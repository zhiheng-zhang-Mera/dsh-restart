# 验收

本文档把设计稿（`plugin-dsh-restart-plan.md`，第 14 节和第 15 节）中的每一条验收标准
映射到某个真正可以运行的对象上。它区分三类证据：

- **自动化** —— `tests/*.test.js` 中一个有名字的测试，由 `npm test` 运行
- **人工** —— 一条可复现的命令或检查，并给出预期结果
- **待真实 Windows E2E** —— 确实需要一台真实机器、一个真实桌面会话和
  一个真实 DS-Hns profile；再多的单元测试也无法替代它

任何当前尚未验证的内容都会被标注为未验证。本文档不会提到任何并不存在的测试。

## 如何运行这些检查

```powershell
npm install
npm test                   # builds lib/ then runs node --test tests/*.test.js
npm run test:only          # the same tests without rebuilding
npm run typecheck          # tsc --noEmit
npm run verify:artifacts   # artifact checks against lib/ and bin/
node bin/supervisor.mjs --help
node --test --test-name-pattern "safe mode" tests/supervisor.test.js
```

测试套件由六个文件组成：`validation.test.js`（请求形状、请求策略、锁、票据）、
`manager.test.js`（pipeline、检查点门控、重复抑制、冷却、系统门控、取消、reconciliation、
breaker 集成、supervisor 存在性、状态、审计日志）、`supervisor.test.js`（存活探针、
breaker、启动命令推导、状态机、运行循环）、`plugin.test.js`（插件导出、`applyRestart`、
面向模型的工具、协议一致性，以及插件与 supervisor 在票据上的一致）以及 `integration.test.js`
（supervisor 自身的命令行与退出码、对四个 PowerShell 脚本进行解析并检查其中是否存在
被禁止的操作，以及仓库卫生）。`tests/helpers/rig.js` 和
`tests/helpers/checkpoints.js` 提供了被注入的接缝，每个测试都通过这些接缝驱动真实的类
——单元测试套件不重启任何东西、不杀掉任何东西，也不调用外部 shell；
`integration.test.js` 是唯一会启动进程的文件，而它启动的进程就是带 `--max-ticks 1` 的 supervisor。

## 设计稿第 15 节：十五条验收标准

| # | 验收标准（设计稿 §15） | 证据 | 状态 |
| --- | --- | --- | --- |
| 1 | Restart 不包含任何健康策略 | `plugin.test.js` → `plugin exports` → *contains no health policy and no scheduling of any kind* | 自动化 |
| 2 | Restart 不包含任何时间调度算法 | 与 #1 相同的测试（它断言不存在任何调度构造）；`validation.test.js` → `request shape validation` → *rejects an unknown mode and a non-boolean checkpoint flag* 覆盖了形状层面的对应情形 | 自动化 |
| 3 | 卸载 Health Scheduler 不会影响手动重启 | 人工：`allowedSources` 默认包含 `operator` 和 `dsh-cli`，且 `src/` 中没有任何代码导入或 require `dsh-health-scheduler`（`grep -r "health-scheduler" src/` 只匹配到配置默认值和文档字符串） | 人工 |
| 4 | 卸载 Restart 后 DS-Hns 仍能运行 | 人工：`scripts/uninstall.ps1`，以及 `applyRestart` 的设计——它只注册一个 settings 命名空间和三个工具，没有任何东西会拦阻启动；`plugin.test.js` → `applyRestart` → *runs without a tools service or a settings service*；`integration.test.js` → `PowerShell deployment scripts` → *never kills DS-Hns as a normal path*，*all four exist and declare their contract* | 人工 + 自动化 |
| 5 | 一条重启请求最多执行一次 | `manager.test.js` → `duplicate suppression` → *returns the original answer for a retried request id and restarts nothing twice*；*refuses the same id used for a different request*；`validation.test.js` → `request policy validation` → *refuses a duplicate request id* | 自动化 |
| 6 | 检查点失败时默认不会重启 | `manager.test.js` → `checkpoint gate` → *aborts when the harness reports an unsafe safe point*，*aborts when the checkpoint starts but does not complete*，*aborts, rather than proceeding, when the checkpoint port throws*，*abandons a checkpoint that never answers instead of hanging the lock*，*refuses every request when no checkpoint port is bound and one is required*；`validation.test.js` → *refuses when a required checkpoint cannot be verified* | 自动化 |
| 7 | Supervisor 死亡不会拖垮 DS-Hns | `manager.test.js` → `supervisor presence` → *refuses when no heartbeat has been seen, because exiting is not restarting*；`supervisor.test.js` → `supervisor state machine` → *never acts on a liveness probe that could not answer*；`integration.test.js` → `supervisor command line` → *reports safe mode as a distinct exit code, so a wrapper can tell* | 自动化 |
| 8 | 重启插件死亡不会拖垮 DS-Hns | `plugin.test.js` → `applyRestart` → *reports a rejected configuration and keeps running on the defaults*；*runs without a tools service or a settings service* | 自动化 |
| 9 | 崩溃循环自动触发熔断 | `supervisor.test.js` → `crash-loop breaker` → *allows relaunches until the limit, then trips*；*uses a rolling window, so old crashes stop counting*；*restores a tripped state from the ledger, so a restart cannot clear it*；`supervisor state machine` → *enters safe mode after the crash-loop limit instead of looping forever* | 自动化 |
| 10 | 安全模式可以启动 | `supervisor.test.js` → `supervisor state machine` → *enters safe mode after the crash-loop limit instead of looping forever*；*stays in safe mode once tripped, even if a ticket arrives*；人工：`node bin/supervisor.mjs --state <dir-with-safeMode-ledger>` 以 **3** 退出（已验证） | 自动化 + 人工 |
| 11 | 应用重启后任务能够恢复 | **本仓库无法验证。** 任务恢复是 DS-Hns Core 的职责；本插件只请求检查点，从不触碰任务状态。这里的任何测试都无法证明任务能够恢复。 | 待真实 Windows E2E |
| 12 | 系统重启后任务能够恢复 | **未验证，且当前不可达：** pipeline 从不调用 reboot 端口（见"尚未实现"一节） | 尚未实现 |
| 13 | 不存在重启风暴 | `manager.test.js` → `cooldowns` → *enforces the minimum interval after an accepted restart*；*reports the remaining cooldown in the status payload*；`duplicate suppression`（同 #5）；`application restart pipeline` → *accepts a valid request, writes a ticket, and asks the host to shut down*（此后锁一直被持有） | 自动化，但存在下文的保留 |
| 14 | 每个异常都有结构化日志 | `manager.test.js` → `audit log` → *writes accepted, refused and cancelled attempts to disk with schema versions*，*never throws when the audit directory cannot be written*；`supervisor.test.js` → `supervisor run loop` → *logs every state change with a machine-readable code*，*contains a throwing log observer*；`integration.test.js` → `supervisor command line` → *runs a bounded number of ticks and exits cleanly*（断言 stderr 上出现 `supervisor_boot`/`supervisor_stopped`，并且 `heartbeat.json` 和 `supervisor.log` 已被写入） | 自动化 |
| 15 | 在最新 Windows 环境上的真实 E2E | 见"需要真实 Windows E2E 运行的内容"一节 | 待真实 Windows E2E |

