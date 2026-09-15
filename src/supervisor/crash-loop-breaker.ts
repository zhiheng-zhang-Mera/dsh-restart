/**
 * The crash-loop breaker.
 *
 * The design's promise for this plugin is a bounded failure: "restart 插件坏掉时，最坏情况只能是
 * 失去自动重启，不能导致 DS-Hns 永久无法启动". A supervisor that relaunches a
 * process which immediately dies again is the way that promise gets broken, so the
 * breaker counts unclean starts inside a window and, past the limit, stops
 * relaunching and enters safe mode.
 *
 * Safe mode does not mean "DS-Hns cannot run". It means "DS-Hns runs without this
 * plugin's automation", which is a state a human can fix.
 *
 * @module dsh-restart/supervisor/crash-loop-breaker
 */

import type { CrashLoopState } from '../shared/protocol.js'
import type { SafetyConfig } from '../shared/types.js'
import type { SupervisorLedger } from '../shared/protocol.js'

/** A recorded unclean start. */
export interface UncleanStart {
  readonly atMs: number
  readonly reason: string
}

/** The breaker's verdict. */
export interface BreakerVerdict {
  /** Whether another relaunch is allowed. */
  readonly allowed: boolean
  /** Whether the breaker is now tripped. */
  readonly tripped: boolean
  /** Machine-readable reason when not allowed. */
  readonly reason: string | null
  /** Unclean starts currently inside the window. */
  readonly failuresInWindow: number
  /** The configured limit. */
  readonly limit: number
}

/**
 * Counts unclean starts and decides whether to keep relaunching.
 *
 * The window is rolling: an unclean start from an hour ago does not count against a
 * limit measured in minutes, otherwise a machine that crashed once a day would
 * eventually trip a breaker that was meant for a machine crashing once a minute.
 */
export class CrashLoopBreaker {
  private readonly config: SafetyConfig
  private starts: UncleanStart[] = []
  private tripped = false
  private trippedAtMs: number | null = null
  private reason: string | null = null

  constructor(options: { readonly config: SafetyConfig; readonly ledger?: SupervisorLedger }) {
    this.config = options.config
    if (options.ledger !== undefined) {
      this.tripped = options.ledger.safeMode
      this.reason = options.ledger.safeModeReason
      this.trippedAtMs = options.ledger.safeModeAt === null ? null : Date.parse(options.ledger.safeModeAt)
      this.starts = options.ledger.uncleanStarts
        .map((entry) => ({ atMs: Date.parse(entry.at), reason: entry.reason }))
        .filter((entry) => Number.isFinite(entry.atMs))
    }
  }

  /** Unclean starts inside the window at `nowMs`. */
  inWindow(nowMs: number): readonly UncleanStart[] {
    const cutoff = nowMs - this.config.crashLoopWindowMs
    return this.starts.filter((entry) => entry.atMs >= cutoff)
  }

  /** Whether the breaker is currently tripped. */
  get isTripped(): boolean {
    return this.tripped
  }

  /** Why it tripped, or `null`. */
  get tripReason(): string | null {
    return this.reason
  }

  /**
   * Record an unclean start and return the verdict for the next relaunch.
   *
   * @param reason - machine-readable cause, e.g. `no_heartbeat_after_relaunch`.
   * @param nowMs - instant of the observation.
   */
  recordUncleanStart(reason: string, nowMs: number): BreakerVerdict {
    // Drop anything that has aged out before counting, so the window is rolling.
    const cutoff = nowMs - this.config.crashLoopWindowMs
    this.starts = this.starts.filter((entry) => entry.atMs >= cutoff)
    this.starts.push({ atMs: nowMs, reason })

    const failuresInWindow = this.starts.length
    if (failuresInWindow >= this.config.crashLoopLimit) {
      this.tripped = true
      this.trippedAtMs = nowMs
      this.reason = reason
      return {
        allowed: false,
        tripped: true,
        reason: 'CRASH_LOOP',
        failuresInWindow,
        limit: this.config.crashLoopLimit,
      }
    }
    return {
      allowed: true,
      tripped: false,
      reason: null,
      failuresInWindow,
      limit: this.config.crashLoopLimit,
    }
  }

  /** The verdict for a relaunch, without recording anything. */
  verdict(nowMs: number): BreakerVerdict {
    if (this.tripped) {
      return {
        allowed: false,
        tripped: true,
        reason: 'CRASH_LOOP',
        failuresInWindow: this.inWindow(nowMs).length,
        limit: this.config.crashLoopLimit,
      }
    }
    return {
      allowed: true,
      tripped: false,
      reason: null,
      failuresInWindow: this.inWindow(nowMs).length,
      limit: this.config.crashLoopLimit,
    }
  }

  /** Clear the breaker, e.g. after an operator fixed the underlying problem. */
  reset(): void {
    this.starts = []
    this.tripped = false
    this.trippedAtMs = null
    this.reason = null
  }

  /** A snapshot for the status call. */
  state(nowMs: number): CrashLoopState {
    return {
      tripped: this.tripped,
      failuresInWindow: this.inWindow(nowMs).length,
      limit: this.config.crashLoopLimit,
      windowMs: this.config.crashLoopWindowMs,
      trippedAt: this.trippedAtMs === null ? null : new Date(this.trippedAtMs).toISOString(),
      reason: this.reason,
    }
  }

  /** The ledger fields this breaker owns, for persistence. */
  toLedgerFields(): Pick<SupervisorLedger, 'uncleanStarts' | 'safeMode' | 'safeModeReason' | 'safeModeAt'> {
    return {
      uncleanStarts: this.starts.map((entry) => ({
        at: new Date(entry.atMs).toISOString(),
        reason: entry.reason,
      })),
      safeMode: this.tripped,
      safeModeReason: this.reason,
      safeModeAt: this.trippedAtMs === null ? null : new Date(this.trippedAtMs).toISOString(),
    }
  }
}
