# 运维

如何运行、观察、调优 `dsh-restart`，以及如何从故障中恢复。这里的一切都是本仓库代码的实际
行为；当设计稿与源码不一致时，描述以源码为准，并会明确指出这一分歧。

相关阅读：[`../README.zh.md`](../README.zh.md)、[`architecture.zh.md`](architecture.zh.md)、
[`protocol.zh.md`](protocol.zh.md)、[`acceptance.zh.md`](acceptance.zh.md)、[`failure-modes.zh.md`](failure-modes.zh.md)。

---

## 运行

Supervisor 是一个独立的长生命周期进程，它运行在 DS-Hns **周围**。它负责 pid 监视、票据、重新拉起以及崩溃循环熔断器；插件负责请求校验、检查点闸门、票据以及优雅关闭请求。

```powershell
node bin/supervisor.mjs --state "$env:DSH_HOME\restart" --pid 4242 --tick-ms 1000 --max-ticks 3 `
  --terminate-after-verify -- node dsh.js --profile web
```

| 选项 | 含义 |
| --- | --- |
| `--state <dir>` | 存放 `ticket.json`、`heartbeat.json` 和 `ledger.json` 的目录。默认为 `%DSH_HOME%\restart`，否则为 `./.dsh-restart`。 |
| `--pid <pid>` | 监视这个 pid，而不是父进程。**以脱离方式启动时必填** —— 见下文。 |
| `--tick-ms <ms>` | 轮询间隔。默认为 `supervisor.pollIntervalMs`（1000 ms）。 |
| `--max-ticks <n>` | 经过 `n` 个 tick 后停止。用于有界运行或冒烟测试；生产环境既不传它也不传 `--tick-ms`，而是停在某个终态。 |
| `--terminate-after-verify` | 在重新拉起通过校验后退出，而不是继续监视。 |
| `-h`, `--help` | 打印用法并以 0 退出。 |
| `-- <command> [args…]` | `--` 之后的所有内容都是用于重新拉起 DS-Hns 的命令。 |

**为什么它必须脱离父进程，以及为什么这迫使人必须传 `--pid`。** Supervisor 必须比它所监视的进程活得更久，因此它不能是一个随父进程一同死去的子进程：`spawnSupervisor()` 用 `detached: true`、`stdio: 'ignore'` 和 `child.unref()` 启动它，而它自己的定时器也被 `unref`，所以它永远无法把宿主拖住。但一次脱离方式的启动没有有意义的父进程，而 `RestartSupervisor` 会把 `watchedPid` 默认为 `process.ppid`。**没有显式的 `--pid`，脱离启动的 supervisor 监视的是它的启动者（或者一个早已退出的 pid），而不是 DS-Hns。** 请传 `--pid`。

**真正会咬人的注意事项。** 不给 `--` 时，`deriveLaunchSpec()` 会回退到 supervisor 自己的 `argv`，那正是 `bin/supervisor.mjs` 本身，而不是 DS-Hns。一个不带 `--` 启动的 supervisor 会在每次退出后重新拉起*它自己*。这一点已经过验证，而且它是这里最重要的部署注意事项。`scripts/install.ps1` 也会就此发出警告：`note: no -LaunchCommand was given, so the supervisor will fall back to its own argv, which is this script path rather than DS-Hns. Pass -LaunchCommand <exe>,<args...> for a working relaunch.`

Supervisor 会把每一行日志同时镜像到 **stderr** 和 `supervisor.log`，因此包装脚本或任务计划程序无需读取该文件就能看到安全模式。当它以安全模式结束时，它以 **3** 退出，这样“必须有人来看一眼”就既能与成功区分，也能与崩溃区分。

从 CLI 启动的 supervisor 会调用 `resolveConfig({})`：它**不会**读取 profile 的插件配置，所以 `supervisor.launchCommand`、`launchArgs`、`launchCwd` 以及那些计时键都处于出厂默认值。给它传 `--`，然后接受这些默认值。参见 [`failure-modes.zh.md`](failure-modes.zh.md)。

---

## 状态目录布局

两边必须指向**同一个**目录，否则插件永远看不到心跳，并会以 `SUPERVISOR_ABSENT` 拒绝每一个请求。插件默认为 `<DSH_HOME>\restart`（`storage.directory` 会覆盖它）；supervisor 默认为 `--state`，否则 `<DSH_HOME>\restart`，再否则 `./.dsh-restart`。

| 文件 | 由谁写入 | 何时写入 | 可以安全删除吗？ |
| --- | --- | --- | --- |
| `ticket.json` | 插件（`TicketStore.writeTicket`，原子写入） | 在检查点闸门通过之后、关闭请求发出之前；一旦 supervisor 消费了它，或者请求被中止、被取消，或者插件的新一次启动完成对账，它就会被删除 | 可以，而这恰恰就是取消一次待处理重启的做法。它是 supervisor 唯一会据以行动的文件。 |
| `heartbeat.json` | supervisor（`HeartbeatWriter`，原子写入，每隔 `heartbeatIntervalMs` 以及在每次状态变化时） | supervisor 运行期间 | 可以。此后插件会把 supervisor 读作缺席，直到下一次心跳，并以 `SUPERVISOR_ABSENT` 拒绝。 |
| `ledger.json` | supervisor（`persistLedger()`；`enable.ps1` / `disable.ps1` 也会编辑它） | 每次重新拉起、每次不干净启动以及安全模式切换时 | 可以，但你会失去崩溃历史和任何 `safeMode` 标志。删除它*确实*是一种清除安全模式的办法 —— 它正是 `enable.ps1 -Mechanism SafeMode` 所编辑的文件。 |
| `supervisor.log` | supervisor（`bin/supervisor.mjs`，每行一个 JSON 对象，只追加） | 每个事件 | 可以。它是一个没有轮转的日志：没有别的东西读取它，而它会无限制地增长。 |
| `restart-attempts.jsonl` | 插件（`RestartAuditLog`，只追加） | 每一次被接受、被拒绝、被中止和被取消的尝试 | 只有当你想失去事故线索时才可以。运维上是安全的：插件只追加，从不回读。 |
| `restart-attempts.jsonl.<timestamp>.bak` | 插件，当日志达到 `storage.maxLogBytes` 时 | 轮转时 | 可以，但有同样的告诫。`uninstall.ps1` 会刻意保留这些文件。 |

插件自己的状态目录解析为 `<DSH_HOME>/restart`，回退到 `<cwd>/.dsh-restart` —— 这与 supervisor 使用的默认值相同，这也是为什么 `%DSH_HOME%` 通常是你唯一需要保持一致设置的东西。

---

## PowerShell 脚本

这四个都是基于注释的帮助（comment-based help）高级脚本，支持 `-WhatIf`（`[CmdletBinding(SupportsShouldProcess)]`），宁可拒绝也不写入它们无法验证的内容，并且在拒绝时以非零码退出。一次拒绝意味着**在报告出问题的地方什么都没有被写入**。

> **环境说明。** 四个脚本都声明 `#Requires -Version 5.1`。它们没有使用任何仅 PowerShell 7 才有的语法，而 Windows PowerShell 5.1 随每一个受支持的 Windows 版本一同提供，因此 5.1 是仍然诚实的最宽要求 —— 也正是用来验证它们的版本。验证所在的机器上**没有**安装 PowerShell 7，因此下面所有用例都在 Windows PowerShell 5.1 下执行：文件解析器与 `Get-Command` 两种解析检查、幂等重装、四个脚本的 `-WhatIf`、前置条件失败时的退出码、取消 ticket 并保留审计日志、`enable`/`disable` 两种机制，以及各条拒绝路径。`tests/integration.test.js` 每次运行都会重做解析与 `-WhatIf` 前置条件检查。它们**尚未**在 7.0 下执行过，这是在有该版本的机器上值得补上的一处缺口。

