"""Realtime intraday fund flow engine for CN (A-share) and US markets (by sector, theme, and ETF)."""

from __future__ import annotations

import datetime as dt
import threading
import time
from io import StringIO
from typing import Any

import pandas as pd
import requests
from akshare.stock_feature.stock_fund_flow import _get_file_content_ths, py_mini_racer

from backend.db import load_universe

CACHE_TTL_SECONDS = 15.0
_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_CACHE_LOCK = threading.Lock()
_THS_LOCK = threading.Lock()

HEADERS_BROWSER = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    )
}

CONCEPT_NOISE_KEYWORDS = (
    "融资融券",
    "转融券",
    "深股通",
    "沪股通",
    "标普",
    "MSCI",
    "富时",
    "同花顺漂亮",
    "昨日",
    "预增",
    "预亏",
    "央企",
    "国企改革",
    "证金持股",
    "基金重仓",
    "保险重仓",
    "社保重仓",
    "QFII",
    "百元股",
    "低价股",
    "微盘股",
    "破净",
    "ST板块",
    "含H股",
    "AH股",
    "AB股",
    "注册制",
)

US_REALTIME_SECTORS: list[dict[str, Any]] = [
    {"code": "XLK", "name": "信息技术 (XLK)", "leaders": ["NVDA", "AAPL", "MSFT"]},
    {"code": "XLF", "name": "金融服务 (XLF)", "leaders": ["JPM", "BAC", "GS"]},
    {"code": "XLV", "name": "医疗保健 (XLV)", "leaders": ["LLY", "UNH", "JNJ"]},
    {"code": "XLE", "name": "能源化工 (XLE)", "leaders": ["XOM", "CVX", "COP"]},
    {"code": "XLY", "name": "可选消费 (XLY)", "leaders": ["AMZN", "TSLA", "HD"]},
    {"code": "XLP", "name": "必选消费 (XLP)", "leaders": ["WMT", "COST", "PG"]},
    {"code": "XLI", "name": "工业制造 (XLI)", "leaders": ["GE", "CAT", "RTX"]},
    {"code": "XLU", "name": "公用事业与电力 (XLU)", "leaders": ["NEE", "CEG", "SO"]},
    {"code": "XLC", "name": "通信与流媒体 (XLC)", "leaders": ["META", "GOOGL", "NFLX"]},
    {"code": "XLB", "name": "基础材料 (XLB)", "leaders": ["LIN", "NEM", "FCX"]},
    {"code": "XLRE", "name": "房地产信托 (XLRE)", "leaders": ["PLD", "AMT", "EQIX"]},
    {"code": "KRE", "name": "区域性银行 (KRE)", "leaders": ["USB", "PNC", "TFC"]},
    {"code": "ITB", "name": "房屋建筑与家居 (ITB)", "leaders": ["DHI", "LEN", "PHM"]},
    {"code": "ITA", "name": "航空航天与国防 (ITA)", "leaders": ["LMT", "RTX", "BA"]},
    {"code": "XOP", "name": "油气勘探与开采 (XOP)", "leaders": ["EOG", "DVN", "FANG"]},
    {"code": "XRT", "name": "商业零售连锁 (XRT)", "leaders": ["WMT", "TGT", "COST"]},
]

