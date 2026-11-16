(() => {
  const state = {
    viewMode: "postmarket", // "postmarket" | "realtime"
    market: "CN",
    period: "5d",
    categoryFilter: "all",
    search: "",
    sortKey: "net_flow",
    sortDesc: true,
    data: null,

    rtData: null,
    rtTab: "industries", // "industries" | "concepts" | "etfs"
    rtSearch: "",
    rtSortKey: "net_flow",
    rtSortDesc: true,
    rtAutoRefresh: false,
    rtTimer: null,
  };

  const charts = {
    timeseries: null,
    clusters: null,
    sectors: null,
    quadrant: null,
    detail: null,
    rtIndustries: null,
    rtConcepts: null,
    rtQuadrant: null,
    rtEtfs: null,
  };

  function isPositiveRed(market) {
    return market === "CN";
  }

  function colorForVal(val, market) {
    if (val > 0) return isPositiveRed(market) ? "#f23645" : "#089981";
    if (val < 0) return isPositiveRed(market) ? "#089981" : "#f23645";
    return "#8b98aa";
  }

  function classForVal(val, market) {
    if (val > 0) return isPositiveRed(market) ? "text-[#f23645]" : "text-[#089981]";
    if (val < 0) return isPositiveRed(market) ? "text-[#089981]" : "text-[#f23645]";
    return "text-[#8b98aa]";
  }

  function fmtSigned(val, decimals = 2, suffix = "") {
    if (val === null || val === undefined || Number.isNaN(val)) return "--";
    const num = Number(val);
    const sign = num > 0 ? "+" : "";
    return `${sign}${num.toFixed(decimals)}${suffix}`;
  }

  function fmtNum(val, decimals = 2) {
    if (val === null || val === undefined || Number.isNaN(val)) return "--";
    return Number(val).toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function renderMarkdownBold(text) {
    return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong class="text-white font-semibold">$1</strong>');
  }

  function getOrInitChart(key, domId) {
    if (!charts[key]) {
      const el = document.getElementById(domId);
      if (el) {
        charts[key] = echarts.init(el);
      }
    }
    return charts[key];
  }

  function resizeAllCharts() {
    Object.values(charts).forEach((c) => {
      if (c) c.resize();
    });
  }

  // ==================== POST-MARKET DASHBOARD ====================

  async function loadDashboard() {
    const res = await fetch(`/api/v1/etf-flow/dashboard?market=${state.market}&period=${state.period}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    renderAll();
  }

  function renderAll() {
    const d = state.data;
    if (!d) return;

    document.getElementById("lbl-flow-window").textContent =
      d.flow_start_date && d.flow_end_date
        ? `${d.flow_start_date} ~ ${d.flow_end_date} (${d.period_label})`
        : "--";
    document.getElementById("lbl-price-date").textContent = d.latest_price_date || "--";

    document.getElementById("unit-badge-1").textContent = d.unit;
    document.getElementById("unit-badge-2").textContent = d.unit;
    document.getElementById("lbl-core-title").textContent =
      d.market === "CN" ? "核心护盘宽基 (300/50/500/1000)" : "核心配置宽基 (SPY/VOO/IVV)";

    renderIndices(d);
    renderKpis(d);
    renderInsights(d, "insights-grid");
    renderTimeSeriesChart(d);
    renderClustersChart(d);
    renderSectorsChart(d);
    renderQuadrantChart(d);
    renderTable();
  }

  function renderIndices(d) {
    const container = document.getElementById("indices-strip");
    container.innerHTML = d.indices
      .map((idx) => {
        const latestCls = classForVal(idx.latest_pct_chg, d.market);
        const periodCls = classForVal(idx.period_pct_chg, d.market);
        return `
          <div class="card-panel px-3.5 py-3">
            <div class="flex items-center justify-between text-xs">
              <span class="font-semibold text-[#d8e1ea]">${escapeHtml(idx.name)}</span>
              <span class="text-[11px] text-[#787b86]">${escapeHtml(idx.code)}</span>
            </div>
            <div class="flex items-baseline justify-between mt-1.5 tabular-nums">
              <span class="text-lg font-bold text-white">${fmtNum(idx.latest_close, 2)}</span>
              <span class="text-xs font-semibold ${latestCls}">${fmtSigned(idx.latest_pct_chg, 2, "%")} <span class="text-[10px] text-[#787b86] font-normal">日</span></span>
            </div>
            <div class="flex items-center justify-between mt-1 text-[11px] text-[#8b98aa] tabular-nums">
              <span>${d.period.toUpperCase()}涨跌：<strong class="${periodCls}">${fmtSigned(idx.period_pct_chg, 2, "%")}</strong></span>
              <span>${fmtNum(idx.period_low, 0)}~${fmtNum(idx.period_high, 0)}</span>
            </div>
          </div>
        `;
      })
      .join("");
  }

  function renderKpis(d) {
    const s = d.summary;
    const u = d.unit;

    const elBroad = document.getElementById("kpi-broad-flow");
    elBroad.textContent = fmtSigned(s.total_broad_flow, 2, ` ${u}`);
    elBroad.className = `text-2xl font-bold mt-1.5 tabular-nums ${classForVal(s.total_broad_flow, d.market)}`;

    const elCore = document.getElementById("kpi-core-flow");
    elCore.textContent = fmtSigned(s.total_core_flow, 2, ` ${u}`);
    elCore.className = `text-2xl font-bold mt-1.5 tabular-nums ${classForVal(s.total_core_flow, d.market)}`;

    const badge = document.getElementById("kpi-stance-badge");
    badge.textContent = s.stance_label;
    if (s.stance_tone === "bullish") {
      badge.className = "badge-tag bg-[#f23645]/15 text-[#f23645] border border-[#f23645]/35";
    } else if (s.stance_tone === "caution" || s.stance_tone === "bearish") {
      badge.className = "badge-tag bg-[#089981]/15 text-[#089981] border border-[#089981]/35";
    } else {
      badge.className = "badge-tag bg-[#2dd4bf]/15 text-[#5eead4] border border-[#2dd4bf]/45";
    }

    const anchorEl = document.getElementById("kpi-anchor-point");
    if (s.weighted_anchor_point !== null && s.weighted_anchor_point !== undefined) {
      const idxName = d.market === "CN" ? "沪深300" : "标普500";
      let txt = `正流入加权点位锚：${idxName} ${fmtNum(s.weighted_anchor_point, 2)}`;
      if (d.market === "CN" && s.weighted_alt_point) {
        txt += ` / 上证 ${fmtNum(s.weighted_alt_point, 2)}`;
      }
      anchorEl.textContent = txt;
    } else {
      anchorEl.textContent = "加权买入点位锚：周期内无正流入交易日";
    }

    const elSector = document.getElementById("kpi-sector-flow");
    elSector.textContent = fmtSigned(s.total_sector_flow, 2, ` ${u}`);
    elSector.className = `text-2xl font-bold mt-1.5 tabular-nums ${classForVal(s.total_sector_flow, d.market)}`;
    document.getElementById("kpi-macro-sub").textContent = `跨境/宏观避险锚净流入：${fmtSigned(s.total_macro_flow, 2, ` ${u}`)}`;

    const elLarge = document.getElementById("kpi-large-flow");
    elLarge.textContent = fmtSigned(s.large_flow, 1, u);
    elLarge.className = `text-lg font-bold tabular-nums ${classForVal(s.large_flow, d.market)}`;

    const elSmall = document.getElementById("kpi-small-flow");
    elSmall.textContent = fmtSigned(s.small_growth_flow, 1, u);
    elSmall.className = `text-lg font-bold tabular-nums ${classForVal(s.small_growth_flow, d.market)}`;

    const styleEl = document.getElementById("kpi-style-verdict");
    styleEl.textContent = s.style_summary;
    styleEl.title = s.style_summary;
  }

  function renderInsights(d, targetId, titleColorClass = "text-[#5eead4]") {
    const grid = document.getElementById(targetId);
    grid.innerHTML = (d.insights || [])
      .map(
        (item) => `
        <div class="zq-insight-card p-3.5">
          <div class="font-semibold ${titleColorClass} mb-1">${escapeHtml(item.title)}</div>
          <div class="text-[#d1d4dc] leading-relaxed">${renderMarkdownBold(item.body)}</div>
        </div>
      `
      )
      .join("");
  }

  function renderTimeSeriesChart(d) {
    const chart = getOrInitChart("timeseries", "chart-timeseries");
    if (!chart) return;

    const ts = d.time_series || [];
    const dates = ts.map((x) => x.trade_date);
    const benchCloses = ts.map((x) => x.bench_close);
    const broadFlows = ts.map((x) => ({
      value: x.broad_flow,
      itemStyle: { color: colorForVal(x.broad_flow, d.market), borderRadius: x.broad_flow >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3] },
    }));
    const coreFlows = ts.map((x) => x.core_flow);

    const benchName = d.market === "CN" ? "沪深300点位" : "标普500点位";
    document.getElementById("chart-ts-title").textContent = `${benchName} vs 宽基每日资金净流向（近60交易日）`;

    const selectedDates = ts.filter((x) => x.in_selected_period).map((x) => x.trade_date);
    const markAreaData =
      selectedDates.length > 0
        ? [
            [
              { xAxis: selectedDates[0], itemStyle: { color: "rgba(45, 212, 191, 0.09)" } },
              { xAxis: selectedDates[selectedDates.length - 1] },
            ],
          ]
        : [];

    const markLineData = [];
    if (d.summary.weighted_anchor_point) {
      markLineData.push({
        yAxis: d.summary.weighted_anchor_point,
        name: "加权流入点位锚",
        lineStyle: { color: "#f59e0b", type: "dashed", width: 1.5 },
        label: { formatter: `加权锚 ${d.summary.weighted_anchor_point}`, color: "#fbbf24", fontSize: 11 },
      });
    }

    chart.setOption(
      {
        tooltip: {
          trigger: "axis",
          axisPointer: { type: "cross" },
          backgroundColor: "#111822",
          borderColor: "#263244",
          textStyle: { color: "#d8e1ea", fontSize: 12 },
          formatter: (params) => {
            if (!params || !params.length) return "";
            const idx = params[0].dataIndex;
            const row = ts[idx];
            return `
              <div style="font-weight:600;margin-bottom:4px;">${row.trade_date}</div>
              <div>${benchName}：<b>${row.bench_close}</b> (${fmtSigned(row.bench_pct, 2, "%")})</div>
              <div>全宽基净流向：<b>${fmtSigned(row.broad_flow, 2, " " + d.unit)}</b></div>
              <div>核心护盘/配置流向：<b>${fmtSigned(row.core_flow, 2, " " + d.unit)}</b></div>
              <div>行业题材合计流向：<b>${fmtSigned(row.sector_flow, 2, " " + d.unit)}</b></div>
            `;
          },
        },
        legend: {
          data: [benchName, "全宽基净流向", "核心护盘/配置"],
          textStyle: { color: "#8b98aa", fontSize: 11 },
          top: 0,
        },
        grid: { left: 52, right: 56, top: 34, bottom: 28 },
        xAxis: {
          type: "category",
          data: dates,
          axisLine: { lineStyle: { color: "#263244" } },
          axisLabel: { color: "#8b98aa", fontSize: 10 },
        },
        yAxis: [
          {
            type: "value",
            name: d.unit,
            nameTextStyle: { color: "#787b86", fontSize: 11 },
            splitLine: { lineStyle: { color: "rgba(148,163,184,0.1)" } },
            axisLabel: { color: "#8b98aa", fontSize: 11 },
          },
          {
            type: "value",
            name: "点位",
            scale: true,
            nameTextStyle: { color: "#787b86", fontSize: 11 },
            splitLine: { show: false },
            axisLabel: { color: "#8b98aa", fontSize: 11 },
          },
        ],
        series: [
          {
            name: "全宽基净流向",
            type: "bar",
            itemStyle: { color: "#8b98aa" },
            data: broadFlows,
            barMaxWidth: 14,
            markArea: { silent: true, data: markAreaData },
          },
          {
            name: "核心护盘/配置",
            type: "line",
            data: coreFlows,
            smooth: 0.25,
            showSymbol: false,
            itemStyle: { color: "#2dd4bf" },
            lineStyle: { color: "#2dd4bf", width: 1.8, type: "dotted" },
          },
          {
            name: benchName,
            type: "line",
            yAxisIndex: 1,
            data: benchCloses,
            smooth: 0.2,
            showSymbol: false,
            itemStyle: { color: "#fbbf24" },
            lineStyle: { color: "#fbbf24", width: 2.2 },
            markLine: { silent: true, symbol: "none", data: markLineData },
          },
        ],
      },
      true
    );
  }

  function renderClustersChart(d) {
    const chart = getOrInitChart("clusters", "chart-clusters");
    if (!chart) return;

    const clusters = [...(d.broad_clusters || [])].reverse();
    const names = clusters.map((c) => c.cluster_name);
    const values = clusters.map((c) => ({
      value: c.net_flow,
      itemStyle: { color: colorForVal(c.net_flow, d.market), borderRadius: c.net_flow >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4] },
    }));

    chart.setOption(
      {
        tooltip: {
          trigger: "axis",
          axisPointer: { type: "shadow" },
          backgroundColor: "#111822",
          borderColor: "#263244",
          textStyle: { color: "#d8e1ea", fontSize: 12 },
          formatter: (params) => {
            const c = clusters[params[0].dataIndex];
            return `
              <div style="font-weight:600;margin-bottom:4px;">${escapeHtml(c.cluster_name)}</div>
              <div>净流向：<b>${fmtSigned(c.net_flow, 2, " " + d.unit)}</b></div>
              <div>占总规模比：<b>${fmtSigned(c.flow_pct_aum, 2, "%")}</b></div>
              <div>加权涨跌：<b>${fmtSigned(c.avg_pct_chg, 2, "%")}</b></div>
              <div>汇总规模：<b>${fmtNum(c.total_aum, 1)} ${d.unit}</b></div>
              <div style="color:#8b98aa;font-size:11px;margin-top:3px;">包含：${c.members.join(", ")}</div>
            `;
          },
        },
        grid: { left: 108, right: 48, top: 14, bottom: 26 },
        xAxis: {
          type: "value",
          splitLine: { lineStyle: { color: "rgba(148,163,184,0.1)" } },
          axisLabel: { color: "#8b98aa", fontSize: 11 },
        },
        yAxis: {
          type: "category",
          data: names,
          axisLine: { lineStyle: { color: "#263244" } },
          axisLabel: { color: "#d8e1ea", fontSize: 12 },
        },
        series: [
          {
            type: "bar",
            data: values,
            barMaxWidth: 22,
            label: {
              show: true,
              position: "right",
              color: "#d1d4dc",
              fontSize: 11,
              formatter: (p) => fmtSigned(p.value, 1),
            },
          },
        ],
      },
      true
    );
  }

  function renderHorizontalFlowChart(chartKey, domId, items, unit, market, labelFormatter) {
    const chart = getOrInitChart(chartKey, domId);
    if (!chart) return;

    const sorted = [...items].sort((a, b) => b.net_flow - a.net_flow);
    const topDown = [...sorted.slice(0, 8), ...sorted.slice(-8)].filter(
      (v, i, arr) => arr.findIndex((x) => x.name === v.name) === i
    );
    topDown.sort((a, b) => a.net_flow - b.net_flow);

    const names = topDown.map((x) => x.name);
    const values = topDown.map((x) => ({
      value: x.net_flow,
      itemStyle: { color: colorForVal(x.net_flow, market), borderRadius: x.net_flow >= 0 ? [0, 3, 3, 0] : [3, 0, 0, 3] },
    }));

    chart.setOption(
      {
        tooltip: {
          trigger: "axis",
          axisPointer: { type: "shadow" },
          backgroundColor: "#111822",
          borderColor: "#263244",
          textStyle: { color: "#d8e1ea", fontSize: 12 },
          formatter: (params) => labelFormatter(topDown[params[0].dataIndex], unit),
        },
        grid: { left: 124, right: 56, top: 12, bottom: 24 },
        xAxis: {
          type: "value",
          splitLine: { lineStyle: { color: "rgba(148,163,184,0.1)" } },
          axisLabel: { color: "#8b98aa", fontSize: 11 },
        },
        yAxis: {
          type: "category",
          data: names,
          axisLine: { lineStyle: { color: "#263244" } },
          axisLabel: { color: "#d8e1ea", fontSize: 11 },
        },
        series: [
          {
            type: "bar",
            data: values,
            barMaxWidth: 16,
            label: {
              show: true,
              position: "right",
              color: "#d1d4dc",
              fontSize: 10,
              formatter: (p) => fmtSigned(p.value, 1),
            },
          },
        ],
      },
      true
    );
  }

  function renderSectorsChart(d) {
    renderHorizontalFlowChart(
      "sectors",
      "chart-sectors",
      d.sector_rankings || [],
      d.unit,
      d.market,
      (s, unit) => `
        <div style="font-weight:600;margin-bottom:4px;">${escapeHtml(s.name)} (${s.code})</div>
        <div>净流向：<b>${fmtSigned(s.net_flow, 2, " " + unit)}</b></div>
        <div>区间涨跌：<b>${fmtSigned(s.period_pct_chg, 2, "%")}</b></div>
        <div>占规模比：<b>${fmtSigned(s.flow_pct_aum, 2, "%")}</b></div>
        <div>行为象限：<b>${s.quadrant}</b></div>
      `
    );
  }

  function renderQuadrantChart(d) {
    const chart = getOrInitChart("quadrant", "chart-quadrant");
    if (!chart) return;

    const list = d.sector_rankings || [];
    const maxAum = Math.max(...list.map((x) => x.latest_aum || 1), 1);

    const scatterData = list.map((x) => ({
      name: x.name,
      value: [x.period_pct_chg, x.net_flow, x.latest_aum, x.code, x.quadrant, x.flow_pct_aum],
      symbolSize: Math.max(10, Math.min(34, 10 + Math.sqrt((x.latest_aum || 1) / maxAum) * 24)),
      itemStyle: {
        color: colorForVal(x.net_flow, d.market),
        opacity: 0.82,
        borderColor: "#f8fafc",
        borderWidth: 1,
      },
    }));

    chart.setOption(
      {
        tooltip: {
          trigger: "item",
          backgroundColor: "#111822",
          borderColor: "#263244",
          textStyle: { color: "#d8e1ea", fontSize: 12 },
          formatter: (p) => {
            const v = p.value;
            return `
              <div style="font-weight:600;margin-bottom:4px;">${escapeHtml(p.name)} (${v[3]})</div>
              <div>行为象限：<b>${v[4]}</b></div>
              <div>区间涨跌：<b>${fmtSigned(v[0], 2, "%")}</b></div>
              <div>净流向：<b>${fmtSigned(v[1], 2, " " + d.unit)}</b></div>
              <div>占规模比：<b>${fmtSigned(v[5], 2, "%")}</b></div>
              <div>最新规模：<b>${fmtNum(v[2], 1)} ${d.unit}</b></div>
            `;
          },
        },
        grid: { left: 56, right: 26, top: 28, bottom: 38 },
        xAxis: {
          name: "涨跌幅 (%)",
          nameLocation: "middle",
          nameGap: 24,
          nameTextStyle: { color: "#8b98aa", fontSize: 11 },
          splitLine: { lineStyle: { color: "rgba(148,163,184,0.08)" } },
          axisLabel: { color: "#8b98aa", fontSize: 11 },
          axisLine: { lineStyle: { color: "#334155" } },
        },
        yAxis: {
          name: `净流向 (${d.unit})`,
          nameTextStyle: { color: "#8b98aa", fontSize: 11 },
          splitLine: { lineStyle: { color: "rgba(148,163,184,0.08)" } },
          axisLabel: { color: "#8b98aa", fontSize: 11 },
          axisLine: { lineStyle: { color: "#334155" } },
        },
        graphic: [
          { type: "text", right: 32, top: 32, style: { text: "主线共振 (价涨流入)", fill: "rgba(216,225,234,0.28)", font: "bold 11px sans-serif" } },
          { type: "text", left: 66, top: 32, style: { text: "逆势抄底 (价跌流入)", fill: "rgba(216,225,234,0.28)", font: "bold 11px sans-serif" } },
          { type: "text", right: 32, bottom: 48, style: { text: "逢高兑现 (价涨流出)", fill: "rgba(216,225,234,0.28)", font: "bold 11px sans-serif" } },
          { type: "text", left: 66, bottom: 48, style: { text: "资金撤离 (价跌流出)", fill: "rgba(216,225,234,0.28)", font: "bold 11px sans-serif" } },
        ],
        series: [
          {
            type: "scatter",
            data: scatterData,
            label: {
              show: true,
              position: "top",
              color: "#d1d4dc",
              fontSize: 10,
              formatter: (p) => p.name.replace(/ETF.*/, ""),
            },
            markLine: {
              silent: true,
              symbol: "none",
              lineStyle: { color: "rgba(148,163,184,0.35)", type: "dashed" },
              data: [{ xAxis: 0 }, { yAxis: 0 }],
            },
          },
        ],
      },
      true
    );
  }

  function renderTable() {
    const d = state.data;
    if (!d) return;

    const kw = state.search.trim().toLowerCase();
    let rows = (d.etfs || []).filter((item) => {
      if (state.categoryFilter === "broad" && item.category !== "broad") return false;
      if (state.categoryFilter === "sector_theme" && item.category !== "sector" && item.category !== "theme") return false;
      if (state.categoryFilter === "macro" && item.category !== "macro") return false;
      if (kw) {
        const hit =
          item.code.toLowerCase().includes(kw) ||
          item.name.toLowerCase().includes(kw) ||
          item.cluster_name.toLowerCase().includes(kw);
        if (!hit) return false;
      }
      return true;
    });

    rows.sort((a, b) => {
      const va = a[state.sortKey];
      const vb = b[state.sortKey];
      if (typeof va === "string") {
        return state.sortDesc ? vb.localeCompare(va) : va.localeCompare(vb);
      }
      return state.sortDesc ? (vb || 0) - (va || 0) : (va || 0) - (vb || 0);
    });

    const catLabelMap = {
      broad: '<span class="badge-tag bg-[#2dd4bf]/15 text-[#5eead4] border border-[#2dd4bf]/35">宽基</span>',
      sector: '<span class="badge-tag bg-violet-500/15 text-[#c4b5fd] border border-violet-400/35">行业</span>',
      theme: '<span class="badge-tag bg-[#fbbf24]/15 text-[#fcd34d] border border-[#fbbf24]/35">题材</span>',
      macro: '<span class="badge-tag bg-[#2a2e39] text-[#a8b5c7] border border-[#363c4e]">宏观</span>',
    };

    const tbody = document.getElementById("etf-table-body");
    tbody.innerHTML = rows
      .map((r) => {
        const flowCls = classForVal(r.net_flow, d.market);
        const pctCls = classForVal(r.period_pct_chg, d.market);
        return `
          <tr data-code="${escapeHtml(r.code)}">
            <td class="font-mono font-semibold text-[#2dd4bf]">${escapeHtml(r.code)}</td>
            <td>
              <div class="font-medium text-white">${escapeHtml(r.name)}</div>
              <div class="text-[11px] text-[#787b86]">${escapeHtml(r.cluster_name)}</div>
            </td>
            <td>${catLabelMap[r.category] || r.category}</td>
            <td class="text-[#d8e1ea]">${fmtNum(r.latest_close, 3)}</td>
            <td class="font-semibold ${pctCls}">${fmtSigned(r.period_pct_chg, 2, "%")}</td>
            <td class="font-bold ${flowCls}">${fmtSigned(r.net_flow, 2, " " + d.unit)}</td>
            <td class="${flowCls}">${fmtSigned(r.flow_pct_aum, 2, "%")}</td>
            <td class="text-[#a8b5c7]">${fmtNum(r.latest_aum, 1)} ${d.unit}</td>
            <td><span class="badge-tag bg-[#1c2030] text-[#d1d4dc] border border-[#2a2e39]">${escapeHtml(r.quadrant)}</span></td>
          </tr>
        `;
      })
      .join("");

    tbody.querySelectorAll("tr").forEach((tr) => {
      tr.addEventListener("click", () => openDetailModal(tr.dataset.code));
    });
  }

  // ==================== REALTIME INTRADAY DASHBOARD ====================

  async function loadRealtime(force = false) {
    const icon = document.getElementById("rt-refresh-icon");
    if (icon) icon.innerHTML = '<span class="spinner"></span>';
    try {
      const res = await fetch(`/api/v1/etf-flow/realtime?market=${state.market}&force=${force}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.rtData = await res.json();
      renderRealtimeAll();
    } finally {
      if (icon) icon.textContent = "↻";
    }
  }

  function renderRealtimeAll() {
    const d = state.rtData;
    if (!d) return;

    document.getElementById("lbl-rt-source").textContent = d.source || "--";
    document.getElementById("lbl-rt-time").textContent = d.quote_time || d.fetched_at || "--";
    document.getElementById("rt-unit-1").textContent = d.unit;
    document.getElementById("rt-unit-2").textContent = d.unit;
    document.getElementById("rt-unit-3").textContent = d.unit;

    // Indices
    const idxContainer = document.getElementById("rt-indices-strip");
    idxContainer.innerHTML = (d.indices || [])
      .map((idx) => {
        const cls = classForVal(idx.pct_chg, d.market);
        return `
          <div class="card-panel px-3.5 py-3">
            <div class="flex items-center justify-between text-xs">
              <span class="font-semibold text-[#d8e1ea]">${escapeHtml(idx.name)}</span>
              <span class="text-[11px] text-[#787b86]">${escapeHtml(idx.code)}</span>
            </div>
            <div class="flex items-baseline justify-between mt-1.5 tabular-nums">
              <span class="text-lg font-bold text-white">${fmtNum(idx.close, 2)}</span>
              <span class="text-xs font-semibold ${cls}">${fmtSigned(idx.pct_chg, 2, "%")}</span>
            </div>
          </div>
        `;
      })
      .join("");

    // KPI Cards
    const s = d.summary || {};
    const topInd = s.top_industry;
    if (topInd) {
      document.getElementById("rt-kpi-ind-name").textContent = topInd.name;
      const indFlowEl = document.getElementById("rt-kpi-ind-flow");
      indFlowEl.textContent = `${fmtSigned(topInd.net_flow, 2, " " + d.unit)} (${fmtSigned(topInd.pct_chg, 2, "%")})`;
      indFlowEl.className = `text-lg font-bold mt-0.5 tabular-nums ${classForVal(topInd.net_flow, d.market)}`;
      document.getElementById("rt-kpi-ind-sub").textContent =
        topInd.lead_stock ? `领涨股：${topInd.lead_stock} (${fmtSigned(topInd.lead_pct, 2, "%")})` : `成交额：${fmtNum(topInd.turnover, 1)} ${d.unit}`;
    }

    const topCon = s.top_concept;
    if (topCon) {
      document.getElementById("rt-kpi-con-name").textContent = topCon.name;
      const conFlowEl = document.getElementById("rt-kpi-con-flow");
      conFlowEl.textContent = `${fmtSigned(topCon.net_flow, 2, " " + d.unit)} (${fmtSigned(topCon.pct_chg, 2, "%")})`;
      conFlowEl.className = `text-lg font-bold mt-0.5 tabular-nums ${classForVal(topCon.net_flow, d.market)}`;
      document.getElementById("rt-kpi-con-sub").textContent =
        topCon.lead_stock ? `领涨股：${topCon.lead_stock} (${fmtSigned(topCon.lead_pct, 2, "%")})` : `成交额：${fmtNum(topCon.turnover, 1)} ${d.unit}`;
    }

    const elRtBroad = document.getElementById("rt-kpi-broad-flow");
    elRtBroad.textContent = fmtSigned(s.total_broad_active_flow, 2, ` ${d.unit}`);
    elRtBroad.className = `text-2xl font-bold mt-1.5 tabular-nums ${classForVal(s.total_broad_active_flow, d.market)}`;
    document.getElementById("rt-kpi-etf-total").textContent =
      `全监控池 ETF 盘中主动流向合计：${fmtSigned(s.total_etf_active_flow, 2, " " + d.unit)}`;

    document.getElementById("rt-kpi-ind-breadth").textContent = `${s.industry_in_count || 0}/${s.industry_total || 0}`;
    document.getElementById("rt-kpi-con-breadth").textContent = `${s.concept_in_count || 0}/${s.concept_total || 0}`;

    renderInsights(d, "rt-insights-grid", "text-[#fcd34d]");

    // Realtime Charts
    renderHorizontalFlowChart(
      "rtIndustries",
      "chart-rt-industries",
      d.industries || [],
      d.unit,
      d.market,
      (x, unit) => `
        <div style="font-weight:600;margin-bottom:4px;">${escapeHtml(x.name)}</div>
        <div>涨跌幅：<b>${fmtSigned(x.pct_chg, 2, "%")}</b></div>
        <div>主力净额：<b>${fmtSigned(x.net_flow, 2, " " + unit)}</b> (净占比 ${fmtSigned(x.net_ratio, 2, "%")})</div>
        <div>流入 / 流出：${fmtNum(x.inflow, 2)} / ${fmtNum(x.outflow, 2)} ${unit}</div>
        <div>领涨股：${escapeHtml(x.lead_stock || "--")} (${fmtSigned(x.lead_pct, 2, "%")})</div>
      `
    );

    renderHorizontalFlowChart(
      "rtConcepts",
      "chart-rt-concepts",
      d.concepts || [],
      d.unit,
      d.market,
      (x, unit) => `
        <div style="font-weight:600;margin-bottom:4px;">${escapeHtml(x.name)}</div>
        <div>涨跌幅：<b>${fmtSigned(x.pct_chg, 2, "%")}</b></div>
        <div>主力净额：<b>${fmtSigned(x.net_flow, 2, " " + unit)}</b> (净占比 ${fmtSigned(x.net_ratio, 2, "%")})</div>
        <div>流入 / 流出：${fmtNum(x.inflow, 2)} / ${fmtNum(x.outflow, 2)} ${unit}</div>
        <div>领涨股：${escapeHtml(x.lead_stock || "--")} (${fmtSigned(x.lead_pct, 2, "%")})</div>
      `
    );

    renderRtQuadrantChart(d);

    renderHorizontalFlowChart(
      "rtEtfs",
      "chart-rt-etfs",
      d.etfs || [],
      d.unit,
      d.market,
      (x, unit) => `
        <div style="font-weight:600;margin-bottom:4px;">${escapeHtml(x.name)} (${x.code})</div>
        <div>最新价：<b>${fmtNum(x.price, 3)}</b> (${fmtSigned(x.pct_chg, 2, "%")})</div>
        <div>盘中主动净买：<b>${fmtSigned(x.net_flow, 2, " " + unit)}</b> (净占比 ${fmtSigned(x.net_ratio, 2, "%")})</div>
        <div>实时成交额：${fmtNum(x.turnover, 2)} ${unit} · 量比：${fmtNum(x.vol_ratio, 2)}</div>
        <div>IOPV 折溢价：${fmtSigned(x.discount_pct, 2, "%")}</div>
      `
    );

    renderRealtimeTable();
  }

  function renderRtQuadrantChart(d) {
    const chart = getOrInitChart("rtQuadrant", "chart-rt-quadrant");
    if (!chart) return;

    const pts = d.quadrant_points || [];
    const maxTurn = Math.max(...pts.map((x) => x.turnover || 1), 1);

    const scatterData = pts.map((x) => ({
      name: x.name,
      value: [x.pct_chg, x.net_flow, x.turnover, x.kind, x.quadrant, x.net_ratio],
      symbol: x.kind === "题材" ? "diamond" : "circle",
      symbolSize: Math.max(10, Math.min(30, 10 + Math.sqrt((x.turnover || 1) / maxTurn) * 20)),
      itemStyle: {
        color: colorForVal(x.net_flow, d.market),
        opacity: 0.82,
        borderColor: x.kind === "题材" ? "#fbbf24" : "#f8fafc",
        borderWidth: 1,
      },
    }));

    chart.setOption(
      {
        tooltip: {
          trigger: "item",
          backgroundColor: "#111822",
          borderColor: "#263244",
          textStyle: { color: "#d8e1ea", fontSize: 12 },
          formatter: (p) => {
            const v = p.value;
            return `
              <div style="font-weight:600;margin-bottom:4px;">[${v[3]}] ${escapeHtml(p.name)}</div>
              <div>象限：<b>${v[4]}</b></div>
              <div>涨跌幅：<b>${fmtSigned(v[0], 2, "%")}</b></div>
              <div>实时净额：<b>${fmtSigned(v[1], 2, " " + d.unit)}</b> (净占比 ${fmtSigned(v[5], 2, "%")})</div>
              <div>总成交/资金：<b>${fmtNum(v[2], 1)} ${d.unit}</b></div>
            `;
          },
        },
        grid: { left: 56, right: 26, top: 28, bottom: 38 },
        xAxis: {
          name: "实时涨跌幅 (%)",
          nameLocation: "middle",
          nameGap: 24,
          nameTextStyle: { color: "#8b98aa", fontSize: 11 },
          splitLine: { lineStyle: { color: "rgba(148,163,184,0.08)" } },
          axisLabel: { color: "#8b98aa", fontSize: 11 },
          axisLine: { lineStyle: { color: "#334155" } },
        },
        yAxis: {
          name: `净流向 (${d.unit})`,
          nameTextStyle: { color: "#8b98aa", fontSize: 11 },
          splitLine: { lineStyle: { color: "rgba(148,163,184,0.08)" } },
          axisLabel: { color: "#8b98aa", fontSize: 11 },
          axisLine: { lineStyle: { color: "#334155" } },
        },
        graphic: [
          { type: "text", right: 32, top: 32, style: { text: "主线共振 (价涨流入)", fill: "rgba(216,225,234,0.28)", font: "bold 11px sans-serif" } },
          { type: "text", left: 66, top: 32, style: { text: "逆势抄底 (价跌流入)", fill: "rgba(216,225,234,0.28)", font: "bold 11px sans-serif" } },
          { type: "text", right: 32, bottom: 48, style: { text: "逢高兑现 (价涨流出)", fill: "rgba(216,225,234,0.28)", font: "bold 11px sans-serif" } },
          { type: "text", left: 66, bottom: 48, style: { text: "资金撤离 (价跌流出)", fill: "rgba(216,225,234,0.28)", font: "bold 11px sans-serif" } },
        ],
        series: [
          {
            type: "scatter",
            data: scatterData,
            label: {
              show: true,
              position: "top",
              color: "#d1d4dc",
              fontSize: 10,
              formatter: (p) => p.name.replace(/\s*\([A-Z]+\)$/, ""),
            },
            markLine: {
              silent: true,
              symbol: "none",
              lineStyle: { color: "rgba(148,163,184,0.35)", type: "dashed" },
              data: [{ xAxis: 0 }, { yAxis: 0 }],
            },
          },
        ],
      },
      true
    );
  }

  function renderRealtimeTable() {
    const d = state.rtData;
    if (!d) return;

    const thead = document.getElementById("rt-table-head");
    const tbody = document.getElementById("rt-table-body");
    const kw = state.rtSearch.trim().toLowerCase();

    if (state.rtTab === "etfs") {
      thead.innerHTML = `
        <tr>
          <th data-rtsort="code">代码</th>
          <th data-rtsort="name">ETF名称 / 所属簇</th>
          <th data-rtsort="category">分类</th>
          <th data-rtsort="price">最新价</th>
          <th data-rtsort="pct_chg">涨跌幅</th>
          <th data-rtsort="net_flow">盘中主动净买</th>
          <th data-rtsort="net_ratio">主动净占比</th>
          <th data-rtsort="turnover">实时成交额</th>
          <th data-rtsort="vol_ratio">量比</th>
          <th data-rtsort="discount_pct">IOPV折溢价</th>
          <th data-rtsort="quadrant">象限</th>
        </tr>
      `;
    } else {
      thead.innerHTML = `
        <tr>
          <th data-rtsort="code">代码/标识</th>
          <th data-rtsort="name">${state.rtTab === "industries" ? "行业板块" : "概念题材"}</th>
          <th data-rtsort="company_count">成分/龙头数</th>
          <th data-rtsort="pct_chg">实时涨跌</th>
          <th data-rtsort="net_flow">实时净流入</th>
          <th data-rtsort="net_ratio">净占比</th>
          <th data-rtsort="inflow">流入资金</th>
          <th data-rtsort="outflow">流出资金</th>
          <th data-rtsort="lead_stock">领涨股</th>
          <th data-rtsort="quadrant">行为象限</th>
        </tr>
      `;
    }

    let sourceRows =
      state.rtTab === "industries"
        ? d.industries || []
        : state.rtTab === "concepts"
          ? d.concepts || []
          : d.etfs || [];

    let rows = sourceRows.filter((item) => {
      if (!kw) return true;
      return (
        String(item.code || "").toLowerCase().includes(kw) ||
        String(item.name || "").toLowerCase().includes(kw) ||
        String(item.lead_stock || "").toLowerCase().includes(kw) ||
        String(item.cluster_name || "").toLowerCase().includes(kw)
      );
    });

    rows.sort((a, b) => {
      const va = a[state.rtSortKey];
      const vb = b[state.rtSortKey];
      if (typeof va === "string") {
        return state.rtSortDesc ? vb.localeCompare(va) : va.localeCompare(vb);
      }
      return state.rtSortDesc ? (vb || 0) - (va || 0) : (va || 0) - (vb || 0);
    });

    const catLabelMap = {
      broad: '<span class="badge-tag bg-[#2dd4bf]/15 text-[#5eead4] border border-[#2dd4bf]/35">宽基</span>',
      sector: '<span class="badge-tag bg-violet-500/15 text-[#c4b5fd] border border-violet-400/35">行业</span>',
      theme: '<span class="badge-tag bg-[#fbbf24]/15 text-[#fcd34d] border border-[#fbbf24]/35">题材</span>',
      macro: '<span class="badge-tag bg-[#2a2e39] text-[#a8b5c7] border border-[#363c4e]">宏观</span>',
    };

    if (state.rtTab === "etfs") {
      tbody.innerHTML = rows
        .map((r) => {
          const flowCls = classForVal(r.net_flow, d.market);
          const pctCls = classForVal(r.pct_chg, d.market);
          return `
            <tr data-code="${escapeHtml(r.code)}">
              <td class="font-mono font-semibold text-[#2dd4bf]">${escapeHtml(r.code)}</td>
              <td>
                <div class="font-medium text-white">${escapeHtml(r.name)}</div>
                <div class="text-[11px] text-[#787b86]">${escapeHtml(r.cluster_name)}</div>
              </td>
              <td>${catLabelMap[r.category] || r.category}</td>
              <td class="text-[#d8e1ea]">${fmtNum(r.price, 3)}</td>
              <td class="font-semibold ${pctCls}">${fmtSigned(r.pct_chg, 2, "%")}</td>
              <td class="font-bold ${flowCls}">${fmtSigned(r.net_flow, 2, " " + d.unit)}</td>
              <td class="${flowCls}">${fmtSigned(r.net_ratio, 2, "%")}</td>
              <td class="text-[#a8b5c7]">${fmtNum(r.turnover, 2)} ${d.unit}</td>
              <td class="text-[#d8e1ea]">${fmtNum(r.vol_ratio, 2)}</td>
              <td class="text-[#a8b5c7]">${fmtSigned(r.discount_pct, 2, "%")}</td>
              <td><span class="badge-tag bg-[#1c2030] text-[#d1d4dc] border border-[#2a2e39]">${escapeHtml(r.quadrant)}</span></td>
            </tr>
          `;
        })
        .join("");

      tbody.querySelectorAll("tr").forEach((tr) => {
        tr.addEventListener("click", () => openDetailModal(tr.dataset.code));
      });
    } else {
      tbody.innerHTML = rows
        .map((r) => {
          const flowCls = classForVal(r.net_flow, d.market);
          const pctCls = classForVal(r.pct_chg, d.market);
          const leadCls = classForVal(r.lead_pct, d.market);
          return `
            <tr>
              <td class="font-mono text-[#8b98aa] text-xs">${escapeHtml(r.code)}</td>
              <td class="font-semibold text-white">${escapeHtml(r.name)}</td>
              <td class="text-[#a8b5c7]">${r.company_count || "--"}</td>
              <td class="font-semibold ${pctCls}">${fmtSigned(r.pct_chg, 2, "%")}</td>
              <td class="font-bold ${flowCls}">${fmtSigned(r.net_flow, 2, " " + d.unit)}</td>
              <td class="${flowCls}">${fmtSigned(r.net_ratio, 2, "%")}</td>
              <td class="text-[#d8e1ea]">${fmtNum(r.inflow, 2)} ${d.unit}</td>
              <td class="text-[#a8b5c7]">${fmtNum(r.outflow, 2)} ${d.unit}</td>
              <td>
                <span class="text-white">${escapeHtml(r.lead_stock || "--")}</span>
                <span class="text-xs font-semibold ml-1 ${leadCls}">${fmtSigned(r.lead_pct, 2, "%")}</span>
              </td>
              <td><span class="badge-tag bg-[#1c2030] text-[#d1d4dc] border border-[#2a2e39]">${escapeHtml(r.quadrant)}</span></td>
            </tr>
          `;
        })
        .join("");
    }

    thead.querySelectorAll("th[data-rtsort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.rtsort;
        if (state.rtSortKey === key) {
          state.rtSortDesc = !state.rtSortDesc;
        } else {
          state.rtSortKey = key;
          state.rtSortDesc = true;
        }
        renderRealtimeTable();
      });
    });
  }

  function switchViewMode(view) {
    state.viewMode = view;
    document.querySelectorAll("#view-mode-switch .seg-btn").forEach((b) => {
      b.classList.remove("active", "active-gold");
      if (b.dataset.view === view) {
        b.classList.add(view === "realtime" ? "active-gold" : "active");
      }
    });

    const postEl = document.getElementById("view-postmarket");
    const rtEl = document.getElementById("view-realtime");

    if (view === "realtime") {
      postEl.classList.add("hidden");
      rtEl.classList.remove("hidden");
      if (!state.rtData || state.rtData.market !== state.market) {
        loadRealtime(false).then(() => resizeAllCharts());
      } else {
        resizeAllCharts();
      }
    } else {
      rtEl.classList.add("hidden");
      postEl.classList.remove("hidden");
      if (!state.data || state.data.market !== state.market) {
        loadDashboard().then(() => resizeAllCharts());
      } else {
        resizeAllCharts();
      }
    }
  }

  function setGlobalMarket(market) {
    state.market = market;
    document.querySelectorAll(".market-switch-group .seg-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.market === market);
    });
    if (state.viewMode === "realtime") {
      loadRealtime(false);
    } else {
      loadDashboard();
    }
  }

  // ==================== DETAIL MODAL & CONTROLS ====================

  async function openDetailModal(code) {
    const modal = document.getElementById("modal-detail");
    modal.classList.add("open");
    const res = await fetch(`/api/v1/etf-flow/etf/${state.market}/${encodeURIComponent(code)}`);
    if (!res.ok) return;
    const payload = await res.json();
    const meta = payload.meta;
    const hist = payload.history || [];
    const unit = state.market === "CN" ? "亿元" : "百万美元";

    document.getElementById("detail-title").textContent = `${meta.name} (${meta.code})`;
    document.getElementById("detail-sub").textContent =
      `所属簇：${meta.cluster_name} · 交易所：${meta.exchange} · 最新规模：${fmtNum(meta.latest_aum, 2)} ${unit}`;

    const chart = getOrInitChart("detail", "chart-detail");
    if (!chart) return;

    const dates = hist.map((x) => x.trade_date);
    const closes = hist.map((x) => x.close);
    const flows = hist.map((x) => ({
      value: x.net_flow,
      itemStyle: { color: colorForVal(x.net_flow || 0, state.market) },
    }));

    chart.resize();
    chart.setOption(
      {
        tooltip: {
          trigger: "axis",
          backgroundColor: "#111822",
          borderColor: "#263244",
          textStyle: { color: "#d8e1ea", fontSize: 12 },
        },
        legend: {
          data: ["每日净流入", "收盘价"],
          textStyle: { color: "#8b98aa", fontSize: 11 },
        },
        grid: { left: 54, right: 54, top: 34, bottom: 28 },
        xAxis: {
          type: "category",
          data: dates,
          axisLabel: { color: "#8b98aa", fontSize: 10 },
        },
        yAxis: [
          {
            type: "value",
            name: unit,
            splitLine: { lineStyle: { color: "rgba(148,163,184,0.1)" } },
            axisLabel: { color: "#8b98aa", fontSize: 11 },
          },
          {
            type: "value",
            name: "价格",
            scale: true,
            splitLine: { show: false },
            axisLabel: { color: "#8b98aa", fontSize: 11 },
          },
        ],
        series: [
          {
            name: "每日净流入",
            type: "bar",
            data: flows,
            barMaxWidth: 12,
          },
          {
            name: "收盘价",
            type: "line",
            yAxisIndex: 1,
            data: closes,
            showSymbol: false,
            lineStyle: { color: "#fbbf24", width: 2 },
          },
        ],
      },
      true
    );
  }

  function wireEvents() {
    document.querySelectorAll("#view-mode-switch .seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchViewMode(btn.dataset.view));
    });

    document.querySelectorAll(".market-switch-group .seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => setGlobalMarket(btn.dataset.market));
    });

    document.querySelectorAll("#period-switch .seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#period-switch .seg-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.period = btn.dataset.period;
        loadDashboard();
      });
    });

    document.querySelectorAll("#cat-filter .seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#cat-filter .seg-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.categoryFilter = btn.dataset.cat;
        renderTable();
      });
    });

    document.getElementById("search-input").addEventListener("input", (e) => {
      state.search = e.target.value;
      renderTable();
    });

    document.querySelectorAll("table.etf-table thead th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.sortKey === key) {
          state.sortDesc = !state.sortDesc;
        } else {
          state.sortKey = key;
          state.sortDesc = true;
        }
        renderTable();
      });
    });

    // Realtime controls
    document.getElementById("btn-rt-refresh").addEventListener("click", () => loadRealtime(true));

    document.getElementById("btn-rt-auto").addEventListener("click", () => {
      state.rtAutoRefresh = !state.rtAutoRefresh;
      const dot = document.getElementById("rt-auto-dot");
      const label = document.getElementById("rt-auto-label");
      const btn = document.getElementById("btn-rt-auto");
      if (state.rtAutoRefresh) {
        dot.className = "w-2 h-2 rounded-full bg-[#2dd4bf] animate-pulse";
        label.textContent = "自动刷新: 30s";
        btn.classList.add("border-[#2dd4bf]");
        state.rtTimer = setInterval(() => {
          if (state.viewMode === "realtime") {
            loadRealtime(true);
          }
        }, 30000);
      } else {
        dot.className = "w-2 h-2 rounded-full bg-[#787b86]";
        label.textContent = "自动刷新: 关";
        btn.classList.remove("border-[#2dd4bf]");
        if (state.rtTimer) {
          clearInterval(state.rtTimer);
          state.rtTimer = null;
        }
      }
    });

    document.querySelectorAll("#rt-tab-switch .seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#rt-tab-switch .seg-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.rtTab = btn.dataset.rttab;
        state.rtSortKey = "net_flow";
        state.rtSortDesc = true;
        renderRealtimeTable();
      });
    });

    document.getElementById("rt-search-input").addEventListener("input", (e) => {
      state.rtSearch = e.target.value;
      renderRealtimeTable();
    });

    // Modals close
    document.querySelectorAll(".close-modal").forEach((btn) => {
      btn.addEventListener("click", () => {
        btn.closest(".modal-backdrop").classList.remove("open");
      });
    });
    document.querySelectorAll(".modal-backdrop").forEach((bg) => {
      bg.addEventListener("click", (e) => {
        if (e.target === bg) bg.classList.remove("open");
      });
    });

    // Add ETF modal
    document.getElementById("btn-add-etf").addEventListener("click", () => {
      const form = document.getElementById("form-add-etf");
      form.market.value = state.market;
      document.getElementById("add-etf-msg").classList.add("hidden");
      document.getElementById("modal-add").classList.add("open");
    });

    document.getElementById("form-add-etf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const msgEl = document.getElementById("add-etf-msg");
      const btn = document.getElementById("btn-submit-add");
      btn.disabled = true;
      btn.textContent = "拉取历史数据中...";
      msgEl.classList.add("hidden");

      try {
        const payload = {
          market: form.market.value,
          code: form.code.value.trim(),
          name: form.name.value.trim(),
          category: form.category.value,
          exchange: form.exchange.value.trim(),
          cluster_id: form.cluster_id.value.trim(),
          cluster_name: form.cluster_name.value.trim(),
        };
        const res = await fetch("/api/v1/etf-flow/universe/add", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
          msgEl.textContent = data.detail || "添加失败";
          msgEl.classList.remove("hidden");
        } else {
          document.getElementById("modal-add").classList.remove("open");
          form.reset();
          setGlobalMarket(payload.market);
        }
      } catch (err) {
        msgEl.textContent = "请求异常: " + err.message;
        msgEl.classList.remove("hidden");
      } finally {
        btn.disabled = false;
        btn.textContent = "添加并拉取历史数据";
      }
    });

    // Report viewer modal
    document.getElementById("btn-report").addEventListener("click", async () => {
      document.getElementById("modal-report").classList.add("open");
      document.getElementById("report-content").textContent = "加载中...";
      const res = await fetch("/api/v1/etf-flow/report");
      const data = await res.json();
      document.getElementById("report-content").textContent = data.content || "";
    });

    // Sync post-market button
    document.getElementById("btn-sync").addEventListener("click", async () => {
      const btn = document.getElementById("btn-sync");
      const icon = document.getElementById("sync-icon");
      const label = document.getElementById("sync-label");
      btn.disabled = true;
      icon.innerHTML = '<span class="spinner"></span>';
      label.textContent = "同步中...";
      try {
        await fetch("/api/v1/etf-flow/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ market: state.market, days: 30 }),
        });
        await loadDashboard();
      } finally {
        btn.disabled = false;
        icon.textContent = "↻";
        label.textContent = "同步数据";
      }
    });

    window.addEventListener("resize", resizeAllCharts);
  }

  wireEvents();
  loadDashboard();
})();
