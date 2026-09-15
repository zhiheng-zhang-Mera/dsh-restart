# 架构

`dsh-restart` 是两个进程和一个文件。插件位于 DS-Hns 内部，决定一次重启能否被安全地执行；supervisor 位于 DS-Hns 外部，是唯一能把它带回来的东西。它们从不互相调用，从不共享内存，也从不持有套接字：所有跨越边界的东西都是磁盘上的一份文档，由一方写入、另一方校验。

这种形态不是实现细节。正是它让插件可以死去而不把宿主一起带走，也正是它让一次重启能够比请求它的那个进程活得更久。

---

## 1. 双进程结构

```
┌─────────────────────────────────────────── DS-Hns process ──┐
│                                                              │
│  requester ──► RestartManager                                │
│  (health-scheduler, dsh-cli, operator)                       │
│                     │                                        │
│    validateShape ───┤                                        │
│    validateRequest ─┤                                        │
│    RestartLock ─────┤   the whole pipeline is in-process:     │
│    CheckpointGate ──┤   no timers that exit the host,         │
│    TicketStore ─────┤   no signals, no process kills,         │
│    RestartAuditLog ─┤   no direct access to task state        │
│                     │                                        │
│  ShutdownPort ◄─────┘   "please exit", through a port only    │
│        │                                                     │
│        └─► the host owns its own lifecycle and exits          │
└──────────────────────────────────────────────────────────────┘
                     │
        writes  <state>/ticket.json   (atomic, checksummed)
        writes  <state>/restart-attempts.jsonl
                     │
        reads   <state>/heartbeat.json
                     │
┌──────────────────────────────────── external supervisor ─────┐
│                                                              │
│  RestartSupervisor                                           │
│    SystemLivenessProbe ── pid alive? (signal 0, tasklist, ps) │
│    CrashLoopBreaker ───── rolling unclean-start window        │
│    ChildProcessLauncher ─ spawn the relaunch command          │
│    HeartbeatWriter ────── writes heartbeat.json               │
│                                                              │
│  writes <state>/heartbeat.json, <state>/ledger.json,          │
│         <state>/supervisor.log                                │
│  reads  <state>/ticket.json  (and deletes it when consumed)   │
│  never: task queue, task state, worker scheduling, health     │
└──────────────────────────────────────────────────────────────┘
```

supervisor 刻意被设计成能够拥有一个进程生命周期的最小事物：监视一个 pid、读取一张票据、等待退出、重新拉起、校验存活、如果持续失败就大声放弃。它完全不知道 DS-Hns 在做什么。

### 为什么插件无法自行重启任何东西

`RestartManager` 从不调用 `process.exit`，从不向 pid 发送信号，也从不拉起替代进程。在成功路径上，它的最后一个动作是 `shutdown.requestShutdown(ticketId)`——一个通过注入端口发出的请求，*宿主* 有权拒绝它。如果宿主拒绝，票据会被删除，重启锁被释放，调用方得到 `SHUTDOWN_PORT_UNAVAILABLE`。

这就是插件的最坏情况被限制住的原因。一个无法杀死自己宿主的插件无法让宿主不可用；它最多只能拒绝重启宿主。

---

## 2. 信任边界

supervisor 是另一个进程，因此不能信任插件。所以票据是一份自描述、带版本、带校验和的文档，而 supervisor 把任何校验不通过的东西视为危险，而不是线索。

| 问题 | 由谁回答 | 方式 |
| --- | --- | --- |
| 这次重启可以发生吗？ | 插件 | 校验、锁、冷却时间、检查点闸门 |
| 插件授权它了吗？ | supervisor，独立地 | 它重新读取并重新校验 `ticket.json`；它从不信任插件的记忆 |
| 票据是真实的吗？ | supervisor | `schemaVersion` 相等，然后是对规范 JSON 求 `sha256` |
| 票据仍然有效吗？ | supervisor | 用 `expiresAt` 对比它自己的时钟 |
| harness 还活着吗？ | supervisor | 用它自己的存活探测；它不询问任何人 |
| 重新拉起成功了吗？ | supervisor | 在 `relaunchTimeoutMs` 之后探测被重新拉起的 pid 是否存活 |
| 插件还活着吗？ | supervisor 不关心 | 插件的死亡不会改变重新拉起的任何事 |
| supervisor 还活着吗？ | 插件 | 磁盘上 `heartbeat.json` 的年龄 |

由此得出三个性质，每一个都是有意为之的：

