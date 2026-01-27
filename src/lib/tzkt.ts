/**
 * TzKT API client for fetching Tezos blockchain data
 * All API calls happen client-side - no server involvement
 * 
 * Note: TzKT only supports USD, EUR, BTC for quotes.
 * GBP and CAD are calculated using historical exchange rate data.
 */

import { TxEvent } from './db';
import { convertFromUSD } from './exchange-rates';

const TZKT_BASE = 'https://api.tzkt.io/v1';

interface TzKTTransaction {
  timestamp: string;
  level: number;
  hash: string;
  sender?: { address: string };
  target?: { address: string };
  amount?: number;
  fee?: number;
  parameter?: unknown;
  status?: string;
  quote?: {
    usd?: number;
  };
}

interface TzKTTokenTransfer {
  timestamp: string;
  level: number;
  transactionHash?: string;
  from?: { address: string };
  to?: { address: string };
  amount?: string;
  token?: {
    contract?: { address: string };
    tokenId?: string;
    standard?: string;
    metadata?: {
      symbol?: string;
      name?: string;
      decimals?: string;
    };
  };
  quote?: {
    usd?: number;
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    let errorDetail = '';
    try {
      const errorBody = await response.text();
      errorDetail = errorBody ? `: ${errorBody}` : '';
    } catch {
      // ignore
    }
    throw new Error(`TzKT API error: ${response.status}${errorDetail}`);
  }
  return response.json();
}

