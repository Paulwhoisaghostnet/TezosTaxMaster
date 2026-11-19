/**
 * IndexedDB wrapper for local-first storage
 * All user data stays in their browser - nothing sent to servers
 */

import { openDB, DBSchema, IDBPDatabase } from 'idb';

// Types
export interface Wallet {
  address: string;
  alias?: string;
  addedAt: string;
  lastSyncedAt?: string;
  // Delegation info (fetched during sync)
  delegate?: string; // Current baker address
  delegateName?: string; // Baker name if known
}

export interface TxEvent {
  id: string; // composite: address:opHash:index
  walletAddress: string;
  timestamp: string;
  level: number;
  opHash: string;
  kind: 'xtz_transfer' | 'token_transfer';
  direction: 'in' | 'out';
  counterparty: string;
  asset: string;
  quantity: number;
  feeXtz: number;
  note: string;
  tags: string[];
  confidence: 'high' | 'medium' | 'low';
  // Prices from TzKT quote data (captured at sync time)
  quoteUsd?: number; // XTZ price in USD at transaction time
  quoteGbp?: number; // XTZ price in GBP at transaction time
  quoteCad?: number; // XTZ price in CAD at transaction time
  quoteAud?: number; // XTZ price in AUD at transaction time
  // Mint detection (token was minted/created, not purchased)
  isMint?: boolean; // True if token was received with no from address (minted)
  entrypoint?: string; // Contract entrypoint when known
  tokenCreators?: string[]; // FA2 creators metadata when present
  // Smart classification (set during post-processing)
  classification?:
    | 'swap' // Part of a DEX swap (XTZ ↔ token)
    | 'self_transfer' // Transfer between user's own wallets
    | 'cex_deposit' // Sent to centralized exchange
    | 'cex_withdrawal' // Received from centralized exchange
    | 'baking_reward' // Reward from delegated baker
    | 'nft_purchase' // XTZ out + NFT in
    | 'nft_sale' // NFT out + XTZ in
    | 'creator_sale' // Sold a token that was minted/created (ordinary income)
    | 'royalty_income' // Royalty share from secondary sale
    | 'auction_bid_escrow' // XTZ locked in auction / offer escrow
    | 'offer_escrow' // XTZ locked in offer escrow
    | 'escrow_refund' // Escrow returned (non-taxable)
    | 'likely_gift' // Sent XTZ with no corresponding receipt (taxable disposal) — after review
    | 'token_gift_out' // Sent token/NFT with no corresponding receipt (taxable disposal)
    | 'received_income' // Received XTZ from external address (taxable income) — after review
    | 'token_received' // Received token/NFT from external address (cost basis = FMV)
    | 'dex_interaction' // Other DEX interaction
    | 'needs_review' // Unexplained transfer — owner must classify
    | 'ignore' // Owner marked non-taxable / ignore
    | 'unknown'; // Needs manual review
  classificationNote?: string; // Additional context
  relatedOpHash?: string; // For swaps, link to the other leg
  counterpartyType?:
    | 'cex'
    | 'dex'
    | 'nft_marketplace'
    | 'baker'
    | 'contract'
    | 'owned_wallet'
    | 'unknown_wallet';
  counterpartyName?: string; // e.g., "Kraken", "QuipuSwap"
  userOverride?: boolean; // True when classification came from review/relabel
}

export interface ClassificationOverride {
  eventId: string;
  classification: NonNullable<TxEvent['classification']>;
  note?: string;
  updatedAt: string;
}

export interface PriceCache {
  id: string; // date:currency
  date: string; // YYYY-MM-DD
  currency: 'usd' | 'gbp' | 'cad';
  xtzPrice: number;
  fetchedAt: string;
}

export interface TaxReport {
  id: string;
  createdAt: string;
  year: number;
  jurisdiction: 'irs' | 'hmrc' | 'cra' | 'ato';
  walletAddresses: string[];
  summary: {
    totalDisposals: number;
    totalProceeds: number;
    totalCostBasis: number;
    totalGain: number;
    taxableGain?: number; // For CRA: 50% inclusion, For ATO: after 50% CGT discount
    longTermGain?: number; // ATO: gains on assets held > 12 months
    shortTermGain?: number; // ATO: gains on assets held <= 12 months
    cgtDiscount?: number; // ATO: 50% discount amount on long-term gains
    totalIncome?: number; // Total income from all sources
    confirmedIncome?: number; // All income is confirmed
    stakingIncome?: number; // Baking/staking rewards
    creatorIncome?: number; // Sales of self-created tokens
    receivedIncome?: number; // XTZ received from external addresses
    currency: string;
  };
  eventsJson: string;
  disposalsJson: string;
  incomeEventsJson?: string; // Detailed income events
}

