# time-gate —— DeepSeek 高峰时段闸门 + 任务队列

> 虽然可能不会有很多人有这个需要，但是能省一点是一点嘛。认真多省省，这叫勤俭持家，学着点。高峰时段（**9:00–12:00、14:00–18:00**，Asia/Shanghai）**完全不烧 token**：
> 新任务自动进队列，平峰按 FIFO 顺序自动执行。执行引擎 = **dsh (DeepSeek Harness) headless** ——
> 烧 dsh 自己的 API 余额，**不碰用户选择的模型**。

## 架构

```
用户/调度触发任务
      │
      ▼
┌─────────────┐  高峰(9-12,14-18)   ┌──────────────┐
│   gate.js   │ ─────────────────▶ │ queue.json   │ 零 token，只写文件
│  add/status │                    │ (FIFO 计划表) │
└─────────────┘                    └──────┬───────┘
      │ 平峰(12:00/18:00 cron 触发)        │
      ▼                                    ▼
┌─────────────┐                    ┌──────────────┐
│ run-task.js │ ──调用──▶  dsh headless CLI       │
│             │            (goal/workflow 全套)    │
└─────────────┘                    └──────────────┘
      │ 结果写回队列
      ▼
┌─────────────┐  只汇报 failed/卡死，重试上限 0
│ supervise.js│ ◀── 监工 cron (0/3/6/21 点)
└─────────────┘
```

## 特性

- **高峰零消耗**：任务只入队不执行，不调任何 API；撞上高峰的队列消化立即暂停
- **平峰自动消化**：cron 到点按 FIFO 执行
- **执行与决策解耦**：任务书（brief）落盘为队列项，执行完全交给 dsh
- **监工纪律**：只上报 `failed` / 卡死（processing 超时），自动重试上限 = 0
- **测试钩子**：`TG_SIM_TIME="HH:MM"` 可模拟任意时刻，验证闸门边界

## 依赖

- Node.js 18+
- [dsh (DeepSeek Harness)](https://github.com/deepseek-ai) 已安装，且已配置 `DEEPSEEK_API_KEY`（web 界面 Models 页或 `$DSH_HOME/.credentials.yaml`）
- OpenClaw 或任意具备 cron 能力的宿主

## 安装

```powershell
git clone <repo-url>
cd time-gate
Copy-Item config.example.json config.json   # 按本机路径修改
```

> ⚠️ **DSH_HOME 是关键**：dsh headless 需要 `DSH_HOME` 指向 dsh-home 才能读到凭证。
> web 模式通常由启动脚本设置，CLI 模式不会 —— `run-task.js` 已自动注入
> `DSH_HOME`（来自 `config.json` 的 `dsh.home`），并把 `.credentials.yaml` 中的
> `DEEPSEEK_API_KEY` 注入环境变量（不回显、不落日志）。

## cron 配置

| 任务 | 时间 (Asia/Shanghai) | 作用 |
|---|---|---|
| tg-dispatch | 12:00, 18:00 | 平峰开始，按序消化队列 |
| tg-supervisor | 0:00, 3:00, 6:00, 21:00 | 监工，只汇报异常 |

OpenClaw 示例（isolated agentTurn）：

```
cron 0 12,18 * * *  →  node time-gate/run-task.js <id>   （循环取 next，先查 status）
cron 0 0,3,6,21 * * * →  node time-gate/supervise.js     （无异常不打扰）
```

## 命令

```powershell
node gate.js status                       # PEAK / OFFPEAK + 下次切换
node gate.js peak                         # 退出码 0=高峰, 1=平峰
node gate.js add "<标题>" ["<任务书>"]     # 入队（任务书 = 给 dsh 的完整 brief）
node gate.js list                         # 看队列
node gate.js next                         # 队首 queued 任务 id
node gate.js get <id>                     # 看单个任务（含输出 note）
node gate.js update <id> <status> [note]  # queued|processing|done|failed
node gate.js rm <id>                      # 删除任务（清理用）
node run-task.js <id> [timeoutSec]        # 用 dsh headless 执行一个任务
node supervise.js                         # 监工：failed/卡死 -> 退出码 2
```

## 测试

```powershell
$env:TG_SIM_TIME='10:00'; node gate.js status   # PEAK（模拟高峰）
$env:TG_SIM_TIME='13:00'; node gate.js status   # OFFPEAK
```

边界语义：**开始含、结束不含** —— 09:00/14:00 准时封闸，12:00/18:00 准时放行。

## 状态机

`queued -> processing -> done | failed`（failed 是终点，不自动重试）

## 作为 dsh 插件安装

本仓库同时是一个 **dsh (DeepSeek Harness) 插件包**（宿主插件，HTTP 路由版）：
注册 `/time-gate` 路由，转发到仓库脚本执行 —— 单队列、单一事实源。
插件入口 `lib/index.mjs`（仓库本身不设 `"type": "module"`，脚本保持 CommonJS）。

### 安装

```powershell
# 1. 把插件加进 web profile 依赖并安装（需代理环境变量）
$env:HTTPS_PROXY='http://127.0.0.1:10081'; $env:HTTP_PROXY='http://127.0.0.1:10081'
cd Z:\dsh
node_modules\.bin\dsh.cmd plugin --profile web add github:romAyang-star/dsh-time-gate

# 2. 确认 Z:\dsh-home\profiles\web\package.json 的 dsh.profile.bundles 含 "dsh-time-gate"
#    （pnpm add 会自动 reconcile；手动加依赖后重启生效）
# 3. 重启 dsh web
```

> `cordis.patch.yml` 中的 `config.repoDir` 指向本机仓库路径，换机器改这一处。

### HTTP API（`/time-gate`）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/time-gate/api/status` | 当前是否高峰 + 下次切换 |
| POST | `/time-gate/api/add` | 入队 `{title, brief?}` |
| GET | `/time-gate/api/list` | 队列 |
| GET | `/time-gate/api/next` | 队首 queued id |
| POST | `/time-gate/api/run` | 执行 `{id}`（dsh headless，重试上限 0） |
| GET | `/time-gate/api/supervise` | 监工 |

### 手机/LAN 访问（dsh web 绑定）

dsh web 默认只绑 127.0.0.1，CLI 禁止 `--host 0.0.0.0`；但配置层 schema 允许，
在 `Z:\dsh-home\profiles\web\cordis.patch.yml` 覆盖即可：

```yaml
- id: webserver
  config:
    host: 0.0.0.0
    port: 3080
```

> ⚠️ **安全提醒**：dsh web 内置 agent 工具（bash/fs 等，等同于远程代码执行）且默认无鉴权。
> 绑 0.0.0.0 会暴露给同网段所有设备，务必配合防火墙白名单或仅信任网络（如 Tailscale 子网）。

> 只放行 Tailscale 网段的防火墙规则（管理员 PowerShell）：
> ```powershell
> New-NetFirewallRule -DisplayName 'dsh-time-gate tailnet-only allow' -Name 'dsh-time-gate-allow-tailnet' -Direction Inbound -Protocol TCP -LocalPort 3080 -RemoteAddress '100.64.0.0/10' -Action Allow -Profile Any
> New-NetFirewallRule -DisplayName 'dsh-time-gate block others' -Name 'dsh-time-gate-block-others' -Direction Inbound -Protocol TCP -LocalPort 3080 -Action Block -Profile Any
> ```

## License

MIT
