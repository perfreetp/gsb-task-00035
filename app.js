const PROCS = {
  cut:  { name: "切割", color: "#4f8ef7" },
  mach: { name: "加工", color: "#9b6df3" },
  qc:   { name: "质检", color: "#f0a13a" },
  pack: { name: "包装", color: "#3fbf7f" },
};
const PROC_IDS = Object.keys(PROCS);

const MACHINE_DEFS = [
  { id: "C1", name: "切割机 A", caps: { cut: 1.0 } },
  { id: "C2", name: "切割机 B", caps: { cut: 1.4 } },
  { id: "M1", name: "加工中心 1", caps: { mach: 1.0 } },
  { id: "M2", name: "加工中心 2", caps: { mach: 1.3 } },
  { id: "Q1", name: "质检台 1", caps: { qc: 1.0 } },
  { id: "Q2", name: "质检台 2", caps: { qc: 1.2 } },
  { id: "P1", name: "包装线 1", caps: { pack: 1.0 } },
  { id: "P2", name: "包装线 2", caps: { pack: 1.25 } },
];

const LANE_H = 58;
const LABEL_W = 116;
const PX_PER_MIN = 0.6;

let machines, orders, machineQueues, now, horizon, selectedOpId;
let running, tickTimer, speed, lastFinish, urgentSeq, lastChangeSummary;

function buildInitialData() {
  machines = MACHINE_DEFS.map((m) => ({ ...m, blocked: [] }));
  machineQueues = {};
  machines.forEach((m) => (machineQueues[m.id] = []));

  const orderDefs = [
    { name: "订单 A101", prio: 2, qty: 120, release: 0,   due: 2400, bases: [110, 170, 55, 50] },
    { name: "订单 A102", prio: 3, qty: 90,  release: 0,   due: 2760, bases: [85, 140, 45, 40] },
    { name: "订单 A103", prio: 1, qty: 150, release: 0,   due: 2100, bases: [130, 200, 65, 60] },
    { name: "订单 A104", prio: 3, qty: 70,  release: 0,   due: 2880, bases: [70, 110, 40, 35] },
    { name: "订单 A105", prio: 4, qty: 110, release: 120, due: 3120, bases: [100, 155, 50, 45] },
    { name: "订单 A106", prio: 2, qty: 95,  release: 240, due: 2520, bases: [90, 130, 45, 40] },
    { name: "订单 A107", prio: 5, qty: 60,  release: 360, due: 3360, bases: [60, 95, 35, 30] },
    { name: "订单 A108", prio: 4, qty: 130, release: 0,   due: 3000, bases: [115, 175, 60, 55] },
  ];

  orders = orderDefs.map((d, i) => {
    const id = "O" + (101 + i);
    const ops = PROC_IDS.map((proc, j) => ({
      id: `${id}-${proc}`,
      orderId: id,
      proc,
      base: d.bases[j],
      machine: null,
      status: "pending",
      start: null,
      end: null,
      fixed: false,
      invalid: false,
      rework: false,
    }));
    return {
      id, name: d.name, prio: d.prio, qty: d.qty,
      release: d.release, due: d.due,
      urgent: false, ops, deltaMin: null,
    };
  });

  const pickIdx = {};
  orders.forEach((o) => {
    o.ops.forEach((op) => {
      const list = machines.filter((m) => m.caps[op.proc] != null).map((m) => m.id);
      const k = pickIdx[op.proc] || 0;
      op.machine = list[k % list.length];
      pickIdx[op.proc] = k + 1;
      machineQueues[op.machine].push(op.id);
    });
  });

  now = 0;
  horizon = 0;
  urgentSeq = 0;
  lastFinish = {};
  selectedOpId = null;
  running = false;
  speed = 4;
  lastChangeSummary = { earlier: [], later: [] };
}

function opById(id) {
  for (const o of orders) {
    const f = o.ops.find((x) => x.id === id);
    if (f) return f;
  }
  return null;
}

function orderById(id) {
  return orders.find((o) => o.id === id);
}

function opDuration(op, machineId) {
  const m = machines.find((x) => x.id === machineId);
  const spd = m && m.caps[op.proc] != null ? m.caps[op.proc] : 1;
  return Math.max(10, Math.round(op.base / spd));
}

