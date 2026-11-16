"""FastAPI web server for Rooftop ETF Flow (天台ETF资金流)."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

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
from backend.db import BASE_DIR, init_db, load_universe, save_universe, sync_meta_from_universe
from backend.fetcher_cn import sync_cn_data
from backend.fetcher_us import sync_us_data
from backend.realtime import get_realtime_flow_data

FRONTEND_DIR = BASE_DIR / "frontend"
REPORT_PATH = BASE_DIR / "docs" / "reports" / "latest_analysis_report.md"

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


@app.on_event("startup")
def _on_startup() -> None:
    """Ensure SQLite schema and ETF metadata are initialized on boot."""
    init_db()


class SyncRequest(BaseModel):
    market: Literal["CN", "US", "ALL"] = "ALL"
    days: int = Field(default=30, ge=5, le=120)


class AddEtfRequest(BaseModel):
    market: Literal["CN", "US"]
    code: str = Field(..., min_length=1, max_length=16)
    name: str = Field(..., min_length=1, max_length=64)
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


@app.post("/api/v1/etf-flow/sync")
def api_sync(req: SyncRequest) -> dict:
    """Trigger incremental or lookback data synchronization and regenerate report."""
    results = {}
    if req.market in ("CN", "ALL"):
        results["CN"] = sync_cn_data(lookback_days=req.days)
    if req.market in ("US", "ALL"):
        results["US"] = sync_us_data(lookback_days=req.days)
    report_path = generate_markdown_report(REPORT_PATH)
    return {
        "status": "ok",
        "results": results,
        "report_path": str(report_path),
    }


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
        return FileResponse(str(FRONTEND_DIR / "index.html"))
