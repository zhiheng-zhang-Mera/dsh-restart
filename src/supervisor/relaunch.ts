/**
 * Relaunching DS-Hns.
 *
 * The supervisor's only privileged action. It launches a process and hands back a
 * pid; it never inspects the process's arguments for meaning, never touches task
 * state, and never decides anything about the harness's work.
 *
 * @module dsh-restart/supervisor/relaunch
 */

import { execFile, spawn } from 'node:child_process'
import type { SupervisorConfig } from '../shared/types.js'

/** A launch specification. */
export interface LaunchSpec {
  /** Executable path. */
  readonly file: string
  /** Arguments. */
  readonly args: readonly string[]
  /** Working directory, or `null` for the supervisor's own. */
  readonly cwd: string | null
  /** Extra environment entries. */
  readonly env: Readonly<Record<string, string>>
}

/** The outcome of one launch attempt. */
export interface LaunchResult {
  readonly pid: number
  readonly ok: boolean
  readonly detail: string
}

/** What the supervisor uses to start a process. */
export interface ProcessLauncher {
  /** Start one process. */
  launch(spec: LaunchSpec): Promise<LaunchResult>
}

/**
 * What the supervisor uses to end a process that ignored its graceful shutdown.
 *
 * Deliberately separate from {@link ProcessLauncher}, and deliberately optional: the
 * default supervisor cannot terminate anything, so "the shutdown hung" produces an
 * abandoned restart rather than a kill. A deployment that wants the stronger
 * behaviour has to inject this and turn on `safety.allowForceTerminate`.
 */
export interface ProcessTerminator {
  /** End the process. */
  terminate(pid: number): Promise<{ readonly ok: boolean; readonly detail: string }>
}

/** Terminates processes with `taskkill` on Windows and `SIGKILL` elsewhere. */
export class SystemProcessTerminator implements ProcessTerminator {
  private readonly platform: NodeJS.Platform
  private readonly runner: (file: string, args: readonly string[]) => Promise<{ readonly code: number; readonly stderr: string }>

  constructor(options: {
    readonly platform?: NodeJS.Platform
    readonly runner?: (file: string, args: readonly string[]) => Promise<{ readonly code: number; readonly stderr: string }>
  } = {}) {
    this.platform = options.platform ?? process.platform
    this.runner = options.runner ?? runTerminate
  }

  async terminate(pid: number): Promise<{ readonly ok: boolean; readonly detail: string }> {
    if (this.platform === 'win32') {
      // `/T` also ends the process's children, which is what a launcher tree needs.
      const result = await this.runner('taskkill.exe', ['/PID', String(pid), '/T', '/F'])
      return result.code === 0
        ? { ok: true, detail: `taskkill terminated pid ${pid} and its children` }
        : { ok: false, detail: `taskkill exited with ${result.code}: ${result.stderr}` }
    }
    try {
      process.kill(pid, 'SIGKILL')
      return { ok: true, detail: `SIGKILL sent to pid ${pid}` }
    } catch (error) {
      return { ok: false, detail: `SIGKILL failed: ${(error as Error).message}` }
    }
  }
}

/** A terminator a test drives. */
export class ScriptedTerminator implements ProcessTerminator {
  /** Every pid passed to {@link terminate}, in order. */
  readonly calls: number[] = []
  private readonly result: { readonly ok: boolean; readonly detail: string }

  constructor(result: { readonly ok: boolean; readonly detail: string } = { ok: true, detail: 'scripted termination' }) {
    this.result = result
  }

  terminate(pid: number): Promise<{ readonly ok: boolean; readonly detail: string }> {
    this.calls.push(pid)
    return Promise.resolve(this.result)
  }
}

