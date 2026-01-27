/**
 * Historical Daily Exchange Rates (USD base)
 * 
 * Daily rates for converting USD to other currencies.
 * Data sourced from:
 * - Bank of Canada (Valet API) for USD/CAD rates
 * - European Central Bank (via Frankfurter API) for USD/GBP rates
 * - Reserve Bank of Australia for USD/AUD rates
 * 
 * Coverage: 2017-01-02 through 2025-01-27 (2,080 business days)
 * 
 * Format: YYYY-MM-DD -> { gbp: rate, cad: rate, aud: rate }
 * Rate meaning: 1 USD = X foreign currency
 */

import ratesData from '../data/exchange-rates.json';

interface DailyRate {
  gbp: number; // 1 USD = X GBP
  cad: number; // 1 USD = X CAD
  aud?: number; // 1 USD = X AUD (optional for backward compatibility)
}

// Type assertion for the imported JSON data
const DAILY_RATES: Record<string, DailyRate> = ratesData as Record<string, DailyRate>;

// Default fallback rate (latest known rate as of Jan 2025)
const DEFAULT_RATE: DailyRate = { gbp: 0.7965, cad: 1.4387, aud: 1.5893 };

/**
 * Get the exchange rate for a specific date
 * @param timestamp ISO timestamp string (e.g., "2023-05-15T10:30:00Z")
 * @param currency Target currency ('gbp', 'cad', or 'aud')
 * @returns Exchange rate (1 USD = X target currency)
 */
export function getExchangeRate(timestamp: string, currency: 'gbp' | 'cad' | 'aud'): number {
  // Extract YYYY-MM-DD from timestamp
  const dateKey = timestamp.substring(0, 10);
  
  const rate = DAILY_RATES[dateKey];
  if (rate) {
    return rate[currency] ?? DEFAULT_RATE[currency] ?? 1;
  }
  
  // If exact date not found, try to find closest available
  const sortedKeys = Object.keys(DAILY_RATES).sort();
  
  // Handle case where date is before all our data
  if (dateKey < sortedKeys[0]) {
    return DAILY_RATES[sortedKeys[0]]?.[currency] ?? DEFAULT_RATE[currency] ?? 1;
  }
  
  // Handle case where date is after all our data
  if (dateKey > sortedKeys[sortedKeys.length - 1]) {
    return DAILY_RATES[sortedKeys[sortedKeys.length - 1]]?.[currency] ?? DEFAULT_RATE[currency] ?? 1;
  }
  
  // Find the closest date that's before or equal to the requested date
  // (handles weekends/holidays by using previous business day)
  let closestKey = sortedKeys[0];
  for (const key of sortedKeys) {
    if (key <= dateKey) {
      closestKey = key;
    } else {
      break;
    }
  }
  
  return DAILY_RATES[closestKey]?.[currency] ?? DEFAULT_RATE[currency] ?? 1;
}

/**
 * Convert USD amount to another currency for a specific date
 * @param usdAmount Amount in USD
 * @param timestamp ISO timestamp string
 * @param currency Target currency
 * @returns Amount in target currency
 */
export function convertFromUSD(usdAmount: number, timestamp: string, currency: 'gbp' | 'cad' | 'aud'): number {
  const rate = getExchangeRate(timestamp, currency);
  return usdAmount * rate;
}

/**
 * Get all exchange rates for a specific date
 * @param timestamp ISO timestamp string
 * @returns Object with all currency rates
 */
export function getAllRatesForDate(timestamp: string): DailyRate {
  const dateKey = timestamp.substring(0, 10);
  
  if (DAILY_RATES[dateKey]) {
    return DAILY_RATES[dateKey];
  }
  
  // Find closest date
  const sortedKeys = Object.keys(DAILY_RATES).sort();
  
  if (dateKey < sortedKeys[0]) {
    return DAILY_RATES[sortedKeys[0]] ?? DEFAULT_RATE;
  }
  
  if (dateKey > sortedKeys[sortedKeys.length - 1]) {
    return DAILY_RATES[sortedKeys[sortedKeys.length - 1]] ?? DEFAULT_RATE;
  }
  
  let closestKey = sortedKeys[0];
  for (const key of sortedKeys) {
    if (key <= dateKey) {
      closestKey = key;
    } else {
      break;
    }
  }
  
  return DAILY_RATES[closestKey] ?? DEFAULT_RATE;
}

/**
 * Check if we have historical data for a given date
 * @param timestamp ISO timestamp string
 * @returns true if we have data for that exact date
 */
export function hasHistoricalData(timestamp: string): boolean {
  const dateKey = timestamp.substring(0, 10);
  return dateKey in DAILY_RATES;
}

/**
 * Get the date range covered by the exchange rate data
 * @returns Object with firstDate and lastDate
 */
export function getDataDateRange(): { firstDate: string; lastDate: string } {
  const sortedKeys = Object.keys(DAILY_RATES).sort();
  return {
    firstDate: sortedKeys[0] ?? '',
    lastDate: sortedKeys[sortedKeys.length - 1] ?? '',
  };
}

/**
 * Get the total number of dates in the rate table
 */
export function getRateCount(): number {
  return Object.keys(DAILY_RATES).length;
}

// Export for debugging/testing
export { DAILY_RATES, DEFAULT_RATE };
