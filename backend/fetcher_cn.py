"""A-share (CN) ETF and benchmark index data fetcher and flow calculator."""

from __future__ import annotations

import datetime as dt
import io
import json
import re
import time
import warnings
from typing import Any

import pandas as pd
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

TZ_CN = dt.timezone(dt.timedelta(hours=8))
HEADERS_CN = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    )
}


def _create_direct_session() -> requests.Session:
    """Create a requests session bypassing system proxy for CN financial APIs."""
    session = requests.Session()
    session.trust_env = False
    session.headers.update(HEADERS_CN)
    return session


def _infer_cn_prefix(code: str, exchange: str = "") -> str:
    """Return 'sh' or 'sz' market prefix for Sina/Tencent endpoints."""
    ex = exchange.upper()
    if ex == "SSE":
        return "sh"
    if ex == "SZSE":
        return "sz"
    if code.startswith(("5", "6", "000")):
        return "sh"
    return "sz"


def _fetch_sina_kline(
    session: requests.Session, symbol: str, datalen: int = 100
) -> list[dict[str, Any]]:
    """Fetch daily unadjusted OHLCV bars from Sina Finance."""
    url = "https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData"
    params = {"symbol": symbol, "scale": "240", "ma": "no", "datalen": str(datalen)}
    for attempt in range(3):
        try:
            resp = session.get(url, params=params, timeout=15)
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, list) and data:
                return data
        except Exception:
            if attempt == 2:
                return []
            time.sleep(0.5)
    return []


def _fetch_tencent_kline(
    session: requests.Session, symbol: str, datalen: int = 100
) -> list[dict[str, Any]]:
    """Fallback daily OHLCV fetcher using Tencent Finance."""
    url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
    params = {"param": f"{symbol},day,,,{datalen},qfq"}
    try:
        resp = session.get(url, params=params, timeout=15)
        resp.raise_for_status()
        payload = resp.json()
        node = payload.get("data", {}).get(symbol, {})
        rows = node.get("day") or node.get("qfqday") or []
        parsed = []
        for row in rows:
            parsed.append(
                {
                    "day": row[0],
                    "open": row[1],
                    "close": row[2],
                    "high": row[3],
                    "low": row[4],
                    "volume": row[5],
                }
            )
        return parsed
    except Exception:
        return []


def _fetch_kline_bars(
    session: requests.Session, symbol: str, datalen: int = 100
) -> list[dict[str, Any]]:
    """Fetch daily OHLCV bars and compute daily pct_chg."""
    raw = _fetch_sina_kline(session, symbol, datalen=datalen)
    if not raw:
        raw = _fetch_tencent_kline(session, symbol, datalen=datalen)
    bars: list[dict[str, Any]] = []
    prev_close: float | None = None
    for item in raw:
        try:
            close = float(item["close"])
            open_p = float(item["open"])
            high = float(item["high"])
            low = float(item["low"])
            vol = float(item.get("volume") or 0.0)
        except (ValueError, TypeError, KeyError):
            continue
        pct_chg = 0.0
        if prev_close and prev_close > 0:
            pct_chg = (close - prev_close) / prev_close * 100.0
        prev_close = close
        bars.append(
            {
                "trade_date": item["day"],
                "open": open_p,
                "high": high,
                "low": low,
                "close": close,
                "pct_chg": round(pct_chg, 4),
                "volume": vol,
                "amount": round(vol * close, 2),
            }
        )
    return bars


def _fetch_eastmoney_nav(session: requests.Session, code: str) -> dict[str, float]:
    """Fetch historical daily NAV map {YYYY-MM-DD: nav} from Eastmoney pingzhongdata."""
    url = f"http://fund.eastmoney.com/pingzhongdata/{code}.js"
    headers = {"Referer": "http://fund.eastmoney.com/"}
    for attempt in range(3):
        try:
            resp = session.get(url, headers=headers, timeout=15)
            resp.raise_for_status()
            m = re.search(r"var\s+Data_netWorthTrend\s*=\s*(\[.*?\]);", resp.text)
            if not m:
                return {}
            series = json.loads(m.group(1))
            nav_map: dict[str, float] = {}
            for pt in series:
                ts = pt.get("x")
                val = pt.get("y")
                if ts is None or val is None:
                    continue
                d_str = dt.datetime.fromtimestamp(ts / 1000.0, TZ_CN).strftime("%Y-%m-%d")
                nav_map[d_str] = float(val)
            return nav_map
        except Exception:
            if attempt == 2:
                return {}
            time.sleep(0.4)
    return {}


