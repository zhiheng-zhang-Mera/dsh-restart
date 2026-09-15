/**
 * The restart lock.
 *
 * Exactly one restart may be in flight. This module owns that invariant and the
 * state machine around it:
 *
 * ```
 * IDLE -> REQUESTED -> CHECKPOINTING -> SHUTTING_DOWN -> RELAUNCHING -> VERIFYING -> IDLE
 * ```
 *
 * The transitions are declared, not implied, so a bug elsewhere cannot walk the
 * lock into a state that has no way out. Anything that is not a declared edge is
 * refused and reported, which is how a stuck restart becomes visible instead of
 * silently blocking every future one.
 *
 * @module dsh-restart/restart-lock
 */

import type { RestartLockState, RestartRequestState } from '../shared/protocol.js'

/** A refused transition. */
export interface TransitionRefusal {
  readonly from: RestartLockState
  readonly to: RestartLockState
  readonly detail: string
}

/** The declared edges of the lock state machine. */
const TRANSITIONS: Readonly<Record<RestartLockState, readonly RestartLockState[]>> = Object.freeze({
  IDLE: ['REQUESTED'],
  // A request may be abandoned from any working state; every later state may also
  // finish, because an operator can always cancel a pending restart.
  REQUESTED: ['CHECKPOINTING', 'SHUTTING_DOWN', 'IDLE'],
  CHECKPOINTING: ['SHUTTING_DOWN', 'IDLE'],
  SHUTTING_DOWN: ['RELAUNCHING', 'IDLE'],
  RELAUNCHING: ['VERIFYING', 'IDLE'],
  VERIFYING: ['IDLE'],
})

/** Request state that corresponds to each lock state. */
const REQUEST_STATE: Readonly<Record<RestartLockState, RestartRequestState>> = Object.freeze({
  IDLE: 'completed',
  REQUESTED: 'queued',
  CHECKPOINTING: 'checkpointing',
  SHUTTING_DOWN: 'shutting_down',
  RELAUNCHING: 'relaunching',
  VERIFYING: 'verifying',
})

/** The lock, its current holder, and its transition history. */
export class RestartLock {
  private current: RestartLockState = 'IDLE'
  private holder: string | null = null
  private enteredAtMs = 0
  private readonly history: Array<{ readonly from: RestartLockState; readonly to: RestartLockState; readonly atMs: number }> = []
  private readonly maxHistory: number

  constructor(options: { readonly maxHistory?: number; readonly now?: () => number } = {}) {
    this.maxHistory = options.maxHistory ?? 50
    this.now = options.now ?? (() => Date.now())
  }

  private readonly now: () => number

  /** Current state. */
  get state(): RestartLockState {
    return this.current
  }

  /** Whether a new restart may be started. */
  get idle(): boolean {
    return this.current === 'IDLE'
  }

  /** The request id holding the lock, or `null`. */
  get currentHolder(): string | null {
    return this.holder
  }

  /** Milliseconds the lock has been in its current state. */
  heldForMs(): number {
    return Math.max(0, this.now() - this.enteredAtMs)
  }

  /** Request state name for the current lock state. */
  get requestState(): RestartRequestState {
    return REQUEST_STATE[this.current]
  }

  /** The transitions taken so far, oldest first. */
  get transitions(): readonly { readonly from: RestartLockState; readonly to: RestartLockState; readonly atMs: number }[] {
    return [...this.history]
  }

  /**
   * Try to move the lock.
   *
   * @param to - the desired state.
   * @param holder - request id claiming the lock; only meaningful when leaving IDLE.
   * @returns `null` on success, or the refusal.
   */
  transition(to: RestartLockState, holder: string | null = null): TransitionRefusal | null {
    const allowed = TRANSITIONS[this.current]
    if (!allowed.includes(to)) {
      return {
        from: this.current,
        to,
        detail: `illegal restart lock transition ${this.current} -> ${to}; allowed: ${allowed.join(', ') || 'none'}`,
      }
    }
    if (to === 'REQUESTED' && (holder === null || holder === '')) {
      return { from: this.current, to, detail: 'entering REQUESTED requires a request id' }
    }
    if (this.current === 'IDLE' && to === 'REQUESTED') this.holder = holder
    if (to === 'IDLE') this.holder = null

    this.history.push({ from: this.current, to, atMs: this.now() })
    if (this.history.length > this.maxHistory) this.history.shift()
    this.current = to
    this.enteredAtMs = this.now()
    return null
  }

  /**
   * Force the lock back to IDLE.
   *
   * Used when a restart is abandoned (a refused checkpoint, a failed shutdown, an
   * explicit cancel, or a startup reconciliation that found a ticket no supervisor
   * ever consumed). Reported through the returned history entry so the reason is
   * not lost.
   *
   * @returns the state the lock was in, or `null` when it was already idle.
   */
  release(reason: string): { readonly from: RestartLockState; readonly reason: string } | null {
    if (this.current === 'IDLE') return null
    const from = this.current
    this.history.push({ from, to: 'IDLE', atMs: this.now() })
    if (this.history.length > this.maxHistory) this.history.shift()
    this.current = 'IDLE'
    this.holder = null
    this.enteredAtMs = this.now()
    return { from, reason }
  }
}