<details>
<summary><code>install.ps1</code> — 注册、校验、可选地启动 supervisor、冒烟测试</summary>

**它按顺序做的事。**（1）前置条件：`-RepoPath` 下必须存在 `package.json`、`bin/supervisor.mjs` 和 `lib/index.js`，并且 dsh 与 node 可执行文件必须能被解析到。（2）它通过导出组合后的 profile 来询问 profile 该插件是否已经注册 —— 这是一次**幂等**检查，发生在任何写入*之前*，所以运行两次只会安装一次，并且会说明这一点。（3）它用 `dsh plugin --profile <Profile> add <RepoPath>` 注册，并重新导出 profile 以进行校验。（4）它可选地创建状态目录，并以脱离、隐藏的方式启动 supervisor。（5）它对 `node bin/supervisor.mjs --help` 做冒烟测试，要求退出码为 0 *并且*有用法文本。

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `-Profile <string>` | `web` | 要安装到的 DSH profile。 |
| `-RepoPath <string>` | `scripts/` 的父目录 | 包目录。 |
| `-StateDirectory <string>` | `$env:DSH_HOME\restart`，否则 `<RepoPath>\.dsh-restart` | 作为 `--state` 传给 supervisor。 |
| `-LaunchCommand <string[]>` | 无 | supervisor 命令行上 `--` 之后的所有内容，例如 `node,'D:\DS-Hns\app\dsh.js','--profile','web'`。 |
| `-WatchPid <int>` | 无 | 作为 `--pid <n>` 传入。 |
| `-SkipSupervisor` | 关 | 只注册并校验；摘要会打印出稍后用来启动它的确切命令。 |
| `-SkipVerification` | 关 | 不运行 `--dump-config`；安装会被报告为 `verified: no`。 |
| `-DshCommand <string[]>` | `@('dsh')` | dsh 可执行文件以及任何前缀参数。 |
| `-NodePath <string>` | `node` | 用于 supervisor 和冒烟测试的 Node。 |
| `-WhatIf` | 关 | 打印每一个动作，不做任何更改。 |

