/**
 * The three external seams, and their real implementations.
 *
 * Everything `dsh-restart` cannot do for itself lives behind a port. Keeping them
 * in one module makes the boundary auditable: this file is the only place in the
 * plugin that talks to the host, to a file, or to an operating-system command, and
 * each of those three is a small, named class rather than an inline call.
 *
 * @module dsh-restart/ports
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type {
  CheckpointOutcome,
  CheckpointPort,
  ShutdownPort,
  SystemShutdownPort,
} from '../shared/types.js'
import type { RestartMode } from '../shared/protocol.js'

/**
 * The host's own lifecycle, reached through a callback.
 *
 * DS-Hns owns its shutdown; this port exists so the plugin can *ask*. The default
 * implementation records the request and lets the caller decide, because a library
 * that calls `process.exit` on its own is the exact failure mode the design forbids.
 */
export interface HostLifecycle {
  /**
   * Ask the host to shut down gracefully.
   *
   * @param reason - the restart ticket id.
   * @returns `true` when the host accepted and an exit is expected.
   */
  requestShutdown(reason: string): Promise<boolean> | boolean
}

/** A lifecycle whose requests are accepted and recorded but never acted on. */
export class RecordingLifecycle implements HostLifecycle {
  /** Every shutdown reason seen, in order. */
  readonly requests: string[] = []
  private readonly accept: boolean
  private readonly onRequest: ((reason: string) => void) | null

  constructor(options: { readonly accept?: boolean; readonly onRequest?: (reason: string) => void } = {}) {
    this.accept = options.accept !== false
    this.onRequest = options.onRequest ?? null
  }

  requestShutdown(reason: string): boolean {
    this.requests.push(reason)
    this.onRequest?.(reason)
    return this.accept
  }
}

/** A shutdown port over a {@link HostLifecycle}. */
export class HostShutdownPort implements ShutdownPort {
  readonly id = 'host-lifecycle'
  private readonly lifecycle: HostLifecycle
  private readonly timeoutMs: number

  constructor(lifecycle: HostLifecycle, timeoutMs = 5_000) {
    this.lifecycle = lifecycle
    this.timeoutMs = timeoutMs
  }

  async requestShutdown(reason: string): Promise<boolean> {
    const answer = await withTimeout(Promise.resolve(this.lifecycle.requestShutdown(reason)), this.timeoutMs)
    return answer === true
  }
}

/**
 * A checkpoint port over a caller-supplied function.
 *
 * The harness plugs its own `prepareForRestart`/`createCheckpoint` in here. The
 * plugin does not provide a default that reports success: see
 * {@link UnboundCheckpointPort}, which is what an unconfigured install gets.
 */
export class FunctionCheckpointPort implements CheckpointPort {
  readonly id: string
  private readonly prepare: (mode: RestartMode) => Promise<CheckpointOutcome> | CheckpointOutcome
  private readonly acknowledge: (resumeToken: string | null) => Promise<boolean> | boolean

  constructor(options: {
    readonly id?: string
    readonly prepare: (mode: RestartMode) => Promise<CheckpointOutcome> | CheckpointOutcome
    readonly acknowledge?: (resumeToken: string | null) => Promise<boolean> | boolean
  }) {
    this.id = options.id ?? 'function-checkpoint'
    this.prepare = options.prepare
    this.acknowledge = options.acknowledge ?? (() => true)
  }

  prepareForRestart(mode: RestartMode): Promise<CheckpointOutcome> | CheckpointOutcome {
    return this.prepare(mode)
  }

  acknowledgeResume(resumeToken: string | null): Promise<boolean> | boolean {
    return this.acknowledge(resumeToken)
  }
}

/**
 * A checkpoint port that reads the harness's own readiness file.
 *
 * This is the deployment-friendly option: a host that cannot call into this plugin
 * can still publish its readiness as a small JSON document, which is exactly the
 * seam the design describes for `getMaintenanceReadiness()`.
 *
 * ```json
 * { "safe": true, "reason": "idle", "checkpoint_id": "ck-42", "resume_token": "rs-7" }
 * ```
 */
export class FileCheckpointPort implements CheckpointPort {
  readonly id = 'file-checkpoint'
  private readonly path: string
  private readonly staleAfterMs: number
  private readonly now: () => number

  constructor(options: { readonly path: string; readonly staleAfterMs?: number; readonly now?: () => number }) {
    this.path = options.path
    this.staleAfterMs = options.staleAfterMs ?? 60_000
    this.now = options.now ?? (() => Date.now())
  }

  prepareForRestart(): CheckpointOutcome {
    if (!existsSync(this.path)) {
      return {
        safe: false,
        reason: 'readiness_file_missing',
        checkpointId: null,
        resumeToken: null,
        completed: false,
        detail: `no readiness file at ${this.path}`,
      }
    }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>
    } catch (error) {
      return {
        safe: false,
        reason: 'readiness_file_unreadable',
        checkpointId: null,
        resumeToken: null,
        completed: false,
        detail: `could not read ${this.path}: ${(error as Error).message}`,
      }
    }