1. **校验和是完整性，而不是认证。** 没有共享密钥，因为不存在一个两个进程都能读取、又能安全保存它的地方。摘要能检测出被截断或被编辑过的票据；它不能证明作者身份。任何能写入状态目录的东西都能伪造出一张可以通过校验的票据，这就是为什么状态目录的文件系统权限属于安全模型的一部分（见 [SECURITY.md](../SECURITY.md)）。
2. **可疑的票据会被销毁，而不是修复。** `verifyTicket` 返回拒绝，而 `TicketStore.consume` 式的调用方会删除该文件。supervisor 的 tick 会清除无法校验的票据并记录 `discarded_unverifiable_ticket`，然后继续监视。把它留在原处，正是这个设计所要防止的失效。
3. **插件的缺席是可承受的。** supervisor 从不等待插件。如果插件在中途死去，票据已经在磁盘上，supervisor 依据的是文档，而不是进程。

### 什么在跨越边界、朝哪个方向、在什么时候

| 产物 | 方向 | 写入时机 | 消费时机 |
| --- | --- | --- | --- |
| `ticket.json` | 插件 → supervisor | 在检查点闸门通过之后、关闭请求之前 | 在每个 supervisor tick 上；一旦观察到退出或票据作废就被删除 |
| `heartbeat.json` | supervisor → 插件 | 每 `heartbeatIntervalMs` 一次，并在每次状态变化时立即写入 | 在每次状态读取和每次请求校验时 |
| `ledger.json` | supervisor → supervisor（以及运维人员） | 在重新拉起时、在非正常启动时、在进入安全模式时 | 在 supervisor 启动时，用于恢复已熔断的熔断器 |
| `supervisor.log` | supervisor → 运维人员 | 每个事件一行，同时镜像到 stderr | 由人或日志收集器消费 |
| `restart-attempts.jsonl` | 插件 → 运维人员 | 在每次被接受、被拒绝、被中止或被取消的尝试时 | 由人或日志收集器消费；在 `storage.maxLogBytes` 处轮转 |

---

## 3. 重启锁状态机

同一时刻只允许一次重启在进行中。`RestartLock` 用**声明式**的边来维护这一不变式，因此别处的 bug 无法把锁带进一个没有出路的状态——非法转换会被拒绝并上报，这正是让卡住的重启变得可见、而不是静默阻塞未来每一次重启的方式。

```
IDLE ──► REQUESTED ──► CHECKPOINTING ──► SHUTTING_DOWN ──► RELAUNCHING ──► VERIFYING
  ▲           │               │                 │                │              │
  │           │               │                 │                │              │
  └───────────┴───────────────┴─────────────────┴────────────────┴──────────────┘
                              (every working state may be abandoned)
```

这些声明式边，逐字来自 `restart-lock.ts`：

| 从 | 允许到 |
| --- | --- |
| `IDLE` | `REQUESTED` |
| `REQUESTED` | `CHECKPOINTING`、`SHUTTING_DOWN`、`IDLE` |
| `CHECKPOINTING` | `SHUTTING_DOWN`、`IDLE` |
| `SHUTTING_DOWN` | `RELAUNCHING`、`IDLE` |
| `RELAUNCHING` | `VERIFYING`、`IDLE` |
| `VERIFYING` | `IDLE` |

在实践中重要的几点说明：

- **`IDLE → REQUESTED` 需要一个 request id。** 拒绝信息是 `entering REQUESTED requires a request id`，正是它阻止了匿名重启。
- **任何工作状态都可以到达 `IDLE`。** 被拒绝的检查点、失败的关闭、显式取消以及启动时的对账都会释放重启锁，因此没有任何单一故障能把机器卡进“重启被永久拒绝”的状态。
- **`REQUESTED → SHUTTING_DOWN` 是存在的**，用于请求不需要检查点的路径。
- **`release(reason)` 不是一次状态转换。** 它是 `abort()` 使用的、刻意留下的逃生口，它会返回自己离开的状态，这样原因就不会丢失。
- **在本版本中，成功路径上的重启锁停在 `SHUTTING_DOWN`**，因为进程被预期会退出。`RELAUNCHING` 和 `VERIFYING` 通过声明式边是可达的，并且被重启锁自身的测试所覆盖，但管理器不会驱动它们：在 `accepted: true` 之后，剩下的部分由另一个进程中的 supervisor 掌管。这就是为什么 `restart_status` 可以合理地在一个正在离场的进程的余生中一直报告 `lock: "SHUTTING_DOWN"`。

