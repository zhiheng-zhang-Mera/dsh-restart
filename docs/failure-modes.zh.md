# 失败模式

当 `dsh-restart` 的每一个组成部分发生故障时它会做什么、运维看到什么，以及如何回到可工作的状态。

> **保证。** 本插件被允许产生的最坏结果是**“自动重启不可用”**，而绝不是**“DS-Hns 不可用”**。下面每一节都可以对照这句话来检验：在本插件的失败路径上，没有任何东西会停止、发信号给、修改或阻塞 DS-Hns。

延伸阅读：[`../README.zh.md`](../README.zh.md)、[`architecture.zh.md`](architecture.zh.md)、[`protocol.zh.md`](protocol.zh.md)、[`acceptance.zh.md`](acceptance.zh.md)。

---

## 1. 重启插件崩溃

**触发条件。** 插件模块抛出异常、它的 `apply()` 失败、profile 不再加载它，或者宿主进程在插件处理请求中途死亡。

**预期行为。** 插件生命周期中的任何环节都无法阻止 DS-Hns 启动，也无法让它持续运行：`applyRestart()` 会报告配置问题并沿用随附的默认值继续运行，而 `src/index.ts` 声明了 `inject = []`，所以缺少工具或设置服务同样不会阻塞激活。崩溃的插件只是停止应答——不会写入新票据，也无法再请求新的重启。在票据写入*之后*发生的崩溃会把票据留在磁盘上。

**运维看到什么。** `restart_status` 不再被提供，或者插件的工具消失了。上一个进程留下的票据会在下次启动时被醒目地对账——`dsh-restart: discarded a pending ticket from request tool-1780000000000-482913 (written 2026-06-01T09:00:00.000Z); the previous process did not exit`。从未写入过票据的插件对 Supervisor 而言不可见，Supervisor 只看到一个已经消失的 pid，并把它当作一次普通崩溃处理：

```json
{"timestamp":"2026-06-01T09:00:00.000Z","state":"MONITORING","code":"process_died_without_ticket","message":"pid 4242 is gone","detail":{"failuresInWindow":1,"limit":3}}
```

**如何恢复。**

```powershell
dsh --profile web --dump-config | Select-String dsh-restart  # is it loaded at all?
pwsh -File scripts/install.ps1 -Profile web -WhatIf           # inspect first, change nothing
pwsh -File scripts/install.ps1 -Profile web                   # re-register and verify
Remove-Item -LiteralPath "$env:DSH_HOME\restart\ticket.json" -Force   # only if you will not start the plugin
```

---

## 2. Supervisor 崩溃

**触发条件。** `bin/supervisor.mjs` 退出、被杀死，或者从未被启动过。

**预期行为。** DS-Hns 继续运行。插件通过心跳文件的年龄检测到这一缺席，并拒绝每一个请求，因为在无人重新拉起的情况下退出是关机，而不是重启：

```json
{"accepted":false,"state":"rejected","reason":"SUPERVISOR_ABSENT","detail":"no supervisor heartbeat was seen; set safety.allowRestartWithoutSupervisor = true to restart anyway","requestId":"tool-1780000000000-482913"}
```

阈值是 `supervisor.heartbeatTimeoutMs`（默认 30000 ms），比较基准是心跳自身的 `timestamp`，缺失时回退到文件的 mtime。这条路径上没有任何东西会碰 DS-Hns。

**运维看到什么。** 在宿主一切正常的情况下，状态报告 Supervisor 缺席：`"supervisor": { "present": false, "lastSeenAt": "2026-06-01T08:58:00.000Z", "ageMs": 120000 }`。当它是通过自己的循环退出时，最后一行日志是一次停止，而不是一次崩溃：

```json
{"timestamp":"2026-06-01T09:01:40.000Z","state":"MONITORING","code":"supervisor_stopped","message":"supervisor finished: TICK_LIMIT","detail":{"state":"MONITORING","reason":"TICK_LIMIT","relaunches":1,"safeMode":false}}
```

**如何恢复。** 用**同一个** `--state` 目录和一个显式的 `--pid` 把它重新启动起来，因为分离（detached）启动否则会去监视它自己的父进程：

```powershell
node bin/supervisor.mjs --state "$env:DSH_HOME\restart" --pid 4242 -- node dsh.js --profile web
```

