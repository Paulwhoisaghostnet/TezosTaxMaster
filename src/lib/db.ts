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
  // Mint detection (token was minted/created, not purchased)
  isMint?: boolean; // True if token was received with no from address (minted)
  // Smart classification (set during post-processing)
  classification?: 
    | 'swap'              // Part of a DEX swap (XTZ ↔ token)
    | 'self_transfer'     // Transfer between user's own wallets
    | 'cex_deposit'       // Sent to centralized exchange
    | 'cex_withdrawal'    // Received from centralized exchange
    | 'baking_reward'     // Reward from delegated baker
    | 'nft_purchase'      // XTZ out + NFT in
    | 'nft_sale'          // NFT out + XTZ in
    | 'creator_sale'      // Sold a token that was minted/created (ordinary income)
    | 'likely_gift'       // Sent XTZ with no corresponding receipt (taxable disposal)
    | 'token_gift_out'    // Sent token/NFT with no corresponding receipt (taxable disposal)
    | 'received_income'   // Received XTZ from external address (taxable income)
    | 'token_received'    // Received token/NFT from external address (cost basis = FMV)
    | 'dex_interaction'   // Other DEX interaction
    | 'unknown';          // Needs manual review
  classificationNote?: string; // Additional context
  relatedOpHash?: string; // For swaps, link to the other leg
  counterpartyType?: 'cex' | 'dex' | 'baker' | 'contract' | 'owned_wallet' | 'unknown_wallet';
  counterpartyName?: string; // e.g., "Kraken", "QuipuSwap"
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
  jurisdiction: 'irs' | 'hmrc' | 'cra';
  walletAddresses: string[];
  summary: {
    totalDisposals: number;
    totalProceeds: number;
    totalCostBasis: number;
    totalGain: number;
    taxableGain?: number; // For CRA: 50% of capital gains only
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
}

let dbInstance: IDBPDatabase<TaxMasterDB> | null = null;

export async function getDB(): Promise<IDBPDatabase<TaxMasterDB>> {
  if (dbInstance) return dbInstance;

  dbInstance = await openDB<TaxMasterDB>('taxmaster', 1, {
    upgrade(db) {
      // Wallets store
      const walletStore = db.createObjectStore('wallets', { keyPath: 'address' });
      walletStore.createIndex('by-added', 'addedAt');

      // Events store
      const eventStore = db.createObjectStore('events', { keyPath: 'id' });
      eventStore.createIndex('by-wallet', 'walletAddress');
      eventStore.createIndex('by-timestamp', 'timestamp');
      eventStore.createIndex('by-wallet-timestamp', ['walletAddress', 'timestamp']);

      // Price cache store
      db.createObjectStore('priceCache', { keyPath: 'id' });

      // Reports store
      const reportStore = db.createObjectStore('reports', { keyPath: 'id' });
      reportStore.createIndex('by-created', 'createdAt');
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

export async function getEventsForYear(addresses: string[], year: number): Promise<TxEvent[]> {
  const startIso = `${year}-01-01T00:00:00Z`;
  const endIso = `${year + 1}-01-01T00:00:00Z`;
  
  const allEvents = await getEventsForWallets(addresses);
  return allEvents.filter(e => e.timestamp >= startIso && e.timestamp < endIso);
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
}