US_REALTIME_THEMES: list[dict[str, Any]] = [
    {"code": "SMH", "name": "AI算力与芯片 (SMH)", "leaders": ["NVDA", "TSM", "AVGO"]},
    {"code": "SOXX", "name": "费城半导体硬件 (SOXX)", "leaders": ["AMD", "QCOM", "MU"]},
    {"code": "IGV", "name": "企业软件与SaaS (IGV)", "leaders": ["MSFT", "CRM", "ORCL"]},
    {"code": "BOTZ", "name": "机器人与具身智能 (BOTZ)", "leaders": ["ISRG", "NVDA", "ABB"]},
    {"code": "CIBR", "name": "网络安全概念 (CIBR)", "leaders": ["CRWD", "PANW", "FTNT"]},
    {"code": "SKYY", "name": "云计算与数据中心 (SKYY)", "leaders": ["AMZN", "GOOGL", "ANET"]},
    {"code": "ARKK", "name": "颠覆式创新高Beta (ARKK)", "leaders": ["TSLA", "COIN", "ROKU"]},
    {"code": "XBI", "name": "生物科技与基因编辑 (XBI)", "leaders": ["VRTX", "REGN", "MRNA"]},
    {"code": "IBIT", "name": "比特币与加密生态 (IBIT)", "leaders": ["MSTR", "COIN", "MARA"]},
    {"code": "URA", "name": "核电与AI能源基建 (URA)", "leaders": ["CCJ", "CEG", "VST"]},
    {"code": "TAN", "name": "光伏与清洁能源 (TAN)", "leaders": ["FSLR", "ENPH", "NXT"]},
    {"code": "LIT", "name": "锂电池与智能电车 (LIT)", "leaders": ["TSLA", "ALB", "RIVN"]},
    {"code": "GDX", "name": "黄金矿业与贵金属 (GDX)", "leaders": ["NEM", "AEM", "GOLD"]},
    {"code": "KWEB", "name": "中概互联网科技 (KWEB)", "leaders": ["BABA", "PDD", "JD"]},
    {"code": "JETS", "name": "全球航空与旅游 (JETS)", "leaders": ["DAL", "UAL", "AAL"]},
    {"code": "FINX", "name": "金融科技与数字支付 (FINX)", "leaders": ["PYPL", "AFRM", "SOFI"]},
]


def _direct_session() -> requests.Session:
    """Create a requests session bypassing system proxy for CN/Tencent gateways."""
    sess = requests.Session()
    sess.trust_env = False
    sess.headers.update(HEADERS_BROWSER)
    return sess


def _safe_float(val: Any, default: float = 0.0) -> float:
    """Parse float safely from strings possibly containing % or commas."""
    if val is None:
        return default
    try:
        s = str(val).replace("%", "").replace(",", "").strip()
        if not s or s in ("-", "--", "nan", "None"):
            return default
        return float(s)
    except (ValueError, TypeError):
        return default


def _classify_quadrant(pct_chg: float, net_flow: float) -> str:
    """Classify intraday price-flow movement into four quadrants."""
    if pct_chg >= 0 and net_flow >= 0:
        return "主线共振"
    if pct_chg >= 0 and net_flow < 0:
        return "逢高兑现"
    if pct_chg < 0 and net_flow >= 0:
        return "逆势抄底"
    return "资金撤离"


def _fetch_tencent_quotes(symbols: list[str]) -> dict[str, list[str]]:
    """Batch fetch real-time quote arrays from Tencent qt.gtimg.cn."""
    if not symbols:
        return {}
    sess = _direct_session()
    parsed: dict[str, list[str]] = {}
    chunk_size = 60
    for i in range(0, len(symbols), chunk_size):
        chunk = symbols[i : i + chunk_size]
        url = f"http://qt.gtimg.cn/q={','.join(chunk)}"
        try:
            resp = sess.get(url, timeout=12)
            resp.encoding = "gbk"
            for line in resp.text.strip().splitlines():
                if "=" not in line or "~" not in line:
                    continue
                key_part, val_part = line.split("=", 1)
                sym = key_part.strip().removeprefix("v_")
                fields = val_part.strip().strip('";').split("~")
                if len(fields) > 35:
                    parsed[sym] = fields
        except Exception:
            continue
    return parsed