function skipBlocked(machineId, start, dur) {
  const m = machines.find((x) => x.id === machineId);
  let guard = 0;
  while (guard++ < 50) {
    const hit = m.blocked.find((b) => b.start < start + dur && b.end > start);
    if (!hit) break;
    start = Math.max(start, hit.end);
  }
  return start;
}

function computeSchedule() {
  const machineAvail = {};
  machines.forEach((m) => (machineAvail[m.id] = now));

  orders.forEach((o) => {
    o.ops.forEach((op) => {
      op.invalid = false;
      if (op.status === "done" || op.status === "doing") {
        op.fixed = true;
        machineAvail[op.machine] = Math.max(machineAvail[op.machine], op.end);
      } else {
        op.start = null;
        op.end = null;
        op.fixed = false;
        const m = machines.find((x) => x.id === op.machine);
        if (!m || m.caps[op.proc] == null) op.invalid = true;
      }
    });
  });

  const queues = {};
  machines.forEach((m) => {
    queues[m.id] = machineQueues[m.id]
      .map((id) => opById(id))
      .filter((op) => op && op.status === "pending" && !op.invalid);
  });

  const endAt = {};
  orders.forEach((o) => {
    o.ops.forEach((op) => {
      if (op.fixed) endAt[op.id] = op.end;
    });
  });

  let safety = 0;
  while (safety++ < 2000) {
    const candidates = [];
    machines.forEach((m) => {
      const head = queues[m.id][0];
      if (!head) return;
      const order = orderById(head.orderId);
      const idx = order.ops.indexOf(head);
      const pred = idx > 0 ? order.ops[idx - 1] : null;
      if (pred && endAt[pred.id] == null) return;
      const dur = opDuration(head, m.id);
      let start = Math.max(machineAvail[m.id], pred ? endAt[pred.id] : now, order.release, now);
      start = skipBlocked(m.id, start, dur);
      candidates.push({ op: head, machine: m, start, dur, order });
    });
    if (!candidates.length) break;
    candidates.sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      if (a.order.prio !== b.order.prio) return a.order.prio - b.order.prio;
      return a.order.id.localeCompare(b.order.id);
    });
    const c = candidates[0];
    c.op.start = c.start;
    c.op.end = c.start + c.dur;
    endAt[c.op.id] = c.op.end;
    machineAvail[c.machine.id] = c.op.end;
    queues[c.machine.id].shift();
  }

  let maxEnd = now + 600;
  lastChangeSummary = { earlier: [], later: [] };
  orders.forEach((o) => {
    const ends = o.ops.map((op) => op.end).filter((e) => e != null);
    const finish = ends.length ? Math.max(...ends) : null;
    if (finish != null) maxEnd = Math.max(maxEnd, finish);
    const prev = lastFinish[o.id];
    o.deltaMin = 0;
    if (finish != null && prev != null && prev !== finish) {
      o.deltaMin = finish - prev;
      (o.deltaMin < 0 ? lastChangeSummary.earlier : lastChangeSummary.later).push({ name: o.name, delta: o.deltaMin });
    }
    if (finish != null) lastFinish[o.id] = finish;
  });
  machines.forEach((m) => m.blocked.forEach((b) => (maxEnd = Math.max(maxEnd, b.end))));
  horizon = Math.ceil(maxEnd / 240) * 240 + 240;
}

function orderProgress(o) {
  if (o.ops.every((op) => op.status === "done")) return "done";
  if (o.ops.some((op) => op.status === "doing")) return "doing";
  if (o.ops.some((op) => op.status === "done")) return "started";
  return "wait";
}

function orderFinish(o) {
  const ends = o.ops.map((op) => op.end).filter((e) => e != null);
  return ends.length ? Math.max(...ends) : null;
}

