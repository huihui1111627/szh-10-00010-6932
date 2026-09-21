// 空间视图渲染（SVG）
import {
  VIEW_W, VIEW_H, runwayLine, segmentPoly, segmentCenter, polyToPoints,
  CROSS_POINT, STAGING_A, STAGING_B, DEICE_PADS, GATES, TAXIWAYS, thresholdPoints,
  vehiclePos, aircraftPos,
} from './geo.js';
import { RUNWAY_DEFS } from './engine.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}, text) => {
  const node = document.createElementNS(SVGNS, name);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
  if (text != null) node.textContent = text;
  return node;
};

export function muColor(mu) {
  if (mu >= 0.50) return '#2f7d52';
  if (mu >= 0.40) return '#4e9a5f';
  if (mu >= 0.30) return '#b78a2a';
  return '#b3402f';
}

export function renderMap(root, { sim, t, selected, onSelect, hoverBus }) {
  root.innerHTML = '';
  const defs = el('defs');
  defs.innerHTML = `
    <pattern id="crossHatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="8" height="8" fill="rgba(245,185,66,.10)"/>
      <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(245,185,66,.55)" stroke-width="2"/>
    </pattern>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="1.4"/>
    </filter>`;
  root.appendChild(defs);

  const showAlert = selected?.kind;
  const crossFlash = showAlert === 'cross';
  const intrusion = showAlert === 'intrusion' ? selected : null;

  // 滑行道
  TAXIWAYS.forEach(d => {
    const path = el('path', { d, class: 'taxi' });
    root.appendChild(path);
    const dash = el('path', { d, class: 'taxi-center' });
    root.appendChild(dash);
  });

  // 廊桥 / 除冰坪 / 等待区
  GATES.forEach(g => {
    root.appendChild(el('rect', { x: g.x - 24, y: g.y - 12, width: 48, height: 24, rx: 5, class: 'gate' }));
    root.appendChild(el('text', { x: g.x, y: g.y + 3, class: 'gate-label' }, g.id));
  });
  DEICE_PADS.forEach(pad => {
    root.appendChild(el('rect', { x: pad.x - 30, y: pad.y - 13, width: 60, height: 26, rx: 6, class: 'pad' }));
    root.appendChild(el('text', { x: pad.x, y: pad.y + 3, class: 'pad-label' }, pad.id));
  });
  [STAGING_A, STAGING_B].forEach(s => {
    root.appendChild(el('rect', { x: s.x - 26, y: s.y - 12, width: 52, height: 24, rx: 6, class: 'staging' }));
    root.appendChild(el('text', { x: s.x, y: s.y + 3, class: 'staging-label' }, s.label.includes('A') ? '车 A' : '车 B'));
  });

  // 跑道基板
  ['A', 'B'].forEach(id => {
    const rl = runwayLine(id);
    root.appendChild(el('line', { x1: rl.x1, y1: rl.y1, x2: rl.x2, y2: rl.y2,
      stroke: '#1b2738', 'stroke-width': 46, 'stroke-linecap': 'round', class: 'rw-slab' }));
  });

  // 分段（按当前时刻摩擦着色）
  ['A', 'B'].forEach(id => {
    const n = RUNWAY_DEFS[id].segments;
    for (let seg = 0; seg < n; seg++) {
      const mu = sim.friction[id][seg][Math.min(t, sim.tEnd)];
      const poly = segmentPoly(id, seg);
      const isClosed = sim.closed[id].includes(seg);
      // 关闭且尚未完成初扫：显示为“待清扫”褐色；其余按实时摩擦着色
      const swept = (sim.plowTasks || []).some(task => task.runway === id && task.seg === seg && task.end <= t);
      const fill = (isClosed && !swept) ? '#5a3c16' : muColor(mu);
      const cell = el('polygon', {
        points: polyToPoints(poly),
        class: 'seg-cell',
        fill,
        opacity: 0.92,
        'data-runway': id, 'data-seg': seg,
      });
      if (isClosed && !swept) {
        cell.addEventListener('mousemove', ev => hoverBus({
          html: `<b>跑道 ${id} 第 ${seg + 1} 段</b><br>初始关闭段，等待初扫<br>当前 μ=${mu.toFixed(2)}`,
          x: ev.clientX, y: ev.clientY,
        }));
      }
      cell.addEventListener('click', () => onSelect({ type: 'segment', runway: id, seg }));
      cell.addEventListener('mousemove', ev => hoverBus({
        html: `<b>跑道 ${id} 第 ${seg + 1} 段</b><br>摩擦系数 μ=${mu.toFixed(2)}`
          + `<br>${isClosed ? '初始关闭段（需初扫）' : '初始开放段'}<br>状态：${sim.usable[id][Math.min(t, sim.tEnd)] ? '可起降' : '不可起降'}`,
        x: ev.clientX, y: ev.clientY,
      }));
      cell.addEventListener('mouseleave', () => hoverBus(null));
      root.appendChild(cell);
      const c = segmentCenter(id, seg);
      root.appendChild(el('text', { x: c.x, y: c.y + 3, class: 'seg-num' }, String(seg + 1)));
    }
  });

  // 选中分段的轮廓
  if (selected?.type === 'segment') {
    const poly = segmentPoly(selected.runway, selected.seg);
    root.appendChild(el('polygon', { points: polyToPoints(poly), fill: 'none',
      stroke: '#ffd166', 'stroke-width': 3, class: 'selected-halo', style: 'pointer-events:none' }));
  }

  // 交叉点区域（双跑互斥区）
  const cpoly = (() => {
    const a2 = segmentPoly('A', CROSS_POINT.segA);
    const b2 = segmentPoly('B', CROSS_POINT.segB);
    return { x: CROSS_POINT.x - 16, y: CROSS_POINT.y - 16, w: 32, h: 32 };
  })();
  const crossRect = el('rect', { x: cpoly.x, y: cpoly.y, width: cpoly.w, height: cpoly.h,
    rx: 6, class: 'cross-zone' + (crossFlash ? ' flash' : ''),
    transform: `rotate(-54 ${CROSS_POINT.x} ${CROSS_POINT.y})` });
  crossRect.style.cursor = 'pointer';
  crossRect.addEventListener('click', () => onSelect({ type: 'cross' }));
  root.appendChild(crossRect);
  if (crossFlash) {
    root.appendChild(el('circle', { cx: CROSS_POINT.x, cy: CROSS_POINT.y, r: 14, class: 'alert-ring flash' }));
  }
  if (selected?.type === 'cross') {
    root.appendChild(el('circle', { cx: CROSS_POINT.x, cy: CROSS_POINT.y, r: 18, class: 'selected-halo' }));
  }
  root.appendChild(el('text', { x: CROSS_POINT.x, y: CROSS_POINT.y - 24, class: 'rw-label', 'text-anchor': 'middle' }, '交叉点'));

  // 跑道中心线、边线、入口
  ['A', 'B'].forEach(id => {
    const rl = runwayLine(id);
    root.appendChild(el('line', { x1: rl.x1, y1: rl.y1, x2: rl.x2, y2: rl.y2, class: 'rw-center' }));
    const ends = thresholdPoints(id);
    ends.forEach(p => {
      const dx = rl.x2 - rl.x1, dy = rl.y2 - rl.y1;
      const len = Math.hypot(dx, dy);
      root.appendChild(el('line', {
        x1: p.x - (-dy / len) * 18, y1: p.y - (dx / len) * 18,
        x2: p.x + (-dy / len) * 18, y2: p.y + (dx / len) * 18,
        class: 'threshold',
      }));
    });
    const labelP = id === 'A' ? { x: rl.x1 + 4, y: rl.y1 - 30 } : { x: rl.x1 - 40, y: rl.y1 + 16 };
    root.appendChild(el('text', { x: labelP.x, y: labelP.y, class: 'rw-label' }, RUNWAY_DEFS[id].name));
  });

  // 车辆（清扫/除冰车）：只渲染“当前时刻正在执行”的任务；已完成的用停车位置示意
  const activeTasks = sim.plowTasks.filter(task => task.start <= t && task.end > t);
  const parkedPlows = new Map();
  sim.plowTasks.forEach(task => {
    if (task.end <= t && !activeTasks.some(a => a.plowId === task.plowId)) {
      parkedPlows.set(task.plowId, task);
    }
  });
  new Set(sim.plowTasks.map(task => task.plowId)).forEach(plowId => {
    const active = activeTasks.find(a => a.plowId === plowId);
    const parked = !active && [...parkedPlows.values()].filter(x => x.plowId === plowId).pop();
    const task = active || parked;
    if (!task) return;
    const pos = vehiclePos(plowId, task, t);
    drawVehicle(root, plowId, pos, {
      active: !!active,
      selected: selected?.refIds?.includes(task.id) || (intrusion?.plowId === plowId && t >= intrusion.tStart - 2),
      flashing: intrusion?.plowId === plowId,
      angle: task.runway === 'A' ? 0 : -54,
      onSelect: () => onSelect({ type: 'plow', refIds: [task.id], plowId, runway: task.runway, seg: task.seg }),
      hover: ev => hoverBus({ html: `<b>${plowId}</b><br>${task.runway} 跑道第 ${task.seg + 1} 段<br>${active ? '正在清扫作业' : '停放/转场'} ${task.start}–${task.end}′`, x: ev.clientX, y: ev.clientY }),
      leave: () => hoverBus(null),
    });
  });

  // 航空器
  sim.flightPlans.forEach(plan => {
    const pos = aircraftPos(plan, t);
    if (!pos) return;
    const isBad = plan.status === 'diverted' || plan.status === 'canceled';
    const selectedFlight = selected?.flightId === plan.id || selected?.refIds?.includes(plan.id);
    drawAircraft(root, plan, pos, {
      bad: isBad, selected: !!selectedFlight,
      flashing: selectedFlight && (selected?.kind === 'icefail' || selected?.kind === 'intrusion' || selected?.kind === 'cross'),
      deicing: pos.deicing,
      onSelect: () => onSelect({ type: 'flight', flightId: plan.id, refIds: [plan.id] }),
      hover: ev => hoverBus({ html: flightTip(plan), x: ev.clientX, y: ev.clientY }),
      leave: () => hoverBus(null),
    });
  });
}