def _fetch_ths_board_page(
    sess: requests.Session,
    board: str,
    order: str,
    page: int,
) -> list[dict[str, Any]]:
    """Fetch one page of Tonghuashun realtime industry (hyzjl) or concept (gnzjl) fund flow."""
    with _THS_LOCK:
        js_code = py_mini_racer.MiniRacer()
        js_code.eval(_get_file_content_ths("ths.js"))
        v_code = js_code.call("v")

    headers = {
        "Accept": "text/html, */*; q=0.01",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "hexin-v": v_code,
        "Host": "data.10jqka.com.cn",
        "Referer": f"http://data.10jqka.com.cn/funds/{board}/",
        "User-Agent": HEADERS_BROWSER["User-Agent"],
        "X-Requested-With": "XMLHttpRequest",
    }
    url = f"http://data.10jqka.com.cn/funds/{board}/field/je/order/{order}/page/{page}/ajax/1/free/1/"
    resp = sess.get(url, headers=headers, timeout=12)
    resp.raise_for_status()
    dfs = pd.read_html(StringIO(resp.text))
    if not dfs:
        return []
    df = dfs[0]
    items: list[dict[str, Any]] = []
    for _, row in df.iterrows():
        name = str(row.iloc[1]).strip()
        pct_chg = _safe_float(row.iloc[3])
        inflow = round(_safe_float(row.iloc[4]), 2)
        outflow = round(_safe_float(row.iloc[5]), 2)
        net_flow = round(_safe_float(row.iloc[6]), 2)
        company_cnt = int(_safe_float(row.iloc[7], 0))
        lead_stock = str(row.iloc[8]).strip() if len(row) > 8 else ""
        lead_pct = round(_safe_float(row.iloc[9]), 2) if len(row) > 9 else 0.0
        total_turnover = inflow + outflow
        net_ratio = round(net_flow / total_turnover * 100.0, 2) if total_turnover > 0 else 0.0
        items.append(
            {
                "code": name,
                "name": name,
                "pct_chg": round(pct_chg, 2),
                "inflow": inflow,
                "outflow": outflow,
                "net_flow": net_flow,
                "net_ratio": net_ratio,
                "turnover": round(total_turnover, 2),
                "company_count": company_cnt,
                "lead_stock": lead_stock,
                "lead_pct": lead_pct,
                "quadrant": _classify_quadrant(pct_chg, net_flow),
            }
        )
    return items


def _fetch_sina_sector_fallback(sess: requests.Session, fenlei: int) -> list[dict[str, Any]]:
    """Fallback fetcher for CN industry (fenlei=0) or concept (fenlei=1) money flows via Sina."""
    merged: dict[str, dict[str, Any]] = {}
    for asc in (0, 1):
        url = (
            f"https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/"
            f"MoneyFlow.ssl_bkzj_bk?page=1&num=60&sort=netamount&asc={asc}&fenlei={fenlei}"
        )
        try:
            resp = sess.get(url, timeout=12)
            rows = resp.json()
            if not isinstance(rows, list):
                continue
            for x in rows:
                name = str(x.get("name", "")).strip()
                if not name:
                    continue
                pct_chg = round(_safe_float(x.get("avg_changeratio")) * 100.0, 2)
                inflow = round(_safe_float(x.get("inamount")) / 1e8, 2)
                outflow = round(_safe_float(x.get("outamount")) / 1e8, 2)
                net_flow = round(_safe_float(x.get("netamount")) / 1e8, 2)
                turnover = inflow + outflow
                net_ratio = round(net_flow / turnover * 100.0, 2) if turnover > 0 else 0.0
                merged[name] = {
                    "code": str(x.get("category") or name),
                    "name": name,
                    "pct_chg": pct_chg,
                    "inflow": inflow,
                    "outflow": outflow,
                    "net_flow": net_flow,
                    "net_ratio": net_ratio,
                    "turnover": round(turnover, 2),
                    "company_count": 0,
                    "lead_stock": str(x.get("ts_name") or "").strip(),
                    "lead_pct": round(_safe_float(x.get("ts_changeratio")) * 100.0, 2),
                    "quadrant": _classify_quadrant(pct_chg, net_flow),
                }
        except Exception:
            continue
    out = list(merged.values())
    out.sort(key=lambda r: r["net_flow"], reverse=True)
    return out