**它拒绝猜测的东西。** 缺失的 dsh 或 node 可执行文件，缺失的 `package.json`、`bin/supervisor.mjs` 或 `lib/index.js`，以及 —— 最重要的一个 —— 无法读取的 profile；对于最后这种情况它会打印 `FAIL: could not determine whether dsh-restart is registered (dsh --dump-config exited 1: ...)`，然后打印 `Nothing was changed: registering on an unknown state is how a profile ends up with the plugin twice. Fix the profile first, or pass -SkipVerification to register without asking.`

它从不停止 DS-Hns，也从不重启任何东西。真实的摘要输出结尾如下：

```text
  state directory : D:\DS-Hns\temp\dsh-restart-script-test-c478835a1ed44dc4a6aca1fceddb28b1\state
  verified        : yes
  supervisor      : not started by this script
  smoke test      : passed
```

</details>

<details>
<summary><code>uninstall.ps1</code> — 取消、停止 <em>supervisor</em>、移除、保留审计日志</summary>

**它按顺序做的事。**（1）删除 `<StateDirectory>\ticket.json`，这样就没有任何 supervisor 能对一次待处理的重启采取行动。（2）**从 `heartbeat.json`** 识别出 supervisor，并且只停止那个进程。（3）运行 `dsh plugin --profile <Profile> remove dsh-restart`。（4）打印它保留的每一个状态文件。

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `-Profile <string>` | `web` | 要从中移除插件的 profile。 |
| `-StateDirectory <string>` | `$env:DSH_HOME\restart`，否则 `<RepoPath>\.dsh-restart` | 票据、心跳、账本和审计日志所在的位置。 |
| `-RepoPath <string>` | `scripts/` 的父目录 | 用于识别 supervisor 的命令行。 |
| `-KeepTicket` | 关 | 不删除待处理的票据（仅当你把它交给一个应当对它采取行动的 supervisor 时）。 |
| `-SkipSupervisor` | 关 | 不停止 supervisor 进程。 |
| `-SkipPluginRemoval` | 关 | 只清理运行时状态，不碰 profile。 |
| `-DshCommand <string[]>` | `@('dsh')` | dsh 可执行文件以及任何前缀参数。 |
| `-Force` | 关 | 即使某个 pid 的命令行没有提到 `supervisor.mjs`，也停止它。 |
| `-WhatIf` | 关 | 打印每一个动作，不做任何更改。 |

**它只停止 supervisor，从不停止 DS-Hns。** 拒绝是明确的，而且它是这个脚本最重要的行为：`FAIL: pid 999999 looks like the DS-Hns harness, not the supervisor; refusing to stop it`。只有当某个 pid 的命令行匹配 `supervisor\.mjs`，或者给出了 `-Force` 时，它才会被停止。它**保留审计日志**，并且会说明这一点：

```text
==> Preserving the audit log
    PRESERVED (not deleted, not rotated, not truncated):
      D:\DS-Hns\temp\...\state\restart-attempts.jsonl (57 bytes)
      D:\DS-Hns\temp\...\state\heartbeat.json (184 bytes)
    note: the state directory itself is left in place: D:\DS-Hns\temp\...\state
    note: delete it by hand only if you also want to lose the incident trail

  DS-Hns was not stopped, signalled or modified. It keeps running; what it loses is automatic restart.
```

**它拒绝猜测的东西。** 一份不是可读 JSON 的心跳，一份没有可用的
`supervisorPid` 的心跳（“refusing to guess which process to stop”），以及任何看起来不像
supervisor 的 pid。它也从不使用 `taskkill`，从不发出 `shutdown /r`。

</details>

<details>
<summary><code>enable.ps1</code> / <code>disable.ps1</code> — 两种相互独立的机制</summary>

两个脚本都只切换两种机制，并打印它们使用的是哪种机制、哪个文件。

| 机制 | 它编辑的文件 | 它改变什么 |
| --- | --- | --- |
| `Plugin` | `<ProfileDirectory>\cordis.patch.yml` 中属于本插件的区域 —— 一行带有 `id: restart` 或 `name: 'dsh-restart'` 的记录 | 该记录中的 `enabled: true` / `enabled: false`。这是插件的主开关：当它为 false 时，每个请求都会被以 `DISABLED` 拒绝。 |
| `SafeMode` | `<StateDirectory>\ledger.json` | `safeMode`（外加 `safeModeReason` 和 `safeModeAt`）。当它为 true 时，supervisor 拒绝重新拉起任何东西，即使出现了一张票据。 |

`-Mechanism Plugin|SafeMode|Both` —— `Both` 是默认值。这两种机制是**相互独立的**：清除安全模式不会重新启用一个被禁用的插件，反之亦然。两者都不会启动 supervisor。

```powershell
pwsh -File scripts/enable.ps1                                     # clear safe mode + enabled: true
pwsh -File scripts/enable.ps1 -Mechanism SafeMode -ClearHistory   # also empty uncleanStarts
pwsh -File scripts/enable.ps1 -Mechanism Plugin -AllowCreate      # append the row if absent
pwsh -File scripts/disable.ps1 -Mechanism SafeMode -Reason 'thermal incident 2026-06-01'
pwsh -File scripts/disable.ps1 -WhatIf                            # change nothing
```

