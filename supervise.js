#!/usr/bin/env node
// 监工：只汇报，不重试。
// 发现 failed 任务或卡死任务(processing 超过 stuckMinutes) 时退出码 2，否则 0。
const fs = require('fs');
const path = require('path');
const cfg = require('./config.json');

const queuePath = path.join(__dirname, cfg.queueFile);
const q = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
const now = Date.now();
const stuckMin = cfg.supervise.stuckMinutes;

const counts = {};
const problems = [];
for (const t of q.tasks) {
  counts[t.status] = (counts[t.status] || 0) + 1;
  if (t.status === 'processing') {
    const ageMin = (now - new Date(t.updatedAt).getTime()) / 60000;
    if (ageMin > stuckMin) problems.push(`STUCK  ${t.id}  ${t.title} (processing ${Math.round(ageMin)}min)`);
  }
  if (t.status === 'failed') problems.push(`FAILED ${t.id}  ${t.title}`);
}
console.log('queue: ' + JSON.stringify(counts));
if (problems.length) {
  console.log(problems.join('\n'));
  process.exit(2);
}
process.exit(0);
