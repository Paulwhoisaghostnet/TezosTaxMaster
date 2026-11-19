/**
 * Smart event classification
 * Analyzes transaction patterns to properly categorize events
 */

import { TxEvent, Wallet } from './db';
import {
  getAddressType,
  looksLikeBakerPayout,
  isNftMarketplace,
  ESCROW_BID_ENTRYPOINTS,
  ESCROW_REFUND_ENTRYPOINTS,
  MARKETPLACE_BUY_ENTRYPOINTS,
} from './known-addresses';

interface ClassificationContext {
  ownedWallets: Set<string>;
}

/**
 * Classify a batch of events with smart detection.
 * Re-run after all wallets are synced so owned-wallet transfers resolve.
 */
export function classifyEvents(events: TxEvent[], wallets: Wallet[]): TxEvent[] {
  const ownedWallets = new Set(wallets.map((w) => w.address.toLowerCase()));
  const delegates = new Set(
    wallets.filter((w) => w.delegate).map((w) => w.delegate!.toLowerCase())
  );
  const delegateAliases = new Set(
    wallets
      .filter((w) => w.delegateName)
      .map((w) => w.delegateName!.toLowerCase())
  );

  const context: ClassificationContext = { ownedWallets };

  const eventsByOpHash = new Map<string, TxEvent[]>();
  for (const event of events) {
    if (!event.opHash) continue;
    if (!eventsByOpHash.has(event.opHash)) {
      eventsByOpHash.set(event.opHash, []);
    }
    eventsByOpHash.get(event.opHash)!.push(event);
  }

  const tokenInventory = new Map<string, { minted: boolean; acquired: boolean }>();
  const sortedEvents = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const event of sortedEvents) {
    if (event.asset === 'XTZ') continue;
    const assetKey = event.asset;
    if (!tokenInventory.has(assetKey)) {
      tokenInventory.set(assetKey, { minted: false, acquired: false });
    }
    const inv = tokenInventory.get(assetKey)!;
    if (event.direction === 'in') {
      if (event.isMint) inv.minted = true;
      else inv.acquired = true;
    }
  }

  const classifiedEvents: TxEvent[] = [];
  for (const event of events) {
    // Preserve user overrides
    if (event.userOverride && event.classification) {
      classifiedEvents.push(event);
      continue;
    }
    classifiedEvents.push(
      classifyEvent(
        { ...event },
        eventsByOpHash,
        context,
        delegates,
        delegateAliases,
        tokenInventory
      )
    );
  }

  return classifiedEvents;
}

