/**
 * Relaunching DS-Hns.
 *
 * The supervisor's only privileged action. It launches a process and hands back a
 * pid; it never inspects the process's arguments for meaning, never touches task
 * state, and never decides anything about the harness's work.
 *
 * @module dsh-restart/supervisor/relaunch
 */

import { spawn } from 'node:child_process'
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
