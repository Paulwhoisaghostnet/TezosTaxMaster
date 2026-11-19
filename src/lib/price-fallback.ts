/**
 * Fallback XTZ price source when TzKT quote is missing.
 * Uses CoinGecko public API (no key) with in-memory day cache.
 */

import { TxEvent } from './db';
import { convertFromUSD } from './exchange-rates';

const COINGECKO = 'https://api.coingecko.com/api/v3';
const dayCache = new Map<string, number>();

async function fetchCoinGeckoUsd(dateYmd: string): Promise<number | null> {
  if (dayCache.has(dateYmd)) return dayCache.get(dateYmd)!;

  const [y, m, d] = dateYmd.split('-');
  const qdate = `${d}-${m}-${y}`;
  try {
    const url = `${COINGECKO}/coins/tezos/history?date=${encodeURIComponent(qdate)}&localization=false`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const price = Number(data?.market_data?.current_price?.usd);
    if (Number.isFinite(price) && price > 0) {
      dayCache.set(dateYmd, price);
      return price;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Fill missing quoteUsd (and derived GBP/CAD/AUD) for XTZ events.
 * NFT/token trades still get pricing from related XTZ legs in tax calc.
 */
export async function enrichQuotesWithFallback(events: TxEvent[]): Promise<void> {
  const missingDates = new Set<string>();
  for (const e of events) {
    if (e.asset === 'XTZ' && (!e.quoteUsd || e.quoteUsd <= 0)) {
      missingDates.add(e.timestamp.substring(0, 10));
    }
  }

  for (const date of missingDates) {
    await fetchCoinGeckoUsd(date);
    await new Promise((r) => setTimeout(r, 120));
  }

  for (const e of events) {
    if (e.asset !== 'XTZ') continue;
    if (e.quoteUsd && e.quoteUsd > 0) continue;
    const day = e.timestamp.substring(0, 10);
    const usd = dayCache.get(day);
    if (!usd) continue;
    e.quoteUsd = usd;
    e.quoteGbp = convertFromUSD(usd, e.timestamp, 'gbp');
    e.quoteCad = convertFromUSD(usd, e.timestamp, 'cad');
    e.quoteAud = convertFromUSD(usd, e.timestamp, 'aud');
    e.tags = [...(e.tags || []), 'price_fallback_coingecko'];
  }
}

/** Pure helper for tests — seed cache without network */
export function seedPriceCache(dateYmd: string, usd: number): void {
  dayCache.set(dateYmd, usd);
}
