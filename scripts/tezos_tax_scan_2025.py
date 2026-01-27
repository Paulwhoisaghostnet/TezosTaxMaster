#!/usr/bin/env python3
"""
Tezos 2025 Tax Scanner (IRS + HMRC)

What it does:
- Pulls 2025 on-chain activity for a Tezos address via TzKT:
  - XTZ transactions
  - FA1.2/FA2 token transfers
- Builds a unified event ledger for 2025
- Classifies events under:
  - IRS-style: disposals -> capital gain/loss; certain receipts -> ordinary income
    * Crypto treated as property (Notice 2014-21) https://www.irs.gov/pub/irs-drop/n-14-21.pdf
    * Airdrop after hard fork -> income when received (Rev. Rul. 2019-24) https://www.irs.gov/pub/irs-drop/rr-19-24.pdf
    * Staking rewards -> income when dominion/control (Rev. Rul. 2023-14) https://www.irs.gov/pub/irs-sbse/rev-ruling-2023-14.pdf
    * If no specific ID, FIFO deemed (IRS FAQ) https://www.irs.gov/individuals/international-taxpayers/frequently-asked-questions-on-virtual-currency-transactions
  - HMRC-style: CGT disposals with matching: same-day, 30-day, then Section 104 pooling
    * Pooling guidance: CRYPTO22200 https://www.gov.uk/hmrc-internal-manuals/cryptoassets-manual/crypto22200
    * Examples: CRYPTO22250 etc. https://www.gov.uk/hmrc-internal-manuals/cryptoassets-manual/crypto22250
    * Fees satisfied in tokens: CRYPTO22280 https://www.gov.uk/hmrc-internal-manuals/cryptoassets-manual/crypto22280
    * Staking / Airdrops: CRYPTO21200 / CRYPTO21250

Outputs (in ./out):
- irs_2025_events.csv
- irs_2025_disposals_fifo.csv
- hmrc_2025_disposals_pooling.csv
- summary_2025.json

DISCLAIMER: This is a classification + calculation helper, not tax advice.
"""

from __future__ import annotations

import csv
import json
import math
import os
import sys
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
import urllib.request
import urllib.parse


# -----------------------------
# Config
# -----------------------------

TZKT_BASE = "https://api.tzkt.io/v1"
COINGECKO_BASE = "https://api.coingecko.com/api/v3"

YEAR = 2025
START_ISO = f"{YEAR}-01-01T00:00:00Z"
END_ISO   = f"{YEAR+1}-01-01T00:00:00Z"

OUT_DIR = "out"


# -----------------------------
# Helpers
# -----------------------------

def http_get_json(url: str, timeout: int = 30) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "tezos-tax-scanner/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
    return json.loads(body.decode("utf-8"))

def iso_to_dt(s: str) -> datetime:
    # TzKT uses ISO strings like "2025-03-01T12:34:56Z"
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)

def dt_to_iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

def ensure_out_dir() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)

def write_csv(path: str, rows: List[Dict[str, Any]], fieldnames: List[str]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in fieldnames})

def clamp(n: float) -> float:
    if math.isfinite(n):
        return n
    return 0.0

def safe_float(x: Any) -> float:
    try:
        return float(x)
    except Exception:
        return 0.0

def sleep_polite():
    time.sleep(0.15)


# -----------------------------
# Pricing
# -----------------------------

