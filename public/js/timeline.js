// 时间线（Gantt）渲染
import { WEATHER_LEVELS } from './engine.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}, text) => {
  const node = document.createElementNS(SVGNS, name);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
  if (text != null) node.textContent = text;
  return node;
};

const W = 960, H = 330;
const PAD_L = 78, PAD_R = 10, PAD_T = 46, PAD_B = 18;
const LANE_H = 18, GAP = 4;
const weatherColor = { none: '#13241c', light: '#1e2e3c', mod: '#31405c', heavy: '#4a3a57' };

let dragCtx = null;
if (typeof window !== 'undefined') {
  window.addEventListener('mousemove', ev => { if (dragCtx) dragCtx.move(ev); });
  window.addEventListener('mouseup', () => { dragCtx = null; });
}

export function timelineGeom() {
  const x0 = PAD_L, x1 = W - PAD_R;
  return { x: t => x0 + (t / 240) * (x1 - x0), x0, x1, y0: PAD_T };
}

export function renderTimeline(root, { sim, now, playhead, selected, onSeek, onSelect }) {
  root.innerHTML = '';
  const g = timelineGeom();

  // 顶部摩擦带：两条跑道的“最低分段摩擦”曲线（μ 0.15~0.95 映射到 24px 高）
  const fBase = PAD_T - 2, fH = 22;
  const yOfMu = mu => fBase + (1 - (Math.max(0.15, Math.min(0.95, mu)) - 0.15) / 0.8) * fH;
  [['A', '#34d399'], ['B', '#4ea1ff']].forEach(([r, color]) => {
    let d = '';
    for (let tt = 0; tt <= 240; tt++) {
      let mu = 1;
      for (let seg = 0; seg < 6; seg++) mu = Math.min(mu, sim.friction[r][seg][tt]);
      d += `${tt === 0 ? 'M' : 'L'} ${g.x(tt).toFixed(1)} ${yOfMu(mu).toFixed(1)} `;
    }
    root.appendChild(el('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.3, opacity: 0.9 }));
  });
  root.appendChild(el('line', { x1: g.x0, y1: yOfMu(sim.minFriction), x2: g.x1, y2: yOfMu(sim.minFriction),
    stroke: '#f26067', 'stroke-width': 1, 'stroke-dasharray': '4 3' }));
  root.appendChild(el('text', { x: 8, y: PAD_T - 6, class: 'tl-lane-text', fill: '#8399b5' }, '最低 μ / 阈值 0.30'));

  // 天气底色（按降雪等级）
  sim.snowBuckets.forEach(b => {
    root.appendChild(el('rect', {
      x: g.x(b.from), y: PAD_T, width: g.x(b.to) - g.x(b.from), height: H - PAD_T - PAD_B,
      fill: weatherColor[b.level], opacity: 0.55,
    }));
    root.appendChild(el('text', { x: (g.x(b.from) + g.x(b.to)) / 2, y: 14,
      class: 'tl-axis-text', fill: '#a9c1de' }, WEATHER_LEVELS[b.level].label + `（${b.from}–${b.to}′）`));
  });

  // 车道定义：4 车 + 每个航班一条
  const lanes = [];
  const plowIds = [...new Set(sim.plowTasks.map(t => t.plowId))];
  plowIds.forEach(id => lanes.push({ kind: 'plow', id, label: id }));
  sim.flightPlans.forEach(p => lanes.push({ kind: 'flight', id: p.id, label: `${p.id}${p.type === 'dep' ? ' ↑' : ' ↓'}` }));

  // 网格与车道
  for (let tt = 0; tt <= 240; tt += 15) {
    const major = tt % 60 === 0;
    root.appendChild(el('line', { x1: g.x(tt), y1: PAD_T, x2: g.x(tt), y2: H - PAD_B,
      class: major ? 'tl-grid tl-grid-major' : 'tl-grid' }));
    root.appendChild(el('text', { x: g.x(tt), y: H - 5, class: 'tl-axis-text' },
      major ? `${tt}′` : ''));
  }
  lanes.forEach((lane, i) => {
    const y = PAD_T + i * (LANE_H + GAP);
    root.appendChild(el('rect', { x: g.x0, y, width: g.x1 - g.x0, height: LANE_H,
      class: i % 2 ? 'tl-lane-alt' : 'tl-lane-bg' }));
    root.appendChild(el('text', { x: g.x0 - 6, y: y + 12.5, class: 'tl-lane-text', 'text-anchor': 'end' }, lane.label));
    lane._y = y;
  });

  const laneY = id => lanes.find(l => l.id === id)?._y ?? 0;

  // 跑道可用性色条（两条细线）
  ['A', 'B'].forEach((r, idx) => {
    let runStart = null;
    for (let t = 0; t <= 240; t++) {
      const ok = sim.usable[r][t];
      if (ok && runStart === null) runStart = t;
      if ((!ok || t === 240) && runStart !== null) {
        const yBase = PAD_T - (idx === 0 ? 0 : 0);
        root.appendChild(el('rect', {
          x: g.x(runStart), y: PAD_T - 6 + idx * 4, width: g.x(t) - g.x(runStart), height: 3,
          fill: '#34d399', opacity: 0.9,
        }));
        runStart = null;
      }
    }
  });
  root.appendChild(el('text', { x: 8, y: PAD_T - 3, class: 'tl-lane-text' }, 'A/B 可用'));

  const selectedRefs = new Set(selected?.refIds || []);
  const barClass = (refIds, past) =>
    'tl-bar' + (refIds.some(r => selectedRefs.has(r)) ? ' selected' : '') + (past ? ' tl-future-dim' : '');

  // 车辆任务条
  sim.plowTasks.forEach(task => {
    const y = laneY(task.plowId);
    const past = task.end <= now;
    const color = past ? '#7c6a3a' : '#f5b942';
    const rect = el('rect', {
      x: g.x(task.start), y: y + 2, width: Math.max(2, g.x(task.end) - g.x(task.start)), height: LANE_H - 4,
      fill: color, class: barClass([task.id], past),
    });
    rect.addEventListener('click', () => onSelect({ type: 'plow', refIds: [task.id], plowId: task.plowId, runway: task.runway, seg: task.seg }));
    root.appendChild(rect);
    if (g.x(task.end) - g.x(task.start) > 26) {
      root.appendChild(el('text', { x: g.x(task.start) + 4, y: y + 12,
        fill: '#1a1407', 'font-size': 9 }, `${task.runway}${task.seg + 1}`));
    }
  });

  // 航班条：除冰段 + 防冰有效窗口 + 跑道占用
  sim.flightPlans.forEach(p => {
    const y = laneY(p.id);
    const past = p.ops.length && p.ops[p.ops.length - 1].end <= now;
    (p.deices || (p.deice ? [p.deice] : [])).forEach(d => {
      const r = el('rect', {
        x: g.x(d.start), y: y + 2, width: Math.max(2, g.x(d.end) - g.x(d.start)), height: LANE_H - 4,
        fill: past ? '#2c5d6b' : '#67d7ef', class: barClass([p.id], false),
      });
      r.addEventListener('click', () => onSelect({ type: 'flight', flightId: p.id, refIds: [p.id] }));
      root.appendChild(r);
    });
    // 防冰有效区间（最后一次除冰之后）
    if (p.deices?.length) {
      const d = p.deices[p.deices.length - 1];
      if (p.holdoverUntil && d.end < p.holdoverUntil) {
        root.appendChild(el('rect', {
          x: g.x(d.end), y: y + 5, width: g.x(p.holdoverUntil) - g.x(d.end), height: LANE_H - 10,
          class: 'tl-hold',
        }));
      }
    }
    p.ops.forEach((o, oi) => {
      const bad = p.status === 'diverted' || p.status === 'canceled';
      const r = el('rect', {
        x: g.x(o.start), y: y + 2, width: Math.max(2, g.x(o.end) - g.x(o.start)), height: LANE_H - 4,
        fill: past ? (bad ? '#7a3a3f' : '#2e7a58') : (bad ? '#f26067' : (p.type === 'dep' ? '#34d399' : '#4ea1ff')),
        class: barClass([p.id], past),
      });
      r.addEventListener('click', () => onSelect({ type: 'flight', flightId: p.id, refIds: [p.id] }));
      root.appendChild(r);
    });
    // 备降/取消：画红色虚框标记其决策时刻
    if (p.status === 'diverted' || p.status === 'canceled') {
      const tx = p.status === 'diverted' ? p.ready + 15 : (p.deices?.[p.deices.length - 1]?.end ?? p.ready);
      root.appendChild(el('line', { x1: g.x(tx), y1: y - 1, x2: g.x(tx), y2: y + LANE_H + 1,
        stroke: '#f26067', 'stroke-width': 1.4, 'stroke-dasharray': '3 2' }));
    }
  });

  // 告警时间标记（倒三角）
  sim.alerts.forEach(a => {
    const t = a.tStart;
    if (t == null) return;
    const x = g.x(t);
    const tri = el('path', {
      d: `M ${x - 5} 2 L ${x + 5} 2 L ${x} 10 Z`,
      fill: a.sev === 'high' ? '#f26067' : '#f5b942',
      style: 'cursor:pointer',
    });
    tri.addEventListener('click', () => onSelect({ type: 'alert', alertId: a.id, ...a, refIds: a.refIds || [a.flightId].filter(Boolean) }));
    root.appendChild(tri);
  });

  // 已执行区域遮罩（now 左侧淡黑，直观表示“真实历史”）
  root.appendChild(el('rect', { x: g.x0, y: PAD_T, width: g.x(now) - g.x0, height: H - PAD_T - PAD_B,
    fill: '#000', opacity: 0.16, pointerEvents: 'none' }));

  // now 线（真实执行）与播放头（视图查看时刻）
  root.appendChild(el('line', { x1: g.x(now), y1: PAD_T, x2: g.x(now), y2: H - PAD_B, class: 'tl-now' }));
  root.appendChild(el('text', { x: Math.min(g.x(now) + 4, g.x1 - 46), y: H - PAD_B + 13, class: 'tl-axis-text', fill: '#34d399', 'text-anchor': 'start' }, `已执行 ${now}′`));
  const ph = g.x(playhead ?? now);
  const head = el('line', { x1: ph, y1: PAD_T - 12, x2: ph, y2: H - PAD_B, class: 'tl-playhead' });
  root.appendChild(head);
  const handle = el('circle', { cx: ph, cy: PAD_T - 12, r: 5, fill: '#ffd166', style: 'cursor:grab' });
  root.appendChild(handle);

  // 拖动 / 点击跳转查看时刻
  const toTime = ev => {
    const rect = root.getBoundingClientRect();
    const sx = (ev.clientX - rect.left) / rect.width * W;
    return Math.max(0, Math.min(240, Math.round((sx - g.x0) / (g.x1 - g.x0) * 240)));
  };
  root.addEventListener('mousedown', ev => {
    dragCtx = { move: e2 => onSeek(toTime(e2)) };
    onSeek(toTime(ev));
  });
}
