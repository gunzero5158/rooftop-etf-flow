"""US ETF and benchmark index data fetcher using Yahoo Finance and ETFdb."""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import json
import re
import time
import urllib.parse
from typing import Any

import requests

from backend.db import (
    get_conn,
    load_universe,
    log_sync,
    sync_meta_from_universe,
    update_etf_latest_aum,
    upsert_etf_daily,
    upsert_index_daily,
)

TZ_UTC = dt.timezone.utc
TZ_NY = dt.timezone(dt.timedelta(hours=-5))
HEADERS_US = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


def _request_with_fallback(url: str, timeout: int = 20, retries: int = 3) -> requests.Response | None:
    """GET request trying default proxy env first, falling back to direct if proxy fails."""
    for attempt in range(retries):
        for trust_env in (True, False):
            try:
                sess = requests.Session()
                sess.trust_env = trust_env
                sess.headers.update(HEADERS_US)
                resp = sess.get(url, timeout=timeout)
                if resp.status_code == 200:
                    return resp
            except requests.exceptions.ProxyError:
                continue
            except Exception:
                if trust_env is False:
                    break
        time.sleep(0.5 * (attempt + 1))
    return None


def _fetch_yahoo_bars(symbol: str, range_str: str = "6mo") -> list[dict[str, Any]]:
    """Fetch daily OHLCV bars from Yahoo Finance chart API and compute daily pct_chg."""
    encoded = urllib.parse.quote(symbol, safe="")
    url = f"https://query2.finance.yahoo.com/v8/finance/chart/{encoded}?range={range_str}&interval=1d"
    resp = _request_with_fallback(url, timeout=15, retries=3)
    if resp is None:
        return []
    try:
        payload = resp.json()
        result = payload["chart"]["result"][0]
        timestamps = result.get("timestamp") or []
        quote = result["indicators"]["quote"][0]
        opens = quote.get("open") or []
        highs = quote.get("high") or []
        lows = quote.get("low") or []
        closes = quote.get("close") or []
        volumes = quote.get("volume") or []
    except Exception:
        return []

    bars: list[dict[str, Any]] = []
    prev_close: float | None = None
    seen_dates: set[str] = set()

    for i, ts in enumerate(timestamps):
        c = closes[i] if i < len(closes) else None
        if c is None:
            continue
        d_str = dt.datetime.fromtimestamp(ts, TZ_NY).strftime("%Y-%m-%d")
        if d_str in seen_dates:
            continue
        seen_dates.add(d_str)

        close_val = float(c)
        open_val = float(opens[i]) if i < len(opens) and opens[i] is not None else close_val
        high_val = float(highs[i]) if i < len(highs) and highs[i] is not None else close_val
        low_val = float(lows[i]) if i < len(lows) and lows[i] is not None else close_val
        vol_val = float(volumes[i]) if i < len(volumes) and volumes[i] is not None else 0.0

        pct_chg = 0.0
        if prev_close and prev_close > 0:
            pct_chg = (close_val - prev_close) / prev_close * 100.0
        prev_close = close_val

        bars.append(
            {
                "trade_date": d_str,
                "open": round(open_val, 4),
                "high": round(high_val, 4),
                "low": round(low_val, 4),
                "close": round(close_val, 4),
                "pct_chg": round(pct_chg, 4),
                "volume": vol_val,
                "amount": round(vol_val * close_val, 2),
            }
        )
    return bars


def _parse_aum_millions(val_str: str, unit: str) -> float:
    """Convert ETFdb AUM string + unit (M/B/T) into USD Millions."""
    num = float(val_str.replace(",", "").strip())
    u = unit.upper()
    if u == "B":
        return num * 1000.0
    if u == "T":
        return num * 1_000_000.0
    return num


def _fetch_etfdb_flows_and_aum(ticker: str, lookback_points: int = 120) -> tuple[dict[str, float], float]:
    """Fetch daily fund flows (USD Millions) and latest AUM (USD Millions) from ETFdb."""
    url = f"https://etfdb.com/etf/{ticker}/"
    resp = _request_with_fallback(url, timeout=22, retries=3)
    if resp is None:
        return {}, 0.0

    html = resp.text
    flows_map: dict[str, float] = {}
    m_series = re.search(
        r"data-series='(\[\[.*?\]\])'\s+id='fund-flow-chart-container'", html
    )
    if m_series:
        try:
            series = json.loads(m_series.group(1))
            for ts_ms, val_billions in series[-lookback_points:]:
                if ts_ms is None or val_billions is None:
                    continue
                # ETFdb timestamps represent midnight UTC for the US trading date
                d_str = dt.datetime.fromtimestamp(ts_ms / 1000.0, TZ_UTC).strftime("%Y-%m-%d")
                flows_map[d_str] = round(float(val_billions) * 1000.0, 4)
        except Exception:
            pass

    latest_aum = 0.0
    m_aum = re.search(r"AUM</span>\s*<span[^>]*>\$([0-9,.]+)\s*([MBT])</span>", html)
    if m_aum:
        try:
            latest_aum = round(_parse_aum_millions(m_aum.group(1), m_aum.group(2)), 2)
        except Exception:
            latest_aum = 0.0

    return flows_map, latest_aum


