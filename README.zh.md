# dsh-restart

**为 DeepSeek Harness 提供的安全重启执行能力 —— 它决定的是*如何*安全地重启，而从不判断一次重启是否*确有必要*。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.11.0-brightgreen.svg)](package.json)
[![DSH compatibility](https://img.shields.io/badge/DSH-%40deepseek--ai%2Fcordis%20%5E4.0.1-informational.svg)](package.json)
[![Plugin type](https://img.shields.io/badge/plugin-bundle%20patch%20%2B%20external%20supervisor-purple.svg)](cordis.patch.yml)

English | [中文](README.zh.md)

`dsh-restart` 接收一个重启请求，对它做校验，获取排他锁，以检查点作为门槛，写入一张带校验和的票据，向宿主请求优雅关闭，然后让一个**外部 Supervisor** 观察退出并重新拉起。它不包含任何健康策略，没有温度阈值，也没有按时段调度，更无法访问任务队列。它最坏情况下的失败是*“自动重启不可用”* —— 而绝不会是*“DS-Hns 不可用”*。

---

## 它做什么 / 它明确不做什么

边界本身就是产品。右列中的每一项都属于另一个组件，其中任何一项都不得被拉回到本组件中。

| 职责 | dsh-restart | Health Scheduler | Supervisor | DS-Hns Core |
| --- | --- | --- | --- | --- |
| 感知压力（CPU、内存、温度、运行时） | **否** | 是 | 否 | 否 |
| 判断一次重启是否确有必要 | **否** | 是 | 否 | 否 |
| 安排维护窗口 | **否** | 是 | 否 | 否 |
| 接受并校验重启请求 | **是** | 提交请求 | 否 | 否 |
| 强制实施排他重启锁 | **是** | 否 | 否 | 否 |
| 强制实施冷却与重复抑制 | **是** | 否 | 否 | 否 |
| 以检查点 / 安全点作为门槛 | **是**（只询问，且只相信回答） | 否 | 否 | **是**（产生检查点） |
| 保存与恢复任务状态 | **否** | 否 | 否 | **是** |
| 写入重启票据 | **是** | 否 | 否 | 否 |
| 请求优雅关闭 | **是**（通过端口） | 否 | 否 | 自行掌管自身退出 |
| 观察退出并重新拉起 | **否** | 否 | **是** | 否 |
| 打断崩溃循环 / 进入安全模式 | **否** | 否 | **是** | 否 |
| 读取或修改任务队列 | **否** | 否 | **否** | **是** |
| 重启操作系统 | **三重门禁且已接线**（见[安全说明](#安全说明)） | 请求重启 | 否 | 否 |

把这张表读作三道接缝：[`dsh-health-scheduler`](https://github.com/zhiheng-zhang-Mera/dsh-health-scheduler) 做决定，`dsh-restart` 执行，Supervisor 负责重新拉起。任何一方缺席都不会破坏另外两方。

---

## 安装

`dsh-restart` 以 DSH **bundle** 的形式发布：`package.json` 声明了
`dsh.bundle.patch = ./cordis.patch.yml`，而该 patch 只插入一行插件记录。

### 从本地检出安装

```powershell
dsh plugin --profile web add D:\dsh-plugin-develop\dsh-restart
dsh --profile web --dump-config | Select-String dsh-restart
```

第一条命令把该包追加到 profile 的 `dsh.profile.bundles`；第二条命令证明组合后的 profile 确实提到了它。在 `--dump-config` 显示出该插件之前，不要认为安装已经完成：解析失败的 bundle 会让 profile 看起来像是已经装好了。

### 从 npm 或 tarball 安装

```powershell
dsh plugin --profile web add dsh-restart
# or, from a packed artifact
npm pack
dsh plugin --profile web add .\dsh-restart-0.1.0.tgz
```

这些是推荐的安装方式。发布的包中包含 `lib/`、`src/`、`bin/`、
`cordis.patch.yml`、本 README 以及许可证，因此安装机器上不会运行
任何构建步骤。

### 从 git 安装，以及构建注意事项

```powershell
dsh plugin --profile web add github:dsh-restart/dsh-restart
```

git 安装会运行该包的 `prepare`/`prepack` 脚本，也就是
`npm run build` —— 这属于**安装时的任意代码执行**，由你的包
管理器把关：

- npm ≥ 7 不会为 git 依赖运行 `prepare`，除非该依赖被允许
  运行脚本；使用 `--ignore-scripts` 安装的 profile（或早于本包
  `allowBuilds` 条目的受管 profile）会缺少 `lib/`。
- pnpm 要求先把该包列入 profile 的 `pnpm-workspace.yaml`（或 `.npmrc`）中的
  `onlyBuiltDependencies` / `allowBuilds`，之后才会运行 `prepare`。
- 通过 npm/tarball 安装永远不会遇到这个问题：`lib/` 已经构建好并随包发布。

如果 git 安装能够加载、随后却报出 `no lib/index.js`，那正是这条注意事项，而不是
插件缺陷：在检出目录中运行 `npm run build`，或改用 npm/tarball 安装。

### 使用辅助脚本

```powershell
pwsh -File scripts/install.ps1                     # register, verify, smoke test
pwsh -File scripts/install.ps1 -WhatIf             # print every action, change nothing
pwsh -File scripts/install.ps1 -SkipSupervisor     # register only
```

`install.ps1` 注册插件、用 `--dump-config` 校验 profile、可选地以脱离方式启动 Supervisor，并对 `node bin/supervisor.mjs --help` 做冒烟测试。它是幂等的：在添加之前会先问 profile 该插件是否已经注册，若是靠猜测就宁可停下，也不会添加第二条注册。参见 [docs/operations.zh.md](docs/operations.zh.md)。

---

## Supervisor

Supervisor 是一个**独立的长期存活进程**。它是 DS-Hns 退出之后唯一能重新拉起它的东西，而且它必须比它所监视的进程活得更久，因此要以脱离（detached）方式启动：

```powershell
node bin/supervisor.mjs --state "$env:DSH_HOME\restart" -- node dsh.js --profile web
```

```
Usage:
  node bin/supervisor.mjs [options] [-- <launch command>]

Options:
  --state <dir>              directory holding ticket.json, heartbeat.json and ledger.json
                             (default: %DSH_HOME%\restart, else ./.dsh-restart)
  --pid <pid>                watch this pid instead of the parent process
  --tick-ms <ms>             poll interval (default: supervisor.pollIntervalMs)
  --max-ticks <n>            stop after n ticks (default: run until a terminal state)
  --terminate-after-verify   exit after a relaunch is verified, instead of resuming
  -h, --help                 show this message
```

**为什么它必须脱离启动。** Supervisor 的职责就是在 DS-Hns 不在时仍然活着。作为
DS-Hns 的子进程，它会随 DS-Hns 一起死去，而那恰恰正是最需要它的时候。请
用 `Start-Process -WindowStyle Hidden` 或任务计划程序以脱离方式启动它，并给它
自己的日志文件。

**为什么 `-- <launch command>` 很重要。** 不带 `--` 时，Supervisor 会从自己的 `argv`
推导重新拉起命令，而那是 `bin/supervisor.mjs` —— 并不是 DS-Hns。在部署中始终要传 `--`，
或者在配置里设置 `supervisor.launchCommand`。

**它写入的内容**，全部位于 `--state <dir>` 之内：

| 文件 | 写入方 | 内容 |
| --- | --- | --- |
| `ticket.json` | 插件 | 带校验和的重启票据（见 [docs/protocol.zh.md](docs/protocol.zh.md)） |
| `heartbeat.json` | Supervisor | `schemaVersion`、`supervisorPid`、`watchedPid`、`state`、`timestamp`、`sequence` |
| `ledger.json` | Supervisor | `uncleanStarts`、`safeMode`、`safeModeReason`、`safeModeAt`、`relaunches` |
| `supervisor.log` | Supervisor | 每行一个 JSON 对象，并镜像到 stderr |
| `restart-attempts.jsonl` | 插件 | 仅追加的审计日志；达到 `storage.maxLogBytes` 时轮转为 `.bak` |

**退出码**（已对照真实二进制验证）：

| 代码 | 含义 | 运维人员应当做什么 |
| --- | --- | --- |
| `0` | 本次运行到达了终态（`supervisor_stopped`，例如 `TICK_LIMIT`、`VERIFIED`） | 什么都不用做 |
| `1` | 致命错误：未知选项或未处理的异常 | 阅读 stderr 上的堆栈跟踪；修正命令行 |
| `2` | 状态目录无法创建 | 修正路径或其权限 |
| `3` | **安全模式**：崩溃循环熔断器已跳闸，或本次运行以 `CRASH_LOOP` 结束 | 必须有人查看这台机器；见[从安全模式恢复](docs/operations.zh.md) |

退出码 3 是刻意区分出来的：包装脚本或任务计划程序可以把
“必须有人来看一眼”和“运行成功”区别开来。

---

## 请求流程

```
requester (dsh-health-scheduler / dsh-cli / operator)
        │  RestartRequest
        ▼
  validateShape ──► INVALID_REQUEST
        ▼
  duplicate ledger ──► DUPLICATE_REQUEST_ID
        ▼
  validateRequest ──► DISABLED · UNKNOWN_SOURCE · MODE_NOT_ALLOWED
        │             SYSTEM_REBOOT_NOT_PERMITTED · CRASH_LOOP
        │             RESTART_IN_FLIGHT · COOLDOWN_ACTIVE
        │             CHECKPOINT_FAILED · SUPERVISOR_ABSENT
        ▼
  lock.transition(REQUESTED) ──► RESTART_IN_FLIGHT (illegal edge)
        ▼
  lock CHECKPOINTING · gate.prepare() ──► CHECKPOINT_FAILED · CHECKPOINT_REQUIRED
        ▼
  write ticket.json (atomic, checksummed) ──► TICKET_WRITE_FAILED
        ▼
  lock SHUTTING_DOWN · shutdown.requestShutdown(ticketId)
        │                              └──► SHUTDOWN_PORT_UNAVAILABLE
        ▼
  accepted:true ─ the process is expected to exit now
        ▼
  ── process boundary ──
        ▼
  supervisor: MONITORING → WAITING_FOR_EXIT → RELAUNCHING
            → WAITING_FOR_HEARTBEAT → VERIFIED → MONITORING
```

插件的职责在 `accepted: true` 处结束。进程边界之后的一切都属于 Supervisor，并且由磁盘上的票据驱动，而不是由内存中持有的任何东西驱动 —— 这正是整套机制能够在它自己所执行的那次重启中存活下来的原因。

### 全部拒绝代码

`RestartResponse` 中的 `reason` 是下列之一。当请求从未启动时 `state` 为 `rejected`，
当请求已经启动但被中止时 `state` 为 `failed`。下面所有字符串都是真实的
`detail` 值。

| 代码 | 触发条件 | 修复方式 |
| --- | --- | --- |
| `INVALID_REQUEST` | 请求不是对象；必填字段缺失、为空、超长或含控制字符；`mode` 不是 `application`/`system`；`checkpointRequired` 不是布尔值；`priority` 未知；某个字段类型错误 | 按 [docs/protocol.zh.md](docs/protocol.zh.md) 中的形状提交；`requestId` ≤ 128，`source` ≤ 64，`reasonCode` ≤ 64，`reasonSummary` ≤ 500 个字符 |
| `INVALID_REQUEST`（priority） | `priority` 合法但未列入 `allowedPriorities` | 把它加入 `allowedPriorities`，或改用被接受的优先级 |
| `DISABLED` | `enabled: false` | 设为 `enabled: true`，或运行 `scripts/enable.ps1` |
| `UNKNOWN_SOURCE` | `source` 不在 `allowedSources` 中 | 把该请求方加入 `allowedSources` |
| `MODE_NOT_ALLOWED` | 该模式自身的 `enabled` 为 false（`systemRestart.enabled` 默认为 false） | 启用该模式 —— 对于 system 模式，还要同时启用 `allowSystemReboot` |
| `SYSTEM_REBOOT_NOT_PERMITTED` | `allowSystemReboot` 为 false，或请求省略了 `acknowledgeSystemReboot` | 两道门槛都必须通过：配置**以及**请求自身的确认 |
| `CRASH_LOOP` | 崩溃循环熔断器已禁用自动重启 | 先修复底层的崩溃，然后清除熔断器（`scripts/enable.ps1`） |
| `DUPLICATE_REQUEST_ID` | 同一个 `requestId` 以**不同**内容被重放 | 换一个新的 `requestId`；完全相同的重放会返回第一次的答复，并不算拒绝 |
| `RESTART_IN_FLIGHT` | 锁不是 `IDLE`，或锁拒绝了该次状态转移 | 等待进行中的重启，或让它失败；绝不要排队第二次 |
| `COOLDOWN_ACTIVE` | 该模式的上一次重启发生在 `minIntervalMs` 之内 | 等过 `cooldowns.<mode>.remainingMs`，或有意识地修改配置的上限 |
| `CHECKPOINT_FAILED` | 没有绑定检查点端口而 `checkpointRequired` 为 true；端口抛错；端口未在 `safety.shutdownTimeoutMs` 内应答 | 绑定一个检查点端口（`applyRestart` 选项 `checkpoint`），或对确实不需要检查点的请求设置 `checkpointRequired: false` |
| `CHECKPOINT_REQUIRED` | Harness 答复称现在**不**适合重启（例如 `git_commit_in_progress`），而该请求要求检查点 | 等待安全点；不要强行推进 |
| `SUPERVISOR_ABSENT` | 在 `supervisor.heartbeatTimeoutMs` 内没有心跳 | 启动 Supervisor；或设置 `safety.allowRestartWithoutSupervisor: true`，并接受“退出之后并不会重启”这一事实 |
| `SHUTDOWN_PORT_UNAVAILABLE` | 关闭端口返回 false，或抛错 | 在 `applyRestart` 中接入生命周期，或接受优雅重启无法实现 |
| `TICKET_WRITE_FAILED` | 票据无法写入磁盘 | 修正状态目录的权限或释放空间；在返回拒绝之前，票据会被删除、锁会被释放 |

审计日志中还会出现另外两个机器可读的代码，但它们永远不会作为 `reason` 出现：
`ACCEPTED`（该次尝试已被接受）与 `CANCELLED`（请求方取消了它）。

<details>
<summary>检查顺序，以及它为何重要</summary>

`validateShape` 最先运行，因此格式错误的请求永远不会到达冷却
账本、重复映射表或写文件的代码。接下来按顺序检查：
`enabled` → `allowedSources` → `allowedPriorities` → 模式 `enabled` → system 门槛 →
崩溃循环熔断器 → 重复 id → 锁 → 冷却 → 检查点端口 → Supervisor
是否存在。廉价的结构性拒绝排在前面；运维人员看到的拒绝是第一个
适用的拒绝，而不是所有拒绝的汇总。
</details>

---

## 失效模式

设计稿中的六个案例，以及本代码对每一个实际给出的保证。完整
细节（包括运维人员看到什么、如何恢复）见
[docs/failure-modes.zh.md](docs/failure-modes.zh.md)。

| # | 案例 | 保证的行为 |
| --- | --- | --- |
| 1 | **插件崩溃** | DS-Hns 继续运行。插件从不掌管应用的生命周期：它没有任何会让进程退出的定时器，`apply` 内部抛出的异常也无法阻止宿主启动。一次执行到一半的重启会留下票据；下一个进程的 `reconcileAfterRestart()` 会删除它并上报。 |
| 2 | **Supervisor 崩溃** | DS-Hns 继续运行。心跳变旧，`supervisor.present` 会在 `heartbeatTimeoutMs` 内变为 false，此后每个请求都会以 `SUPERVISOR_ABSENT` 被拒绝。自动重新拉起的能力丢失；优雅重启依然是被拒绝，而不会降级为一次关闭。 |
| 3 | **检查点失败** | 重启被中止，绝不降级。不安全的答复、不完整的检查点、端口抛错、超时以及未绑定的端口，都会产生 `CHECKPOINT_FAILED`/`CHECKPOINT_REQUIRED`，票据被删除、锁被释放。本插件完全不触碰任务状态。 |
| 4 | **关闭挂起** | **部分实现，并如实承认。** 插件在宿主接受关闭请求之后返回 `accepted: true`，并且从不等待自己退出，所以它不可能挂起。Supervisor 的 `WAITING_FOR_EXIT` 状态现在有截止时间（`safety.shutdownTimeoutMs`）：超时即放弃这次重启并记录原因；当 `safety.allowForceTerminate` 打开且注入了终止器时，它会结束该进程并把这次重启记为脏重启。见[尚未实现](#尚未实现)。 |
| 5 | **重启之后没有心跳** | 当被重新拉起的 pid 在 `relaunchTimeoutMs` 之后仍不存活时，Supervisor 会计一次不干净启动，然后再次重新拉起；在 `crashLoopWindowMs` 内失败达到 `crashLoopLimit` 次之后，熔断器跳闸并进入安全模式（退出码 3）。重试由熔断器约束，而不是由退避曲线约束。 |
| 6 | **请求风暴** | 通过 `requestId` 去重（完全相同的重放返回第一次的答复），通过排他锁串行化，并通过按模式的冷却做速率限制。优先级永远不会绕过这三者中的任何一个。 |

---

## 配置

每个键都是可选的；下面的值是随附的默认值，其中的每一项都在
[`cordis.patch.yml`](cordis.patch.yml) 中连同修改它的风险一起做了说明。完整的类型与效果：
[docs/operations.zh.md](docs/operations.zh.md)。

| 键 | 类型 | 默认值 | 效果 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关；`false` 会让每个请求都以 `DISABLED` 被拒绝 |
| `applicationRestart.enabled` | boolean | `true` | 是否允许发生应用重启 |
| `applicationRestart.minIntervalMs` | number | `1200000` | 应用重启之间强制实施的冷却（20 分钟） |
| `systemRestart.enabled` | boolean | `false` | 是否可以使用 system 模式 |
| `systemRestart.minIntervalMs` | number | `3600000` | 系统重启之间强制实施的冷却（60 分钟） |
| `allowedSources` | string[] | `dsh-health-scheduler`、`dsh-cli`、`operator` | 谁可以提交；空列表会触发 `ConfigError` |
| `allowedPriorities` | string[] | `low`、`normal`、`high`、`emergency` | 被接受的优先级词表 |
| `allowSystemReboot` | boolean | `false` | `mode: system` 的第二道门槛；请求还必须做出确认 |
| `safety.checkpointRequired` | boolean | `true` | 请求的检查点是否必须成功 |
| `safety.duplicateSuppression` | boolean | `true` | 重放的 `requestId` 是否返回上一次的答复 |
| `safety.crashLoopLimit` | number | `3` | 窗口内触发熔断器的不干净启动次数 |
| `safety.crashLoopWindowMs` | number | `600000` | 熔断器滚动窗口（10 分钟） |
| `safety.safeModeOnLoop` | boolean | `true` | 熔断器跳闸时是否同时进入安全模式 |
| `safety.shutdownTimeoutMs` | number | `90000` | 关闭预算，同时也用作检查点预算 |
| `safety.allowForceTerminate` | boolean | `false` | 已声明、已校验，但本版本**从不读取** |
| `safety.allowRestartWithoutSupervisor` | boolean | `false` | 在无人重新拉起的情况下是否仍然退出 |
| `supervisor.heartbeatIntervalMs` | number | `5000` | Supervisor 心跳周期 |
| `supervisor.heartbeatTimeoutMs` | number | `30000` | 超过该时长后 Supervisor 即被视为缺席 |
| `supervisor.relaunchTimeoutMs` | number | `90000` | 被重新拉起的 pid 必须保持存活的时间 |
| `supervisor.launchCommand` | string[] \| null | `null` | 重新拉起命令；`null` 表示“复用 Supervisor 自己的 argv” |
| `supervisor.launchArgs` | string[] | `[]` | 追加到重新拉起命令之后的额外参数 |
| `supervisor.launchCwd` | string \| null | `null` | 重新拉起时的工作目录 |
| `supervisor.pollIntervalMs` | number | `1000` | pid 轮询间隔 |
| `supervisor.ticketTtlMs` | number | `600000` | 待处理票据保持有效的时长 |
| `supervisor.detach` | boolean | `true` | Supervisor 是否以脱离方式运行 —— **已声明，从不读取**：只有那个未被调用的 `spawnSupervisor()` 会查询它 |
| `storage.directory` | string \| null | `null` | 审计日志目录；`null` = 状态目录 |
| `storage.maxLogBytes` | number | `4194304` | 审计日志轮转阈值 |
| `storage.maxRecentAttempts` | number | `25` | 为状态查询而在内存中保留的尝试次数 |
| `knownReasonCodes` | string[] | 九个代码 | 可无警告接受的代码；未知代码只会被记录，不会被拒绝 |

非法文档会在加载时以点分路径的形式被拒绝，插件会继续使用默认值，而不是让宿主启动失败。例如：

```
dsh-restart config: supervisor.heartbeatTimeoutMs must exceed supervisor.heartbeatIntervalMs (60000), received 30000
dsh-restart config: allowedSources must list at least one source; an empty list would refuse every request, including an operator request
```

---

## 面向模型的工具

当 profile 具有工具运行时时，会注册三个工具。它们只是对 API 所暴露的同一服务的
便利封装 —— **工具调用不会绕过任何检查**：它会依次经过
`validateShape`、`validateRequest`、锁、冷却和检查点门槛，完全
像任何其他请求方一样，并被归因到 `dsh-cli` 来源。

### `restart_status`

只读。无参数。以下是真实输出（已裁剪）：

```json
{
  "timestamp": "2026-06-01T09:05:00.000Z",
  "enabled": true,
  "lock": "IDLE",
  "can_restart": true,
  "can_restart_reason": "OK",
  "active": null,
  "cooldowns": {
    "application": { "nextAllowedAt": null, "remainingMs": 0, "minimumIntervalMs": 1200000 },
    "system": { "nextAllowedAt": null, "remainingMs": 0, "minimumIntervalMs": 3600000 }
  },
  "crash_loop": { "tripped": false, "failuresInWindow": 0, "limit": 3, "windowMs": 600000, "trippedAt": null, "reason": null },
  "supervisor": { "present": true, "lastSeenAt": "2026-06-01T09:04:58.000Z", "ageMs": 0 },
  "capabilities": {
    "applicationRestart": true,
    "systemRestart": false,
    "checkpointPort": true,
    "shutdownPort": true,
    "supervisorWatch": true
  },
  "recent": []
}
```

`ageMs` 是最后一次心跳的年龄。`TicketStore.heartbeatAgeMs()` 优先使用 Supervisor 写在 `heartbeat.json` 里的 `timestamp` 字段，仅当该时间戳缺失或无法解析时才回退到文件的 `mtime`，因此 `lastSeenAt` 与 `ageMs` 通常描述同一个时刻。停止心跳的 Supervisor 会让两者同时冻结，于是在 `heartbeatTimeoutMs` 之内就会被判定为不存在——这才是诚实的解读。

### `restart_request`

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `mode` | `application` \| `system` | 是 | 范围 |
| `reason_code` | string | 是 | 会被记录，但从不被解析（例如 `RUNTIME_PRESSURE`） |
| `reason_summary` | string | 是 | 一行文本，按原文记入审计日志 |
| `checkpoint_required` | boolean | 否 | 默认为 `true` |
| `priority` | `low` \| `normal` \| `high` \| `emergency` | 否 | 默认为 `normal` |
| `acknowledge_system_reboot` | boolean | 否 | 当 `mode: "system"` 时为必填 |

被接受：

```json
{
  "accepted": true,
  "state": "shutting_down",
  "detail": "application restart accepted: the host is shutting down and the supervisor will relaunch it",
  "requestId": "tool-1780000000000-482913",
  "ticketId": "application-1780304400000-1-e2efb725"
}
```

被拒绝，且原因按原文返回：

```json
{
  "accepted": false,
  "state": "rejected",
  "reason": "SUPERVISOR_ABSENT",
  "detail": "no supervisor heartbeat was seen; set safety.allowRestartWithoutSupervisor = true to restart anyway",
  "requestId": "tool-1780000000000-482913"
}
```

### `restart_cancel`

| 参数 | 类型 | 必填 |
| --- | --- | --- |
| `request_id` | string | 是 |

```json
{
  "cancelled": true,
  "detail": "request tool-1780000000000-482913 cancelled; no restart will happen"
}
```

只有在请求仍处于待处理状态时才可能取消：关闭已经
生效之后（`relaunching`/`verifying`）不能取消，接受该请求的那个进程已经
消失之后也不能取消。当没有任何请求待处理时，该工具会如实说明，而不是报错：

```json
{
  "cancelled": false,
  "detail": "request tool-1780000000000-482913 is not pending (it may have completed, been refused, or never existed)"
}
```

---

## 降级与移除

| 情形 | 会发生什么 |
| --- | --- |
| **未绑定检查点端口**（默认情况） | `capabilities.checkpointPort` 为 `false`，并且在 `safety.checkpointRequired` 为 true 期间，每个请求都会以 `CHECKPOINT_FAILED` 被拒绝。未配置的安装无法重启，这正是有意的默认值：没有端口意味着“无法校验”，也就意味着“不要重启”。 |
| **没有 Supervisor 在运行** | `capabilities.supervisorWatch` 仍会报告该能力，但 `supervisor.present` 为 `false`，请求会以 `SUPERVISOR_ABSENT` 被拒绝。这是刻意为之：在无人重新拉起的情况下退出是一次关闭，而不是重启。 |
| **没有系统关闭端口** | 即使 `allowSystemReboot` 与 `systemRestart.enabled` 都为 true，`capabilities.systemRestart` 仍为 `false`，因此部署方能够看出重启系统是不可能的。应用重启照常工作。 |
| **没有工具运行时或设置服务** | 插件会记录一条警告并继续：`apply` 返回 `toolNames: []`，重启控制仍可通过插件 API 使用。工具和设置命名空间是面向模型的表面，而不是引擎本身。 |
| **卸载插件之后** | DS-Hns 正常运行，只失去自动重启能力。应当删除待处理的 `ticket.json`（`scripts/uninstall.ps1` 会这么做），以免某个 Supervisor 对来自一个已经不在的插件的请求采取行动。审计日志被有意保留。 |
| **在 *Supervisor* 被停止之后** | 对运行中的 DS-Hns 来说没有任何变化，只是无法再观察到重启；插件会继续以 `SUPERVISOR_ABSENT` 拒绝请求。 |

---

## 安全说明

安装之前请先读这一节。

- **安装插件就是在用你的权限运行第三方代码。** DSH 插件是被加载进 Harness 进程的
  普通 Node.js 代码。`dsh-restart` 也不例外：它可以
  读写其状态目录中的文件，并且以与
  DS-Hns 本身相同的权限被加载。git 安装还会在安装时运行本包的 `prepare`
  脚本。
- **本插件包含可以重启你机器的代码。** `WindowsSystemShutdownPort`
  会以 `execFile` 且不经 shell 运行 `shutdown.exe /r /t <delay> /d p:4:1`。只有在
  `allowSystemReboot` **和** `systemRestart.enabled` 同时为 true、且
  请求自身设置了 `acknowledgeSystemReboot: true` 时才会走到它。三道门槛的默认值都是
  **关闭**。不过要准确说明当前状态：在本版本中该端口虽被
  构造并导出，但**请求流水线从不调用它** —— 一个被接受的
  `mode: "system"` 请求会写入一张 `mode: "system"` 的票据，并请求*宿主*关闭。
  见[尚未实现](#尚未实现)。
- **辅助脚本没有沙箱保护。** `scripts/*.ps1` 以你的权限运行，会编辑你
  profile 的 `cordis.patch.yml`、停止 Supervisor 进程并删除票据文件。运行之前
  请先阅读它们；每一个都支持 `-WhatIf`。
- **票据校验和提供的是完整性，而不是身份认证。** 它无需任何共享密钥就能检测出被截断或
  被编辑过的票据。它不能证明是谁写的：任何
  能写入状态目录的东西都能写出一张能通过校验的票据。请
  用文件系统权限保护该目录。
- **`safety.allowRestartWithoutSupervisor: true` 会把被接受的请求变成大概率
  的中断。** 它默认关闭是有原因的。
- **无网络访问。** 插件不发起任何出站连接：它读写
  文件、通过注入的端口调用宿主，并且（为判断 pid 是否存活）
  以 `execFile` 且不经 shell 运行本地的只读进程查询（`tasklist.exe` / `ps`）。

---

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.zh.md](docs/architecture.zh.md) | 双进程全景、信任边界、两个状态机、票据生命周期 |
| [docs/protocol.zh.md](docs/protocol.zh.md) | 线上协议、票据文档、心跳、账本、版本规则，以及一次完整的往返示例 |
| [docs/failure-modes.zh.md](docs/failure-modes.zh.md) | 每种失效模式一节：触发条件、行为、运维人员看到什么、如何恢复 |
| [docs/operations.zh.md](docs/operations.zh.md) | 运行、调优、阅读审计日志、从安全模式恢复、PS 脚本、日志格式、目录布局 |
| [docs/acceptance.zh.md](docs/acceptance.zh.md) | 设计稿中的每一条验收标准到具名测试的映射，以及哪些需要真实的 Windows E2E 运行 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 构建/测试循环，以及不可打破的规则 |
| [SECURITY.md](SECURITY.md) | 威胁模型与负责任披露 |
| [CHANGELOG.md](CHANGELOG.md) | 发布历史 |

## 开发

```powershell
npm install
npm run build              # tsc -p tsconfig.json  -> lib/
npm test                   # build, then node --test tests/*.test.js
npm run test:only          # node --test tests/*.test.js  (no rebuild)
npm run typecheck          # tsc --noEmit
npm run verify:artifacts   # artifact checks against lib/ and bin/
npm run supervisor -- --help
```

`npm test` 会先构建，因此每次测试运行都针对当前的 `src/`。
`verify:artifacts` 断言 `lib/` 是一次可用的构建：入口点暴露
Cordis 契约与库表面，没有任何产出文件仍然导入 `.ts` 说明符，
协议声明随包发布，文档中所述的冷却能够解析，非法配置
与空的 `allowedSources` 会被拒绝，每个 `SELF_REASON_CODES` 值都可用，并且
Supervisor 入口点确实会打印用法。

---

## 常见问题

**这会重启我的机器吗？**
不会，在本版本中不会。那段本该做这件事的代码（`WindowsSystemShutdownPort`）存在并已
导出，它受 `allowSystemReboot` + `systemRestart.enabled` +
`acknowledgeSystemReboot` 三道门槛约束，而它们的默认值都是关闭。但请求流水线从不
调用该端口，所以一个被接受的 `mode: "system"` 请求目前只会产生一张票据和一次
宿主关闭请求，而不是重启。不要指望这个插件去重启任何东西。

**如果 Supervisor 没有运行会怎样？**
什么都不会被重新拉起，而且插件会有意拒绝重启。它会答复
`SUPERVISOR_ABSENT`，而不是让进程退出，因为在无人把它带回来的情况下退出
是一次关闭，而不是重启。请启动 Supervisor（见
[Supervisor](#supervisor)），或者通过设置
`safety.allowRestartWithoutSupervisor: true` 来接受这一取舍。

**为什么我的请求以 `SUPERVISOR_ABSENT` 被拒绝了？**
因为在 `supervisor.heartbeatTimeoutMs`（默认 30 秒）内没有看到任何 Supervisor 心跳。
这项检查依据的是磁盘上 `<state>/heartbeat.json` 的存在时长，因此当 Supervisor
没有运行、已经死掉，或启动时使用的
`--state` 目录与插件所用的不是同一个时，它都会失败。让两者指向同一个目录 —— 这种
不一致是最常见的原因。

**我该如何从安全模式恢复？**
先修复底层的崩溃，然后清除该标志：
`pwsh -File scripts/enable.ps1 -Mechanism SafeMode`，或者编辑 `<state>/ledger.json` 把
`safeMode` 设为 `false`（`enable.ps1` 还会清除 `safeModeReason`/`safeModeAt`，再加上
`-ClearHistory` 则会清空 `uncleanStarts`）。Supervisor 会在启动时读取账本，并在
该标志置位期间停止重新拉起，所以请清除它，并确保 Supervisor
重新运行起来。

**它会保存我的任务吗？**
不会。本插件无法访问任务状态，也从不写入任何任务状态。它通过检查点端口*请求*
Harness 为重启做准备，并且只相信对方的回答；当回答缺失或不安全时
拒绝重启，这正是整个设计的核心。保存与
恢复你工作成果的是 DS-Hns Core。

**模型能通过调用工具来重启机器吗？**
它可以*请求*重启，而该请求会经过每一道检查：来源白名单、
模式门槛、`allowSystemReboot`、请求自身的确认、锁、冷却
以及检查点门槛。工具调用没有特权通道，也无法绕过任何检查。在
本版本中它同样无法造成重启，除非 `systemRestart.enabled`、`allowSystemReboot` 与请求自身的 `acknowledgeSystemReboot` 三者同时成立，且机器上绑定了系统关闭端口。

**为什么在一次重启被接受之后，`restart_status` 会以原因 `RESTART_IN_FLIGHT` 报告
`can_restart: false`？**
因为锁会一直停留在 `SHUTTING_DOWN`，直到该进程真正退出 —— 而
被要求退出的正是这个进程，所以它在余下的整个生命周期里都保持非空闲状态。
这是预期行为，不是锁卡住了。

**为什么明明刚刚才重启过，我的请求还是被拒绝了？**
有三种不同的原因看起来很相似：锁仍被持有（`RESTART_IN_FLIGHT`）、
冷却尚未结束（`COOLDOWN_ACTIVE`）、或者同一个 `requestId` 以
不同内容被重放（`DUPLICATE_REQUEST_ID`）。请阅读 `reason`，而不只是看 `accepted: false`。

**冷却会跨重启被记住吗？**
不会。冷却截止时间存在于接受该次重启的那个进程里，而新进程
启动时没有任何冷却。该上限只在执行该次重启的进程的生命周期内
被强制实施，而不是跨越重启本身。需要跨重启硬性上限的运维方必须
在请求方或包装脚本中实施。见
[尚未实现](#尚未实现)。

**如果检查点端口挂起会怎样？**
门槛会给它 `safety.shutdownTimeoutMs`（默认 90 秒），之后就像对待任何其他
检查点失败一样处理：重启被中止、票据被删除、锁
被释放，调用方得到 `CHECKPOINT_FAILED`。挂起的检查点不会让
锁卡在 `CHECKPOINTING`。

**我能在不破坏 DS-Hns 的情况下卸载它吗？**
可以。这是一项设计要求，而不是一厢情愿：插件注册一个设置
命名空间和三个工具，移除它就会把这一切一并移除。`scripts/uninstall.ps1`
会取消待处理的重启、停止 *Supervisor*（并明确说明这一点）、移除
注册，并保留审计日志。DS-Hns 继续运行，只是少了自动重启。

---

## 尚未实现

直白地列出来，免得有人必须去读源码才能发现它们。每一条都是与
设计稿的偏差：

- **系统重启已接线，并且有三重门禁。** 被接受的 `mode: "system"` 请求在写完 ticket 之后会调用
  系统关闭端口；没有该端口的机器会直接拒绝请求，而不是把它悄悄降级成应用重启。该端口本身在
  不使用 shell 的情况下运行 `shutdown.exe`。
- **挂起的关闭是有界的。** Supervisor 给宿主 `safety.shutdownTimeoutMs` 的时间退出，超时后放弃
  这次重启并记录原因。当 `safety.allowForceTerminate` 打开**且**注入了终止器时，它会改为结束该
  进程并把这次重启记为脏重启。随附的 `bin/supervisor.mjs` 只在该设置打开时注入终止器，因此默认的
  Supervisor 在物理上无法杀死任何东西。
- **`acknowledgeResume` 会被自动调用。** Supervisor 在观察到重新拉起的进程存活的那一刻调用它，
  于是宿主得知自己的 checkpoint 已被消费。确认失败只会被记录，不会致命。
- **重新拉起的重试有节奏控制。** 失败的启动会按 `supervisor.relaunchBackoffMs` 翻倍退避到
  `relaunchBackoffMaxMs` 再重试，与崩溃循环熔断器叠加生效。
- **插件会读取 Supervisor 的账本。** `ledger.json` 的 `safeMode` 标志会被折算进插件自己的
  `CRASH_LOOP` 拒绝中，因此 Supervisor 发现的崩溃循环对那个本来会一直请求重启的进程也是可见的。
- **安全模式只是停止自动化；它不会启动一个降级的 DS-Hns。** 设计稿
  描述的安全模式是不带重启插件自动化地启动 DS-Hns。而
  Supervisor 实际做的是停止重新拉起。如果它是因为进程
  已经消失才让熔断器跳闸，DS-Hns 会一直停着，直到有人来启动它 —— 日志行“DS-Hns 仍在
  运行”只对 DS-Hns 还活着而问题出在*插件*的情形才是准确的。
- **插件不会启动 Supervisor。** `spawnSupervisor()` 已导出但从未
  被调用，因此必须由包装脚本、任务计划程序或
  `scripts/install.ps1` 来启动 Supervisor。
- **Supervisor 不读取 profile 配置。** `bin/supervisor.mjs` 调用 `resolveConfig()` 时不带任何覆盖值，因此它始终运行在随附默认值加上它自己的命令行之上。于是，profile 层面对 `supervisor.*` 的调优会改变*插件*的预期（例如它的心跳超时），却不会改变 Supervisor 的行为 —— 这种不一致会表现为虚假的 `SUPERVISOR_ABSENT` 拒绝。请传 `--tick-ms`，或者在两侧都接受默认值。
- **`supervisor.detach` 只是文档性的。** 它被声明、被赋予默认值并被校验，但只有那个从未被调用的 `spawnSupervisor()` 会读取它；真正的重新拉起启动器把 `detached: false` 写死了，所以脱离启动是运维方自己的事。
- **`supervisor.log` 从不轮转。** 它只做追加，会无限增长；只有审计日志会遵守 `storage.maxLogBytes`。
- **`SHUTDOWN_TIMEOUT` 被声明了，但插件从不抛出它。** Supervisor 会把同一条件报告为
  `SHUTDOWN_ABANDONED` 以及自己日志里的 `shutdown_abandoned`，因此插件侧的这个代码仍然是保留项。
- **冷却、重复账本和崩溃循环视图都是按进程的。** 它们都没有
  被持久化，因此没有一个能活过它所约束的那次重启。
- **重新拉起的验证依据是 pid 存活，而不是应用心跳。** 该
  状态名为 `WAITING_FOR_HEARTBEAT`，但它实际检查的是被重新拉起的 pid
  是否存活；唯一的心跳文件是 Supervisor 自己的。
- **本仓库中没有 Windows E2E 证据。** 设计稿的端到端矩阵需要一台
  真机；见 [docs/acceptance.zh.md](docs/acceptance.zh.md)。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。版权所有 (c) 2026 dsh-restart 贡献者。

这是一个**社区插件**。它与 DeepSeek 没有隶属关系，未获其背书，也不受其支持。
“DeepSeek Harness”和“DS-Hns”指本插件所面向的宿主应用；
所有商标归其各自所有者所有。
