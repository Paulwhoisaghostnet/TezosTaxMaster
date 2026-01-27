/**
 * Smart event classification
 * Analyzes transaction patterns to properly categorize events
 */

import { TxEvent, Wallet } from './db';
import { getAddressType, isKnownBaker } from './known-addresses';

interface ClassificationContext {
  ownedWallets: Set<string>; // User's wallet addresses (lowercase)
  delegateAddress?: string;  // Current baker address
}

/**
 * Classify a batch of events with smart detection
 */
export function classifyEvents(
  events: TxEvent[],
  wallets: Wallet[]
): TxEvent[] {
  // Build context
  const ownedWallets = new Set(wallets.map(w => w.address.toLowerCase()));
  
  // Get delegate addresses from all wallets
  const delegates = new Set(
    wallets
      .filter(w => w.delegate)
      .map(w => w.delegate!.toLowerCase())
  );
  
  const context: ClassificationContext = {
    ownedWallets,
  };
  
  // Group events by opHash for swap detection
  const eventsByOpHash = new Map<string, TxEvent[]>();
  for (const event of events) {
    if (!eventsByOpHash.has(event.opHash)) {
      eventsByOpHash.set(event.opHash, []);
    }
    eventsByOpHash.get(event.opHash)!.push(event);
  }
  
  // Track token inventory: which tokens were minted vs purchased
  // Key: asset string, Value: { minted: boolean, acquired: boolean }
  const tokenInventory = new Map<string, { minted: boolean; acquired: boolean }>();
  
  // First pass: build token inventory (chronological)
  const sortedEvents = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const event of sortedEvents) {
    if (event.asset === 'XTZ') continue;
    
    const assetKey = event.asset;
    if (!tokenInventory.has(assetKey)) {
      tokenInventory.set(assetKey, { minted: false, acquired: false });
    }
    
    const inv = tokenInventory.get(assetKey)!;
    if (event.direction === 'in') {
      if (event.isMint) {
        inv.minted = true;
      } else {
        inv.acquired = true;
      }
    }
  }
  
  // Classify each event
  const classifiedEvents: TxEvent[] = [];
  
  for (const event of events) {
    const classified = classifyEvent(event, eventsByOpHash, context, delegates, tokenInventory);
    classifiedEvents.push(classified);
  }
  
  return classifiedEvents;
}