async function fetchPaginated<T>(baseUrl: string, limit = 1000): Promise<T[]> {
  const results: T[] = [];
  let offset = 0;
  
  while (true) {
    const separator = baseUrl.includes('?') ? '&' : '?';
    const url = `${baseUrl}${separator}limit=${limit}&offset=${offset}`;
    const data = await fetchJson<T[]>(url);
    
    if (!Array.isArray(data) || data.length === 0) {
      break;
    }
    
    results.push(...data);
    
    if (data.length < limit) {
      break;
    }
    
    offset += limit;
    // Small delay to be polite to API
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return results;
}

export async function fetchXtzTransactions(
  address: string,
  startIso: string,
  endIso: string
): Promise<TzKTTransaction[]> {
  // Fetch outgoing transactions (sender)
  const senderParams = new URLSearchParams({
    'sender': address,
    'timestamp.ge': startIso,
    'timestamp.lt': endIso,
    'status': 'applied',
    'quote': 'usd', // TzKT only supports USD, EUR, BTC - we convert to GBP/CAD
  });
  
  // Fetch incoming transactions (target)
  const targetParams = new URLSearchParams({
    'target': address,
    'timestamp.ge': startIso,
    'timestamp.lt': endIso,
    'status': 'applied',
    'quote': 'usd', // TzKT only supports USD, EUR, BTC - we convert to GBP/CAD
  });
  
  const [senderOps, targetOps] = await Promise.all([
    fetchPaginated<TzKTTransaction>(`${TZKT_BASE}/operations/transactions?${senderParams}`),
    fetchPaginated<TzKTTransaction>(`${TZKT_BASE}/operations/transactions?${targetParams}`),
  ]);
  
  // Merge and deduplicate by hash
  const seen = new Set<string>();
  const merged: TzKTTransaction[] = [];
  
  for (const op of [...senderOps, ...targetOps]) {
    if (op.hash && !seen.has(op.hash)) {
      seen.add(op.hash);
      merged.push(op);
    }
  }
  
  // Sort by timestamp
  merged.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  
  return merged;
}

export async function fetchTokenTransfers(
  address: string,
  startIso: string,
  endIso: string
): Promise<TzKTTokenTransfer[]> {
  // Fetch outgoing token transfers (from)
  const fromParams = new URLSearchParams({
    'from': address,
    'timestamp.ge': startIso,
    'timestamp.lt': endIso,
    'quote': 'usd', // TzKT only supports USD, EUR, BTC - we convert to GBP/CAD
  });
  
  // Fetch incoming token transfers (to)
  const toParams = new URLSearchParams({
    'to': address,
    'timestamp.ge': startIso,
    'timestamp.lt': endIso,
    'quote': 'usd', // TzKT only supports USD, EUR, BTC - we convert to GBP/CAD
  });
  
  const [fromOps, toOps] = await Promise.all([
    fetchPaginated<TzKTTokenTransfer>(`${TZKT_BASE}/tokens/transfers?${fromParams}`),
    fetchPaginated<TzKTTokenTransfer>(`${TZKT_BASE}/tokens/transfers?${toParams}`),
  ]);
  
  // Merge and deduplicate by transaction hash + level + token
  const seen = new Set<string>();
  const merged: TzKTTokenTransfer[] = [];
  
  for (const tr of [...fromOps, ...toOps]) {
    const key = `${tr.transactionHash}:${tr.level}:${tr.token?.contract?.address}:${tr.token?.tokenId}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(tr);
    }
  }
  
  // Sort by timestamp
  merged.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  
  return merged;
}

export async function fetchAllTransactions(
  address: string,
  startIso?: string,
  endIso?: string
): Promise<{ xtzOps: TzKTTransaction[]; tokenOps: TzKTTokenTransfer[] }> {
  // Default to all time if no range specified
  const start = startIso || '2018-01-01T00:00:00Z';
  const end = endIso || new Date(Date.now() + 86400000).toISOString(); // tomorrow
  
  const [xtzOps, tokenOps] = await Promise.all([
    fetchXtzTransactions(address, start, end),
    fetchTokenTransfers(address, start, end),
  ]);
  
  return { xtzOps, tokenOps };
}

export function buildEvents(
  address: string,
  xtzOps: TzKTTransaction[],
  tokenOps: TzKTTokenTransfer[]
): TxEvent[] {
  const addr = address.toLowerCase();
  const events: TxEvent[] = [];
  
  // XTZ operations
  for (const op of xtzOps) {
    if (!op.timestamp) continue;
    
    const sender = op.sender?.address || '';
    const target = op.target?.address || '';
    const amountMutez = Number(op.amount) || 0;
    const amountXtz = amountMutez / 1_000_000;
    const feeMutez = Number(op.fee) || 0;
    const feeXtz = feeMutez / 1_000_000;
    
    if (amountXtz === 0 && feeXtz === 0) continue;
    
    const direction: 'in' | 'out' = 
      (target.toLowerCase() === addr && sender.toLowerCase() !== addr) ? 'in' : 'out';
    const counterparty = direction === 'in' ? sender : target;
    const note = op.parameter ? 'contract_call' : 'transfer';
    const tags: string[] = [];
    let confidence: 'high' | 'medium' | 'low' = 'medium';
    
    if (amountXtz > 0 && direction === 'in') {
      tags.push('receipt');
    }
    if (amountXtz > 0 && direction === 'out') {
      tags.push('payment_or_disposal');
    }
    
    // Self-transfer
    if (sender.toLowerCase() === addr && target.toLowerCase() === addr) {
      tags.push('self_transfer');
      confidence = 'high';
    }
    
    const id = `${address}:${op.hash}:xtz:${op.level}`;
    
    events.push({
      id,
      walletAddress: address,
      timestamp: op.timestamp,
      level: op.level || 0,
      opHash: op.hash || '',
      kind: 'xtz_transfer',
      direction,
      counterparty,
      asset: 'XTZ',
      quantity: clamp(amountXtz),
      feeXtz: clamp(feeXtz),
      note,
      tags,
      confidence,
      quoteUsd: op.quote?.usd,
      quoteGbp: op.quote?.usd ? convertFromUSD(op.quote.usd, op.timestamp, 'gbp') : undefined,
      quoteCad: op.quote?.usd ? convertFromUSD(op.quote.usd, op.timestamp, 'cad') : undefined,
    });
  }
  
  // Token transfers
  for (const tr of tokenOps) {
    if (!tr.timestamp) continue;
    
    const fromAddr = tr.from?.address || '';
    const toAddr = tr.to?.address || '';
    const direction: 'in' | 'out' = toAddr.toLowerCase() === addr ? 'in' : 'out';
    const counterparty = direction === 'in' ? fromAddr : toAddr;
    
    const token = tr.token || {};
    const contract = token.contract?.address || '';
    const tokenId = token.tokenId || '';
    const standard = token.standard || '';
    const symbol = token.metadata?.symbol;
    const name = token.metadata?.name;
    const decimalsStr = token.metadata?.decimals;
    
    const rawAmount = Number(tr.amount) || 0;
    let qty = rawAmount;
    if (decimalsStr !== undefined) {
      try {
        qty = rawAmount / Math.pow(10, parseInt(decimalsStr));
      } catch {
        qty = rawAmount;
      }
    }
    
    const asset = `${symbol || name || 'TOKEN'}:${contract}:${tokenId}:${standard}`;
    const tags: string[] = ['token_transfer'];
    let confidence: 'high' | 'medium' | 'low' = 'medium';
    
    // NFT hint
    if (standard.toUpperCase() === 'FA2' && (!decimalsStr || decimalsStr === '0') && rawAmount === 1) {
      tags.push('likely_nft');
      confidence = 'high';
    }
    
    // Mint detection: incoming token with no from address = minted/created
    const isMint = direction === 'in' && !fromAddr;
    if (isMint) {
      tags.push('minted');
    }
    
    const id = `${address}:${tr.transactionHash || ''}:token:${tr.level}:${contract}:${tokenId}`;
    
    events.push({
      id,
      walletAddress: address,
      timestamp: tr.timestamp,
      level: tr.level || 0,
      opHash: tr.transactionHash || '',
      kind: 'token_transfer',
      direction,
      counterparty,
      asset,
      quantity: clamp(qty),
      feeXtz: 0, // Token transfer endpoint doesn't include fee
      note: 'token_transfer',
      tags,
      confidence,
      isMint, // Track if this was a mint operation
      quoteUsd: tr.quote?.usd,
      quoteGbp: tr.quote?.usd ? convertFromUSD(tr.quote.usd, tr.timestamp, 'gbp') : undefined,
      quoteCad: tr.quote?.usd ? convertFromUSD(tr.quote.usd, tr.timestamp, 'cad') : undefined,
    });
  }
  
  // Sort by timestamp
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return events;
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n;
}

// Validate Tezos address format
export function isValidTezosAddress(address: string): boolean {
  // tz1, tz2, tz3, KT1 addresses
  return /^(tz[123]|KT1)[a-zA-Z0-9]{33}$/.test(address.trim());
}

// Get account info including delegation
export async function getAccountInfo(address: string): Promise<{
  balance: number;
  type: string;
  firstActivity?: string;
  delegate?: string;
  delegateAlias?: string;
} | null> {
  try {
    const data = await fetchJson<{
      balance: number;
      type: string;
      firstActivity?: number;
      firstActivityTime?: string;
      delegate?: {
        address: string;
        alias?: string;
      };
    }>(`${TZKT_BASE}/accounts/${address}`);
    
    return {
      balance: (data.balance || 0) / 1_000_000,
      type: data.type || 'unknown',
      firstActivity: data.firstActivityTime,
      delegate: data.delegate?.address,
      delegateAlias: data.delegate?.alias,
    };
  } catch {
    return null;
  }
}

// Get historical delegates for an account
export async function getDelegationHistory(address: string): Promise<Array<{
  timestamp: string;
  delegate?: string;
  delegateAlias?: string;
}>> {
  try {
    const data = await fetchJson<Array<{
      timestamp: string;
      newDelegate?: {
        address: string;
        alias?: string;
      };
    }>>(`${TZKT_BASE}/accounts/${address}/delegations?limit=100`);
    
    return data.map(d => ({
      timestamp: d.timestamp,
      delegate: d.newDelegate?.address,
      delegateAlias: d.newDelegate?.alias,
    }));
  } catch {
    return [];
  }
}
