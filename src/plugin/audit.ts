/**
 * The restart audit log.
 *
 * Every accepted, refused, failed and cancelled attempt lands here with its reason
 * code, identifiers and outcome. The log is bounded and append-only, and a failure
 * to write it is reported rather than thrown: not being able to open a log file is
 * not a reason to skip a restart that has already been authorized, and it is
 * certainly not a reason to crash the host.
 *
 * @module dsh-restart/audit
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RestartAttemptRecord } from '../shared/protocol.js'

/** One persisted line. */
interface PersistedLine {
  readonly schemaVersion: number
  readonly kind: 'restart-attempt'
  readonly record: RestartAttemptRecord
}

/** Current on-disk schema version. */
export const AUDIT_SCHEMA_VERSION = 1

/** Options for {@link RestartAuditLog}. */
export interface RestartAuditLogOptions {
  /** Directory to write into, or `null` to stay memory-only. */
  readonly directory: string | null
  /** Maximum file size before rotation, in bytes. */
  readonly maxBytes: number
  /** Maximum records kept in memory for the status call. */
  readonly maxRecords: number
  /** Injectable clock, for deterministic tests. */
  readonly now?: () => number
}

/** Bounded, append-only restart audit log. */
export class RestartAuditLog {
  private readonly records: RestartAttemptRecord[] = []
  private readonly options: RestartAuditLogOptions
  private failures = 0
  private error: string | null = null
  private sequence = 0

  constructor(options: RestartAuditLogOptions) {
    this.options = options
  }

  /** Path of the on-disk log, or `null` when memory-only. */
  get path(): string | null {
    return this.options.directory === null ? null : join(this.options.directory, 'restart-attempts.jsonl')
  }

  /** Last I/O error, or `null`. */
  get lastError(): string | null {
    return this.error
  }

  /** How many write attempts have failed. */
  get writeFailures(): number {
    return this.failures
  }

  /** Next monotonic sequence number, used for ticket ids. */
  nextSequence(): number {
    this.sequence += 1
    return this.sequence
  }

  /** Append a record, keeping the in-memory ring bounded. */
  append(record: RestartAttemptRecord): void {
    this.records.push(record)
    const overflow = this.records.length - this.options.maxRecords
    if (overflow > 0) this.records.splice(0, overflow)
    this.persist(record)
  }

  /** Most recent records, newest first. */
  recent(limit = this.options.maxRecords): readonly RestartAttemptRecord[] {
    const tail = limit >= this.records.length ? [...this.records] : this.records.slice(this.records.length - limit)
    return tail.reverse()
  }

  /** How many records are held in memory. */
  get size(): number {
    return this.records.length
  }

  /** The bound this log was constructed with, for diagnostics and tests. */
  get maxRecords(): number {
    return this.options.maxRecords
  }

  /** Read the on-disk log back, tolerating a truncated final line. */
  readPersisted(limit = 200): readonly RestartAttemptRecord[] {
    const path = this.path
    if (path === null || !existsSync(path)) return []
    try {
      const out: RestartAttemptRecord[] = []
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const parsed = JSON.parse(trimmed) as PersistedLine
          if (parsed.kind === 'restart-attempt' && parsed.schemaVersion === AUDIT_SCHEMA_VERSION) {
            out.push(parsed.record)
          }
        } catch {
          // A half-written trailing line is expected after a hard kill.
        }
      }
      return out.length > limit ? out.slice(out.length - limit) : out
    } catch (error) {
      this.error = (error as Error).message
      return []
    }
  }

  private persist(record: RestartAttemptRecord): void {
    const path = this.path
    if (path === null) return
    try {
      const directory = dirname(path)
      if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
      this.rotateIfNeeded(path)
      const line: PersistedLine = { schemaVersion: AUDIT_SCHEMA_VERSION, kind: 'restart-attempt', record }
      appendFileSync(path, `${JSON.stringify(line)}\n`, 'utf8')
      this.error = null
    } catch (error) {
      this.failures += 1
      this.error = (error as Error).message
    }
  }

  private rotateIfNeeded(path: string): void {
    if (!existsSync(path)) return
    if (statSync(path).size < this.options.maxBytes) return
    const stamp = new Date(this.options.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, '-')
    renameSync(path, `${path}.${stamp}.bak`)
    writeFileSync(path, '', 'utf8')
  }
}
