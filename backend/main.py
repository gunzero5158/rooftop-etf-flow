"""FastAPI web server for Rooftop ETF Flow (天台ETF资金流)."""

from __future__ import annotations

import datetime as dt
import threading
import time
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend import __version__
from backend.analyzer import (
    generate_markdown_report,
    get_dashboard_data,
    get_etf_detail_history,
)
from backend.db import (
    BASE_DIR,
    get_latest_sync,
    init_db,
    load_universe,
    save_universe,
    sync_meta_from_universe,
)
from backend.fetcher_cn import sync_cn_data
from backend.fetcher_us import sync_us_data
from backend.realtime import get_realtime_flow_data

FRONTEND_DIR = BASE_DIR / "frontend"
REPORT_PATH = BASE_DIR / "docs" / "reports" / "latest_analysis_report.md"
TZ_CN = ZoneInfo("Asia/Shanghai")
AUTO_SYNC_SLOTS = ((8, 40), (17, 30), (21, 0))

_SYNC_LOCK = threading.Lock()
_SYNC_STATE: dict[str, Any] = {
    "running": False,
    "last_trigger": "",
    "last_started_at": "",
    "last_finished_at": "",
    "last_error": "",
    "results": {},
}
_SCHEDULER_STARTED = False

app = FastAPI(
    title="Rooftop ETF Flow API",
    description="天台ETF资金流 - A股与美股宽基/行业ETF真实份额资金流向看板",
    version=__version__,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _run_sync_locked(
    market: Literal["CN", "US", "ALL"] = "ALL",
    days: int = 30,
    trigger: str = "manual",
) -> dict[str, Any]:
    """Execute market sync under a mutex lock and track execution status."""
    with _SYNC_LOCK:
        _SYNC_STATE["running"] = True
        _SYNC_STATE["last_trigger"] = trigger
        _SYNC_STATE["last_started_at"] = dt.datetime.now(TZ_CN).strftime("%Y-%m-%d %H:%M:%S")
        _SYNC_STATE["last_error"] = ""
        results: dict[str, Any] = {}
        try:
            if market in ("CN", "ALL"):
                results["CN"] = sync_cn_data(lookback_days=days)
            if market in ("US", "ALL"):
                results["US"] = sync_us_data(lookback_days=days)
            report_path = generate_markdown_report(REPORT_PATH)
            _SYNC_STATE["results"] = results
            _SYNC_STATE["last_finished_at"] = dt.datetime.now(TZ_CN).strftime("%Y-%m-%d %H:%M:%S")
            return {
                "status": "ok",
                "results": results,
                "report_path": str(report_path),
            }
        except Exception as exc:
            _SYNC_STATE["last_error"] = str(exc)
            raise
        finally:
            _SYNC_STATE["running"] = False


def _has_missed_weekday_since(last_date_str: str, today_cn: dt.date) -> bool:
    """Return True if at least one full weekday passed after last_date_str before today_cn."""
    if not last_date_str:
        return True
    try:
        last_d = dt.date.fromisoformat(last_date_str[:10])
    except ValueError:
        return True
    cur = last_d + dt.timedelta(days=1)
    while cur < today_cn:
        if cur.weekday() < 5:
            return True
        cur += dt.timedelta(days=1)
    return False


def _auto_sync_scheduler() -> None:
    """Background daemon that catches up stale data on boot and runs scheduled daily syncs."""
    try:
        today_cn = dt.datetime.now(TZ_CN).date()
        cn_sync = get_latest_sync("CN")
        us_sync = get_latest_sync("US")
        cn_stale = not cn_sync or _has_missed_weekday_since(cn_sync.get("latest_flow_date", ""), today_cn)
        us_stale = not us_sync or _has_missed_weekday_since(us_sync.get("latest_flow_date", ""), today_cn)
        if cn_stale or us_stale:
            _run_sync_locked(market="ALL", days=20, trigger="startup_catchup")
    except Exception:
        pass

    executed_slots: set[str] = set()
    while True:
        time.sleep(30)
        try:
            now_cn = dt.datetime.now(TZ_CN)
            # Run scheduled slots Mon-Fri, plus Sat 08:40 for US Friday night settlement
            if now_cn.weekday() == 6:
                continue
            for slot_h, slot_m in AUTO_SYNC_SLOTS:
                if now_cn.weekday() == 5 and (slot_h, slot_m) != (8, 40):
                    continue
                slot_key = f"{now_cn.strftime('%Y-%m-%d')}_{slot_h:02d}:{slot_m:02d}"
                if slot_key in executed_slots:
                    continue
                slot_dt = now_cn.replace(hour=slot_h, minute=slot_m, second=0, microsecond=0)
                diff_sec = (now_cn - slot_dt).total_seconds()
                if 0 <= diff_sec <= 180:
                    executed_slots.add(slot_key)
                    _run_sync_locked(market="ALL", days=20, trigger=f"cron_{slot_h:02d}{slot_m:02d}")
        except Exception:
            continue


@app.on_event("startup")
def _on_startup() -> None:
    """Ensure SQLite schema, ETF metadata, and background sync scheduler are started."""
    global _SCHEDULER_STARTED
    init_db()
    if not _SCHEDULER_STARTED:
        _SCHEDULER_STARTED = True
        t = threading.Thread(target=_auto_sync_scheduler, name="rooftop-auto-sync", daemon=True)
        t.start()


class SyncRequest(BaseModel):
    market: Literal["CN", "US", "ALL"] = "ALL"
    days: int = Field(default=30, ge=5, le=120)


class AddEtfRequest(BaseModel):
    market: Literal["CN", "US"]
    code: str = Field(..., min_length=1, max_length=16)
    name: str = Field(..., min_length=1, max_length=64)
    sector_name: str = ""
    exchange: str = ""
    category: Literal["broad", "sector", "theme", "macro"] = "theme"
    cluster_id: str = "custom_watch"
    cluster_name: str = "自定义关注"
    style: str = "growth"
    national_team_core: bool = False


@app.get("/api/health")
def health() -> dict[str, str]:
    """Health check endpoint."""
    return {"status": "ok", "version": __version__}


@app.get("/api/v1/etf-flow/dashboard")
def api_dashboard(
    market: Literal["CN", "US"] = Query(default="CN"),
    period: Literal["1d", "5d", "20d", "60d"] = Query(default="5d"),
) -> dict:
    """Return aggregated dashboard analytics for a market and period."""
    return get_dashboard_data(market=market, period=period)


@app.get("/api/v1/etf-flow/realtime")
def api_realtime(
    market: Literal["CN", "US"] = Query(default="CN"),
    force: bool = Query(default=False),
) -> dict:
    """Return realtime intraday sector, theme, and monitored ETF fund flow data."""
    return get_realtime_flow_data(market=market, force=force)


@app.get("/api/v1/etf-flow/etf/{market}/{code}")
def api_etf_detail(
    market: Literal["CN", "US"],
    code: str,
    limit: int = Query(default=90, ge=10, le=200),
) -> dict:
    """Return daily historical price, share, and net flow series for one ETF."""
    detail = get_etf_detail_history(market=market, code=code.upper(), limit=limit)
    if not detail:
        raise HTTPException(status_code=404, detail=f"ETF {market}:{code} not found")
    return detail


@app.get("/api/v1/etf-flow/universe")
def api_universe() -> dict:
    """Return current configured ETF and benchmark index universe."""
    return load_universe()


@app.get("/api/v1/etf-flow/sync/status")
def api_sync_status() -> dict[str, Any]:
    """Return current background/manual sync state and latest sync records for CN and US."""
    return {
        **_SYNC_STATE,
        "CN": get_latest_sync("CN"),
        "US": get_latest_sync("US"),
    }


@app.post("/api/v1/etf-flow/sync")
def api_sync(req: SyncRequest) -> dict:
    """Trigger incremental or lookback data synchronization and regenerate report."""
    return _run_sync_locked(market=req.market, days=req.days, trigger="manual")


@app.post("/api/v1/etf-flow/universe/add")
def api_add_etf(req: AddEtfRequest) -> dict:
    """Add a new ETF to config/etf_universe.json, sync its historical data, and return status."""
    market = req.market.upper()
    code = req.code.strip().upper() if market == "US" else req.code.strip()

    universe = load_universe()
    etf_list = universe[market]["etfs"]
    if any(e["code"] == code for e in etf_list):
        raise HTTPException(status_code=400, detail=f"标的 {code} 已在 {market} 监控池中")

    exchange = req.exchange.strip().upper()
    if not exchange:
        if market == "CN":
            exchange = "SSE" if code.startswith(("5", "6")) else "SZSE"
        else:
            exchange = "NYSE"

    new_item = {
        "code": code,
        "name": req.name.strip(),
        "sector_name": req.sector_name.strip() or req.name.strip(),
        "exchange": exchange,
        "category": req.category,
        "cluster_id": req.cluster_id.strip() or "custom_watch",
        "cluster_name": req.cluster_name.strip() or "自定义关注",
        "style": req.style.strip() or "growth",
        "national_team_core": req.national_team_core,
    }
    etf_list.append(new_item)
    save_universe(universe)
    sync_meta_from_universe()

    if market == "CN":
        sync_res = sync_cn_data(lookback_days=75, target_codes=[code])
    else:
        sync_res = sync_us_data(lookback_days=75, target_codes=[code])

    generate_markdown_report(REPORT_PATH)
    return {
        "status": "ok",
        "added": new_item,
        "sync": sync_res,
    }


@app.get("/api/v1/etf-flow/report")
def api_get_report() -> dict[str, str]:
    """Return latest generated Markdown analysis report."""
    if not REPORT_PATH.exists():
        generate_markdown_report(REPORT_PATH)
    return {
        "path": str(REPORT_PATH),
        "content": REPORT_PATH.read_text(encoding="utf-8"),
    }


@app.get("/api/v1/etf-flow/report/download", response_class=PlainTextResponse)
def api_download_report() -> PlainTextResponse:
    """Download latest Markdown analysis report as .md attachment."""
    if not REPORT_PATH.exists():
        generate_markdown_report(REPORT_PATH)
    content = REPORT_PATH.read_text(encoding="utf-8")
    return PlainTextResponse(
        content=content,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=rooftop_etf_flow_report.md"},
    )


if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

    @app.get("/")
    def serve_index() -> FileResponse:
        """Serve the Rooftop ETF Flow dashboard SPA."""
        return FileResponse(
            str(FRONTEND_DIR / "index.html"),
            headers={"Cache-Control": "no-cache, must-revalidate"},
        )
