// 机场空间布局（SVG 坐标，viewBox 1000 x 560）
// A 跑道东西向；B 跑道斜向，两跑在各自第 2/3 段交界附近交叉。

export const VIEW_W = 1000;
export const VIEW_H = 560;

const RUNWAY = {
  A: { p1: { x: 130, y: 250 }, p2: { x: 850, y: 250 }, width: 46, segments: 6 },
  B: { p1: { x: 370, y: 470 }, p2: { x: 706, y: 58 },  width: 46, segments: 6 },
};

export const STAGING_A = { x: 250, y: 188, label: 'A 跑道车辆等待区' };
export const STAGING_B = { x: 430, y: 500, label: 'B 跑道车辆等待区' };
export const DEICE_PADS = [
  { x: 150, y: 430, id: '除冰位 D1' },
  { x: 230, y: 452, id: '除冰位 D2' },
  { x: 310, y: 472, id: '除冰位 D3' },
];
export const GATES = [
  { x: 96, y: 120, id: '廊桥 1' }, { x: 96, y: 165, id: '廊桥 2' },
  { x: 96, y: 330, id: '廊桥 3' }, { x: 96, y: 375, id: '廊桥 4' },
];
export const TAXIWAYS = [
  'M 120 120 L 180 228',
  'M 120 375 L 190 272',
  'M 340 470 Q 300 380 260 278',     // 除冰坪 → A/B
  'M 300 470 Q 380 420 408 380',
  'M 820 250 L 880 320 L 880 470',   // A 东端 → 南侧滑行
];

const lerp = (p1, p2, f) => ({ x: p1.x + (p2.x - p1.x) * f, y: p1.y + (p2.y - p1.y) * f });

export function runwayEnds(id) {
  const r = RUNWAY[id];
  return { ...r };
}

// 第 i 段（0-based）的多边形四点（沿跑道方向等长切分）
export function segmentPoly(id, i) {
  const r = RUNWAY[id];
  const f0 = i / r.segments;
  const f1 = (i + 1) / r.segments;
  const a = lerp(r.p1, r.p2, f0);
  const b = lerp(r.p1, r.p2, f1);
  const dx = r.p2.x - r.p1.x, dy = r.p2.y - r.p1.y;
  const len = Math.hypot(dx, dy);
  const nx = -dy / len * r.width / 2, ny = dx / len * r.width / 2;
  return [
    { x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny },
  ];
}

export function segmentCenter(id, i) {
  const r = RUNWAY[id];
  return lerp(r.p1, r.p2, (i + 0.5) / r.segments);
}

// 交叉点（A 的 y=250；B 参数解出）
export const CROSS_POINT = (() => {
  const a = RUNWAY.A, b = RUNWAY.B;
  const f = (a.p1.y - b.p1.y) / (b.p2.y - b.p1.y);
  const p = lerp(b.p1, b.p2, f);
  return { ...p, segA: 2, segB: 2 };
})();

export function runwayLine(id) {
  const r = RUNWAY[id];
  return { x1: r.p1.x, y1: r.p1.y, x2: r.p2.x, y2: r.p2.y };
}

export function thresholdPoints(id) {
  const r = RUNWAY[id];
  return [lerp(r.p1, r.p2, 0.015), lerp(r.p1, r.p2, 0.985)];
}

// 任务进行中车辆位置：等待区 → 分段中心（简单线性近似）
export function vehiclePos(plowId, task, t) {
  const center = segmentCenter(task.runway, task.seg);
  const staging = task.runway === 'A' ? STAGING_A : STAGING_B;
  if (t < task.start) return { ...staging };
  if (t >= task.end) return center;
  const f = (t - task.start) / (task.end - task.start);
  return lerp(staging, center, Math.min(1, f * 1.2));
}

// 航空器位置：起飞/落地窗口内在跑道上按方向移动，否则在廊桥/除冰坪或五边
const flightPad = {};
let padCursor = 0;
export function aircraftPos(plan, t) {
  const r = RUNWAY[plan.runway];
  const op = plan.ops[plan.ops.length - 1];
  if (plan.type === 'arr') {
    if (op && t >= op.start && t <= op.end) {
      const f = (t - op.start) / (op.end - op.start);
      return { ...lerp(r.p2, r.p1, f), onRunway: true };
    }
    if (op && t > op.end) {
      if (t - op.end <= 8) {
        const f = (t - op.end) / 8;
        return { x: r.p1.x - 20 - f * 60, y: r.p1.y + 30 + f * 80, onRunway: false };
      }
      const slot = plan.id.charCodeAt(2) % 4;
      return { x: 120, y: 120 + slot * 85, onRunway: false, parked: true };
    }
    // 五边进近：从跑道入口方向外侧逼近；备降后转向飞离
    const decision = plan.ready + 15;
    if (t > decision) {
      const dt = t - decision;
      if (dt <= 8) return { x: r.p2.x + 30 + dt * 20, y: r.p2.y - 40 - dt * 16, onRunway: false, diverting: true };
      return null;
    }
    const approachStart = Math.max(0, (op?.start ?? decision) - 8);
    const f = Math.max(0, Math.min(1, (t - approachStart) / (((op?.start ?? decision)) - approachStart)));
    const out = { x: r.p2.x + 120 * (1 - f), y: r.p2.y - 90 * (1 - f) };
    return { ...lerp(out, r.p2, f * 0.9), onRunway: false };
  }
  // dep
  if (!flightPad[plan.id]) { flightPad[plan.id] = DEICE_PADS[padCursor % DEICE_PADS.length]; padCursor += 1; }
  const pad = flightPad[plan.id];
  if (op && t >= op.start && t <= op.end) {
    const f = (t - op.start) / (op.end - op.start);
    return { ...lerp(r.p1, r.p2, f), onRunway: true };
  }
  if (op && t > op.end) {
    // 起飞后 6 分钟内爬升离开画面，之后不再绘制
    if (t - op.end <= 6) {
      return { x: r.p2.x + 20 + (t - op.end) * 22, y: r.p2.y - 16 - (t - op.end) * 18, onRunway: false, climbing: true };
    }
    return null;
  }
  // 除冰/滑行阶段：廊桥 → 除冰坪（0~ready），除冰坪停留到起飞
  if (t < (plan.deice?.start ?? plan.ready)) {
    return { x: 96, y: 330 + (plan.id.charCodeAt(2) % 2) * 45, onRunway: false };
  }
  if (plan.status === 'canceled') return { x: pad.x, y: pad.y, onRunway: false, canceled: true };
  return { x: pad.x, y: pad.y, onRunway: false, deicing: t >= (plan.deice?.start ?? plan.ready) && t < (op?.start ?? Infinity) };
}

export const polyToPoints = poly => poly.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