验收标准 #11、#12 和 #15 是诚实交代的缺口。#12 不只是未经测试，而是尚未实现；
#11 则根本无法从本仓库取得任何证据。

## 设计稿第 14 节：单元与集成覆盖

| 设计稿 §14 条目 | 测试 |
| --- | --- |
| 请求校验 | `validation.test.js` → `request shape validation`（8 个测试）、`request policy validation`（15 个测试） |
| 重启锁 | `validation.test.js` → `RestartLock`（9 个测试） |
| 冷却 | `manager.test.js` → `cooldowns`（3 个测试）；`validation.test.js` → *refuses inside a cooldown and reports the remaining time* |
| 去重 | `manager.test.js` → `duplicate suppression`（3 个测试） |
| 票据持久化 | `validation.test.js` → `tickets`（13 个测试），包括校验和被篡改、过期、schema 版本、错误的 pid 和原子写入 |
| 崩溃循环 breaker | `supervisor.test.js` → `crash-loop breaker`（6 个测试） |
| 状态转换 | `validation.test.js` → `RestartLock`；`supervisor.test.js` → `supervisor state machine`（11 个测试） |
| 假的 DS-Hns → 优雅退出 → 重新拉起 | `supervisor.test.js` → `supervisor state machine` → *honours a ticket: waits for the exit, relaunches, and verifies*；`plugin.test.js` → `supervisor and plugin agree on the ticket` → *writes a ticket the supervisor accepts, consumes and erases* |
| 检查点成功 | `manager.test.js` → `application restart pipeline` → *runs the checkpoint gate before writing anything*；`checkpoint gate` → *proceeds without a checkpoint only when the request does not require one* |
| 检查点失败 | `manager.test.js` → `checkpoint gate`（5 个中止/拒绝测试） |
| 重复请求 | `manager.test.js` → `duplicate suppression`（3 个测试） |
| supervisor 不可用 | `manager.test.js` → `supervisor presence`（3 个测试） |
| 重新拉起失败 | `supervisor.test.js` → `supervisor state machine` → *counts a failed launch against the breaker rather than retrying blindly*，*gives up cleanly when no launch command can be derived*，*gives up on a relaunch that never comes back alive* |
| 安全模式回退 | `supervisor.test.js` → `crash-loop breaker` → *restores a tripped state from the ledger, so a restart cannot clear it*；`supervisor state machine` → *stays in safe mode once tripped, even if a ticket arrives* |