| 参数 | 脚本 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `-Mechanism` | 两者 | `Both` | `Plugin`、`SafeMode` 或 `Both`（`ValidateSet`）。 |
| `-Profile` | 两者 | `web` | 要编辑其 `cordis.patch.yml` 的 profile。 |
| `-ProfileDirectory` | 两者 | `$env:DSH_HOME\profiles\<Profile>` | 在无法推导出该目录时使用。 |
| `-StateDirectory` | 两者 | `$env:DSH_HOME\restart`，否则 `<RepoPath>\.dsh-restart` | 存放 `ledger.json`。 |
| `-RepoPath` | 两者 | `scripts/` 的父目录 | 状态目录的回退值。 |
| `-ClearHistory` | enable | 关 | 与 `SafeMode` 一起使用时，还会清空 `uncleanStarts`。 |
| `-AllowCreate` | 两者 | 关 | 与 `Plugin` 一起使用时，创建/追加补丁记录，而不是拒绝。 |
| `-Reason` | disable | `manual_disable_by_operator` | 记录到账本中的 `safeModeReason`。 |
| `-WhatIf` | 两者 | 关 | 打印将会改变什么，不写入任何内容。 |

**它们拒绝猜测的东西。** 一份缺失的账本（`enable` 会拒绝：“the supervisor has never run, so there is no safe-mode flag to change”）、不可读的 JSON、不是对象的 JSON，或者既没有 `safeMode` 也没有 `schemaVersion` 的文档；一份为这个插件包含**多于一行**记录的补丁（“refusing to guess which one to edit”）；一行既没有 `config:` 块也没有 `enabled:` 键的记录；以及 —— 当缺少 `-AllowCreate` 时 —— 一份完全没有对应行的补丁：`FAIL: no row for this plugin in ...\profiles\web\cordis.patch.yml; expected a line like '- id: restart' or "- name: 'dsh-restart'"`，随后是 `note: pass -AllowCreate to append such a row instead of refusing`。

两个脚本都刻意写入**不带 BOM** 的 UTF-8：BOM 会让账本无法被 supervisor 的读取器解析，而那样看起来就像“没有账本”，并会静默地重新武装自动重启。它们还会以那条要紧的提醒收尾：

```text
  Configuration changes take effect on the next profile load: this script does not
  reload the running profile, and the plugin does not hot-swap its safety bounds.
  Safe mode is cleared for the SUPERVISOR: if it is not running, nothing will relaunch DS-Hns.
```

</details>

---

## 从安全模式恢复

安全模式是指崩溃循环熔断器跳闸后 supervisor 已停止重新拉起。DS-Hns 仍在运行；消失的是自动重新拉起。**先修好底层问题** —— 安全模式是刹车，不是故障。

```powershell
# 1. See where it stands.
Get-Content "$env:DSH_HOME\restart\ledger.json"
Select-String -Path "$env:DSH_HOME\restart\supervisor.log" -Pattern 'safe_mode|crash_loop'

# 2. Clear the flag, and the crashes that accumulated while it was set.
pwsh -File scripts/enable.ps1 -Mechanism SafeMode -ClearHistory

# 3. Clearing safe mode does NOT start the supervisor. Start it:
node bin/supervisor.mjs --state "$env:DSH_HOME\restart" --pid 4242 -- node dsh.js --profile web
```

在一次真实崩溃循环之后，账本**之前**的样子：

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

账本**之后**的样子 —— 这是脚本测试运行的真实输出，它打印了 `==> Clearing the crash-loop safe-mode flag in the ledger` 和 `done: cleared safeMode in ...\state\ledger.json (was True)`：

```json
{
  "schemaVersion":  1,
  "uncleanStarts":  [
                        {
                            "at":  "2026-06-01T08:59:00.000Z",
                            "reason":  "process_died_without_ticket"
                        }
                    ],
  "safeMode":  false,
  "safeModeReason":  null,
  "safeModeAt":  null,
  "relaunches":  2
}
```

（那次捕获是在省略 `-ClearHistory` 的情况下取得的，所以还留下了一条 `uncleanStarts` 记录。加上 `-ClearHistory` 时，这个数组也会被清空。）`disable.ps1` 是反向操作：它记录 `safeModeReason: "manual_disable_by_operator"` 和一个新的 `safeModeAt`。

---

## 配置参考

每个键都会深合并到 `DEFAULT_CONFIG` 之上，然后由 `resolveConfig()` 校验。一份无法被强制执行的
文档会被**拒绝，绝不修复** —— 插件会报告它并运行在默认值上；supervisor 会报告它并以非零码
退出。

<details>
<summary>每个键、它的默认值、它的作用以及修改它的风险</summary>