interface TaxMasterDB extends DBSchema {
  wallets: {
    key: string;
    value: Wallet;
    indexes: { 'by-added': string };
  };
  events: {
    key: string;
    value: TxEvent;
    indexes: {
      'by-wallet': string;
      'by-timestamp': string;
      'by-wallet-timestamp': [string, string];
    };
  };
  priceCache: {
    key: string;
    value: PriceCache;
  };
  reports: {
    key: string;
    value: TaxReport;
    indexes: { 'by-created': string };
  };
  classificationOverrides: {
    key: string;
    value: ClassificationOverride;
  };
}

let dbInstance: IDBPDatabase<TaxMasterDB> | null = null;

export async function getDB(): Promise<IDBPDatabase<TaxMasterDB>> {
  if (dbInstance) return dbInstance;

  dbInstance = await openDB<TaxMasterDB>('taxmaster', 2, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const walletStore = db.createObjectStore('wallets', { keyPath: 'address' });
        walletStore.createIndex('by-added', 'addedAt');

        const eventStore = db.createObjectStore('events', { keyPath: 'id' });
        eventStore.createIndex('by-wallet', 'walletAddress');
        eventStore.createIndex('by-timestamp', 'timestamp');
        eventStore.createIndex('by-wallet-timestamp', ['walletAddress', 'timestamp']);

        db.createObjectStore('priceCache', { keyPath: 'id' });

        const reportStore = db.createObjectStore('reports', { keyPath: 'id' });
        reportStore.createIndex('by-created', 'createdAt');
      }
      if (oldVersion < 2) {
        if (!db.objectStoreNames.contains('classificationOverrides')) {
          db.createObjectStore('classificationOverrides', { keyPath: 'eventId' });
        }
      }
    },
  });

  return dbInstance;
}

// Wallet operations
export async function addWallet(address: string, alias?: string): Promise<Wallet> {
  const db = await getDB();
  const wallet: Wallet = {
    address: address.trim(),
    alias,
    addedAt: new Date().toISOString(),
  };
  await db.put('wallets', wallet);
  return wallet;
}

export async function getWallets(): Promise<Wallet[]> {
  const db = await getDB();
  return db.getAllFromIndex('wallets', 'by-added');
}

export async function getWallet(address: string): Promise<Wallet | undefined> {
  const db = await getDB();
  return db.get('wallets', address);
}

export async function deleteWallet(address: string): Promise<void> {
  const db = await getDB();
  await db.delete('wallets', address);
  // Also delete associated events
  const events = await db.getAllFromIndex('events', 'by-wallet', address);
  const tx = db.transaction('events', 'readwrite');
  for (const event of events) {
    await tx.store.delete(event.id);
  }
  await tx.done;
}

export async function updateWalletSyncTime(address: string): Promise<void> {
  const db = await getDB();
  const wallet = await db.get('wallets', address);
  if (wallet) {
    wallet.lastSyncedAt = new Date().toISOString();
    await db.put('wallets', wallet);
  }
}