然后通过读取 `heartbeat.json`（`timestamp`、`watchedPid`、`supervisorPid`）来确认它的存在——见 [`operations.zh.md`](operations.zh.md)。

---

## 3. 检查点失败

**触发条件。** 以下任意一种：没有绑定检查点端口而请求需要它（未配置的默认安装）；端口抛出异常；端口没有在 `safety.shutdownTimeoutMs` 内应答；端口应答 `safe: false`；端口应答 `safe: true` 但 `completed: false`。

**预期行为。** 重启被**中止，绝不降级**。票据只在门禁通过之后才写入，因此 Supervisor 永远不可能观察到一张对应于已被拒绝的重启的票据。锁会被释放，该次尝试会被记录。

**运维看到什么。** 真实的 `detail` 字符串：

| 代码 | 观察到的 `detail` |
| --- | --- |
| `CHECKPOINT_FAILED`（无端口） | `no checkpoint port is bound and safety.checkpointRequired is true, so a restart cannot be authorized` |
| `CHECKPOINT_FAILED`（抛出异常） | `restart aborted: prepareForRestart threw: checkpoint subsystem exploded (reason checkpoint_threw)` |
| `CHECKPOINT_REQUIRED` | `restart aborted: harness reports git_commit_in_progress (reason git_commit_in_progress)` |

抛出异常的或不安全的检查点会应答 `{"accepted": false, "state": "failed", ...}`；无端口的情况应答 `"state": "rejected"`。无论哪种情况，拒绝都会进入审计日志：

```json
{"schemaVersion":1,"kind":"restart-attempt","record":{"requestId":"req-from-nowhere","ticketId":null,"mode":"application","source":"some-random-app","reasonCode":"OPERATOR_REQUEST","state":"rejected","startedAt":"2026-06-01T09:00:00.000Z","finishedAt":"2026-06-01T09:00:00.000Z","detail":"source \"some-random-app\" is not allowed; allowed sources: dsh-health-scheduler, dsh-cli, operator","clean":true,"outcomeCode":"UNKNOWN_SOURCE"}}
```

**如何恢复。** 绑定一个真实的检查点端口（进程内 harness 用 `FunctionCheckpointPort`，只能发布就绪文档的宿主用 `FileCheckpointPort`），或者——仅当该部署确实没有可达的安全点时——设置 `safety.checkpointRequired: false`。不要仅仅为了让一个拒绝消失就削弱它；见 [`operations.zh.md`](operations.zh.md)。

---

## 4. 优雅关闭挂起

**触发条件。** 宿主接受了优雅关闭请求，但永不退出。

**预期行为——以及它的真实状态。** 这种情况是**半实现**的，而且两半并不相同。

*插件这一半是正确的。* `RestartManager` 从不等待自己的退出：它写入票据、请求关闭、记录 `state: "shutting_down"` / `outcomeCode: "ACCEPTED"`，然后返回。挂起的宿主无法让插件死锁。

*Supervisor 这一半没有截止时间。* `WAITING_FOR_EXIT` 轮询存活状态，并在每一个 tick 上永远返回 `{state: "WAITING_FOR_EXIT", reason: "WAITING"}`。设计稿要求的是 `等待 timeout → supervisor policy → 可选 force terminate → 记录 dirty restart`；这些一个都不存在：

- `safety.allowForceTerminate` 被**校验但从未被任何代码路径读取**，所以把它设为 true 不会带来任何改变。
- `WAITING_FOR_EXIT` 上**没有超时**，并且在任何地方都**没有写入“dirty restart”记录**。
- `safety.shutdownTimeoutMs` 不是监视宿主退出的看门狗；在实现中，它只是**检查点**调用的预算。

**运维看到什么。** 被接受的票据，然后就只剩心跳：

```json
{"timestamp":"2026-06-01T09:00:05.000Z","state":"WAITING_FOR_EXIT","code":"restart_ticket_accepted","message":"restart_ticket_accepted","detail":{"ticketId":"application-1780304400000-1-e2efb725","mode":"application","pid":4242}}
```

与此同时，插件报告锁被持有，并拒绝第二次尝试——`{"accepted":false,"state":"rejected","reason":"RESTART_IN_FLIGHT","detail":"another restart is already in progress","requestId":"tool-1780000300000-119284"}`。

