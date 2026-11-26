"""Multi-period ETF flow aggregator, quadrant classifier, and market analysis engine."""

from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any

from backend.db import BASE_DIR, get_conn, get_latest_sync, load_universe

PERIOD_DAYS_MAP = {
    "1d": 1,
    "5d": 5,
    "20d": 20,
    "60d": 60,
}

PERIOD_LABELS = {
    "1d": "单日 (1D)",
    "5d": "近一周 (5D)",
    "20d": "近一月 (20D)",
    "60d": "近一季 (60D)",
}


def _compound_return(pct_list: list[float]) -> float:
    """Compute compounded return percentage from daily pct_chg values."""
    acc = 1.0
    for r in pct_list:
        acc *= 1.0 + r / 100.0
    return round((acc - 1.0) * 100.0, 2)


def _get_flow_dates(market: str, limit: int) -> list[str]:
    """Return sorted trade dates (ascending) with valid net_flow records for the market."""
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT DISTINCT trade_date
            FROM etf_daily
            WHERE market = ? AND net_flow IS NOT NULL
            ORDER BY trade_date DESC
            LIMIT ?
            """,
            (market, limit),
        ).fetchall()
    dates = [r["trade_date"] for r in rows]
    dates.reverse()
    return dates


def _classify_quadrant(pct_chg: float, net_flow: float) -> str:
    """Classify an ETF into one of four price-flow behavior quadrants."""
    if pct_chg >= 0 and net_flow >= 0:
        return "主线共振"
    if pct_chg >= 0 and net_flow < 0:
        return "逢高兑现"
    if pct_chg < 0 and net_flow >= 0:
        return "逆势抄底"
    return "资金撤离"


def _judge_core_stance(
    market: str,
    period: str,
    bench_pct: float,
    core_flow: float,
) -> tuple[str, str]:
    """Determine institutional / national-team posture based on benchmark move and core broad inflow."""
    if market == "CN":
        thresholds = {"1d": 15.0, "5d": 40.0, "20d": 80.0, "60d": 150.0}
    else:
        thresholds = {"1d": 1000.0, "5d": 3000.0, "20d": 6000.0, "60d": 12000.0}
    th = thresholds.get(period, 40.0)

    if bench_pct < -0.3 and core_flow > th:
        return ("逆势护盘 / 逢低吸筹" if market == "CN" else "逢低配置 / 逆势吸筹", "bullish")
    if bench_pct >= 0.3 and core_flow > th:
        return ("增量共振 / 机构加仓", "bullish")
    if bench_pct >= 0.3 and core_flow < -th:
        return ("逢高兑现 / 压制降温", "caution")
    if bench_pct < -0.3 and core_flow < -th:
        return ("存量流出 / 弱势观望", "bearish")
    if core_flow > 0:
        return ("温和净流入 / 震荡承接", "neutral_pos")
    return ("小幅净流出 / 存量博弈", "neutral_neg")


def get_dashboard_data(market: str = "CN", period: str = "5d") -> dict[str, Any]:
    """Build complete structured analytics payload for a market and period."""
    market = market.upper()
    if market not in ("CN", "US"):
        market = "CN"
    if period not in PERIOD_DAYS_MAP:
        period = "5d"

    n_days = PERIOD_DAYS_MAP[period]
    universe = load_universe()
    m_cfg = universe[market]
    unit = m_cfg["flow_unit"]
    currency = m_cfg["currency"]

    flow_dates = _get_flow_dates(market, n_days)
    series_dates = _get_flow_dates(market, 60)

    with get_conn() as conn:
        latest_price_row = conn.execute(
            "SELECT MAX(trade_date) AS d FROM index_daily WHERE market = ?", (market,)
        ).fetchone()
        latest_price_date = latest_price_row["d"] if latest_price_row and latest_price_row["d"] else ""

        meta_rows = conn.execute(
            "SELECT * FROM etf_meta WHERE market = ? ORDER BY category, cluster_id, latest_aum DESC",
            (market,),
        ).fetchall()
        metas = [dict(r) for r in meta_rows]

        # Build benchmark index summaries over [flow_start, flow_end] and latest price date
        index_summaries: list[dict[str, Any]] = []
        flow_start = flow_dates[0] if flow_dates else ""
        flow_end = flow_dates[-1] if flow_dates else latest_price_date

        for idx_cfg in m_cfg["indices"]:
            idx_code = idx_cfg["code"]
            latest_bar = conn.execute(
                """
                SELECT trade_date, close, pct_chg
                FROM index_daily
                WHERE market = ? AND code = ?
                ORDER BY trade_date DESC LIMIT 1
                """,
                (market, idx_code),
            ).fetchone()

            if flow_start and flow_end:
                window_bars = conn.execute(
                    """
                    SELECT trade_date, close, high, low, pct_chg
                    FROM index_daily
                    WHERE market = ? AND code = ? AND trade_date >= ? AND trade_date <= ?
                    ORDER BY trade_date ASC
                    """,
                    (market, idx_code, flow_start, flow_end),
                ).fetchall()
            else:
                window_bars = []

            period_pct = (
                _compound_return([float(b["pct_chg"] or 0.0) for b in window_bars])
                if window_bars
                else 0.0
            )
            period_close = float(window_bars[-1]["close"]) if window_bars else (
                float(latest_bar["close"]) if latest_bar else 0.0
            )
            period_high = max((float(b["high"]) for b in window_bars), default=period_close)
            period_low = min((float(b["low"]) for b in window_bars), default=period_close)

            index_summaries.append(
                {
                    "code": idx_code,
                    "name": idx_cfg["name"],
                    "is_primary": bool(idx_cfg.get("is_primary")),
                    "latest_date": latest_bar["trade_date"] if latest_bar else "",
                    "latest_close": round(float(latest_bar["close"]), 2) if latest_bar else 0.0,
                    "latest_pct_chg": round(float(latest_bar["pct_chg"] or 0.0), 2) if latest_bar else 0.0,
                    "period_close": round(period_close, 2),
                    "period_pct_chg": period_pct,
                    "period_high": round(period_high, 2),
                    "period_low": round(period_low, 2),
                }
            )

        # Aggregate ETF flows & price returns over flow_dates
        etf_items: list[dict[str, Any]] = []
        if flow_start and flow_end:
            daily_rows = conn.execute(
                """
                SELECT code, trade_date, close, pct_chg, amount, nav, shares, share_chg, net_flow, aum
                FROM etf_daily
                WHERE market = ? AND trade_date >= ? AND trade_date <= ?
                ORDER BY code, trade_date ASC
                """,
                (market, flow_start, flow_end),
            ).fetchall()
        else:
            daily_rows = []

        by_code: dict[str, list[dict[str, Any]]] = {}
        for r in daily_rows:
            by_code.setdefault(r["code"], []).append(dict(r))

        # Fetch latest closing prices (even if shares for latest_price_date aren't published yet)
        latest_etf_rows = conn.execute(
            """
            SELECT e1.code, e1.trade_date, e1.close, e1.pct_chg
            FROM etf_daily e1
            INNER JOIN (
                SELECT code, MAX(trade_date) AS max_d
                FROM etf_daily
                WHERE market = ? AND close IS NOT NULL
                GROUP BY code
            ) e2 ON e1.code = e2.code AND e1.trade_date = e2.max_d
            WHERE e1.market = ?
            """,
            (market, market),
        ).fetchall()
        latest_etf_map = {r["code"]: dict(r) for r in latest_etf_rows}

        for m in metas:
            code = m["code"]
            rows = by_code.get(code, [])
            valid_flows = [float(r["net_flow"]) for r in rows if r["net_flow"] is not None]
            valid_pcts = [float(r["pct_chg"]) for r in rows if r["pct_chg"] is not None]
            valid_sh_chg = [float(r["share_chg"]) for r in rows if r["share_chg"] is not None]

            total_flow = round(sum(valid_flows), 2)
            period_pct = _compound_return(valid_pcts) if valid_pcts else 0.0
            total_sh_chg = round(sum(valid_sh_chg), 2)

            latest_aum = float(m["latest_aum"] or 0.0)
            if latest_aum <= 0:
                aums = [float(r["aum"]) for r in rows if r["aum"] is not None and r["aum"] > 0]
                if aums:
                    latest_aum = aums[-1]

            flow_pct_aum = round((total_flow / latest_aum * 100.0), 2) if latest_aum > 0 else 0.0
            latest_px = latest_etf_map.get(code, {})
            period_close = (
                float(rows[-1]["close"])
                if rows and rows[-1]["close"] is not None
                else float(latest_px.get("close") or 0.0)
            )
            avg_daily_amount = (
                round(sum(float(r["amount"] or 0.0) for r in rows) / len(rows) / 1e8, 2)
                if market == "CN" and rows
                else (
                    round(sum(float(r["amount"] or 0.0) for r in rows) / len(rows) / 1e6, 2)
                    if rows
                    else 0.0
                )
            )

            etf_items.append(
                {
                    "code": code,
                    "name": m["name"],
                    "sector_name": (m.get("sector_name") or "").strip() or m["name"],
                    "exchange": m["exchange"],
                    "category": m["category"],
                    "cluster_id": m["cluster_id"],
                    "cluster_name": m["cluster_name"],
                    "style": m["style"],
                    "national_team_core": bool(m["national_team_core"]),
                    "latest_aum": round(latest_aum, 2),
                    "latest_close": round(float(latest_px.get("close") or period_close), 3),
                    "latest_pct_chg": round(float(latest_px.get("pct_chg") or 0.0), 2),
                    "period_close": round(period_close, 3),
                    "period_pct_chg": period_pct,
                    "net_flow": total_flow,
                    "share_chg": total_sh_chg,
                    "flow_pct_aum": flow_pct_aum,
                    "avg_daily_amount": avg_daily_amount,
                    "quadrant": _classify_quadrant(period_pct, total_flow),
                    "valid_flow_days": len(valid_flows),
                }
            )

        # Build 60-day time series: index point vs broad/core/sector daily net flows
        ts_start = series_dates[0] if series_dates else ""
        ts_end = series_dates[-1] if series_dates else ""
        primary_bench_code = "000300" if market == "CN" else "^GSPC"
        alt_bench_code = "000001" if market == "CN" else "^IXIC"

        ts_rows = []
        if ts_start and ts_end:
            bench_rows = conn.execute(
                """
                SELECT code, trade_date, close, pct_chg
                FROM index_daily
                WHERE market = ? AND code IN (?, ?) AND trade_date >= ? AND trade_date <= ?
                ORDER BY trade_date ASC
                """,
                (market, primary_bench_code, alt_bench_code, ts_start, ts_end),
            ).fetchall()
            bench_map: dict[str, dict[str, dict[str, float]]] = {}
            for b in bench_rows:
                bench_map.setdefault(b["trade_date"], {})[b["code"]] = {
                    "close": float(b["close"]),
                    "pct_chg": float(b["pct_chg"] or 0.0),
                }

            flow_agg_rows = conn.execute(
                """
                SELECT d.trade_date, m.category, m.national_team_core, SUM(d.net_flow) AS sum_flow
                FROM etf_daily d
                JOIN etf_meta m ON d.market = m.market AND d.code = m.code
                WHERE d.market = ? AND d.net_flow IS NOT NULL
                  AND d.trade_date >= ? AND d.trade_date <= ?
                GROUP BY d.trade_date, m.category, m.national_team_core
                ORDER BY d.trade_date ASC
                """,
                (market, ts_start, ts_end),
            ).fetchall()

            agg_by_date: dict[str, dict[str, float]] = {}
            for r in flow_agg_rows:
                d_entry = agg_by_date.setdefault(
                    r["trade_date"],
                    {"broad": 0.0, "core": 0.0, "market_broad": 0.0, "sector": 0.0},
                )
                val = float(r["sum_flow"] or 0.0)
                if r["category"] == "broad":
                    d_entry["broad"] += val
                    if r["national_team_core"]:
                        d_entry["core"] += val
                    else:
                        d_entry["market_broad"] += val
                elif r["category"] in ("sector", "theme"):
                    d_entry["sector"] += val

            for d in series_dates:
                b_info = bench_map.get(d, {})
                p_info = b_info.get(primary_bench_code, {})
                a_info = b_info.get(alt_bench_code, {})
                f_info = agg_by_date.get(
                    d, {"broad": 0.0, "core": 0.0, "market_broad": 0.0, "sector": 0.0}
                )
                ts_rows.append(
                    {
                        "trade_date": d,
                        "bench_close": round(p_info.get("close", 0.0), 2),
                        "bench_pct": round(p_info.get("pct_chg", 0.0), 2),
                        "alt_close": round(a_info.get("close", 0.0), 2),
                        "alt_pct": round(a_info.get("pct_chg", 0.0), 2),
                        "broad_flow": round(f_info["broad"], 2),
                        "core_flow": round(f_info["core"], 2),
                        "market_broad_flow": round(f_info["market_broad"], 2),
                        "sector_flow": round(f_info["sector"], 2),
                        "in_selected_period": d in set(flow_dates),
                    }
                )

    # Cluster aggregation for broad ETFs
    broad_items = [e for e in etf_items if e["category"] == "broad"]
    sector_items = [e for e in etf_items if e["category"] in ("sector", "theme")]
    macro_items = [e for e in etf_items if e["category"] == "macro"]

    cluster_map: dict[str, dict[str, Any]] = {}
    for e in broad_items:
        cid = e["cluster_id"]
        c = cluster_map.setdefault(
            cid,
            {
                "cluster_id": cid,
                "cluster_name": e["cluster_name"],
                "style": e["style"],
                "national_team_core": e["national_team_core"],
                "net_flow": 0.0,
                "total_aum": 0.0,
                "weighted_pct_sum": 0.0,
                "etf_count": 0,
                "members": [],
            },
        )
        c["net_flow"] += e["net_flow"]
        c["total_aum"] += e["latest_aum"]
        c["weighted_pct_sum"] += e["period_pct_chg"] * (e["latest_aum"] if e["latest_aum"] > 0 else 1.0)
        c["etf_count"] += 1
        c["members"].append(e["code"])

    broad_clusters: list[dict[str, Any]] = []
    for c in cluster_map.values():
        denom = c["total_aum"] if c["total_aum"] > 0 else max(c["etf_count"], 1)
        avg_pct = round(c["weighted_pct_sum"] / denom, 2)
        flow_pct = round(c["net_flow"] / c["total_aum"] * 100.0, 2) if c["total_aum"] > 0 else 0.0
        broad_clusters.append(
            {
                "cluster_id": c["cluster_id"],
                "cluster_name": c["cluster_name"],
                "style": c["style"],
                "national_team_core": c["national_team_core"],
                "net_flow": round(c["net_flow"], 2),
                "total_aum": round(c["total_aum"], 2),
                "flow_pct_aum": flow_pct,
                "avg_pct_chg": avg_pct,
                "etf_count": c["etf_count"],
                "members": c["members"],
            }
        )
    broad_clusters.sort(key=lambda x: x["net_flow"], reverse=True)

    # Totals & style spread
    total_broad_flow = round(sum(e["net_flow"] for e in broad_items), 2)
    total_core_flow = round(sum(e["net_flow"] for e in broad_items if e["national_team_core"]), 2)
    total_market_broad_flow = round(total_broad_flow - total_core_flow, 2)
    total_sector_flow = round(sum(e["net_flow"] for e in sector_items), 2)
    total_macro_flow = round(sum(e["net_flow"] for e in macro_items), 2)

    large_flow = round(
        sum(e["net_flow"] for e in broad_items if e["style"] in ("large_core", "large_value")),
        2,
    )
    small_growth_flow = round(
        sum(
            e["net_flow"]
            for e in broad_items
            if e["style"] in ("mid_small", "micro_small", "growth")
        ),
        2,
    )

    # Compute weighted benchmark point anchor for positive core-flow days in selected window
    selected_ts = [t for t in ts_rows if t["in_selected_period"]]
    pos_core_days = [t for t in selected_ts if t["core_flow"] > 0 and t["bench_close"] > 0]
    weighted_anchor_point: float | None = None
    weighted_alt_point: float | None = None
    if pos_core_days:
        w_sum = sum(t["core_flow"] for t in pos_core_days)
        if w_sum > 0:
            weighted_anchor_point = round(
                sum(t["core_flow"] * t["bench_close"] for t in pos_core_days) / w_sum, 2
            )
            if pos_core_days[0]["alt_close"] > 0:
                weighted_alt_point = round(
                    sum(t["core_flow"] * t["alt_close"] for t in pos_core_days) / w_sum, 2
                )

    primary_idx = next((x for x in index_summaries if x["code"] == primary_bench_code), None)
    alt_idx = next((x for x in index_summaries if x["code"] == alt_bench_code), None)
    bench_pct = primary_idx["period_pct_chg"] if primary_idx else 0.0
    stance_label, stance_tone = _judge_core_stance(market, period, bench_pct, total_core_flow)

    # Style preference verdict (concise for KPI card + full for narrative)
    style_diff = round(large_flow - small_growth_flow, 2)
    if large_flow > 0 and small_growth_flow > 0:
        bias = "大盘占优" if style_diff > 0 else "中小成长占优"
        style_short = f"剪刀差 {style_diff:+.1f}{unit} · 大小盘同流入，{bias}"
        style_summary = f"大小盘宽基同步净流入，剪刀差 {style_diff:+.2f}{unit}，{bias}"
    elif large_flow < 0 and small_growth_flow < 0:
        bias = "大盘抗跌流出少" if style_diff > 0 else "中小流出相对少"
        style_short = f"剪刀差 {style_diff:+.1f}{unit} · 大小盘同步净流出"
        style_summary = f"大小盘宽基同步净流出，剪刀差 {style_diff:+.2f}{unit}（{bias}），风险偏好偏谨慎"
    elif style_diff > 0:
        style_short = f"剪刀差 {style_diff:+.1f}{unit} · 偏向大盘蓝筹护盘"
        style_summary = f"剪刀差达 {style_diff:+.2f}{unit}，资金显著流向大盘蓝筹防御配置、撤出中小成长"
    else:
        style_short = f"剪刀差 {style_diff:+.1f}{unit} · 偏向中小成长进攻"
        style_summary = f"剪刀差为 {style_diff:+.2f}{unit}，资金偏向中小盘及双创成长进攻、兑现大盘权重"

    # Aggregate sector/theme ETFs by sector_name (board level) and by cluster_id (macro track level)
    sec_grp_map: dict[str, dict[str, Any]] = {}
    for s in sector_items:
        sname = s["sector_name"]
        g = sec_grp_map.setdefault(
            sname,
            {
                "name": sname,
                "code": s["code"],
                "category": s["category"],
                "cluster_id": s["cluster_id"],
                "cluster_name": s["cluster_name"],
                "net_flow": 0.0,
                "latest_aum": 0.0,
                "weighted_pct_sum": 0.0,
                "etf_count": 0,
                "members": [],
                "member_names": [],
            },
        )
        if s["latest_aum"] > g.get("_max_aum", -1.0):
            g["_max_aum"] = s["latest_aum"]
            g["code"] = s["code"]
        g["net_flow"] += s["net_flow"]
        g["latest_aum"] += s["latest_aum"]
        g["weighted_pct_sum"] += s["period_pct_chg"] * (s["latest_aum"] if s["latest_aum"] > 0 else 1.0)
        g["etf_count"] += 1
        g["members"].append(s["code"])
        g["member_names"].append(s["name"])

    sector_groups: list[dict[str, Any]] = []
    for g in sec_grp_map.values():
        denom = g["latest_aum"] if g["latest_aum"] > 0 else max(g["etf_count"], 1)
        avg_pct = round(g["weighted_pct_sum"] / denom, 2)
        flow_pct = round(g["net_flow"] / g["latest_aum"] * 100.0, 2) if g["latest_aum"] > 0 else 0.0
        net_f = round(g["net_flow"], 2)
        sector_groups.append(
            {
                "code": g["code"],
                "name": g["name"],
                "category": g["category"],
                "cluster_id": g["cluster_id"],
                "cluster_name": g["cluster_name"],
                "net_flow": net_f,
                "latest_aum": round(g["latest_aum"], 2),
                "flow_pct_aum": flow_pct,
                "period_pct_chg": avg_pct,
                "quadrant": _classify_quadrant(avg_pct, net_f),
                "etf_count": g["etf_count"],
                "members": g["members"],
                "member_names": g["member_names"],
            }
        )
    sector_groups.sort(key=lambda x: x["net_flow"], reverse=True)

    sec_cls_map: dict[str, dict[str, Any]] = {}
    for s in sector_items:
        cid = s["cluster_id"]
        c = sec_cls_map.setdefault(
            cid,
            {
                "code": s["code"],
                "name": s["cluster_name"],
                "category": "sector",
                "cluster_id": cid,
                "cluster_name": s["cluster_name"],
                "net_flow": 0.0,
                "latest_aum": 0.0,
                "weighted_pct_sum": 0.0,
                "etf_count": 0,
                "members": [],
                "member_names": [],
            },
        )
        c["net_flow"] += s["net_flow"]
        c["latest_aum"] += s["latest_aum"]
        c["weighted_pct_sum"] += s["period_pct_chg"] * (s["latest_aum"] if s["latest_aum"] > 0 else 1.0)
        c["etf_count"] += 1
        c["members"].append(s["code"])
        c["member_names"].append(s["name"])

    sector_clusters: list[dict[str, Any]] = []
    for c in sec_cls_map.values():
        denom = c["latest_aum"] if c["latest_aum"] > 0 else max(c["etf_count"], 1)
        avg_pct = round(c["weighted_pct_sum"] / denom, 2)
        flow_pct = round(c["net_flow"] / c["latest_aum"] * 100.0, 2) if c["latest_aum"] > 0 else 0.0
        net_f = round(c["net_flow"], 2)
        sector_clusters.append(
            {
                "code": c["code"],
                "name": c["name"],
                "category": "sector",
                "cluster_id": c["cluster_id"],
                "cluster_name": c["cluster_name"],
                "net_flow": net_f,
                "latest_aum": round(c["latest_aum"], 2),
                "flow_pct_aum": flow_pct,
                "period_pct_chg": avg_pct,
                "quadrant": _classify_quadrant(avg_pct, net_f),
                "etf_count": c["etf_count"],
                "members": c["members"],
                "member_names": c["member_names"],
            }
        )
    sector_clusters.sort(key=lambda x: x["net_flow"], reverse=True)

    # Sector rankings & quadrant breakdown (based on deduplicated sector_groups)
    sector_sorted = sorted(sector_items, key=lambda x: x["net_flow"], reverse=True)
    top_inflows = sector_groups[:5]
    top_outflows = sorted(sector_groups, key=lambda x: x["net_flow"])[:5]

    quadrants: dict[str, list[dict[str, Any]]] = {
        "主线共振": [],
        "逢高兑现": [],
        "逆势抄底": [],
        "资金撤离": [],
    }
    for s in sector_groups:
        quadrants[s["quadrant"]].append(s)

    sector_in_count = sum(1 for g in sector_groups if g["net_flow"] > 0)
    sector_total_count = len(sector_groups)

    # Build structured narrative commentary
    insights = _build_narrative_insights(
        market=market,
        unit=unit,
        period=period,
        flow_start=flow_start,
        flow_end=flow_end,
        primary_idx=primary_idx,
        alt_idx=alt_idx,
        total_broad_flow=total_broad_flow,
        total_core_flow=total_core_flow,
        total_market_broad_flow=total_market_broad_flow,
        total_sector_flow=total_sector_flow,
        total_macro_flow=total_macro_flow,
        stance_label=stance_label,
        weighted_anchor_point=weighted_anchor_point,
        weighted_alt_point=weighted_alt_point,
        large_flow=large_flow,
        small_growth_flow=small_growth_flow,
        style_summary=style_summary,
        broad_clusters=broad_clusters,
        top_inflows=top_inflows,
        top_outflows=top_outflows,
        quadrants=quadrants,
    )

    return {
        "market": market,
        "currency": currency,
        "unit": unit,
        "period": period,
        "period_label": PERIOD_LABELS[period],
        "flow_start_date": flow_start,
        "flow_end_date": flow_end,
        "latest_price_date": latest_price_date,
        "sync_info": get_latest_sync(market),
        "indices": index_summaries,
        "summary": {
            "total_broad_flow": total_broad_flow,
            "total_core_flow": total_core_flow,
            "total_market_broad_flow": total_market_broad_flow,
            "total_sector_flow": total_sector_flow,
            "total_macro_flow": total_macro_flow,
            "sector_in_count": sector_in_count,
            "sector_total_count": sector_total_count,
            "large_flow": large_flow,
            "small_growth_flow": small_growth_flow,
            "style_diff": style_diff,
            "style_short": style_short,
            "stance_label": stance_label,
            "stance_tone": stance_tone,
            "weighted_anchor_point": weighted_anchor_point,
            "weighted_alt_point": weighted_alt_point,
            "style_summary": style_summary,
        },
        "insights": insights,
        "time_series": ts_rows,
        "broad_clusters": broad_clusters,
        "sector_groups": sector_groups,
        "sector_clusters": sector_clusters,
        "sector_rankings": sector_sorted,
        "top_inflows": top_inflows,
        "top_outflows": top_outflows,
        "quadrants": {
            k: [{"code": i["code"], "name": i["name"], "net_flow": i["net_flow"], "period_pct_chg": i["period_pct_chg"]} for i in v]
            for k, v in quadrants.items()
        },
        "etfs": etf_items,
    }


def _build_narrative_insights(
    market: str,
    unit: str,
    period: str,
    flow_start: str,
    flow_end: str,
    primary_idx: dict[str, Any] | None,
    alt_idx: dict[str, Any] | None,
    total_broad_flow: float,
    total_core_flow: float,
    total_market_broad_flow: float,
    total_sector_flow: float,
    total_macro_flow: float,
    stance_label: str,
    weighted_anchor_point: float | None,
    weighted_alt_point: float | None,
    large_flow: float,
    small_growth_flow: float,
    style_summary: str,
    broad_clusters: list[dict[str, Any]],
    top_inflows: list[dict[str, Any]],
    top_outflows: list[dict[str, Any]],
    quadrants: dict[str, list[dict[str, Any]]],
) -> list[dict[str, str]]:
    """Generate concise structured market analysis bullet blocks."""
    idx_desc = ""
    if primary_idx:
        idx_desc += (
            f"{primary_idx['name']}收报 **{primary_idx['period_close']}**（区间 **{primary_idx['period_pct_chg']:+.2f}%**，"
            f"波动区间 {primary_idx['period_low']}~{primary_idx['period_high']}）"
        )
    if alt_idx:
        idx_desc += (
            f"；{alt_idx['name']}收报 **{alt_idx['period_close']}**（**{alt_idx['period_pct_chg']:+.2f}%**）"
        )

    core_role = "汪汪队代理宽基（沪深300/上证50）" if market == "CN" else "标普500核心配置盘（SPY/VOO/IVV）"
    anchor_text = ""
    if weighted_anchor_point is not None:
        anchor_name = "沪深300" if market == "CN" else "标普500"
        anchor_text = f" 正流入交易日对应的{anchor_name}加权点位锚约为 **{weighted_anchor_point}**"
        if weighted_alt_point is not None and market == "CN":
            anchor_text += f"（对应上证指数约 **{weighted_alt_point}**）"
        anchor_text += "。"

    top_cluster = broad_clusters[0] if broad_clusters else None
    bot_cluster = broad_clusters[-1] if broad_clusters else None
    cluster_text = ""
    if top_cluster and bot_cluster:
        if top_cluster["net_flow"] <= 0:
            cluster_text = (
                f"各宽基簇全线净流出，其中流出最少的是 **{top_cluster['cluster_name']}**（{top_cluster['net_flow']:+.2f}{unit}，"
                f"占规模 {top_cluster['flow_pct_aum']:+.2f}%），流出最多/承压居首的是 **{bot_cluster['cluster_name']}**（{bot_cluster['net_flow']:+.2f}{unit}）。"
            )
        elif bot_cluster["net_flow"] >= 0:
            cluster_text = (
                f"各宽基簇全线净流入，其中吸金居首的是 **{top_cluster['cluster_name']}**（{top_cluster['net_flow']:+.2f}{unit}，"
                f"占规模 {top_cluster['flow_pct_aum']:+.2f}%），流入相对较少的是 **{bot_cluster['cluster_name']}**（{bot_cluster['net_flow']:+.2f}{unit}）。"
            )
        else:
            cluster_text = (
                f"宽基簇中，吸金居首的是 **{top_cluster['cluster_name']}**（{top_cluster['net_flow']:+.2f}{unit}，"
                f"占规模 {top_cluster['flow_pct_aum']:+.2f}%）；流出/承压居前的是 **{bot_cluster['cluster_name']}**（{bot_cluster['net_flow']:+.2f}{unit}）。"
            )

    in_str = "、".join(
        f"{x['name']}({x['net_flow']:+.2f}{unit}, {x['period_pct_chg']:+.2f}%)"
        for x in top_inflows[:3]
    )
    out_str = "、".join(
        f"{x['name']}({x['net_flow']:+.2f}{unit}, {x['period_pct_chg']:+.2f}%)"
        for x in top_outflows[:3]
    )

    res_names = "、".join(x["name"] for x in quadrants["主线共振"][:4]) or "暂无明显标的"
    dip_names = "、".join(x["name"] for x in quadrants["逆势抄底"][:4]) or "暂无明显标的"
    tp_names = "、".join(x["name"] for x in quadrants["逢高兑现"][:4]) or "暂无明显标的"

    mkt_broad_role = "市场化宽基（A500/500/1000/双创/2000/深100/A50）" if market == "CN" else "成长与中小盘宽基（QQQ/IWM/DIA）"
    return [
        {
            "title": f"大盘点位与周期背景（{flow_start} ~ {flow_end}）",
            "body": (
                f"{idx_desc}。汪汪队宽基（300/50）净流向 **{total_core_flow:+.2f}{unit}**，"
                f"{mkt_broad_role}净流向 **{total_market_broad_flow:+.2f}{unit}**，"
                f"全市场行业/题材板块合计 **{total_sector_flow:+.2f}{unit}**（宏观/避险锚 **{total_macro_flow:+.2f}{unit}**）。"
            ),
        },
        {
            "title": f"汪汪队与宽基阵营：{stance_label}" if market == "CN" else f"主力核心配置动向：{stance_label}",
            "body": f"{core_role}累计净流向 **{total_core_flow:+.2f}{unit}**，综合定性为「{stance_label}」。{anchor_text} {cluster_text}",
        },
        {
            "title": "大小盘风格剪刀差",
            "body": f"大盘权重宽基 **{large_flow:+.2f}{unit}** vs 中小成长宽基 **{small_growth_flow:+.2f}{unit}**；{style_summary}。",
        },
        {
            "title": "全市场行业与题材板块轮动（四象限）",
            "body": (
                f"吸金前三板块：{in_str or '无'}；撤离前三板块：{out_str or '无'}。"
                f"其中「主线共振（价涨流入）」：{res_names}；"
                f"「逆势抄底（价跌流入）」：{dip_names}；"
                f"「逢高兑现（价涨流出）」：{tp_names}。"
            ),
        },
    ]


def get_etf_detail_history(market: str, code: str, limit: int = 90) -> dict[str, Any] | None:
    """Return metadata and daily historical series for a single ETF."""
    market = market.upper()
    with get_conn() as conn:
        meta = conn.execute(
            "SELECT * FROM etf_meta WHERE market = ? AND code = ?",
            (market, code),
        ).fetchone()
        if not meta:
            return None
        rows = conn.execute(
            """
            SELECT trade_date, close, pct_chg, volume, amount, nav, shares, share_chg, net_flow, aum
            FROM etf_daily
            WHERE market = ? AND code = ?
            ORDER BY trade_date DESC
            LIMIT ?
            """,
            (market, code, limit),
        ).fetchall()
    history = [dict(r) for r in reversed(rows)]
    return {"meta": dict(meta), "history": history}


def generate_markdown_report(output_path: Path | None = None) -> Path:
    """Generate a comprehensive multi-market, multi-period Markdown analysis report."""
    if output_path is None:
        output_path = BASE_DIR / "docs" / "reports" / "latest_analysis_report.md"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    now_str = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines: list[str] = [
        "# Rooftop ETF Flow（天台ETF资金流）自动复盘分析报告",
        "",
        f"> 生成时间：{now_str} | 数据口径：交易所官方份额变动 / ETFdb 一级市场净申赎",
        "",
    ]

    for market, m_title in (("CN", "一、 A股市场 ETF 资金流复盘"), ("US", "二、 美股市场 ETF 资金流复盘")):
        lines.append(f"## {m_title}")
        lines.append("")
        d_1d = get_dashboard_data(market, "1d")
        d_5d = get_dashboard_data(market, "5d")
        d_20d = get_dashboard_data(market, "20d")
        unit = d_5d["unit"]

        lines.append(
            f"- **行情最新日期**：{d_5d['latest_price_date']} | **资金流最新有效结算日**：{d_5d['flow_end_date']}"
        )
        lines.append("")
        lines.append("### 1. 指数点位与多周期资金流总览")
        lines.append("")
        lines.append(
            "| 统计周期 | 区间日期 | 宽基总净流入 | 核心护盘/配置净流入 | 行业题材总净流入 | 资金姿态定性 |"
        )
        lines.append("| :--- | :--- | ---: | ---: | ---: | :--- |")
        for d in (d_1d, d_5d, d_20d):
            s = d["summary"]
            lines.append(
                f"| {d['period_label']} | {d['flow_start_date']} ~ {d['flow_end_date']} | "
                f"{s['total_broad_flow']:+.2f} {unit} | {s['total_core_flow']:+.2f} {unit} | "
                f"{s['total_sector_flow']:+.2f} {unit} | {s['stance_label']} |"
            )
        lines.append("")

        lines.append("### 2. 近一周 (5D) 大盘基准点位表现")
        lines.append("")
        lines.append("| 指数名称 | 最新收盘点位 | 最新日涨跌 | 5D区间收盘 | 5D区间涨跌 | 5D波动区间 |")
        lines.append("| :--- | ---: | ---: | ---: | ---: | :--- |")
        for idx in d_5d["indices"]:
            lines.append(
                f"| {idx['name']} (`{idx['code']}`) | {idx['latest_close']} | {idx['latest_pct_chg']:+.2f}% | "
                f"{idx['period_close']} | {idx['period_pct_chg']:+.2f}% | {idx['period_low']} ~ {idx['period_high']} |"
            )
        lines.append("")

        lines.append("### 3. 核心结论提炼（基于近一周 5D & 近一月 20D 共振分析）")
        lines.append("")
        for ins in d_5d["insights"]:
            lines.append(f"- **{ins['title']}**：{ins['body']}")
        lines.append(
            f"- **月度趋势参照 (20D)**：近20个交易日宽基总净流入 **{d_20d['summary']['total_broad_flow']:+.2f}{unit}**，"
            f"核心护盘/配置簇净流向 **{d_20d['summary']['total_core_flow']:+.2f}{unit}**（定性：{d_20d['summary']['stance_label']}）。"
        )
        lines.append("")

        lines.append("### 4. 宽基 ETF 簇流向明细（近一周 5D vs 近一月 20D）")
        lines.append("")
        c20_map = {c["cluster_id"]: c for c in d_20d["broad_clusters"]}
        lines.append(
            f"| 宽基簇名称 | 总规模({unit}) | 5D净流入({unit}) | 5D占规模比 | 5D加权涨跌 | 20D净流入({unit}) | 代表标的 |"
        )
        lines.append("| :--- | ---: | ---: | ---: | ---: | ---: | :--- |")
        for c in d_5d["broad_clusters"]:
            c20 = c20_map.get(c["cluster_id"], {})
            lines.append(
                f"| {c['cluster_name']} | {c['total_aum']:.2f} | {c['net_flow']:+.2f} | "
                f"{c['flow_pct_aum']:+.2f}% | {c['avg_pct_chg']:+.2f}% | "
                f"{c20.get('net_flow', 0.0):+.2f} | {', '.join(c['members'])} |"
            )
        lines.append("")

        lines.append("### 5. 行业与题材 ETF 流向排行（近一周 5D）")
        lines.append("")
        lines.append(
            f"| 方向 | 代码 | ETF名称 | 最新规模({unit}) | 5D净流入({unit}) | 占规模比 | 5D涨跌 | 四象限分类 |"
        )
        lines.append("| :--- | :--- | :--- | ---: | ---: | ---: | ---: | :--- |")
        for item in d_5d["top_inflows"]:
            lines.append(
                f"| 流入Top | `{item['code']}` | {item['name']} | {item['latest_aum']:.2f} | "
                f"{item['net_flow']:+.2f} | {item['flow_pct_aum']:+.2f}% | {item['period_pct_chg']:+.2f}% | {item['quadrant']} |"
            )
        for item in d_5d["top_outflows"]:
            lines.append(
                f"| 流出Top | `{item['code']}` | {item['name']} | {item['latest_aum']:.2f} | "
                f"{item['net_flow']:+.2f} | {item['flow_pct_aum']:+.2f}% | {item['period_pct_chg']:+.2f}% | {item['quadrant']} |"
            )
        lines.append("")

    content = "\n".join(lines)
    with output_path.open("w", encoding="utf-8") as f:
        f.write(content)
    return output_path
