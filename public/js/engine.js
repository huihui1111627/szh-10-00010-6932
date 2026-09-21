// 机场冬季运行推演引擎（纯函数，浏览器与 Node 共用）
// 时间单位：分钟（0 = 计划基准时刻），推演窗口 4 小时。摩擦系数 mu：0~1。

export const T_END = 240;
export const MIN_FRICTION = 0.30;   // 起降最低摩擦系数
export const RESWEEP_AT = 0.40;     // 摩擦降到该值即安排二次清扫
export const HOLD_DIST = 6;         // 航空器占用跑道时长（分钟）
export const DEICE_TIME = 10;       // 除冰作业时长
export const DEICE_MAX_RETRY = 2;
export const PLOW_SPEED = 2;        // 清扫一个分段耗时（分钟/段）
export const PLOW_REPOSITION = 1;   // 相邻分段移位耗时
export const ARR_HOLD_LIMIT = 15;   // 进近航空器最长等待（分钟）

export const WEATHER_LEVELS = {
  none:  { label: '晴好', rate: 0.000, holdover: 90 },
  light: { label: '小雪', rate: 0.005, holdover: 45 },
  mod:   { label: '中雪', rate: 0.008, holdover: 25 },
  heavy: { label: '大雪', rate: 0.014, holdover: 15 },
};