| 键 | 类型 | 默认值 | 作用 | 修改它的风险 |
| --- | --- | --- | --- | --- |
| `enabled` | boolean | `true` | 重启执行的主开关；为 false 时以 `DISABLED` 拒绝每一个请求 | 会静默地彻底移除重启能力 —— 而这正是降级中的主机可能想要的 |
| `applicationRestart.enabled` | boolean | `true` | 是否允许发生一次应用重启 | 关闭后就没有自动恢复路径；开启才是本意，因为进程本来就预期会回来 |
| `applicationRestart.minIntervalMs` | number ≥ 0 | `1200000`（20 分钟） | 两次应用重启之间的硬性下限；更早的请求会被拒绝，而不是排队 | 太小会允许重启风暴；太大会让运维人员在事故期间一直等待 |
| `systemRestart.enabled` | boolean | `false` | 操作系统重启三道独立闸门中的第一道 | 启用它才是让一个请求能够结束机器上所有其他程序的东西 |
| `systemRestart.minIntervalMs` | number ≥ 0 | `3600000`（60 分钟） | 两次系统重启之间的下限 | 太短会让一台出故障的机器被反复重启 |
| `allowedSources` | string[] | `dsh-health-scheduler`、`dsh-cli`、`operator` | 允许提交的来源；其他任何来源都是 `UNKNOWN_SOURCE` | 添加一个来源就赋予了它结束进程的能力；不能为空 |
| `allowedPriorities` | string[] | `low`、`normal`、`high`、`emergency` | 词汇表过滤器；优先级从不会绕过任何检查 | 收窄它会让请求方以 `INVALID_REQUEST` 失败，而不是被降级 |
| `allowSystemReboot` | boolean | `false` | 重启的第二道闸门；请求自身的确认是第三道 | 有了它并且启用了该模式，一个已确认的请求就可能重启整台机器 |
| `safety.checkpointRequired` | boolean | `true` | 一个要求检查点的请求是否必须拿到检查点 | 为 false 会让重启在没有安全点确认的情况下继续 —— 而这是设计所禁止的唯一一件事 |
| `safety.duplicateSuppression` | boolean | `true` | 被重放的 `requestId` 是返回先前的答案而不是再次行动 | 关闭后，重试的请求方就能提交两次；锁和冷却时间成为仅剩的防线 |
| `safety.crashLoopLimit` | number ≥ 1 | `3` | 窗口内触发熔断器的不干净启动次数 | 太低会让只有一次偶发崩溃的机器进入安全模式；太高会让真正的崩溃循环继续重新拉起 |
| `safety.crashLoopWindowMs` | number > 0 | `600000`（10 分钟） | 这些启动的滚动窗口 | 太短会让缓慢的崩溃循环躲过熔断器；太长会把不相关的崩溃累积成一次跳闸 |
| `safety.safeModeOnLoop` | boolean | `true` | 熔断器跳闸时是否也进入安全模式 | 为 false 时仍然会拒绝超出上限的重新拉起，但不记录 `safeMode` 标志，因此运维人员可依据的东西更少 |
| `safety.shutdownTimeoutMs` | number > 0 | `90000` | **checkpoint** 调用的预算；它*不是*对宿主退出的看门狗 | 设得太低会放弃缓慢的检查点；它并不会让挂起的关闭超时（见用例 4） |
| `safety.allowForceTerminate` | boolean | `false` | 本意是允许对一个超时的关闭执行强制终止 | **已校验但从未被读取。** 在本版本中修改它没有任何效果 |
| `safety.allowRestartWithoutSupervisor` | boolean | `false` | 在没有心跳的情况下是否仍可尝试重启 | 为 true 会把每个被接受的请求都变成一次大概率的中断：退出不等于重启 |
| `supervisor.heartbeatIntervalMs` | number > 0 | `5000` | Supervisor 的心跳间隔，两端都会读取 | 间隔太长会让插件在两次心跳之间宣告 supervisor 缺席 |
| `supervisor.heartbeatTimeoutMs` | number > 0 | `30000` | 超过这个年龄后 supervisor 就算作缺席 | 超时太短会让一台繁忙的机器拒绝合法重启 |
| `supervisor.relaunchTimeoutMs` | number > 0 | `90000` | supervisor 等待被重新拉起的 pid 存活多久，同时也是重试之间的延迟 | 太短会把一次缓慢但健康的启动算到熔断器头上 |
| `supervisor.launchCommand`, `.launchArgs`, `.launchCwd` | string[] / string 或 `null` | `null`、`[]`、`null` | 重新拉起命令、额外参数、工作目录；`launchCommand: null` 表示“复用 supervisor 自己的 argv” | 值写错会重新拉起错误的程序，或者在某个意想不到的地方解析相对 profile 路径；CLI 启动的 supervisor 根本不读这些键 |
| `supervisor.pollIntervalMs` | number > 0 | `1000` | supervisor 多久轮询一次退出 | 太小会持续轮询进程列表；太大则会在干净退出后推迟重新拉起 |
| `supervisor.ticketTtlMs` | number > 0 | `600000`（10 分钟） | 一张待处理票据保持有效多久 | 太短会让一个启动较晚的 supervisor 作废一张合法票据；太长则会让旧票据在事后仍被兑现 |
| `supervisor.detach` | boolean | `true` | 本意是以脱离方式运行 supervisor | 被 `deriveLaunchSpec()` **校验但从未读取**；`ChildProcessLauncher` 硬编码了 `detached: false` |
| `storage.directory` | string 或 `null` | `null` | 审计日志的目录覆盖；`null` 表示“与票据、心跳和账本相同的目录” | 把它指向临时路径会丢失线索；指向只读路径会让审计写入失败 |
| `storage.maxLogBytes` | number > 0 | `4194304`（4 MiB） | `restart-attempts.jsonl` 轮转为 `<path>.<timestamp>.bak` 的大小阈值 | 太大会在无人看管下增长磁盘占用；太小会把线索散落到许多 `.bak` 文件里 |
| `storage.maxRecentAttempts` | number ≥ 1 | `25` | 状态调用在内存中保留多少次尝试 | 只影响 `restart_status` 显示的内容；磁盘上的日志保留得更多 |
| `knownReasonCodes` | string[] | 九个代码 | 被接受而不会引发抱怨的原因码 | 这是给运维人员的文档，不是授权列表：未知代码只会被记录，不会被拒绝 |