// Event operations
export async function saveEvents(events: TxEvent[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('events', 'readwrite');
  for (const event of events) {
    await tx.store.put(event);
  }
  await tx.done;
}

export async function getEventsForWallet(address: string): Promise<TxEvent[]> {
  const db = await getDB();
  return db.getAllFromIndex('events', 'by-wallet', address);
}

export async function getEventsForWallets(addresses: string[]): Promise<TxEvent[]> {
  const db = await getDB();
  const allEvents: TxEvent[] = [];
  for (const address of addresses) {
    const events = await db.getAllFromIndex('events', 'by-wallet', address);
    allEvents.push(...events);
  }
  return allEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function getTaxYearBounds(
  year: number,
  jurisdiction?: 'irs' | 'hmrc' | 'cra' | 'ato'
): { startIso: string; endIso: string } {
  if (jurisdiction === 'hmrc') {
    return {
      startIso: `${year}-04-06T00:00:00Z`,
      endIso: `${year + 1}-04-06T00:00:00Z`,
    };
  }
  if (jurisdiction === 'ato') {
    return {
      startIso: `${year}-07-01T00:00:00Z`,
      endIso: `${year + 1}-07-01T00:00:00Z`,
    };
  }
  return {
    startIso: `${year}-01-01T00:00:00Z`,
    endIso: `${year + 1}-01-01T00:00:00Z`,
  };
}

/**
 * Events strictly inside the tax year (for display). Prefer getEventsForLotMatching
 * when calculating gains so prior-year acquisitions seed FIFO/ACB lots.
 */
export async function getEventsForYear(
  addresses: string[],
  year: number,
  jurisdiction?: 'irs' | 'hmrc' | 'cra' | 'ato'
): Promise<TxEvent[]> {
  const { startIso, endIso } = getTaxYearBounds(year, jurisdiction);
  const allEvents = await getEventsForWallets(addresses);
  return allEvents.filter((e) => e.timestamp >= startIso && e.timestamp < endIso);
}

/** Full history for selected wallets — required for correct cost basis. */
export async function getEventsForLotMatching(addresses: string[]): Promise<TxEvent[]> {
  return getEventsForWallets(addresses);
}

export async function saveClassificationOverride(
  override: ClassificationOverride
): Promise<void> {
  const db = await getDB();
  await db.put('classificationOverrides', override);
}

export async function getClassificationOverrides(): Promise<ClassificationOverride[]> {
  const db = await getDB();
  return db.getAll('classificationOverrides');
}

export async function deleteClassificationOverride(eventId: string): Promise<void> {
  const db = await getDB();
  await db.delete('classificationOverrides', eventId);
}

export function applyOverridesToEvents(
  events: TxEvent[],
  overrides: ClassificationOverride[]
): TxEvent[] {
  if (overrides.length === 0) return events;
  const map = new Map(overrides.map((o) => [o.eventId, o]));
  return events.map((e) => {
    const o = map.get(e.id);
    if (!o) return e;
    return {
      ...e,
      classification: o.classification,
      classificationNote: o.note || e.classificationNote,
      userOverride: true,
      confidence: 'high' as const,
    };
  });
}

export async function clearEventsForWallet(address: string): Promise<void> {
  const db = await getDB();
  const events = await db.getAllFromIndex('events', 'by-wallet', address);
  const tx = db.transaction('events', 'readwrite');
  for (const event of events) {
    await tx.store.delete(event.id);
  }
  await tx.done;
}

// Price cache operations
export async function getCachedPrice(date: string, currency: 'usd' | 'gbp'): Promise<number | null> {
  const db = await getDB();
  const key = `${date}:${currency}`;
  const cached = await db.get('priceCache', key);
  if (cached) {
    return cached.xtzPrice;
  }
  return null;
}

export async function setCachedPrice(date: string, currency: 'usd' | 'gbp', price: number): Promise<void> {
  const db = await getDB();
  const id = `${date}:${currency}`;
  await db.put('priceCache', {
    id,
    date,
    currency,
    xtzPrice: price,
    fetchedAt: new Date().toISOString(),
  });
}

// Report operations
export async function saveReport(report: TaxReport): Promise<void> {
  const db = await getDB();
  await db.put('reports', report);
}

export async function getReports(): Promise<TaxReport[]> {
  const db = await getDB();
  const reports = await db.getAllFromIndex('reports', 'by-created');
  return reports.reverse(); // newest first
}

export async function getReport(id: string): Promise<TaxReport | undefined> {
  const db = await getDB();
  return db.get('reports', id);
}

export async function deleteReport(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('reports', id);
}

// Export all data (for backup)
export async function exportAllData(): Promise<{
  wallets: Wallet[];
  events: TxEvent[];
  reports: TaxReport[];
}> {
  const db = await getDB();
  return {
    wallets: await db.getAll('wallets'),
    events: await db.getAll('events'),
    reports: await db.getAll('reports'),
  };
}

// Import data (for restore)
export async function importData(data: {
  wallets?: Wallet[];
  events?: TxEvent[];
  reports?: TaxReport[];
}): Promise<void> {
  const db = await getDB();
  
  if (data.wallets) {
    const tx = db.transaction('wallets', 'readwrite');
    for (const wallet of data.wallets) {
      await tx.store.put(wallet);
    }
    await tx.done;
  }
  
  if (data.events) {
    const tx = db.transaction('events', 'readwrite');
    for (const event of data.events) {
      await tx.store.put(event);
    }
    await tx.done;
  }
  
  if (data.reports) {
    const tx = db.transaction('reports', 'readwrite');
    for (const report of data.reports) {
      await tx.store.put(report);
    }
    await tx.done;
  }
}

// Clear all data
export async function clearAllData(): Promise<void> {
  const db = await getDB();
  await db.clear('wallets');
  await db.clear('events');
  await db.clear('priceCache');
  await db.clear('reports');
  if (db.objectStoreNames.contains('classificationOverrides')) {
    await db.clear('classificationOverrides');
  }
}
