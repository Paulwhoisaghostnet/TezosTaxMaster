/**
 * TzKT API client for fetching Tezos blockchain data
 * All API calls happen client-side - no server involvement
 *
 * Note: TzKT only supports USD, EUR, BTC for quotes.
 * GBP and CAD are calculated using historical exchange rate data.
 * Fees live in bakerFee/storageFee/allocationFee (not `fee`).
 */

import { TxEvent } from './db';
import { convertFromUSD } from './exchange-rates';
import { enrichQuotesWithFallback } from './price-fallback';

const TZKT_BASE = 'https://api.tzkt.io/v1';

export interface TzKTTransaction {
  id?: number;
  timestamp: string;
  level: number;
  hash: string;
  sender?: { address: string; alias?: string };
  target?: { address: string; alias?: string };
  initiator?: { address: string; alias?: string } | null;
  amount?: number;
  /** Deprecated / often null on TzKT — prefer bakerFee */
  fee?: number | null;
  bakerFee?: number | null;
  storageFee?: number | null;
  allocationFee?: number | null;
  parameter?: { entrypoint?: string; value?: unknown } | null;
  status?: string;
  nonce?: number | null;
  quote?: {
    usd?: number;
  };
}

export interface TzKTTokenTransfer {
  id?: number;
  timestamp: string;
  level: number;
  transactionId?: number;
  transactionHash?: string | null;
  from?: { address: string; alias?: string } | null;
  to?: { address: string; alias?: string } | null;
  amount?: string;
  token?: {
    contract?: { address: string };
    tokenId?: string;
    standard?: string;
    metadata?: {
      symbol?: string;
      name?: string;
      decimals?: string;
      creators?: string[];
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

/**
 * Cursor pagination by id (more complete than offset for large histories).
 */
async function fetchPaginatedById<T extends { id?: number }>(
  baseUrl: string,
  limit = 1000
): Promise<T[]> {
  const results: T[] = [];
  let lastId = 0;

  while (true) {
    const separator = baseUrl.includes('?') ? '&' : '?';
    const url = `${baseUrl}${separator}limit=${limit}&sort.asc=id&id.gt=${lastId}`;
    const data = await fetchJson<T[]>(url);

    if (!Array.isArray(data) || data.length === 0) {
      break;
    }

    results.push(...data);
    const maxId = Math.max(...data.map((d) => d.id ?? 0));
    if (data.length < limit || maxId <= lastId) {
      break;
    }
    lastId = maxId;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  return results;
}

/** Total fee in mutez paid by the operation's sender (root ops only have non-zero fees). */
export function totalFeeMutez(op: TzKTTransaction): number {
  return (
    (Number(op.bakerFee) || 0) +
    (Number(op.storageFee) || 0) +
    (Number(op.allocationFee) || 0)
  );
}

export async function fetchXtzTransactions(
  address: string,
  startIso: string,
  endIso: string
): Promise<TzKTTransaction[]> {
  // anyof keeps every internal tx where the wallet is sender OR target
  // (hash-dedupe would drop batched internals — a major accuracy bug).
  const params = new URLSearchParams({
    'anyof.sender.target': address,
    'timestamp.ge': startIso,
    'timestamp.lt': endIso,
    status: 'applied',
    quote: 'usd',
  });

  const ops = await fetchPaginatedById<TzKTTransaction>(
    `${TZKT_BASE}/operations/transactions?${params}`
  );

  // Deduplicate by TzKT operation id (not hash)
  const seen = new Set<number | string>();
  const merged: TzKTTransaction[] = [];
  for (const op of ops) {
    const key = op.id ?? `${op.hash}:${op.level}:${op.nonce ?? 'root'}:${op.amount}:${op.target?.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(op);
  }

  merged.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  return merged;
}

export async function fetchTokenTransfers(
  address: string,
  startIso: string,
  endIso: string
): Promise<TzKTTokenTransfer[]> {
  const params = new URLSearchParams({
    'anyof.from.to': address,
    'timestamp.ge': startIso,
    'timestamp.lt': endIso,
    quote: 'usd',
  });

  const transfers = await fetchPaginatedById<TzKTTokenTransfer>(
    `${TZKT_BASE}/tokens/transfers?${params}`
  );

  const seen = new Set<string>();
  const merged: TzKTTokenTransfer[] = [];
  for (const tr of transfers) {
    const key = `${tr.id ?? ''}:${tr.transactionHash}:${tr.level}:${tr.token?.contract?.address}:${tr.token?.tokenId}:${tr.from?.address}:${tr.to?.address}:${tr.amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(tr);
  }

  merged.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  return merged;
}

/**
 * Resolve token transfer hashes using already-fetched XTZ ops (same TzKT id space),
 * then optionally batch-fetch any remaining ids from the API.
 */
export async function resolveTokenTransferHashes(
  transfers: TzKTTokenTransfer[],
  xtzOps?: TzKTTransaction[],
  fetchMissing = true
): Promise<void> {
  const idToHash = new Map<number, string>();
  if (xtzOps) {
    for (const op of xtzOps) {
      if (op.id != null && op.hash) idToHash.set(op.id, op.hash);
    }
  }

  for (const tr of transfers) {
    if (!tr.transactionHash && tr.transactionId && idToHash.has(tr.transactionId)) {
      tr.transactionHash = idToHash.get(tr.transactionId)!;
    }
  }

  if (!fetchMissing) return;

  const missingIds = Array.from(
    new Set(
      transfers
        .filter((t) => !t.transactionHash && t.transactionId)
        .map((t) => t.transactionId!)
    )
  );

  if (missingIds.length === 0) return;

  const chunkSize = 100;
  for (let i = 0; i < missingIds.length; i += chunkSize) {
    const chunk = missingIds.slice(i, i + chunkSize);
    const params = new URLSearchParams({
      'id.in': chunk.join(','),
      select: 'id,hash',
      limit: String(chunk.length),
    });
    try {
      const ops = await fetchJson<Array<{ id: number; hash: string }>>(
        `${TZKT_BASE}/operations/transactions?${params}`
      );
      for (const op of ops) {
        if (op.id && op.hash) idToHash.set(op.id, op.hash);
      }
    } catch {
      // Best-effort; joins may fall back to level matching
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  for (const tr of transfers) {
    if (!tr.transactionHash && tr.transactionId && idToHash.has(tr.transactionId)) {
      tr.transactionHash = idToHash.get(tr.transactionId)!;
    }
  }
}

/**
 * Fallback hash attach: only when a level has exactly one wallet-involved XTZ hash.
 * Do NOT match on timestamp alone — concurrent third-party FA2 transfers share
 * timestamps with unrelated wallet ops and would get the wrong hash.
 */
export function attachHashesByLevel(
  address: string,
  xtzOps: TzKTTransaction[],
  tokenOps: TzKTTokenTransfer[]
): void {
  const addr = address.toLowerCase();
  const levelToHashes = new Map<number, Set<string>>();

  for (const op of xtzOps) {
    if (!op.hash || !op.level) continue;
    const involved =
      op.sender?.address?.toLowerCase() === addr ||
      op.target?.address?.toLowerCase() === addr;
    if (!involved) continue;
    if (!levelToHashes.has(op.level)) levelToHashes.set(op.level, new Set());
    levelToHashes.get(op.level)!.add(op.hash);
  }

  for (const tr of tokenOps) {
    if (tr.transactionHash) continue;
    const hashes = levelToHashes.get(tr.level);
    if (hashes && hashes.size === 1) {
      tr.transactionHash = Array.from(hashes)[0];
    }
  }
}

/** Delegations + originations (fee-only for tax; wallet is sender). */
export async function fetchFeeOnlyOperations(
  address: string,
  startIso: string,
  endIso: string
): Promise<TzKTTransaction[]> {
  const types = ['delegations', 'originations'] as const;
  const all: TzKTTransaction[] = [];
  for (const type of types) {
    const params = new URLSearchParams({
      sender: address,
      'timestamp.ge': startIso,
      'timestamp.lt': endIso,
      status: 'applied',
      quote: 'usd',
    });
    const ops = await fetchPaginatedById<TzKTTransaction>(
      `${TZKT_BASE}/operations/${type}?${params}`
    );
    for (const op of ops) {
      // Normalize so buildEvents can treat as fee-bearing root ops
      all.push({
        ...op,
        amount: op.amount ?? 0,
        parameter: { entrypoint: type === 'delegations' ? 'delegation' : 'origination' },
      });
    }
  }
  return all;
}

export async function fetchAllTransactions(
  address: string,
  startIso?: string,
  endIso?: string
): Promise<{ xtzOps: TzKTTransaction[]; tokenOps: TzKTTokenTransfer[] }> {
  // Default to all time — needed for prior-year cost basis
  const start = startIso || '2018-01-01T00:00:00Z';
  const end = endIso || new Date(Date.now() + 86400000).toISOString();

  const [xtzOps, tokenOps, feeOps] = await Promise.all([
    fetchXtzTransactions(address, start, end),
    fetchTokenTransfers(address, start, end),
    fetchFeeOnlyOperations(address, start, end),
  ]);

  const mergedXtz = [...xtzOps, ...feeOps];
  // Prefer local id→hash join, then API for remaining ids, then unique-level fallback
  await resolveTokenTransferHashes(tokenOps, mergedXtz, true);
  attachHashesByLevel(address, mergedXtz, tokenOps);

  return { xtzOps: mergedXtz, tokenOps };
}

export function buildEvents(
  address: string,
  xtzOps: TzKTTransaction[],
  tokenOps: TzKTTokenTransfer[]
): TxEvent[] {
  const addr = address.toLowerCase();
  const events: TxEvent[] = [];

  // Precompute fee per hash for root ops where this wallet is the fee payer
  const feeByHash = new Map<string, number>();
  for (const op of xtzOps) {
    if (!op.hash) continue;
    const isRoot = op.initiator == null && (op.nonce == null || op.nonce === undefined);
    const senderIsWallet = op.sender?.address?.toLowerCase() === addr;
    if (isRoot && senderIsWallet) {
      const feeXtz = totalFeeMutez(op) / 1_000_000;
      feeByHash.set(op.hash, (feeByHash.get(op.hash) || 0) + feeXtz);
    }
  }

  // Track which hash already had fee attached to an event
  const feeAttached = new Set<string>();

  for (const op of xtzOps) {
    if (!op.timestamp) continue;

    const sender = op.sender?.address || '';
    const target = op.target?.address || '';
    const senderLower = sender.toLowerCase();
    const targetLower = target.toLowerCase();

    // Only emit events for legs that touch this wallet
    const walletIsSender = senderLower === addr;
    const walletIsTarget = targetLower === addr;
    if (!walletIsSender && !walletIsTarget) continue;

    const amountMutez = Number(op.amount) || 0;
    const amountXtz = amountMutez / 1_000_000;

    let feeXtz = 0;
    if (op.hash && !feeAttached.has(op.hash) && walletIsSender) {
      feeXtz = feeByHash.get(op.hash) || 0;
      if (feeXtz > 0) feeAttached.add(op.hash);
    }

    // Skip zero-value non-fee contract calls that don't move tez for this wallet
    // Keep fee-only root calls (amount 0 but fee > 0)
    if (amountXtz === 0 && feeXtz === 0) {
      // Still keep entrypoint-bearing calls for classification (bids with wrapped XTZ etc.)
      const entrypoint = op.parameter?.entrypoint;
      if (!entrypoint) continue;
    }

    const direction: 'in' | 'out' = walletIsTarget && !walletIsSender ? 'in' : 'out';
    // For self-transfers both true — treat as out for fee accounting, tagged below
    const counterparty = direction === 'in' ? sender : target;
    const counterpartyAlias =
      direction === 'in' ? op.sender?.alias : op.target?.alias;
    const entrypoint = op.parameter?.entrypoint;
    const note = entrypoint ? `contract_call:${entrypoint}` : op.parameter ? 'contract_call' : 'transfer';
    const tags: string[] = [];
    let confidence: 'high' | 'medium' | 'low' = 'medium';

    if (amountXtz > 0 && direction === 'in') tags.push('receipt');
    if (amountXtz > 0 && direction === 'out') tags.push('payment_or_disposal');
    if (entrypoint) tags.push(`entry:${entrypoint}`);

    if (walletIsSender && walletIsTarget) {
      tags.push('self_transfer');
      confidence = 'high';
    }

    const id = `${address}:${op.hash}:xtz:${op.id ?? `${op.level}:${op.nonce ?? 'r'}`}`;

    events.push({
      id,
      walletAddress: address,
      timestamp: op.timestamp,
      level: op.level || 0,
      opHash: op.hash || '',
      kind: 'xtz_transfer',
      direction,
      counterparty,
      counterpartyName: counterpartyAlias,
      asset: 'XTZ',
      quantity: clamp(amountXtz),
      feeXtz: clamp(feeXtz),
      note,
      tags,
      confidence,
      entrypoint,
      quoteUsd: op.quote?.usd,
      quoteGbp: op.quote?.usd ? convertFromUSD(op.quote.usd, op.timestamp, 'gbp') : undefined,
      quoteCad: op.quote?.usd ? convertFromUSD(op.quote.usd, op.timestamp, 'cad') : undefined,
      quoteAud: op.quote?.usd ? convertFromUSD(op.quote.usd, op.timestamp, 'aud') : undefined,
    });
  }

  // If fee was never attached (e.g. only incoming legs), add a fee-only synthetic event
  for (const [hash, feeXtz] of feeByHash) {
    if (feeXtz <= 0 || feeAttached.has(hash)) continue;
    const sample = xtzOps.find((o) => o.hash === hash);
    if (!sample) continue;
    events.push({
      id: `${address}:${hash}:fee`,
      walletAddress: address,
      timestamp: sample.timestamp,
      level: sample.level || 0,
      opHash: hash,
      kind: 'xtz_transfer',
      direction: 'out',
      counterparty: sample.target?.address || '',
      asset: 'XTZ',
      quantity: 0,
      feeXtz: clamp(feeXtz),
      note: 'fee_only',
      tags: ['fee_only'],
      confidence: 'high',
      quoteUsd: sample.quote?.usd,
      quoteGbp: sample.quote?.usd
        ? convertFromUSD(sample.quote.usd, sample.timestamp, 'gbp')
        : undefined,
      quoteCad: sample.quote?.usd
        ? convertFromUSD(sample.quote.usd, sample.timestamp, 'cad')
        : undefined,
      quoteAud: sample.quote?.usd
        ? convertFromUSD(sample.quote.usd, sample.timestamp, 'aud')
        : undefined,
    });
  }

  for (const tr of tokenOps) {
    if (!tr.timestamp) continue;

    const fromAddr = tr.from?.address || '';
    const toAddr = tr.to?.address || '';
    const fromLower = fromAddr.toLowerCase();
    const toLower = toAddr.toLowerCase();
    if (fromLower !== addr && toLower !== addr) continue;

    const direction: 'in' | 'out' = toLower === addr ? 'in' : 'out';
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
    if (decimalsStr !== undefined && decimalsStr !== null && decimalsStr !== '') {
      try {
        qty = rawAmount / Math.pow(10, parseInt(String(decimalsStr), 10));
      } catch {
        qty = rawAmount;
      }
    }

    const asset = `${symbol || name || 'TOKEN'}:${contract}:${tokenId}:${standard}`;
    const tags: string[] = ['token_transfer'];
    let confidence: 'high' | 'medium' | 'low' = 'medium';

    if (
      standard.toUpperCase() === 'FA2' &&
      (!decimalsStr || decimalsStr === '0') &&
      rawAmount === 1
    ) {
      tags.push('likely_nft');
      confidence = 'high';
    }

    const isMint = direction === 'in' && !fromAddr;
    if (isMint) tags.push('minted');

    const opHash = tr.transactionHash || '';
    const id = `${address}:${opHash || tr.transactionId || ''}:token:${tr.id ?? `${tr.level}:${contract}:${tokenId}`}`;

    events.push({
      id,
      walletAddress: address,
      timestamp: tr.timestamp,
      level: tr.level || 0,
      opHash,
      kind: 'token_transfer',
      direction,
      counterparty,
      asset,
      quantity: clamp(qty),
      feeXtz: 0,
      note: 'token_transfer',
      tags,
      confidence,
      isMint,
      tokenCreators: token.metadata?.creators,
      quoteUsd: tr.quote?.usd,
      quoteGbp: tr.quote?.usd ? convertFromUSD(tr.quote.usd, tr.timestamp, 'gbp') : undefined,
      quoteCad: tr.quote?.usd ? convertFromUSD(tr.quote.usd, tr.timestamp, 'cad') : undefined,
      quoteAud: tr.quote?.usd ? convertFromUSD(tr.quote.usd, tr.timestamp, 'aud') : undefined,
    });
  }

  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return events;
}

/** Build events and fill missing XTZ quotes via CoinGecko fallback (client-side). */
export async function buildEventsWithPricing(
  address: string,
  xtzOps: TzKTTransaction[],
  tokenOps: TzKTTokenTransfer[]
): Promise<TxEvent[]> {
  const events = buildEvents(address, xtzOps, tokenOps);
  await enrichQuotesWithFallback(events);
  return events;
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n;
}

export function isValidTezosAddress(address: string): boolean {
  return /^(tz[123]|KT1)[a-zA-Z0-9]{33}$/.test(address.trim());
}

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

export async function getDelegationHistory(address: string): Promise<
  Array<{
    timestamp: string;
    delegate?: string;
    delegateAlias?: string;
  }>
> {
  try {
    const data = await fetchJson<
      Array<{
        timestamp: string;
        newDelegate?: {
          address: string;
          alias?: string;
        };
      }>
    >(`${TZKT_BASE}/accounts/${address}/delegations?limit=100`);

    return data.map((d) => ({
      timestamp: d.timestamp,
      delegate: d.newDelegate?.address,
      delegateAlias: d.newDelegate?.alias,
    }));
  } catch {
    return [];
  }
}