def _fetch_single_us_etf(etf: dict[str, Any], lookback_days: int) -> tuple[str, list[dict[str, Any]], float]:
    """Fetch price bars and ETFdb flow series for a single US ETF."""
    code = etf["code"]
    bars = _fetch_yahoo_bars(code, range_str="6mo")
    bars = bars[-lookback_days:] if len(bars) > lookback_days else bars
    flows_map, latest_aum = _fetch_etfdb_flows_and_aum(code, lookback_points=lookback_days + 20)

    bar_dates = {b["trade_date"] for b in bars}
    latest_bar_date = bars[-1]["trade_date"] if bars else ""
    rows: list[dict[str, Any]] = []

    for b in bars:
        d = b["trade_date"]
        flow_m = flows_map.get(d)
        aum_val = latest_aum if (d == latest_bar_date and latest_aum > 0) else None
        shares_approx = (
            round(latest_aum * 100.0 / b["close"], 4)
            if (aum_val and b["close"] > 0)
            else None
        )
        rows.append(
            {
                "market": "US",
                "code": code,
                "trade_date": d,
                "close": b["close"],
                "pct_chg": b["pct_chg"],
                "volume": b["volume"],
                "amount": b["amount"],
                "nav": b["close"],
                "shares": shares_approx,
                "share_chg": round(flow_m * 100.0 / b["close"], 4) if (flow_m is not None and b["close"] > 0) else None,
                "net_flow": flow_m,
                "aum": aum_val,
            }
        )

    # Also ensure any ETFdb flow date missing from Yahoo bars is not dropped if recent
    for d, flow_m in flows_map.items():
        if d not in bar_dates and bars and d >= bars[0]["trade_date"]:
            rows.append(
                {
                    "market": "US",
                    "code": code,
                    "trade_date": d,
                    "close": None,
                    "pct_chg": None,
                    "volume": None,
                    "amount": None,
                    "nav": None,
                    "shares": None,
                    "share_chg": None,
                    "net_flow": flow_m,
                    "aum": None,
                }
            )

    return code, rows, latest_aum


def sync_us_data(lookback_days: int = 85, target_codes: list[str] | None = None) -> dict[str, Any]:
    """Synchronize US benchmark indices, ETF prices, ETFdb net flows (USD Millions), and AUM."""
    sync_meta_from_universe()
    universe = load_universe()
    us_cfg = universe["US"]
    indices = us_cfg["indices"]
    all_etfs = us_cfg["etfs"]
    if target_codes:
        target_set = set(target_codes)
        etfs = [e for e in all_etfs if e["code"] in target_set]
    else:
        etfs = all_etfs

    # 1. Fetch US benchmark indices
    index_rows: list[dict[str, Any]] = []
    for idx in indices:
        bars = _fetch_yahoo_bars(idx["code"], range_str="6mo")
        bars = bars[-lookback_days:] if len(bars) > lookback_days else bars
        for b in bars:
            index_rows.append(
                {
                    "market": "US",
                    "code": idx["code"],
                    "name": idx["name"],
                    "trade_date": b["trade_date"],
                    "open": b["open"],
                    "high": b["high"],
                    "low": b["low"],
                    "close": b["close"],
                    "pct_chg": b["pct_chg"],
                    "amount": b["amount"],
                }
            )
    upsert_index_daily(index_rows)

    # 2. Concurrently fetch ETF bars & ETFdb flows with polite worker pool
    all_etf_rows: list[dict[str, Any]] = []
    aum_updates: list[tuple[str, float]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        futures = {
            executor.submit(_fetch_single_us_etf, etf, lookback_days): etf["code"]
            for etf in etfs
        }
        for fut in concurrent.futures.as_completed(futures):
            code, rows, latest_aum = fut.result()
            all_etf_rows.extend(rows)
            if latest_aum > 0:
                aum_updates.append((code, latest_aum))

    upsert_etf_daily(all_etf_rows)
    for code, aum_val in aum_updates:
        update_etf_latest_aum("US", code, aum_val)

    with get_conn() as conn:
        row_price = conn.execute(
            "SELECT MAX(trade_date) AS d FROM index_daily WHERE market = 'US'"
        ).fetchone()
        row_flow = conn.execute(
            "SELECT MAX(trade_date) AS d FROM etf_daily WHERE market = 'US' AND net_flow IS NOT NULL"
        ).fetchone()
        latest_price_date = row_price["d"] if row_price and row_price["d"] else ""
        latest_flow_date = row_flow["d"] if row_flow and row_flow["d"] else ""

    msg = f"Synced {len(etfs)} US ETFs and {len(indices)} indices."
    log_sync("US", "ok", msg, latest_price_date, latest_flow_date)
    return {
        "market": "US",
        "status": "ok",
        "message": msg,
        "etf_count": len(etfs),
        "latest_price_date": latest_price_date,
        "latest_flow_date": latest_flow_date,
    }
