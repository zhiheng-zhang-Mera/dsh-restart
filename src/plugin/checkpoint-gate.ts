/**
 * The checkpoint gate.
 *
 * `dsh-restart` never saves task state. It asks the harness to, waits a bounded
 * time, and believes only the answer.
 *
 * The default is refusal. A missing port, a timeout, a thrown error and an
 * explicit `safe: false` all produce the same outcome: no checkpoint, therefore no
 * restart. That is the design's "if checkpoint_required = true AND checkpoint
 * failed -> ABORT RESTART, 不得擅自继续".
 *
 * @module dsh-restart/checkpoint-gate
 */

import type { CheckpointOutcome, CheckpointPort } from '../shared/types.js'
import type { RestartMode } from '../shared/protocol.js'

/** A checkpoint attempt, successful or not. */
export interface GateResult {
  readonly outcome: CheckpointOutcome
  /** Milliseconds the harness took to answer. */
  readonly elapsedMs: number
  /** Whether the request may proceed. */
  readonly authorized: boolean
}

/** A checkpoint port that is not bound: every answer is "cannot verify". */
export class UnboundCheckpointPort implements CheckpointPort {
  readonly id = 'checkpoint-unbound'
  /** Why nothing is bound, surfaced in the audit record. */
  readonly reason: string

  constructor(reason = 'no checkpoint port is bound in this profile') {
    this.reason = reason
  }

  prepareForRestart(): CheckpointOutcome {
    return {
      safe: false,
      reason: 'no_checkpoint_port',
      checkpointId: null,
      resumeToken: null,
      completed: false,
      detail: this.reason,
    }
  }

  acknowledgeResume(): boolean {
    return false
  }
}

/** Failure outcome factory, so every path produces the same shape. */
function failure(reason: string, detail: string): CheckpointOutcome {
  return { safe: false, reason, checkpointId: null, resumeToken: null, completed: false, detail }
}

/**
 * Run one checkpoint request under a hard budget.
 *
 * A hung checkpoint must not hang the restart path: the caller is asked to prepare
 * for a restart, and an unbounded wait would leave the lock in CHECKPOINTING
 * forever, blocking every future request.
 */
export class CheckpointGate {
  private readonly port: CheckpointPort
  private readonly timeoutMs: number
  private readonly now: () => number

  constructor(options: { readonly port: CheckpointPort; readonly timeoutMs: number; readonly now?: () => number }) {
    this.port = options.port
    this.timeoutMs = options.timeoutMs
    this.now = options.now ?? (() => Date.now())
  }

  /** Port id, for diagnostics. */
  get portId(): string {
    return this.port.id
  }

  /** Whether a real port is bound (the unbound one reports itself as such). */
  get available(): boolean {
    return !(this.port instanceof UnboundCheckpointPort)
  }

  /**
   * Ask the harness to prepare for a restart.
   *
   * @param mode - the restart scope being requested.
   * @param required - whether a checkpoint must succeed for the request to proceed.
   */
  async prepare(mode: RestartMode, required: boolean): Promise<GateResult> {
    const startedAt = this.now()
    let outcome: CheckpointOutcome
    try {
      outcome = await this.withTimeout(Promise.resolve(this.port.prepareForRestart(mode)))
    } catch (error) {
      outcome = failure('checkpoint_threw', `prepareForRestart threw: ${(error as Error).message}`)
    }
    const elapsedMs = this.now() - startedAt

    const authorized = required ? outcome.safe && outcome.completed : true
    return {
      outcome:
        required || outcome.safe
          ? outcome
          : { ...outcome, detail: `${outcome.detail} (checkpoint not required for this request)` },
      elapsedMs,
      authorized,
    }
  }

  /** Tell the harness the checkpoint was consumed after a successful restart. */
  async acknowledgeResume(resumeToken: string | null): Promise<boolean> {
    try {
      return await this.withTimeout(Promise.resolve(this.port.acknowledgeResume(resumeToken)))
    } catch {
      return false
    }
  }

  private withTimeout<T>(value: Promise<T>): Promise<T> {
    if (this.timeoutMs <= 0) return value
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`checkpoint port ${this.port.id} did not answer within ${this.timeoutMs} ms`))
      }, this.timeoutMs)
      timer.unref?.()
      value.then(
        (result) => {
          clearTimeout(timer)
          resolve(result)
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
  }
}
