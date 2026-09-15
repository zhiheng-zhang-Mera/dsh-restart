# 协议

共享协议模块（`src/shared/protocol.ts`）**就是契约**。它命名双方达成一致的形状，对一次重启如何执行只字不提，因此请求方——健康调度器、运维脚本、测试装置——可以只依据本文档编写，而不必导入实现。

这里的一切都要跨越进程边界或文件边界：经由插件 API 发出的一次请求及其响应、从插件到 supervisor 的一张票据、从 supervisor 回到插件的一次心跳和一份账本。请求方只需要设计稿所命名的四个入口点——`requestApplicationRestart(request)`、`requestSystemRestart(request)`、`getRestartStatus()`、`cancelPendingRestart(requestId)`——再加上下面这些形状。另见 [README](../README.zh.md) · [architecture.zh.md](architecture.zh.md) · [operations.zh.md](operations.zh.md) · [failure-modes.zh.md](failure-modes.zh.md)。当设计稿与源码不一致时，本文档以源码为准，并在一条 *Divergence* 注记中说明。

## 1. RestartRequest

```ts
type RestartMode = 'application' | 'system'
type RestartPriority = 'low' | 'normal' | 'high' | 'emergency'
type RestartReasonCode = 'RUNTIME_PRESSURE' | 'SYSTEM_PRESSURE' | 'MEMORY_LEAK' | 'THERMAL_STRESS' | 'UI_DEGRADATION'
  | 'COMPUTER_USE_STALL' | 'SCHEDULED_MAINTENANCE' | 'OPERATOR_REQUEST' | 'TEST' | (string & {})  // open vocabulary

interface RestartRequest {
  readonly requestId: string               // requester-chosen and unique; de-duplication keys on this alone
  readonly source: string                  // requesting module id, e.g. 'dsh-health-scheduler'
  readonly mode: RestartMode
  readonly reasonCode: RestartReasonCode   // recorded, never interpreted
  readonly reasonSummary: string           // one line, recorded verbatim, never parsed
  readonly checkpointRequired: boolean     // a required checkpoint that cannot be confirmed aborts the restart
  readonly priority: RestartPriority       // a hint: it never bypasses validation
  readonly createdAt?: string              // ISO-8601 instant the requester created the request
  readonly acknowledgeSystemReboot?: boolean // consulted only for mode 'system'
}
```

`validateShape` 会把它规范化成一个 `NormalizedRequest`，其中每个字段都是必填的：`priority` 默认为 `'normal'`，`createdAt` 默认为 `new Date(0).toISOString()`（纪元时刻，`"1970-01-01T00:00:00.000Z"`），`acknowledgeSystemReboot` 默认为 `false`。形状校验在每次策略检查之前运行，因此一个畸形请求永远不会到达冷却账本、去重映射或写文件的代码。

```json
{ "requestId": "tool-1780000000000-482913", "source": "dsh-cli", "mode": "application",
  "reasonCode": "RUNTIME_PRESSURE",
  "reasonSummary": "pressure_84_gte_app_restart_80, memory_slope_high, maintenance_window_open",
  "checkpointRequired": true, "priority": "normal",
  "createdAt": "2026-06-01T09:05:00.000Z", "acknowledgeSystemReboot": false }
```

`dsh-health-scheduler` 实际发送的请求就是这个形状去掉两个可选字段（采集到的值：`requestId` `hs-1772297190000-1`、同样的 `reasonSummary`、`priority` `normal`）。

<details>
<summary>每一条形状校验拒绝，逐字照录（<code>validateShape</code>）</summary>

| 字段 | 规则 | 失败时确切的 `detail` |
| --- | --- | --- |
| 请求本身 | 一个非 null 对象；数组和原始值都被拒绝 | `request must be an object, received <typeof value>` |
| `requestId` / `source` / `reasonCode` / `reasonSummary` | 字符串，`trim()` 后非空，最长 128 / 64 / 64 / 500 个字符，且不含控制字符 `[\u0000-\u001f\u007f]` | `<field> must be a non-empty string` / `<field> exceeds <max> characters` / `<field> contains control characters` |
| `mode` | 恰好是 `'application'` 或 `'system'` | `mode must be "application" or "system", received "partial"` |
| `checkpointRequired` | 真正的布尔值——不做真值强制转换 | `checkpointRequired must be a boolean` |
| `priority` | `low`、`normal`、`high` 或 `emergency`；省略即表示 `normal` | `priority must be low, normal, high or emergency, received "urgent"` |
| `createdAt` | 存在时必须是字符串 | `createdAt must be an ISO-8601 string when present` |
| `acknowledgeSystemReboot` | 存在时必须是布尔值 | `acknowledgeSystemReboot must be a boolean when present` |

每个字符串都是**被 trim 而不是被拒绝**（`"  dsh-health-scheduler  "` 变成 `dsh-health-scheduler`），在期望字符串的位置给出数字或对象会像字段缺失一样校验失败，而这些边界是防止日志注入的边界，不是业务规则。`createdAt` 只做类型检查：它的内容从不被解析、比较或使用——它不影响过期（票据的 `expiresAt` 是接受时刻加上 `supervisor.ticketTtlMs`），也不会被带入票据。
</details>

