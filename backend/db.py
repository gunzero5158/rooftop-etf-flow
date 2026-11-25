"""SQLite persistence layer and universe config management for Rooftop ETF Flow."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "rooftop_etf.db"
UNIVERSE_PATH = BASE_DIR / "config" / "etf_universe.json"


def load_universe() -> dict[str, Any]:
    """Load the ETF and index universe configuration from JSON."""
    with UNIVERSE_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_universe(universe: dict[str, Any]) -> None:
    """Persist the ETF and index universe configuration to JSON."""
    UNIVERSE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with UNIVERSE_PATH.open("w", encoding="utf-8") as f:
        json.dump(universe, f, ensure_ascii=False, indent=2)


@contextmanager
def get_conn() -> Iterator[sqlite3.Connection]:
    """Yield a SQLite connection configured with row factory and WAL mode."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    """Initialize SQLite tables and indexes if they do not exist."""
    with get_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS etf_meta (
                market TEXT NOT NULL,
                code TEXT NOT NULL,
                name TEXT NOT NULL,
                sector_name TEXT DEFAULT '',
                exchange TEXT NOT NULL,
                category TEXT NOT NULL,
                cluster_id TEXT NOT NULL,
                cluster_name TEXT NOT NULL,
                style TEXT DEFAULT '',
                national_team_core INTEGER DEFAULT 0,
                latest_aum REAL DEFAULT 0.0,
                updated_at TEXT DEFAULT '',
                PRIMARY KEY (market, code)
            );

            CREATE TABLE IF NOT EXISTS etf_daily (
                market TEXT NOT NULL,
                code TEXT NOT NULL,
                trade_date TEXT NOT NULL,
                close REAL,
                pct_chg REAL,
                volume REAL,
                amount REAL,
                nav REAL,
                shares REAL,
                share_chg REAL,
                net_flow REAL,
                aum REAL,
                PRIMARY KEY (market, code, trade_date)
            );

            CREATE INDEX IF NOT EXISTS idx_etf_daily_market_date
                ON etf_daily (market, trade_date);

            CREATE TABLE IF NOT EXISTS index_daily (
                market TEXT NOT NULL,
                code TEXT NOT NULL,
                name TEXT NOT NULL,
                trade_date TEXT NOT NULL,
                open REAL,
                high REAL,
                low REAL,
                close REAL,
                pct_chg REAL,
                amount REAL,
                PRIMARY KEY (market, code, trade_date)
            );

            CREATE INDEX IF NOT EXISTS idx_index_daily_market_date
                ON index_daily (market, trade_date);

            CREATE TABLE IF NOT EXISTS sync_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                market TEXT NOT NULL,
                status TEXT NOT NULL,
                message TEXT DEFAULT '',
                latest_price_date TEXT DEFAULT '',
                latest_flow_date TEXT DEFAULT '',
                synced_at TEXT NOT NULL
            );
            """
        )
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(etf_meta)").fetchall()}
        if "sector_name" not in cols:
            conn.execute("ALTER TABLE etf_meta ADD COLUMN sector_name TEXT DEFAULT '';")
    sync_meta_from_universe()


def sync_meta_from_universe() -> None:
    """Synchronize etf_meta records with config/etf_universe.json."""
    universe = load_universe()
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with get_conn() as conn:
        for market in ("CN", "US"):
            etfs = universe.get(market, {}).get("etfs", [])
            for item in etfs:
                conn.execute(
                    """
                    INSERT INTO etf_meta (
                        market, code, name, sector_name, exchange, category,
                        cluster_id, cluster_name, style, national_team_core, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(market, code) DO UPDATE SET
                        name = excluded.name,
                        sector_name = excluded.sector_name,
                        exchange = excluded.exchange,
                        category = excluded.category,
                        cluster_id = excluded.cluster_id,
                        cluster_name = excluded.cluster_name,
                        style = excluded.style,
                        national_team_core = excluded.national_team_core,
                        updated_at = excluded.updated_at
                    """,
                    (
                        market,
                        item["code"],
                        item["name"],
                        item.get("sector_name", ""),
                        item.get("exchange", ""),
                        item["category"],
                        item["cluster_id"],
                        item["cluster_name"],
                        item.get("style", ""),
                        1 if item.get("national_team_core") else 0,
                        now_str,
                    ),
                )


def upsert_index_daily(rows: list[dict[str, Any]]) -> int:
    """Batch upsert daily index bars."""
    if not rows:
        return 0
    with get_conn() as conn:
        conn.executemany(
            """
            INSERT INTO index_daily (
                market, code, name, trade_date, open, high, low, close, pct_chg, amount
            )
            VALUES (
                :market, :code, :name, :trade_date, :open, :high, :low, :close, :pct_chg, :amount
            )
            ON CONFLICT(market, code, trade_date) DO UPDATE SET
                name = excluded.name,
                open = COALESCE(excluded.open, index_daily.open),
                high = COALESCE(excluded.high, index_daily.high),
                low = COALESCE(excluded.low, index_daily.low),
                close = COALESCE(excluded.close, index_daily.close),
                pct_chg = COALESCE(excluded.pct_chg, index_daily.pct_chg),
                amount = COALESCE(excluded.amount, index_daily.amount)
            """,
            rows,
        )
    return len(rows)


def upsert_etf_daily(rows: list[dict[str, Any]]) -> int:
    """Batch upsert daily ETF bars and flow metrics without overwriting non-null values with nulls."""
    if not rows:
        return 0
    with get_conn() as conn:
        conn.executemany(
            """
            INSERT INTO etf_daily (
                market, code, trade_date, close, pct_chg, volume, amount,
                nav, shares, share_chg, net_flow, aum
            )
            VALUES (
                :market, :code, :trade_date, :close, :pct_chg, :volume, :amount,
                :nav, :shares, :share_chg, :net_flow, :aum
            )
            ON CONFLICT(market, code, trade_date) DO UPDATE SET
                close = COALESCE(excluded.close, etf_daily.close),
                pct_chg = COALESCE(excluded.pct_chg, etf_daily.pct_chg),
                volume = COALESCE(excluded.volume, etf_daily.volume),
                amount = COALESCE(excluded.amount, etf_daily.amount),
                nav = COALESCE(excluded.nav, etf_daily.nav),
                shares = COALESCE(excluded.shares, etf_daily.shares),
                share_chg = COALESCE(excluded.share_chg, etf_daily.share_chg),
                net_flow = COALESCE(excluded.net_flow, etf_daily.net_flow),
                aum = COALESCE(excluded.aum, etf_daily.aum)
            """,
            rows,
        )
    return len(rows)


def update_etf_latest_aum(market: str, code: str, latest_aum: float) -> None:
    """Update cached latest AUM in etf_meta."""
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with get_conn() as conn:
        conn.execute(
            "UPDATE etf_meta SET latest_aum = ?, updated_at = ? WHERE market = ? AND code = ?",
            (latest_aum, now_str, market, code),
        )


def log_sync(
    market: str,
    status: str,
    message: str,
    latest_price_date: str = "",
    latest_flow_date: str = "",
) -> None:
    """Record a market sync execution event."""
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO sync_log (market, status, message, latest_price_date, latest_flow_date, synced_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (market, status, message, latest_price_date, latest_flow_date, now_str),
        )


def get_latest_sync(market: str) -> dict[str, Any] | None:
    """Return the most recent sync_log record for a market."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM sync_log WHERE market = ? ORDER BY id DESC LIMIT 1",
            (market,),
        ).fetchone()
        return dict(row) if row else None