**如何恢复。** 双方都不会终止任何东西，所以解决这个挂起是本插件之外的人工操作：修好阻塞宿主退出的任何问题，或者手动终止宿主进程。一旦 pid 真正消失，Supervisor 就会清除票据并自行重新拉起——不需要重启 Supervisor——并记录 `{"timestamp":"2026-06-01T09:00:05.000Z","state":"RELAUNCHING","code":"relaunching","message":"relaunching","detail":{"reason":"expected_exit_observed"}}`。

---

## 5. 重启后没有心跳

**触发条件。** Supervisor 重新拉起了 DS-Hns，但当 `supervisor.relaunchTimeoutMs`（默认 90000 ms）到期时，该 pid 并不存活。

**预期行为。** Supervisor 会重试，受崩溃循环断路器的约束，然后停止重新拉起并进入安全模式。它绝不会永远重新拉起。

**运维看到什么。** 真实的演进过程，每行一个 JSON 对象：

```json
{"timestamp":"2026-06-01T09:00:00.000Z","state":"WAITING_FOR_HEARTBEAT","code":"relaunched","message":"relaunched","detail":{"pid":20002}}
{"timestamp":"2026-06-01T09:01:40.000Z","state":"WAITING_FOR_HEARTBEAT","code":"relaunch_verification_failed","message":"the relaunched process is not alive","detail":{"failuresInWindow":2,"limit":3}}
{"timestamp":"2026-06-01T09:01:40.000Z","state":"RELAUNCHING","code":"relaunching","message":"relaunching","detail":{"reason":"relaunch_retry"}}
{"timestamp":"2026-06-01T09:03:20.000Z","state":"CRASH_LOOP","code":"crash_loop_limit_reached","message":"crash_loop_limit_reached","detail":{"failuresInWindow":3}}
{"timestamp":"2026-06-01T09:03:20.000Z","state":"SAFE_MODE","code":"safe_mode_entered","message":"safe_mode_entered","detail":{"reason":"no_liveness_after_relaunch","relaunches":2}}
```

每个 tick 的结果依次为——
`[{"state":"WAITING_FOR_HEARTBEAT","reason":"RELAUNCHED","relaunches":1,"safeMode":false}, {"state":"WAITING_FOR_HEARTBEAT","reason":"RELAUNCHED","relaunches":2,"safeMode":false}, {"state":"SAFE_MODE","reason":"CRASH_LOOP","relaunches":2,"safeMode":true}]`
——并持久化为一个账本，断路器在其中得以存续：

```json
{
  "schemaVersion": 1,
  "uncleanStarts": [
    { "at": "2026-06-01T09:00:00.000Z", "reason": "process_died_without_ticket" },
    { "at": "2026-06-01T09:01:40.000Z", "reason": "no_liveness_after_relaunch" },
    { "at": "2026-06-01T09:03:20.000Z", "reason": "no_liveness_after_relaunch" }
  ],
  "safeMode": true,
  "safeModeReason": "no_liveness_after_relaunch",
  "safeModeAt": "2026-06-01T09:03:20.000Z",
  "relaunches": 2
}
```

进程以退出码 **3** 结束，并打印那一行人工操作提示：

```text
automation is disabled; DS-Hns still runs. Fix the underlying problem, then delete the safeMode flag in ledger.json (or run scripts/enable.ps1) to restore automatic restart.
```

这句话只有在 DS-Hns 处于运行状态、且问题出在插件上时才成立：安全模式只是停止重新拉起，它并不会启动一个降级的 DS-Hns。

**如何恢复。** 先修好底层的启动失败，然后清除标志并重启 Supervisor。清除安全模式**不会**启动它。

```powershell
pwsh -File scripts/enable.ps1 -Mechanism SafeMode -ClearHistory
node bin/supervisor.mjs --state "$env:DSH_HOME\restart" --pid 4242 -- node dsh.js --profile web
```

