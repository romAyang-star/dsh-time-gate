#!/usr/bin/env node
// 执行一个队列任务：queued -> processing -> 调 dsh headless -> done/failed
// 重试上限 = 0：失败就标 failed，交给监工汇报，不做任何自动重试。
// 用法: node run-task.js <id> [timeoutSec]
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const cfg = require('./config.json');

const queuePath = path.join(__dirname, cfg.queueFile);
const id = process.argv[2];
const timeoutSec = parseInt(process.argv[3] || cfg.run.timeoutSec, 10);
if (!id) { console.error('usage: run-task.js <id> [timeoutSec]'); process.exit(2); }

function saveQueue(q) {
  const tmp = queuePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(q, null, 2));
  fs.renameSync(tmp, queuePath);
}

const q = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
const t = q.tasks.find(t => t.id === id);
if (!t) { console.error(`task ${id} not found`); process.exit(1); }
if (t.status !== 'queued') { console.error(`task ${id} is ${t.status}, expected queued`); process.exit(1); }

t.status = 'processing';
t.updatedAt = new Date().toISOString();
saveQueue(q);

const dshCli = path.join(cfg.dsh.cwd, cfg.dsh.cli);

// headless 需要 DSH_HOME 指向 dsh-home 才能读到 .credentials.yaml；
// 再保险：直接把 key 注入环境变量（不回显）。
const env = { ...process.env, DSH_HOME: cfg.dsh.home };
try {
  const cred = fs.readFileSync(path.join(cfg.dsh.home, '.credentials.yaml'), 'utf8');
  const m = cred.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(\S+)\s*$/m);
  if (m) env.DEEPSEEK_API_KEY = m[1].trim();
} catch (e) { /* 没有凭证文件就交给 dsh 自己报错 */ }

console.log(`[run-task] ${id} -> dsh headless (timeout ${timeoutSec}s)`);

execFile('cmd.exe', ['/c', dshCli, '--profile', 'headless', t.brief], {
  cwd: cfg.dsh.cwd,
  env,
  timeout: timeoutSec * 1000,
  maxBuffer: 16 * 1024 * 1024,
  windowsHide: true,
}, (err, stdout, stderr) => {
  const out = (stdout || '').trim();
  const errOut = (stderr || '').trim();
  const ok = !err;
  const note = [out, errOut ? '[stderr] ' + errOut : ''].filter(Boolean).join('\n').slice(-6000);

  const q2 = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  const t2 = q2.tasks.find(x => x.id === id);
  t2.status = ok ? 'done' : 'failed';
  t2.updatedAt = new Date().toISOString();
  t2.note = note;
  saveQueue(q2);

  console.log(`[run-task] ${id} -> ${ok ? 'done' : 'failed'} (exit ${err ? err.code : 0})`);
  console.log(note.split('\n').slice(-15).join('\n'));
  process.exit(ok ? 0 : 1);
});