**Divergence（设计稿 §10）。** 设计稿的 `RestartRequest` 是 `{ requestId, mode, reasonCode, priority, checkpointRequired }`，其中 `priority: "normal" | "high" | "emergency"`，并且它的 JSON 草图使用 snake_case 键（`request_id`、`reason_code`、`checkpoint_required`）。实现则**要求 `source` 和 `reasonSummary`**，增加了可选的 `createdAt` 和 `acknowledgeSystemReboot`，在线协议上使用 camelCase，并且它的优先级词汇表**包含 `low`**——设计稿的联合类型没有它，而 `DEFAULT_CONFIG.allowedPriorities` 列出了全部四种。只有面向模型的工具参数是 snake_case；那是工具调用界面，不是线协议。

## 2. RestartResponse

```ts
type RestartRequestState = 'rejected' | 'queued' | 'checkpointing' | 'shutting_down' | 'relaunching'
  | 'verifying' | 'completed' | 'failed' | 'cancelled'

interface RestartResponse {
  readonly accepted: boolean   // whether the request was accepted and is (or was) being carried out
  readonly state: RestartRequestState
  readonly reason?: string     // machine-readable rejection or failure code; absent when accepted
  readonly detail: string      // human-readable explanation, safe to log and to show
  readonly requestId: string   // echoed so a caller can correlate
  readonly ticketId?: string   // present when a ticket was written
}
```

一次被接受的 application 重启，由真实流水线产生：

```json
{ "accepted": true, "state": "shutting_down",
  "detail": "application restart accepted: the host is shutting down and the supervisor will relaunch it",
  "requestId": "tool-1780000000000-482913", "ticketId": "application-1780304700000-1-2dca85a9" }
```

在任何东西被写入之前发出的拒绝具有相同的形状，只是没有 `ticketId`——例如 `reason: "SUPERVISOR_ABSENT"`，detail 为 `no supervisor heartbeat was seen; set safety.allowRestartWithoutSupervisor = true to restart anyway`。票据写入之后发生的中止会向 `state: "failed"` 添加 `ticketId`（它写入过、随后删除的那个 id）。对于 `mode: "system"`，被接受时的 detail 是 `system restart accepted: the machine will reboot and the supervisor will relaunch DS-Hns`。

### 哪些状态实际上会被产生，以及在哪里产生

| 状态 | 由谁产生 | 说明 |
| --- | --- | --- |
| `rejected` | `refuse()`：形状失败、策略失败、同一 id 但内容不同的重放、非法的锁边 | `reason` 是下表中的一个代码；不存在票据 |
| `shutting_down` | 被接受的响应，在票据写入且宿主接受了关闭请求之后 | 调用方唯一能看到的成功状态 |
| `failed` | `abort()`：被中止的检查点、票据写入失败、被拒绝或抛错的关闭端口 | 在返回应答之前，票据已被删除、锁已被释放 |
| `queued` | 从不返回。进行中的请求从这里开始，它作为 `status.active.state` 可见 | `RestartLock` 把 `REQUESTED → 'queued'` |
| `checkpointing` | 从不返回。在门控运行期间作为 `status.active.state` 可见 | `RestartLock` 把 `CHECKPOINTING → 'checkpointing'` |
| `cancelled` | 从不返回。它是一个**审计**状态：`cancelPendingRestart()` 返回一个裸布尔值，而 `restart_cancel` 返回 `{ "cancelled": …, "detail": … }` | 审计记录以 `state: 'cancelled'`、`outcomeCode: 'CANCELLED'` 写入 |
| `relaunching` | 从不产生：插件从不会观察到重新拉起，它理应已经消失 | 锁声明了它，`cancelPendingRestart()` 以它为守卫；没有任何代码设置它 |
| `verifying` | 从不产生，同上 | — |
| `completed` | 从不产生；它是 `RestartLock` 对 `IDLE` 的投影 | 结果会在审计日志和下一个进程的对账中浮现 |

在 `rejected` 之下，代码有 `INVALID_REQUEST`（形状失败，或者 `priority` 合法但不在 `allowedPriorities` 中：`priority normal is not accepted by this deployment`）、`DISABLED`、`UNKNOWN_SOURCE`、`MODE_NOT_ALLOWED`、`SYSTEM_REBOOT_NOT_PERMITTED`、`CRASH_LOOP`、`DUPLICATE_REQUEST_ID`（该 id 被复用于**不同**内容）、`RESTART_IN_FLIGHT`（锁不处于 `IDLE`；如果改为拒绝 `transition('REQUESTED')`，detail 就是锁的 `illegal restart lock transition …; allowed: …`）、`COOLDOWN_ACTIVE`（detail 报告向上取整的剩余秒数和最小间隔）、`CHECKPOINT_FAILED`（没有绑定检查点端口**并且** `safety.checkpointRequired` 为 true，这是任何执行之前的策略拒绝）以及 `SUPERVISOR_ABSENT`。在 `failed` 之下，它们是 `CHECKPOINT_FAILED`（端口抛错，或者回答了 `safe: true` 却带 `completed: false`）、`CHECKPOINT_REQUIRED`（harness 报告了 `safe: false`，例如 `git_commit_in_progress`）、`TICKET_WRITE_FAILED`（`restart aborted: could not write the restart ticket (<message>)`）以及 `SHUTDOWN_PORT_UNAVAILABLE`。因此 `CHECKPOINT_FAILED` 会出现在**两个状态**中：要读 `state`，而不只是读 `reason`。