还有两点值得说明：**没有退避曲线**——每次重试都恰好等待一个 `relaunchTimeoutMs`，唯一的约束是断路器——并且断路器的*状态*是持久化的，而插件自己的计数器不是；见[案例 6](#6-重启请求风暴)。

---

## 6. 重启请求风暴

**触发条件。** 一个请求方激进地重试、调度器反复触发，或者多个来源同时请求重启。

**预期行为。** 四道相互独立的防线，按此顺序：形状校验、重复抑制、排他锁，然后是冷却。

**运维看到什么。** 下面每一个拒绝代码及其真实的 `detail`：

| 代码 | 观察到的 `detail` |
| --- | --- |
| `DUPLICATE_REQUEST_ID`（完全相同的重试） | **原样返回的第一个应答**——`accepted: true`、`state: "shutting_down"`、`ticketId: "application-1780304400000-1-ef102451"`——并且不会有第二次重启 |
| `DUPLICATE_REQUEST_ID`（相同 id、新内容） | `request id req-1 was already used for a different request` |
| `RESTART_IN_FLIGHT` | `another restart is already in progress` |
| `COOLDOWN_ACTIVE` | `application restart is in cooldown for another 600s (minimum interval 1200s)` |

**如何恢复。** 通常什么都不用做：冷却会过期，下一个合法请求会被接受。`restart_status` 会显示它正在消退——`"application": { "nextAllowedAt": "2026-06-01T09:20:00.000Z", "remainingMs": 900000, "minimumIntervalMs": 1200000 }`——而冷却表本身在 [`operations.zh.md`](operations.zh.md) 中。

**关键注意事项。** 冷却截止时间、去重账本和崩溃循环视图都是 **`RestartManager` 中的每进程内存状态**，并且**不会**在它们所把关的那次重启中存续：新进程启动时 `cooldownUntil = 0`、`seen` 映射为空（上限 200 条）、断路器也未跳闸。得以存续的是 Supervisor 的账本，Supervisor 会在启动时把它读回来。

---

## 7. 无法通过校验的票据

**触发条件。** `ticket.json` 存在但校验失败：`missing`、`schema_version`、`checksum`、`expired`、`malformed` 或 `wrong_pid`。

**预期行为。** 可疑的票据是危险，而不是提示。Supervisor 会删除它并继续监视，而不是据此行动，同时记录 `{"timestamp":"2026-06-01T09:00:05.000Z","state":"MONITORING","code":"discarded_unverifiable_ticket","message":"<verification detail>","detail":{"rejection":"checksum"}}`。插件在启动时的行为相同：`reconcileAfterRestart()` 会丢弃它发现的任何票据并报告原因。

**运维看到什么。** 因校验和漂移而被拒绝的票据是可读的；它的 `checksum` 只是不再覆盖其内容：

```json
{
  "schemaVersion": 1,
  "ticketId": "application-1780304400000-1-e2efb725",
  "requestId": "tool-1780000000000-482913",
  "mode": "application",
  "reasonCode": "RUNTIME_PRESSURE",
  "pid": 4242,
  "createdAt": "2026-06-01T09:00:00.000Z",
  "expiresAt": "2026-06-01T09:10:00.000Z",
  "cleanShutdown": true,
  "checkpointId": "ck-2026-06-01T09-00-00",
  "checksum": "sha256:3e6ffa34cad2551ac4fab178509303a86573f8aa33dc8cbfae53404af47f06ea"
}
```

**如何恢复。** 无需恢复：丢弃它*就是*正确的结果，审计轨迹不受影响。如果票据持续校验失败，就要怀疑状态目录里有一个外部写入者，或者时钟偏移越过了 `expiresAt`（默认 `supervisor.ticketTtlMs` = 十分钟）。

**一个通过阅读代码发现——而非复现——的缺口。** 票据写入失败之后，`RestartManager.abort()` 会在释放锁**之前**调用 `clearTicket()`。如果票据既无法写入也无法删除——在 Windows 上，一个外部进程持有 `ticket.json` 打开是可能的原因——`clearTicket()` 会抛出异常，该异常逃出 `handle()`，不写入任何审计记录，锁也永远不会被释放。调用方看到的是抛出的异常，而不是结构化响应，随后的一次请求会以 `RESTART_IN_FLIGHT` 被拒绝。这是一个读代码得出的观察，而不是一次复现。把没有对应审计行的 `RESTART_IN_FLIGHT` 拒绝当作这一特征。

---

## 8. 状态目录不可写

**触发条件。** 由 `--state`（Supervisor）或 `options.stateDirectory` / `storage.directory`（插件）指定的目录无法创建、是只读的，或者位于已写满的卷上。

**预期行为。** 每一次写入都失败关闭（fail closed），并且不会向宿主抛出任何东西。Supervisor 以退出码 **2** 拒绝启动；插件以 `TICKET_WRITE_FAILED` 中止；审计日志吞掉自身的失败并把它计入。

**运维看到什么。** 在 Supervisor 启动时，在 stderr 上，退出码 2：`supervisor: cannot create state directory <dir>: <error message>`。当票据无法写入时，来自插件的是：

```json
{"accepted":false,"state":"failed","reason":"TICKET_WRITE_FAILED","detail":"restart aborted: could not write the restart ticket (<error message>)","requestId":"tool-1780000000000-482913","ticketId":"application-1780304400000-1-2c1a9f33"}
```

心跳写入器和 `supervisor.log` 写入器按设计都会吞掉自己的错误，因此可观察到的症状是**沉默**：没有新的 `heartbeat.json`，没有新的日志行，随后插件就会报告 Supervisor 缺席。

**如何恢复。**

```powershell
Set-Content -LiteralPath "$env:DSH_HOME\restart\writetest.tmp" -Value ok   # prove writability first
Remove-Item -LiteralPath "$env:DSH_HOME\restart\writetest.tmp" -Force
pwsh -File scripts/install.ps1 -Profile web -StateDirectory 'D:\DS-Hns\data\restart'
node bin/supervisor.mjs --state D:\DS-Hns\data\restart --pid 4242 -- node dsh.js --profile web
```

**关键注意事项。** 插件和 Supervisor 必须指定*同一个*目录——插件默认为 `<DSH_HOME>\restart`，Supervisor 使用 `--state`，否则也是 `<DSH_HOME>\restart`（回退到 `./.dsh-restart`）。把 `-StateDirectory` 传给某个脚本**不会**把它传播进 profile，所以要么在 profile 中设置 `storage.directory`，*要么*把 `--state` 传给 Supervisor，并让二者保持一致。不匹配看起来和“没有 Supervisor 心跳”一模一样，并且是神秘的 `SUPERVISOR_ABSENT` 最可能的原因。另请注意，`RestartAuditLog` 会跟踪 `writeFailures` 和 `lastError`，但在本次发布中，二者都没有在 `restart_status` 中暴露出来。

---

## 9. 配置在加载时被拒绝

**触发条件。** profile 的配置文档无法被强制执行——类型错误、非正的时长、跨字段矛盾，或者 `allowedSources` 为空。

**预期行为。** 插件**不会让宿主的启动失败**。它记录问题并沿用随附的默认值继续运行；Supervisor 记录问题并以非零码退出，而不是在边界未知的情况下进行监视。

```text
dsh-restart: configuration was rejected (<config error>); continuing with the shipped defaults. Fix the offending value and reload the profile to activate it.
```

**运维看到什么。** 确切的消息：

```text
ConfigError: dsh-restart config: supervisor.heartbeatTimeoutMs must exceed supervisor.heartbeatIntervalMs (60000), received 30000
ConfigError: dsh-restart config: allowedSources must list at least one source; an empty list would refuse every request, including an operator request
ConfigError: dsh-restart config: allowedPriorities[] unknown priority "urgent"; known: low, normal, high, emergency
ConfigError: dsh-restart config: applicationRestart.minIntervalMs must be >= 0, received -1
ConfigError: dsh-restart config: enabled must be a boolean, received "yes"
```

最后一条值得警惕：`tryResolveConfig({ enabled: 'yes' })` 会报告错误，并**回退到 `enabled: true`**。因此一个笔误可能让重启保持武装状态，而不是解除武装——与作者的意图正好相反。

**如何恢复。** 修好 profile 补丁中被点名的那条点号路径，然后重新加载 profile。设置变更会被校验，但**不会被热替换**：运行中的进程保持它启动时的边界，新文档在下一次 profile 加载时生效。可以在不启动宿主的情况下用 `node -e "import('./lib/index.js').then(m => console.log(m.resolveConfig()))"` 或 `npm run verify:artifacts` 检查。

**一个值得了解的分歧。** `bin/supervisor.mjs` 调用 `resolveConfig({})`——它从不读取 profile 的插件配置。在从 CLI 启动的 Supervisor 内部，`supervisor.launchCommand`、`launchArgs`、`launchCwd`、`heartbeatIntervalMs`、`relaunchTimeoutMs`、`pollIntervalMs`、`ticketTtlMs` 和 `crashLoopLimit` 全都处于**随附默认值**，无论 profile 怎么说。用 `--` 传入启动命令并接受这些默认值；profile 目前无法调整 Supervisor。

---

## 10. 无法推导重新拉起命令 / 重新拉起失败

**触发条件。** Supervisor 需要重新拉起，但要么无法弄清*要启动什么*，要么启动本身失败（路径错误、缺少解释器、权限被拒绝）。

**预期行为。** 两者都是终局性的，且都不会循环。缺少命令时会不启动任何东西就进入安全模式；启动失败会计入崩溃循环断路器，要么重试一次，要么让断路器跳闸。

**运维看到什么。** 完全没有命令：

```json
{"timestamp":"2026-06-01T09:00:05.000Z","state":"RELAUNCHING","code":"no_launch_command","message":"cannot relaunch: no launch command could be derived"}
```

这会设置 `SAFE_MODE` 并返回 `{"state":"SAFE_MODE","reason":"NO_LAUNCH_COMMAND",...}`。一次失败的启动：

```json
{"timestamp":"2026-06-01T09:00:05.000Z","state":"RELAUNCHING","code":"relaunch_failed","message":"spawn failed: spawn <file> ENOENT","detail":{"failuresInWindow":1}}
```

随后，在断路器还允许再一次尝试时是 `{"state":"RELAUNCHING","reason":"RELAUNCH_FAILED",...}`，不允许时则是 `CRASH_LOOP` → `SAFE_MODE`。

**如何恢复。** 始终在 `--` 之后把命令显式地交给 Supervisor：

```powershell
node bin/supervisor.mjs --state "$env:DSH_HOME\restart" --pid 4242 -- node "D:\DS-Hns\app\dsh.js" --profile web
```

没有 `--` 时，`deriveLaunchSpec()` 会回退到 Supervisor 自己的 `argv`，也就是 `bin/supervisor.mjs` 本身——Supervisor 会重新拉起*它自己*，而不是 DS-Hns。这一点已经过验证，并且是本文档中最重要的部署注意事项；见 [`operations.zh.md`](operations.zh.md)。

---

## 尚未实现

设计稿规定、但本次发布**未**实现的行为。这里没有任何一项是半开的：每一项都只是不存在，上面的各节说明了取而代之会发生什么。

| 设计项 | 本次发布中的状态 | 后果 |
| --- | --- | --- |
| 系统重启（`SystemShutdownPort.requestSystemRestart`） | 已实现、已导出且可单元测试，但**从未被** `RestartManager` **调用**，后者读取该端口只是为了报告 `capabilities.systemRestart` | 一个被接受的 `mode: "system"` 请求会写入一张 `mode: "system"` 票据，并要求*宿主*关闭；机器永远不会重启，而 Supervisor 会像对待任何其他票据一样重新拉起该应用 |
| 流水线中的 `CheckpointPort.acknowledgeResume` | 在端口和 `CheckpointGate` 上已实现，但**从未被** `RestartManager` **调用** | 设计中的“确认恢复”步骤不会自动发生 |
| `safety.allowForceTerminate` | 由 `resolveConfig()` 校验，但**从未被读取** | 把它设为 true 不会带来任何改变；案例 4 会挂起 |
| `WAITING_FOR_EXIT` 上的截止时间，以及一条“dirty restart”记录 | 两者都不存在；tick 永远返回 `reason: "WAITING"` | 挂起的宿主会被无限期等待，且没有任何关于它的结构化证据 |
| Supervisor 读取 profile 配置 | `bin/supervisor.mjs` 调用 `resolveConfig({})` | profile 层面的 Supervisor 调优没有任何效果 |
| `supervisor.detach` | 已校验，但**从未被读取**；`ChildProcessLauncher` 硬编码 `detached: false` | 该配置键只存在于文档中 |
| 退避曲线；持久化的冷却/去重计数器 | 平坦的 `relaunchTimeoutMs`；插件的计数器是每进程的 | 节奏不可调优，而且当被把关的进程重启时，这些边界会重置 |
| 安全模式启动一个降级的 DS-Hns | 它**不**启动任何东西；它只是停止重新拉起 | “DS-Hns 仍在运行”只有在 DS-Hns 处于运行状态、且问题出在插件上时才成立 |
| `supervisor.log` 的轮转 | 不存在；它会无界增长 | 只有审计日志遵循 `storage.maxLogBytes` |
