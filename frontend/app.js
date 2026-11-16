(() => {
  const state = {
    market: "CN",
    period: "5d",
    categoryFilter: "all",
    search: "",
    sortKey: "net_flow",
    sortDesc: true,
    data: null,
  };

  const charts = {
    timeseries: null,
    clusters: null,
    sectors: null,
    quadrant: null,
    detail: null,
  };

  function isPositiveRed(market) {
    // CN convention: red = inflow / up, green = outflow / down; US convention: green = up, red = down
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
    return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-100 font-semibold">$1</strong>');
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
    renderInsights(d);
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
              <span class="font-semibold text-slate-200">${escapeHtml(idx.name)}</span>
              <span class="text-[11px] text-slate-500">${escapeHtml(idx.code)}</span>
            </div>
            <div class="flex items-baseline justify-between mt-1.5 tabular-nums">
              <span class="text-lg font-bold text-slate-100">${fmtNum(idx.latest_close, 2)}</span>
              <span class="text-xs font-semibold ${latestCls}">${fmtSigned(idx.latest_pct_chg, 2, "%")} <span class="text-[10px] text-slate-500 font-normal">日</span></span>
            </div>
            <div class="flex items-center justify-between mt-1 text-[11px] text-slate-400 tabular-nums">
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

  function renderInsights(d) {
    const grid = document.getElementById("insights-grid");
    grid.innerHTML = d.insights
      .map(
        (item) => `
        <div class="zq-insight-card p-3.5">
          <div class="font-semibold text-[#5eead4] mb-1">${escapeHtml(item.title)}</div>
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
          textStyle: { color: "#94a3b8", fontSize: 11 },
          top: 0,
        },
        grid: { left: 52, right: 56, top: 34, bottom: 28 },
        xAxis: {
          type: "category",
          data: dates,
          axisLine: { lineStyle: { color: "#334155" } },
          axisLabel: { color: "#94a3b8", fontSize: 10 },
        },
        yAxis: [
          {
            type: "value",
            name: d.unit,
            nameTextStyle: { color: "#64748b", fontSize: 11 },
            splitLine: { lineStyle: { color: "rgba(148,163,184,0.1)" } },
            axisLabel: { color: "#94a3b8", fontSize: 11 },
          },
          {
            type: "value",
            name: "点位",
            scale: true,
            nameTextStyle: { color: "#64748b", fontSize: 11 },
            splitLine: { show: false },
            axisLabel: { color: "#94a3b8", fontSize: 11 },
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
              <div style="color:#94a3b8;font-size:11px;margin-top:3px;">包含：${c.members.join(", ")}</div>
            `;
          },
        },
        grid: { left: 108, right: 48, top: 14, bottom: 26 },
        xAxis: {
          type: "value",
          splitLine: { lineStyle: { color: "rgba(148,163,184,0.1)" } },
          axisLabel: { color: "#94a3b8", fontSize: 11 },
        },
        yAxis: {
          type: "category",
          data: names,
          axisLine: { lineStyle: { color: "#334155" } },
          axisLabel: { color: "#e2e8f0", fontSize: 12 },
        },
        series: [
          {
            type: "bar",
            data: values,
            barMaxWidth: 22,
            label: {
              show: true,
              position: "right",
              color: "#cbd5e1",
              fontSize: 11,
              formatter: (p) => fmtSigned(p.value, 1),
            },
          },
        ],
      },
      true
    );
  }

  function renderSectorsChart(d) {
    const chart = getOrInitChart("sectors", "chart-sectors");
    if (!chart) return;

    const list = d.sector_rankings || [];
    const topDown = [...list.slice(0, 8), ...list.slice(-8)].filter(
      (v, i, arr) => arr.findIndex((x) => x.code === v.code) === i
    );
    topDown.sort((a, b) => a.net_flow - b.net_flow);

    const names = topDown.map((x) => `${x.name}`);
    const values = topDown.map((x) => ({
      value: x.net_flow,
      itemStyle: { color: colorForVal(x.net_flow, d.market), borderRadius: x.net_flow >= 0 ? [0, 3, 3, 0] : [3, 0, 0, 3] },
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
            const s = topDown[params[0].dataIndex];
            return `
              <div style="font-weight:600;margin-bottom:4px;">${escapeHtml(s.name)} (${s.code})</div>
              <div>净流向：<b>${fmtSigned(s.net_flow, 2, " " + d.unit)}</b></div>
              <div>区间涨跌：<b>${fmtSigned(s.period_pct_chg, 2, "%")}</b></div>
              <div>占规模比：<b>${fmtSigned(s.flow_pct_aum, 2, "%")}</b></div>
              <div>行为象限：<b>${s.quadrant}</b></div>
            `;
          },
        },
        grid: { left: 116, right: 54, top: 12, bottom: 24 },
        xAxis: {
          type: "value",
          splitLine: { lineStyle: { color: "rgba(148,163,184,0.1)" } },
          axisLabel: { color: "#94a3b8", fontSize: 11 },
        },
        yAxis: {
          type: "category",
          data: names,
          axisLine: { lineStyle: { color: "#334155" } },
          axisLabel: { color: "#e2e8f0", fontSize: 11 },
        },
        series: [
          {
            type: "bar",
            data: values,
            barMaxWidth: 16,
            label: {
              show: true,
              position: "right",
              color: "#cbd5e1",
              fontSize: 10,
              formatter: (p) => fmtSigned(p.value, 1),
            },
          },
        ],
      },
      true
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
          nameTextStyle: { color: "#94a3b8", fontSize: 11 },
          splitLine: { lineStyle: { color: "rgba(148,163,184,0.08)" } },
          axisLabel: { color: "#94a3b8", fontSize: 11 },
          axisLine: { lineStyle: { color: "#475569" } },
        },
        yAxis: {
          name: `净流向 (${d.unit})`,
          nameTextStyle: { color: "#94a3b8", fontSize: 11 },
          splitLine: { lineStyle: { color: "rgba(148,163,184,0.08)" } },
          axisLabel: { color: "#94a3b8", fontSize: 11 },
          axisLine: { lineStyle: { color: "#475569" } },
        },
        graphic: [
          { type: "text", right: 32, top: 32, style: { text: "主线共振 (价涨流入)", fill: "rgba(248,250,252,0.28)", font: "bold 11px sans-serif" } },
          { type: "text", left: 66, top: 32, style: { text: "逆势抄底 (价跌流入)", fill: "rgba(248,250,252,0.28)", font: "bold 11px sans-serif" } },
          { type: "text", right: 32, bottom: 48, style: { text: "逢高兑现 (价涨流出)", fill: "rgba(248,250,252,0.28)", font: "bold 11px sans-serif" } },
          { type: "text", left: 66, bottom: 48, style: { text: "资金撤离 (价跌流出)", fill: "rgba(248,250,252,0.28)", font: "bold 11px sans-serif" } },
        ],
        series: [
          {
            type: "scatter",
            data: scatterData,
            label: {
              show: true,
              position: "top",
              color: "#cbd5e1",
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
              <div class="font-medium text-[#ffffff]">${escapeHtml(r.name)}</div>
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
          textStyle: { color: "#94a3b8", fontSize: 11 },
        },
        grid: { left: 54, right: 54, top: 34, bottom: 28 },
        xAxis: {
          type: "category",
          data: dates,
          axisLabel: { color: "#94a3b8", fontSize: 10 },
        },
        yAxis: [
          {
            type: "value",
            name: unit,
            splitLine: { lineStyle: { color: "rgba(148,163,184,0.1)" } },
            axisLabel: { color: "#94a3b8", fontSize: 11 },
          },
          {
            type: "value",
            name: "价格",
            scale: true,
            splitLine: { show: false },
            axisLabel: { color: "#94a3b8", fontSize: 11 },
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
    document.querySelectorAll("#market-switch .seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#market-switch .seg-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.market = btn.dataset.market;
        loadDashboard();
      });
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
          state.market = payload.market;
          document.querySelectorAll("#market-switch .seg-btn").forEach((b) => {
            b.classList.toggle("active", b.dataset.market === state.market);
          });
          await loadDashboard();
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

    // Sync button
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

    window.addEventListener("resize", () => {
      Object.values(charts).forEach((c) => {
        if (c) c.resize();
      });
    });
  }

  wireEvents();
  loadDashboard();
})();
