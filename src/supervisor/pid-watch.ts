/**
 * PID watching.
 *
 * The supervisor's most important question is "is the harness still running?", and
 * it must answer it without any cooperation from the harness. On Windows a signal-0
 * probe is unreliable for a process owned by another session, so the default
 * implementation shells out to `tasklist` and parses its CSV output; a cheap
 * signal-0 probe answers first when it can.
 *
 * @module dsh-restart/supervisor/pid-watch
 */

import { execFile } from 'node:child_process'

/** Why a liveness probe could not answer. */
export type LivenessError = 'probe_failed' | 'unsupported'

/** One liveness answer. */
export interface LivenessResult {
  /** Whether the process is running. `null` when the probe could not tell. */
  readonly alive: boolean | null
  /** How the answer was obtained. */
  readonly method: 'signal0' | 'tasklist' | 'ps' | 'none'
  /** Error classification when `alive` is `null`. */
  readonly error: LivenessError | null
  /** Human-readable detail, safe to log. */
  readonly detail: string
}

/** The probe interface, so tests can drive the watcher without real processes. */
export interface LivenessProbe {
  /** Whether the process with this pid exists. */
  check(pid: number): Promise<LivenessResult>
}

/** A probe backed by the platform's process list. */
export class SystemLivenessProbe implements LivenessProbe {
  private readonly platform: NodeJS.Platform
  private readonly runner: (file: string, args: readonly string[]) => Promise<{ readonly stdout: string; readonly code: number }>

  constructor(options: {
    readonly platform?: NodeJS.Platform
    readonly runner?: (file: string, args: readonly string[]) => Promise<{ readonly stdout: string; readonly code: number }>
  } = {}) {
    this.platform = options.platform ?? process.platform
    this.runner = options.runner ?? runCapture
  }

  async check(pid: number): Promise<LivenessResult> {
    if (!Number.isInteger(pid) || pid <= 0) {
      return { alive: false, method: 'none', error: null, detail: `pid ${pid} is not a valid process id` }
    }

    // A signal-0 probe is free and answers correctly for our own children, which
    // is the common case on a relaunch. It cannot see a process in another
    // Windows session, so a negative answer is confirmed by the process list.
    try {
      process.kill(pid, 0)
      return { alive: true, method: 'signal0', error: null, detail: `pid ${pid} answered signal 0` }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM') {
        // The process exists but belongs to somebody else.
        return { alive: true, method: 'signal0', error: null, detail: `pid ${pid} exists but denies signals` }
      }
    }

    if (this.platform === 'win32') {
      const result = await this.runner('tasklist.exe', [
        '/FI',
        `PID eq ${pid}`,
        '/NH',
        '/FO',
        'CSV',
      ])
      if (result.code !== 0) {
        return {
          alive: null,
          method: 'tasklist',
          error: 'probe_failed',
          detail: `tasklist exited with ${result.code}`,
        }
      }
      const alive = parseTasklistOutput(result.stdout, pid)
      return {
        alive,
        method: 'tasklist',
        error: null,
        detail: alive ? `tasklist lists pid ${pid}` : `tasklist does not list pid ${pid}`,
      }
    }

    const result = await this.runner('ps', ['-o', 'pid=', '-p', String(pid)])
    if (result.code !== 0) {
      return { alive: null, method: 'ps', error: 'probe_failed', detail: `ps exited with ${result.code}` }
    }
    const alive = result.stdout.trim() !== ''
    return { alive, method: 'ps', error: null, detail: alive ? `ps lists pid ${pid}` : `ps does not list pid ${pid}` }
  }
}

/**
 * Parse `tasklist /NH /FO CSV` output.
 *
 * The format is `"name","pid","session","session#","mem"`, and when no process
 * matches, tasklist prints an informational line that is also CSV-quoted. Both are
 * handled here so the parser cannot mistake "no tasks" for "pid 0".
 */
export function parseTasklistOutput(stdout: string, pid: number): boolean {
  const wanted = String(pid)
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('INFO:')) continue
    const fields = trimmed
      .split(',')
      .map((field) => field.trim().replace(/^"|"$/g, ''))
    if (fields.length >= 2 && fields[1] === wanted) return true
  }
  return false
}

/** A probe whose answers a test controls. */
export class ScriptedLivenessProbe implements LivenessProbe {
  private readonly answers: LivenessResult[]
  private readonly fallback: LivenessResult
  /** Every pid checked, in order. */
  readonly checks: number[] = []

  constructor(answers: readonly LivenessResult[], fallback: LivenessResult = { alive: true, method: 'signal0', error: null, detail: 'scripted' }) {
    this.answers = [...answers]
    this.fallback = fallback
  }

  check(pid: number): Promise<LivenessResult> {
    this.checks.push(pid)
    const next = this.answers.shift()
    return Promise.resolve(next ?? this.fallback)
  }
}

/** Capture a command's stdout without a shell. */
function runCapture(file: string, args: readonly string[]): Promise<{ readonly stdout: string; readonly code: number }> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error === null) {
          resolve({ stdout: String(stdout ?? ''), code: 0 })
          return
        }
        const code = typeof (error as unknown as { code?: number }).code === 'number'
          ? ((error as unknown as { code: number }).code as number)
          : 1
        resolve({ stdout: String(stdout ?? ''), code })
      },
    )
  })
}