function classifyEvent(
  event: TxEvent,
  eventsByOpHash: Map<string, TxEvent[]>,
  context: ClassificationContext,
  delegates: Set<string>,
  delegateAliases: Set<string>,
  tokenInventory: Map<string, { minted: boolean; acquired: boolean }>
): TxEvent {
  const counterpartyLower = (event.counterparty || '').toLowerCase();
  const addressType = getAddressType(event.counterparty);
  const relatedEvents = event.opHash ? eventsByOpHash.get(event.opHash) || [] : [];
  const entrypoint =
    event.entrypoint ||
    (event.note?.startsWith('contract_call:')
      ? event.note.slice('contract_call:'.length)
      : undefined);
  const tzktAlias = event.counterpartyName; // may already be set from TzKT alias at build time

  event.counterpartyType =
    addressType.type === 'wallet'
      ? 'unknown_wallet'
      : addressType.type === 'nft_marketplace'
        ? 'nft_marketplace'
        : addressType.type;
  event.counterpartyName = addressType.name || tzktAlias;

  // Inter-wallet (own) transfers — non-taxable
  if (context.ownedWallets.has(counterpartyLower)) {
    event.counterpartyType = 'owned_wallet';
    event.classification = 'self_transfer';
    event.classificationNote = 'Transfer between your own wallets';
    event.confidence = 'high';
    return event;
  }

  // Staking / baker rewards
  if (event.direction === 'in' && event.asset === 'XTZ' && event.quantity > 0) {
    const bakerHit = looksLikeBakerPayout(
      event.counterparty,
      event.counterpartyName || tzktAlias
    );
    const isUserDelegate = delegates.has(counterpartyLower);
    const aliasLooksDelegate =
      !!event.counterpartyName &&
      Array.from(delegateAliases).some(
        (a) =>
          event.counterpartyName!.toLowerCase().includes(a) ||
          a.includes(event.counterpartyName!.toLowerCase())
      );

    if (bakerHit.isBaker || isUserDelegate || aliasLooksDelegate) {
      event.counterpartyType = 'baker';
      event.counterpartyName =
        bakerHit.name || event.counterpartyName || 'Delegated Baker';
      event.classification = 'baking_reward';
      event.classificationNote = `Staking reward from ${event.counterpartyName}`;
      event.confidence = 'high';
      return event;
    }
  }

  // CEX
  if (addressType.type === 'cex') {
    if (event.direction === 'out') {
      event.classification = 'cex_deposit';
      event.classificationNote = `Deposit to ${addressType.name}`;
    } else {
      event.classification = 'cex_withdrawal';
      event.classificationNote = `Withdrawal from ${addressType.name}`;
    }
    event.confidence = 'high';
    return event;
  }

  // Auction / offer escrow & refunds (by entrypoint)
  const escrow = classifyEscrow(event, relatedEvents, entrypoint, addressType);
  if (escrow) {
    event.classification = escrow.classification;
    event.classificationNote = escrow.note;
    event.confidence = 'high';
    return event;
  }

  // NFT marketplace / swap patterns joined by opHash
  if (relatedEvents.length > 1) {
    const swapResult = detectMarketplaceOrSwap(event, relatedEvents, tokenInventory);
    if (swapResult) {
      event.classification = swapResult.classification;
      event.classificationNote = swapResult.note;
      event.relatedOpHash = event.opHash;
      event.confidence = 'high';
      return event;
    }
  }

  // Royalty / primary sale payouts: inbound XTZ from marketplace with no NFT out in same op
  if (
    event.direction === 'in' &&
    event.asset === 'XTZ' &&
    event.quantity > 0 &&
    (addressType.type === 'nft_marketplace' ||
      isNftMarketplace(event.counterparty).isMarketplace ||
      event.counterparty.startsWith('KT1'))
  ) {
    const tokenOut = relatedEvents.some(
      (e) => e.asset !== 'XTZ' && e.direction === 'out' && e.walletAddress === event.walletAddress
    );
    const tokenIn = relatedEvents.some(
      (e) => e.asset !== 'XTZ' && e.direction === 'in' && e.walletAddress === event.walletAddress
    );

    if (!tokenOut && !tokenIn) {
      // Could be royalty or primary sale settlement to creator
      const isCreatorWallet = relatedEvents.some(
        (e) =>
          e.kind === 'token_transfer' &&
          e.tokenCreators?.some(
            (c) => c.toLowerCase() === event.walletAddress.toLowerCase()
          )
      );
      // Heuristic: small inbound from marketplace without token movement = royalty
      // Larger with mint history elsewhere still creator_sale when token out exists;
      // here treat as royalty_income (ordinary) — owner can relabel to creator_sale.
      event.classification = isCreatorWallet ? 'creator_sale' : 'royalty_income';
      event.classificationNote = isCreatorWallet
        ? 'Primary/creator payout from marketplace'
        : 'Likely royalty or sale payout from marketplace — ordinary income';
      event.confidence = 'medium';
      return event;
    }
  }

  // DEX (non-NFT) without detected swap
  if (addressType.type === 'dex') {
    event.classification = 'dex_interaction';
    event.classificationNote = `Interaction with ${addressType.name}`;
    event.confidence = 'medium';
    return event;
  }

  // Creator sale: outgoing minted token
  if (event.direction === 'out' && event.asset !== 'XTZ') {
    const inv = tokenInventory.get(event.asset);
    if (inv && inv.minted && !inv.acquired) {
      event.classification = 'creator_sale';
      event.classificationNote =
        'Sale of self-created token - ordinary income (Schedule C for US)';
      event.confidence = 'high';
      return event;
    }
  }

  // Unexplained transfers → needs_review (NOT auto income/gift)
  if (event.direction === 'out' && event.asset === 'XTZ' && event.quantity > 0) {
    const hasIncomingInSameOp = relatedEvents.some(
      (e) => e.direction === 'in' && e.id !== event.id
    );
    if (!hasIncomingInSameOp && addressType.type === 'wallet') {
      event.classification = 'needs_review';
      event.classificationNote =
        'Outbound XTZ with no linked receipt — classify as gift, payment, own-wallet, or ignore';
      event.confidence = 'low';
      return event;
    }
  }

  if (event.direction === 'out' && event.asset !== 'XTZ') {
    const hasIncomingInSameOp = relatedEvents.some(
      (e) => e.direction === 'in' && e.id !== event.id
    );
    if (!hasIncomingInSameOp && addressType.type === 'wallet') {
      event.classification = 'needs_review';
      event.classificationNote =
        'Outbound token/NFT with no linked payment — classify as gift, transfer, or ignore';
      event.confidence = 'low';
      return event;
    }
  }

  if (event.direction === 'in' && event.asset === 'XTZ' && event.quantity > 0) {
    if (addressType.type === 'wallet') {
      event.classification = 'needs_review';
      event.classificationNote =
        'Inbound XTZ from unknown address — classify as income, own-wallet, CEX, gift, or ignore';
      event.confidence = 'low';
      return event;
    }
  }

  // Token in from marketplace with no XTZ in this op — likely auction/offer settle
  if (
    event.direction === 'in' &&
    event.asset !== 'XTZ' &&
    (addressType.type === 'nft_marketplace' ||
      isNftMarketplace(event.counterparty).isMarketplace ||
      relatedEvents.some(
        (e) =>
          getAddressType(e.counterparty).type === 'nft_marketplace' ||
          isNftMarketplace(e.counterparty).isMarketplace
      ))
  ) {
    event.classification = 'nft_purchase';
    event.classificationNote =
      'NFT received via marketplace (possible prior bid/offer settle) — cost basis from escrow if linked';
    event.confidence = 'medium';
    return event;
  }

  if (event.direction === 'in' && event.asset !== 'XTZ') {
    event.classification = event.isMint ? 'token_received' : 'needs_review';
    event.classificationNote = event.isMint
      ? 'Minted token — basis typically 0 (or mint costs)'
      : 'Inbound token/NFT — classify as purchase settlement, airdrop, gift, or ignore';
    event.confidence = event.isMint ? 'high' : 'low';
    return event;
  }

  event.classification = 'unknown';
  event.confidence = 'low';
  return event;
}