class PriceOracle:
    """
    Best effort oracle using CoinGecko for XTZ->USD/GBP (daily).
    If you want exact timestamp pricing, swap this for your own source.
    """
    def __init__(self, vs_currency: str):
        self.vs = vs_currency.lower()
        self.cache: Dict[str, float] = {}  # key: YYYY-MM-DD -> price

    def xtz_price_on_date(self, date_yyyy_mm_dd: str) -> float:
        if date_yyyy_mm_dd in self.cache:
            return self.cache[date_yyyy_mm_dd]

        # CoinGecko: /coins/tezos/history?date=dd-mm-yyyy
        dd, mm, yyyy = date_yyyy_mm_dd.split("-")[2], date_yyyy_mm_dd.split("-")[1], date_yyyy_mm_dd.split("-")[0]
        qdate = f"{dd}-{mm}-{yyyy}"
        url = f"{COINGECKO_BASE}/coins/tezos/history?{urllib.parse.urlencode({'date': qdate, 'localization': 'false'})}"
        data = http_get_json(url)
        sleep_polite()

        price = 0.0
        try:
            price = float(data["market_data"]["current_price"][self.vs])
        except Exception:
            price = 0.0
        self.cache[date_yyyy_mm_dd] = price
        return price

    def xtz_fmv(self, dt: datetime) -> float:
        d = dt.strftime("%Y-%m-%d")
        return self.xtz_price_on_date(d)


# -----------------------------
# Data model
# -----------------------------

@dataclass
class Event:
    timestamp: str                # ISO Z
    level: int
    op_hash: str
    kind: str                     # "xtz_transfer" | "token_transfer"
    direction: str                # "in" | "out"
    counterparty: str
    asset: str                    # "XTZ" or token identifier
    quantity: float
    fee_xtz: float
    note: str
    tags: str                     # pipe-separated
    confidence: str               # "high"|"medium"|"low"


# -----------------------------
# TzKT fetchers (2025 only)
# -----------------------------

def tzkt_paginated(url: str, limit: int = 1000) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    offset = 0
    while True:
        page_url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode({"limit": limit, "offset": offset})
        data = http_get_json(page_url)
        if not isinstance(data, list) or not data:
            break
        out.extend(data)
        if len(data) < limit:
            break
        offset += limit
        sleep_polite()
    return out

def fetch_xtz_transactions(address: str) -> List[Dict[str, Any]]:
    # Includes simple transfers and contract calls that move tez (amount>0).
    # We'll pull both sender/target involvement.
    params = {
        "anyof.sender.target": address,
        "timestamp.ge": START_ISO,
        "timestamp.lt": END_ISO,
        "sort.asc": "timestamp",
    }
    url = f"{TZKT_BASE}/operations/transactions?{urllib.parse.urlencode(params)}"
    return tzkt_paginated(url)

def fetch_token_transfers(address: str) -> List[Dict[str, Any]]:
    # Token transfers (FA2/FA1.2) involving address
    params = {
        "anyof.from.to": address,
        "timestamp.ge": START_ISO,
        "timestamp.lt": END_ISO,
        "sort.asc": "timestamp",
    }
    url = f"{TZKT_BASE}/tokens/transfers?{urllib.parse.urlencode(params)}"
    return tzkt_paginated(url)


# -----------------------------
# Event building + heuristics
# -----------------------------

