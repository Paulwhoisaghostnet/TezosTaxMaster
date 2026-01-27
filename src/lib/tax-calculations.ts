/**
 * Tax calculation engines for IRS and HMRC
 * 
 * IRS: FIFO cost basis matching (Notice 2014-21, Rev. Rul. 2019-24, 2023-14)
 * HMRC: Same-day, 30-day, then Section 104 pooling (CRYPTO22200 series)
 * 
 * Uses smart classification to properly handle:
 * - Self-transfers (not taxable)
 * - CEX deposits (not taxable until sold)
 * - Baking rewards (ordinary income)
 * - Swaps (both legs taxable)
 * - Gifts (taxable disposal)
 */

import { TxEvent } from './db';

// Types
export interface IRSLedgerEntry {
  timestamp: string;
  level: number;
  opHash: string;
  kind: string;
  direction: string;
  counterparty: string;
  asset: string;
  quantity: number;
  feeXtz: number;
  tags: string[];
  confidence: string;
  classification?: string;
  classificationNote?: string;
  irsCategory: string;
  irsTaxable: string;
  xtzFmvUsd: number;
}

export interface IRSDisposal {
  timestamp: string;
  asset: string;
  qtyDisposed: number;
  fmvUsdPerXtz: number;
  proceedsUsd: number;
  basisUsd: number;
  gainUsd: number;
  feeXtz: number;
  opHash: string;
  lotBreakdown: Array<{
    fromLotAcquiredTs: string;
    takeQty: number;
    basisPerUsd: number;
  }>;
  classification?: string;
  note: string;
}

export interface HMRCDisposal {
  timestamp: string;
  asset: string;
  qtyDisposed: number;
  fmvGbpPerXtz: number;
  proceedsGbp: number;
  allowableCostGbp: number;
  gainGbp: number;
  opHash: string;
  matchingBreakdown: Array<{
    rule?: string;
    fromAcqTs?: string;
    takeQty: number;
    costPerGbp?: number;
    avgCostPerGbp?: number;
  }>;
  classification?: string;
  note: string;
}

export interface TaxCalculationResult {
  ledger: IRSLedgerEntry[];
  disposals: IRSDisposal[] | HMRCDisposal[];
  summary: {
    totalDisposals: number;
    totalProceeds: number;
    totalCostBasis: number;
    totalGain: number;
    currency: string;
  };
  incomeEvents: Array<{
    timestamp: string;
    type: string;
    quantity: number;
    fmv: number;
    note: string;
  }>;
}

interface FifoLot {
  acquiredTs: string;
  qty: number;
  basisPer: number;
}

/**
 * Check if an event is a taxable disposal
 */
function isTaxableDisposal(e: TxEvent): boolean {
  // Self-transfers are not taxable
  if (e.classification === 'self_transfer') return false;
  
  // CEX deposits are not taxable (taxable when sold on CEX)
  if (e.classification === 'cex_deposit') return false;
  
  // Outgoing XTZ or tokens are generally taxable disposals
  if (e.direction === 'out' && e.quantity > 0) return true;
  
  return false;
}

/**
 * Check if an event is taxable income
 */
function isTaxableIncome(e: TxEvent): boolean {
  // Baking rewards are ordinary income
  if (e.classification === 'baking_reward') return true;
  
  // CEX withdrawals are not income (you already owned it)
  if (e.classification === 'cex_withdrawal') return false;
  
  // Self-transfers are not income
  if (e.classification === 'self_transfer') return false;
  
  // Swaps - the incoming leg is not separate income
  if (e.classification === 'swap' && e.direction === 'in') return false;
  
  return false;
}

/**
 * Get disposal note based on classification
 */
function getDisposalNote(e: TxEvent): string {
  switch (e.classification) {
    case 'swap':
      return `Swap: ${e.classificationNote || 'DEX trade'}`;
    case 'likely_gift':
      return 'Likely gift - verify with records. Gifts are taxable disposals at FMV.';
    case 'nft_purchase':
      return 'NFT purchase';
    case 'nft_sale':
      return 'NFT sale';
    case 'dex_interaction':
      return `DEX interaction: ${e.classificationNote || 'Unknown'}`;
    default:
      return 'FIFO used if you did not specifically identify units (IRS FAQ).';
  }
}

