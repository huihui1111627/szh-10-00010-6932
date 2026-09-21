// 左侧调整面板
import { WEATHER_LEVELS, RUNWAY_DEFS, T_END } from './engine.js';

export function renderSnowEditor(root, scenario, locks, onChange) {
  root.innerHTML = '';
  scenario.snowBuckets.forEach((b, i) => {
    const row = document.createElement('div');
    row.className = 'snow-row';
    const lvl = document.createElement('select');
    Object.entries(WEATHER_LEVELS).forEach(([key, def]) => {
      const opt = document.createElement('option');
      opt.value = key; opt.textContent = def.label;
      if (b.level === key) opt.selected = true;
      lvl.appendChild(opt);
    });
    lvl.addEventListener('change', () => { b.level = lvl.value; onChange(); });

    const from = document.createElement('input');
    from.type = 'number'; from.min = 0; from.max = T_END; from.value = b.from;
    from.disabled = true; // 分界点固定，保证三段连续
    const to = document.createElement('input');
    to.type = 'number'; to.min = 0; to.max = T_END; to.value = b.to;
    to.addEventListener('change', () => {
      let v = Math.max(10, Math.min(T_END, Number(to.value) || b.to));
      b.to = v;
      // 始终维持三段连续：[0, to0), [to0, to1), [to1, T_END)
      if (i < scenario.snowBuckets.length - 1) {
        scenario.snowBuckets[i + 1].from = v;
      }
      if (i > 0) {
        scenario.snowBuckets[i].from = scenario.snowBuckets[i - 1].to;
      }
      onChange();
    });

    row.append(lvl, from, to);
    root.appendChild(row);
  });
  const note = document.createElement('div');
  note.className = 'hint';
  const heavy = scenario.snowBuckets.find(b => b.level === 'heavy');
  note.innerHTML = `大雪下降雪率 ${WEATHER_LEVELS.heavy.rate}/分钟，防冰有效时间仅 <b style="color:#f5b942">${WEATHER_LEVELS.heavy.holdover} 分钟</b>。`;
  root.appendChild(note);
}

export function renderRunwayEditor(root, scenario, locks, onChange) {
  root.innerHTML = '';
  ['A', 'B'].forEach(id => {
    const n = RUNWAY_DEFS[id].segments;
    const block = document.createElement('div');
    block.className = 'rw-block';
    const doneSegs = new Set((locks.prePlowed || []).filter(t => t.runway === id).map(t => t.seg));

    const title = document.createElement('div');
    title.className = 'rw-title';
    title.innerHTML = `<b>跑道 ${id}</b><span class="fmeta">${RUNWAY_DEFS[id].name}</span>`;
    block.appendChild(title);

    const hint = document.createElement('div');
    hint.className = 'fmeta';
    hint.textContent = '点选分段切换关闭/开放（已完成初扫的分段不可重新关闭）';
    block.appendChild(hint);

    const chips = document.createElement('div');
    chips.className = 'seg-chips';
    for (let seg = 0; seg < n; seg++) {
      const chip = document.createElement('button');
      chip.className = 'seg-chip' + (scenario.closed[id].includes(seg) ? ' closed' : '') + (doneSegs.has(seg) ? ' locked' : '');
      chip.textContent = seg + 1;
      chip.title = doneSegs.has(seg) ? '已完成真实清扫，不能改动' : '';
      chip.addEventListener('click', () => {
        if (doneSegs.has(seg)) return;
        const set = new Set(scenario.closed[id]);
        if (set.has(seg)) {
          set.delete(seg);
          scenario.clearOrder[id] = scenario.clearOrder[id].filter(x => x !== seg);
        } else {
          set.add(seg);
          if (!scenario.clearOrder[id].includes(seg)) scenario.clearOrder[id].push(seg);
        }
        scenario.closed[id] = [...set].sort((a, b) => a - b);
        onChange();
      });
      chips.appendChild(chip);
    }
    block.appendChild(chips);

    const orderLabel = document.createElement('div');
    orderLabel.className = 'fmeta';
    orderLabel.textContent = '清扫顺序（点击前移一位）：';
    block.appendChild(orderLabel);
    const order = document.createElement('div');
    order.className = 'order-list';
    const renderOrder = () => {
      order.innerHTML = '';
      scenario.clearOrder[id].forEach((seg, idx) => {
        const item = document.createElement('button');
        item.className = 'order-item';
        item.textContent = `第${seg + 1}段`;
        item.title = '点击前移一位';
        item.addEventListener('click', () => {
          if (idx === 0) return;
          const arr = scenario.clearOrder[id];
          [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
          onChange();
        });
        order.appendChild(item);
      });
    };
    renderOrder();
    block.appendChild(order);

    const meta = document.createElement('div');
    meta.className = 'rw-meta';
    meta.innerHTML = `<span>开始清扫 T+</span>`;
    const startInput = document.createElement('input');
    startInput.type = 'number'; startInput.min = 0; startInput.max = T_END;
    startInput.value = scenario.startAt[id];
    startInput.addEventListener('change', () => {
      scenario.startAt[id] = Math.max(0, Math.min(T_END - 2, Number(startInput.value) || 0));
      onChange();
    });
    meta.appendChild(startInput);
    meta.innerHTML += `<span>分钟</span>`;
    block.appendChild(meta);

    root.appendChild(block);
  });
}

export function renderFlightEditor(root, scenario, locks, now, onChange) {
  root.innerHTML = '';
  const lockedIds = new Set((locks.flightPlans || []).map(p => p.id));
  scenario.flights.forEach(f => {
    const row = document.createElement('div');
    row.className = 'flight-row';
    const locked = lockedIds.has(f.id);
    row.innerHTML = `<div class="fid">${f.id}</div>
      <div class="fmeta">${f.type === 'dep' ? '离港↑' : '进港↓'} · 跑道 ${f.runway} · 计划 T+${f.sched}′${locked ? ' · <span style="color:#34d399">已执行锁定</span>' : ''}</div>`;
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '3px';
    wrap.innerHTML += '<span class="fmeta">延后</span>';
    const input = document.createElement('input');
    input.className = 'delay-input';
    input.type = 'number'; input.min = 0; input.max = T_END - f.sched;
    input.value = f.delay;
    input.disabled = locked;
    input.addEventListener('change', () => {
      f.delay = Math.max(0, Math.min(T_END - f.sched - 6, Number(input.value) || 0));
      onChange();
    });
    wrap.appendChild(input);
    wrap.innerHTML += '<span class="fmeta">分</span>';
    row.appendChild(wrap);
    root.appendChild(row);
  });
}
