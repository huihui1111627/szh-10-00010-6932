// 处置方案的“真实执行”状态机 + 重推演锁定逻辑
import { runSim, T_END } from './engine.js';

export function newPlanDoc(name) {
  return {
    id: 'plan_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    name: name || '处置方案',
    scenario: null, // 由首次推演写入
    now: 0,         // 真实执行时钟（分钟）
    playing: false,
    speed: 1,       // 倍速（1x/2x/4x）
    sim: null,      // 最近一次推演结果（用于未来时刻的渲染）
    history: [],    // 已发生的真实事件快照
    locks: { prePlowed: [], flightPlans: [], alerts: [] },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// 依据当前执行时钟，从推演结果中提取“真实发生过”的任务与航班，生成 locks 后重推演
export function advanceAndRecompute(doc) {
  if (!doc.scenario) return doc;
  const t = doc.now;

  // 从最近一次推演中固化已完成/已开始的清扫任务
  const prePlowed = [];
  (doc.sim?.plowTasks || []).forEach(task => {
    if (task.end <= t) {
      // 同一分段只保留最早完成时刻
      const exist = prePlowed.find(x => x.runway === task.runway && x.seg === task.seg);
      if (!exist || task.end < exist.clearedAt) {
        if (exist) exist.clearedAt = task.end;
        else prePlowed.push({ runway: task.runway, seg: task.seg, clearedAt: task.end, plowId: task.plowId });
      }
    }
  });

  // 已结束的航班（落地/起飞/备降/取消）整单锁定；已开始除冰但尚未起飞的航班不锁定（允许重排）
  const flightPlans = [];
  const alerts = [];
  (doc.sim?.flightPlans || []).forEach(p => {
    const lastOp = p.ops[p.ops.length - 1];
    const doneStatus = ['arrived', 'departed', 'departed-retry', 'diverted', 'canceled'];
    const finishedOp = lastOp && lastOp.end <= t;
    const finishedTerminal = doneStatus.includes(p.status) && (!lastOp || finishedOp);
    if (finishedOp && (p.status === 'arrived' || p.status.startsWith('departed'))) {
      flightPlans.push(p);
    } else if ((p.status === 'diverted' || p.status === 'canceled') && p.ready + 30 <= t) {
      flightPlans.push(p);
    }
  });
  // 已发生时刻的告警锁定
  (doc.sim?.alerts || []).forEach(a => {
    if ((a.tStart ?? T_END) <= t) alerts.push(a);
  });

  doc.locks = { prePlowed, flightPlans, alerts };
  doc.sim = runSim(doc.scenario, doc.locks);
  doc.updatedAt = Date.now();
  return doc;
}

// 当前时钟下各任务的真实状态
export function taskStateAt(sim, t) {
  const plowStates = (sim.plowTasks || []).map(task => {
    let state = 'future';
    if (task.end <= t) state = 'done';
    else if (task.start <= t) state = 'running';
    return { ...task, state, progress: state === 'done' ? 1 : state === 'running' ? (t - task.start) / (task.end - task.start) : 0 };
  });
  const flightStates = (sim.flightPlans || []).map(p => {
    const op = p.ops[p.ops.length - 1];
    let state = 'future';
    if (p.status === 'diverted' || p.status === 'canceled') state = t >= p.ready ? (p.ready + 30 <= t ? 'done' : 'running') : 'future';
    else if (op && op.end <= t) state = 'done';
    else if (op && op.start <= t) state = 'running';
    else if (p.deice && p.deice.start <= t) state = 'running';
    return { ...p, state };
  });
  return { plowStates, flightStates };
}

// 方案上做了人工调整（关闭区/清扫顺序/延后航班）后重推演
export function editAndRecompute(doc, mutator) {
  mutator(doc.scenario);
  return advanceAndRecompute(doc);
}