def _get_cn_industries_and_concepts() -> tuple[list[dict[str, Any]], list[dict[str, Any]], str]:
    """Fetch realtime CN industry and concept fund flows (Tonghuashun primary, Sina fallback)."""
    sess = _direct_session()
    source = "同花顺实时资金流"
    industries: list[dict[str, Any]] = []
    concepts: list[dict[str, Any]] = []

    try:
        ind_map: dict[str, dict[str, Any]] = {}
        for page in (1, 2):
            for row in _fetch_ths_board_page(sess, "hyzjl", "desc", page):
                ind_map[row["name"]] = row
        industries = sorted(ind_map.values(), key=lambda x: x["net_flow"], reverse=True)
    except Exception:
        industries = _fetch_sina_sector_fallback(sess, fenlei=0)
        source = "新浪财经实时资金流"

    try:
        con_map: dict[str, dict[str, Any]] = {}
        for order in ("desc", "asc"):
            for row in _fetch_ths_board_page(sess, "gnzjl", order, 1):
                if any(k in row["name"] for k in CONCEPT_NOISE_KEYWORDS):
                    continue
                con_map[row["name"]] = row
        concepts = sorted(con_map.values(), key=lambda x: x["net_flow"], reverse=True)
    except Exception:
        raw_con = _fetch_sina_sector_fallback(sess, fenlei=1)
        concepts = [
            row for row in raw_con if not any(k in row["name"] for k in CONCEPT_NOISE_KEYWORDS)
        ]
        if source == "同花顺实时资金流":
            source = "同花顺行业 + 新浪概念"

    return industries, concepts, source


def _get_cn_realtime_etfs_and_indices() -> tuple[list[dict[str, Any]], list[dict[str, Any]], str]:
    """Fetch realtime CN benchmark indices and monitored ETF intraday active flow via Tencent."""
    universe = load_universe()
    cn_cfg = universe["CN"]
    indices_cfg = cn_cfg["indices"]
    etfs_cfg = cn_cfg["etfs"]

    sym_list: list[str] = [f"{idx['prefix']}{idx['code']}" for idx in indices_cfg]
    etf_sym_map: dict[str, dict[str, Any]] = {}
    for e in etfs_cfg:
        prefix = "sh" if e.get("exchange") == "SSE" or e["code"].startswith(("5", "6")) else "sz"
        sym = f"{prefix}{e['code']}"
        sym_list.append(sym)
        etf_sym_map[sym] = e

    quotes = _fetch_tencent_quotes(sym_list)
    latest_time = ""

    indices_out: list[dict[str, Any]] = []
    for idx in indices_cfg:
        sym = f"{idx['prefix']}{idx['code']}"
        p = quotes.get(sym)
        if not p:
            continue
        raw_t = p[30] if len(p) > 30 else ""
        if len(raw_t) == 14:
            latest_time = f"{raw_t[:4]}-{raw_t[4:6]}-{raw_t[6:8]} {raw_t[8:10]}:{raw_t[10:12]}:{raw_t[12:14]}"
        indices_out.append(
            {
                "code": idx["code"],
                "name": idx["name"],
                "close": round(_safe_float(p[3]), 2),
                "pct_chg": round(_safe_float(p[32]), 2),
            }
        )

    etfs_out: list[dict[str, Any]] = []
    for sym, meta in etf_sym_map.items():
        p = quotes.get(sym)
        if not p:
            continue
        price = round(_safe_float(p[3]), 3)
        pct_chg = round(_safe_float(p[32]), 2)
        total_vol = _safe_float(p[6])
        outer_vol = _safe_float(p[7])
        inner_vol = _safe_float(p[8])

        turnover_yuan = 0.0
        if len(p) > 35 and "/" in p[35]:
            parts_35 = p[35].split("/")
            if len(parts_35) >= 3:
                turnover_yuan = _safe_float(parts_35[2])
        if turnover_yuan <= 0 and len(p) > 37:
            turnover_yuan = _safe_float(p[37]) * 10000.0
        turnover_yi = round(turnover_yuan / 1e8, 2)

        active_ratio = (
            round((outer_vol - inner_vol) / total_vol * 100.0, 2) if total_vol > 0 else 0.0
        )
        active_net_flow = round(turnover_yi * active_ratio / 100.0, 2)
        inflow_yi = round((turnover_yi + active_net_flow) / 2.0, 2)
        outflow_yi = round((turnover_yi - active_net_flow) / 2.0, 2)

        turnover_rate = round(_safe_float(p[38]), 2) if len(p) > 38 else 0.0
        vol_ratio = round(_safe_float(p[49], 1.0), 2) if len(p) > 49 else 1.0
        discount_pct = round(_safe_float(p[77]), 2) if len(p) > 77 else 0.0
        iopv = round(_safe_float(p[78], price), 3) if len(p) > 78 else price

        etfs_out.append(
            {
                "code": meta["code"],
                "name": meta["name"],
                "category": meta["category"],
                "cluster_name": meta["cluster_name"],
                "price": price,
                "pct_chg": pct_chg,
                "net_flow": active_net_flow,
                "net_ratio": active_ratio,
                "inflow": inflow_yi,
                "outflow": outflow_yi,
                "turnover": turnover_yi,
                "vol_ratio": vol_ratio,
                "turnover_rate": turnover_rate,
                "discount_pct": discount_pct,
                "iopv": iopv,
                "quadrant": _classify_quadrant(pct_chg, active_net_flow),
            }
        )

    etfs_out.sort(key=lambda x: x["net_flow"], reverse=True)
    return indices_out, etfs_out, latest_time