function flightTip(plan) {
  const op = plan.ops[plan.ops.length - 1];
  const typeName = plan.type === 'dep' ? '离港' : '进港';
  let extra = '';
  if (plan.deice) extra = `<br>除冰 ${plan.deice.start}–${plan.deice.end}′，防冰有效至 ${plan.holdoverUntil ?? '—'}′`;
  if (op) extra += `<br>跑道占用 ${op.start}–${op.end}′（${op.runway}）`;
  if (plan.retries) extra += `<br>重复除冰 ${plan.retries} 次`;
  return `<b>${plan.id}</b>（${typeName} · ${plan.runway} 跑道）<br>计划 ${plan.sched}′`
    + (plan.delay ? ` <span style="color:#f5b942">+延后 ${plan.delay}′</span>` : '')
    + `<br>状态：${statusText(plan.status)}` + extra;
}

export function statusText(s) {
  return ({
    departed: '已起飞', 'departed-retry': '重复除冰后起飞', arrived: '已落地',
    diverted: '备降/复飞', canceled: '取消', pending: '待处理',
  })[s] || s;
}

function drawVehicle(root, plowId, pos, opts) {
  const g = el('g', { transform: `translate(${pos.x},${pos.y}) rotate(${opts.angle})`, class: 'vehicle' });
  g.style.cursor = 'pointer';
  g.addEventListener('click', ev => { ev.stopPropagation(); opts.onSelect(); });
  g.addEventListener('mousemove', opts.hover);
  g.addEventListener('mouseleave', opts.leave);
  // 铲刀 + 车身
  g.appendChild(el('path', { d: 'M -11 5 L -14 9 M -11 -5 L -14 -9', class: 'plow-blade' }));
  g.appendChild(el('rect', { x: -9, y: -5, width: 16, height: 10, rx: 2.5, class: 'plow-body' }));
  g.appendChild(el('circle', { cx: 5, cy: -5, r: 2, fill: '#ff8a8a' }));
  if (opts.flashing) {
    g.appendChild(el('circle', { cx: -1, cy: 0, r: 9, class: 'alert-ring flash' }));
  }
  if (opts.selected) g.appendChild(el('circle', { cx: -1, cy: 0, r: 12, class: 'selected-halo' }));
  const label = el('text', { x: -1, y: -9, class: 'aircraft-label' }, plowId.replace(/[^0-9]/g, ''));
  g.appendChild(label);
  root.appendChild(g);
}