function classifyEvent(
  event: TxEvent,
  eventsByOpHash: Map<string, TxEvent[]>,
  context: ClassificationContext,
  delegates: Set<string>,
  tokenInventory: Map<string, { minted: boolean; acquired: boolean }>
): TxEvent {
  const counterpartyLower = event.counterparty.toLowerCase();
  const addressType = getAddressType(event.counterparty);
  
  // Set counterparty info
  event.counterpartyType = addressType.type === 'wallet' ? 'unknown_wallet' : addressType.type;
  event.counterpartyName = addressType.name;
  
  // Check if counterparty is an owned wallet
  if (context.ownedWallets.has(counterpartyLower)) {
    event.counterpartyType = 'owned_wallet';
    event.classification = 'self_transfer';
    event.classificationNote = 'Transfer between your own wallets';
    event.confidence = 'high';
    return event;
  }
  
  // Check if this is a baking reward
  if (event.direction === 'in' && event.asset === 'XTZ') {
    // Check against known bakers and user's delegates
    const isBaker = isKnownBaker(event.counterparty);
    const isUserDelegate = delegates.has(counterpartyLower);
    
    if (isBaker.isBaker || isUserDelegate) {
      event.counterpartyType = 'baker';
      event.counterpartyName = isBaker.name || 'Delegated Baker';
      event.classification = 'baking_reward';
      event.classificationNote = `Reward from ${event.counterpartyName}`;
      event.confidence = 'high';
      return event;
    }
  }
  
  // Check CEX interactions
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
  
  // Check for swaps (same opHash with XTZ and token moving in opposite directions)
  const relatedEvents = eventsByOpHash.get(event.opHash) || [];
  if (relatedEvents.length > 1) {
    const swapResult = detectSwap(event, relatedEvents, tokenInventory);
    if (swapResult) {
      event.classification = swapResult.classification;
      event.classificationNote = swapResult.note;
      event.relatedOpHash = event.opHash;
      event.confidence = 'high';
      return event;
    }
  }
  
  // Check DEX interactions (even without detected swap)
  if (addressType.type === 'dex') {
    event.classification = 'dex_interaction';
    event.classificationNote = `Interaction with ${addressType.name}`;
    event.confidence = 'medium';
    return event;
  }
  
  // Creator sale detection: selling a token that was minted (not purchased)
  // For US tax: this is ordinary income (Schedule C), not capital gains
  if (event.direction === 'out' && event.asset !== 'XTZ') {
    const inv = tokenInventory.get(event.asset);
    if (inv && inv.minted && !inv.acquired) {
      event.classification = 'creator_sale';
      event.classificationNote = 'Sale of self-created token - ordinary income (Schedule C for US)';
      event.confidence = 'high';
      return event;
    }
  }
  
  // Outgoing XTZ to unknown wallet with no corresponding receipt = likely gift
  if (event.direction === 'out' && event.asset === 'XTZ' && addressType.type === 'wallet') {
    // Check if there's any incoming token in the same operation
    const hasIncomingInSameOp = relatedEvents.some(
      e => e.direction === 'in' && e.id !== event.id
    );
    
    if (!hasIncomingInSameOp) {
      event.classification = 'likely_gift';
      event.classificationNote = 'Sent XTZ with no corresponding receipt - taxable disposal at FMV';
      event.confidence = 'medium';
      return event;
    }
  }
  
  // Outgoing TOKEN/NFT to unknown wallet with no corresponding receipt = gift
  if (event.direction === 'out' && event.asset !== 'XTZ' && addressType.type === 'wallet') {
    // Check if there's any incoming asset in the same operation
    const hasIncomingInSameOp = relatedEvents.some(
      e => e.direction === 'in' && e.id !== event.id
    );
    
    if (!hasIncomingInSameOp) {
      event.classification = 'token_gift_out';
      event.classificationNote = 'Sent token/NFT with no corresponding receipt - taxable disposal at FMV';
      event.confidence = 'medium';
      return event;
    }
  }
  
  // Incoming XTZ from unknown/unowned wallet = INCOME
  // If it's not from: owned wallet, baker, or CEX, then it's taxable income
  if (event.direction === 'in' && event.asset === 'XTZ' && addressType.type === 'wallet') {
    event.classification = 'received_income';
    event.classificationNote = 'Received XTZ from external address - taxable income at FMV';
    event.confidence = 'high';
    return event;
  }
  
  // Incoming TOKEN/NFT from unknown address (not part of swap/purchase) = potential income/gift received
  // Cost basis = FMV at receipt (if it's a gift, basis is donor's basis or FMV if unknown)
  if (event.direction === 'in' && event.asset !== 'XTZ' && addressType.type === 'wallet') {
    event.classification = 'token_received';
    event.classificationNote = 'Received token/NFT from external address - cost basis = FMV at receipt';
    event.confidence = 'medium';
    return event;
  }
  
  // Default
  event.classification = 'unknown';
  event.confidence = 'low';
  return event;
}

interface SwapDetectionResult {
  classification: TxEvent['classification'];
  note: string;
}