在设计稿自身列表之外，`integration.test.js` 还覆盖了单元测试套件无法触及的部署面：
`supervisor command line`（--help 以 0 退出并打印用法，未知选项会被拒绝而不是被猜测，
一次有界的运行会干净退出并写入它的 heartbeat 和日志，安全模式则是一个独立的退出码）、
`PowerShell deployment scripts`（四个脚本都存在，带有基于注释的帮助和 `-WhatIf`，
能在 Windows PowerShell 解析器下解析，暴露 `-Profile`，并且经过检查，确保它们都不会长出
`taskkill`、`shutdown /r` 或任何会停止 DS-Hns 的路径），以及 `repository hygiene`
（没有跟踪任何运行时产物，bundle patch 和 supervisor 二进制已在 `package.json` 中声明，
构建出的入口点中没有 `.ts` 说明符，也不依赖 health 插件）。

## 仅有部分证据的验收标准

这些标准值得被明确点出，而不是藏在一片全绿的测试套件背后。

| 标准 | 测试实际证明了什么 | 测试没有证明什么 |
| --- | --- | --- |
| #13"不存在重启风暴" | 第二次请求会被拒绝——但 *enforces the minimum interval after an accepted restart* 接受 `COOLDOWN_ACTIVE` **或** `RESTART_IN_FLIGHT` **两者之一**作为原因 | 具体是冷却拦下了它。在一次被接受的重启之后，锁仍处于 `SHUTTING_DOWN`，所以经由公共 API 时，第二个请求通常会更早地被锁拒绝。`COOLDOWN_ACTIVE` 是在校验器层面得到证明的（*refuses inside a cooldown and reports the remaining time*），并且只有在该进程本来就有冷却的情况下，它对下一个进程才仍然可达——而冷却状态保存在内存中，因此新进程启动时 `remainingMs: 0`。所以跨重启的下界**并未**被强制执行；见"尚未实现"一节。 |
| #2"无时间调度" | 插件中没有任何调度代码 | 与请求方有关的任何东西。按设计，负责调度重启的 Health Scheduler 属于另一个仓库。 |
| #7"supervisor 死亡" | 在没有心跳时插件的拒绝行为 | 运维人员会察觉：这属于心跳监控加上退出码 3 的约定，记录在 [operations.zh.md](operations.zh.md) 中。 |
| #14"结构化日志" | 审计日志和 supervisor 日志条目是结构化的且具备容错性 | *每一个*异常都被记录。拒绝、中止、取消和被接受的尝试都会被记录；一个没有退出就死掉的进程只留下票据，由下一次启动时的 reconciliation 报告出来。 |
| #8"插件死亡" | 插件对缺失服务和错误配置的容忍 | 插件在*重启中途*崩溃后系统仍保持一致。其机制是磁盘上的票据加上 `reconcileAfterRestart()`，由 `manager.test.js` → `startup reconciliation`（3 个测试）覆盖，但崩溃本身并没有做端到端模拟。 |

## 需要真实 Windows E2E 运行的内容

设计稿的 §14 Windows E2E 矩阵无法从本仓库得到满足。下面每一项都需要一台真实机器、
一个真实桌面会话和一个真实 profile，并且每一项都列出了该运行必须实际证明的内容：

| 场景 | 该运行必须展示什么 | 为什么自动化无法解决 |
| --- | --- | --- |
| 正常应用重启 | 票据 → 退出 → 重新拉起 → `supervisor.log` 中出现 `relaunch_verified`，并且 DS-Hns 重新对外服务 | 需要 `ShutdownPort` 背后的真实宿主生命周期；除非宿主注入自己的实现，`HostShutdownPort` 连接的是 `RecordingLifecycle` |
| 空闲时重启 | 检查点端口回答安全，重启继续进行 | 需要一个真实的 harness 应答 `prepareForRestart` |
| worker 任务期间重启 | harness 要么完成检查点，要么回答不安全，而不安全的回答会**中止**重启 | 需要一个真正在执行中的任务 |
| Computer Use 任务期间重启 | 同上，但使用更长/真实的安全点等待 | 需要真实的 Computer Use 环境 |
| git 操作期间的重启请求 | 以真实原因（例如 `git_commit_in_progress`）拒绝或推迟；不出现半提交状态 | 需要一个真实的仓库和一个真正进行中的 commit |
| 关闭超时 | 当宿主接受了关闭请求却始终不退出时，实际会发生什么 | **截止时间尚未实现**：`WAITING_FOR_EXIT` 没有超时，`allowForceTerminate` 从未被读取，因此今天预期的观察结果是"supervisor 永远等待，不再记录任何后续日志"——见 [failure-modes.zh.md](failure-modes.zh.md) |
| profile 损坏后的重启 | 插件记录一条配置被拒绝的日志，继续以默认值运行，DS-Hns 仍能启动 | 需要一个真正损坏的 profile，以及一次 harness 启动 |
| 系统重启 | 一次重启，以及机器重新回来 | **尚未实现**：reboot 端口确实会被流水线调用，但真实重启无法在 CI 中演练 |
| 登录 / 重新拉起 | 会话登录后 DS-Hns 重新拉起 | 需要真实的桌面/会话集成（任务计划程序或等价物） |
| 任务恢复 | 任务状态在两种重启下都能存活 | 属于 DS-Hns Core 的职责，只有在真实安装上才能证明 |