function fmt(t) {
  if (t == null) return "--:--";
  const d = Math.floor(t / 1440) + 1;
  const h = Math.floor((t % 1440) / 60);
  const mm = t % 60;
  return `D${d} ${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function fmtDelta(min) {
  if (min == null || min === 0) return "无变化";
  const abs = Math.abs(min);
  const word = min < 0 ? "提前" : "推迟";
  if (abs >= 60) return `${word} ${Math.floor(abs / 60)}h${abs % 60 ? (abs % 60) + "m" : ""}`;
  return `${word} ${abs}m`;
}

function log(kind, html) {
  const el = document.createElement("div");
  el.className = "log-entry " + kind;
  el.innerHTML = `<span class="lt">${fmt(now)}</span>${html}`;
  const box = document.getElementById("log");
  box.prepend(el);
}

function render() {
  renderClock();
  renderOrders();
  renderAlerts();
  renderGantt();
  renderOpPanel();
}

function renderClock() {
  document.getElementById("clock").textContent = fmt(now);
  const st = document.getElementById("clock-state");
  st.textContent = running ? "运行中" : "已暂停";
  st.className = running ? "running" : "";
  document.getElementById("btn-toggle").textContent = running ? "⏸ 暂停" : "▶ 开始";
}

function renderOrders() {
  const box = document.getElementById("order-list");
  box.innerHTML = "";
  const sorted = [...orders].sort((a, b) => a.prio - b.prio || a.id.localeCompare(b.id));
  sorted.forEach((o) => {
    const prog = orderProgress(o);
    const finish = orderFinish(o);
    const late = finish != null && finish > o.due;
    const risk = !late && finish != null && o.due - finish < 120;
    const row = document.createElement("div");
    row.className = "order-row"
      + (late ? " late" : "")
      + (risk ? " risk" : "")
      + (prog === "done" ? " done-order" : "")
      + (o.ops.some((op) => op.id === selectedOpId) ? " selected" : "");
    const statusText = {
      done: '<span class="or-status done">已完成</span>',
      doing: '<span class="or-status doing">生产中</span>',
      started: '<span class="or-status doing">部分开工</span>',
      wait: '<span class="or-status wait">待生产</span>',
    }[prog];
    const lateTag = late ? '<span class="or-status late">⚠ 延期</span>' : "";
    const deltaCls = o.deltaMin == null || o.deltaMin === 0 ? "zero" : o.deltaMin < 0 ? "earlier" : "later";
    row.innerHTML = `
      <div class="or-top">
        <span class="or-name">${o.name}</span>
        ${o.urgent ? '<span class="or-urgent">急单</span>' : ""}
        <span class="or-prio p${o.prio}">P${o.prio}</span>
        <button class="or-up" title="该订单所有待生产工序在各自机台队列置顶">⤒ 置顶</button>
      </div>
      <div class="or-meta">
        ${statusText}${lateTag}
        <span>数量 ${o.qty}</span>
        <span>物料 ${fmt(o.release)}</span>
      </div>
      <div class="or-meta">
        <span>交期 ${fmt(o.due)}</span>
        <span>预计完工 ${fmt(finish)}</span>
        <span class="delta ${deltaCls}">${fmtDelta(o.deltaMin)}</span>
      </div>`;
    row.querySelector(".or-up").addEventListener("click", (e) => {
      e.stopPropagation();
      prioritizeOrder(o);
    });
    row.addEventListener("click", () => {
      const target = o.ops.find((op) => op.status !== "done") || o.ops[o.ops.length - 1];
      selectOp(target.id);
    });
    box.appendChild(row);
  });
}

function renderAlerts() {
  const box = document.getElementById("alerts");
  box.innerHTML = "";
  const items = [];

  orders.forEach((o) => {
    o.ops.forEach((op) => {
      if (op.invalid) {
        items.push({
          cls: "danger",
          html: `⛔ <b>${o.name}</b> 的「${PROCS[op.proc].name}」被分配到 <b>${machineName(op.machine)}</b>，该机台不具备此工序能力，订单无法排产。`,
        });
      }
    });
  });

  machines.forEach((m) => {
    m.blocked.forEach((b) => {
      if (b.end > now) {
        items.push({
          cls: "warn",
          html: `🔧 <b>${m.name}</b> 故障停机中（${fmt(Math.max(b.start, now))} ~ ${fmt(b.end)}），其队列任务自动顺延。`,
        });
      }
    });
  });

  orders.forEach((o) => {
    if (o.release > now && o.ops[0].status === "pending") {
      items.push({
        cls: "info",
        html: `📦 <b>${o.name}</b> 物料 ${fmt(o.release)} 到货，首道工序暂不可排。`,
      });
    }
  });

  let lateN = 0;
  orders.forEach((o) => {
    const finish = orderFinish(o);
    if (finish != null && finish > o.due && orderProgress(o) !== "done") {
      lateN++;
      items.push({
        cls: "danger",
        html: `⚠ <b>${o.name}</b> 预计 ${fmt(finish)} 完工，超过交期 ${fmt(o.due)}（超 ${fmtDelta(finish - o.due).replace("推迟 ", "")}）。`,
      });
    }
  });

  if (lastChangeSummary.earlier.length || lastChangeSummary.later.length) {
    const e = lastChangeSummary.earlier.map((x) => `${x.name} ${fmtDelta(x.delta)}`).join("、");
    const l = lastChangeSummary.later.map((x) => `${x.name} ${fmtDelta(x.delta)}`).join("、");
    items.push({
      cls: "ok",
      html: `🔁 最近一次调整：${e ? "提前 → " + e : ""}${e && l ? "<br>" : ""}${l ? "推迟 → " + l : ""}`,
    });
  }

  if (!items.length) {
    box.innerHTML = '<p class="muted">当前无冲突、无延期风险。</p>';
    return;
  }
  items.forEach((it) => {
    const d = document.createElement("div");
    d.className = "alert-item " + it.cls;
    d.innerHTML = it.html;
    box.appendChild(d);
  });
}

function machineName(id) {
  const m = machines.find((x) => x.id === id);
  return m ? m.name : id;
}

function renderGantt() {
  const header = document.getElementById("gantt-header");
  const body = document.getElementById("gantt-body");
  const width = LABEL_W + horizon * PX_PER_MIN;
  header.style.width = width + "px";
  body.style.width = width + "px";
  header.innerHTML = "";
  body.innerHTML = "";

  for (let t = 0; t <= horizon; t += 120) {
    const tick = document.createElement("div");
    tick.className = "axis-tick" + (t % 1440 === 0 ? " day" : "");
    tick.style.left = LABEL_W + t * PX_PER_MIN + "px";
    tick.textContent = t % 1440 === 0 ? `D${t / 1440 + 1}` : fmt(t).slice(3);
    header.appendChild(tick);
  }

  const laneTop = {};
  machines.forEach((m, i) => {
    const lane = document.createElement("div");
    lane.className = "lane";
    lane.dataset.machine = m.id;
    lane.style.width = width + "px";
    laneTop[m.id] = i * LANE_H;

    const down = m.blocked.some((b) => b.start <= now && b.end > now);
    const label = document.createElement("div");
    label.className = "lane-label" + (down ? " down" : "");
    const capNames = Object.keys(m.caps).map((p) => PROCS[p].name).join("/");
    label.innerHTML = `<span>${m.name}${down ? '<span class="blocked-badge">故障</span>' : ""}</span><span class="cap">${capNames} ×${m.caps[Object.keys(m.caps)[0]]}</span>`;
    lane.appendChild(label);

    m.blocked.forEach((b) => {
      if (b.end <= now) return;
      const zone = document.createElement("div");
      zone.style.cssText = `position:absolute;left:${LABEL_W + Math.max(b.start, now) * PX_PER_MIN}px;width:${(b.end - Math.max(b.start, now)) * PX_PER_MIN}px;top:0;bottom:0;background:rgba(216,68,63,.13);border-left:2px solid rgba(216,68,63,.5);z-index:1;pointer-events:none;`;
      lane.appendChild(zone);
    });

    lane.addEventListener("dragover", (e) => {
      if (dragOpId) {
        e.preventDefault();
        lane.classList.add("dragover");
      }
    });
    lane.addEventListener("dragleave", () => lane.classList.remove("dragover"));
    lane.addEventListener("drop", (e) => {
      e.preventDefault();
      lane.classList.remove("dragover");
      handleDrop(m.id, e);
    });

    body.appendChild(lane);
  });

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", width);
  svg.setAttribute("height", machines.length * LANE_H);
  svg.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:3;";
  orders.forEach((o) => {
    for (let i = 1; i < o.ops.length; i++) {
      const a = o.ops[i - 1];
      const b = o.ops[i];
      if (a.end == null || b.start == null) continue;
      const x1 = LABEL_W + a.end * PX_PER_MIN;
      const y1 = laneTop[a.machine] + LANE_H / 2;
      const x2 = LABEL_W + b.start * PX_PER_MIN;
      const y2 = laneTop[b.machine] + LANE_H / 2;
      const late = orderFinish(o) != null && orderFinish(o) > o.due;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const midX = (x1 + x2) / 2;
      line.setAttribute("d", `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`);
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", late ? "rgba(226,72,72,.55)" : "rgba(90,110,150,.4)");
      line.setAttribute("stroke-width", "1.4");
      line.setAttribute("stroke-dasharray", "4 3");
      svg.appendChild(line);
      const arrow = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      arrow.setAttribute("cx", x2);
      arrow.setAttribute("cy", y2);
      arrow.setAttribute("r", "2.6");
      arrow.setAttribute("fill", late ? "rgba(226,72,72,.8)" : "rgba(90,110,150,.7)");
      svg.appendChild(arrow);
    }
  });
  body.appendChild(svg);

  orders.forEach((o) => {
    const late = orderFinish(o) != null && orderFinish(o) > o.due;
    o.ops.forEach((op) => {
      if (op.start == null) return;
      const el = document.createElement("div");
      el.className = "op " + op.status
        + (op.id === selectedOpId ? " selected" : "")
        + (late ? " order-late" : "")
        + (op.invalid ? " invalid" : "");
      el.style.left = LABEL_W + op.start * PX_PER_MIN + "px";
      el.style.top = laneTop[op.machine] + 9 + "px";
      el.style.width = Math.max(14, (op.end - op.start) * PX_PER_MIN - 2) + "px";
      el.style.background = PROCS[op.proc].color;
      el.dataset.opid = op.id;
      el.innerHTML = `<div class="op-title">${o.name.replace("订单 ", "")}${op.rework ? "↺" : ""} ${PROCS[op.proc].name}</div><div class="op-time">${fmt(op.start)}–${fmt(op.end)}</div>`;
      el.title = `${o.name} / ${PROCS[op.proc].name}\n机台：${machineName(op.machine)}\n${fmt(op.start)} ~ ${fmt(op.end)}`;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        selectOp(op.id);
      });
      if (op.status === "pending") {
        el.draggable = true;
        el.addEventListener("dragstart", (e) => {
          dragOpId = op.id;
          e.dataTransfer.effectAllowed = "move";
          setTimeout(() => el.classList.add("dragging"), 0);
        });
        el.addEventListener("dragend", () => {
          dragOpId = null;
          el.classList.remove("dragging");
        });
      }
      body.appendChild(el);
    });
  });

  const nowLine = document.createElement("div");
  nowLine.id = "now-line";
  nowLine.style.left = LABEL_W + now * PX_PER_MIN + "px";
  body.appendChild(nowLine);
  const flag = document.createElement("div");
  flag.id = "now-flag";
  flag.style.left = LABEL_W + now * PX_PER_MIN + "px";
  flag.textContent = "现在 " + fmt(now);
  header.appendChild(flag);
}

let dragOpId = null;

function handleDrop(machineId, e) {
  if (!dragOpId) return;
  const op = opById(dragOpId);
  if (!op || op.status !== "pending") return;
  const fromMachine = op.machine;
  const oldQueue = machineQueues[fromMachine];
  const idx = oldQueue.indexOf(dragOpId);
  if (idx >= 0) oldQueue.splice(idx, 1);

  const lane = e.currentTarget;
  const rect = lane.getBoundingClientRect();
  const dropMin = (e.clientX - rect.left - LABEL_W) / PX_PER_MIN;

  op.machine = machineId;
  const queue = machineQueues[machineId];
  let insertAt = queue.length;
  for (let i = 0; i < queue.length; i++) {
    const other = opById(queue[i]);
    if (other && other.start != null && other.start > dropMin) {
      insertAt = i;
      break;
    }
  }
  queue.splice(insertAt, 0, dragOpId);

  const m = machines.find((x) => x.id === machineId);
  const order = orderById(op.orderId);
  if (m.caps[op.proc] == null) {
    log("system", `⚠️ 将 <b>${order.name}</b> 的「${PROCS[op.proc].name}」拖到 <b>${m.name}</b>：该机台无此工序能力，已标记冲突。`);
  } else {
    log("system", `手动调整：<b>${order.name}</b> 的「${PROCS[op.proc].name}」移至 <b>${m.name}</b> 队列第 ${insertAt + 1} 位。`);
  }
  computeSchedule();
  render();
}

function selectOp(id) {
  selectedOpId = id;
  render();
  const el = document.querySelector(`.op[data-opid="${id}"]`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
}

function renderOpPanel() {
  const panel = document.getElementById("op-panel");
  const op = selectedOpId ? opById(selectedOpId) : null;
  if (!op) {
    panel.innerHTML = '<p class="muted">点击甘特图中的工序块进行设备调整或顺序调整（同机台内可拖拽排序）。</p>';
    return;
  }
  const order = orderById(op.orderId);
  const idx = order.ops.indexOf(op);
  const pred = idx > 0 ? order.ops[idx - 1] : null;
  const succ = idx < order.ops.length - 1 ? order.ops[idx + 1] : null;
  const queue = machineQueues[op.machine];
  const pos = queue.indexOf(op.id);

  const machineOpts = machines
    .map((m) => {
      const capable = m.caps[op.proc] != null;
      return `<option value="${m.id}" ${m.id === op.machine ? "selected" : ""} ${capable ? "" : 'style="color:#c4342e"'}>${m.name}${capable ? "" : "（无此工序能力）"}</option>`;
    })
    .join("");

  panel.innerHTML = `
    <div class="op-info-row"><span>订单</span><b>${order.name}${order.urgent ? "（急单）" : ""}</b></div>
    <div class="op-info-row"><span>工序</span><b>${PROCS[op.proc].name}${op.rework ? "（返工）" : ""}</b></div>
    <div class="op-info-row"><span>状态</span><b>${{ pending: "待生产", doing: "生产中", done: "已完成" }[op.status]}</b></div>
    <div class="op-info-row"><span>计划</span><b>${fmt(op.start)} ~ ${fmt(op.end)}</b></div>
    <div class="op-info-row"><span>前置依赖</span><b>${pred ? PROCS[pred.proc].name + "（" + fmt(pred.end) + " 完成）" : "物料到货 " + fmt(order.release)}</b></div>
    <div class="op-info-row"><span>后续工序</span><b>${succ ? PROCS[succ.proc].name : "无（末道工序）"}</b></div>
    <label>分配机台（队列位置 ${pos >= 0 ? pos + 1 : "-"} / ${queue.length}）</label>
    <select id="op-machine" ${op.status !== "pending" ? "disabled" : ""}>${machineOpts}</select>
    <div class="mini-btns">
      <button id="op-first" ${op.status !== "pending" || pos <= 0 ? "disabled" : ""}>⤒ 队首</button>
      <button id="op-up" ${op.status !== "pending" || pos <= 0 ? "disabled" : ""}>↑ 前移</button>
      <button id="op-down" ${op.status !== "pending" || pos < 0 || pos >= queue.length - 1 ? "disabled" : ""}>↓ 后移</button>
      <button id="op-last" ${op.status !== "pending" || pos < 0 || pos >= queue.length - 1 ? "disabled" : ""}>⤓ 队尾</button>
    </div>
    ${op.status !== "pending" ? '<p class="muted" style="margin-top:8px">已开工/已完成的工序不可再调整。</p>' : ""}`;

  const sel = document.getElementById("op-machine");
  if (sel) {
    sel.addEventListener("change", () => {
      const target = sel.value;
      const oldQ = machineQueues[op.machine];
      const i = oldQ.indexOf(op.id);
      if (i >= 0) oldQ.splice(i, 1);
      op.machine = target;
      machineQueues[target].push(op.id);
      const m = machines.find((x) => x.id === target);
      if (m.caps[op.proc] == null) {
        log("system", `⚠️ <b>${order.name}</b> 的「${PROCS[op.proc].name}」改派到 <b>${m.name}</b>：无工序能力，产生冲突。`);
      } else {
        log("system", `手动调整：<b>${order.name}</b> 的「${PROCS[op.proc].name}」改派到 <b>${m.name}</b>。`);
      }
      computeSchedule();
      render();
    });
  }
  const move = (to) => {
    const q = machineQueues[op.machine];
    const i = q.indexOf(op.id);
    if (i < 0) return;
    q.splice(i, 1);
    const ni = to === "first" ? 0 : to === "last" ? q.length : Math.max(0, Math.min(q.length, i + to));
    q.splice(ni, 0, op.id);
    computeSchedule();
    render();
  };
  const bind = (id, fn) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener("click", fn);
  };
  bind("op-first", () => move("first"));
  bind("op-last", () => move("last"));
  bind("op-up", () => move(-1));
  bind("op-down", () => move(1));
}

function prioritizeOrder(order) {
  let moved = 0;
  order.ops.forEach((op) => {
    if (op.status !== "pending") return;
    const q = machineQueues[op.machine];
    const i = q.indexOf(op.id);
    if (i > 0) {
      q.splice(i, 1);
      q.unshift(op.id);
      moved++;
    }
  });
  log("system", `手动调整：<b>${order.name}</b> 的 ${moved} 道待生产工序已在各机台队列置顶。`);
  computeSchedule();
  render();
}

function applyAndReport(kind, logHtml) {
  computeSchedule();
  const { earlier, later } = lastChangeSummary;
  const parts = [];
  if (earlier.length) parts.push("提前：" + earlier.map((x) => `${x.name} ${fmtDelta(x.delta)}`).join("、"));
  if (later.length) parts.push("推迟：" + later.map((x) => `${x.name} ${fmtDelta(x.delta)}`).join("、"));
  log(kind, logHtml + (parts.length ? `<br>📊 影响 → ${parts.join("；")}` : "<br>📊 对其他订单交期无影响"));
  render();
}

function evUrgent() {
  urgentSeq++;
  const id = "U" + urgentSeq;
  const qty = 40 + Math.floor(Math.random() * 80);
  const bases = [55, 90, 35, 30].map((b) => Math.round(b * (0.8 + Math.random() * 0.5)));
  const order = {
    id, name: `急单 X${100 + urgentSeq}`, prio: 1, qty,
    release: now, due: now + 480 + Math.floor(Math.random() * 240),
    urgent: true, deltaMin: null,
    ops: PROC_IDS.map((proc, j) => ({
      id: `${id}-${proc}`, orderId: id, proc, base: bases[j],
      machine: null, status: "pending", start: null, end: null,
      fixed: false, invalid: false, rework: false,
    })),
  };
  order.ops.forEach((op) => {
    const list = machines.filter((m) => m.caps[op.proc] != null);
    const m = list[Math.floor(Math.random() * list.length)];
    op.machine = m.id;
    machineQueues[m.id].unshift(op.id);
  });
  orders.push(order);
  applyAndReport("urgent", `🚨 <b>${order.name}</b> 插入（数量 ${qty}，交期 ${fmt(order.due)}），各工序已排到机台队首。`);
}

function evBreakdown() {
  const busy = machines.filter((m) => !m.blocked.some((b) => b.start <= now && b.end > now));
  if (!busy.length) return;
  const m = busy[Math.floor(Math.random() * busy.length)];
  const dur = 90 + Math.floor(Math.random() * 150);
  m.blocked.push({ start: now, end: now + dur });
  const affected = machineQueues[m.id]
    .map((id) => opById(id))
    .filter((op) => op && op.status === "pending").length;
  applyAndReport("breakdown", `🔧 <b>${m.name}</b> 突发故障，停机 ${Math.round(dur / 60 * 10) / 10} 小时（至 ${fmt(now + dur)}），队列中 ${affected} 道工序顺延。`);
}

function evRework() {
  const candidates = orders.filter((o) => {
    const qc = o.ops.find((op) => op.proc === "qc" && !op.rework);
    return qc && qc.status === "pending" && o.ops.some((op) => op.proc === "mach" && (op.status === "doing" || op.status === "done"));
  });
  if (!candidates.length) {
    log("rework", "🔁 当前没有可返工的订单（需加工已开工且质检未开始）。");
    return;
  }
  const order = candidates[Math.floor(Math.random() * candidates.length)];
  const machIdx = order.ops.findIndex((op) => op.proc === "mach" && !op.rework);
  const reworkOp = {
    id: `${order.id}-rework${order.ops.filter((x) => x.rework).length + 1}`,
    orderId: order.id, proc: "mach",
    base: Math.round(order.ops[machIdx].base * 0.5),
    machine: null, status: "pending", start: null, end: null,
    fixed: false, invalid: false, rework: true,
  };
  const machs = machines.filter((m) => m.caps.mach != null);
  const target = machs[Math.floor(Math.random() * machs.length)];
  reworkOp.machine = target.id;
  order.ops.splice(machIdx + 1, 0, reworkOp);
  machineQueues[target.id].unshift(reworkOp.id);
  applyAndReport("rework", `🔁 <b>${order.name}</b> 质检发现缺陷，插入返工工序（${PROCS.mach.name}，${reworkOp.base} 分钟 → ${target.name}），后续质检/包装顺延。`);
}

function evMaterial() {
  const candidates = orders.filter((o) => o.ops[0].status === "pending");
  if (!candidates.length) {
    log("material", "📦 所有订单首道工序均已开工，物料延迟不再产生影响。");
    return;
  }
  const order = candidates[Math.floor(Math.random() * candidates.length)];
  const delay = 60 + Math.floor(Math.random() * 180);
  order.release = Math.max(order.release, now) + delay;
  applyAndReport("material", `📦 <b>${order.name}</b> 物料延迟 ${Math.round(delay / 60 * 10) / 10} 小时，预计 ${fmt(order.release)} 到货，首道工序暂停排产。`);
}

function tick() {
  now += 1;
  let changed = false;
  orders.forEach((o) => {
    o.ops.forEach((op) => {
      if (op.status === "pending" && op.start != null && op.start <= now) {
        op.status = "doing";
        changed = true;
      }
      if (op.status === "doing" && op.end <= now) {
        op.status = "done";
        changed = true;
        const order = orderById(op.orderId);
        if (order.ops.every((x) => x.status === "done")) {
          const late = op.end > order.due;
          log(late ? "urgent" : "system", `${late ? "⚠️" : "✅"} <b>${order.name}</b> 全部完工（${fmt(op.end)}）${late ? "，已超交期" : ""}。`);
        }
      }
    });
  });
  if (changed) computeSchedule();
  render();
}

function setRunning(v) {
  running = v;
  if (running) {
    tickTimer = setInterval(tick, 1000 / speed);
  } else {
    clearInterval(tickTimer);
  }
  renderClock();
}

function renderLegend() {
  const box = document.getElementById("legend");
  box.innerHTML =
    PROC_IDS.map((p) => `<span><span class="legend-dot" style="background:${PROCS[p].color}"></span>${PROCS[p].name}</span>`).join("") +
    '<span><span class="legend-dot" style="background:repeating-linear-gradient(45deg,#e24848,#e24848 3px,#9c2f2f 3px,#9c2f2f 6px)"></span>机台故障/能力冲突</span>' +
    '<span>┆ 虚线 = 工序前后依赖（红色 = 所属订单延期）</span>' +
    '<span style="color:#e24848">▎现在时刻</span>';
}

function init() {
  buildInitialData();
  computeSchedule();
  renderLegend();
  render();
  log("system", `车间开班：${orders.length} 个订单、${machines.length} 台设备完成初始排产。可拖拽工序块调整顺序，或点击工序块更换机台。`);
}

function bindControls() {
  document.getElementById("btn-toggle").addEventListener("click", () => setRunning(!running));
  document.getElementById("speed").addEventListener("change", (e) => {
    speed = Number(e.target.value);
    if (running) setRunning(true);
  });
  document.getElementById("ev-urgent").addEventListener("click", evUrgent);
  document.getElementById("ev-breakdown").addEventListener("click", evBreakdown);
  document.getElementById("ev-rework").addEventListener("click", evRework);
  document.getElementById("ev-material").addEventListener("click", evMaterial);
  document.getElementById("btn-reset").addEventListener("click", () => {
    setRunning(false);
    document.getElementById("log").innerHTML = "";
    init();
  });
  document.getElementById("gantt-wrap").addEventListener("click", () => {
    if (selectedOpId) {
      selectedOpId = null;
      render();
    }
  });
}

init();
bindControls();
