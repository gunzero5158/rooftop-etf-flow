/**
 * Rooftop ETF Flow (天台ETF资金流) - Cloudflare Workers Edge Gateway & Realtime Engine.
 * Serves static SPA assets, cached post-market analytics from Workers KV,
 * and live intraday CN/US sector, theme, and ETF flow endpoints.
 */

import { generateThsToken } from "./ths-token.js";

const APP_VERSION = "0.7.1";
const CACHE_TTL_SECONDS = 30.0;
const EDGE_MEM_CACHE = new Map();

const HEADERS_BROWSER = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

const CONCEPT_NOISE_KEYWORDS = [
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
  "基金重仓",
  "保险重仓",
  "社保重仓",
  "QFII",
  "百元股",
  "低价股",
  "ST板块",
  "含H股",
  "AH股",
  "AB股",
  "注册制",
];

const US_REALTIME_SECTORS = [
  { code: "XLK", name: "信息技术 (XLK)", leaders: ["NVDA", "AAPL", "MSFT"] },
  { code: "XLF", name: "金融服务 (XLF)", leaders: ["JPM", "BAC", "GS"] },
  { code: "XLV", name: "医疗保健 (XLV)", leaders: ["LLY", "UNH", "JNJ"] },
  { code: "XLE", name: "能源化工 (XLE)", leaders: ["XOM", "CVX", "COP"] },
  { code: "XLY", name: "可选消费 (XLY)", leaders: ["AMZN", "TSLA", "HD"] },
  { code: "XLP", name: "必选消费 (XLP)", leaders: ["WMT", "COST", "PG"] },
  { code: "XLI", name: "工业制造 (XLI)", leaders: ["GE", "CAT", "RTX"] },
  { code: "XLU", name: "公用事业与电力 (XLU)", leaders: ["NEE", "CEG", "SO"] },
  { code: "XLC", name: "通信与流媒体 (XLC)", leaders: ["META", "GOOGL", "NFLX"] },
  { code: "XLB", name: "基础材料 (XLB)", leaders: ["LIN", "NEM", "FCX"] },
  { code: "XLRE", name: "房地产信托 (XLRE)", leaders: ["PLD", "AMT", "EQIX"] },
  { code: "KRE", name: "区域性银行 (KRE)", leaders: ["USB", "PNC", "TFC"] },
  { code: "ITB", name: "房屋建筑与家居 (ITB)", leaders: ["DHI", "LEN", "PHM"] },
  { code: "ITA", name: "航空航天与国防 (ITA)", leaders: ["LMT", "RTX", "BA"] },
  { code: "XOP", name: "油气勘探与开采 (XOP)", leaders: ["EOG", "DVN", "FANG"] },
  { code: "XRT", name: "商业零售连锁 (XRT)", leaders: ["WMT", "TGT", "COST"] },
  { code: "XME", name: "金属与采矿 (XME)", leaders: ["NEM", "FCX", "AA"] },
  { code: "XHB", name: "建筑与家居零售 (XHB)", leaders: ["HD", "LOW", "DHI"] },
  { code: "IYT", name: "交通运输与物流 (IYT)", leaders: ["UNP", "UPS", "FDX"] },
  { code: "KIE", name: "保险行业 (KIE)", leaders: ["TRV", "CB", "PGR"] },
];

const US_REALTIME_THEMES = [
  { code: "SMH", name: "AI算力与芯片 (SMH)", leaders: ["NVDA", "TSM", "AVGO"] },
  { code: "SOXX", name: "费城半导体硬件 (SOXX)", leaders: ["AMD", "QCOM", "MU"] },
  { code: "IGV", name: "企业软件与SaaS (IGV)", leaders: ["MSFT", "CRM", "ORCL"] },
  { code: "BOTZ", name: "机器人与具身智能 (BOTZ)", leaders: ["ISRG", "NVDA", "ABB"] },
  { code: "CIBR", name: "网络安全概念 (CIBR)", leaders: ["CRWD", "PANW", "FTNT"] },
  { code: "SKYY", name: "云计算与数据中心 (SKYY)", leaders: ["AMZN", "GOOGL", "ANET"] },
  { code: "ARKK", name: "颠覆式创新高Beta (ARKK)", leaders: ["TSLA", "COIN", "ROKU"] },
  { code: "XBI", name: "生物科技与基因编辑 (XBI)", leaders: ["VRTX", "REGN", "MRNA"] },
  { code: "IBIT", name: "比特币与加密生态 (IBIT)", leaders: ["MSTR", "COIN", "MARA"] },
  { code: "URA", name: "核电与AI能源基建 (URA)", leaders: ["CCJ", "CEG", "VST"] },
  { code: "TAN", name: "光伏与清洁能源 (TAN)", leaders: ["FSLR", "ENPH", "NXT"] },
  { code: "LIT", name: "锂电池与智能电车 (LIT)", leaders: ["TSLA", "ALB", "RIVN"] },
  { code: "GDX", name: "黄金矿业与贵金属 (GDX)", leaders: ["NEM", "AEM", "GOLD"] },
  { code: "KWEB", name: "中概互联网科技 (KWEB)", leaders: ["BABA", "PDD", "JD"] },
  { code: "JETS", name: "全球航空与旅游 (JETS)", leaders: ["DAL", "UAL", "AAL"] },
  { code: "FINX", name: "金融科技与数字支付 (FINX)", leaders: ["PYPL", "AFRM", "SOFI"] },
  { code: "AIQ", name: "生成式AI与大数据 (AIQ)", leaders: ["NVDA", "MSFT", "PLTR"] },
  { code: "PAVE", name: "美国基建与电网升级 (PAVE)", leaders: ["ETN", "PWR", "URI"] },
  { code: "ICLN", name: "全球清洁能源 (ICLN)", leaders: ["ENPH", "FSLR", "NEE"] },
  { code: "BLOK", name: "区块链与数字资产 (BLOK)", leaders: ["COIN", "MSTR", "RIOT"] },
];

const WEEKDAY_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function safeFloat(val, fallback = 0.0) {
  if (val === null || val === undefined) return fallback;
  const s = String(val).replace(/%/g, "").replace(/,/g, "").trim();
  if (!s || s === "-" || s === "--" || s === "nan" || s === "None") return fallback;
  const num = Number(s);
  return Number.isFinite(num) ? num : fallback;
}