</details>

**`resolveConfig()` 强制执行的三个跨字段约束。** 每一个都是加载时的拒绝，并会点名出有问题的点分路径：

| 约束 | 真实错误字符串 |
| --- | --- |
| `supervisor.heartbeatTimeoutMs` **必须大于** `supervisor.heartbeatIntervalMs` | `dsh-restart config: supervisor.heartbeatTimeoutMs must exceed supervisor.heartbeatIntervalMs (60000), received 30000` |
| `supervisor.relaunchTimeoutMs` **≥** `supervisor.heartbeatIntervalMs` | `dsh-restart config: supervisor.relaunchTimeoutMs must be at least supervisor.heartbeatIntervalMs (5000)` —— 由 `config.ts` 组合而成；那次本意是演练它的捕获运行先触发了心跳约束 |
| `allowedSources` **必须非空** | `dsh-restart config: allowedSources must list at least one source; an empty list would refuse every request, including an operator request` |

另有两个相邻的校验也值得了解，因为它们是静默的：`tryResolveConfig({ enabled: 'yes' })` 会报告 `dsh-restart config: enabled must be a boolean, received "yes"`，然后**回退到 `enabled: true`**；而 `crashLoopLimit` 会用 `Math.max(1, Math.trunc(...))` 做强制转换，所以 `0` 会变成 `1` 而不是报错。

---

## 调优指引

<details>
<summary>慢机器</summary>

失效特征是：健康的 supervisor 被宣告缺席，或者一次缓慢的启动被算到熔断器头上。要把这些预算一起提高：

```yaml
supervisor:
  heartbeatIntervalMs: 15000     # from 5000
  heartbeatTimeoutMs: 60000      # must stay above heartbeatIntervalMs
  relaunchTimeoutMs: 180000      # from 90000; must be >= heartbeatIntervalMs
  pollIntervalMs: 5000           # from 1000; a busy machine does not need 1 Hz polling
```

把 `heartbeatTimeoutMs` 保持在比 `heartbeatIntervalMs` 至少高出三次心跳的水平，并记住 `relaunchTimeoutMs` 同时也是重新拉起重试之间的延迟 —— 提高它会拖慢崩溃循环自身的检测。

</details>

<details>
<summary>重启必须很少发生的机器</summary>

让请求路径尽早拒绝而不是排队，并让熔断器更早跳闸：

```yaml
applicationRestart:
  minIntervalMs: 3600000         # from 1200000: one application restart per hour
safety:
  crashLoopLimit: 2              # from 3: trip after two unclean starts
  crashLoopWindowMs: 1800000     # from 600000: a wider window catches slow loops
  allowRestartWithoutSupervisor: false   # keep this false
```

提高 `minIntervalMs` 只改变*拒绝*的阈值：插件没有队列，所以冷却期内的请求会以 `COOLDOWN_ACTIVE` 被拒绝，而不是被延后。如果某个请求方绝不能被拒绝，那是一个调度决策，属于 `dsh-health-scheduler`，而不是这里。

</details>

<details>
<summary>没有检查点端口的部署</summary>

出厂默认是 `UnboundCheckpointPort`，它报告 `safe: false`，并让每个带 `checkpointRequired: true` 的请求以 `CHECKPOINT_FAILED` 失败。三个选项，从最好到最差：

1. **绑定一个真实端口。** 如果 harness 能调用进插件，就用 `FunctionCheckpointPort`；如果宿主只能发布一份就绪文档，就用 `FileCheckpointPort` —— 它读取 `{ "safe": true, "reason": "idle", "checkpoint_id": "ck-42", "resume_token": "rs-7" }`，并且默认把超过 60 秒的文件视为过期。
2. **只在存在检查点时才要求检查点。** 保留 `safety.checkpointRequired: true`，并让请求方对那些确实不需要检查点的重启发送 `checkpointRequired: false`。此时闸门会在没有检查点的情况下授权，而结果详情会说明这一点。
3. **全局关闭闸门**，用 `safety.checkpointRequired: false`。这会为每一个请求移除设计的核心保证，所以它是最后手段，而不是首选。

