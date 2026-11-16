"""CLI entrypoint to sync CN and US ETF flows and generate the latest Markdown report."""

from __future__ import annotations

import argparse
import sys

from backend.analyzer import generate_markdown_report, get_dashboard_data
from backend.db import get_conn, init_db
from backend.fetcher_cn import sync_cn_data
from backend.fetcher_us import sync_us_data


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync Rooftop ETF Flow data and generate report.")
    parser.add_argument("--market", choices=["CN", "US", "ALL"], default="ALL")
    parser.add_argument("--days", type=int, default=85, help="Lookback trading days to fetch.")
    args = parser.parse_args()

    init_db()

    if args.market in ("CN", "ALL"):
        print("[1/3] Syncing CN (A-share) indices, prices, NAVs, and official shares...")
        res_cn = sync_cn_data(lookback_days=args.days)
        print("      Result:", res_cn)

    if args.market in ("US", "ALL"):
        print("[2/3] Syncing US indices, prices, and ETFdb fund flows...")
        res_us = sync_us_data(lookback_days=args.days)
        print("      Result:", res_us)

    print("[3/3] Generating structured Markdown analysis report...")
    report_path = generate_markdown_report()
    print(f"      Saved report to: {report_path}")

    with get_conn() as conn:
        for m in ("CN", "US"):
            cnt_etf = conn.execute(
                "SELECT COUNT(*) AS c FROM etf_daily WHERE market = ? AND net_flow IS NOT NULL",
                (m,),
            ).fetchone()["c"]
            cnt_idx = conn.execute(
                "SELECT COUNT(*) AS c FROM index_daily WHERE market = ?", (m,)
            ).fetchone()["c"]
            print(f"      DB stats [{m}]: valid net_flow rows={cnt_etf}, index rows={cnt_idx}")

    for m in ("CN", "US"):
        dash = get_dashboard_data(m, "5d")
        s = dash["summary"]
        print(
            f"      Preview [{m} 5D {dash['flow_start_date']}~{dash['flow_end_date']}]: "
            f"broad={s['total_broad_flow']:+.2f}{dash['unit']}, "
            f"core={s['total_core_flow']:+.2f}{dash['unit']} ({s['stance_label']}), "
            f"sector={s['total_sector_flow']:+.2f}{dash['unit']}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