function detectSwap(
  event: TxEvent,
  relatedEvents: TxEvent[],
  tokenInventory: Map<string, { minted: boolean; acquired: boolean }>
): SwapDetectionResult | null {
  // Look for patterns indicating a swap
  const xtzOut = relatedEvents.find(e => e.asset === 'XTZ' && e.direction === 'out');
  const xtzIn = relatedEvents.find(e => e.asset === 'XTZ' && e.direction === 'in');
  const tokenOut = relatedEvents.find(e => e.asset !== 'XTZ' && e.direction === 'out');
  const tokenIn = relatedEvents.find(e => e.asset !== 'XTZ' && e.direction === 'in');
  
  // Check if tokenOut was minted (for creator sale detection)
  const tokenOutWasMinted = tokenOut && tokenInventory.get(tokenOut.asset);
  const isCreatorSale = tokenOutWasMinted && 
    tokenOutWasMinted.minted && !tokenOutWasMinted.acquired;
  
  // XTZ → Token swap
  if (xtzOut && tokenIn && event.id === xtzOut.id) {
    const tokenSymbol = extractTokenSymbol(tokenIn.asset);
    return {
      classification: 'swap',
      note: `Swapped XTZ for ${tokenSymbol}`,
    };
  }
  if (xtzOut && tokenIn && event.id === tokenIn.id) {
    const tokenSymbol = extractTokenSymbol(tokenIn.asset);
    return {
      classification: 'swap',
      note: `Received ${tokenSymbol} from XTZ swap`,
    };
  }
  
  // Token → XTZ swap
  if (tokenOut && xtzIn && event.id === tokenOut.id) {
    const tokenSymbol = extractTokenSymbol(tokenOut.asset);
    return {
      classification: 'swap',
      note: `Swapped ${tokenSymbol} for XTZ`,
    };
  }
  if (tokenOut && xtzIn && event.id === xtzIn.id) {
    const tokenSymbol = extractTokenSymbol(tokenOut.asset);
    return {
      classification: 'swap',
      note: `Received XTZ from ${tokenSymbol} swap`,
    };
  }
  
  // NFT purchase (XTZ out + NFT in)
  if (xtzOut && tokenIn) {
    const isNft = event.tags.includes('likely_nft') || 
                  relatedEvents.some(e => e.tags.includes('likely_nft'));
    if (isNft) {
      if (event.id === xtzOut.id) {
        return {
          classification: 'nft_purchase',
          note: 'NFT purchase',
        };
      }
      if (event.id === tokenIn.id) {
        return {
          classification: 'nft_purchase',
          note: 'NFT received from purchase',
        };
      }
    }
  }
  
  // NFT/Token sale (Token out + XTZ in)
  if (tokenOut && xtzIn) {
    const isNft = event.tags.includes('likely_nft') ||
                  relatedEvents.some(e => e.tags.includes('likely_nft'));
    
    // Check if this is a creator sale (selling a minted token)
    if (isCreatorSale) {
      if (event.id === tokenOut.id) {
        return {
          classification: 'creator_sale',
          note: 'Sale of self-created token - ordinary income (Schedule C for US)',
        };
      }
      if (event.id === xtzIn.id) {
        return {
          classification: 'creator_sale',
          note: 'Income from sale of self-created token (Schedule C for US)',
        };
      }
    }
    
    // Regular NFT sale (not creator)
    if (isNft) {
      if (event.id === tokenOut.id) {
        return {
          classification: 'nft_sale',
          note: 'NFT sold',
        };
      }
      if (event.id === xtzIn.id) {
        return {
          classification: 'nft_sale',
          note: 'XTZ received from NFT sale',
        };
      }
    }
  }
  
  // Token → Token swap
  if (tokenOut && tokenIn && !xtzOut && !xtzIn) {
    const outSymbol = extractTokenSymbol(tokenOut.asset);
    const inSymbol = extractTokenSymbol(tokenIn.asset);
    if (event.id === tokenOut.id) {
      return {
        classification: 'swap',
        note: `Swapped ${outSymbol} for ${inSymbol}`,
      };
    }
    if (event.id === tokenIn.id) {
      return {
        classification: 'swap',
        note: `Received ${inSymbol} from ${outSymbol} swap`,
      };
    }
  }
  
  return null;
}

function extractTokenSymbol(asset: string): string {
  // Asset format: "SYMBOL:contract:tokenId:standard"
  const parts = asset.split(':');
  return parts[0] || 'token';
}

/**
 * Get classification summary stats
 */
export function getClassificationStats(events: TxEvent[]): Record<string, number> {
  const stats: Record<string, number> = {};
  
  for (const event of events) {
    const classification = event.classification || 'unclassified';
    stats[classification] = (stats[classification] || 0) + 1;
  }
  
  return stats;
}