/**
 * IRS FIFO calculation
 * - Acquisitions create lots with basis = FMV at receipt
 * - Disposals consume lots in FIFO order
 * - Uses stored quoteUsd from TzKT (no external API calls)
 * - Respects smart classification for proper tax treatment
 */
export function calculateIRS(
  events: TxEvent[],
  onProgress?: (progress: number, message: string) => void
): TaxCalculationResult {
  const ledger: IRSLedgerEntry[] = [];
  const disposals: IRSDisposal[] = [];
  const incomeEvents: TaxCalculationResult['incomeEvents'] = [];
  const xtzLots: FifoLot[] = [];
  
  let totalProceeds = 0;
  let totalBasis = 0;
  let totalGain = 0;
  
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const fmvUsd = e.asset === 'XTZ' ? (e.quoteUsd || 0) : 0;
    
    let irsCategory = 'review';
    let taxable = 'unknown';
    
    if (e.asset === 'XTZ') {
      // Handle based on classification
      if (e.classification === 'self_transfer') {
        irsCategory = 'self_transfer';
        taxable = 'no';
        // Don't create lots or disposals for self-transfers
      } else if (e.classification === 'cex_deposit') {
        irsCategory = 'cex_deposit';
        taxable = 'no';
        // Don't create disposal - will be taxed when sold on exchange
      } else if (e.classification === 'cex_withdrawal') {
        irsCategory = 'cex_withdrawal';
        taxable = 'no';
        // Create lot with basis = cost on exchange (unknown, use FMV as fallback)
        xtzLots.push({
          acquiredTs: e.timestamp,
          qty: e.quantity,
          basisPer: fmvUsd,
        });
      } else if (e.classification === 'baking_reward') {
        irsCategory = 'ordinary_income';
        taxable = 'yes';
        // Baking rewards are income at FMV when received
        xtzLots.push({
          acquiredTs: e.timestamp,
          qty: e.quantity,
          basisPer: fmvUsd,
        });
        incomeEvents.push({
          timestamp: e.timestamp,
          type: 'Baking Reward',
          quantity: e.quantity,
          fmv: e.quantity * fmvUsd,
          note: e.classificationNote || 'Staking/baking reward',
        });
      } else if (e.direction === 'in' && e.quantity > 0) {
        // Other acquisitions
        irsCategory = e.classification === 'swap' 
          ? 'swap_acquisition' 
          : 'acquisition_or_income_review';
        taxable = e.classification === 'swap' ? 'no' : 'maybe';
        
        xtzLots.push({
          acquiredTs: e.timestamp,
          qty: e.quantity,
          basisPer: fmvUsd,
        });
      } else if (isTaxableDisposal(e)) {
        // Taxable disposal
        irsCategory = e.classification === 'likely_gift' 
          ? 'gift_disposal' 
          : e.classification === 'swap'
            ? 'swap_disposal'
            : 'disposal_capital';
        taxable = 'yes';
        
        let qtyToDispose = e.quantity;
        const proceeds = qtyToDispose * fmvUsd;
        let basis = 0;
        const lotDetails: IRSDisposal['lotBreakdown'] = [];
        
        // FIFO matching
        while (qtyToDispose > 1e-12 && xtzLots.length > 0) {
          const lot = xtzLots[0];
          const take = Math.min(qtyToDispose, lot.qty);
          basis += take * lot.basisPer;
          
          lotDetails.push({
            fromLotAcquiredTs: lot.acquiredTs,
            takeQty: take,
            basisPerUsd: lot.basisPer,
          });
          
          lot.qty -= take;
          qtyToDispose -= take;
          
          if (lot.qty <= 1e-12) {
            xtzLots.shift();
          }
        }
        
        const gain = proceeds - basis;
        totalProceeds += proceeds;
        totalBasis += basis;
        totalGain += gain;
        
        disposals.push({
          timestamp: e.timestamp,
          asset: e.asset,
          qtyDisposed: e.quantity,
          fmvUsdPerXtz: round(fmvUsd, 8),
          proceedsUsd: round(proceeds, 8),
          basisUsd: round(basis, 8),
          gainUsd: round(gain, 8),
          feeXtz: e.feeXtz,
          opHash: e.opHash,
          lotBreakdown: lotDetails,
          classification: e.classification,
          note: getDisposalNote(e),
        });
      }
    } else {
      // Token/NFT
      if (e.direction === 'out') {
        irsCategory = e.classification === 'nft_sale' 
          ? 'nft_sale' 
          : 'token_disposal_review';
        taxable = e.classification === 'self_transfer' ? 'no' : 'likely';
      } else {
        irsCategory = e.classification === 'nft_purchase'
          ? 'nft_purchase'
          : 'token_acquisition_or_income_review';
        taxable = 'maybe';
      }
    }
    
    ledger.push({
      timestamp: e.timestamp,
      level: e.level,
      opHash: e.opHash,
      kind: e.kind,
      direction: e.direction,
      counterparty: e.counterparty,
      asset: e.asset,
      quantity: e.quantity,
      feeXtz: e.feeXtz,
      tags: e.tags,
      confidence: e.confidence,
      classification: e.classification,
      classificationNote: e.classificationNote,
      irsCategory,
      irsTaxable: taxable,
      xtzFmvUsd: e.asset === 'XTZ' ? round(fmvUsd, 8) : 0,
    });
    
    onProgress?.(((i + 1) / events.length) * 100, `Processing event ${i + 1}/${events.length}`);
  }
  
  return {
    ledger,
    disposals,
    incomeEvents,
    summary: {
      totalDisposals: disposals.length,
      totalProceeds: round(totalProceeds, 2),
      totalCostBasis: round(totalBasis, 2),
      totalGain: round(totalGain, 2),
      currency: 'USD',
    },
  };
}