export const RUNWAY_DEFS = {
  A: { id: 'A', name: '09L / 27R（东西向）', segments: 6, frictionAt: 0.82, initMu: 0.26 },
  B: { id: 'B', name: '14 / 32（斜向）',     segments: 6, frictionAt: 0.80, initMu: 0.26 },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const bucketLevel = (buckets, t) => (buckets.find(b => t >= b.from && t < b.to) || {}).level || 'none';
const rateAt = (buckets, t) => WEATHER_LEVELS[bucketLevel(buckets, t)].rate;
const holdoverAt = (buckets, t) => WEATHER_LEVELS[bucketLevel(buckets, t)].holdover;
const overlap = (a, b) => a.start < b.end && b.start < a.end;

export function defaultSnowBuckets() {
  return [
    { from: 0,   to: 60,  level: 'light' },
    { from: 60,  to: 150, level: 'heavy' },
    { from: 150, to: T_END, level: 'mod' },
  ];
}

export function defaultScenario() {
  return {
    snowBuckets: defaultSnowBuckets(),
    closed: {
      A: [1, 2, 3, 4],
      B: [1, 2, 3, 4],
    },
    clearOrder: {
      A: [2, 3, 1, 4],
      B: [2, 3, 1, 4],
    },
    startAt: { A: 5, B: 10 },
    plows: [
      { id: '除冰车-01', runway: 'A', readyAt: 4 },
      { id: '清扫车-02', runway: 'A', readyAt: 4 },
      { id: '清扫车-03', runway: 'B', readyAt: 9 },
      { id: '除冰车-04', runway: 'B', readyAt: 9 },
    ],
    flights: [
      { id: 'CA1831', type: 'dep', runway: 'A', sched: 30,  delay: 0,  seats: 168 },
      { id: 'MU5102', type: 'arr', runway: 'B', sched: 55,  delay: 0,  seats: 152 },
      { id: 'CZ3170', type: 'dep', runway: 'A', sched: 82,  delay: 0,  seats: 180 },
      { id: 'HU7805', type: 'arr', runway: 'A', sched: 92,  delay: 0,  seats: 140 },
      { id: 'CA1589', type: 'dep', runway: 'B', sched: 96,  delay: 0,  seats: 160 },
      { id: 'MU2241', type: 'arr', runway: 'B', sched: 150, delay: 0,  seats: 156 },
      { id: 'CZ9008', type: 'dep', runway: 'A', sched: 205, delay: 0,  seats: 174 },
    ],
  };
}

function normalize(sc) {
  ['A', 'B'].forEach(r => {
    const n = RUNWAY_DEFS[r].segments;
    sc.closed[r] = [...new Set((sc.closed[r] || []).map(Number))].filter(i => i >= 0 && i < n).sort((a, b) => a - b);
    const order = (sc.clearOrder[r] || []).map(Number).filter(i => sc.closed[r].includes(i));
    sc.closed[r].forEach(seg => { if (!order.includes(seg)) order.push(seg); });
    sc.clearOrder[r] = order;
    sc.startAt[r] = clamp(Number(sc.startAt[r]) || 0, 0, T_END - 2);
  });
  sc.plows.forEach(p => { p.readyAt = clamp(Number(p.readyAt) || 0, 0, T_END); });
  sc.flights.forEach(f => {
    f.sched = clamp(Number(f.sched) || 0, 0, T_END - HOLD_DIST);
    f.delay = clamp(Number(f.delay) || 0, 0, T_END - f.sched);
  });
  return sc;
}

// 校验重新推演是否破坏已执行的真实进度（已清扫分段不能从关闭清单中移除）
export function validateAgainstLocks(scenario, locks) {
  const errors = [];
  (locks?.prePlowed || []).forEach(t => {
    if (!scenario.closed[t.runway].includes(t.seg)) {
      errors.push(`跑道 ${t.runway} 第 ${t.seg + 1} 段已经完成清扫，不能重新划回开放区`);
    }
  });
  return { ok: errors.length === 0, errors };
}

let alertSeq = 0;
const newAlert = (kind, sev, msg, loc) => ({ id: `AL${++alertSeq}`, kind, sev, msg, ...loc });

// 地面推演：逐分钟调度清扫/除冰车辆，同时演进各分段摩擦系数
function simulateGround(sc, locks) {
  const friction = { A: {}, B: {} };
  const usable = { A: new Array(T_END + 1), B: new Array(T_END + 1) };
  const plowTasks = [];

  // 已真实完成的清扫（上一轮执行进度锁定）
  const doneMap = { A: new Map(), B: new Map() };
  (locks?.prePlowed || []).forEach(t => doneMap[t.runway].set(t.seg, t.clearedAt));

  const clearAt = { A: new Map(doneMap.A), B: new Map(doneMap.B) }; // 每段最近一次清扫完成时刻
  const initQueues = { A: [...sc.clearOrder.A].filter(seg => !clearAt.A.has(seg)),
                       B: [...sc.clearOrder.B].filter(seg => !clearAt.B.has(seg)) };
  const queued = { A: new Set(initQueues.A), B: new Set(initQueues.B) };
  const runwaysCleared = { A: new Set(doneMap.A.keys()), B: new Set(doneMap.B.keys()) };

  ['A', 'B'].forEach(r => {
    const n = RUNWAY_DEFS[r].segments;
    const closedSet = new Set(sc.closed[r]);
    for (let seg = 0; seg < n; seg++) {
      friction[r][seg] = new Array(T_END + 1);
      friction[r][seg][0] = closedSet.has(seg) ? RUNWAY_DEFS[r].initMu : RUNWAY_DEFS[r].frictionAt;
      // 未关闭的分段在基准时刻前已完成清扫，但降雪期间仍要纳入二次清扫
      if (!closedSet.has(seg)) {
        clearAt[r].set(seg, 0);
        runwaysCleared[r].add(seg);
      }
    }
  });

  // 车辆状态
  const plows = sc.plows.map(p => ({ def: p, busyUntil: p.readyAt, pos: 'staging', runway: p.runway }));

  const assign = (r, seg, t) => {
    const cand = plows
      .filter(p => p.runway === r && p.busyUntil <= t)
      .sort((x, y) => (x.pos === 'staging' ? 0 : 1) - (y.pos === 'staging' ? 0 : 1) || x.busyUntil - y.busyUntil);
    if (!cand.length) return false;
    const plow = cand[0];
    const start = t;
    const end = t + PLOW_SPEED;
    plow.busyUntil = end + PLOW_REPOSITION;
    plow.pos = seg;
    plowTasks.push({ id: `${plow.def.id}-${r}${seg}-${start}`, plowId: plow.def.id, runway: r, seg, start, end });
    return true;
  };

  for (let t = 1; t <= T_END; t++) {
    const rate = rateAt(sc.snowBuckets, t);

    // 1) 完成清扫的分段在本分钟恢复摩擦
    plowTasks.filter(task => task.end === t).forEach(task => {
      clearAt[task.runway].set(task.seg, t);
      runwaysCleared[task.runway].add(task.seg);
      queued[task.runway].delete(task.seg);
    });

    // 2) 摩擦衰减/恢复
    ['A', 'B'].forEach(r => {
      const n = RUNWAY_DEFS[r].segments;
      for (let seg = 0; seg < n; seg++) {
        let mu = friction[r][seg][t - 1] - rate;
        if (clearAt[r].get(seg) === t) mu = RUNWAY_DEFS[r].frictionAt;
        friction[r][seg][t] = clamp(+mu.toFixed(3), 0.05, 0.95);
      }
    });

    // 3) 给空车派活：初扫队列优先，其次二次清扫
    ['A', 'B'].forEach(r => {
      const idle = plows.filter(p => p.runway === r && p.busyUntil <= t);
      idle.forEach(plow => {
        let seg = initQueues[r].shift();
        if (seg === undefined) {
          // 初扫完成后：给摩擦最先逼近阈值的已清扫分段安排二次清扫
          seg = [...runwaysCleared[r]]
            .filter(sx => !queued[r].has(sx))
            .filter(sx => !plowTasks.some(task => task.runway === r && task.seg === sx && task.end > t))
            .filter(sx => friction[r][sx][t] <= RESWEEP_AT && rate > 0)
            .sort((a, b) => friction[r][a][t] - friction[r][b][t])[0];
        }
        if (seg !== undefined && assign(r, seg, t)) queued[r].add(seg);
      });
    });

    // 4) 跑道可用性：关闭分段完成初扫 + 全段摩擦达标；
    //    车辆是否侵入起降区由 findSlot 按“作业车辆 ↔ 起降窗口”逐分钟检测
    ['A', 'B'].forEach(r => {
      const n = RUNWAY_DEFS[r].segments;
      const allInitCleared = sc.closed[r].every(seg => clearAt[r].has(seg));
      const minMu = Math.min(...Array.from({ length: n }, (_, seg) => friction[r][seg][t]));
      usable[r][t] = allInitCleared && minMu >= MIN_FRICTION;
    });
  }

  return { friction, usable, plowTasks };
}

function runwayFree(usable, r, start, end) {
  for (let t = start; t < end; t++) {
    if (t < 0 || t > T_END || !usable[r][t]) return false;
  }
  return true;
}

// 主推演：scenario + locks（已真实执行的进度）
export function runSim(scenarioInput, locks = {}) {
  const sc = normalize(JSON.parse(JSON.stringify(scenarioInput)));
  const lockedPlans = locks.flightPlans || [];
  const lockedAlerts = locks.alerts || [];

  const { friction, usable, plowTasks } = simulateGround(sc, locks);
  const alerts = [...lockedAlerts];
  const flightPlans = [...lockedPlans];

  // 跑道占用：锁定航班先登记
  const occ = { A: [], B: [] };
  lockedPlans.forEach(p => (p.ops || []).forEach(o => occ[o.runway].push({ start: o.start, end: o.end, flightId: p.id })));

  // 在指定跑道上、[earliest,deadline] 内寻找可行起降窗口
  function findSlot(runway, earliest, deadline, selfId) {
    for (let t = earliest; t + HOLD_DIST <= deadline; t++) {
      const iv = { start: t, end: t + HOLD_DIST, flightId: selfId };
      if (!runwayFree(usable, runway, t, t + HOLD_DIST)) continue;
      if (occ[runway].some(o => overlap(iv, o))) continue;
      if (occ[runway === 'A' ? 'B' : 'A'].some(o => overlap(iv, o))) continue; // 交叉点双跑互斥
      if (plowTasks.some(task => task.runway === runway && overlap(task, iv))) continue; // 车辆侵入
      return t;
    }
    return null;
  }

  const flights = sc.flights
    .filter(f => !lockedPlans.some(p => p.id === f.id))
    .sort((a, b) => (a.sched + a.delay) - (b.sched + b.delay));

  for (const f of flights) {
    const ready = f.sched + f.delay;
    const plan = { id: f.id, type: f.type, runway: f.runway, sched: f.sched, delay: f.delay, seats: f.seats,
      ready, deice: null, ops: [], retries: 0, holdoverUntil: null, status: 'pending', notes: [] };

    if (f.type === 'arr') {
      const deadline = ready + ARR_HOLD_LIMIT;
      const t = findSlot(f.runway, ready, deadline, f.id);
      if (t !== null) {
        plan.status = 'arrived';
        plan.ops.push({ runway: f.runway, start: t, end: t + HOLD_DIST });
      } else {
        // 等待上限到达，强制复飞/备降：检查这一时刻跑道上的车辆与另一跑道航班，用于冲突定位
        const forcedStart = Math.min(Math.max(ready, deadline - HOLD_DIST), T_END - HOLD_DIST);
        const iv = { start: forcedStart, end: forcedStart + HOLD_DIST };
        const vehicle = plowTasks.find(task => task.runway === f.runway && overlap(task, iv));
        const cross = occ[f.runway === 'A' ? 'B' : 'A'].find(o => overlap(iv, o));
        if (vehicle) {
          alerts.push(newAlert('intrusion', 'high',
            `${f.id} 等待上限（${ARR_HOLD_LIMIT} 分钟）到达，${vehicle.plowId} 仍在跑道 ${f.runway} 第 ${vehicle.seg + 1} 段作业，存在车辆侵入起降区风险，航空器复飞备降`,
            { tStart: forcedStart, tEnd: forcedStart + HOLD_DIST, runway: f.runway, seg: vehicle.seg,
              flightId: f.id, plowId: vehicle.plowId, refIds: [f.id, vehicle.id] }));
        } else {
          alerts.push(newAlert('divert', 'med',
            `${f.id} 在等待上限内未获得可用窗口（跑道关闭/摩擦不足），备降其他机场`,
            { tStart: ready, tEnd: forcedStart + HOLD_DIST, runway: f.runway, seg: null,
              flightId: f.id, refIds: [f.id] }));
        }
        if (cross) {
          alerts.push(newAlert('cross', 'high',
            `${f.id} 计划窗口与另一跑道航班 ${cross.flightId} 在交叉点时间重叠`,
            { tStart: forcedStart, tEnd: forcedStart + HOLD_DIST, runway: f.runway, seg: 2,
              flightId: f.id, refIds: [f.id, cross.flightId] }));
        }
        plan.status = 'diverted';
      }
    } else {
      // 起飞：除冰 → 必须在防冰有效时间内完成起飞；超时返回除冰坪重做
      const deices = [];
      let deiceStart = ready;
      let attempt = 0;
      let solved = false;
      while (attempt <= DEICE_MAX_RETRY && !solved) {
        const deiceEnd = deiceStart + DEICE_TIME;
        const H = holdoverAt(sc.snowBuckets, deiceEnd);
        const deadline = Math.min(deiceEnd + H, T_END);
        deices.push({ start: deiceStart, end: deiceEnd, holdover: H, no: attempt + 1 });
        if (attempt > 0) {
          plan.retries = attempt;
          alerts.push(newAlert('icefail', attempt >= DEICE_MAX_RETRY ? 'high' : 'med',
            `${f.id} 第 ${attempt} 次防冰超出有效时间（${H} 分钟）仍无起飞窗口，滑行返回除冰坪重新除冰`,
            { tStart: deiceStart, tEnd: deiceEnd, runway: null, seg: null,
              flightId: f.id, refIds: [f.id] }));
        }
        const t = findSlot(f.runway, deiceEnd, deadline, f.id);
        if (t !== null) {
          plan.ops.push({ runway: f.runway, start: t, end: t + HOLD_DIST });
          plan.holdoverUntil = deadline;
          plan.status = attempt > 0 ? 'departed-retry' : 'departed';
          solved = true;
        } else {
          attempt += 1;
          if (attempt > DEICE_MAX_RETRY) break;
          deiceStart = Math.min(deadline, T_END - DEICE_TIME - HOLD_DIST);
        }
      }
      plan.deice = deices[0];
      plan.deices = deices;
      if (!solved) {
        plan.status = 'canceled';
        plan.notes.push('多次除冰后仍无可用起飞窗口，防冰液失效，航班取消');
        alerts.push(newAlert('icefail', 'high',
          `${f.id} 防冰彻底失效，重复除冰 ${DEICE_MAX_RETRY} 次后仍无法起飞，航班取消`,
          { tStart: deiceStart, tEnd: deiceStart + DEICE_TIME, runway: null, seg: null,
            flightId: f.id, refIds: [f.id] }));
      }
    }

    if (plan.ops.length) {
      const op = plan.ops[plan.ops.length - 1];
      occ[op.runway].push({ start: op.start, end: op.end, flightId: plan.id });
      const cross = occ[op.runway === 'A' ? 'B' : 'A'].find(o => o.flightId !== plan.id && overlap(op, o));
      if (cross) {
        alerts.push(newAlert('cross', 'high',
          `${plan.id} 与 ${cross.flightId} 在两条跑道交叉点时间冲突`,
          { tStart: op.start, tEnd: op.end, runway: op.runway, seg: 2,
            flightId: plan.id, refIds: [plan.id, cross.flightId] }));
      }
    }
    flightPlans.push(plan);
  }

  // 去重：锁定的历史告警不应在重推演中再次生成（同航班+类型+时刻+车辆视为同一条）
  const sig = a => `${a.kind}|${a.flightId || ''}|${a.plowId || ''}|${a.tStart ?? ''}|${a.runway || ''}`;
  const seen = new Set(lockedAlerts.map(sig));
  const deduped = lockedAlerts.slice();
  alerts.slice(lockedAlerts.length).forEach(a => {
    const key = sig(a);
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(a);
  });
  alerts.length = 0;
  deduped.forEach(a => alerts.push(a));

  // 时间排序的 Gantt 用任务
  plowTasks.forEach(t => { t.label = `${t.plowId} · ${t.runway}${t.seg + 1}`; });

  return {
    tEnd: T_END,
    minFriction: MIN_FRICTION,
    snowBuckets: sc.snowBuckets,
    closed: sc.closed,
    clearOrder: sc.clearOrder,
    plowTasks,
    flightPlans,
    friction,
    usable,
    alerts,
    summary: buildSummary(flightPlans, alerts, usable),
  };
}

function buildSummary(plans, alerts, usable) {
  const departed = plans.filter(p => p.status.startsWith('departed')).length;
  const arrived = plans.filter(p => p.status === 'arrived').length;
  const diverted = plans.filter(p => p.status === 'diverted').length;
  const canceled = plans.filter(p => p.status === 'canceled').length;
  const retries = plans.reduce((n, p) => n + (p.retries || 0), 0);
  const delayed = plans.filter(p => p.ops.length && p.ops[0].start > p.ready + 5).length;
  const usableMins = {
    A: usable.A.filter(Boolean).length,
    B: usable.B.filter(Boolean).length,
  };
  return {
    total: plans.length, departed, arrived, diverted, canceled, delayed, retries, usableMins,
    highAlerts: alerts.filter(a => a.sev === 'high').length,
    medAlerts: alerts.filter(a => a.sev === 'med').length,
  };
}