每个锁状态在报告中都映射到一个请求状态：`IDLE → completed`、`REQUESTED → queued`、`CHECKPOINTING → checkpointing`、`SHUTTING_DOWN → shutting_down`、`RELAUNCHING → relaunching`、`VERIFYING → verifying`。

---

## 4. supervisor 状态机

```
MONITORING ──(a valid ticket exists)──► WAITING_FOR_EXIT
     │                                        │
     │ (process died, no ticket)              │ (the watched pid is gone)
     │                                        ▼
     │                                   RELAUNCHING ◄──────────┐
     │                                        │                 │
     │                                        ▼                 │ (retry while the
     │                              WAITING_FOR_HEARTBEAT ───────┘  breaker allows)
     │                                        │
     │                                        │ (the relaunched pid is alive)
     │                                        ▼
     │                                     VERIFIED ──► MONITORING
     │
     └──(crash-loop limit reached)──► CRASH_LOOP ──► SAFE_MODE
```

| 状态 | 含义 | 何时离开 |
| --- | --- | --- |
| `MONITORING` | 正在监视；没有票据在起作用 | 出现一张有效票据（→ `WAITING_FOR_EXIT`）、进程死亡（→ 熔断器，然后 `RELAUNCHING`），或熔断器被触发（→ `SAFE_MODE`） |
| `WAITING_FOR_EXIT` | 一张有效票据已被接受；等待被监视的 pid 消失 | pid 消失（→ `RELAUNCHING`）；无法给出答案的探测会让它停在这里并记录 `liveness_probe_failed` |
| `RELAUNCHING` | 推导启动规格并拉起进程 | 拉起成功（→ `WAITING_FOR_HEARTBEAT`）、拉起失败（计入熔断器）、无法推导出规格（→ `SAFE_MODE`、`NO_LAUNCH_COMMAND`） |
| `WAITING_FOR_HEARTBEAT` | 被重新拉起的 pid 必须在 `relaunchTimeoutMs` 内活着 | 它活着（→ `VERIFIED`），或者它不活着（非正常启动，随后重试或进入 `CRASH_LOOP`） |
| `VERIFIED` | 观察到重新拉起后的进程存活 | 立即 → `MONITORING`（这个状态存在，只是为了让事件流能够展示它） |
| `CRASH_LOOP` | 熔断器已触发 | 当 `safeModeOnLoop` 为 true 时 → `SAFE_MODE`；无论哪种情况本次运行都结束 |
| `SAFE_MODE` | 自动化已关闭；需要人工介入 | 只能通过清除账本来离开。supervisor 从不自行判定“时间已经足够久” |
| `STOPPED` | 在 `SupervisorState` 联合类型中声明 | **从未被任何代码路径赋值**——见“尚未实现” |

有两个细节值得精确说明，因为这些名字具有误导性：

- **`WAITING_FOR_HEARTBEAT` 并不等待来自 DS-Hns 的心跳。** 在这个设计里没有应用心跳。supervisor 用自己对它所拉起的 pid 的存活探测来校验重新拉起，而唯一的心跳文件是 supervisor 自己的，写给*插件*读取。设计稿把“读取心跳”列为 supervisor 的职责；实现把这个方向反了过来。
- **`SAFE_MODE` 停止重新拉起；它不会启动一个降级的 DS-Hns。** 在死亡之后到达该状态的路径中（监视期间崩溃，或重新拉起后没有存活），harness 是停着的，并且会一直停着直到有人启动它。日志行 `"automation is disabled; DS-Hns still runs"` 只在 DS-Hns 还在运行、而失败的是*插件*的情况下才准确。

每次状态变化都会发出带有机器可读 `code` 的事件，并以每行一个 JSON 对象的形式写入 `supervisor.log`——例如 `supervisor_boot`、`restart_ticket_accepted`、`discarded_unverifiable_ticket`、`process_died_without_ticket`、`relaunching`、`relaunched`、`relaunch_verification_failed`、`crash_loop_limit_reached`、`safe_mode_entered`、`safe_mode_manual_action_required`、`supervisor_stopped`。

---

## 5. 票据生命周期