    const writtenAt = typeof parsed.written_at === 'string' ? Date.parse(parsed.written_at) : Number.NaN
    if (Number.isFinite(writtenAt) && this.now() - writtenAt > this.staleAfterMs) {
      return {
        safe: false,
        reason: 'readiness_file_stale',
        checkpointId: null,
        resumeToken: null,
        completed: false,
        detail: `the readiness file was last written ${Math.round((this.now() - writtenAt) / 1000)}s ago`,
      }
    }

    return {
      safe: parsed.safe === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'unspecified',
      checkpointId: typeof parsed.checkpoint_id === 'string' ? parsed.checkpoint_id : null,
      resumeToken: typeof parsed.resume_token === 'string' ? parsed.resume_token : null,
      completed: parsed.safe === true,
      detail: `readiness file ${this.path} reports safe=${String(parsed.safe === true)}`,
    }
  }

  acknowledgeResume(): boolean {
    // Consumption of the resume token is the harness's business; the file port has
    // nothing to write, and claiming otherwise would be a lie.
    return true
  }
}

/**
 * The Windows system-restart port.
 *
 * The **only** place in this repository that can reboot a machine, and it is a
 * separate port so that "restart the app" keeps working on a machine where
 * rebooting is not permitted. `execFile` is used without a shell, so nothing in a
 * reason string can become a command.
 *
 * The default command is `shutdown.exe /r /t <delay> /d p:4:1` — the `p:4:1`
 * reason code is Windows' "operating system: recovery (planned)" and it is what
 * makes the reboot show up as planned in the event log rather than as a crash.
 */
export class WindowsSystemShutdownPort implements SystemShutdownPort {
  readonly id = 'windows-system-restart'
  private readonly argv: readonly string[]
  private readonly runner: (file: string, args: readonly string[]) => Promise<{ readonly code: number; readonly stderr: string }>

  constructor(options: {
    /** Override the command; the first element is the executable. */
    readonly command?: readonly string[]
    readonly runner?: (file: string, args: readonly string[]) => Promise<{ readonly code: number; readonly stderr: string }>
  } = {}) {
    this.argv = options.command ?? []
    this.runner = options.runner ?? runProcess
  }

  async requestSystemRestart(reason: string, delaySeconds: number): Promise<boolean> {
    const args =
      this.argv.length > 0
        ? [...this.argv.slice(1), String(delaySeconds), reason]
        : ['/r', '/t', String(Math.max(0, Math.round(delaySeconds))), '/d', 'p:4:1', '/c', truncate(reason, 200)]
    const file = this.argv[0] ?? 'shutdown.exe'
    const result = await this.runner(file, args)
    return result.code === 0
  }
}

/** The real process runner: no shell, bounded output, no inherited stdio. */
export function runProcess(
  file: string,
  args: readonly string[],
): Promise<{ readonly code: number; readonly stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1024 },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stderr: String(stderr ?? '') })
          return
        }
        const code = typeof (error as NodeJS.ErrnoException & { code?: number | string }).code === 'number'
          ? ((error as unknown as { code: number }).code as number)
          : 1
        resolve({ code, stderr: `${error.message}\n${String(stderr ?? '')}`.trim() })
      },
    )
  })
}

/** Resolve after `ms`, keeping the timer unref'd so it cannot hold the loop open. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** Race a promise against a budget. */
async function withTimeout<T>(value: Promise<T>, timeoutMs: number): Promise<T | null> {
  if (timeoutMs <= 0) return value
  let timedOut = false
  const timer = (async () => {
    await delay(timeoutMs)
    timedOut = true
  })()
  const result = await Promise.race([value, timer.then(() => null)])
  if (timedOut) return null
  return result
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}

/** Options for {@link spawnSupervisor}. */
export interface SpawnSupervisorOptions {
  /** Executable to run. Defaults to `process.execPath` (the Node binary). */
  readonly nodePath?: string
  /** Path of the supervisor entry script. */
  readonly scriptPath: string
  /** Arguments to pass through to the supervisor. */
  readonly args?: readonly string[]
  /** Detach the child so it survives this process. Defaults to `true`. */
  readonly detach?: boolean
  /** Working directory for the child. */
  readonly cwd?: string
  /** Environment for the child. */
  readonly env?: NodeJS.ProcessEnv
}

/** A launched supervisor. */
export interface SpawnedSupervisor {
  readonly pid: number
  readonly detached: boolean
}

/**
 * Launch the supervisor as a detached process.
 *
 * Detaching is the point: the supervisor must outlive the process it is watching,
 * so it cannot be a child that dies with it. Stdio is ignored for the same reason —
 * there is no terminal left to write to once the parent is gone. The supervisor
 * writes its own log file.
 */
export function spawnSupervisor(options: SpawnSupervisorOptions): SpawnedSupervisor {
  const detached = options.detach !== false
  const child = spawn(options.nodePath ?? process.execPath, [options.scriptPath, ...(options.args ?? [])], {
    detached,
    stdio: 'ignore',
    windowsHide: true,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  })
  if (detached) child.unref()
  return { pid: child.pid ?? -1, detached }
}
