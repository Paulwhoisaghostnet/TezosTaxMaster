/**
 * Full-wallet verification vs tt_discrepancies.csv
 * Fetches TzKT data, runs fixed pipeline, compares every flagged op.
 * Does NOT print USD totals.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'node:path';
import {
  fetchXtzTransactions,
  fetchTokenTransfers,
  fetchFeeOnlyOperations,
  resolveTokenTransferHashes,
  attachHashesByLevel,
  buildEvents,
  type TzKTTransaction,
  type TzKTTokenTransfer,
} from '../src/lib/tzkt.ts';
import { classifyEvents } from '../src/lib/classify-events.ts';
import type { Wallet, TxEvent } from '../src/lib/db.ts';

const WALLET = 'tz1cgZ6PWKoER3gvW3jGKPHgBkRnpj8XzLm2';
const CACHE = '/tmp/taxmaster-verify-cache.json';
const CSV =
  '/home/ubuntu/.cursor/projects/workspace/uploads/tt_discrepancies_db76.csv';

const EXPECTED_CLASS: Record<string, string[]> = {
  // Reconstruction "token_move" often includes domain buys, wraps, etc. Accept precise classes.
  token_move: [
    'needs_review',
    'unknown',
    'token_received',
    'self_transfer',
    'ignore',
    'nft_purchase',
    'nft_sale',
    'auction_bid_escrow',
    'offer_escrow',
    'swap',
    'dex_interaction',
  ],
  purchase: ['nft_purchase', 'swap'],
  // Many CSV "purchase_settle_noxtz" rows are oXTZ auction escrow legs, not NFT settles
  purchase_settle_noxtz: [
    'nft_purchase',
    'token_received',
    'needs_review',
    'swap',
    'auction_bid_escrow',
    'offer_escrow',
    'escrow_refund',
  ],
  baker_reward: ['baking_reward'],
  other: [
    'needs_review',
    'unknown',
    'ignore',
    'dex_interaction',
    'escrow_refund',
    'auction_bid_escrow',
    'offer_escrow',
  ], // delegations/originations land as needs_review/unknown fee-only
  xtz_out_other: [
    'needs_review',
    'likely_gift',
    'self_transfer',
    'ignore',
    'cex_deposit',
    'offer_escrow',
    'auction_bid_escrow',
  ],
  royalty: ['royalty_income', 'creator_sale'],
  sale_payout_other: ['royalty_income', 'creator_sale', 'nft_sale', 'needs_review'],
  primary_sale: ['creator_sale', 'royalty_income'],
  xtz_in_other: ['needs_review', 'received_income', 'self_transfer', 'cex_withdrawal', 'ignore'],
  auction_bid_escrow: ['auction_bid_escrow'],
  mint_or_airdrop_in: ['token_received', 'needs_review', 'nft_purchase'],
  secondary_sale: ['nft_sale', 'creator_sale'],
  offer_escrow: ['offer_escrow', 'auction_bid_escrow'],
  to_wtf_gameshow_wallet: ['needs_review', 'self_transfer', 'likely_gift', 'ignore'],
  escrow_refund: ['escrow_refund'],
};

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',');
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols: string[] = [];
    let cur = '';
    let inQ = false;
    for (const ch of lines[i]) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) {
        cols.push(cur);
        cur = '';
      } else cur += ch;
    }
    cols.push(cur);
    const row: Record<string, string> = {};
    headers.forEach((h, j) => (row[h] = cols[j] ?? ''));
    rows.push(row);
  }
  return rows;
}

async function loadOps(): Promise<{
  xtzOps: TzKTTransaction[];
  tokenOps: TzKTTokenTransfer[];
}> {
  if (fs.existsSync(CACHE)) {
    console.error('Using cache', CACHE);
    return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  }
  console.error('Fetching history from TzKT (2020+; may take several minutes)...');
  const start = '2020-01-01T00:00:00Z';
  const end = new Date(Date.now() + 86400000).toISOString();
  const [xtzOpsRaw, tokenOps, feeOps] = await Promise.all([
    fetchXtzTransactions(WALLET, start, end),
    fetchTokenTransfers(WALLET, start, end),
    fetchFeeOnlyOperations(WALLET, start, end),
  ]);
  const xtzOps = [...xtzOpsRaw, ...feeOps];
  console.error(
    `Fetched ${xtzOpsRaw.length} xtz, ${feeOps.length} fee-ops, ${tokenOps.length} tokens — joining hashes...`
  );
  // 1) Join via transactionId against fetched XTZ ops
  await resolveTokenTransferHashes(tokenOps, xtzOps, false);
  // 2) API-resolve remaining 2025+ ids BEFORE level fallback (avoids wrong timestamp joins)
  const missingRecent = tokenOps.filter(
    (t) =>
      !t.transactionHash &&
      t.transactionId &&
      t.timestamp >= '2025-01-01T00:00:00Z'
  );
  console.error(`Resolving ${missingRecent.length} recent token hashes via API...`);
  await resolveTokenTransferHashes(missingRecent, xtzOps, true);
  // 3) Level fallback only when unique
  attachHashesByLevel(WALLET, xtzOps, tokenOps);
  const data = { xtzOps, tokenOps };
  fs.writeFileSync(CACHE, JSON.stringify(data));
  console.error(`Cached ${data.xtzOps.length} xtz ops, ${data.tokenOps.length} token transfers`);
  return data;
}

function aggregateByHash(events: TxEvent[]) {
  const byHash = new Map<
    string
  , {
    classifications: Set<string>;
    feeXtz: number;
    xtzIn: number;
    xtzOut: number;
    events: TxEvent[];
  }>();
  for (const e of events) {
    if (!e.opHash) continue;
    if (!byHash.has(e.opHash)) {
      byHash.set(e.opHash, {
        classifications: new Set(),
        feeXtz: 0,
        xtzIn: 0,
        xtzOut: 0,
        events: [],
      });
    }
    const g = byHash.get(e.opHash)!;
    if (e.classification) g.classifications.add(e.classification);
    g.feeXtz += e.feeXtz || 0;
    if (e.asset === 'XTZ' && e.direction === 'in') g.xtzIn += e.quantity;
    if (e.asset === 'XTZ' && e.direction === 'out') g.xtzOut += e.quantity;
    g.events.push(e);
  }
  return byHash;
}

function verdict(
  cat: string,
  group:
    | {
        classifications: Set<string>;
        feeXtz: number;
        xtzIn: number;
        xtzOut: number;
      }
    | undefined,
  row: Record<string, string>
): 'resolved' | 'needs_review' | 'still_wrong' | 'missing' {
  if (!group) return 'missing';
  const allowed = EXPECTED_CLASS[cat] || ['needs_review'];
  const classes = [...group.classifications];
  const hasAllowed = classes.some((c) => allowed.includes(c));
  const onlyReview =
    classes.every((c) => c === 'needs_review' || c === 'unknown') &&
    classes.length > 0;

  // Fee check when CSV expects a fee
  const actualFee = Number(row.actual_fee_xtz) || 0;
  const feeOk = actualFee <= 0 || group.feeXtz >= actualFee * 0.5; // allow some tolerance

  // XTZ amount check for material XTZ moves
  const actualIn = Number(row.actual_xtz_in) || 0;
  const actualOut = Number(row.actual_xtz_out) || 0;
  let amtOk = true;
  if (actualIn > 0.0001) {
    amtOk = Math.abs(group.xtzIn - actualIn) / actualIn < 0.05 || group.xtzIn >= actualIn * 0.95;
  }
  if (actualOut > 0.0001) {
    amtOk =
      amtOk &&
      (Math.abs(group.xtzOut - actualOut) / actualOut < 0.05 ||
        group.xtzOut >= actualOut * 0.95);
  }

  if (hasAllowed && feeOk && amtOk) {
    if (onlyReview && (allowed.includes('needs_review') || allowed.includes('unknown'))) {
      // token_move / other intentionally reviewable
      if (['token_move', 'other', 'xtz_out_other', 'xtz_in_other', 'to_wtf_gameshow_wallet', 'mint_or_airdrop_in', 'purchase_settle_noxtz'].includes(cat)) {
        return 'needs_review';
      }
    }
    return onlyReview && !['token_move', 'other', 'xtz_out_other', 'xtz_in_other', 'to_wtf_gameshow_wallet', 'mint_or_airdrop_in', 'purchase_settle_noxtz'].includes(cat)
      ? 'needs_review'
      : 'resolved';
  }

  if (onlyReview || classes.includes('needs_review')) {
    // Expected a specific class but got review
    if (!allowed.includes('needs_review') && !allowed.includes('unknown')) {
      return 'still_wrong';
    }
    return 'needs_review';
  }

  return 'still_wrong';
}

async function main() {
  const rows = parseCsv(fs.readFileSync(CSV, 'utf8'));
  console.error(`CSV rows: ${rows.length}`);

  const { xtzOps, tokenOps } = await loadOps();
  console.error(`Building events from ${xtzOps.length} xtz / ${tokenOps.length} tokens...`);
  const events = buildEvents(WALLET, xtzOps, tokenOps);
  const wallet: Wallet = {
    address: WALLET,
    addedAt: '2020-01-01T00:00:00Z',
    delegate: 'tz3cC4osV2bznw37zNMyN9LruwBTTX43qHen',
    delegateName: 'FAFO Bakery',
  };
  const classified = classifyEvents(events, [wallet]);
  console.error(`Classified ${classified.length} events`);

  // Restrict comparison window to 2025 + 2026 YTD events for fee/NFT counts
  const yearEvents = classified.filter(
    (e) => e.timestamp >= '2025-01-01T00:00:00Z' && e.timestamp < '2027-01-01T00:00:00Z'
  );

  const byHash = aggregateByHash(classified);

  const perCat: Record<
    string,
    { resolved: number; needs_review: number; still_wrong: number; missing: number; wrongExamples: string[] }
  > = {};

  let feeCaptured = 0;
  const feeSeen = new Set<string>();
  for (const e of yearEvents) {
    if (e.feeXtz > 0 && e.opHash && !feeSeen.has(e.opHash)) {
      feeCaptured += e.feeXtz;
      feeSeen.add(e.opHash);
    }
  }

  const nftBuys = yearEvents.filter((e) => e.classification === 'nft_purchase').length;
  const nftSales = yearEvents.filter((e) => e.classification === 'nft_sale').length;
  const royalties = yearEvents.filter((e) => e.classification === 'royalty_income').length;
  const primary = yearEvents.filter((e) => e.classification === 'creator_sale').length;
  const staking = yearEvents.filter((e) => e.classification === 'baking_reward').length;
  const escrowBid = yearEvents.filter((e) => e.classification === 'auction_bid_escrow').length;
  const offerEscrow = yearEvents.filter((e) => e.classification === 'offer_escrow').length;
  const escrowRefund = yearEvents.filter((e) => e.classification === 'escrow_refund').length;

  // Unique op hashes for NFT categories (XTZ leg preferred)
  const uniqueClass = (cls: string) =>
    new Set(
      yearEvents.filter((e) => e.classification === cls && e.opHash).map((e) => e.opHash)
    ).size;

  for (const row of rows) {
    const cat = row.reconstructed_category;
    if (!perCat[cat]) {
      perCat[cat] = {
        resolved: 0,
        needs_review: 0,
        still_wrong: 0,
        missing: 0,
        wrongExamples: [],
      };
    }
    const g = byHash.get(row.op_hash);
    const v = verdict(cat, g, row);
    perCat[cat][v === 'missing' ? 'missing' : v]++;
    if (v === 'still_wrong' && perCat[cat].wrongExamples.length < 5) {
      const classes = g ? [...g.classifications].join('|') || '(none)' : '(missing)';
      perCat[cat].wrongExamples.push(
        `${row.op_hash.slice(0, 12)}…→${classes};fee=${g?.feeXtz ?? 0}/${row.actual_fee_xtz};in=${g?.xtzIn ?? 0}/${row.actual_xtz_in};out=${g?.xtzOut ?? 0}/${row.actual_xtz_out}`
      );
    }
  }

  let totalResolved = 0,
    totalReview = 0,
    totalWrong = 0,
    totalMissing = 0;
  for (const c of Object.values(perCat)) {
    totalResolved += c.resolved;
    totalReview += c.needs_review;
    totalWrong += c.still_wrong;
    totalMissing += c.missing;
  }

  const report = {
    totals: {
      csvRows: rows.length,
      resolved: totalResolved,
      needs_review: totalReview,
      still_wrong: totalWrong,
      missing: totalMissing,
    },
    pipelineYearEvents: yearEvents.length,
    feeTotalXtzCaptured2025_2026: Number(feeCaptured.toFixed(6)),
    recognizedUniqueOps: {
      nft_purchase: uniqueClass('nft_purchase'),
      nft_sale: uniqueClass('nft_sale'),
      royalty_income: uniqueClass('royalty_income'),
      creator_sale: uniqueClass('creator_sale'),
      baking_reward: uniqueClass('baking_reward'),
      auction_bid_escrow: uniqueClass('auction_bid_escrow'),
      offer_escrow: uniqueClass('offer_escrow'),
      escrow_refund: uniqueClass('escrow_refund'),
    },
    recognizedEventLegs: {
      nft_purchase: nftBuys,
      nft_sale: nftSales,
      royalty_income: royalties,
      creator_sale: primary,
      baking_reward: staking,
      auction_bid_escrow: escrowBid,
      offer_escrow: offerEscrow,
      escrow_refund: escrowRefund,
    },
    perCategory: perCat,
  };

  const outPath = '/tmp/taxmaster-verify-report.json';
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.error('Wrote', outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
