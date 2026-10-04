const formatNumber = new Intl.NumberFormat("zh-CN");
const formatCompact = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
const formatDateTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const state = {
  data: null,
  selectedId: null,
  range: "24h",
  search: "",
  sort: "votes",
};

function valueAt(snapshot, index, field = "votes") {
  const values = snapshot?.[field];
  const value = values?.[index];
  return Number.isFinite(value) ? value : null;
}

function closestSnapshot(snapshots, targetTime) {
  if (!snapshots.length) return null;
  let best = snapshots[0];
  let bestDistance = Math.abs(new Date(best.timestamp).getTime() - targetTime);
  for (const snapshot of snapshots) {
    const distance = Math.abs(new Date(snapshot.timestamp).getTime() - targetTime);
    if (distance < bestDistance) {
      best = snapshot;
      bestDistance = distance;
    }
  }
  return best;
}

function referenceSnapshot(snapshots, latestTime, targetAgeMs, toleranceMs) {
  const targetTime = latestTime - targetAgeMs;
  const oldEnough = snapshots.filter((snapshot) => new Date(snapshot.timestamp).getTime() <= targetTime + toleranceMs);
  return oldEnough.length ? closestSnapshot(oldEnough, targetTime) : null;
}

function deltaBetween(latest, reference, index) {
  const current = valueAt(latest, index);
  const previous = valueAt(reference, index);
  return current === null || previous === null ? null : current - previous;
}