def _fetch_sse_shares_for_date(
    session: requests.Session, date_str: str, target_codes: set[str]
) -> dict[str, float]:
    """Fetch SSE daily ETF shares (in 10k units / 万份) for a single trade date."""
    url = "https://query.sse.com.cn/commonQuery.do"
    params = {
        "isPagination": "true",
        "pageHelp.pageSize": "10000",
        "pageHelp.pageNo": "1",
        "pageHelp.beginPage": "1",
        "pageHelp.cacheSize": "1",
        "pageHelp.endPage": "1",
        "sqlId": "COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L",
        "STAT_DATE": date_str,
    }
    headers = {"Referer": "https://www.sse.com.cn/"}
    for attempt in range(3):
        try:
            resp = session.get(url, params=params, headers=headers, timeout=15)
            resp.raise_for_status()
            result = resp.json().get("result") or []
            shares_map: dict[str, float] = {}
            for row in result:
                code = str(row.get("SEC_CODE", "")).strip()
                if code in target_codes:
                    try:
                        val = float(row.get("TOT_VOL"))
                        if val > 0:
                            shares_map[code] = val
                    except (TypeError, ValueError):
                        continue
            return shares_map
        except Exception:
            if attempt == 2:
                return {}
            time.sleep(0.5)
    return {}


def _fetch_szse_shares_history(
    session: requests.Session, code: str, start_date: str, end_date: str
) -> dict[str, float]:
    """Fetch SZSE historical ETF shares (converted to 10k units / 万份) via official Excel report."""
    url = "https://fund.szse.cn/api/report/ShowReport"
    params = {
        "SHOWTYPE": "xlsx",
        "CATALOGID": "fund_jjgm",
        "TABKEY": "tab1",
        "txtDm": code,
        "txtStart": start_date,
        "txtEnd": end_date,
    }
    headers = {"Referer": "https://fund.szse.cn/marketdata/fundslist/index.html"}
    for attempt in range(3):
        try:
            resp = session.get(url, params=params, headers=headers, timeout=15)
            resp.raise_for_status()
            if not resp.content or len(resp.content) < 200:
                return {}
            with warnings.catch_warnings(record=True):
                warnings.simplefilter("always")
                df = pd.read_excel(io.BytesIO(resp.content), engine="openpyxl")
            if df.empty or "日期" not in df.columns or "基金规模(份)" not in df.columns:
                return {}
            out: dict[str, float] = {}
            for _, row in df.iterrows():
                d_val = str(row["日期"]).strip()[:10]
                raw_shares = pd.to_numeric(row["基金规模(份)"], errors="coerce")
                if pd.notna(raw_shares) and raw_shares > 0:
                    # Convert raw shares to 10k shares (万份) to match SSE unit
                    out[d_val] = float(raw_shares) / 10000.0
            return out
        except Exception:
            if attempt == 2:
                return {}
            time.sleep(0.5)
    return {}