```
        (no ticket)
             │
             │  RestartManager.handle(): checkpoint gate passed
             ▼
   ┌──────────────────────────┐
   │ ticket.json written      │  writeFileAtomic: temp file → fsync → rename
   │ schemaVersion 1          │  checksum = sha256(canonicalJson(all but checksum)
   │ expiresAt = now + ttl    │
   └──────────────────────────┘
             │
             ├── host refuses the shutdown ──► clearTicket() ──► audit: failed
             │
             ▼
   ┌──────────────────────────┐
   │ handed to the supervisor │  the plugin does not wait; the process exits
   └──────────────────────────┘
             │
             ├── supervisor tick: does not verify ──► clearTicket() + discarded_unverifiable_ticket
             ├── supervisor tick: expired / wrong schema ──► same
             ├── supervisor tick: names another pid ──► adopts that pid, keeps the ticket
             ▼
   ┌──────────────────────────┐
   │ exit observed            │  clearTicket() before relaunching
   └──────────────────────────┘
             │
             ▼
   ┌──────────────────────────┐
   │ relaunch → verify        │  ledger.json records relaunches / unclean starts
   └──────────────────────────┘

   (a new process at startup)
             │
             └── reconcileAfterRestart(): any ticket still present is from a process
                 that did not exit. It is deleted and reported; the next supervisor
                 tick therefore finds nothing and the stale intent cannot be acted on.
```

每一步都是幂等的或自清除的：一张票据要么被消费、要么被作废，要么被下一个进程对账掉。不存在任何一种状态能让一张旧票据引发一次没人要求过的重启，因为 supervisor 在每个 tick 上都会重新校验有效期，而插件会在启动时删除它发现的任何遗留票据。

---

## 6. 每项职责在哪里止步

这个设计中有意思的部分不是每个组件做什么；而是每个组件在哪里拒绝再往前走。

| 组件 | 止步于 | 原因 |
| --- | --- | --- |
| `dsh-restart` 插件 | 写入票据并请求宿主退出 | 宿主拥有自己的生命周期；插件没有以特权方式结束它的途径 |
| `dsh-restart` 插件 | 检查点的*答案* | 它从不保存任务状态；缺失或不安全的答案会中止重启，而不是被绕过去处理 |
| `dsh-restart` 插件 | `DISABLED`/`CRASH_LOOP` 拒绝 | 它不知道重启是*为什么*被需要，因此不能凭直觉推翻自己设定的边界 |
| supervisor | 监视、重新拉起、统计失败 | 它绝不能变成第二个 DS-Hns：没有任务队列、没有 worker 调度、没有健康、没有温度 |
| supervisor | 进入安全模式 | 它不会在“时间够久”之后自行重新武装自动化；那是运维人员的决定 |
| DS-Hns Core | 提供检查点和消费恢复 | 只有 harness 知道什么是一个安全点 |
| DS-Hns Core | 保存和恢复任务状态 | 插件没有访问权限，也不想要 |
| `dsh-health-scheduler` | 提交一个请求 | 决策与执行被刻意放在不同的进程中 |

## 尚未实现

与设计稿的偏差，这些偏差属于架构说明，因为它们改变的是系统的形态，而不是某个细节：

- **系统重启尚未接线。** `SystemShutdownPort` 链路存在且已导出，但 `RestartManager` 读取它只是为了报告 `capabilities.systemRestart`。没有任何路径调用 `requestSystemRestart`，所以 `mode: "system"` 目前最终得到一个宿主关闭请求外加一张 `mode: "system"` 的票据——而不是一次重启。supervisor 除了记录 `ticket.mode` 之外就忽略它，所以那张票据会像其他任何票据一样重新拉起应用。
- **没有任何东西把重启锁推过 `SHUTTING_DOWN`。** `RELAUNCHING` 和 `VERIFYING` 已被声明、可测试，并且在生产环境中从未到达，因为 supervisor 是一个不持有重启锁的独立进程。
- **插件从不观察它所请求的重启的结果。** 在 `accepted: true` 之后，它被预期已经消失。下一次启动时的对账是唯一的反馈，而且它报告的是“上一个进程没有退出”，而不是“重启成功了”。
- **`SupervisorState.STOPPED` 从未被赋值。** 一个已停止的 supervisor 就是一个缺席的 supervisor，通过心跳年龄来检测。
- **`spawnSupervisor()` 从未被调用**，所以双进程结构必须由运维人员或包装脚本组装，而不是由插件组装。
- **插件不读取 `ledger.json`。** 安全模式仅由 supervisor 强制执行；插件自身的 `CRASH_LOOP` 拒绝由 `tripCrashLoop()` 驱动，而这个包内没有任何东西调用它。