function signed(value) {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${formatNumber.format(value)}`;
}

function metricClass(value) {
  return value === null ? "unavailable" : value > 0 ? "positive" : "";
}

function getMetrics() {
  const { data } = state;
  const snapshots = data.snapshots;
  const latest = snapshots.at(-1);
  const latestTime = new Date(latest.timestamp).getTime();
  const previous = referenceSnapshot(snapshots, latestTime, 30 * 60 * 1000, 10 * 60 * 1000);
  const previous24 = referenceSnapshot(snapshots, latestTime, 24 * 60 * 60 * 1000, 4 * 60 * 60 * 1000);
  const elapsed24 = previous24 ? Math.max((latestTime - new Date(previous24.timestamp).getTime()) / 3600000, 0) : 0;

  return data.candidate_order.map((id, index) => {
    const votes = valueAt(latest, index) ?? 0;
    const delta30 = previous ? deltaBetween(latest, previous, index) : null;
    const delta24 = previous24 && previous24 !== latest ? deltaBetween(latest, previous24, index) : null;
    const speed = delta24 !== null && elapsed24 > 0 ? delta24 / elapsed24 : null;
    return {
      id,
      index,
      ...data.candidates[id],
      votes,
      voters: valueAt(latest, index, "voters"),
      delta30,
      delta24,
      speed,
    };
  }).sort((a, b) => b.votes - a.votes);
}

function renderKpis(metrics) {
  const { data } = state;
  const leader = metrics[0];
  const latest = data.snapshots.at(-1);
  const latestDate = new Date(latest.timestamp);
  const ageMinutes = Math.max(0, (Date.now() - latestDate.getTime()) / 60000);
  const stale = ageMinutes > 75;
  document.querySelector("#activity-title").textContent = `${data.activity}票数监测`;
  document.querySelector("#last-updated").textContent = stale
    ? `${formatDateTime.format(latestDate)}（更新延迟）`
    : formatDateTime.format(latestDate);
  document.querySelector(".pulse").classList.toggle("stale", stale);
  document.querySelector("#leader-name").textContent = leader.name;
  document.querySelector("#leader-votes").textContent = `${formatNumber.format(leader.votes)} ${data.unit}`;
  document.querySelector("#leader-30m").textContent = signed(leader.delta30);
  document.querySelector("#leader-30m").className = metricClass(leader.delta30);
  document.querySelector("#leader-24h").textContent = signed(leader.delta24);
  document.querySelector("#leader-24h").className = metricClass(leader.delta24);
  document.querySelector("#leader-speed").textContent = leader.speed === null ? "等待更多历史记录" : `${signed(Math.round(leader.speed))} / 小时`;
  document.querySelector("#candidate-count").textContent = formatNumber.format(metrics.length);
  document.querySelector("#snapshot-count").textContent = `${formatNumber.format(data.snapshots.length)} 次历史记录`;
  document.querySelector("#vote-unit").textContent = data.unit;
}

function renderRankingChart(metrics) {
  const top = metrics.slice(0, 10);
  const max = top[0]?.votes || 1;
  const root = document.querySelector("#ranking-chart");
  root.innerHTML = top.map((item) => `
    <div class="bar-row" title="${escapeHtml(item.name)}：${formatNumber.format(item.votes)}">
      <span class="bar-label">${escapeHtml(item.name)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.max(0.5, item.votes / max * 100)}%"></span></span>
      <strong class="bar-value">${formatCompact.format(item.votes)}</strong>
    </div>
  `).join("");
}

function rangeSnapshots() {
  const snapshots = state.data.snapshots;
  if (state.range === "all") return snapshots;
  const latestTime = new Date(snapshots.at(-1).timestamp).getTime();
  const duration = state.range === "24h" ? 24 * 3600000 : 7 * 24 * 3600000;
  return snapshots.filter((snapshot) => new Date(snapshot.timestamp).getTime() >= latestTime - duration);
}

function renderTrend() {
  const data = state.data;
  const index = data.candidate_order.indexOf(state.selectedId);
  const candidate = data.candidates[state.selectedId];
  const snapshots = rangeSnapshots().filter((snapshot) => valueAt(snapshot, index) !== null);
  const root = document.querySelector("#trend-chart");

  if (!candidate || !snapshots.length) {
    root.innerHTML = '<p class="unavailable">等待历史记录</p>';
    return;
  }

  const width = 760;
  const height = 250;
  const pad = { left: 64, right: 20, top: 24, bottom: 34 };
  const values = snapshots.map((snapshot) => valueAt(snapshot, index));
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const padding = Math.max((maxValue - minValue) * 0.18, maxValue * 0.01, 1);
  const yMin = Math.max(0, minValue - padding);
  const yMax = maxValue + padding;
  const x = (i) => pad.left + (snapshots.length === 1 ? (width - pad.left - pad.right) / 2 : i / (snapshots.length - 1) * (width - pad.left - pad.right));
  const y = (value) => pad.top + (yMax - value) / Math.max(yMax - yMin, 1) * (height - pad.top - pad.bottom);
  const points = values.map((value, i) => `${x(i)},${y(value)}`).join(" ");
  const area = `${pad.left},${height - pad.bottom} ${points} ${x(values.length - 1)},${height - pad.bottom}`;
  const ticks = [0, 0.5, 1].map((position) => {
    const value = yMax - position * (yMax - yMin);
    const cy = pad.top + position * (height - pad.top - pad.bottom);
    return `<line class="grid-line" x1="${pad.left}" x2="${width - pad.right}" y1="${cy}" y2="${cy}" />
      <text class="axis-text" x="${pad.left - 10}" y="${cy + 4}" text-anchor="end">${formatCompact.format(Math.round(value))}</text>`;
  }).join("");
  const firstLabel = formatDateTime.format(new Date(snapshots[0].timestamp));
  const lastLabel = formatDateTime.format(new Date(snapshots.at(-1).timestamp));

  root.setAttribute("aria-label", `${candidate.name}票数趋势，${firstLabel}至${lastLabel}`);
  root.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff8200" stop-opacity="0.30"/><stop offset="1" stop-color="#ff8200" stop-opacity="0"/></linearGradient></defs>
    ${ticks}
    <polygon class="trend-area" points="${area}" />
    <polyline class="trend-line" points="${points}" />
    ${values.map((value, i) => `<circle class="trend-dot" cx="${x(i)}" cy="${y(value)}" r="${snapshots.length < 30 ? 3 : 0}" />`).join("")}
    <text class="axis-text" x="${pad.left}" y="${height - 10}">${firstLabel}</text>
    <text class="axis-text" x="${width - pad.right}" y="${height - 10}" text-anchor="end">${lastLabel}</text>
  </svg>`;

  renderDailyGrowth(index);
}