对于以上所有场景，该运行都必须记录：`dsh --profile <p> --dump-config` 的完整输出、
运行产生的 `supervisor.log` 和 `restart-attempts.jsonl`、生成的
`ticket.json`/`heartbeat.json`/`ledger.json`，以及 supervisor 的退出码。无法产出这些产物的运行，
什么都没有证明。

## 发布前值得运行的人工检查

```powershell
# 1. The artifacts are a usable build.
npm run build; npm run verify:artifacts

# 2. The whole suite, from the current sources.
npm test

# 3. The supervisor really starts, really stays alive, and really stops.
$dir = Join-Path $env:TEMP ('dsh-restart-acceptance-' + [guid]::NewGuid().ToString('N'))
node bin/supervisor.mjs --state $dir --tick-ms 150 --max-ticks 3   # -> exit 0
Get-Content (Join-Path $dir 'supervisor.log')                      # supervisor_started .. supervisor_stopped

# 4. Safe mode is exit code 3, not 0.
$ledger = '{"schemaVersion":1,"uncleanStarts":[],"safeMode":true,"safeModeReason":"process_died_without_ticket","safeModeAt":"2026-06-01T09:00:00.000Z","relaunches":2}'
Set-Content -Path (Join-Path $dir 'ledger.json') -Value $ledger -NoNewline -Encoding utf8NoBOM
node bin/supervisor.mjs --state $dir                               # -> exit 3

# 5. A bad command line fails loudly rather than silently doing nothing.
node bin/supervisor.mjs --nope                                     # -> exit 1
node bin/supervisor.mjs --state (Join-Path $dir 'file/sub')         # -> exit 2
```

其中两项是针对撰写本文档时发现的真实缺陷所做的回归检查：

- supervisor 的入口点过去会把 `import.meta.url` 与手工拼接的 `file://D:/...` 字符串比较，
  这在 Windows 上永远不匹配，于是 `node bin/supervisor.mjs` 什么都不打印并以 0 退出。
  现在 `npm run verify:artifacts` 会断言 `--help` 打印用法，一旦回归就会失败。
- supervisor 自身的定时器按设计被 `unref`，因此裸调用 `run()` 会在第一个 tick 之后
  耗尽事件循环，进程还没开始监管就退出了。现在入口点会在整个运行期间保持事件循环存活。
  一旦回归，上面的第 3 步就会失败：`supervisor_stopped` 永远不会出现，退出码也不是 0。

## 尚未实现

在此重申，因为十五条验收标准中有三条离开它们就无法满足：

| 条目 | 设计稿出处 | 状态 |
| --- | --- | --- |
| 系统重启（`requestSystemRestart`） | §5 Level B、§15 #12 | 端口已实现并导出；pipeline **从未调用** |
| 关闭超时后的强制终止 | §13 case 4 | `safety.allowForceTerminate` 会在 `safety.shutdownTimeoutMs` 到期后被读取，同时还需要绑定终止器 |
| "记录一次脏重启" | §13 case 4 | 不会写入任何此类记录 |
| 重启之后的 `acknowledgeResume` | §5 Level A 流程、§7 | 已在端口和门控上实现；pipeline 从未调用 |
| 重新拉起重试之间的有界退避 | §13 case 5 | 按轮询间隔重试，仅由 breaker 限定上界 |
| 在安全模式下以无自动化方式启动 DS-Hns | §6.3 | 安全模式会停止重新拉起；它不会启动一个降级的 DS-Hns |
| 跨重启的冷却持久化 | §6.2"强制执行下界" | 冷却保存在内存中；新进程启动时没有任何冷却 |
| 由插件启动 supervisor | §11"注册 supervisor" | `spawnSupervisor()` 已导出，但从未被调用 |

## 相关文档

- [failure-modes.zh.md](failure-modes.zh.md) —— 每种失败在运维人员眼中是什么样子
- [operations.zh.md](operations.zh.md) —— 运行、调优与恢复
- [architecture.zh.md](architecture.zh.md) —— 两个进程与信任边界
- [protocol.zh.md](protocol.zh.md) —— 线协议与票据文档