/**
 * HMRC pooling calculation
 * - Same-day matching first
 * - 30-day rule (acquisitions within 30 days AFTER disposal)
 * - Then Section 104 pool average cost
 * - Uses stored quoteGbp from TzKT (no external API calls)
 * - Respects smart classification for proper tax treatment
 */
export function calculateHMRC(
  events: TxEvent[],
  onProgress?: (progress: number, message: string) => void
): TaxCalculationResult {
  const disposals: HMRCDisposal[] = [];
  const incomeEvents: TaxCalculationResult['incomeEvents'] = [];
  
  // Filter and sort XTZ events
  const xtzEvents = events.filter(e => e.asset === 'XTZ' && e.quantity > 0);
  xtzEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  
  // Build acquisition records by day
  interface AcqRecord {
    ts: string;
    dt: Date;
    qty: number;
    costPer: number;
  }
  
  const acqByDay: Map<string, AcqRecord[]> = new Map();
  const allAcquisitions: AcqRecord[] = [];
  
  // Section 104 pool
  let poolQty = 0;
  let poolCostGbp = 0;
  
  // First pass: collect all acquisitions (excluding self-transfers and CEX deposits)
  for (const e of xtzEvents) {
    if (e.direction === 'in' && e.classification !== 'self_transfer') {
      const fmvGbp = e.quoteGbp || 0;
      const dt = new Date(e.timestamp);
      const day = e.timestamp.substring(0, 10);
      
      // Track baking rewards as income
      if (e.classification === 'baking_reward') {
        incomeEvents.push({
          timestamp: e.timestamp,
          type: 'Baking Reward',
          quantity: e.quantity,
          fmv: e.quantity * fmvGbp,
          note: e.classificationNote || 'Staking/baking reward',
        });
      }
      
      const rec: AcqRecord = {
        ts: e.timestamp,
        dt,
        qty: e.quantity,
        costPer: fmvGbp,
      };
      
      if (!acqByDay.has(day)) {
        acqByDay.set(day, []);
      }
      acqByDay.get(day)!.push(rec);
      allAcquisitions.push(rec);
    }
  }
  
  let totalProceeds = 0;
  let totalCost = 0;
  let totalGain = 0;
  
  // Second pass: process disposals with HMRC matching
  let processedCount = 0;
  for (const e of xtzEvents) {
    const fmvGbp = e.quoteGbp || 0;
    
    if (e.direction === 'in' && e.classification !== 'self_transfer') {
      // Add to Section 104 pool
      poolQty += e.quantity;
      poolCostGbp += e.quantity * fmvGbp;
      processedCount++;
      continue;
    }
    
    // Skip non-taxable events
    if (!isTaxableDisposal(e)) {
      processedCount++;
      continue;
    }
    
    // Disposal
    const dt = new Date(e.timestamp);
    const day = e.timestamp.substring(0, 10);
    let qty = e.quantity;
    const proceeds = qty * fmvGbp;
    let costTotal = 0;
    const matchUsed: HMRCDisposal['matchingBreakdown'] = [];
    
    // 1) Same-day matching
    const sameDayList = acqByDay.get(day) || [];
    for (const rec of sameDayList) {
      if (qty <= 1e-12) break;
      if (rec.qty <= 1e-12) continue;
      
      const take = Math.min(qty, rec.qty);
      costTotal += take * rec.costPer;
      matchUsed.push({
        rule: 'same-day',
        fromAcqTs: rec.ts,
        takeQty: take,
        costPerGbp: rec.costPer,
      });
      
      rec.qty -= take;
      qty -= take;
    }
    
    // 2) 30-day rule (acquisitions AFTER disposal within 30 days)
    if (qty > 1e-12) {
      const thirtyDayEnd = new Date(dt.getTime() + 30 * 24 * 60 * 60 * 1000);
      
      const eligibleAcqs = allAcquisitions
        .filter(a => a.dt > dt && a.dt <= thirtyDayEnd && a.qty > 1e-12)
        .sort((a, b) => a.dt.getTime() - b.dt.getTime());
      
      for (const rec of eligibleAcqs) {
        if (qty <= 1e-12) break;
        
        const take = Math.min(qty, rec.qty);
        costTotal += take * rec.costPer;
        matchUsed.push({
          rule: '30-day',
          fromAcqTs: rec.ts,
          takeQty: take,
          costPerGbp: rec.costPer,
        });
        
        rec.qty -= take;
        qty -= take;
      }
    }
    
    // 3) Section 104 pool for remainder
    if (qty > 1e-12) {
      if (poolQty > 1e-12) {
        const avgCost = poolCostGbp / poolQty;
        const poolCost = qty * avgCost;
        
        matchUsed.push({
          rule: 'S104',
          takeQty: qty,
          avgCostPerGbp: avgCost,
        });
        
        // Reduce pool
        poolQty -= qty;
        poolCostGbp -= poolCost;
        costTotal += poolCost;
      } else {
        // No pool - zero cost
        matchUsed.push({
          rule: 'S104-empty',
          takeQty: qty,
          avgCostPerGbp: 0,
        });
      }
    }
    
    const gain = proceeds - costTotal;
    totalProceeds += proceeds;
    totalCost += costTotal;
    totalGain += gain;
    
    disposals.push({
      timestamp: e.timestamp,
      asset: 'XTZ',
      qtyDisposed: e.quantity,
      fmvGbpPerXtz: round(fmvGbp, 8),
      proceedsGbp: round(proceeds, 8),
      allowableCostGbp: round(costTotal, 8),
      gainGbp: round(gain, 8),
      opHash: e.opHash,
      matchingBreakdown: matchUsed,
      classification: e.classification,
      note: getDisposalNote(e),
    });
    
    processedCount++;
    onProgress?.(
      (processedCount / xtzEvents.length) * 100,
      `Processing event ${processedCount}/${xtzEvents.length}`
    );
  }
  
  // Also generate a simple ledger for HMRC
  const ledger: IRSLedgerEntry[] = events.map(e => {
    let irsCategory = 'review';
    let taxable = 'unknown';
    
    if (e.classification === 'self_transfer') {
      irsCategory = 'self_transfer';
      taxable = 'no';
    } else if (e.classification === 'cex_deposit') {
      irsCategory = 'cex_deposit';
      taxable = 'no';
    } else if (e.classification === 'baking_reward') {
      irsCategory = 'income';
      taxable = 'yes';
    } else if (e.direction === 'out') {
      irsCategory = 'disposal';
      taxable = 'yes';
    } else {
      irsCategory = 'acquisition';
      taxable = 'maybe';
    }
    
    return {
      timestamp: e.timestamp,
      level: e.level,
      opHash: e.opHash,
      kind: e.kind,
      direction: e.direction,
      counterparty: e.counterparty,
      asset: e.asset,
      quantity: e.quantity,
      feeXtz: e.feeXtz,
      tags: e.tags,
      confidence: e.confidence,
      classification: e.classification,
      classificationNote: e.classificationNote,
      irsCategory,
      irsTaxable: taxable,
      xtzFmvUsd: 0, // Not used for HMRC
    };
  });
  
  return {
    ledger,
    disposals,
    incomeEvents,
    summary: {
      totalDisposals: disposals.length,
      totalProceeds: round(totalProceeds, 2),
      totalCostBasis: round(totalCost, 2),
      totalGain: round(totalGain, 2),
      currency: 'GBP',
    },
  };
}