def _compute_us_etf_flow_metrics(fields: list[str]) -> dict[str, float]:
    """Derive Chaikin/intraday money flow metrics (USD Millions) from Tencent US quote fields."""
    price = _safe_float(fields[3])
    pct_chg = _safe_float(fields[32])
    high = _safe_float(fields[33], price)
    low = _safe_float(fields[34], price)
    amount_usd = _safe_float(fields[37])
    turnover_m = round(amount_usd / 1e6, 2)

    spread = max(high - low, 0.0001)
    clv = ((price - low) - (high - price)) / spread
    clv = max(-1.0, min(1.0, clv))
    pct_comp = max(-1.0, min(1.0, pct_chg / 2.5))
    mfm = max(-0.85, min(0.85, 0.55 * clv + 0.45 * pct_comp))

    net_flow = round(turnover_m * mfm * 0.4, 2)
    inflow = round((turnover_m + net_flow) / 2.0, 2)
    outflow = round((turnover_m - net_flow) / 2.0, 2)
    net_ratio = round(net_flow / turnover_m * 100.0, 2) if turnover_m > 0 else 0.0
    amp = round(_safe_float(fields[43]), 2) if len(fields) > 43 else 0.0

    return {
        "price": round(price, 2),
        "pct_chg": round(pct_chg, 2),
        "turnover": turnover_m,
        "inflow": inflow,
        "outflow": outflow,
        "net_flow": net_flow,
        "net_ratio": net_ratio,
        "amplitude": amp,
    }