在这些选项之一被落实之前，预计 `restart_status` 会报告 `"capabilities": { "checkpointPort": false }`，并且每个请求都会被拒绝。

</details>

---

## 阅读审计日志

`restart-attempts.jsonl` 只追加，每行一个 JSON 对象，外层信封如下：

```json
{"schemaVersion":1,"kind":"restart-attempt","record":{ ... }}
```

`record` 是一个 `RestartAttemptRecord`：`requestId`、`ticketId`（没有写入任何东西时为 `null`）、`mode`、`source`、`reasonCode`、`state`、`startedAt`、`finishedAt`、`detail`、`clean`、`outcomeCode`。两行真实记录，都是拒绝：

```json
{"schemaVersion":1,"kind":"restart-attempt","record":{"requestId":"req-from-nowhere","ticketId":null,"mode":"application","source":"some-random-app","reasonCode":"OPERATOR_REQUEST","state":"rejected","startedAt":"2026-06-01T09:00:00.000Z","finishedAt":"2026-06-01T09:00:00.000Z","detail":"source \"some-random-app\" is not allowed; allowed sources: dsh-health-scheduler, dsh-cli, operator","clean":true,"outcomeCode":"UNKNOWN_SOURCE"}}
{"schemaVersion":1,"kind":"restart-attempt","record":{"requestId":"tool-1780000300000-119284","ticketId":null,"mode":"application","source":"dsh-cli","reasonCode":"OPERATOR_REQUEST","state":"rejected","startedAt":"2026-06-01T09:05:00.000Z","finishedAt":"2026-06-01T09:05:00.000Z","detail":"another restart is already in progress","clean":true,"outcomeCode":"RESTART_IN_FLIGHT"}}
```

**被接受、被拒绝、被中止和被取消的尝试都会被记录。** 一次被接受的应用重启会在响应返回*之前*写入，因此阅读日志的运维人员总能看到进程为什么即将消失；它的记录使用 `state: "shutting_down"`、`outcomeCode: "ACCEPTED"`，以及形如 `<response detail> (checkpoint <id|none>, reason <reasonCode>)` 的详情 —— 例如 `application restart accepted: the host is shutting down and the supervisor will relaunch it (checkpoint ck-2026-06-01T09-00-00, reason OPERATOR_REQUEST)`。中止使用 `state: "failed"`，并带有 `CHECKPOINT_FAILED`、`CHECKPOINT_REQUIRED`、`TICKET_WRITE_FAILED` 或 `SHUTDOWN_PORT_UNAVAILABLE`；取消使用 `state: "cancelled"`，带有 `outcomeCode: "CANCELLED"` 和详情 `the requester cancelled the pending restart`。

安全地读取它：

- **轮转。** 当文件达到 `storage.maxLogBytes`（默认 4 MiB）时，它会被重命名为一个 `.bak` 文件，其名字里带有一个 ISO 时间戳，其中 `:` 和 `.` 字符被替换为 `-`（因此形如 `restart-attempts.jsonl.2026-06-01T09-05-00-000Z.bak`），并创建一个新的空文件。读取不会跟进 `.bak` 文件；如果你需要完整的线索，请自行把它们拼接起来。
- **硬杀之后，末尾出现一行写了一半的内容是预期之中的**，并且会被容忍：无法解析为 JSON 的行会被跳过，而一条记录只有在 `kind` 为 `restart-attempt` **并且** `schemaVersion` 为 `1` 时才被接受。任何内容都不会被就地截断或修复。
- **写入失败会被吞掉**，计入 `RestartAuditLog.writeFailures`，并通过 `lastError` 暴露。在本版本中，这两者都不会出现在 `restart_status` 的负载里，所以一个已满或只读的目录会表现为审计行的*缺失*，而不是一个错误。

```powershell
# The last five recorded attempts, newest last.
Get-Content "$env:DSH_HOME\restart\restart-attempts.jsonl" -Tail 5 | ForEach-Object {
  $r = ($_ | ConvertFrom-Json).record
  '{0}  {1,-10} {2,-14} {3}' -f $r.finishedAt, $r.state, $r.outcomeCode, $r.detail
}
```

---

## 日志格式

### supervisor.log

每行一个 JSON 对象，同时也会镜像到 **stderr**。每个字段始终存在；没有内容时会省略 `detail`。

| 字段 | 含义 |
| --- | --- |
| `timestamp` | ISO-8601 时刻。 |
| `state` | `MONITORING`、`WAITING_FOR_EXIT`、`RELAUNCHING`、`WAITING_FOR_HEARTBEAT`、`VERIFIED`、`CRASH_LOOP`、`SAFE_MODE`、`STOPPED` 之一。 |
| `code` | 机器可读的事件码，便于 grep。 |
| `message` | 供人阅读的一行。 |
| `detail` | 可选对象，含事件相关的字段。 |

正常的一次重启，按顺序如下：

