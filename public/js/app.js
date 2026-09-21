// 主编排：方案管理、真实执行时钟、空间/时间线联动
import { runSim, defaultScenario, validateAgainstLocks } from './engine.js';
import { advanceAndRecompute } from './state.js';
import { renderMap, statusText } from './mapview.js';
import { renderTimeline } from './timeline.js';
import { renderSnowEditor, renderRunwayEditor, renderFlightEditor } from './editor.js';
import { WEATHER_LEVELS } from './engine.js';

const $ = sel => document.querySelector(sel);

const state = {
  plans: [],          // 列表摘要
  doc: null,          // 当前完整方案（含 sim）
  viewT: 0,           // 空间视图查看时刻
  playing: false,
  timer: null,
  selected: null,
  dirty: false,       // 编辑后尚未重推演
};

// ---------------- API ----------------
const api = {
  async list() { return (await fetch('/api/plans').then(r => r.json())).plans; },
  async get(id) { return (await fetch('/api/plans/' + id).then(r => r.json())).doc; },
  async create(name, scenario) {
    return (await fetch('/api/plans', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, scenario }) }).then(r => r.json())).doc;
  },
  async update(id, payload) {
    const r = await fetch('/api/plans/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload) });
    if (!r.ok) throw new Error((await r.json()).error);
    return (await r.json()).doc;
  },
  async tick(id, now, speed) {
    return (await fetch(`/api/plans/${id}/tick`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ now, speed }) }).then(r => r.json())).doc;
  },
  async clone(id, name) {
    return (await fetch(`/api/plans/${id}/clone`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }) }).then(r => r.json())).doc;
  },
  async reset(id) { await fetch('/api/plans/' + id + '/reset', { method: 'POST' }); },
  async del(id) { await fetch('/api/plans/' + id, { method: 'DELETE' }); },
};

// ---------------- 工具 ----------------
const fmtClock = t => {
  const h = String(Math.floor(t / 60)).padStart(2, '0');
  const m = String(t % 60).padStart(2, '0');
  return `${h}:${m}`;
};
function toast(msg, bad) {
  const d = document.createElement('div');
  d.className = 'toast' + (bad ? ' bad' : '');
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 2600);
}

// ---------------- 渲染 ----------------
function renderAll() {
  const doc = state.doc;
  if (!doc) return;
  $('#clockText').textContent = fmtClock(doc.now);
  $('#clockNote').textContent = doc.now >= 240 ? '执行结束' : '真实执行 T+' + doc.now + '′';
  $('#playBtn').textContent = state.playing ? '⏸ 暂停' : (doc.now >= 240 ? '✓ 已结束' : '▶ 执行');
  $('#speedSel').value = String(doc.speed);

  // 天气
  const lvlKey = (doc.sim.snowBuckets.find(b => doc.now >= b.from && doc.now < b.to) || {}).level || 'none';
  const lvl = WEATHER_LEVELS[lvlKey];
  $('#weatherNow').innerHTML = `当前降雪：<b>${lvl.label}</b> · 防冰有效 ${lvl.holdover}′ · 跑道最低 μ ${doc.sim.minFriction}`;

  renderSnowEditor($('#snowEditor'), doc.scenario, doc.locks, scheduleReplan);
  renderRunwayEditor($('#runwayEditor'), doc.scenario, doc.locks, scheduleReplan);
  renderFlightEditor($('#flightEditor'), doc.scenario, doc.locks, doc.now, scheduleReplan);

  renderStats(doc);
  renderAlerts(doc);
  renderFlights(doc);
  renderMap($('#mapSvg'), {
    sim: doc.sim, t: state.viewT, selected: state.selected,
    onSelect: setSelected, hoverBus: showTooltip,
  });
  renderTimeline($('#timelineSvg'), {
    sim: doc.sim, now: doc.now, playhead: state.viewT,
    selected: state.selected,
    onSeek: t => { state.viewT = t; renderViewsOnly(); },
    onSelect: setSelected,
  });
}

function renderViewsOnly() {
  const doc = state.doc;
  renderMap($('#mapSvg'), { sim: doc.sim, t: state.viewT, selected: state.selected,
    onSelect: setSelected, hoverBus: showTooltip });
  renderTimeline($('#timelineSvg'), { sim: doc.sim, now: doc.now, playhead: state.viewT,
    selected: state.selected, onSeek: t => { state.viewT = t; renderViewsOnly(); }, onSelect: setSelected });
}

