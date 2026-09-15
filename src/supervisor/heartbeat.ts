/**
 * Heartbeat reading and writing.
 *
 * The supervisor and the plugin are separate processes, so "is the supervisor
 * alive?" is answered by a file both can see. The heartbeat is written atomically
 * and carries a monotonic sequence, which is what makes a fresh beat
 * distinguishable from a stale file left behind by a dead supervisor.
 *
 * @module dsh-restart/supervisor/heartbeat
 */

import type { SupervisorHeartbeat, SupervisorState } from '../shared/protocol.js'
import type { SupervisorConfig } from '../shared/types.js'
import type { TicketStore } from '../plugin/ticket-store.js'

/** Writes supervisor heartbeats. */
export class HeartbeatWriter {
  private readonly store: TicketStore
  private readonly config: SupervisorConfig
  private readonly supervisorPid: number
  private readonly now: () => number
  private sequence = 0
  private timer: NodeJS.Timeout | null = null
  private watchedPid: number
  private state: SupervisorState = 'MONITORING'

  constructor(options: {
    readonly store: TicketStore
    readonly config: SupervisorConfig
    readonly supervisorPid: number
    readonly watchedPid: number
    readonly now?: () => number
  }) {
    this.store = options.store
    this.config = options.config
    this.supervisorPid = options.supervisorPid
    this.watchedPid = options.watchedPid
    this.now = options.now ?? (() => Date.now())
  }

  /** Write one heartbeat immediately. */
  beat(): SupervisorHeartbeat {
    this.sequence += 1
    const heartbeat: SupervisorHeartbeat = {
      schemaVersion: 1,
      supervisorPid: this.supervisorPid,
      watchedPid: this.watchedPid,
      state: this.state,
      timestamp: new Date(this.now()).toISOString(),
      sequence: this.sequence,
    }
    try {
      this.store.writeHeartbeat(heartbeat)
    } catch {
      // A heartbeat that cannot be written must not stop the supervisor from
      // supervising; the plugin will report the supervisor as absent, which is
      // the honest reading of "no heartbeat".
    }
    return heartbeat
  }

  /** Update the reported state and beat once, so the change is visible promptly. */
  setState(state: SupervisorState): void {
    this.state = state
    this.beat()
  }

  /** Change the watched pid and beat once. */
  watch(pid: number): void {
    this.watchedPid = pid
    this.beat()
  }

  /** Start beating on the configured interval. */
  start(): void {
    if (this.timer !== null) return
    this.beat()
    this.timer = setInterval(() => this.beat(), this.config.heartbeatIntervalMs)
    this.timer.unref?.()
  }

  /** Stop beating. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** The sequence number of the last beat written. */
  get currentSequence(): number {
    return this.sequence
  }
}

/** A heartbeat reading with its age. */
export interface HeartbeatReading {
  readonly heartbeat: SupervisorHeartbeat | null
  readonly ageMs: number | null
  readonly present: boolean
}

/** Read the supervisor heartbeat from a store. */
export function readHeartbeat(store: TicketStore, nowMs: number, timeoutMs: number): HeartbeatReading {
  const heartbeat = store.readHeartbeat()
  const ageMs = store.heartbeatAgeMs(nowMs)
  return {
    heartbeat,
    ageMs,
    present: ageMs !== null && ageMs <= timeoutMs,
  }
}