function classifyEscrow(
  event: TxEvent,
  relatedEvents: TxEvent[],
  entrypoint: string | undefined,
  addressType: ReturnType<typeof getAddressType>
): { classification: NonNullable<TxEvent['classification']>; note: string } | null {
  const ep = (entrypoint || '').toLowerCase();
  const relatedEps = relatedEvents
    .map((e) => e.entrypoint || '')
    .filter(Boolean)
    .map((e) => e.toLowerCase());
  const allEps = new Set([ep, ...relatedEps].filter(Boolean));
  const isMkt =
    addressType.type === 'nft_marketplace' ||
    relatedEvents.some(
      (e) =>
        getAddressType(e.counterparty).type === 'nft_marketplace' ||
        isNftMarketplace(e.counterparty).isMarketplace
    );

  // Refund: XTZ returning after retract/cancel
  const hasRefundEp = [...allEps].some((e) => ESCROW_REFUND_ENTRYPOINTS.has(e));
  if (hasRefundEp && event.asset === 'XTZ') {
    if (event.direction === 'in' && event.quantity > 0) {
      return {
        classification: 'escrow_refund',
        note: 'Marketplace escrow refund — not taxable income',
      };
    }
    if (event.direction === 'out' && event.quantity === 0) {
      return {
        classification: 'escrow_refund',
        note: 'Retract/cancel offer or bid',
      };
    }
  }

  // Bid / offer escrow: XTZ out (often via wXTZ wrap) — wrapped XTZ is not an NFT buy
  const hasBidEp = [...allEps].some((e) => e === 'bid' || e === 'bid_floor');
  const hasOfferEp = [...allEps].some(
    (e) => e === 'offer' || e === 'offer_token' || e === 'make_offer'
  );
  const hasWrapEp = [...allEps].some((e) => e === 'wrap');
  const wrapTokenIn = relatedEvents.some(
    (e) =>
      e.asset !== 'XTZ' &&
      e.direction === 'in' &&
      /^(o)?xtz$/i.test((e.asset.split(':')[0] || '').replace(/\s/g, ''))
  );
  const nftIn = relatedEvents.some(
    (e) =>
      e.asset !== 'XTZ' &&
      e.direction === 'in' &&
      e.tags.includes('likely_nft') &&
      !/^(o)?xtz$/i.test((e.asset.split(':')[0] || '').replace(/\s/g, ''))
  );

  // Pure wXTZ wrap (XTZ out + oXTZ in) — escrow / wrap, never NFT purchase
  if (
    (hasWrapEp || wrapTokenIn) &&
    event.asset === 'XTZ' &&
    event.direction === 'out' &&
    event.quantity > 0 &&
    !nftIn
  ) {
    return {
      classification: hasOfferEp && !hasBidEp ? 'offer_escrow' : 'auction_bid_escrow',
      note: 'XTZ wrapped / locked for marketplace bid or offer',
    };
  }

  if (
    (hasBidEp || hasOfferEp) &&
    event.asset === 'XTZ' &&
    event.direction === 'out' &&
    event.quantity > 0 &&
    !nftIn
  ) {
    return {
      classification: hasOfferEp && !hasBidEp ? 'offer_escrow' : 'auction_bid_escrow',
      note: hasOfferEp && !hasBidEp
        ? 'XTZ locked in offer escrow — not a disposal until filled or refunded'
        : 'XTZ locked in auction bid escrow — not a disposal until settled',
    };
  }

  // wXTZ / oXTZ token legs are never NFT trades
  if (event.asset !== 'XTZ' && /^(o)?xtz$/i.test((event.asset.split(':')[0] || '').replace(/\s/g, ''))) {
    return {
      classification: hasOfferEp && !hasBidEp ? 'offer_escrow' : 'auction_bid_escrow',
      note: 'Wrapped XTZ token transfer — not an NFT trade',
    };
  }

  // Marketplace buy entrypoint with XTZ out handled in detectMarketplaceOrSwap
  if (MARKETPLACE_BUY_ENTRYPOINTS.has(ep) && isMkt) {
    return null;
  }

  return null;
}