def _get_us_realtime_all() -> tuple[
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    str,
]:
    """Fetch realtime US benchmark indices, 16 sectors, 16 themes, and monitored US ETFs."""
    universe = load_universe()
    us_etfs_cfg = universe["US"]["etfs"]

    sym_set: set[str] = {"us.INX", "us.IXIC", "us.DJI"}
    for item in US_REALTIME_SECTORS + US_REALTIME_THEMES:
        sym_set.add(f"us{item['code']}")
        for leader in item["leaders"]:
            sym_set.add(f"us{leader}")
    for e in us_etfs_cfg:
        sym_set.add(f"us{e['code']}")

    quotes = _fetch_tencent_quotes(sorted(sym_set))
    latest_time = ""

    index_defs = [
        ("us.INX", "^GSPC", "标普500"),
        ("us.IXIC", "^IXIC", "纳斯达克综合"),
        ("us.DJI", "^DJI", "道琼斯工业"),
        ("usIWM", "IWM", "罗素2000 ETF"),
    ]
    indices_out: list[dict[str, Any]] = []
    for q_sym, code, name in index_defs:
        p = quotes.get(q_sym)
        if not p:
            continue
        if len(p) > 30 and p[30]:
            latest_time = str(p[30]).strip()
        indices_out.append(
            {
                "code": code,
                "name": name,
                "close": round(_safe_float(p[3]), 2),
                "pct_chg": round(_safe_float(p[32]), 2),
            }
        )

    def _build_board_items(defs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for item in defs:
            p = quotes.get(f"us{item['code']}")
            if not p:
                continue
            m = _compute_us_etf_flow_metrics(p)
            best_leader = ""
            best_leader_pct = -999.0
            for l_sym in item["leaders"]:
                lp = quotes.get(f"us{l_sym}")
                if not lp:
                    continue
                l_pct = round(_safe_float(lp[32]), 2)
                if l_pct > best_leader_pct:
                    best_leader_pct = l_pct
                    best_leader = l_sym
            if best_leader_pct == -999.0:
                best_leader_pct = 0.0

            out.append(
                {
                    "code": item["code"],
                    "name": item["name"],
                    "price": m["price"],
                    "pct_chg": m["pct_chg"],
                    "inflow": m["inflow"],
                    "outflow": m["outflow"],
                    "net_flow": m["net_flow"],
                    "net_ratio": m["net_ratio"],
                    "turnover": m["turnover"],
                    "company_count": len(item["leaders"]),
                    "lead_stock": best_leader,
                    "lead_pct": best_leader_pct,
                    "quadrant": _classify_quadrant(m["pct_chg"], m["net_flow"]),
                }
            )
        out.sort(key=lambda x: x["net_flow"], reverse=True)
        return out

    industries = _build_board_items(US_REALTIME_SECTORS)
    concepts = _build_board_items(US_REALTIME_THEMES)

    etfs_out: list[dict[str, Any]] = []
    for meta in us_etfs_cfg:
        p = quotes.get(f"us{meta['code']}")
        if not p:
            continue
        m = _compute_us_etf_flow_metrics(p)
        etfs_out.append(
            {
                "code": meta["code"],
                "name": meta["name"],
                "category": meta["category"],
                "cluster_name": meta["cluster_name"],
                "price": m["price"],
                "pct_chg": m["pct_chg"],
                "net_flow": m["net_flow"],
                "net_ratio": m["net_ratio"],
                "inflow": m["inflow"],
                "outflow": m["outflow"],
                "turnover": m["turnover"],
                "vol_ratio": 1.0,
                "turnover_rate": m["amplitude"],
                "discount_pct": 0.0,
                "iopv": m["price"],
                "quadrant": _classify_quadrant(m["pct_chg"], m["net_flow"]),
            }
        )
    etfs_out.sort(key=lambda x: x["net_flow"], reverse=True)
    return indices_out, industries, concepts, etfs_out, latest_time


def _build_realtime_insights(
    market: str,
    unit: str,
    indices: list[dict[str, Any]],
    industries: list[dict[str, Any]],
    concepts: list[dict[str, Any]],
    etfs: list[dict[str, Any]],
) -> list[dict[str, str]]:
    """Build four concise intraday realtime commentary blocks."""
    idx_text = "；".join(
        f"{x['name']} **{x['close']}**（**{x['pct_chg']:+.2f}%**）" for x in indices[:3]
    )
    ind_in = "、".join(
        f"{x['name']}({x['net_flow']:+.2f}{unit}, {x['pct_chg']:+.2f}%)" for x in industries[:3]
    )
    ind_out = "、".join(
        f"{x['name']}({x['net_flow']:+.2f}{unit}, {x['pct_chg']:+.2f}%)"
        for x in sorted(industries, key=lambda r: r["net_flow"])[:3]
    )
    con_in = "、".join(
        f"{x['name']}({x['net_flow']:+.2f}{unit}, {x['pct_chg']:+.2f}%)" for x in concepts[:3]
    )
    con_out = "、".join(
        f"{x['name']}({x['net_flow']:+.2f}{unit}, {x['pct_chg']:+.2f}%)"
        for x in sorted(concepts, key=lambda r: r["net_flow"])[:3]
    )

    broad_etfs = [e for e in etfs if e["category"] == "broad"]
    broad_sum = round(sum(e["net_flow"] for e in broad_etfs), 2)
    top_etf = etfs[0] if etfs else None
    bot_etf = etfs[-1] if etfs else None

    ind_up_cnt = sum(1 for x in industries if x["net_flow"] > 0)
    con_up_cnt = sum(1 for x in concepts if x["net_flow"] > 0)
    etf_detail = ""
    if top_etf and bot_etf:
        etf_detail = (
            f"盘中净买入居首的是 **{top_etf['name']}**（{top_etf['net_flow']:+.2f}{unit}，"
            f"涨跌 {top_etf['pct_chg']:+.2f}%）；承压居前的是 **{bot_etf['name']}**（{bot_etf['net_flow']:+.2f}{unit}）。"
        )

    method_note = (
        "行业/概念为同花顺/新浪实时主力净额；场内ETF采用内外盘主动买卖额口径"
        if market == "CN"
        else "基于腾讯实时行情与日内量价资金流乘数（MFM × 成交额）实时估算"
    )

    return [
        {
            "title": "大盘实时走势与资金广度",
            "body": (
                f"{idx_text}。实时资金广度：行业净流入 **{ind_up_cnt}/{len(industries)}** 个，"
                f"概念题材净流入 **{con_up_cnt}/{len(concepts)}** 个（{method_note}）。"
            ),
        },
        {
            "title": "分行业实时资金主线",
            "body": f"主力净流入前三行业：{ind_in or '暂无'}；净流出前三行业：{ind_out or '暂无'}。",
        },
        {
            "title": "分题材 / 概念实时热点",
            "body": f"资金抢筹前三题材：{con_in or '暂无'}；资金撤离前三题材：{con_out or '暂无'}。",
        },
        {
            "title": "监控池 ETF 盘中主动资金动向",
            "body": f"宽基 ETF 盘中主动净流向合计 **{broad_sum:+.2f}{unit}**。{etf_detail}",
        },
    ]


def get_realtime_flow_data(market: str = "CN", force: bool = False) -> dict[str, Any]:
    """Fetch and assemble realtime sector, theme, and ETF flow data with short TTL cache."""
    market = market.upper()
    if market not in ("CN", "US"):
        market = "CN"

    now_ts = time.time()
    with _CACHE_LOCK:
        cached = _CACHE.get(market)
        if not force and cached and (now_ts - cached[0] < CACHE_TTL_SECONDS):
            return cached[1]

    if market == "CN":
        unit = "亿元"
        currency = "RMB"
        indices, etfs, quote_time = _get_cn_realtime_etfs_and_indices()
        industries, concepts, source = _get_cn_industries_and_concepts()
    else:
        unit = "百万美元"
        currency = "USD"
        indices, industries, concepts, etfs, quote_time = _get_us_realtime_all()
        source = "腾讯美股实时行情 + 日内资金流模型 (MFM)"

    if not quote_time:
        quote_time = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    total_etf_active = round(sum(e["net_flow"] for e in etfs), 2)
    total_broad_active = round(sum(e["net_flow"] for e in etfs if e["category"] == "broad"), 2)
    ind_in_cnt = sum(1 for x in industries if x["net_flow"] > 0)
    con_in_cnt = sum(1 for x in concepts if x["net_flow"] > 0)

    quadrant_points = [
        {**x, "kind": "行业"} for x in industries[:15] + industries[-10:]
    ] + [
        {**x, "kind": "题材"} for x in concepts[:15] + concepts[-10:]
    ]
    # Deduplicate quadrant points by name + kind
    seen_qp: set[tuple[str, str]] = set()
    dedup_qp: list[dict[str, Any]] = []
    for pt in quadrant_points:
        key = (pt["kind"], pt["name"])
        if key not in seen_qp:
            seen_qp.add(key)
            dedup_qp.append(pt)

    payload = {
        "market": market,
        "currency": currency,
        "unit": unit,
        "source": source,
        "quote_time": quote_time,
        "fetched_at": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "indices": indices,
        "summary": {
            "top_industry": industries[0] if industries else None,
            "bottom_industry": industries[-1] if industries else None,
            "top_concept": concepts[0] if concepts else None,
            "bottom_concept": concepts[-1] if concepts else None,
            "total_etf_active_flow": total_etf_active,
            "total_broad_active_flow": total_broad_active,
            "industry_in_count": ind_in_cnt,
            "industry_total": len(industries),
            "concept_in_count": con_in_cnt,
            "concept_total": len(concepts),
        },
        "insights": _build_realtime_insights(market, unit, indices, industries, concepts, etfs),
        "industries": industries,
        "concepts": concepts,
        "quadrant_points": dedup_qp,
        "etfs": etfs,
    }

    with _CACHE_LOCK:
        _CACHE[market] = (time.time(), payload)
    return payload