def build_events(address: str, xtz_ops: List[Dict[str, Any]], tok_ops: List[Dict[str, Any]]) -> List[Event]:
    addr = address.lower()
    events: List[Event] = []

    # XTZ ops
    for op in xtz_ops:
        ts = op.get("timestamp")
        if not ts:
            continue
        sender = (op.get("sender") or {}).get("address", "") or ""
        target = (op.get("target") or {}).get("address", "") or ""
        amount_mutez = safe_float(op.get("amount", 0))
        amount_xtz = amount_mutez / 1_000_000.0
        fee_mutez = safe_float(op.get("fee", 0))
        fee_xtz = fee_mutez / 1_000_000.0

        if amount_xtz == 0 and fee_xtz == 0:
            continue

        direction = "in" if (target.lower() == addr and sender.lower() != addr) else "out"
        counterparty = sender if direction == "in" else target
        note = op.get("parameter") and "contract_call" or "transfer"
        tags = []
        conf = "medium"

        # crude hints
        if amount_xtz > 0 and direction == "in":
            tags.append("receipt")
        if amount_xtz > 0 and direction == "out":
            tags.append("payment_or_disposal")

        # mark self-transfer
        if sender.lower() == addr and target.lower() == addr:
            tags.append("self_transfer")
            conf = "high"

        events.append(Event(
            timestamp=ts,
            level=int(op.get("level", 0)),
            op_hash=str(op.get("hash", "")),
            kind="xtz_transfer",
            direction=direction,
            counterparty=counterparty,
            asset="XTZ",
            quantity=clamp(amount_xtz),
            fee_xtz=clamp(fee_xtz),
            note=note,
            tags="|".join(tags),
            confidence=conf
        ))

    # Token transfers
    for tr in tok_ops:
        ts = tr.get("timestamp")
        if not ts:
            continue
        from_a = (tr.get("from") or {}).get("address", "") or ""
        to_a = (tr.get("to") or {}).get("address", "") or ""
        direction = "in" if to_a.lower() == addr else "out"
        counterparty = from_a if direction == "in" else to_a

        token = tr.get("token") or {}
        contract = (token.get("contract") or {}).get("address", "") or ""
        token_id = token.get("tokenId")
        standard = token.get("standard", "")
        symbol = (token.get("metadata") or {}).get("symbol")
        name = (token.get("metadata") or {}).get("name")
        decimals = token.get("metadata", {}).get("decimals")

        raw_amount = safe_float(tr.get("amount", 0))
        qty = raw_amount
        if decimals is not None:
            try:
                qty = raw_amount / (10 ** int(decimals))
            except Exception:
                qty = raw_amount

        asset = f"{symbol or name or 'TOKEN'}:{contract}:{token_id}:{standard}"
        tags = ["token_transfer"]
        conf = "medium"

        # NFT hint
        if standard.upper() == "FA2" and (decimals in (None, 0)) and raw_amount == 1:
            tags.append("likely_nft")
            conf = "high"

        events.append(Event(
            timestamp=ts,
            level=int(tr.get("level", 0)),
            op_hash=str(tr.get("transactionHash", "")),
            kind="token_transfer",
            direction=direction,
            counterparty=counterparty,
            asset=asset,
            quantity=clamp(qty),
            fee_xtz=0.0,          # token transfer endpoint doesn't include fee; we'll keep 0
            note="token_transfer",
            tags="|".join(tags),
            confidence=conf
        ))

    # sort
    events.sort(key=lambda e: e.timestamp)
    return events


# -----------------------------
# Tax classification
# -----------------------------