interface SwapDetectionResult {
  classification: TxEvent['classification'];
  note: string;
}

function detectMarketplaceOrSwap(
  event: TxEvent,
  relatedEvents: TxEvent[],
  tokenInventory: Map<string, { minted: boolean; acquired: boolean }>
): SwapDetectionResult | null {
  const wallet = event.walletAddress.toLowerCase();
  const xtzOut = relatedEvents.find(
    (e) =>
      e.asset === 'XTZ' &&
      e.direction === 'out' &&
      e.quantity > 0 &&
      e.walletAddress.toLowerCase() === wallet
  );
  const xtzIn = relatedEvents.find(
    (e) =>
      e.asset === 'XTZ' &&
      e.direction === 'in' &&
      e.quantity > 0 &&
      e.walletAddress.toLowerCase() === wallet
  );
  const tokenOut = relatedEvents.find(
    (e) =>
      e.asset !== 'XTZ' &&
      e.direction === 'out' &&
      e.walletAddress.toLowerCase() === wallet
  );
  const tokenIn = relatedEvents.find(
    (e) =>
      e.asset !== 'XTZ' &&
      e.direction === 'in' &&
      e.walletAddress.toLowerCase() === wallet
  );

  const isWrapToken = (asset: string) =>
    /^(o)?xtz$/i.test((asset.split(':')[0] || '').replace(/\s/g, ''));

  const tokenInReal =
    tokenIn && !isWrapToken(tokenIn.asset) ? tokenIn : undefined;
  const tokenOutReal =
    tokenOut && !isWrapToken(tokenOut.asset) ? tokenOut : undefined;

  const tokenOutWasMinted = tokenOutReal && tokenInventory.get(tokenOutReal.asset);
  const isCreatorSale =
    !!tokenOutWasMinted && tokenOutWasMinted.minted && !tokenOutWasMinted.acquired;

  const isNft =
    event.tags.includes('likely_nft') ||
    relatedEvents.some((e) => e.tags.includes('likely_nft') && !isWrapToken(e.asset)) ||
    relatedEvents.some(
      (e) =>
        getAddressType(e.counterparty).type === 'nft_marketplace' ||
        isNftMarketplace(e.counterparty).isMarketplace
    );

  // NFT purchase: XTZ out + real token in (not wrapped XTZ)
  if (xtzOut && tokenInReal && isNft) {
    if (event.id === xtzOut.id || event.id === tokenInReal.id) {
      return {
        classification: 'nft_purchase',
        note: `NFT/token purchase (${extractTokenSymbol(tokenInReal.asset)})`,
      };
    }
  }

  // NFT / creator sale: real token out + XTZ in
  if (tokenOutReal && xtzIn) {
    if (isCreatorSale) {
      if (event.id === tokenOutReal.id || event.id === xtzIn.id) {
        return {
          classification: 'creator_sale',
          note: 'Sale of self-created token - ordinary income (Schedule C for US)',
        };
      }
    }
    if (isNft) {
      if (event.id === tokenOutReal.id || event.id === xtzIn.id) {
        return {
          classification: 'nft_sale',
          note: 'NFT/token sale - capital gain/loss',
        };
      }
    }
  }

  // Classic DEX swap XTZ ↔ token (exclude pure wXTZ wrap)
  if (xtzOut && tokenInReal) {
    if (event.id === xtzOut.id || event.id === tokenInReal.id) {
      return {
        classification: 'swap',
        note: `Swapped XTZ for ${extractTokenSymbol(tokenInReal.asset)}`,
      };
    }
  }
  if (tokenOutReal && xtzIn) {
    if (event.id === tokenOutReal.id || event.id === xtzIn.id) {
      return {
        classification: 'swap',
        note: `Swapped ${extractTokenSymbol(tokenOutReal.asset)} for XTZ`,
      };
    }
  }

  if (tokenOutReal && tokenInReal && !xtzOut && !xtzIn) {
    if (event.id === tokenOutReal.id || event.id === tokenInReal.id) {
      return {
        classification: 'swap',
        note: `Swapped ${extractTokenSymbol(tokenOutReal.asset)} for ${extractTokenSymbol(tokenInReal.asset)}`,
      };
    }
  }

  return null;
}

function extractTokenSymbol(asset: string): string {
  const parts = asset.split(':');
  return parts[0] || 'token';
}

export function getClassificationStats(events: TxEvent[]): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const event of events) {
    const classification = event.classification || 'unclassified';
    stats[classification] = (stats[classification] || 0) + 1;
  }
  return stats;
}

/** Events that still need owner review before filing */
export function getReviewQueue(events: TxEvent[]): TxEvent[] {
  return events.filter(
    (e) =>
      e.classification === 'needs_review' ||
      e.classification === 'unknown' ||
      (!e.classification && e.quantity > 0)
  );
}