function drawAircraft(root, plan, pos, opts) {
  const g = el('g', {
    transform: `translate(${pos.x},${pos.y}) rotate(${plan.type === 'arr' ? 180 : 0})`,
    class: 'aircraft',
  });
  g.style.cursor = 'pointer';
  g.addEventListener('click', ev => { ev.stopPropagation(); opts.onSelect(); });
  g.addEventListener('mousemove', opts.hover);
  g.addEventListener('mouseleave', opts.leave);
  const cls = plan.type === 'dep' ? (opts.bad ? 'bad' : 'dep') : (opts.bad ? 'bad' : 'arr');
  // 飞机外形（俯视）
  const d = 'M 14 0 L -8 -4 L -12 -9 L -14 -9 L -11 -3 L -15 -2 L -15 2 L -11 3 L -14 9 L -12 9 L -8 4 Z';
  g.appendChild(el('path', { d, fill: 'currentColor', class: cls,
    style: `color:${opts.bad ? '#f26067' : plan.type === 'dep' ? '#34d399' : '#4ea1ff'}` }));
  if (opts.deicing) g.appendChild(el('circle', { cx: 0, cy: 0, r: 13, class: 'hold-ring' }));
  if (opts.flashing) g.appendChild(el('circle', { cx: 0, cy: 0, r: 10, class: 'alert-ring flash' }));
  if (opts.selected) g.appendChild(el('circle', { cx: 0, cy: 0, r: 15, class: 'selected-halo' }));
  root.appendChild(g);
  root.appendChild(el('text', { x: pos.x, y: pos.y - 14, class: 'aircraft-label' }, plan.id));
}
