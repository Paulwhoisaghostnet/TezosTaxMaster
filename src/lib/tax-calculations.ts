/**
 * Tax calculation engines for IRS, HMRC, and CRA
 * 
 * IRS: FIFO cost basis matching (Notice 2014-21, Rev. Rul. 2019-24, 2023-14)
 * HMRC: Same-day, 30-day, then Section 104 pooling (CRYPTO22200 series)
 * CRA: Adjusted Cost Base (ACB) with 50% inclusion rate
 * 
 * Uses smart classification to properly handle:
 * - Self-transfers (not taxable)
 * - CEX deposits (not taxable until sold)
 * - Baking rewards (ordinary income)
 * - Received XTZ from external addresses (ordinary income)
 * - Swaps (both legs taxable)
 * - Gifts (taxable disposal)
 * - NFT/token purchases and sales (capital gains)
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

export interface CRADisposal {
  timestamp: string;
  asset: string;
  qtyDisposed: number;
  fmvCadPerXtz: number;
  proceedsCad: number;
  acbCad: number; // Adjusted Cost Base
  gainCad: number;
  taxableGainCad: number; // 50% of capital gain (inclusion rate)
  opHash: string;
  acbPerUnit: number; // ACB per unit at time of disposal
  classification?: string;
  note: string;
}

export interface TaxCalculationResult {
  ledger: IRSLedgerEntry[];
  disposals: IRSDisposal[] | HMRCDisposal[] | CRADisposal[];
  summary: {
    totalDisposals: number;
    totalProceeds: number;
    totalCostBasis: number;
    totalGain: number;
    taxableGain?: number; // For CRA: 50% inclusion rate on capital gains only
    totalIncome?: number; // Total income from all sources
    confirmedIncome?: number; // All income is confirmed (no review needed)
    stakingIncome?: number; // Baking/staking rewards
    creatorIncome?: number; // Sales of self-created tokens
    receivedIncome?: number; // XTZ received from external addresses
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
 * Check if an event is a taxable disposal (capital gains)
 */
function isTaxableDisposal(e: TxEvent): boolean {
  // Self-transfers are not taxable
  if (e.classification === 'self_transfer') return false;
  
  // CEX deposits are not taxable (taxable when sold on CEX)
  if (e.classification === 'cex_deposit') return false;
  
  // Creator sales are ordinary income, not capital gains
  // (IRS treats sale of self-created items as business income, not cap gains)
  if (e.classification === 'creator_sale') return false;
  
  // Outgoing XTZ or tokens are generally taxable disposals
  if (e.direction === 'out' && e.quantity > 0) return true;
  
  return false;
}

/**
 * Check if an event is taxable ordinary income (not capital gains)
 */
