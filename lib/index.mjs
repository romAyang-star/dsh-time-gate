// dsh-time-gate —— DeepSeek 高峰时段闸门 + FIFO 任务队列（dsh 宿主插件，HTTP 路由版）
//
// 薄封装设计：所有判断/队列/执行逻辑都在仓库脚本里（gate.js / run-task.js /
// supervise.js），插件只注册 /time-gate 路由把请求转发到脚本 —— 单队列、单一事实源。
//
// 路由：
//   GET  /time-gate/api/status      当前是否高峰 + 下次切换
//   POST /time-gate/api/add         任务入队 {title, brief?}
//   GET  /time-gate/api/list        队列列表
//   GET  /time-gate/api/next        队首 queued 任务 id
//   POST /time-gate/api/run         执行任务 {id}
//   GET  /time-gate/api/supervise   监工（failed/卡死 -> ok=false）
//
// 配置（cordis.patch.yml 的 config）：
//   repoDir: 仓库绝对路径（脚本 + config.json + queue.json 所在目录）
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'time-gate';
export const inject = ['webServer'];

const PAGE_PATH = '/time-gate';

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

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

export function apply(ctx, config = {}) {
  const ws = ctx.get('webServer');
  if (ws === undefined) return;
  const options = { pagePath: PAGE_PATH, repoDir: config.repoDir, ...config };
  const disposers = [];

  const route = {
    kind: 'prefix',
    path: options.pagePath,
    handler: async (req, res) => {
      const url = (req.url ?? '').split('?')[0];
      const api = `${options.pagePath}/api`;
      try {
        if (url === api || url === `${api}/status`) {
          return sendJson(res, 200, await runScript(options.repoDir, 'gate.js', ['status']));
        }
        if (url === `${api}/add` && req.method === 'POST') {
          const body = await readJsonBody(req);
          const title = String(body?.title ?? '').trim();
          if (!title) return sendJson(res, 400, { ok: false, error: 'title required' });
          const brief = String(body?.brief ?? title).trim();
          return sendJson(res, 200, await runScript(options.repoDir, 'gate.js', ['add', title, brief]));
        }
        if (url === `${api}/list`) {
          return sendJson(res, 200, await runScript(options.repoDir, 'gate.js', ['list']));
        }
        if (url === `${api}/next`) {
          return sendJson(res, 200, await runScript(options.repoDir, 'gate.js', ['next']));
        }
        if (url === `${api}/run` && req.method === 'POST') {
          const body = await readJsonBody(req);
          const id = String(body?.id ?? '').trim();
          if (!id) return sendJson(res, 400, { ok: false, error: 'id required' });
          return sendJson(res, 200, await runScript(options.repoDir, 'run-task.js', [id]));
        }
        if (url === `${api}/supervise`) {
          return sendJson(res, 200, await runScript(options.repoDir, 'supervise.js'));
        }
        if (url === options.pagePath) {
          const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-time-gate</title></head>
<body style="font:14px/1.7 ui-monospace,Consolas,monospace;background:#101820;color:#e8ecf0;padding:32px">
<h2 style="color:#ffb02e">dsh-time-gate API</h2>
<pre>GET  ${api}/status      高峰判断
POST ${api}/add         入队 {title, brief?}
GET  ${api}/list        队列
GET  ${api}/next        队首
POST ${api}/run         执行 {id}
GET  ${api}/supervise   监工</pre>
<p style="color:#8a97a5">逻辑见仓库脚本 gate.js / run-task.js / supervise.js</p>
</body></html>`;
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': Buffer.byteLength(html),
          });
          return res.end(html);
        }
        return sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e) });
      }
    },
  };
  disposers.push(ws.register(route));
  ctx.on('dispose', () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {}
    }
  });
}