def _recalculate_cn_flows_for_code(code: str) -> None:
    """Recompute share_chg, net_flow (亿元), and aum (亿元) for one CN ETF from stored daily rows."""
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT trade_date, close, nav, shares
            FROM etf_daily
            WHERE market = 'CN' AND code = ?
            ORDER BY trade_date ASC
            """,
            (code,),
        ).fetchall()

        updates: list[tuple[float | None, float | None, float | None, str, str, str]] = []
        prev_shares: float | None = None
        latest_aum: float = 0.0

        for row in rows:
            shares = row["shares"]
            nav = row["nav"]
            close = row["close"]
            eff_price = nav if (nav is not None and nav > 0) else close

            share_chg: float | None = None
            net_flow: float | None = None
            aum: float | None = None

            if shares is not None and shares > 0:
                if eff_price is not None and eff_price > 0:
                    aum = round(shares * eff_price / 10000.0, 4)
                    latest_aum = aum
                if prev_shares is not None and prev_shares > 0:
                    share_chg = round(shares - prev_shares, 4)
                    if eff_price is not None and eff_price > 0:
                        net_flow = round(share_chg * eff_price / 10000.0, 4)
                prev_shares = shares

            updates.append((share_chg, net_flow, aum, "CN", code, row["trade_date"]))

        if updates:
            conn.executemany(
                """
                UPDATE etf_daily
                SET share_chg = ?, net_flow = ?, aum = ?
                WHERE market = ? AND code = ? AND trade_date = ?
                """,
                updates,
            )
    if latest_aum > 0:
        update_etf_latest_aum("CN", code, latest_aum)


def sync_cn_data(lookback_days: int = 85, target_codes: list[str] | None = None) -> dict[str, Any]:
    """Synchronize A-share benchmark indices, ETF prices, NAVs, official shares, and compute net flows."""
    sync_meta_from_universe()
    universe = load_universe()
    cn_cfg = universe["CN"]
    indices = cn_cfg["indices"]
    all_etfs = cn_cfg["etfs"]
    if target_codes:
        target_set = set(target_codes)
        etfs = [e for e in all_etfs if e["code"] in target_set]
    else:
        etfs = all_etfs

    session = _create_direct_session()

    # 1. Sync benchmark indices and collect authoritative trade calendar
    trade_dates_set: set[str] = set()
    index_rows: list[dict[str, Any]] = []
    for idx in indices:
        sym = f"{idx['prefix']}{idx['code']}"
        bars = _fetch_kline_bars(session, sym, datalen=lookback_days + 10)
        bars = bars[-lookback_days:] if len(bars) > lookback_days else bars
        for b in bars:
            trade_dates_set.add(b["trade_date"])
            index_rows.append(
                {
                    "market": "CN",
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

    trade_dates = sorted(trade_dates_set)
    if not trade_dates:
        msg = "No CN index trade dates retrieved"
        log_sync("CN", "error", msg)
        return {"market": "CN", "status": "error", "message": msg}

    start_date = trade_dates[0]
    end_date = trade_dates[-1]

    # 2. Fetch ETF prices & NAVs
    sse_codes: set[str] = set()
    szse_etfs: list[dict[str, Any]] = []
    etf_daily_rows: list[dict[str, Any]] = []

    for etf in etfs:
        code = etf["code"]
        exchange = etf.get("exchange", "SSE" if code.startswith(("5", "6")) else "SZSE")
        if exchange == "SSE":
            sse_codes.add(code)
        else:
            szse_etfs.append(etf)

        prefix = _infer_cn_prefix(code, exchange)
        bars = _fetch_kline_bars(session, f"{prefix}{code}", datalen=lookback_days + 10)
        bars = bars[-lookback_days:] if len(bars) > lookback_days else bars
        nav_map = _fetch_eastmoney_nav(session, code)

        for b in bars:
            d = b["trade_date"]
            etf_daily_rows.append(
                {
                    "market": "CN",
                    "code": code,
                    "trade_date": d,
                    "close": b["close"],
                    "pct_chg": b["pct_chg"],
                    "volume": b["volume"],
                    "amount": b["amount"],
                    "nav": nav_map.get(d),
                    "shares": None,
                    "share_chg": None,
                    "net_flow": None,
                    "aum": None,
                }
            )

    upsert_etf_daily(etf_daily_rows)

    # 3. Fetch SSE shares by date (skip dates already complete for all target SSE codes, always recheck last 5 days)
    if sse_codes:
        recent_recheck = set(trade_dates[-5:])
        with get_conn() as conn:
            complete_dates_rows = conn.execute(
                f"""
                SELECT trade_date, COUNT(DISTINCT code) as cnt
                FROM etf_daily
                WHERE market = 'CN'
                  AND shares IS NOT NULL
                  AND shares > 0
                  AND code IN ({','.join('?' for _ in sse_codes)})
                GROUP BY trade_date
                HAVING cnt >= ?
                """,
                (*sse_codes, len(sse_codes)),
            ).fetchall()
            complete_dates = {r["trade_date"] for r in complete_dates_rows}

        dates_to_fetch = [
            d for d in trade_dates if (d not in complete_dates or d in recent_recheck)
        ]

        sse_share_rows: list[dict[str, Any]] = []
        for d in dates_to_fetch:
            shares_map = _fetch_sse_shares_for_date(session, d, sse_codes)
            for code, sh_val in shares_map.items():
                sse_share_rows.append(
                    {
                        "market": "CN",
                        "code": code,
                        "trade_date": d,
                        "close": None,
                        "pct_chg": None,
                        "volume": None,
                        "amount": None,
                        "nav": None,
                        "shares": sh_val,
                        "share_chg": None,
                        "net_flow": None,
                        "aum": None,
                    }
                )
            time.sleep(0.08)
        upsert_etf_daily(sse_share_rows)

    # 4. Fetch SZSE historical shares per ETF
    szse_share_rows: list[dict[str, Any]] = []
    for etf in szse_etfs:
        code = etf["code"]
        sh_hist = _fetch_szse_shares_history(session, code, start_date, end_date)
        for d, sh_val in sh_hist.items():
            szse_share_rows.append(
                {
                    "market": "CN",
                    "code": code,
                    "trade_date": d,
                    "close": None,
                    "pct_chg": None,
                    "volume": None,
                    "amount": None,
                    "nav": None,
                    "shares": sh_val,
                    "share_chg": None,
                    "net_flow": None,
                    "aum": None,
                }
            )
        time.sleep(0.1)
    upsert_etf_daily(szse_share_rows)

    # 5. Recompute daily share changes, net flows (亿元), and AUM (亿元)
    for etf in etfs:
        _recalculate_cn_flows_for_code(etf["code"])

    with get_conn() as conn:
        row_price = conn.execute(
            "SELECT MAX(trade_date) AS d FROM index_daily WHERE market = 'CN'"
        ).fetchone()
        row_flow = conn.execute(
            "SELECT MAX(trade_date) AS d FROM etf_daily WHERE market = 'CN' AND net_flow IS NOT NULL"
        ).fetchone()
        latest_price_date = row_price["d"] if row_price and row_price["d"] else end_date
        latest_flow_date = row_flow["d"] if row_flow and row_flow["d"] else ""

    msg = f"Synced {len(etfs)} CN ETFs and {len(indices)} indices."
    log_sync("CN", "ok", msg, latest_price_date, latest_flow_date)
    return {
        "market": "CN",
        "status": "ok",
        "message": msg,
        "etf_count": len(etfs),
        "latest_price_date": latest_price_date,
        "latest_flow_date": latest_flow_date,
    }