function fmtSigned(val, decimals = 2, suffix = "") {
  const num = Number(val || 0);
  const sign = num > 0 ? "+" : "";
  return `${sign}${num.toFixed(decimals)}${suffix}`;
}

function classifyQuadrant(pctChg, netFlow) {
  if (pctChg >= 0 && netFlow >= 0) return "主线共振";
  if (pctChg >= 0 && netFlow < 0) return "逢高兑现";
  if (pctChg < 0 && netFlow >= 0) return "逆势抄底";
  return "资金撤离";
}

function isNoiseConcept(name) {
  return CONCEPT_NOISE_KEYWORDS.some((kw) => name.includes(kw));
}

async function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a || ""))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b || ""))),
  ]);
  const ba = new Uint8Array(ha);
  const bb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < ba.length; i++) {
    diff |= ba[i] ^ bb[i];
  }
  return diff === 0;
}

async function verifyAdminToken(request, env) {
  const expected = String(env.ROOFTOP_ADMIN_TOKEN || "").trim();
  if (!expected) return true;
  const provided = String(request.headers.get("X-Admin-Token") || "").trim();
  if (!provided) return false;
  return constantTimeEqual(provided, expected);
}

function getZonedNowParts(timeZone) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = {};
  for (const p of fmt.formatToParts(now)) {
    parts[p.type] = p.value;
  }
  const hour = Number(parts.hour === "24" ? 0 : parts.hour);
  const minute = Number(parts.minute);
  const todayLocal = `${parts.year}-${parts.month}-${parts.day}`;
  const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const wdNum = wdMap[parts.weekday] ?? 1;
  const isWeekday = wdNum >= 1 && wdNum <= 5;
  const tzLabel = timeZone === "Asia/Shanghai" ? "CST" : "EST/EDT";
  return {
    todayLocal,
    hhmm: hour * 100 + minute,
    isWeekday,
    clockStr: `${parts.month}-${parts.day} ${String(hour).padStart(2, "0")}:${parts.minute} ${tzLabel}`,
    nowStr: `${todayLocal} ${String(hour).padStart(2, "0")}:${parts.minute}:${parts.second}`,
  };
}

function formatDateWeekday(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return "";
  const d = new Date(`${dateStr}T12:00:00Z`);
  return WEEKDAY_ZH[d.getUTCDay()] || "";
}

function evaluateMarketSessionStatus(market, quoteTime) {
  const tz = market === "CN" ? "Asia/Shanghai" : "America/New_York";
  const z = getZonedNowParts(tz);
  let dataDate = quoteTime && quoteTime.length >= 10 ? quoteTime.slice(0, 10) : z.todayLocal;
  let wd = formatDateWeekday(dataDate);
  if (!wd) {
    dataDate = z.todayLocal;
    wd = formatDateWeekday(dataDate);
  }
  const shortDate = dataDate.slice(5);

  if (market === "CN") {
    if (dataDate !== z.todayLocal) {
      if (z.isWeekday && z.hhmm < 930) {
        return {
          state: "PRE_MARKET_PREV_DAY",
          is_live: false,
          is_previous_day: true,
          data_date: dataDate,
          weekday: wd,
          badge_text: `⏸ 盘前未开盘 · 上一交易日 ${shortDate}(${wd})`,
          short_tag: `上一交易日 ${dataDate} (${wd}) 收盘定格`,
          banner_title: `A股盘前尚未开盘 — 当前展示为上一交易日【${dataDate} ${wd}】收盘定格资金流`,
          banner_desc:
            "A股交易时段为北京时间 09:30-11:30、13:00-15:00。开盘集合竞价结束后将自动切换为今日盘中实时数据。",
        };
      }
      return {
        state: "CLOSED_PREV_DAY",
        is_live: false,
        is_previous_day: true,
        data_date: dataDate,
        weekday: wd,
        badge_text: `⏸ 休市中 · 上一交易日 ${shortDate}(${wd})`,
        short_tag: `上一交易日 ${dataDate} (${wd}) 收盘定格`,
        banner_title: `当前A股休市中 — 当前展示为上一交易日【${dataDate} ${wd}】全天收盘定格资金流`,
        banner_desc:
          "非交易时段行情静止，所有行业、题材与ETF主动资金流均为上一交易日 15:00 收盘最终定格数据。",
      };
    }

    if (z.isWeekday && ((z.hhmm >= 925 && z.hhmm <= 1130) || (z.hhmm >= 1300 && z.hhmm <= 1500))) {
      return {
        state: "LIVE_TRADING",
        is_live: true,
        is_previous_day: false,
        data_date: dataDate,
        weekday: wd,
        badge_text: `● 盘中交易中 · ${shortDate}(${wd})实时`,
        short_tag: `今日 ${dataDate} (${wd}) 盘中实时`,
        banner_title: `A股盘中交易进行中【${dataDate} ${wd}】— 实时追踪行业、题材与场内ETF主动资金流`,
        banner_desc:
          "支持每 30 秒自动刷新；分行业/题材统计日内主力资金，监控池ETF基于内外盘主动买卖差额实时测算。",
      };
    }
    if (z.isWeekday && z.hhmm > 1130 && z.hhmm < 1300) {
      return {
        state: "LUNCH_BREAK",
        is_live: false,
        is_previous_day: false,
        data_date: dataDate,
        weekday: wd,
        badge_text: `⏸ 午间休市 · ${shortDate}(${wd})早盘定格`,
        short_tag: `今日 ${dataDate} (${wd}) 早盘定格`,
        banner_title: `A股午间休市中【${dataDate} ${wd}】— 展示截至 11:30 早盘收盘资金流`,
        banner_desc: "13:00 午盘开市后将继续实时跳动更新。",
      };
    }
    return {
      state: "POST_CLOSE_TODAY",
      is_live: false,
      is_previous_day: false,
      data_date: dataDate,
      weekday: wd,
      badge_text: `⏹ 今日已收盘 · ${shortDate}(${wd})收盘定格`,
      short_tag: `今日 ${dataDate} (${wd}) 收盘定格`,
      banner_title: `A股今日已收盘 — 当前展示为今日【${dataDate} ${wd}】15:00 全天收盘定格资金流`,
      banner_desc:
        "今日盘中交易已结束（数据定格于 15:00），官方一级市场申赎份额预计于晚间至次日早间公布，可在「盘后份额流向」页核验。",
    };
  }

  // US Market
  if (dataDate !== z.todayLocal) {
    if (z.isWeekday && z.hhmm < 930) {
      return {
        state: "PRE_MARKET_PREV_DAY",
        is_live: false,
        is_previous_day: true,
        data_date: dataDate,
        weekday: wd,
        badge_text: `⏸ 美股未开盘 · 上一交易日 ${shortDate}(${wd})`,
        short_tag: `上一交易日 ${dataDate} (${wd}) 收盘定格`,
        banner_title: `当前美股尚未开盘 — 页面展示为上一交易日【${dataDate} ${wd}】全天收盘定格资金流`,
        banner_desc: `美股常规交易时段为美东 09:30-16:00（当前美东 ${z.clockStr}）。此时所有板块与ETF均为上一交易日收盘最终汇总。`,
      };
    }
    return {
      state: "CLOSED_PREV_DAY",
      is_live: false,
      is_previous_day: true,
      data_date: dataDate,
      weekday: wd,
      badge_text: `⏸ 美股休市中 · 上一交易日 ${shortDate}(${wd})`,
      short_tag: `上一交易日 ${dataDate} (${wd}) 收盘定格`,
      banner_title: `当前美股休市中 — 页面展示为上一交易日【${dataDate} ${wd}】全天收盘定格资金流`,
      banner_desc: `当前为美股休市时段（美东 ${z.clockStr}），页面数值为上一交易日 16:00 收盘最终定格数据。`,
    };
  }

  if (z.isWeekday && z.hhmm >= 930 && z.hhmm <= 1600) {
    return {
      state: "LIVE_TRADING",
      is_live: true,
      is_previous_day: false,
      data_date: dataDate,
      weekday: wd,
      badge_text: `● 美股交易中 · ${shortDate}(${wd})实时`,
      short_tag: `当期 ${dataDate} (${wd}) 盘中实时`,
      banner_title: `美股盘中交易进行中【${dataDate} ${wd}】— 实时追踪20大行业与20大热门题材`,
      banner_desc: `当前美东时间 ${z.clockStr}，支持每 30 秒自动刷新估算日内资金流向。`,
    };
  }
  return {
    state: "POST_CLOSE_TODAY",
    is_live: false,
    is_previous_day: false,
    data_date: dataDate,
    weekday: wd,
    badge_text: `⏹ 美股已收盘 · ${shortDate}(${wd})收盘定格`,
    short_tag: `当期 ${dataDate} (${wd}) 收盘定格`,
    banner_title: `美股当期交易日已收盘 — 当前展示为【${dataDate} ${wd}】16:00 收盘定格资金流`,
    banner_desc: `当前美东时间 ${z.clockStr}，当期盘中已结束，数值已定格为该交易日全天收盘汇总。`,
  };
}

