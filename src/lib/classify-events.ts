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
  
  // Classify each event
  const classifiedEvents: TxEvent[] = [];
  
  for (const event of events) {
    const classified = classifyEvent(event, eventsByOpHash, context, delegates);
    classifiedEvents.push(classified);
  }
  
  return classifiedEvents;
}

function classifyEvent(
  event: TxEvent,
  eventsByOpHash: Map<string, TxEvent[]>,
  context: ClassificationContext,
  delegates: Set<string>
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
    const swapResult = detectSwap(event, relatedEvents);
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
  
  // Outgoing XTZ to unknown wallet with no corresponding receipt = likely gift
  if (event.direction === 'out' && event.asset === 'XTZ' && addressType.type === 'wallet') {
    // Check if there's any incoming token in the same operation
    const hasIncomingInSameOp = relatedEvents.some(
      e => e.direction === 'in' && e.id !== event.id
    );
    
    if (!hasIncomingInSameOp) {
      event.classification = 'likely_gift';
      event.classificationNote = 'Sent XTZ with no corresponding receipt - may be a gift';
      event.confidence = 'medium';
      return event;
    }
  }
  
  // Incoming XTZ from unknown source
  if (event.direction === 'in' && event.asset === 'XTZ' && addressType.type === 'wallet') {
    event.classification = 'likely_income';
    event.classificationNote = 'Received XTZ - may be income, gift, or transfer from own wallet';
    event.confidence = 'low';
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
  relatedEvents: TxEvent[]
): SwapDetectionResult | null {
  // Look for patterns indicating a swap
  const xtzOut = relatedEvents.find(e => e.asset === 'XTZ' && e.direction === 'out');
  const xtzIn = relatedEvents.find(e => e.asset === 'XTZ' && e.direction === 'in');
  const tokenOut = relatedEvents.find(e => e.asset !== 'XTZ' && e.direction === 'out');
  const tokenIn = relatedEvents.find(e => e.asset !== 'XTZ' && e.direction === 'in');
  
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
  
  // NFT sale (NFT out + XTZ in)
  if (tokenOut && xtzIn) {
    const isNft = event.tags.includes('likely_nft') ||
                  relatedEvents.some(e => e.tags.includes('likely_nft'));
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
