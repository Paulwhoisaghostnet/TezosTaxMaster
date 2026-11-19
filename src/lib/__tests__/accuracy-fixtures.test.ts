/**
 * Fixture tests from publicly flagged TzKT ops (wallet tz1cgZ6…Lm2).
 * Asserts classification / fee / batching fixes — no USD totals committed.
 */

import { describe, expect, it } from 'vitest';
import fixtures from '../__fixtures__/flagged-ops.json';
import { buildEvents, totalFeeMutez, type TzKTTransaction, type TzKTTokenTransfer } from '../tzkt';
import { classifyEvents } from '../classify-events';
import { calculateIRS } from '../tax-calculations';
import type { Wallet } from '../db';

const WALLET = fixtures.wallet;

const walletObj: Wallet = {
  address: WALLET,
  addedAt: '2024-01-01T00:00:00Z',
  delegate: 'tz3cC4osV2bznw37zNMyN9LruwBTTX43qHen',
  delegateName: 'FAFO Bakery',
};

function pack(name: keyof typeof fixtures.ops) {
  const p = fixtures.ops[name];
  return {
    hash: p.hash,
    xtzOps: p.xtzOps as TzKTTransaction[],
    tokenOps: p.tokenOps as TzKTTokenTransfer[],
  };
}

function run(name: keyof typeof fixtures.ops) {
  const { xtzOps, tokenOps } = pack(name);
  const events = buildEvents(WALLET, xtzOps, tokenOps);
  const classified = classifyEvents(events, [walletObj]);
  return classified;
}

describe('fee field (bakerFee)', () => {
  it('reads bakerFee+storage+allocation, not null fee', () => {
    const { xtzOps } = pack('gift_out_with_fee');
    expect(xtzOps[0].fee ?? null).toBeNull();
    expect(totalFeeMutez(xtzOps[0])).toBe(283);
  });

  it('attaches 0.000283 XTZ fee on outbound gift op', () => {
    const events = run('gift_out_with_fee');
    const xtz = events.filter((e) => e.asset === 'XTZ');
    const feeTotal = xtz.reduce((s, e) => s + e.feeXtz, 0);
    expect(feeTotal).toBeCloseTo(0.000283, 8);
  });
});

describe('batched ops (no hash dedupe)', () => {
  it('keeps multiple inbound XTZ legs for primary sale payout', () => {
    const events = run('primary_sale_batched');
    const inbound = events.filter(
      (e) => e.asset === 'XTZ' && e.direction === 'in' && e.quantity > 0
    );
    expect(inbound.length).toBeGreaterThanOrEqual(2);
    const totalIn = inbound.reduce((s, e) => s + e.quantity, 0);
    expect(totalIn).toBeCloseTo(4.75, 6);
  });
});

describe('NFT token join + purchase', () => {
  it('joins token transfer to payment via opHash and classifies nft_purchase', () => {
    const events = run('nft_purchase');
    expect(events.some((e) => e.kind === 'token_transfer' && e.opHash)).toBe(true);
    const purchases = events.filter((e) => e.classification === 'nft_purchase');
    expect(purchases.length).toBeGreaterThanOrEqual(1);
    const xtzOut = events.find(
      (e) => e.asset === 'XTZ' && e.direction === 'out' && e.quantity === 25
    );
    expect(xtzOut?.classification).toBe('nft_purchase');
    expect(xtzOut?.feeXtz).toBeCloseTo(0.001412, 6);
  });
});

describe('staking rewards', () => {
  it('classifies Zir0h bakery payout as baking_reward', () => {
    const events = run('baker_reward');
    const reward = events.find((e) => e.asset === 'XTZ' && e.direction === 'in');
    expect(reward?.classification).toBe('baking_reward');
    expect(reward?.quantity).toBeCloseTo(0.09782, 5);
  });
});

describe('royalty / marketplace payout', () => {
  it('classifies inbound marketplace XTZ without token leg as royalty_income', () => {
    const events = run('royalty');
    const inbound = events.find((e) => e.asset === 'XTZ' && e.direction === 'in');
    expect(inbound?.classification).toBe('royalty_income');
  });
});

describe('auction escrow', () => {
  it('classifies bid wrap/lock as auction_bid_escrow (not gift)', () => {
    const events = run('auction_bid');
    const escrow = events.filter(
      (e) =>
        e.classification === 'auction_bid_escrow' || e.classification === 'offer_escrow'
    );
    expect(escrow.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.classification !== 'likely_gift')).toBe(true);
  });

  it('classifies offer as offer_escrow', () => {
    const events = run('offer_escrow');
    expect(events.some((e) => e.classification === 'offer_escrow')).toBe(true);
  });

  it('classifies retract_offer refunds as escrow_refund (not income)', () => {
    const events = run('escrow_refund');
    const refunds = events.filter((e) => e.classification === 'escrow_refund');
    expect(refunds.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.classification !== 'received_income')).toBe(true);
  });
});

describe('unexplained transfers need review', () => {
  it('does not auto-label plain outbound as likely_gift', () => {
    const events = run('gift_out_with_fee');
    const out = events.find((e) => e.direction === 'out' && e.quantity === 100);
    expect(out?.classification).toBe('needs_review');
  });
});

describe('multi-wallet self transfer', () => {
  it('marks transfer to another owned wallet as self_transfer', () => {
    const other = 'tz1cVRngZw42KZ42VQF2ZCy2CJSPNG3H7Cgt';
    const events = buildEvents(WALLET, pack('gift_out_with_fee').xtzOps, []);
    const classified = classifyEvents(events, [
      walletObj,
      { address: other, addedAt: '2024-01-01T00:00:00Z' },
    ]);
    expect(classified[0].classification).toBe('self_transfer');
  });
});

describe('full-history lot matching', () => {
  it('uses prior-year acquisition for tax-year disposal basis', () => {
    const priorBuy = {
      id: 'prior',
      walletAddress: WALLET,
      timestamp: '2024-06-01T00:00:00Z',
      level: 1,
      opHash: 'opPrior',
      kind: 'xtz_transfer' as const,
      direction: 'in' as const,
      counterparty: 'tz1external',
      asset: 'XTZ',
      quantity: 10,
      feeXtz: 0,
      note: 'transfer',
      tags: [],
      confidence: 'high' as const,
      classification: 'cex_withdrawal' as const,
      quoteUsd: 1,
    };
    const disposal = {
      id: 'disp',
      walletAddress: WALLET,
      timestamp: '2025-03-01T00:00:00Z',
      level: 2,
      opHash: 'opDisp',
      kind: 'xtz_transfer' as const,
      direction: 'out' as const,
      counterparty: 'tz1someone',
      asset: 'XTZ',
      quantity: 5,
      feeXtz: 0.001,
      note: 'transfer',
      tags: [],
      confidence: 'high' as const,
      classification: 'likely_gift' as const,
      quoteUsd: 2,
    };
    const result = calculateIRS([priorBuy, disposal], undefined, {
      startIso: '2025-01-01T00:00:00Z',
      endIso: '2026-01-01T00:00:00Z',
    });
    expect(result.disposals).toHaveLength(1);
    const d = result.disposals[0] as { basisUsd: number; proceedsUsd: number; gainUsd: number };
    expect(d.basisUsd).toBeCloseTo(5, 6); // 5 * $1 prior basis
    expect(d.proceedsUsd).toBeCloseTo(10, 6); // 5 * $2
    expect(d.gainUsd).toBeCloseTo(5, 6);
    // Prior-year acquisition not in ledger
    expect(result.ledger.every((e) => e.timestamp.startsWith('2025'))).toBe(true);
  });
});