function decodeBuffer(buf, preferGbk = false) {
  if (preferGbk) {
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      return new TextDecoder("utf-8").decode(buf);
    }
  }
  const utf8 = new TextDecoder("utf-8").decode(buf);
  if (utf8.includes("\uFFFD")) {
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      return utf8;
    }
  }
  return utf8;
}

async function fetchTencentQuotes(symbols) {
  const parsed = {};
  if (!symbols || symbols.length === 0) return parsed;

  const chunkSize = 60;
  const tasks = [];
  for (let i = 0; i < symbols.length; i += chunkSize) {
    const chunk = symbols.slice(i, i + chunkSize);
    const url = `https://qt.gtimg.cn/q=${chunk.join(",")}`;
    tasks.push(
      fetch(url, {
        headers: HEADERS_BROWSER,
        signal: AbortSignal.timeout(9000),
      })
        .then(async (resp) => {
          if (!resp.ok) return;
          const buf = await resp.arrayBuffer();
          const text = decodeBuffer(buf, true);
          for (const rawLine of text.trim().split(/\r?\n/)) {
            if (!rawLine.includes("=") || !rawLine.includes("~")) continue;
            const eqIdx = rawLine.indexOf("=");
            const sym = rawLine.slice(0, eqIdx).trim().replace(/^v_/, "");
            const valPart = rawLine.slice(eqIdx + 1).trim().replace(/^[";]+|[";]+$/g, "");
            const fields = valPart.split("~");
            if (fields.length > 35) {
              parsed[sym] = fields;
            }
          }
        })
        .catch(() => {})
    );
  }
  await Promise.all(tasks);
  return parsed;
}

function stripHtmlText(raw) {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function parseThsBoardHtml(html) {
  const pageMatch = html.match(/class="page_info"[^>]*>\s*\d+\s*\/\s*(\d+)\s*</i);
  const totalPages = pageMatch ? Number(pageMatch[1]) || 1 : 1;

  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  const bodyHtml = tbodyMatch ? tbodyMatch[1] : html;
  const trMatches = bodyHtml.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];

  const items = [];
  for (const tr of trMatches) {
    const tdMatches = [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)];
    if (tdMatches.length < 8) continue;
    const cols = tdMatches.map((m) => stripHtmlText(m[1]));
    const name = cols[1];
    if (!name || name === "nan" || name === "板块名称") continue;

    const pctChg = safeFloat(cols[3]);
    const inflow = round2(safeFloat(cols[4]));
    const outflow = round2(safeFloat(cols[5]));
    const netFlow = round2(safeFloat(cols[6]));
    const companyCnt = Math.trunc(safeFloat(cols[7], 0));
    const leadStock = cols.length > 8 ? cols[8] : "";
    const leadPct = cols.length > 9 ? round2(safeFloat(cols[9])) : 0.0;
    const turnover = round2(inflow + outflow);
    const netRatio = turnover > 0 ? round2((netFlow / turnover) * 100.0) : 0.0;

    items.push({
      code: name,
      name,
      pct_chg: round2(pctChg),
      inflow,
      outflow,
      net_flow: netFlow,
      net_ratio: netRatio,
      turnover,
      company_count: companyCnt,
      lead_stock: leadStock,
      lead_pct: leadPct,
      quadrant: classifyQuadrant(pctChg, netFlow),
    });
  }
  return { items, totalPages };
}

