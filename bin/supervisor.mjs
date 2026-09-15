#!/usr/bin/env node
/**
 * The restart supervisor entry point.
 *
 * Run this *around* DS-Hns, once, as a long-lived process:
 *
 * ```sh
 * node bin/supervisor.mjs --state "%DSH_HOME%\restart" -- node dsh.js --profile web
 * ```
 *
 * Everything after `--` is the command the supervisor relaunches. When `--` is
 * absent the supervisor derives the launch command from its own `argv`, which is
 * the normal deployment: the supervisor is started by the same command line that
 * starts DS-Hns, so it relaunches exactly what it was given.
 *
 * It writes its own log next to the ticket, and it exits non-zero when it ends in
 * safe mode, so a wrapper script or the Task Scheduler can see that a human is
 * needed.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RestartSupervisor } from '../lib/supervisor/index.js'
import { SystemProcessTerminator } from '../lib/supervisor/relaunch.js'
import { resolveConfig } from '../lib/shared/config.js'

/** Parse the supervisor's own flags. Unknown flags are an error, not a guess. */
export function parseArgs(argv) {
  const options = {
    state: null,
    watchPid: null,
    launch: null,
    tickMs: null,
    maxTicks: null,
    terminateAfterVerify: false,
    help: false,
  }
  let index = 0
  while (index < argv.length) {
    const token = argv[index]
    if (token === '--') {
      options.launch = argv.slice(index + 1)
      break
    }
    switch (token) {
      case '--state':
        options.state = argv[++index] ?? null
        break
      case '--pid':
        options.watchPid = Number(argv[++index])
        break
      case '--tick-ms':
        options.tickMs = Number(argv[++index])
        break
      case '--max-ticks':
        options.maxTicks = Number(argv[++index])
        break
      case '--terminate-after-verify':
        options.terminateAfterVerify = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`unknown supervisor option: ${token}`)
    }
    index += 1
  }
  return options
}

const USAGE = `dsh-restart supervisor

Usage:
  node bin/supervisor.mjs [options] [-- <launch command>]

Options:
  --state <dir>              directory holding ticket.json, heartbeat.json and ledger.json
                             (default: %DSH_HOME%\\restart, else ./.dsh-restart)
  --pid <pid>                watch this pid instead of the parent process
  --tick-ms <ms>             poll interval (default: supervisor.pollIntervalMs)
  --max-ticks <n>            stop after n ticks (default: run until a terminal state)
  --terminate-after-verify   exit after a relaunch is verified, instead of resuming
  -h, --help                 show this message

Everything after \`--\` is the command used to relaunch DS-Hns. Without it, the
supervisor relaunches the command that started it.
`

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(USAGE)
    return 0
  }

  // `--` with nothing after it means "no explicit command", not "an empty command":
  // treat it exactly like omitting the separator, so the supervisor falls back to
  // relaunching the command that started it.
  const explicitLaunch = options.launch !== null && options.launch.length > 0 ? options.launch : null
  const config = resolveConfig(
    explicitLaunch === null ? {} : { supervisor: { launchCommand: explicitLaunch, detach: false } },
  )

  const stateDirectory =
    options.state ??
    (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? join(process.env.DSH_HOME.trim(), 'restart')
      : join(process.cwd(), '.dsh-restart'))

  try {
    mkdirSync(stateDirectory, { recursive: true })
  } catch (error) {
    process.stderr.write(`supervisor: cannot create state directory ${stateDirectory}: ${error.message}\n`)
    return 2
  }

  const logPath = join(stateDirectory, 'supervisor.log')
  const emit = (event) => {
    const line = `${JSON.stringify(event)}\n`
    process.stderr.write(line)
    try {
      appendFileSync(logPath, line, 'utf8')
    } catch {
      // A log that cannot be written must not stop supervision.
    }
  }

  const supervisor = new RestartSupervisor({
    config,
    directory: stateDirectory,
    ...(options.watchPid === null || !Number.isFinite(options.watchPid) ? {} : { watchPid: options.watchPid }),
    terminateAfterVerify: options.terminateAfterVerify,
    // Bound only when the configuration permits it, so the shipped supervisor cannot
    // end a process at all: a hung shutdown becomes an abandoned restart unless an
    // operator has explicitly asked for the stronger behaviour.
    terminator: config.safety.allowForceTerminate ? new SystemProcessTerminator() : null,
    onEvent: emit,
  })

  emit({
    timestamp: new Date().toISOString(),
    state: 'MONITORING',
    code: 'supervisor_boot',
    message: `watching pid ${supervisor.pid} in ${stateDirectory}`,
    detail: { supervisorPid: process.pid, launch: options.launch },
  })

  const runOptions = {}
  if (options.tickMs !== null && Number.isFinite(options.tickMs)) runOptions.tickMs = options.tickMs
  if (options.maxTicks !== null && Number.isFinite(options.maxTicks)) runOptions.maxTicks = options.maxTicks

  // Every timer inside the supervisor is deliberately `unref`'d, so that a supervisor
  // can never hold a host process open. The side effect is that a bare `run()` has
  // nothing keeping the event loop alive between polls, and Node drains the loop
  // during the first tick: the supervisor would log "supervisor_boot" and exit
  // without supervising anything, never reaching a terminal state.
  //
  // This entry point therefore holds the loop open itself, and releases it as soon as
  // the run reaches a terminal state. The library keeps its unref'd timers, so an
  // embedder that calls `run()` is still never held open against its will.
  // The interval must stay inside the 32-bit millisecond range: 2 ** 31 - 1 wraps
  // to 1 ms and turns this into a busy loop. An hour is far longer than the gap
  // between two polls, so it never fires in practice.
  const keepAlive = setInterval(() => {}, 60 * 60 * 1000)
  let result
  try {
    result = await supervisor.run(runOptions)
  } finally {
    clearInterval(keepAlive)
  }
  emit({
    timestamp: new Date().toISOString(),
    state: result.state,
    code: 'supervisor_stopped',
    message: `supervisor finished: ${result.reason}`,
    detail: result,
  })

  // Safe mode is exit code 3 on purpose: it is neither success nor a crash, and a
  // wrapper should be able to tell "a human must look at this" from "it worked".
  if (result.safeMode) return 3
  return result.reason === 'CRASH_LOOP' ? 3 : 0
}

// `pathToFileURL` is the only reliable way to compare a path against
// `import.meta.url` on Windows. The previous hand-rolled form produced
// `file://D:/...`, which never matched this module's `file:///D:/...`, so the
// script exited 0 without starting a supervisor at all.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      process.stderr.write(`supervisor: fatal: ${error?.stack ?? String(error)}\n`)
      process.exitCode = 1
    },
  )
}