function renderStats(doc) {
  const s = doc.sim.summary;
  const cards = [
    ['good', s.departed, '已起飞'], ['accent', s.arrived, '已落地'],
    ['warn', s.delayed, '延误超 5′'], ['bad', s.diverted, '备降/复飞'],
    ['bad', s.canceled, '取消'], ['warn', s.retries, '重复除冰'],
    ['bad', s.highAlerts, '高危告警'], ['warn', s.medAlerts, '中等告警'],
    ['accent', s.usableMins.A + s.usableMins.B, '跑道可用分钟'],
  ];
  $('#stats').innerHTML = cards.map(([cls, n, l]) =>
    `<div class="stat ${cls}"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
}

const ALERT_META = {
  icefail:   { name: '防冰失效', icon: '🧊' },
  intrusion: { name: '车辆侵入起降区', icon: '🚜' },
  cross:     { name: '双跑道交叉冲突', icon: '✖' },
  divert:    { name: '航空器备降', icon: '↩' },
};

function renderAlerts(doc) {
  const box = $('#alertList');
  const alerts = [...doc.sim.alerts].sort((a, b) => (a.tStart ?? 999) - (b.tStart ?? 999));
  $('#alertCount').textContent = alerts.length;
  $('#alertCount').className = 'count' + (alerts.length ? '' : ' zero');
  if (!alerts.length) {
    box.innerHTML = '<div class="hint">当前推演未发现冲突。大雪持续时调整清扫顺序或延后航班，可能触发防冰失效、车辆侵入或双跑冲突。</div>';
    return;
  }
  box.innerHTML = '';
  alerts.forEach(a => {
    const locked = (doc.locks.alerts || []).some(x => x.id === a.id);
    const item = document.createElement('div');
    item.className = `alert-item ${a.sev === 'med' ? 'med' : ''} ${locked ? 'locked' : ''}`;
    if (state.selected?.alertId === a.id) item.classList.add('selected');
    const meta = ALERT_META[a.kind] || { name: a.kind, icon: '!' };
    const locText = a.tStart != null
      ? `T+${a.tStart}′${a.runway ? ` · 跑道 ${a.runway}` : ''}${a.seg != null ? ` 第 ${a.seg + 1} 段` : ''}`
      : '';
    item.innerHTML = `<div class="alert-head"><span>${meta.icon} ${meta.name}</span>
      <span class="alert-kind">${a.sev === 'high' ? '高危' : '中等'}</span></div>
      <div class="alert-msg">${a.msg}</div>
      <div class="alert-loc">${locText} ${locked ? '<span class="alert-locked-tag">· 已实际发生并锁定</span>' : ''}</div>`;
    item.addEventListener('click', () => setSelected({ type: 'alert', alertId: a.id, ...a,
      refIds: a.refIds || [a.flightId].filter(Boolean) }));
    box.appendChild(item);
  });
}

function renderFlights(doc) {
  const box = $('#flightList');
  box.innerHTML = '';
  [...doc.sim.flightPlans]
    .sort((a, b) => (a.ready) - (b.ready))
    .forEach(p => {
      const op = p.ops[p.ops.length - 1];
      let phase = p.status;
      if (op && state.viewT >= op.start && state.viewT < op.end) phase = 'running';
      const item = document.createElement('div');
      item.className = `f-item ${p.type} ${p.status}` + (state.selected?.flightId === p.id ? ' selected' : '');
      const opText = op ? `窗口 T+${op.start}–${op.end}′` : '未获得窗口';
      item.innerHTML = `
        <div class="fid">${p.id}</div>
        <div><div>${p.type === 'dep' ? '离港↑' : '进港↓'} · ${p.runway} 跑道 · ${p.seats} 座</div>
        <div class="f-line2">计划 T+${p.sched}′${p.delay ? ` <span style="color:#f5b942">+${p.delay}′</span>` : ''} · ${opText}${p.retries ? ` · 重除冰×${p.retries}` : ''}</div></div>
        <span class="f-status ${phase}">${statusText(p.status)}</span>`;
      item.addEventListener('click', () => setSelected({ type: 'flight', flightId: p.id, refIds: [p.id] }));
      box.appendChild(item);
    });
}

// ---------------- 选中联动（空间 + 时间线定位） ----------------
function setSelected(sel) {
  state.selected = sel;
  // 告警 / 航班 / 车辆：把视图时刻跳到事件时刻
  if (sel.tStart != null) {
    state.viewT = Math.max(0, Math.min(240, sel.tStart + 1));
  } else if (sel.type === 'flight') {
    const p = state.doc.sim.flightPlans.find(x => x.id === sel.flightId);
    if (p) state.viewT = Math.min(240, (p.ops[0]?.start ?? p.deice?.end ?? p.ready) + 1);
  } else if (sel.type === 'plow') {
    const task = state.doc.sim.plowTasks.find(t => t.id === sel.refIds[0]);
    if (task) state.viewT = task.start + 1;
  } else if (sel.type === 'segment') {
    // 停留在当前查看时刻即可
  }
  renderAll();
  // 滚动告警到可见
  if (sel.alertId) {
    [...$('#alertList').children].forEach(c => {
      if (c.textContent.includes(sel.alertId)) c.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }
}

function showTooltip(tip) {
  const tt = $('#mapTooltip');
  if (!tip) { tt.hidden = true; return; }
  tt.hidden = false;
  tt.innerHTML = tip.html;
  const wrap = $('.map-wrap').getBoundingClientRect();
  tt.style.left = Math.min(wrap.width - 250, tip.x - wrap.left + 14) + 'px';
  tt.style.top = (tip.y - wrap.top + 14) + 'px';
}

// ---------------- 编辑 / 重推演 / 持久化 ----------------
let replanTimer = null;
function scheduleReplan() {
  state.dirty = true;
  clearTimeout(replanTimer);
  $('#replanBtn').textContent = '重新推演未来 ●';
  replanTimer = setTimeout(replan, 400);  // 编辑停顿后自动重推演；也可手动点按钮
}

async function replan() {
  const doc = state.doc;
  const v = validateAgainstLocks(doc.scenario, doc.locks);
  if (!v.ok) { toast(v.errors[0], true); return; }
  // 本地立即推演以保持交互流畅
  advanceAndRecompute(doc);
  renderAll();
  try {
    state.doc = await api.update(doc.id, { scenario: doc.scenario });
    renderAll();
    toast('已按最新调整重推演，真实进度保持不变');
  } catch (e) {
    toast('保存失败：' + e.message, true);
  } finally {
    $('#replanBtn').textContent = '重新推演未来';
    state.dirty = false;
  }
}

// ---------------- 执行时钟 ----------------
function startPlay() {
  if (state.playing || state.doc.now >= 240) return;
  state.playing = true;
  $('#playBtn').textContent = '⏸ 暂停';
  const tick = async () => {
    if (!state.playing || !state.doc) return;
    const speed = Number($('#speedSel').value) || 1;
    const next = Math.min(240, state.doc.now + 1);
    try {
      state.doc = await api.tick(state.doc.id, next, speed);
      state.viewT = state.doc.now;
      renderAll();
    } catch (e) { toast('执行同步失败：' + e.message, true); }
    if (state.doc.now >= 240) { stopPlay(); toast('全部处置已执行完毕'); return; }
    state.timer = setTimeout(tick, 1000 / speed);
  };
  tick();
}
function stopPlay() {
  state.playing = false;
  clearTimeout(state.timer);
  if (state.doc) $('#playBtn').textContent = state.doc.now >= 240 ? '✓ 已结束' : '▶ 执行';
}

async function stepOnce() {
  stopPlay();
  const next = Math.min(240, state.doc.now + 5);
  state.doc = await api.tick(state.doc.id, next, state.doc.speed);
  state.viewT = state.doc.now;
  renderAll();
  if (next >= 240) toast('全部处置已执行完毕');
}

// ---------------- 方案管理 ----------------
async function refreshPlanList(selectId) {
  state.plans = await api.list();
  const sel = $('#planSelect');
  sel.innerHTML = '';
  state.plans.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    const ab = (p.summary?.diverted || 0) + (p.summary?.canceled || 0);
    opt.textContent = `${p.name} · T+${p.now}′ · ${p.highAlerts ? p.highAlerts + '高危 ' : ''}${ab}异常`;
    sel.appendChild(opt);
  });
  if (selectId) sel.value = selectId;
}

async function loadPlan(id) {
  stopPlay();
  state.doc = await api.get(id);
  state.viewT = state.doc.now;
  state.selected = null;
  await refreshPlanList(id);
  renderAll();
}

async function createPlan() {
  stopPlay();
  const name = prompt('方案名称', `处置方案 ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  if (name === null) return;
  const doc = await api.create(name || '处置方案', defaultScenario());
  await refreshPlanList(doc.id);
  await loadPlan(doc.id);
  toast('已创建新方案');
}

async function clonePlan() {
  stopPlay();
  const copy = await api.clone(state.doc.id, state.doc.name + ' 副本');
  await refreshPlanList(copy.id);
  await loadPlan(copy.id);
  toast('已另存一套方案，真实执行进度一并复制');
}

async function resetPlan() {
  if (!confirm(`确定重置「${state.doc.name}」？这将放弃全部真实执行进度，不可恢复。`)) return;
  const id = state.doc.id;
  await api.reset(id);
  state.plans = state.plans.filter(p => p.id !== id);
  if (!state.plans.length) {
    const doc = await api.create('初始处置方案', defaultScenario());
    await refreshPlanList(doc.id);
    await loadPlan(doc.id);
  } else {
    await loadPlan(state.plans[0].id);
  }
  toast('已重置执行进度');
}

// ---------------- 启动 ----------------
async function boot() {
  $('#playBtn').addEventListener('click', () => state.playing ? stopPlay() : startPlay());
  $('#stepBtn').addEventListener('click', stepOnce);
  $('#nowBtn').addEventListener('click', () => { state.viewT = state.doc.now; renderViewsOnly(); });
  $('#replanBtn').addEventListener('click', replan);
  $('#newPlanBtn').addEventListener('click', createPlan);
  $('#clonePlanBtn').addEventListener('click', clonePlan);
  $('#resetPlanBtn').addEventListener('click', resetPlan);
  $('#planSelect').addEventListener('change', e => loadPlan(e.target.value));
  $('#speedSel').addEventListener('change', async e => {
    state.doc.speed = Number(e.target.value);
    await api.update(state.doc.id, { name: state.doc.name });
  });

  state.plans = await api.list();
  if (!state.plans.length) {
    const doc = await api.create('初始处置方案', defaultScenario());
    await refreshPlanList(doc.id);
    state.doc = doc;
  } else {
    await loadPlan(state.plans[0].id);
  }
  state.viewT = state.doc.now;
  renderAll();
}

boot();