async function fetchThsBoardPage(board, order, page, field = "je") {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const vCode = generateThsToken();
      const url = `http://data.10jqka.com.cn/funds/${board}/field/${field}/order/${order}/page/${page}/ajax/1/free/1/`;
      const resp = await fetch(url, {
        headers: {
          Accept: "text/html, */*; q=0.01",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          "hexin-v": vCode,
          Referer: `http://data.10jqka.com.cn/funds/${board}/`,
          "User-Agent": HEADERS_BROWSER["User-Agent"],
          "X-Requested-With": "XMLHttpRequest",
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) continue;
      const buf = await resp.arrayBuffer();
      const ct = (resp.headers.get("content-type") || "").toLowerCase();
      const html = decodeBuffer(buf, ct.includes("gb"));
      const parsed = parseThsBoardHtml(html);
      if (parsed.items.length > 0) {
        return parsed;
      }
      if (html.includes("<table") && attempt === 0) {
        // Retry once on THS intermittent empty table
        continue;
      }
      return { items: [], totalPages: parsed.totalPages };
    } catch {
      // Retry on transient error
    }
  }
  return { items: [], totalPages: 1 };
}

async function fetchSinaSectorFallback(fenlei) {
  const merged = {};
  const fetches = [0, 1].map(async (asc) => {
    const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_bk?page=1&num=200&sort=netamount&asc=${asc}&fenlei=${fenlei}`;
    try {
      const resp = await fetch(url, {
        headers: HEADERS_BROWSER,
        signal: AbortSignal.timeout(9000),
      });
      if (!resp.ok) return;
      const rows = await resp.json();
      if (!Array.isArray(rows)) return;
      for (const x of rows) {
        const name = String(x?.name || "").trim();
        if (!name) continue;
        const pctChg = round2(safeFloat(x.avg_changeratio) * 100.0);
        const inflow = round2(safeFloat(x.inamount) / 1e8);
        const outflow = round2(safeFloat(x.outamount) / 1e8);
        const netFlow = round2(safeFloat(x.netamount) / 1e8);
        const turnover = round2(inflow + outflow);
        const netRatio = turnover > 0 ? round2((netFlow / turnover) * 100.0) : 0.0;
        merged[name] = {
          code: String(x.category || name),
          name,
          pct_chg: pctChg,
          inflow,
          outflow,
          net_flow: netFlow,
          net_ratio: netRatio,
          turnover,
          company_count: 0,
          lead_stock: String(x.ts_name || "").trim(),
          lead_pct: round2(safeFloat(x.ts_changeratio) * 100.0),
          quadrant: classifyQuadrant(pctChg, netFlow),
        };
      }
    } catch {
      // Ignore single leg failure
    }
  });
  await Promise.all(fetches);
  return Object.values(merged).sort((a, b) => b.net_flow - a.net_flow);
}

async function getCnIndustriesAndConcepts(prevPayload) {
  let indSrc = "同花顺";
  let conSrc = "同花顺";

  // 1. Industries (90 across 2 pages)
  const indMap = {};
  const [indP1, indP2] = await Promise.all([
    fetchThsBoardPage("hyzjl", "desc", 1),
    fetchThsBoardPage("hyzjl", "desc", 2),
  ]);
  for (const r of [...indP1.items, ...indP2.items]) {
    indMap[r.name] = r;
  }
  let industries = [];
  if (Object.keys(indMap).length >= 30) {
    industries = Object.values(indMap).sort((a, b) => b.net_flow - a.net_flow);
  } else {
    industries = await fetchSinaSectorFallback(0);
    indSrc = industries.length > 0 ? "新浪" : "无数据";
  }

  // 2. Concepts (all pages from gnzjl)
  const conMap = {};
  const firstCon = await fetchThsBoardPage("gnzjl", "desc", 1);
  let hasEmptyPage = firstCon.items.length === 0;
  for (const r of firstCon.items) {
    if (!isNoiseConcept(r.name)) conMap[r.name] = r;
  }

  const totalPages = Math.min(Math.max(firstCon.totalPages || 1, 1), 10);
  if (totalPages > 1) {
    const batch1 = [];
    const batch2 = [];
    for (let p = 2; p <= totalPages; p++) {
      if (p <= 5) batch1.push(p);
      else batch2.push(p);
    }
    const r1 = await Promise.all(batch1.map((p) => fetchThsBoardPage("gnzjl", "desc", p)));
    const r2 = await Promise.all(batch2.map((p) => fetchThsBoardPage("gnzjl", "desc", p)));
    for (const res of [...r1, ...r2]) {
      if (res.items.length === 0) hasEmptyPage = true;
      for (const r of res.items) {
        if (!isNoiseConcept(r.name)) conMap[r.name] = r;
      }
    }
  }

  if ((hasEmptyPage || Object.keys(conMap).length < 340) && Object.keys(conMap).length > 0) {
    const [a1, a2, zDesc, zAsc] = await Promise.all([
      fetchThsBoardPage("gnzjl", "asc", 1),
      fetchThsBoardPage("gnzjl", "asc", 2),
      fetchThsBoardPage("gnzjl", "desc", 1, "tradezdf"),
      fetchThsBoardPage("gnzjl", "asc", 1, "tradezdf"),
    ]);
    for (const r of [...a1.items, ...a2.items]) {
      if (!isNoiseConcept(r.name)) conMap[r.name] = r;
    }
    for (const r of [...zDesc.items, ...zAsc.items]) {
      if (!isNoiseConcept(r.name) && !conMap[r.name]) conMap[r.name] = r;
    }
  }

  let concepts = [];
  const freshConCount = Object.keys(conMap).length;
  const prevConcepts = Array.isArray(prevPayload?.concepts) ? prevPayload.concepts : [];
  if ((hasEmptyPage || freshConCount < 340) && freshConCount >= 150 && prevConcepts.length >= 250) {
    const merged = {};
    for (const r of prevConcepts) {
      if (!isNoiseConcept(r.name)) merged[r.name] = r;
    }
    Object.assign(merged, conMap);
    concepts = Object.values(merged).sort((a, b) => b.net_flow - a.net_flow);
  } else if (freshConCount >= 200) {
    concepts = Object.values(conMap).sort((a, b) => b.net_flow - a.net_flow);
  } else if (freshConCount >= 20) {
    concepts = Object.values(conMap).sort((a, b) => b.net_flow - a.net_flow);
  } else {
    const rawSina = await fetchSinaSectorFallback(1);
    concepts = rawSina.filter((r) => !isNoiseConcept(r.name));
    conSrc = concepts.length > 0 ? "新浪" : "无数据";
  }

  const source =
    indSrc === conSrc ? `${indSrc}实时资金流` : `行业:${indSrc} / 题材:${conSrc}`;
  return { industries, concepts, source };
}

async function getCnRealtimeEtfsAndIndices(universe) {
  const cnCfg = universe?.CN || {};
  const indicesCfg = cnCfg.indices || [];
  const etfsCfg = cnCfg.etfs || [];

  const idxSymbols = indicesCfg.map((idx) => `${idx.prefix}${idx.code}`);
  const etfSymMap = {};
  for (const e of etfsCfg) {
    const prefix = e.exchange === "SSE" ? "sh" : "sz";
    etfSymMap[`${prefix}${e.code}`] = e;
  }

  const quotes = await fetchTencentQuotes([...idxSymbols, ...Object.keys(etfSymMap)]);
  let latestTime = "";

  const indicesOut = [];
  for (const idx of indicesCfg) {
    const p = quotes[`${idx.prefix}${idx.code}`];
    if (!p) continue;
    const rawT = String(p[30] || "").trim();
    if (rawT.length === 14) {
      latestTime = `${rawT.slice(0, 4)}-${rawT.slice(4, 6)}-${rawT.slice(6, 8)} ${rawT.slice(8, 10)}:${rawT.slice(10, 12)}:${rawT.slice(12, 14)}`;
    }
    indicesOut.push({
      code: idx.code,
      name: idx.name,
      close: round2(safeFloat(p[3])),
      pct_chg: round2(safeFloat(p[32])),
    });
  }

  const etfsOut = [];
  for (const [sym, meta] of Object.entries(etfSymMap)) {
    const p = quotes[sym];
    if (!p) continue;
    const price = round3(safeFloat(p[3]));
    const pctChg = round2(safeFloat(p[32]));
    const totalVol = safeFloat(p[6]);
    const outerVol = safeFloat(p[7]);
    const innerVol = safeFloat(p[8]);

    let turnoverYuan = 0.0;
    if (p.length > 35 && String(p[35]).includes("/")) {
      const parts35 = String(p[35]).split("/");
      if (parts35.length >= 3) turnoverYuan = safeFloat(parts35[2]);
    }
    if (turnoverYuan <= 0 && p.length > 37) {
      turnoverYuan = safeFloat(p[37]) * 10000.0;
    }
    const turnoverYi = round2(turnoverYuan / 1e8);
    const activeRatio = totalVol > 0 ? round2(((outerVol - innerVol) / totalVol) * 100.0) : 0.0;
    const activeNetFlow = round2((turnoverYi * activeRatio) / 100.0);
    const inflowYi = round2((turnoverYi + activeNetFlow) / 2.0);
    const outflowYi = round2((turnoverYi - activeNetFlow) / 2.0);
    const turnoverRate = p.length > 38 ? round2(safeFloat(p[38])) : 0.0;
    const volRatio = p.length > 49 ? round2(safeFloat(p[49], 1.0)) : 1.0;
    const discountPct = p.length > 77 ? round2(safeFloat(p[77])) : 0.0;
    const iopv = p.length > 78 ? round3(safeFloat(p[78], price)) : price;

    etfsOut.push({
      code: meta.code,
      name: meta.name,
      category: meta.category,
      cluster_name: meta.cluster_name,
      price,
      pct_chg: pctChg,
      net_flow: activeNetFlow,
      net_ratio: activeRatio,
      inflow: inflowYi,
      outflow: outflowYi,
      turnover: turnoverYi,
      vol_ratio: volRatio,
      turnover_rate: turnoverRate,
      discount_pct: discountPct,
      iopv,
      quadrant: classifyQuadrant(pctChg, activeNetFlow),
    });
  }
  etfsOut.sort((a, b) => b.net_flow - a.net_flow);
  return { indices: indicesOut, etfs: etfsOut, quoteTime: latestTime };
}

function computeUsEtfFlowMetrics(fields) {
  const price = safeFloat(fields[3]);
  const pctChg = safeFloat(fields[32]);
  const high = safeFloat(fields[33], price);
  const low = safeFloat(fields[34], price);
  const amountUsd = safeFloat(fields[37]);
  const turnoverM = round2(amountUsd / 1e6);

  const spread = Math.max(high - low, 0.0001);
  let clv = ((price - low) - (high - price)) / spread;
  clv = Math.max(-1.0, Math.min(1.0, clv));
  const pctComp = Math.max(-1.0, Math.min(1.0, pctChg / 2.5));
  const mfm = Math.max(-0.85, Math.min(0.85, 0.55 * clv + 0.45 * pctComp));

  const netFlow = round2(turnoverM * mfm * 0.4);
  const inflow = round2((turnoverM + netFlow) / 2.0);
  const outflow = round2((turnoverM - netFlow) / 2.0);
  const netRatio = turnoverM > 0 ? round2((netFlow / turnoverM) * 100.0) : 0.0;
  const amp = fields.length > 43 ? round2(safeFloat(fields[43])) : 0.0;

  return {
    price: round2(price),
    pct_chg: round2(pctChg),
    turnover: turnoverM,
    inflow,
    outflow,
    net_flow: netFlow,
    net_ratio: netRatio,
    amplitude: amp,
  };
}

async function getUsRealtimeAll(universe) {
  const usEtfsCfg = universe?.US?.etfs || [];
  const symSet = new Set(["us.INX", "us.IXIC", "us.DJI", "usIWM"]);
  for (const item of [...US_REALTIME_SECTORS, ...US_REALTIME_THEMES]) {
    symSet.add(`us${item.code}`);
    for (const leader of item.leaders) symSet.add(`us${leader}`);
  }
  for (const e of usEtfsCfg) symSet.add(`us${e.code}`);

  const quotes = await fetchTencentQuotes([...symSet].sort());
  let latestTime = "";

  const indexDefs = [
    ["us.INX", "^GSPC", "标普500"],
    ["us.IXIC", "^IXIC", "纳斯达克综合"],
    ["us.DJI", "^DJI", "道琼斯工业"],
    ["usIWM", "IWM", "罗素2000 ETF"],
  ];
  const indicesOut = [];
  for (const [qSym, code, name] of indexDefs) {
    const p = quotes[qSym];
    if (!p) continue;
    if (p.length > 30 && p[30]) latestTime = String(p[30]).trim();
    indicesOut.push({
      code,
      name,
      close: round2(safeFloat(p[3])),
      pct_chg: round2(safeFloat(p[32])),
    });
  }

  function buildBoardItems(defs) {
    const out = [];
    for (const item of defs) {
      const p = quotes[`us${item.code}`];
      if (!p) continue;
      const m = computeUsEtfFlowMetrics(p);
      let bestLeader = "";
      let bestLeaderPct = -999.0;
      for (const lSym of item.leaders) {
        const lp = quotes[`us${lSym}`];
        if (!lp) continue;
        const lPct = round2(safeFloat(lp[32]));
        if (lPct > bestLeaderPct) {
          bestLeaderPct = lPct;
          bestLeader = lSym;
        }
      }
      if (bestLeaderPct === -999.0) bestLeaderPct = 0.0;
      out.push({
        code: item.code,
        name: item.name,
        price: m.price,
        pct_chg: m.pct_chg,
        inflow: m.inflow,
        outflow: m.outflow,
        net_flow: m.net_flow,
        net_ratio: m.net_ratio,
        turnover: m.turnover,
        company_count: item.leaders.length,
        lead_stock: bestLeader,
        lead_pct: bestLeaderPct,
        quadrant: classifyQuadrant(m.pct_chg, m.net_flow),
      });
    }
    return out.sort((a, b) => b.net_flow - a.net_flow);
  }

  const industries = buildBoardItems(US_REALTIME_SECTORS);
  const concepts = buildBoardItems(US_REALTIME_THEMES);

  const etfsOut = [];
  for (const meta of usEtfsCfg) {
    const p = quotes[`us${meta.code}`];
    if (!p) continue;
    const m = computeUsEtfFlowMetrics(p);
    etfsOut.push({
      code: meta.code,
      name: meta.name,
      category: meta.category,
      cluster_name: meta.cluster_name,
      price: m.price,
      pct_chg: m.pct_chg,
      net_flow: m.net_flow,
      net_ratio: m.net_ratio,
      inflow: m.inflow,
      outflow: m.outflow,
      turnover: m.turnover,
      vol_ratio: 1.0,
      turnover_rate: m.amplitude,
      discount_pct: 0.0,
      iopv: m.price,
      quadrant: classifyQuadrant(m.pct_chg, m.net_flow),
    });
  }
  etfsOut.sort((a, b) => b.net_flow - a.net_flow);
  return { indices: indicesOut, industries, concepts, etfs: etfsOut, quoteTime: latestTime };
}

function buildRealtimeInsights(market, unit, indices, industries, concepts, etfs, sessionInfo) {
  const idxText = indices
    .slice(0, 3)
    .map((x) => `${x.name} **${x.close}**（**${fmtSigned(x.pct_chg, 2, "%")}**）`)
    .join("；");
  const indIn = industries
    .slice(0, 3)
    .map((x) => `${x.name}(${fmtSigned(x.net_flow, 2, unit)}, ${fmtSigned(x.pct_chg, 2, "%")})`)
    .join("、");
  const indOut = [...industries]
    .sort((a, b) => a.net_flow - b.net_flow)
    .slice(0, 3)
    .map((x) => `${x.name}(${fmtSigned(x.net_flow, 2, unit)}, ${fmtSigned(x.pct_chg, 2, "%")})`)
    .join("、");
  const conIn = concepts
    .slice(0, 3)
    .map((x) => `${x.name}(${fmtSigned(x.net_flow, 2, unit)}, ${fmtSigned(x.pct_chg, 2, "%")})`)
    .join("、");
  const conOut = [...concepts]
    .sort((a, b) => a.net_flow - b.net_flow)
    .slice(0, 3)
    .map((x) => `${x.name}(${fmtSigned(x.net_flow, 2, unit)}, ${fmtSigned(x.pct_chg, 2, "%")})`)
    .join("、");

  const broadSum = round2(
    etfs.filter((e) => e.category === "broad").reduce((s, e) => s + e.net_flow, 0)
  );
  const topEtf = etfs[0] || null;
  const botEtf = etfs[etfs.length - 1] || null;
  const indUpCnt = industries.filter((x) => x.net_flow > 0).length;
  const conUpCnt = concepts.filter((x) => x.net_flow > 0).length;

  let etfDetail = "";
  if (topEtf && botEtf) {
    etfDetail =
      `主动净买入居首的是 **${topEtf.name}**（${fmtSigned(topEtf.net_flow, 2, unit)}，` +
      `涨跌 ${fmtSigned(topEtf.pct_chg, 2, "%")}）；承压居前的是 **${botEtf.name}**（${fmtSigned(botEtf.net_flow, 2, unit)}）。`;
  }

  const methodNote =
    market === "CN"
      ? "行业/概念为同花顺/新浪主力净额；场内ETF采用内外盘主动买卖额口径"
      : "基于腾讯实时行情与日内量价资金流乘数（MFM × 成交额）测算";
  const tag = sessionInfo.short_tag || "";

  return [
    {
      title: `大盘走势与资金广度（${tag}）`,
      body: `${idxText}。资金广度：行业净流入 **${indUpCnt}/${industries.length}** 个，概念题材净流入 **${conUpCnt}/${concepts.length}** 个（${methodNote}）。`,
    },
    {
      title: "分行业资金主线",
      body: `主力净流入前三行业：${indIn || "暂无"}；净流出前三行业：${indOut || "暂无"}。`,
    },
    {
      title: "分题材 / 概念热点",
      body: `资金抢筹前三题材：${conIn || "暂无"}；资金撤离前三题材：${conOut || "暂无"}。`,
    },
    {
      title: "监控池 ETF 主动资金动向",
      body: `宽基 ETF 主动净流向合计 **${fmtSigned(broadSum, 2, unit)}**。${etfDetail}`,
    },
  ];
}

async function handleRealtime(market, force, env, ctx) {
  const m = market === "US" ? "US" : "CN";
  const cooldownSec = Math.max(1, Number(env.ROOFTOP_RT_FORCE_COOLDOWN || 15));
  const nowSec = Date.now() / 1000;
  const kvKey = `rt:${m}`;

  let cachedEntry = EDGE_MEM_CACHE.get(kvKey) || null;
  if (!cachedEntry && env.ETF_KV) {
    try {
      cachedEntry = await env.ETF_KV.get(kvKey, "json");
      if (cachedEntry?.ts && cachedEntry?.payload) {
        EDGE_MEM_CACHE.set(kvKey, cachedEntry);
      }
    } catch {
      cachedEntry = null;
    }
  }

  if (cachedEntry && cachedEntry.ts && cachedEntry.payload) {
    const age = nowSec - cachedEntry.ts;
    if (!force && age < CACHE_TTL_SECONDS) {
      return jsonResponse({
        ...cachedEntry.payload,
        session: evaluateMarketSessionStatus(m, cachedEntry.payload.quote_time || ""),
        from_cache: true,
        cooldown_throttled: false,
        cooldown_remaining: 0.0,
      });
    }
    if (force && age < cooldownSec) {
      return jsonResponse({
        ...cachedEntry.payload,
        session: evaluateMarketSessionStatus(m, cachedEntry.payload.quote_time || ""),
        from_cache: true,
        cooldown_throttled: true,
        cooldown_remaining: round1(Math.max(0.0, cooldownSec - age)),
      });
    }
  }

  const universe = (env.ETF_KV && (await env.ETF_KV.get("universe", "json"))) || {
    CN: { indices: [], etfs: [] },
    US: { indices: [], etfs: [] },
  };

  let unit, currency, indices, industries, concepts, etfs, quoteTime, source;
  if (m === "CN") {
    unit = "亿元";
    currency = "RMB";
    const [qRes, bRes] = await Promise.all([
      getCnRealtimeEtfsAndIndices(universe),
      getCnIndustriesAndConcepts(cachedEntry?.payload || null),
    ]);
    indices = qRes.indices;
    etfs = qRes.etfs;
    quoteTime = qRes.quoteTime;
    industries = bRes.industries;
    concepts = bRes.concepts;
    source = bRes.source;
  } else {
    unit = "百万美元";
    currency = "USD";
    const usRes = await getUsRealtimeAll(universe);
    indices = usRes.indices;
    industries = usRes.industries;
    concepts = usRes.concepts;
    etfs = usRes.etfs;
    quoteTime = usRes.quoteTime;
    source = "腾讯美股实时行情 + 日内资金流模型 (MFM)";
  }

  const cnNow = getZonedNowParts("Asia/Shanghai");
  if (!quoteTime) quoteTime = cnNow.nowStr;
  const sessionInfo = evaluateMarketSessionStatus(m, quoteTime);

  const totalEtfActive = round2(etfs.reduce((s, e) => s + e.net_flow, 0));
  const totalBroadActive = round2(
    etfs.filter((e) => e.category === "broad").reduce((s, e) => s + e.net_flow, 0)
  );
  const indInCnt = industries.filter((x) => x.net_flow > 0).length;
  const conInCnt = concepts.filter((x) => x.net_flow > 0).length;

  const seenQp = new Set();
  const dedupQp = [];
  for (const pt of [
    ...industries.map((x) => ({ ...x, kind: "行业" })),
    ...concepts.map((x) => ({ ...x, kind: "题材" })),
  ]) {
    const k = `${pt.kind}:${pt.name}`;
    if (!seenQp.has(k)) {
      seenQp.add(k);
      dedupQp.push(pt);
    }
  }

  const payload = {
    market: m,
    currency,
    unit,
    source,
    quote_time: quoteTime,
    fetched_at: cnNow.nowStr,
    from_cache: false,
    cooldown_throttled: false,
    cooldown_remaining: 0.0,
    session: sessionInfo,
    indices,
    summary: {
      top_industry: industries[0] || null,
      bottom_industry: industries[industries.length - 1] || null,
      top_concept: concepts[0] || null,
      bottom_concept: concepts[concepts.length - 1] || null,
      total_etf_active_flow: totalEtfActive,
      total_broad_active_flow: totalBroadActive,
      industry_in_count: indInCnt,
      industry_total: industries.length,
      concept_in_count: conInCnt,
      concept_total: concepts.length,
    },
    insights: buildRealtimeInsights(m, unit, indices, industries, concepts, etfs, sessionInfo),
    industries,
    concepts,
    quadrant_points: dedupQp,
    etfs,
  };

  const entry = { ts: Date.now() / 1000, payload };
  EDGE_MEM_CACHE.set(kvKey, entry);
  if (env.ETF_KV) {
    const putPromise = env.ETF_KV.put(kvKey, JSON.stringify(entry), {
      expirationTtl: 300,
    }).catch(() => {});
    if (ctx?.waitUntil) {
      ctx.waitUntil(putPromise);
    }
  }
  return jsonResponse(payload);
}

async function serveStaticAsset(assetPath, request, env) {
  const url = new URL(request.url);
  let resp = null;
  if (env.ASSETS) {
    try {
      const candidate = await env.ASSETS.fetch(new Request(new URL(assetPath, url), request));
      if (candidate.ok) resp = candidate;
    } catch {
      resp = null;
    }
  }

  let bodyText = null;
  if (!resp && env.ETF_KV) {
    bodyText = await env.ETF_KV.get(`asset:${assetPath}`);
  }

  if (!resp && bodyText === null) {
    return new Response("Not Found", { status: 404 });
  }

  const ext = assetPath.split(".").pop()?.toLowerCase();
  const contentType =
    ext === "html"
      ? "text/html; charset=utf-8"
      : ext === "css"
        ? "text/css; charset=utf-8"
        : ext === "js"
          ? "application/javascript; charset=utf-8"
          : "application/octet-stream";

  const headers = new Headers(resp ? resp.headers : undefined);
  headers.set("Content-Type", contentType);
  if (assetPath === "/index.html") {
    headers.set("Cache-Control", "no-cache, must-revalidate");
  }
  return new Response(resp ? resp.body : bodyText, { status: 200, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return serveStaticAsset("/index.html", request, env);
    }

    if (request.method === "GET" && pathname.startsWith("/static/")) {
      const subPath = pathname.slice("/static".length);
      if (!subPath || subPath.includes("..")) {
        return new Response("Bad Request", { status: 400 });
      }
      return serveStaticAsset(subPath, request, env);
    }

    if (request.method === "GET" && pathname === "/api/health") {
      return jsonResponse({
        status: "ok",
        version: APP_VERSION,
        runtime: "cloudflare-workers",
        admin_protected: Boolean(String(env.ROOFTOP_ADMIN_TOKEN || "").trim()),
      });
    }

    if (request.method === "GET" && pathname === "/api/v1/etf-flow/dashboard") {
      const market = (searchParams.get("market") || "CN").toUpperCase() === "US" ? "US" : "CN";
      const rawPeriod = searchParams.get("period") || "5d";
      const period = ["1d", "5d", "20d", "60d"].includes(rawPeriod) ? rawPeriod : "5d";
      const raw = await env.ETF_KV.get(`dash:${market}:${period}`);
      if (!raw) {
        return jsonResponse({ detail: "盘后快照尚未同步，请等待 GitHub Actions 同步完成" }, 503);
      }
      return new Response(raw, {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (request.method === "GET" && pathname === "/api/v1/etf-flow/realtime") {
      const market = (searchParams.get("market") || "CN").toUpperCase();
      const force = searchParams.get("force") === "true";
      return handleRealtime(market, force, env, ctx);
    }

    if (request.method === "GET" && pathname.startsWith("/api/v1/etf-flow/etf/")) {
      const parts = pathname.slice("/api/v1/etf-flow/etf/".length).split("/");
      if (parts.length !== 2) return jsonResponse({ detail: "Invalid ETF path" }, 400);
      const market = parts[0].toUpperCase() === "US" ? "US" : "CN";
      const code = decodeURIComponent(parts[1]).toUpperCase();
      const detailsMap = await env.ETF_KV.get(`etfs:${market}`, "json");
      const item = detailsMap?.[code];
      if (!item) {
        return jsonResponse({ detail: `ETF ${market}:${code} not found` }, 404);
      }
      return jsonResponse(item);
    }

    if (request.method === "GET" && pathname === "/api/v1/etf-flow/universe") {
      const raw = await env.ETF_KV.get("universe");
      return new Response(raw || '{"CN":{},"US":{}}', {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (request.method === "GET" && pathname === "/api/v1/etf-flow/sync/status") {
      const raw = await env.ETF_KV.get("sync_status");
      return new Response(raw || '{"running":false}', {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (request.method === "GET" && pathname === "/api/v1/etf-flow/report") {
      const content = (await env.ETF_KV.get("report")) || "";
      return jsonResponse({
        path: "cloudflare-kv://docs/reports/latest_analysis_report.md",
        content,
      });
    }

    if (request.method === "GET" && pathname === "/api/v1/etf-flow/report/download") {
      const content = (await env.ETF_KV.get("report")) || "";
      return new Response(content, {
        status: 200,
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": "attachment; filename=rooftop_etf_flow_report.md",
        },
      });
    }

    if (request.method === "POST" && pathname === "/api/v1/etf-flow/sync") {
      if (!(await verifyAdminToken(request, env))) {
        return jsonResponse({ detail: "管理员口令错误或未提供，请先输入口令后再执行此操作" }, 401);
      }
      const syncStatus = (await env.ETF_KV.get("sync_status", "json")) || {};
      if (env.GITHUB_PAT && env.GITHUB_REPO) {
        const ghResp = await fetch(
          `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/sync-postmarket.yml/dispatches`,
          {
            method: "POST",
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${env.GITHUB_PAT}`,
              "User-Agent": "rooftop-etf-flow-worker",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            body: JSON.stringify({ ref: "main", inputs: { days: "30" } }),
          }
        );
        if (ghResp.ok) {
          return jsonResponse({
            status: "dispatched",
            message: "已触发 GitHub Actions 云端同步，约 1~2 分钟后刷新页面即可看到最新份额数据",
            results: syncStatus.results || { CN: syncStatus.CN, US: syncStatus.US },
          });
        }
      }
      return jsonResponse({
        status: "ok",
        mode: "kv_snapshot",
        message: "公网盘后数据由 GitHub Actions 按 08:40 / 17:30 / 21:00 自动更新，当前已加载最新云端快照",
        results: syncStatus.results || { CN: syncStatus.CN, US: syncStatus.US },
      });
    }

    if (request.method === "POST" && pathname === "/api/v1/etf-flow/admin/kv-seed") {
      if (!(await verifyAdminToken(request, env))) {
        return jsonResponse({ detail: "管理员口令错误或未提供" }, 401);
      }
      let body = null;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ detail: "Invalid JSON body" }, 400);
      }
      const items = Array.isArray(body?.items) ? body.items : [];
      const allowedExact = new Set(["universe", "sync_status", "report"]);
      const allowedPrefixes = ["dash:", "etfs:", "asset:/"];
      let written = 0;
      for (const it of items) {
        const k = String(it?.key || "");
        const v = typeof it?.value === "string" ? it.value : "";
        const ok =
          allowedExact.has(k) || allowedPrefixes.some((pfx) => k.startsWith(pfx));
        if (!ok || !v) continue;
        await env.ETF_KV.put(k, v);
        written++;
      }
      return jsonResponse({ status: "ok", written });
    }

    if (request.method === "POST" && pathname === "/api/v1/etf-flow/universe/add") {
      if (!(await verifyAdminToken(request, env))) {
        return jsonResponse({ detail: "管理员口令错误或未提供，请先输入口令后再执行此操作" }, 401);
      }
      return jsonResponse(
        {
          detail:
            "公网边缘版暂不支持直接回写代码仓库配置，请在本地或 GitHub 更新 config/etf_universe.json 后推送 main 自动部署。",
        },
        501
      );
    }

    return jsonResponse({ detail: "Not Found" }, 404);
  },
};