```json
{"timestamp":"2026-06-01T09:00:05.000Z","state":"MONITORING","code":"supervisor_started","message":"watching pid 4242","detail":{"supervisorPid":28868,"directory":"D:\\DS-Hns\\temp\\docs-sup-ok-lc9Gu6"}}
{"timestamp":"2026-06-01T09:00:05.000Z","state":"WAITING_FOR_EXIT","code":"restart_ticket_accepted","message":"restart_ticket_accepted","detail":{"ticketId":"application-1780304400000-1-e2efb725","mode":"application","pid":4242}}
{"timestamp":"2026-06-01T09:00:05.000Z","state":"RELAUNCHING","code":"relaunching","message":"relaunching","detail":{"reason":"expected_exit_observed"}}
{"timestamp":"2026-06-01T09:00:05.000Z","state":"WAITING_FOR_HEARTBEAT","code":"relaunched","message":"relaunched","detail":{"pid":10002}}
{"timestamp":"2026-06-01T09:00:05.000Z","state":"VERIFIED","code":"relaunch_verified","message":"relaunch_verified","detail":{"pid":10002}}
{"timestamp":"2026-06-01T09:00:05.000Z","state":"MONITORING","code":"monitoring_resumed","message":"monitoring_resumed","detail":{"pid":10002}}
```

`bin/supervisor.mjs` 会用 `supervisor_boot`（携带 `supervisorPid` 和解析出的 `launch` 数组）和 `supervisor_stopped`（携带整个运行结果：`state`、`reason`、`relaunches`、`safeMode`）把一次运行括起来。事故期间可以 grep 的事件码：

| 事件码 | 含义 |
| --- | --- |
| `restart_ticket_accepted` | 发现了一张可校验的票据；supervisor 现在正等待退出。 |
| `discarded_unverifiable_ticket` | 一张票据未通过校验并被删除；`detail.rejection` 说明原因。 |
| `adopted_ticket_pid` | 票据指定的 pid 与被监视的 pid 不同；票据胜出。 |
| `process_died_without_ticket` | 被监视的 pid 在没有票据的情况下消失了；计为一次不干净启动。 |
| `no_launch_command` | 无法推导出任何可用于重新拉起的内容；安全模式。 |
| `relaunch_failed` | 拉起本身失败了；计入熔断器。 |
| `relaunch_verification_failed` | 被重新拉起的 pid 在 `relaunchTimeoutMs` 之后不存活。 |
| `crash_loop_limit_reached` | 熔断器跳闸了。 |
| `safe_mode_entered`, `safe_mode_manual_action_required` | 自动化停止；需要人工介入。 |

### 退出码

| 码 | 含义 | 何时 |
| --- | --- | --- |
| `0` | 成功：本次运行正常结束 | `--help`；一次达到 tick 上限的有界运行（`supervisor_stopped`，原因 `TICK_LIMIT`）；一次在带 `--terminate-after-verify` 的重新拉起通过校验后结束的运行 |
| `1` | supervisor 自身失败 | 未知选项（`unknown supervisor option: --nope`），或 `main()` 中的致命错误 |
| `2` | 无法创建状态目录 | `--state <file>/sub`，其中 `<file>` 不是目录：`supervisor: cannot create state directory <dir>: <error>` |
| `3` | 必须有人来看一眼：安全模式，或者本次运行以原因 `CRASH_LOOP` 结束 | `ledger.json` 中熔断器跳闸（`SAFE_MODE`、`CRASH_LOOP`） |

---

## 运维人员可以运行的健康检查

```powershell
# 1. The entry point exists, runs, and prints usage. Exit 0 plus "Usage:" text.
node bin/supervisor.mjs --help

# 2. Is the supervisor alive, and what is it watching? A stale timestamp means absence:
#    the plugin declares it absent past supervisor.heartbeatTimeoutMs (30 s by default).
Get-Content "$env:DSH_HOME\restart\heartbeat.json"
# {"schemaVersion":1,"supervisorPid":28868,"watchedPid":10002,"state":"MONITORING","timestamp":"2026-06-01T09:00:05.000Z","sequence":7}

# 3. Is the installation sound? Builds nothing; checks the emitted lib/, the shipped
#    defaults, the refusals, the reason codes and the supervisor entry point.
npm run build
npm run verify:artifacts

# 4. The full suite: build, then every *.test.js, including the CLI exit codes and a
#    spawnSync check that each PowerShell script parses and advertises -WhatIf.
npm test

# 5. The ticket, if a restart is pending. A ticket that does not verify is deleted by the
#    supervisor, so its presence is normal and its absence is not necessarily a fault.
if (Test-Path "$env:DSH_HOME\restart\ticket.json") { Get-Content "$env:DSH_HOME\restart\ticket.json" }

# 6. The last few supervisor events, newest last.
Get-Content "$env:DSH_HOME\restart\supervisor.log" -Tail 10
```

一个健康的安装看起来是什么样：`restart_status` 报告 `can_restart: true`，原因为 `OK`，`supervisor.present: true` 且 `ageMs` 远低于超时，`crash_loop.tripped: false`，以及 `capabilities.checkpointPort: true`。一个健康的*降级*安装会报告 `capabilities.checkpointPort: false`，并且仍然完美地运行 DS-Hns —— 它只是无法授权重启，而这正是本插件被设计成会有的失效模式。
