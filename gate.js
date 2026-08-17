#!/usr/bin/env node
// 时段闸门 + 任务队列 —— gate.js
// 用法:
//   node gate.js status                 -> 输出 PEAK / OFFPEAK 及下次切换
//   node gate.js peak                   -> 退出码 0=高峰, 1=平峰 (供脚本判断)
//   node gate.js add "<title>" ["<brief>"]
//   node gate.js list
//   node gate.js next                   -> 输出队首 queued 任务 id
//   node gate.js get <id>
//   node gate.js update <id> <status> [note]   status: queued|processing|done|failed
const fs = require('fs');
const path = require('path');
const cfg = require('./config.json');

const queuePath = path.join(__dirname, cfg.queueFile);

function load() {
  if (!fs.existsSync(queuePath)) return { schema: 1, tasks: [] };
  return JSON.parse(fs.readFileSync(queuePath, 'utf8'));
}
function save(q) {
  const tmp = queuePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(q, null, 2));
  fs.renameSync(tmp, queuePath);
}
function z(n) { return String(n).padStart(2, '0'); }

// 按配置时区取"当前小时"（不依赖机器本地时区）
function hourNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: cfg.timezone, hour: 'numeric', hour12: false,
  }).formatToParts(new Date());
  return parseInt(parts.find(p => p.type === 'hour').value, 10) % 24;
}
// 测试钩子：TG_SIM_TIME="HH:MM" 时用模拟时间替代真实时钟（仅测试用，调度 cron 不会设置）
const SIM = process.env.TG_SIM_TIME;
function nowMinutes() {
  if (SIM) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(SIM);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  const d = new Date();
  return hourNow() * 60 + d.getMinutes();
}
function isPeak() {
  const h = Math.floor(nowMinutes() / 60);
  return cfg.peakWindows.some(w => h >= w.start && h < w.end);
}
function nextTransition() {
  const nowMin = nowMinutes();
  const points = [];
  for (const w of cfg.peakWindows) {
    points.push({ min: w.start * 60, kind: 'peak-start' });
    points.push({ min: w.end * 60, kind: 'peak-end' });
  }
  points.sort((a, b) => a.min - b.min);
  for (const p of points) if (p.min > nowMin) return { ...p, in: p.min - nowMin };
  const p = points[0];
  return { ...p, in: 24 * 60 - nowMin + p.min };
}

const [,, cmd, ...rest] = process.argv;
const q = load();

switch (cmd) {
  case 'status': {
    const nx = nextTransition();
    const mins = nowMinutes();
    console.log(isPeak() ? 'PEAK' : 'OFFPEAK');
    console.log(`now=${z(Math.floor(mins / 60))}:${z(mins % 60)} next=${nx.kind} in ${nx.in}min` + (SIM ? ` [sim ${SIM}]` : ''));
    break;
  }
  case 'peak':
    process.exit(isPeak() ? 0 : 1);
    break;
  case 'add': {
    const title = rest[0];
    const brief = rest.slice(1).join(' ') || title;
    if (!title) { console.error('usage: gate.js add "<title>" ["<brief>"]'); process.exit(2); }
    const id = 't' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    q.tasks.push({ id, title, brief, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), note: null });
    save(q);
    console.log(`added ${id} (${q.tasks.filter(t => t.status === 'queued').length} queued)`);
    break;
  }
  case 'list': {
    if (!q.tasks.length) { console.log('(empty)'); break; }
    for (const t of q.tasks) console.log(`${t.status.padEnd(10)} ${t.id}  ${t.title}`);
    break;
  }
  case 'next': {
    const t = q.tasks.find(t => t.status === 'queued');
    if (!t) process.exit(1);
    console.log(t.id);
    break;
  }
  case 'get': {
    const t = q.tasks.find(t => t.id === rest[0]);
    if (!t) { console.error('not found'); process.exit(1); }
    console.log(JSON.stringify(t, null, 2));
    break;
  }
  case 'rm': {
    const id = rest[0];
    const idx = q.tasks.findIndex(t => t.id === id);
    if (idx < 0) { console.error('not found'); process.exit(1); }
    const removed = q.tasks.splice(idx, 1)[0];
    save(q);
    console.log(`removed ${removed.id} (${removed.status})`);
    break;
  }
  case 'update': {
    const [id, status] = rest;
    const note = rest.slice(2).join(' ') || null;
    const t = q.tasks.find(t => t.id === id);
    if (!t) { console.error('not found'); process.exit(1); }
    if (!['queued', 'processing', 'done', 'failed'].includes(status)) { console.error('bad status'); process.exit(2); }
    t.status = status; t.updatedAt = new Date().toISOString();
    if (note) t.note = note;
    save(q);
    console.log(`${id} -> ${status}`);
    break;
  }
  default:
    console.error('usage: gate.js <status|peak|add|list|next|get|update|rm> ...');
    process.exit(2);
}
