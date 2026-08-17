// dsh-time-gate —— DeepSeek 高峰时段闸门 + FIFO 任务队列（dsh 宿主插件）
//
// 薄封装设计：所有判断/队列/执行逻辑都在仓库脚本里（gate.js / run-task.js /
// supervise.js），插件只把 dsh 的调用转发到脚本 —— 保证单队列、单一事实源，
// 插件代码量最小、升级只需要 git pull。
//
// 配置（cordis.patch.yml 的 config）：
//   repoDir: 仓库绝对路径（脚本 + config.json + queue.json 所在目录）
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'time-gate';
export const inject = [];

function runScript(repoDir, script, args = []) {
  if (!repoDir || !existsSync(join(repoDir, script))) {
    return Promise.resolve({
      ok: false,
      code: -1,
      stdout: '',
      stderr: `dsh-time-gate: repoDir 未配置或脚本缺失 (${script})，请在 cordis.patch.yml 的 config.repoDir 填仓库路径`,
    });
  }
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], {
      cwd: repoDir,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }));
    p.on('error', (err) => resolve({ ok: false, code: -1, stdout, stderr: String(err) }));
  });
}

export function apply(ctx, config = {}) {
  const repoDir = config.repoDir;
  ctx.timeGate = {
    /** 当前是否高峰 + 下次切换时刻 */
    status: () => runScript(repoDir, 'gate.js', ['status']),
    /** 任务入队（高峰期间唯一允许的动作，零 token） */
    add: (title, brief) => runScript(repoDir, 'gate.js', ['add', title, brief || title]),
    /** 列出队列 */
    list: () => runScript(repoDir, 'gate.js', ['list']),
    /** 队首 queued 任务 id */
    next: () => runScript(repoDir, 'gate.js', ['next']),
    /** 执行一个任务（dsh headless，重试上限 0） */
    run: (id) => runScript(repoDir, 'run-task.js', [String(id)]),
    /** 监工：failed/卡死时 ok=false，退出码 2 */
    supervise: () => runScript(repoDir, 'supervise.js'),
  };
}