function round(n: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

/**
 * Generate CSV content from disposals
 */
export function disposalsToCSV(
  disposals: IRSDisposal[] | HMRCDisposal[],
  jurisdiction: 'irs' | 'hmrc'
): string {
  if (disposals.length === 0) {
    return jurisdiction === 'irs'
      ? 'timestamp,asset,qty_disposed,fmv_usd_per_xtz,proceeds_usd,basis_usd,gain_usd,fee_xtz,op_hash,classification,note\n'
      : 'timestamp,asset,qty_disposed,fmv_gbp_per_xtz,proceeds_gbp,allowable_cost_gbp,gain_gbp,op_hash,classification,note\n';
  }
  
  if (jurisdiction === 'irs') {
    const irsDisposals = disposals as IRSDisposal[];
    const headers = ['timestamp', 'asset', 'qty_disposed', 'fmv_usd_per_xtz', 'proceeds_usd', 'basis_usd', 'gain_usd', 'fee_xtz', 'op_hash', 'classification', 'note'];
    const rows = irsDisposals.map(d => [
      d.timestamp,
      d.asset,
      d.qtyDisposed,
      d.fmvUsdPerXtz,
      d.proceedsUsd,
      d.basisUsd,
      d.gainUsd,
      d.feeXtz,
      d.opHash,
      d.classification || '',
      `"${d.note}"`,
    ].join(','));
    return [headers.join(','), ...rows].join('\n');
  } else {
    const hmrcDisposals = disposals as HMRCDisposal[];
    const headers = ['timestamp', 'asset', 'qty_disposed', 'fmv_gbp_per_xtz', 'proceeds_gbp', 'allowable_cost_gbp', 'gain_gbp', 'op_hash', 'classification', 'note'];
    const rows = hmrcDisposals.map(d => [
      d.timestamp,
      d.asset,
      d.qtyDisposed,
      d.fmvGbpPerXtz,
      d.proceedsGbp,
      d.allowableCostGbp,
      d.gainGbp,
      d.opHash,
      d.classification || '',
      `"${d.note}"`,
    ].join(','));
    return [headers.join(','), ...rows].join('\n');
  }
}

/**
 * Generate CSV content from ledger
 */
export function ledgerToCSV(ledger: IRSLedgerEntry[]): string {
  if (ledger.length === 0) {
    return 'timestamp,level,op_hash,kind,direction,counterparty,asset,quantity,fee_xtz,tags,confidence,classification,category,taxable,xtz_fmv_usd\n';
  }
  
  const headers = ['timestamp', 'level', 'op_hash', 'kind', 'direction', 'counterparty', 'asset', 'quantity', 'fee_xtz', 'tags', 'confidence', 'classification', 'category', 'taxable', 'xtz_fmv_usd'];
  const rows = ledger.map(e => [
    e.timestamp,
    e.level,
    e.opHash,
    e.kind,
    e.direction,
    e.counterparty,
    `"${e.asset}"`,
    e.quantity,
    e.feeXtz,
    `"${e.tags.join('|')}"`,
    e.confidence,
    e.classification || '',
    e.irsCategory,
    e.irsTaxable,
    e.xtzFmvUsd,
  ].join(','));
  
  return [headers.join(','), ...rows].join('\n');
}