function renderDailyGrowth(index) {
  const byDay = new Map();
  for (const snapshot of state.data.snapshots) {
    const value = valueAt(snapshot, index);
    if (value === null) continue;
    const day = snapshot.timestamp.slice(0, 10);
    const entry = byDay.get(day) || { first: value, last: value };
    entry.last = value;
    byDay.set(day, entry);
  }
  const days = [...byDay.entries()].slice(-7).map(([day, entry]) => ({ day, growth: entry.last - entry.first }));
  const root = document.querySelector("#daily-growth");
  root.innerHTML = `<h3>最近每日增长</h3><div class="daily-list">${days.map(({ day, growth }) => `
    <div class="daily-item"><span>${day.slice(5)}</span><strong class="${metricClass(growth)}">${signed(growth)}</strong></div>
  `).join("")}</div>`;
}

function populateCandidateSelect(metrics) {
  const select = document.querySelector("#candidate-select");
  const previous = state.selectedId;
  select.innerHTML = metrics.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join("");
  state.selectedId = previous && state.data.candidates[previous] ? previous : metrics[0].id;
  select.value = state.selectedId;
}

function renderTable(metrics) {
  const query = state.search.trim().toLocaleLowerCase("zh-CN");
  const rows = metrics
    .filter((item) => !query || item.name.toLocaleLowerCase("zh-CN").includes(query) || item.id.includes(query))
    .sort((a, b) => {
      const av = a[state.sort] ?? -Infinity;
      const bv = b[state.sort] ?? -Infinity;
      return bv - av || b.votes - a.votes;
    });
  const body = document.querySelector("#ranking-body");
  body.innerHTML = rows.map((item) => `
    <tr>
      <td class="rank-cell">${item.index + 1}</td>
      <td class="candidate-cell"><strong>${escapeHtml(item.name)}</strong><small>ID ${item.id}</small></td>
      <td class="number">${formatNumber.format(item.votes)}</td>
      <td class="number ${metricClass(item.delta30)}">${signed(item.delta30)}</td>
      <td class="number ${metricClass(item.delta24)}">${signed(item.delta24)}</td>
      <td class="number ${metricClass(item.speed)}">${item.speed === null ? "—" : `${signed(Math.round(item.speed))}/h`}</td>
      <td class="number ${item.voters === null ? "unavailable" : ""}">${item.voters === null ? "—" : formatNumber.format(item.voters)}</td>
    </tr>
  `).join("");
  document.querySelector("#table-summary").textContent = `显示 ${rows.length} / ${metrics.length} 位候选人`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function render() {
  const metrics = getMetrics();
  renderKpis(metrics);
  renderRankingChart(metrics);
  populateCandidateSelect(metrics);
  renderTrend();
  renderTable(metrics);
}

function bindEvents() {
  document.querySelector("#candidate-select").addEventListener("change", (event) => {
    state.selectedId = event.target.value;
    renderTrend();
  });
  document.querySelectorAll("[data-range]").forEach((button) => {
    button.addEventListener("click", () => {
      state.range = button.dataset.range;
      document.querySelectorAll("[data-range]").forEach((item) => item.classList.toggle("active", item === button));
      renderTrend();
    });
  });
  document.querySelector("#search-input").addEventListener("input", (event) => {
    state.search = event.target.value;
    renderTable(getMetrics());
  });
  document.querySelector("#sort-select").addEventListener("change", (event) => {
    state.sort = event.target.value;
    renderTable(getMetrics());
  });
}

async function loadData() {
  try {
    const response = await fetch(`data/history.json?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data.snapshots?.length || !data.candidate_order?.length) throw new Error("数据文件没有历史记录");
    state.data = data;
    render();
  } catch (error) {
    document.querySelector("#error-message").textContent = error.message;
    document.querySelector("#error-state").hidden = false;
  }
}

bindEvents();
loadData();
setInterval(loadData, 5 * 60 * 1000);