/** Run `taskkill` without a shell. */
function runTerminate(
  file: string,
  args: readonly string[],
): Promise<{ readonly code: number; readonly stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, [...args], { windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1024 }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stderr: String(stderr ?? '') })
        return
      }
      const code = typeof (error as unknown as { code?: number }).code === 'number'
        ? ((error as unknown as { code: number }).code as number)
        : 1
      resolve({ code, stderr: `${error.message}\n${String(stderr ?? '')}`.trim() })
    })
  })
}

/**
 * Derive the relaunch command.
 *
 * Resolution order, most explicit first:
 *
 * 1. `supervisor.launchCommand` from the configuration.
 * 2. The supervisor's own `argv`, when the supervisor was started by the same
 *    command that started DS-Hns — which is the normal case and the reason the
 *    default needs no configuration at all.
 */
export function deriveLaunchSpec(options: {
  readonly config: SupervisorConfig
  readonly supervisorArgv: readonly string[]
  readonly supervisorCwd: string
  readonly env?: Readonly<Record<string, string>>
}): LaunchSpec | null {
  const configured = options.config.launchCommand
  if (configured !== null && configured.length > 0) {
    const [file, ...rest] = configured
    if (file === undefined || file.trim() === '') return null
    return {
      file,
      args: [...rest, ...options.config.launchArgs],
      cwd: options.config.launchCwd ?? options.supervisorCwd,
      env: options.env ?? {},
    }
  }
  const file = options.supervisorArgv[0]
  if (file === undefined || file.trim() === '') return null
  return {
    file,
    args: [...options.supervisorArgv.slice(1), ...options.config.launchArgs],
    cwd: options.config.launchCwd ?? options.supervisorCwd,
    env: options.env ?? {},
  }
}

/** Launches processes with `node:child_process`. */
export class ChildProcessLauncher implements ProcessLauncher {
  private readonly recordStdio: boolean

  constructor(options: { readonly recordStdio?: boolean } = {}) {
    this.recordStdio = options.recordStdio === true
  }

  launch(spec: LaunchSpec): Promise<LaunchResult> {
    return new Promise((resolve) => {
      try {
        const child = spawn(spec.file, [...spec.args], {
          detached: false,
          // The relaunched process must not hold the supervisor's stdio open, or a
          // supervisor that outlives its child would leak descriptors.
          stdio: this.recordStdio ? ['ignore', 'pipe', 'pipe'] : 'ignore',
          windowsHide: true,
          cwd: spec.cwd ?? process.cwd(),
          env: { ...process.env, ...spec.env },
        })
        child.once('error', (error) => {
          resolve({ pid: child.pid ?? -1, ok: false, detail: `spawn failed: ${error.message}` })
        })
        child.once('spawn', () => {
          resolve({ pid: child.pid ?? -1, ok: true, detail: `launched ${spec.file} as pid ${child.pid ?? -1}` })
        })
        child.unref()
      } catch (error) {
        resolve({ pid: -1, ok: false, detail: `spawn threw: ${(error as Error).message}` })
      }
    })
  }
}

/** A launcher a test drives. */
export class ScriptedLauncher implements ProcessLauncher {
  private readonly results: LaunchResult[]
  private readonly fallback: LaunchResult
  /** Every spec passed to {@link launch}, in order. */
  readonly specs: LaunchSpec[] = []
  private nextPid: number

  constructor(options: {
    readonly results?: readonly LaunchResult[]
    readonly fallback?: LaunchResult
    readonly startPid?: number
  } = {}) {
    this.results = [...(options.results ?? [])]
    this.nextPid = options.startPid ?? 10_000
    this.fallback = options.fallback ?? { pid: this.nextPid, ok: true, detail: 'scripted launch' }
  }

  launch(spec: LaunchSpec): Promise<LaunchResult> {
    this.specs.push(spec)
    const next = this.results.shift()
    if (next !== undefined) return Promise.resolve(next)
    this.nextPid += 1
    return Promise.resolve({ ...this.fallback, pid: this.fallback.pid === -1 ? -1 : this.nextPid })
  }
}