def classify_irs(events: List[Event], usd_oracle: PriceOracle) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    IRS approach:
    - Buying/receiving isn't always taxable; selling/exchanging/using is.
    - FIFO if not specifically identifying units.
    We'll compute:
      - ledger rows with 'irs_category'
      - disposal rows with FIFO lots for XTZ only (best-effort).
    """
    ledger: List[Dict[str, Any]] = []
    disposals: List[Dict[str, Any]] = []

    # FIFO lots for XTZ (acquisitions create lots; disposals consume lots)
    xtz_lots: List[Dict[str, Any]] = []  # {acquired_dt, qty, basis_usd_per_xtz}

    for e in events:
        dt = iso_to_dt(e.timestamp)
        fmv_usd = usd_oracle.xtz_fmv(dt) if e.asset == "XTZ" else 0.0

        irs_category = "review"
        taxable = "unknown"
        proceeds_usd = ""
        basis_usd = ""
        gain_usd = ""

        if e.asset == "XTZ":
            if e.direction == "in" and e.quantity > 0:
                # Could be income (staking payout/airdrop/etc) or just transfer from self/other wallet
                irs_category = "acquisition_or_income_review"
                taxable = "maybe"
                # For FIFO capital gains later, we treat as an acquisition lot with basis = FMV at receipt (best-effort).
                xtz_lots.append({
                    "acquired_ts": e.timestamp,
                    "qty": e.quantity,
                    "basis_per": fmv_usd
                })

            elif e.direction == "out" and e.quantity > 0:
                # Disposal event: spend/sell/swap -> capital gain/loss generally
                irs_category = "disposal_capital"
                taxable = "yes"

                qty_to_dispose = e.quantity
                proceeds = qty_to_dispose * fmv_usd  # best-effort proceeds using same-day FMV (you may replace with actual sale proceeds)
                basis = 0.0

                lot_details = []
                while qty_to_dispose > 1e-12 and xtz_lots:
                    lot = xtz_lots[0]
                    take = min(qty_to_dispose, lot["qty"])
                    basis += take * lot["basis_per"]
                    lot_details.append({
                        "from_lot_acquired_ts": lot["acquired_ts"],
                        "take_qty": take,
                        "basis_per_usd": lot["basis_per"]
                    })
                    lot["qty"] -= take
                    qty_to_dispose -= take
                    if lot["qty"] <= 1e-12:
                        xtz_lots.pop(0)

                g = proceeds - basis

                proceeds_usd = round(proceeds, 8)
                basis_usd = round(basis, 8)
                gain_usd = round(g, 8)

                disposals.append({
                    "timestamp": e.timestamp,
                    "asset": e.asset,
                    "qty_disposed": e.quantity,
                    "fmv_usd_per_xtz_used": round(fmv_usd, 8),
                    "proceeds_usd_est": proceeds_usd,
                    "basis_usd_fifo_est": basis_usd,
                    "gain_usd_est": gain_usd,
                    "fee_xtz": e.fee_xtz,
                    "op_hash": e.op_hash,
                    "lot_breakdown_json": json.dumps(lot_details, ensure_ascii=False),
                    "note": "FIFO used if you did not specifically identify units (IRS FAQ)."
                })

        else:
            # Token/NFT: we can tag but not compute basis without a pricing feed per token.
            if e.direction == "out":
                irs_category = "token_disposal_review"
                taxable = "likely"
            else:
                irs_category = "token_acquisition_or_income_review"
                taxable = "maybe"

        ledger.append({
            "timestamp": e.timestamp,
            "level": e.level,
            "op_hash": e.op_hash,
            "kind": e.kind,
            "direction": e.direction,
            "counterparty": e.counterparty,
            "asset": e.asset,
            "quantity": e.quantity,
            "fee_xtz": e.fee_xtz,
            "tags": e.tags,
            "confidence": e.confidence,
            "irs_category": irs_category,
            "irs_taxable": taxable,
            "xtz_fmv_usd_daily": round(fmv_usd, 8) if e.asset == "XTZ" else ""
        })

    return ledger, disposals


def hmrc_pooling_disposals(events: List[Event], gbp_oracle: PriceOracle) -> List[Dict[str, Any]]:
    """
    HMRC-style matching for XTZ only (best-effort):
    same-day acquisitions, then 30-day acquisitions, then Section 104 pool average.
    This produces estimated gains in GBP.

    NOTE: Full HMRC matching is per-asset. For tokens/NFTs you need GBP pricing per asset.
    """
    # We'll build day buckets of acquisitions for XTZ
    acq_by_day: Dict[str, List[Dict[str, Any]]] = {}
    disposals: List[Dict[str, Any]] = []

    # Section 104 pool
    pool_qty = 0.0
    pool_cost_gbp = 0.0

    # store acquisitions for 30-day matching: list of (dt, qty, cost_per_unit)
    future_acqs: List[Tuple[datetime, float, float, str]] = []  # dt, qty, cost_per, ts

    xtz_events = [e for e in events if e.asset == "XTZ" and e.quantity > 0]
    xtz_events.sort(key=lambda e: e.timestamp)

    # First pass: record acquisitions per day
    for e in xtz_events:
        dt = iso_to_dt(e.timestamp)
        day = dt.strftime("%Y-%m-%d")
        fmv_gbp = gbp_oracle.xtz_fmv(dt)
        if e.direction == "in":
            acq_by_day.setdefault(day, []).append({
                "ts": e.timestamp,
                "dt": dt,
                "qty": e.quantity,
                "cost_per": fmv_gbp
            })
            future_acqs.append((dt, e.quantity, fmv_gbp, e.timestamp))

    # helper: consume from an acquisition record list
    def consume_from_list(lst: List[Dict[str, Any]], qty_needed: float) -> Tuple[float, List[Dict[str, Any]]]:
        cost = 0.0
        used = []
        i = 0
        while qty_needed > 1e-12 and i < len(lst):
            rec = lst[i]
            take = min(qty_needed, rec["qty"])
            cost += take * rec["cost_per"]
            used.append({"from_acq_ts": rec["ts"], "take_qty": take, "cost_per_gbp": rec["cost_per"]})
            rec["qty"] -= take
            qty_needed -= take
            if rec["qty"] <= 1e-12:
                i += 1
            else:
                break
        # drop fully consumed
        lst[:] = [r for r in lst if r["qty"] > 1e-12]
        return cost, used

    # Second pass: process chronological; update pool as we go
    # Pool increases with acquisitions unless they later get matched by same-day/30-day when disposing.
    # This is a simplified approach: we add to pool immediately, then when disposing we preferentially match.
    for e in xtz_events:
        dt = iso_to_dt(e.timestamp)
        day = dt.strftime("%Y-%m-%d")
        fmv_gbp = gbp_oracle.xtz_fmv(dt)

        if e.direction == "in":
            # add to pool
            pool_qty += e.quantity
            pool_cost_gbp += e.quantity * fmv_gbp
            continue

        # disposal
        qty = e.quantity
        proceeds = qty * fmv_gbp

        # 1) same-day matching
        same_day_list = acq_by_day.get(day, [])
        same_day_cost, same_day_used = consume_from_list(same_day_list, qty)
        qty_left = qty - sum(u["take_qty"] for u in same_day_used)
        cost_total = same_day_cost
        match_used = same_day_used[:]

        # 2) 30-day matching (acquisitions AFTER disposal within 30 days)
        if qty_left > 1e-12:
            end_dt = dt.replace(tzinfo=timezone.utc)  # already tz-aware
            # find eligible acquisitions in (dt, dt+30d]
            thirty = []
            for (adt, aqty, cost_per, ts) in list(future_acqs):
                if adt > dt and (adt - dt).days <= 30 and aqty > 1e-12:
                    thirty.append([adt, aqty, cost_per, ts])
            thirty.sort(key=lambda x: x[0])

            for rec in thirty:
                if qty_left <= 1e-12:
                    break
                take = min(qty_left, rec[1])
                cost_total += take * rec[2]
                match_used.append({"from_acq_ts": rec[3], "take_qty": take, "cost_per_gbp": rec[2], "rule": "30-day"})
                rec[1] -= take
                qty_left -= take

                # write back to future_acqs
                for idx, (adt, aqty, cper, ts2) in enumerate(future_acqs):
                    if ts2 == rec[3]:
                        future_acqs[idx] = (adt, aqty - take, cper, ts2)
                        break

        # 3) Section 104 pool for remainder
        pool_used = []
        if qty_left > 1e-12:
            if pool_qty <= 1e-12:
                # nothing in pool; treat cost as 0 and flag
                pool_cost = 0.0
            else:
                avg_cost = pool_cost_gbp / pool_qty
                pool_cost = qty_left * avg_cost
                pool_used.append({"take_qty": qty_left, "avg_cost_per_gbp": avg_cost, "rule": "S104"})
                # reduce pool
                pool_qty -= qty_left
                pool_cost_gbp -= pool_cost
            cost_total += pool_cost
            qty_left = 0.0

        gain = proceeds - cost_total

        disposals.append({
            "timestamp": e.timestamp,
            "asset": "XTZ",
            "qty_disposed": qty,
            "fmv_gbp_per_xtz_used": round(fmv_gbp, 8),
            "proceeds_gbp_est": round(proceeds, 8),
            "allowable_cost_gbp_est": round(cost_total, 8),
            "gain_gbp_est": round(gain, 8),
            "op_hash": e.op_hash,
            "matching_breakdown_json": json.dumps(match_used + pool_used, ensure_ascii=False),
            "note": "Best-effort same-day, 30-day, then Section 104 style matching (HMRC Cryptoassets Manual)."
        })

    return disposals


# -----------------------------
# Main
# -----------------------------

def main():
    if len(sys.argv) < 2:
        print("Usage: python tezos_tax_scan_2025.py <tzAddress> [--no-prices]")
        print("Example: python tezos_tax_scan_2025.py tz1... ")
        sys.exit(1)

    address = sys.argv[1].strip()
    no_prices = "--no-prices" in sys.argv

    ensure_out_dir()

    print(f"[+] Fetching 2025 ops for {address} from TzKT...")
    xtz_ops = fetch_xtz_transactions(address)
    tok_ops = fetch_token_transfers(address)
    print(f"    XTZ ops: {len(xtz_ops)}")
    print(f"    Token transfers: {len(tok_ops)}")

    print("[+] Building unified event ledger...")
    events = build_events(address, xtz_ops, tok_ops)

    # pricing oracles (daily)
    usd_oracle = PriceOracle("usd")
    gbp_oracle = PriceOracle("gbp")

    if no_prices:
        # stub: returns 0 so you can still get event classification
        usd_oracle.xtz_fmv = lambda dt: 0.0  # type: ignore
        gbp_oracle.xtz_fmv = lambda dt: 0.0  # type: ignore

    print("[+] Classifying IRS ledger and FIFO disposals (XTZ only)...")
    irs_ledger, irs_disposals = classify_irs(events, usd_oracle)

    print("[+] Computing HMRC disposals with pooling (XTZ only)...")
    hmrc_disposals = hmrc_pooling_disposals(events, gbp_oracle)

    # Write outputs
    print("[+] Writing outputs...")
    irs_fields = list(irs_ledger[0].keys()) if irs_ledger else [
        "timestamp","level","op_hash","kind","direction","counterparty","asset","quantity","fee_xtz","tags","confidence","irs_category","irs_taxable","xtz_fmv_usd_daily"
    ]
    write_csv(os.path.join(OUT_DIR, "irs_2025_events.csv"), irs_ledger, irs_fields)

    fifo_fields = list(irs_disposals[0].keys()) if irs_disposals else [
        "timestamp","asset","qty_disposed","fmv_usd_per_xtz_used","proceeds_usd_est","basis_usd_fifo_est","gain_usd_est","fee_xtz","op_hash","lot_breakdown_json","note"
    ]
    write_csv(os.path.join(OUT_DIR, "irs_2025_disposals_fifo.csv"), irs_disposals, fifo_fields)

    hmrc_fields = list(hmrc_disposals[0].keys()) if hmrc_disposals else [
        "timestamp","asset","qty_disposed","fmv_gbp_per_xtz_used","proceeds_gbp_est","allowable_cost_gbp_est","gain_gbp_est","op_hash","matching_breakdown_json","note"
    ]
    write_csv(os.path.join(OUT_DIR, "hmrc_2025_disposals_pooling.csv"), hmrc_disposals, hmrc_fields)

    summary = {
        "address": address,
        "year": YEAR,
        "event_count": len(events),
        "irs_disposal_count_xtz": len(irs_disposals),
        "hmrc_disposal_count_xtz": len(hmrc_disposals),
        "notes": [
            "Token/NFT gain calculations require per-token GBP/USD pricing; this script flags likely disposals but does not price them.",
            "Tezos delegation payouts often look like ordinary incoming transfers; review 'acquisition_or_income_review' rows.",
            "Prices are daily CoinGecko snapshots (not exact timestamp). Replace oracle if you need minute-level FMV."
        ]
    }
    with open(os.path.join(OUT_DIR, "summary_2025.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)

    print("[✓] Done.")
    print(f"Outputs in ./{OUT_DIR}/")
    print("  - irs_2025_events.csv")
    print("  - irs_2025_disposals_fifo.csv")
    print("  - hmrc_2025_disposals_pooling.csv")
    print("  - summary_2025.json")


if __name__ == "__main__":
    main()