门控是 `authorized = checkpointRequired ? (outcome.safe && outcome.completed) : true`，预算为 `safety.shutdownTimeoutMs`（90 秒）：当 `checkpointRequired: false` 时，即使端口抛错或回答不安全，重启也会继续；而一个从不回答的端口会被放弃，而不是把锁挂死。

`reason` 是 `string`，不是封闭联合类型：对已知代码分支处理，并把未知代码当作“被拒绝或被中止，读 `detail`”。每一次策略拒绝、中止和接受都会按 `requestId` 记住（最近 200 条，仅存内存），因此完全相同的重放会返回**第一次的响应原文**，包括它原本的 `ticketId`。插件自己的代码在 [§9](#9-self_reason_codes) 中；拒绝的 detail 在 [README](../README.zh.md#every-refusal-code) 中列成表格。

**Divergence（设计稿 §10）。** 设计稿的联合类型是 `rejected | queued | checkpointing | restarting | verifying | completed | failed`，并且它的接口只有 `accepted`、`state` 和一个可选的 `reason`。实现**没有 `restarting`**：它命名的两个状态是 `shutting_down`（被接受时的应答）和 `relaunching`（已声明，从未到达）。它增加了 `cancelled` 以及三个字段 `detail`、`requestId` 和 `ticketId`。当涉及某个响应时，把 `restarting` 读作 `shutting_down`。

## 3. RestartStatus

`getRestartStatus()` 返回全貌；`statusPayload()` 把它投影到工具打印所用的 snake_case 名称上，而工具将它作为 JSON **字符串**返回（`JSON.stringify(payload, null, 2)`）。

```ts
interface RestartStatus {
  readonly timestamp: string           // ISO-8601 instant the status was read
  readonly enabled: boolean            // config.enabled
  readonly lock: RestartLockState      // IDLE | REQUESTED | CHECKPOINTING | SHUTTING_DOWN | RELAUNCHING | VERIFYING
  readonly active: RestartActiveRequest | null
  readonly canRestart: { readonly allowed: boolean; readonly reason: string }
  readonly cooldowns: { readonly application: CooldownState; readonly system: CooldownState }
  readonly recent: readonly RestartAttemptRecord[]   // newest first, bounded by storage.maxRecentAttempts
  readonly crashLoop: CrashLoopState
  readonly supervisor: SupervisorPresence
  readonly capabilities: { readonly applicationRestart: boolean; readonly systemRestart: boolean
    readonly checkpointPort: boolean; readonly shutdownPort: boolean; readonly supervisorWatch: boolean }
}
```

投影只重命名三个名字；`timestamp`、`enabled`、`lock`、`active`、`cooldowns`、`supervisor`、`capabilities`、`recent` 以及所有嵌套项（`crash_loop.tripped`、`cooldowns.application.minimumIntervalMs`、`supervisor.lastSeenAt`、`capabilities.applicationRestart`、`recent[].outcomeCode`）都保留它们的 camelCase 名称。

| `RestartStatus` | 工具负载（`statusPayload()`） |
| --- | --- |
| `canRestart.allowed` | `can_restart` |
| `canRestart.reason` | `can_restart_reason` |
| `crashLoop` | `crash_loop` |

一个真实负载，来自一个全新进程，带有存活的心跳和已绑定的检查点端口（为宽度而折行；工具打印的是完全展开的形式）。在一次被接受的重启之后，`lock` 是 `SHUTTING_DOWN`，`can_restart` 是 `false` 且 `can_restart_reason` 为 `RESTART_IN_FLIGHT`，`active` 持有处于 `shutting_down` 状态的请求，该模式的冷却已被填入，而 `recent[0]` 就是那次被接受的尝试：

```json
{
  "timestamp": "2026-06-01T09:05:00.000Z", "enabled": true, "lock": "IDLE",
  "can_restart": true, "can_restart_reason": "OK", "active": null,
  "cooldowns": { "application": { "nextAllowedAt": null, "remainingMs": 0, "minimumIntervalMs": 1200000 },
    "system": { "nextAllowedAt": null, "remainingMs": 0, "minimumIntervalMs": 3600000 } },
  "crash_loop": { "tripped": false, "failuresInWindow": 0, "limit": 3, "windowMs": 600000, "trippedAt": null, "reason": null },
  "supervisor": { "present": true, "lastSeenAt": "2026-06-01T09:05:00.000Z", "ageMs": 0 },
  "capabilities": { "applicationRestart": true, "systemRestart": false, "checkpointPort": true, "shutdownPort": true, "supervisorWatch": true },
  "recent": []
}
```

<details>
<summary>每个字段的含义，包括那些名不副实的字段</summary>

| 字段 | 含义 |
| --- | --- |
| `active` | 进行中的请求：`requestId`、`ticketId`、`source`、`mode`、`reasonCode`、`priority`、`state`、`createdAt`、`updatedAt`、`attempts`（只有当宿主接受了关闭时它才变成 1） |
| `canRestart.reason` | 按顺序取第一个适用的：`DISABLED`、`CRASH_LOOP`、`RESTART_IN_FLIGHT`、`MODE_NOT_ALLOWED`、`COOLDOWN_ACTIVE`、`SUPERVISOR_ABSENT`、`CHECKPOINT_FAILED`，否则 `OK`；它描述的是 **application** 模式 |
| `cooldowns.<mode>` | `nextAllowedAt`（截止时刻或 `null`）、`remainingMs`（`max(0, deadline - now)`）、`minimumIntervalMs`（默认 application 20 分钟、system 60 分钟） |
| `recent[]` | 最新的在前，仅存内存，受 `storage.maxRecentAttempts`（25）限制；拒绝也会被记录，本版本中 `clean` 始终为 `true`，而 `outcomeCode` 是一个拒绝代码或 `ACCEPTED` / `CANCELLED` |
| `crashLoop` | **插件侧**断路器：`tripped` 只由 `tripCrashLoop()` 设置，不会从 `ledger.json` 读取，而 `failuresInWindow` **不是一次测量**（触发时为 `crashLoopLimit`，否则为 `0`） |
| `supervisor` | `present` 是心跳年龄 ≤ `supervisor.heartbeatTimeoutMs`（见 [§5](#5-the-heartbeat)）；`lastSeenAt` 是 supervisor 写入的 `timestamp`，逐字照录，或 `null`；`ageMs` 是它的年龄，被钳制在 ≥ 0，或当根本没有心跳时为 `null` |
| `capabilities` | `applicationRestart` = `applicationRestart.enabled`；`systemRestart` = `systemRestart.enabled` **并且** `allowSystemReboot` **并且** 已绑定系统关闭端口；`checkpointPort` = 已绑定真实的检查点端口；`shutdownPort` 和 `supervisorWatch` 则**硬编码为 `true`**——“端口已接线”和“插件会监视 supervisor”——所以存活状态请用 `supervisor.present` |

在一次被接受的重启之后，锁在该进程余下的生命周期里一直保持 `SHUTTING_DOWN`（被要求退出的正是这个进程），而冷却截止时刻只存在于接受了这次重启的那个进程中。
</details>

## 4. 票据文档

票据是唯一从插件跨越到 supervisor 的文档，而 supervisor 把任何校验不通过的东西视为危险，而不是线索。

```ts
const TICKET_SCHEMA_VERSION = 1

interface RestartTicket {
  readonly schemaVersion: number        // must equal TICKET_SCHEMA_VERSION
  readonly ticketId: string             // `${mode}-${nowMs}-${sequence}-${uuid8}`
  readonly requestId: string            // the requester's id, for correlation
  readonly mode: RestartMode
  readonly reasonCode: string
  readonly reasonSummary: string
  readonly pid: number                  // the pid the supervisor should watch
  readonly createdAt: string            // ISO-8601, the accept instant
  readonly expiresAt: string            // ISO-8601; nowMs + supervisor.ticketTtlMs (600000 by default)
  readonly cleanShutdown: boolean       // true for every ticket this pipeline writes
  readonly checkpointId: string | null  // the checkpoint the restart was authorised against
  readonly checksum: string             // 'sha256:<hex>' over the canonical JSON of every other field
}
```

该 id 是 `${mode}-${nowMs}-${sequence}-${uuid8}`：模式、以纪元毫秒表示的接受时刻、从 1 开始的每进程单调序列号，以及一个随机 UUID v4 的前 8 个十六进制字符——例如 `application-1780304400000-1-e2efb725` 或 `application-1780304700000-1-2dca85a9`。一个真实的 `ticket.json`：

```json
{ "schemaVersion": 1, "ticketId": "application-1780304700000-1-2dca85a9",
  "requestId": "tool-1780000000000-482913", "mode": "application", "reasonCode": "RUNTIME_PRESSURE",
  "reasonSummary": "pressure_84_gte_app_restart_80, memory_slope_high, maintenance_window_open",
  "pid": 4242, "createdAt": "2026-06-01T09:05:00.000Z", "expiresAt": "2026-06-01T09:15:00.000Z",
  "cleanShutdown": true, "checkpointId": "ck-1",
  "checksum": "sha256:3d0867bab9563554e342324221c093e16ab2c111b2df1005aac66d9209f1cd8f" }
```

**规范化 JSON**（`canonicalJson(value)`）：原始值经由 `JSON.stringify`，其中 `undefined` 变成字面量 `null`；数组逐元素处理并保持顺序（`canonicalJson({ a: [1, { d: 4, c: 3 }] })` 是 `{"a":[1,{"c":3,"d":4}]}`）；对象按键升序排序，值为 `undefined` 的条目被**丢弃**，`null` 被保留（`canonicalJson({ a: 1, b: undefined })` 是 `{"a":1}`）。因此文件中的键顺序无关紧要，校验和是可复现的。

**校验和**：对**除 `checksum` 本身之外**每个字段的 `canonicalJson` 的 UTF-8 字节求 `sha256:<hex>`。`verifyTicket` 解构出 `{ checksum, ...rest }` 并对 `rest` 重新计算，因此事后任何字段的增加、删除或修改都会改变摘要——而且**给票据增加字段是破坏性变更**，需要提升 `TICKET_SCHEMA_VERSION`。**写入**：`writeJsonAtomic` → 同目录的临时文件、`fsync`、`rename` 覆盖 `ticket.json`；两空格缩进、结尾换行、权限 `0600`，所以硬杀之后留下的要么是旧文档、要么是新文档，也不会有临时文件残留。票据只在检查点门控授权了请求之后才写入，而 `checkpointId` 就是门控返回的那个检查点（当请求不要求检查点时为 `null`）。

### 六种校验拒绝

`verifyTicket(candidate, nowMs, expectedPid?)` 返回 `{ valid, ticket, rejection, detail }`。拒绝绝不是修复，调用方会删除校验不通过的东西。生产中只会触发检查 1–5，因为**没有任何生产调用方传入 `expectedPid`**。按求值顺序：

| # | `rejection` | `detail` | 含义 |
| --- | --- | --- | --- |
| 1 | `missing` | `no ticket file` | candidate 是 `null`/`undefined`。对于文件缺失、文件不可读**以及 JSON 无法解析**，`readJson` 都返回 `null`，所以损坏的 `ticket.json` 读出来同样是 *missing* |
| 2 | `malformed` | `ticket is not an object` | 合法 JSON 但不是对象（`"a string"`、`42`、数组） |
| 3 | `schema_version` | `ticket schemaVersion 99 is not 1` | `schemaVersion !== TICKET_SCHEMA_VERSION`：该文档来自另一个版本 |
| 4 | `checksum` | `ticket checksum does not match its contents` | `checksum` 不是字符串，或与重新计算的摘要不同：被截断、被编辑或被篡改的票据 |
| 5 | `expired` | `ticket expired at 2026-06-01T09:15:00.000Z` | `expiresAt <= nowMs`，或者 `expiresAt` 不是有限日期；时钟以读取方为准 |
| 6 | `wrong_pid` | `ticket targets pid 4242, not 9999` | 调用方提供了 `expectedPid`，而票据指向的是另一个进程 |

supervisor 读取票据时不带预期 pid，而是*采纳*票据所指的 pid（`adopted_ticket_pid`、`now watching pid <pid> from ticket <ticketId>`），所以 `wrong_pid` 只能通过直接调用触及，正如测试所做的那样。校验不通过的票据会被销毁：supervisor 清空该文件并以 `{ "rejection": "<one of the six>" }` 记录 `discarded_unverifiable_ticket`，然后继续监视；插件的 `reconcileAfterRestart()` 在启动时运行一次，删除它发现的任何票据——本进程刚刚开始，所以票据只能是遗留物——并报告 `discarded a pending ticket from request <id> (written <createdAt>); the previous process did not exit` 或 `discarded an unusable ticket (<rejection>: <detail>)`。

校验和是**完整性校验，而非身份认证**。没有共享密钥，也没有签名：摘要是在公开的规范化形式上计算的，所以它能发现被截断或被编辑的票据，却不能证明是谁写的。**任何能写入状态目录的东西都能伪造出一张校验通过的票据**，包括校验和、`pid` 和 `expiresAt`。该目录的文件系统权限是信任模型的一部分，而不是一个细节。

## 5. 心跳

```ts
interface SupervisorHeartbeat {
  readonly schemaVersion: number   // always 1 as written by HeartbeatWriter
  readonly supervisorPid: number
  readonly watchedPid: number      // the process the supervisor believes it is watching
  readonly state: SupervisorState  // MONITORING | WAITING_FOR_EXIT | RELAUNCHING | WAITING_FOR_HEARTBEAT
                                   // | VERIFIED | CRASH_LOOP | SAFE_MODE | STOPPED
  readonly timestamp: string       // ISO-8601 instant the beat was written
  readonly sequence: number        // monotonic per writer process, starting at 1
}
```

一个真实的 `heartbeat.json`，在一次校验通过的重新拉起之后写入，以及插件对它施加的规则：

```json
{ "schemaVersion": 1, "supervisorPid": 28868, "watchedPid": 10002,
  "state": "MONITORING", "timestamp": "2026-06-01T09:00:05.000Z", "sequence": 7 }
```

```text
ageMs      = now - Date.parse(heartbeat.timestamp)   // when that field is a parseable string
           = now - mtime(heartbeat.json)             // fallback: no heartbeat, or an unusable timestamp
present    = ageMs !== null && ageMs <= supervisor.heartbeatTimeoutMs
lastSeenAt = heartbeat.timestamp                     // the field, verbatim; null when the file is absent
```

两种年龄都被钳制在 `max(0, …)`，所以来自未来的时间戳读作年龄 `0`，也就是 present。默认值：supervisor 每 `heartbeatIntervalMs`（5 秒）跳一次，并在每次状态变化和被监视 pid 变化时立即跳动；`heartbeatTimeoutMs` 是 30 秒；配置会拒绝一个不超过间隔的超时（`dsh-restart config: supervisor.heartbeatTimeoutMs must exceed supervisor.heartbeatIntervalMs (60000), received 30000`）。

**对研究记录的更正。** 采集到的笔记（以及 README）把 `supervisor.ageMs` 描述为心跳**文件**的年龄，也就是它的 mtime。源码做的恰好相反：`TicketStore.heartbeatAgeMs()` 优先采用 supervisor 写入的 `timestamp` 字段，只在该字段缺失或无法解析时**才作为回退**使用文件 mtime。对于真正要紧的情形，两种读法结果相同——一个停止跳动的 supervisor 留下的文件，其时间戳和 mtime 都不再前进，所以 `present` 会在 `heartbeatTimeoutMs` 内变成 `false`，请求会以 `SUPERVISOR_ABSENT` 被拒绝——但对于一个 mtime 被触碰而时间戳保持陈旧的文件，两条规则结果不同：那种情况读作 **absent**，而不是 present。

## 6. 账本

```ts
interface SupervisorLedger {
  readonly schemaVersion: number
  readonly uncleanStarts: readonly { readonly at: string; readonly reason: string }[]  // newest last
  readonly safeMode: boolean
  readonly safeModeReason: string | null
  readonly safeModeAt: string | null
  readonly relaunches: number
}
```

`emptyLedger()` 返回的恰好是 `{ schemaVersion: 1, uncleanStarts: [], safeMode: false, safeModeReason: null, safeModeAt: null, relaunches: 0 }`。一个真实的 `ledger.json`，在一次干净的 application 重启之后：

```json
{ "schemaVersion": 1, "uncleanStarts": [], "safeMode": false,
  "safeModeReason": null, "safeModeAt": null, "relaunches": 1 }
```

读取方刻意保持宽容：一份读不出来的账本不能阻止 supervisor 去监视。每个字段都被独立强制转换，文件从不被重写或修复。

| 条件 | 结果 |
| --- | --- |
| 文件缺失、不可读、无法解析，或不是对象 | `emptyLedger()` |
| `schemaVersion` 不是数字 | `1` |
| `uncleanStarts` 不是数组 | `[]`（条目按原样使用；断路器会丢弃那些 `at` 无法解析的条目） |
| `safeMode` 不是恰好 `true` | `false` |
| `safeModeReason` / `safeModeAt` 不是字符串 | `null` |
| `relaunches` 不是数字 | `0` |

supervisor 通过同一个原子写入器写入它，并在启动时从它恢复一个已触发的断路器：`safeMode: true` 意味着在操作员清除该标志之前，自动化保持关闭（见 [operations.zh.md](operations.zh.md)）。

**BOM 陷阱。** `JSON.parse` 会拒绝开头的 UTF-8 BOM，`readJson` 吞掉该错误并返回 `null`，因此 `readLedger` 交回一份**空账本**。已针对真实读取方验证：采集到的那份带 BOM 写入的安全模式账本读回来是 `safeMode: false, relaunches: 0`；不带 BOM 写入则读回来是 `safeMode: true, relaunches: 2`。BOM 会静默地重新武装自动重启，而不是报告一个问题，这就是为什么两个写入方都保持无 BOM：`writeJsonAtomic` 写入纯 UTF-8，而 `scripts/*.ps1` 使用 `[System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))`，并带有内联注释 “a BOM makes the file unparseable by the supervisor's reader”。插件自己从不读取 `ledger.json`；安全模式属于 supervisor，而插件的 `CRASH_LOOP` 拒绝则来自 `tripCrashLoop()`。

## 7. 版本规则

| 常量 | 值 | 范围 | 规则 |
| --- | --- | --- | --- |
| `PROTOCOL_VERSION` | `1` | 本文档中的各个形状 | **仅**在破坏性变更时提升。它从包入口点导出，运行时没有任何人比较它：没有协商，请求上也没有版本字段，所以在构建期断言它 |
| `TICKET_SCHEMA_VERSION` | `1` | 按文档，携带在每张票据中 | `schemaVersion` 不同的票据会被**拒绝，绝不迁移**（`rejection: 'schema_version'`、`ticket schemaVersion N is not 1`）；supervisor 删除它，记录 `discarded_unverifiable_ticket`，下一个进程在启动时清掉它 |
| 心跳 `schemaVersion` | `1` | 按文档 | 由 `HeartbeatWriter` 写入；读取方目前不检查它 |
| 审计 `schemaVersion` / `kind` | `1` / `'restart-attempt'` | `restart-attempts.jsonl` 中的每一行 | `readPersisted()` 会忽略版本或 kind 不同的行；硬杀之后写了一半的尾行会被跳过 |

给票据增加字段是**破坏性**变更，而不是增量变更：校验和覆盖所有存在的字段，所以除非提升 schema 版本把它把守起来，否则较新的票据会在较旧的读取方的 `checksum` 检查中失败。

**未知 `reasonCode`。** `RestartReasonCode` 是一个开放联合类型（`… | (string & {})`），校验只检查该代码是一个非空字符串、最长 64 个字符且不含控制字符。一个新代码不需要协议变更，也不需要配置变更，并且会被逐字存入票据和审计记录。不过对于 `config.knownReasonCodes` 要准确：**没有任何代码会把请求的 `reasonCode` 与它比较。** 这个列表（默认九个代码）只在一个地方被读取——用它的前六项加上 `…` 渲染 `restart_request` 工具的描述。它的文档注释里那句“unknown codes are logged, not refused”只对了一半：未知代码当然不会被拒绝，它也不会被按名字记录——它只是被带入票据和审计记录。

**请求方应如何处理未知的 `reason`。** 先对 `state` 分支（先 `accepted`，再 `rejected` / `failed`），然后把 `reason` 当作不透明字符串：[§9](#9-self_reason_codes) 中的代码是插件自己的，`SELF_REASON_CODES` 把每个代码映射到一句面向操作员的话，而该映射之外的任何代码都必须连同它的 `detail` 逐字报告，而不是去解释它或盲目重试。`reason` 被定为 `string` 是刻意的——新的拒绝代码不是协议破坏，而没有 default 分支的请求方会因为它而出问题。

## 8. 完整往返示例

一次 application 重启，从 `requestId` 到重新拉起，使用采集到的值。

1. **请求。** 一个被允许的来源提交 §1 的请求体，其中 `requestId: "tool-1780000000000-482913"`、`mode: "application"`、`checkpointRequired: true`。该部署就是出厂默认值：`applicationRestart.enabled` 为 true 且 `minIntervalMs` 为 1200000，`safety.checkpointRequired` 为 true，并且 supervisor 心跳的年龄为 0 毫秒。
2. **校验、锁、检查点。** `validateShape` 接受并 trim，`validateRequest` 没有发现拒绝，去重映射中也没有该 id 的条目。`RestartLock` 以该 request id 为持有者从 `IDLE → REQUESTED`；活动请求状态变成 `queued`，随后是 `CHECKPOINTING` / `checkpointing`。门控询问已绑定的端口，端口回答 `safe: true, completed: true, checkpointId: 'ck-1'`，于是重启被授权，票据将引用那个检查点。
3. **票据 id 与票据。** 取 `nowMs = 1780304700000`（2026-06-01T09:05:00.000Z）并且是该进程的第一张票据，id 由 `${mode}-${nowMs}-${sequence}-${uuid8}` 得到 `application-1780304700000-1-2dca85a9`；采集到的 supervisor 日志显示了另一次运行中相同的格式，`application-1780304400000-1-e2efb725`。`buildTicket` 写入 [§4](#4-the-ticket-document) 的文档：schema 版本 1、`pid` 4242、`createdAt` 09:05:00.000Z、`expiresAt` 09:15:00.000Z（600000 毫秒的 TTL）、`cleanShutdown: true`、`checkpointId: "ck-1"` 以及匹配的 `sha256:` 校验和。发现它的某次 supervisor tick 会记录 `restart_ticket_accepted`。
4. **关闭请求，然后被接受。** 锁移到 `SHUTTING_DOWN`，活动状态变成 `shutting_down`，插件调用 `shutdown.requestShutdown(ticketId)`——票据 id **就是**关闭原因。采集到的生命周期记录的恰好一次请求是：`["application-1780304700000-1-2dca85a9"]`；拒绝了的宿主，或抛错的端口，会产生 §2 中 `failed` 的响应，而票据已被删除。插件随后把该模式的冷却设为 `nowMs + minIntervalMs`（`nextAllowedAt: "2026-06-01T09:25:00.000Z"`），写审计记录——`outcomeCode: "ACCEPTED"`、`clean: true`、detail `application restart accepted: the host is shutting down and the supervisor will relaunch it (checkpoint ck-1, reason RUNTIME_PRESSURE)`——然后才以 `state: "shutting_down"` 和票据 id 应答接受。在此之后不等待任何东西：等待自己的退出正是重启服务把自己锁死的方式。
5. **进程边界——supervisor。** 等价场景采集到的 `supervisor.log`，按顺序逐字照录：
   ```text
   {"timestamp":"2026-06-01T09:00:05.000Z","state":"MONITORING","code":"supervisor_started","message":"watching pid 4242","detail":{"supervisorPid":28868,"directory":"D:\\DS-Hns\\temp\\docs-sup-ok-lc9Gu6"}}
   {"timestamp":"2026-06-01T09:00:05.000Z","state":"WAITING_FOR_EXIT","code":"restart_ticket_accepted","message":"restart_ticket_accepted","detail":{"ticketId":"application-1780304400000-1-e2efb725","mode":"application","pid":4242}}
   {"timestamp":"2026-06-01T09:00:05.000Z","state":"RELAUNCHING","code":"relaunching","message":"relaunching","detail":{"reason":"expected_exit_observed"}}
   {"timestamp":"2026-06-01T09:00:05.000Z","state":"WAITING_FOR_HEARTBEAT","code":"relaunched","message":"relaunched","detail":{"pid":10002}}
   {"timestamp":"2026-06-01T09:00:05.000Z","state":"VERIFIED","code":"relaunch_verified","message":"relaunch_verified","detail":{"pid":10002}}
   {"timestamp":"2026-06-01T09:00:05.000Z","state":"MONITORING","code":"monitoring_resumed","message":"monitoring_resumed","detail":{"pid":10002}}
   ```
   supervisor 校验了票据，等待被监视的 pid 消失，清掉票据，重新拉起并恢复监视。该次运行以 `{"state":"MONITORING","reason":"TICK_LIMIT","relaunches":1,"safeMode":false}` 和退出码 `0` 结束。
6. **心跳、账本与下一次启动。** 结果通过 [§5](#5-the-heartbeat) 和 [§6](#6-the-ledger) 的文档对插件可见：`heartbeat.json` 带有 `supervisorPid` 28868、`watchedPid` 10002、`state` `MONITORING`、`timestamp` 09:00:05.000Z 和 `sequence` 7；而 `ledger.json` 带有空的 `uncleanStarts`、`safeMode: false` 和 `relaunches: 1`。如果该进程*没有*退出，它的票据仍会在磁盘上，下一个进程的 `reconcileAfterRestart()` 会删除它并报告 `discarded a pending ticket from request tool-1780000000000-482913 (written 2026-06-01T09:05:00.000Z); the previous process did not exit`。

<details>
<summary>以上每个字符串的来源</summary>

- 步骤 1–4 来自真实流水线针对真实状态目录的一次运行（来自 `lib/` 的 `RestartManager` 和 `TicketStore`、出厂默认值、一个回答 `ck-1` 的已绑定检查点端口、一个记录式的宿主生命周期、pid 4242、固定在 `2026-06-01T09:05:00.000Z` 的时钟）。校验和是从规范化字符串独立重新计算的，并且一致。
- 步骤 5 和步骤 6 中的文档是采集到的场景 A 日志、心跳和账本原文。那次采集是同一场景的另一次运行，所以它的票据 id 带有另一个接受时刻和随机后缀（`application-1780304400000-1-e2efb725`），时间戳是 09:00:05 而不是 09:05:00。`pid: 4242` 是两次采集都使用的 harness pid；`10002` 是 supervisor 重新拉起的 pid。
</details>

## 9. SELF_REASON_CODES

插件自己的原因代码，以及每个代码映射到的那句面向操作员的话。这个冻结的、导出的映射是请求方的查找表和文档，不是校验表：各代码路径把普通字符串字面量传给 `refuse()`。

| 代码 | 消息 |
| --- | --- |
| `DUPLICATE_REQUEST_ID` | a request with this id has already been processed |
| `UNKNOWN_SOURCE` | the requesting source is not in the allow list |
| `MODE_NOT_ALLOWED` | this restart mode is disabled by configuration |
| `SYSTEM_REBOOT_NOT_PERMITTED` | system restart requires an explicit permission and acknowledgement |
| `RESTART_IN_FLIGHT` | another restart is already in progress |
| `COOLDOWN_ACTIVE` | the minimum interval for this restart mode has not elapsed |
| `CHECKPOINT_REQUIRED` | this request requires a checkpoint and none was produced |
| `CHECKPOINT_FAILED` | the harness refused to prepare a checkpoint |
| `SHUTDOWN_TIMEOUT` | the process did not exit inside the shutdown budget |
| `SHUTDOWN_PORT_UNAVAILABLE` | no shutdown capability is bound, so a graceful restart is impossible |
| `SUPERVISOR_ABSENT` | no supervisor heartbeat was seen, so a restart could not be observed |
| `CRASH_LOOP` | the crash-loop breaker has disabled automatic restart |
| `INVALID_REQUEST` | the request did not satisfy the protocol |
| `DISABLED` | restart execution is disabled by configuration |

<details>
<summary>映射中<em>没有</em>什么，以及一个没有任何代码路径会引发的条目</summary>

- **`TICKET_WRITE_FAILED` 不在映射中。** 它*确实*会被产生：`RestartManager.abort()` 把它作为 `reason` 返回（状态 `failed`），并把它记录为一个 `outcomeCode`。只在 `SELF_REASON_CODES` 中查代码的请求方会漏掉它——而锁自己的 `RESTART_IN_FLIGHT` detail（`illegal restart lock transition …; allowed: …`）是在一个*确实*在映射中的代码之下的第二句话。
- **`ACCEPTED` 和 `CANCELLED` 根本不是原因代码。** 它们只作为审计日志中的 `RestartAttemptRecord.outcomeCode` 出现（`state: "shutting_down"` / `state: "cancelled"`），从不作为响应的 `reason`。
- **`SHUTDOWN_TIMEOUT` 已声明，但插件从不引发它。** 插件侧没有任何代码路径发出它 —— 插件不等待自己的退出。Supervisor 会把同一条件报告为 `SHUTDOWN_ABANDONED`，要 grep 就用这个名字；Supervisor 自己的 `WAITING_FOR_EXIT` 状态现在受 `safety.shutdownTimeoutMs` 约束。把插件侧这个条目视为保留。
- 映射中的句子不是 `detail` 字符串：响应的 `detail` 是更具体的校验器或中止文本（例如 `no checkpoint port is bound and safety.checkpointRequired is true, so a restart cannot be authorized`），而审计的 `outcomeCode` 就是代码本身。记录代码，引用 detail。
</details>
