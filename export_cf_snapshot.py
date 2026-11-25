"""Export SQLite post-market dashboard analytics, ETF histories, and report to Cloudflare KV bulk JSON."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path
from typing import Any

import requests

from backend.analyzer import (
    generate_markdown_report,
    get_dashboard_data,
    get_etf_detail_history,
)
from backend.db import BASE_DIR, get_latest_sync, init_db, load_universe

REPORT_PATH = BASE_DIR / "docs" / "reports" / "latest_analysis_report.md"
OUT_PATH = BASE_DIR / "data" / "cf_kv_bulk.json"
FRONTEND_DIR = BASE_DIR / "frontend"


def build_kv_items(include_assets: bool = False) -> list[dict[str, str]]:
    """Build key-value pairs covering all post-market dashboard queries, details, report, and optional assets."""
    init_db()
    universe = load_universe()
    items: list[dict[str, str]] = []

    for market in ("CN", "US"):
        for period in ("1d", "5d", "20d", "60d"):
            payload = get_dashboard_data(market=market, period=period)
            items.append(
                {
                    "key": f"dash:{market}:{period}",
                    "value": json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                }
            )

        etf_details: dict[str, Any] = {}
        for item in universe.get(market, {}).get("etfs", []):
            code = str(item["code"]).upper()
            detail = get_etf_detail_history(market=market, code=code, limit=90)
            if detail:
                etf_details[code] = detail
        items.append(
            {
                "key": f"etfs:{market}",
                "value": json.dumps(etf_details, ensure_ascii=False, separators=(",", ":")),
            }
        )

    items.append(
        {
            "key": "universe",
            "value": json.dumps(universe, ensure_ascii=False, separators=(",", ":")),
        }
    )

    now_str = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cn_sync = get_latest_sync("CN")
    us_sync = get_latest_sync("US")
    sync_status = {
        "running": False,
        "last_trigger": "github_actions",
        "last_started_at": now_str,
        "last_finished_at": now_str,
        "last_error": "",
        "results": {
            "CN": cn_sync,
            "US": us_sync,
        },
        "CN": cn_sync,
        "US": us_sync,
    }
    items.append(
        {
            "key": "sync_status",
            "value": json.dumps(sync_status, ensure_ascii=False, separators=(",", ":")),
        }
    )

    if not REPORT_PATH.exists():
        generate_markdown_report(REPORT_PATH)
    report_text = REPORT_PATH.read_text(encoding="utf-8")
    items.append({"key": "report", "value": report_text})

    if include_assets and FRONTEND_DIR.exists():
        for filename in ("index.html", "styles.css", "app.js"):
            fpath = FRONTEND_DIR / filename
            if fpath.exists():
                items.append(
                    {
                        "key": f"asset:/{filename}",
                        "value": fpath.read_text(encoding="utf-8"),
                    }
                )

    return items


def upload_kv_bulk(items: list[dict[str, str]]) -> None:
    """Upload KV items to Cloudflare Workers KV via REST bulk endpoint."""
    token = os.getenv("CLOUDFLARE_API_TOKEN", "").strip()
    account_id = os.getenv("CLOUDFLARE_ACCOUNT_ID", "").strip()
    namespace_id = os.getenv("CLOUDFLARE_KV_NAMESPACE_ID", "").strip()
    if not token or not account_id or not namespace_id:
        raise RuntimeError(
            "Missing CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, or CLOUDFLARE_KV_NAMESPACE_ID"
        )

    url = (
        f"https://api.cloudflare.com/client/v4/accounts/{account_id}"
        f"/storage/kv/namespaces/{namespace_id}/bulk"
    )
    resp = requests.put(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json=items,
        timeout=60,
    )
    if not resp.ok:
        raise RuntimeError(f"Cloudflare KV bulk upload failed ({resp.status_code}): {resp.text[:500]}")
    body = resp.json()
    if not body.get("success"):
        raise RuntimeError(f"Cloudflare KV bulk upload error: {body}")
    print(f"Uploaded {len(items)} KV keys successfully to namespace {namespace_id}.")


def seed_via_worker(items: list[dict[str, str]], seed_url: str, admin_token: str) -> None:
    """Seed Cloudflare KV entries in small batches through the admin-protected Worker endpoint."""
    endpoint = seed_url.rstrip("/") + "/api/v1/etf-flow/admin/kv-seed"
    sess = requests.Session()
    sess.trust_env = False
    headers = {"Content-Type": "application/json"}
    if admin_token:
        headers["X-Admin-Token"] = admin_token

    total_written = 0
    for item in items:
        resp = sess.post(endpoint, headers=headers, json={"items": [item]}, timeout=30)
        if not resp.ok:
            raise RuntimeError(
                f"Worker kv-seed failed on key '{item['key']}' ({resp.status_code}): {resp.text[:300]}"
            )
        total_written += int(resp.json().get("written", 0))
    print(f"Seeded {total_written}/{len(items)} KV keys via Worker endpoint {endpoint}.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Export Rooftop ETF Flow snapshot for Cloudflare KV")
    parser.add_argument(
        "--include-assets",
        action="store_true",
        help="Include frontend HTML/CSS/JS fallback keys in KV bundle",
    )
    parser.add_argument(
        "--upload-kv",
        action="store_true",
        help="Upload exported KV items directly to Cloudflare Workers KV",
    )
    parser.add_argument(
        "--seed-url",
        default="",
        help="Worker base URL to push KV snapshot via /api/v1/etf-flow/admin/kv-seed",
    )
    parser.add_argument(
        "--admin-token",
        default="",
        help="Admin token (ROOFTOP_ADMIN_TOKEN) when seeding via Worker endpoint",
    )
    args = parser.parse_args()

    items = build_kv_items(include_assets=args.include_assets)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
    total_kb = OUT_PATH.stat().st_size / 1024.0
    print(f"Exported {len(items)} KV items ({total_kb:.1f} KB) to {OUT_PATH}")

    if args.upload_kv:
        upload_kv_bulk(items)
    if args.seed_url:
        token = args.admin_token or os.getenv("ROOFTOP_ADMIN_TOKEN", "").strip()
        seed_via_worker(items, args.seed_url, token)
    return 0


if __name__ == "__main__":
    sys.exit(main())