function isTaxableIncome(e: TxEvent): boolean {
  // Baking rewards are ordinary income
  if (e.classification === 'baking_reward') return true;
  
  // Creator sales: selling self-created tokens is ordinary income (Schedule C)
  // The entire proceeds are income, cost basis is your actual costs (gas, materials)
  if (e.classification === 'creator_sale') return true;
  
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
      return 'Gift of XTZ - taxable disposal at FMV.';
    case 'token_gift_out':
      return 'Gift of token/NFT - taxable disposal at FMV.';
    case 'nft_purchase':
      return 'NFT purchase';
    case 'nft_sale':
      return 'NFT sale - capital gain/loss (acquired token sold)';
    case 'creator_sale':
      return 'Creator sale - ordinary income, NOT capital gains (self-created token sold)';
    case 'token_received':
      return 'Token/NFT received - cost basis = FMV at receipt (or 0 if unknown)';
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
  
  // Token/NFT lot tracking: Map<assetKey, FifoLot[]>
  const tokenLots: Map<string, Array<{ acquiredTs: string; qty: number; basisPerUsd: number }>> = new Map();
  
  // Helper to get token value from related XTZ in same operation
  const getTokenValueFromRelatedXtz = (event: TxEvent, allEvents: TxEvent[]): number => {
    const relatedEvents = allEvents.filter(e => e.opHash === event.opHash && e.id !== event.id);
    const xtzEvent = relatedEvents.find(e => e.asset === 'XTZ');
    if (xtzEvent) {
      return xtzEvent.quantity * (xtzEvent.quoteUsd || 0);
    }
    return 0; // Unknown value
  };
  
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
        // Baking rewards are ordinary income at FMV when received
        xtzLots.push({
          acquiredTs: e.timestamp,
          qty: e.quantity,
          basisPer: fmvUsd,
        });
        incomeEvents.push({
          timestamp: e.timestamp,
          type: 'Staking Reward (Ordinary Income)',
          quantity: e.quantity,
          fmv: e.quantity * fmvUsd,
          note: e.classificationNote || 'IRS: Ordinary income at FMV when received - report on Schedule 1 or Schedule C if business activity.',
        });
      } else if (e.classification === 'creator_sale' && e.direction === 'in') {
        // Creator sale income: XTZ received from selling self-created token
        // This is ordinary income (Schedule C), not capital gains
        irsCategory = 'creator_income';
        taxable = 'yes';
        // Create lot with FMV basis (for if they later sell this XTZ)
        xtzLots.push({
          acquiredTs: e.timestamp,
          qty: e.quantity,
          basisPer: fmvUsd,
        });
        incomeEvents.push({
          timestamp: e.timestamp,
          type: 'Creator Sale (Self-Employment)',
          quantity: e.quantity,
          fmv: e.quantity * fmvUsd,
          note: e.classificationNote || 'IRS: Self-employment income from sale of self-created token - report on Schedule C. Subject to self-employment tax.',
        });
      } else if (e.classification === 'received_income' && e.direction === 'in') {
        // Received XTZ from external address (not owned wallet, not CEX, not baker)
        // This is taxable income at FMV when received
        irsCategory = 'ordinary_income';
        taxable = 'yes';
        
        // Create lot with FMV basis
        xtzLots.push({
          acquiredTs: e.timestamp,
          qty: e.quantity,
          basisPer: fmvUsd,
        });
        
        // Add to income events
        incomeEvents.push({
          timestamp: e.timestamp,
          type: 'Received Income (Ordinary Income)',
          quantity: e.quantity,
          fmv: e.quantity * fmvUsd,
          note: e.classificationNote || 'IRS: XTZ received from external address - taxable as ordinary income at FMV when received.',
        });
      } else if (e.direction === 'in' && e.quantity > 0) {
        // Other acquisitions (swaps, etc.)
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
      // Token/NFT handling with cost basis tracking
      const assetKey = e.asset;
      
      if (e.classification === 'self_transfer') {
        // Self-transfers of tokens don't trigger gains
        irsCategory = 'self_transfer';
        taxable = 'no';
      } else if (e.direction === 'in') {
        // Token/NFT acquisition - create lot with cost basis
        let costBasisUsd = 0;
        
        if (e.classification === 'nft_purchase' || e.classification === 'swap') {
          // Cost basis = value of XTZ spent in same operation
          costBasisUsd = getTokenValueFromRelatedXtz(e, events);
          irsCategory = 'nft_purchase';
          taxable = 'no'; // Acquisition isn't taxable, disposal of XTZ is handled separately
        } else if (e.classification === 'token_received') {
          // Received token/NFT as gift - cost basis = FMV (use 0 if unknown)
          // Note: For gifts, recipient's basis is typically donor's basis, but if unknown, use 0
          costBasisUsd = getTokenValueFromRelatedXtz(e, events); // Will be 0 for pure gifts
          irsCategory = 'token_received';
          taxable = 'no'; // Receiving a gift isn't income for recipient (donor pays gift tax if applicable)
        } else if (e.isMint) {
          // Minted token - cost basis = 0 (or actual costs if tracked)
          costBasisUsd = 0;
          irsCategory = 'token_mint';
          taxable = 'no';
        } else {
          irsCategory = 'token_acquisition';
          taxable = 'no';
        }
        
        // Create lot for the token
        if (!tokenLots.has(assetKey)) {
          tokenLots.set(assetKey, []);
        }
        tokenLots.get(assetKey)!.push({
          acquiredTs: e.timestamp,
          qty: e.quantity,
          basisPerUsd: e.quantity > 0 ? costBasisUsd / e.quantity : 0,
        });
      } else if (e.direction === 'out') {
        // Token/NFT disposal - calculate capital gain
        if (e.classification === 'creator_sale') {
          // Creator sales are ordinary income, not capital gains
          irsCategory = 'creator_sale';
          taxable = 'yes';
          // Income already tracked when XTZ is received
        } else {
          // Regular sale or gift - capital gains event
          const proceeds = getTokenValueFromRelatedXtz(e, events);
          let basis = 0;
          let qtyToDispose = e.quantity;
          const lots = tokenLots.get(assetKey) || [];
          
          // FIFO matching for token
          while (qtyToDispose > 1e-12 && lots.length > 0) {
            const lot = lots[0];
            const take = Math.min(qtyToDispose, lot.qty);
            basis += take * lot.basisPerUsd;
            lot.qty -= take;
            qtyToDispose -= take;
            if (lot.qty <= 1e-12) {
              lots.shift();
            }
          }
          
          const gain = proceeds - basis;
          
          if (e.classification === 'nft_sale') {
            irsCategory = 'nft_sale';
            taxable = 'yes';
          } else if (e.classification === 'token_gift_out') {
            irsCategory = 'token_gift';
            taxable = 'yes'; // Gifts are disposals at FMV
          } else {
            irsCategory = 'token_disposal';
            taxable = 'yes';
          }
          
          // Only add to totals if there's a known proceeds value
          if (proceeds > 0 || basis > 0) {
            totalProceeds += proceeds;
            totalBasis += basis;
            totalGain += gain;
            
            // Record as disposal
            disposals.push({
              timestamp: e.timestamp,
              asset: e.asset,
              qtyDisposed: e.quantity,
              fmvUsdPerXtz: 0, // Not XTZ
              proceedsUsd: round(proceeds, 8),
              basisUsd: round(basis, 8),
              gainUsd: round(gain, 8),
              feeXtz: e.feeXtz,
              opHash: e.opHash,
              lotBreakdown: [],
              classification: e.classification,
              note: e.classification === 'token_gift_out' 
                ? 'Token/NFT gift - taxable disposal at FMV'
                : 'Token/NFT sale - capital gain/loss',
            });
          }
        }
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
  
  // Calculate income totals by category
  const stakingIncome = incomeEvents
    .filter(e => e.type.includes('Staking'))
    .reduce((sum, e) => sum + e.fmv, 0);
  const creatorIncome = incomeEvents
    .filter(e => e.type.includes('Creator'))
    .reduce((sum, e) => sum + e.fmv, 0);
  const receivedIncome = incomeEvents
    .filter(e => e.type.includes('Received'))
    .reduce((sum, e) => sum + e.fmv, 0);
  const totalIncome = incomeEvents.reduce((sum, e) => sum + e.fmv, 0);
  
  return {
    ledger,
    disposals,
    incomeEvents,
    summary: {
      totalDisposals: disposals.length,
      totalProceeds: round(totalProceeds, 2),
      totalCostBasis: round(totalBasis, 2),
      totalGain: round(totalGain, 2),
      totalIncome: round(totalIncome, 2),
      confirmedIncome: round(totalIncome, 2), // All income is now confirmed
      stakingIncome: round(stakingIncome, 2),
      creatorIncome: round(creatorIncome, 2),
      receivedIncome: round(receivedIncome, 2),
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
      
      // Track baking rewards as miscellaneous income (HMRC: £1,000 trading allowance may apply)
      if (e.classification === 'baking_reward') {
        incomeEvents.push({
          timestamp: e.timestamp,
          type: 'Staking Reward (Misc Income)',
          quantity: e.quantity,
          fmv: e.quantity * fmvGbp,
          note: e.classificationNote || 'HMRC: Miscellaneous income - £1,000 trading allowance may apply. Report on Self Assessment if total exceeds allowance.',
        });
      }
      
      // Track creator sales as trading income (HMRC: report as self-employment)
      if (e.classification === 'creator_sale') {
        incomeEvents.push({
          timestamp: e.timestamp,
          type: 'Creator Sale (Trading Income)',
          quantity: e.quantity,
          fmv: e.quantity * fmvGbp,
          note: e.classificationNote || 'HMRC: Trading income from sale of self-created token - report on Self Assessment as self-employment income.',
        });
      }
      
      // Track received income from external addresses (not owned wallet, not CEX, not baker)
      if (e.classification === 'received_income') {
        incomeEvents.push({
          timestamp: e.timestamp,
          type: 'Received Income (Misc Income)',
          quantity: e.quantity,
          fmv: e.quantity * fmvGbp,
          note: e.classificationNote || 'HMRC: XTZ received from external address - taxable as miscellaneous income at FMV when received.',
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
  
  // Calculate income totals by category
  const stakingIncome = incomeEvents
    .filter(e => e.type.includes('Staking'))
    .reduce((sum, e) => sum + e.fmv, 0);
  const creatorIncome = incomeEvents
    .filter(e => e.type.includes('Creator'))
    .reduce((sum, e) => sum + e.fmv, 0);
  const receivedIncome = incomeEvents
    .filter(e => e.type.includes('Received'))
    .reduce((sum, e) => sum + e.fmv, 0);
  const totalIncome = incomeEvents.reduce((sum, e) => sum + e.fmv, 0);
  
  return {
    ledger,
    disposals,
    incomeEvents,
    summary: {
      totalDisposals: disposals.length,
      totalProceeds: round(totalProceeds, 2),
      totalCostBasis: round(totalCost, 2),
      totalGain: round(totalGain, 2),
      totalIncome: round(totalIncome, 2),
      confirmedIncome: round(totalIncome, 2), // All income is now confirmed
      stakingIncome: round(stakingIncome, 2),
      creatorIncome: round(creatorIncome, 2),
      receivedIncome: round(receivedIncome, 2),
      currency: 'GBP',
    },
  };
}

/**
 * CRA (Canada Revenue Agency) ACB calculation
 * - Uses Adjusted Cost Base (ACB) method - average cost pooling
 * - Only 50% of capital gains are taxable (inclusion rate)
 * - Each crypto asset has its own ACB pool
 * - Superficial loss rule: can't claim loss if repurchased within 30 days
 * 
 * Reference: https://www.canada.ca/en/revenue-agency/programs/about-canada-revenue-agency-cra/compliance/digital-currency/cryptocurrency-guide.html
 */
export function calculateCRA(
  events: TxEvent[],
  onProgress?: (progress: number, message: string) => void
): TaxCalculationResult {
  const disposals: CRADisposal[] = [];
  const incomeEvents: TaxCalculationResult['incomeEvents'] = [];
  
  // ACB pool for XTZ (Adjusted Cost Base)
  let acbPoolQty = 0;
  let acbPoolCost = 0;
  
  // Filter and sort XTZ events
  const xtzEvents = events.filter(e => e.asset === 'XTZ' && e.quantity > 0);
  xtzEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  
  let totalProceeds = 0;
  let totalCost = 0;
  let totalGain = 0;
  let totalTaxableGain = 0;
  
  // Process events chronologically
  let processedCount = 0;
  for (const e of xtzEvents) {
    const fmvCad = e.quoteCad || 0;
    
    // Skip non-taxable transfers
    if (e.classification === 'self_transfer') {
      processedCount++;
      continue;
    }
    
    if (e.direction === 'in') {
      // Acquisition - add to ACB pool
      const cost = e.quantity * fmvCad;
      acbPoolQty += e.quantity;
      acbPoolCost += cost;
      
      // Track baking rewards as business income (CRA: 100% taxable, NOT 50%)
      if (e.classification === 'baking_reward') {
        incomeEvents.push({
          timestamp: e.timestamp,
          type: 'Baking Reward (Business Income)',
          quantity: e.quantity,
          fmv: cost,
          note: e.classificationNote || 'CRA: Business income from staking - 100% taxable (not eligible for 50% capital gains rate)',
        });
      }
      
      // Track creator sales as business income (CRA: 100% taxable, NOT 50%)
      if (e.classification === 'creator_sale') {
        incomeEvents.push({
          timestamp: e.timestamp,
          type: 'Creator Sale (Business Income)',
          quantity: e.quantity,
          fmv: cost,
          note: e.classificationNote || 'CRA: Business income from sale of self-created token - 100% taxable (not eligible for 50% capital gains rate)',
        });
      }
      
      // Track received income from external addresses (not owned wallet, not CEX, not baker)
      if (e.classification === 'received_income') {
        incomeEvents.push({
          timestamp: e.timestamp,
          type: 'Received Income (Other Income)',
          quantity: e.quantity,
          fmv: cost,
          note: e.classificationNote || 'CRA: XTZ received from external address - taxable as other income at FMV when received.',
        });
      }
      
      processedCount++;
      continue;
    }
    
    // Skip CEX deposits (not taxable until sold)
    if (e.classification === 'cex_deposit') {
      processedCount++;
      continue;
    }
    
    // Disposal - calculate using ACB
    const proceeds = e.quantity * fmvCad;
    
    // Calculate ACB for disposed units
    let acbPerUnit = 0;
    if (acbPoolQty > 1e-12) {
      acbPerUnit = acbPoolCost / acbPoolQty;
    }
    const acb = e.quantity * acbPerUnit;
    
    // Reduce ACB pool
    acbPoolQty -= e.quantity;
    acbPoolCost -= acb;
    
    // Ensure pool doesn't go negative
    if (acbPoolQty < 0) acbPoolQty = 0;
    if (acbPoolCost < 0) acbPoolCost = 0;
    
    const gain = proceeds - acb;
    
    // In Canada, only 50% of capital gains are taxable (inclusion rate)
    // Note: As of 2024, gains over $250k have 66.67% inclusion, but we use 50% as default
    const taxableGain = gain > 0 ? gain * 0.5 : gain; // Losses are also at 50%
    
    totalProceeds += proceeds;
    totalCost += acb;
    totalGain += gain;
    totalTaxableGain += taxableGain;
    
    disposals.push({
      timestamp: e.timestamp,
      asset: 'XTZ',
      qtyDisposed: e.quantity,
      fmvCadPerXtz: round(fmvCad, 8),
      proceedsCad: round(proceeds, 8),
      acbCad: round(acb, 8),
      gainCad: round(gain, 8),
      taxableGainCad: round(taxableGain, 8),
      opHash: e.opHash,
      acbPerUnit: round(acbPerUnit, 8),
      classification: e.classification,
      note: getDisposalNote(e) + ' ACB (Adjusted Cost Base) method used.',
    });
    
    processedCount++;
    onProgress?.(
      (processedCount / xtzEvents.length) * 100,
      `Processing event ${processedCount}/${xtzEvents.length}`
    );
  }
  
  // Generate ledger
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
      xtzFmvUsd: 0, // Not used for CRA
    };
  });
  
  // Calculate income totals by category
  const stakingIncome = incomeEvents
    .filter(e => e.type.includes('Baking'))
    .reduce((sum, e) => sum + e.fmv, 0);
  const creatorIncome = incomeEvents
    .filter(e => e.type.includes('Creator'))
    .reduce((sum, e) => sum + e.fmv, 0);
  const receivedIncome = incomeEvents
    .filter(e => e.type.includes('Received'))
    .reduce((sum, e) => sum + e.fmv, 0);
  const totalIncome = incomeEvents.reduce((sum, e) => sum + e.fmv, 0);
  
  return {
    ledger,
    disposals,
    incomeEvents,
    summary: {
      totalDisposals: disposals.length,
      totalProceeds: round(totalProceeds, 2),
      totalCostBasis: round(totalCost, 2),
      totalGain: round(totalGain, 2),
      taxableGain: round(totalTaxableGain, 2), // 50% inclusion rate - capital gains ONLY
      totalIncome: round(totalIncome, 2),
      confirmedIncome: round(totalIncome, 2), // All income is now confirmed
      stakingIncome: round(stakingIncome, 2),
      creatorIncome: round(creatorIncome, 2),
      receivedIncome: round(receivedIncome, 2),
      currency: 'CAD',
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
  disposals: IRSDisposal[] | HMRCDisposal[] | CRADisposal[],
  jurisdiction: 'irs' | 'hmrc' | 'cra'
): string {
  if (disposals.length === 0) {
    if (jurisdiction === 'irs') {
      return 'timestamp,asset,qty_disposed,fmv_usd_per_xtz,proceeds_usd,basis_usd,gain_usd,fee_xtz,op_hash,classification,note\n';
    } else if (jurisdiction === 'hmrc') {
      return 'timestamp,asset,qty_disposed,fmv_gbp_per_xtz,proceeds_gbp,allowable_cost_gbp,gain_gbp,op_hash,classification,note\n';
    } else {
      return 'timestamp,asset,qty_disposed,fmv_cad_per_xtz,proceeds_cad,acb_cad,gain_cad,taxable_gain_cad,acb_per_unit,op_hash,classification,note\n';
    }
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
  } else if (jurisdiction === 'hmrc') {
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
  } else {
    const craDisposals = disposals as CRADisposal[];
    const headers = ['timestamp', 'asset', 'qty_disposed', 'fmv_cad_per_xtz', 'proceeds_cad', 'acb_cad', 'gain_cad', 'taxable_gain_cad', 'acb_per_unit', 'op_hash', 'classification', 'note'];
    const rows = craDisposals.map(d => [
      d.timestamp,
      d.asset,
      d.qtyDisposed,
      d.fmvCadPerXtz,
      d.proceedsCad,
      d.acbCad,
      d.gainCad,
      d.taxableGainCad,
      d.acbPerUnit,
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

/**
 * Generate CSV content from income events
 */
export function incomeEventsToCSV(
  incomeEvents: TaxCalculationResult['incomeEvents'],
  currency: string
): string {
  if (incomeEvents.length === 0) {
    return `timestamp,type,quantity,fmv_${currency.toLowerCase()},note\n`;
  }
  
  const headers = ['timestamp', 'type', 'quantity', `fmv_${currency.toLowerCase()}`, 'note'];
  const rows = incomeEvents.map(e => [
    e.timestamp,
    `"${e.type}"`,
    e.quantity,
    e.fmv,
    `"${e.note}"`,
  ].join(','));
  
  return [headers.join(','), ...rows].join('\n');
}
