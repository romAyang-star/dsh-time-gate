# time-gate —— DeepSeek 高峰时段闸门 + 任务队列

> 高峰时段（**9:00–12:00、14:00–18:00**，Asia/Shanghai）**完全不烧 token**：
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

本仓库同时是一个 **dsh (DeepSeek Harness) 插件包**（宿主插件，薄封装）：
把 `ctx.timeGate` 服务暴露给 dsh（status / add / list / next / run / supervise），
所有逻辑仍由仓库脚本执行 —— 单队列、单一事实源。

```powershell
# 1. 把插件加进 web profile 依赖并安装（需代理环境变量）
$env:HTTPS_PROXY='http://127.0.0.1:10081'; $env:HTTP_PROXY='http://127.0.0.1:10081'
cd Z:\dsh
node_modules\.bin\dsh.cmd plugin --profile web add github:romAyang-star/dsh-time-gate

# 2. 在 Z:\dsh-home\profiles\web\package.json 的 dsh.profile.bundles 里追加 "dsh-time-gate"
# 3. 重启 dsh web：start-dsh-web.bat（已带 --host 0.0.0.0，手机/LAN 可访问）
```

> `cordis.patch.yml` 中的 `config.repoDir` 指向本机仓库路径；
> 换机器时改这一处即可（也可通过 dsh settings 覆盖）。

## License

MIT
