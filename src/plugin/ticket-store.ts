/**
 * The ticket store.
 *
 * A restart request becomes a ticket: a versioned, checksummed document on disk
 * that the external supervisor reads. The plugin writes it, the supervisor acts on
 * it, and neither trusts the other's memory — which is what makes the whole thing
 * survive the restart it is performing.
 *
 * ```
 * <state>/ticket.json     the pending or live restart ticket
 * <state>/heartbeat.json  the supervisor's latest heartbeat
 * <state>/ledger.json     the supervisor's durable crash-loop ledger
 * ```
 *
 * @module dsh-restart/ticket-store
 */

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic, readJson, sha256, mtimeMs } from './atomic.js'
import {
  TICKET_SCHEMA_VERSION,
  canonicalJson,
  type RestartMode,
  type RestartTicket,
  type SupervisorHeartbeat,
  type SupervisorLedger,
} from '../shared/protocol.js'

/** Why a ticket was rejected by the verifier. */
export type TicketRejection =
  | 'missing'
  | 'schema_version'
  | 'checksum'
  | 'expired'
  | 'malformed'
  | 'wrong_pid'

/** Ticket verification result. */
export interface TicketVerification {
  readonly valid: boolean
  readonly ticket: RestartTicket | null
  readonly rejection: TicketRejection | null
  readonly detail: string
}

/** Fields a caller supplies; the store computes the checksum and schema version. */
export interface TicketDraft {
  readonly ticketId: string
  readonly requestId: string
  readonly mode: RestartMode
  readonly reasonCode: string
  readonly reasonSummary: string
  readonly pid: number
  readonly ttlMs: number
  readonly cleanShutdown: boolean
  readonly checkpointId: string | null
  readonly nowMs: number
  readonly ttlFromMs?: number
}

/**
 * Compute the checksum for a ticket.
 *
 * The digest covers the canonical form of every field except `checksum` itself, so
 * a supervisor can detect a tampered or truncated document without any shared
 * secret. This is integrity, not authentication: the ticket lives in a directory
 * only the harness user can write.
 */
export function ticketChecksum(ticket: Omit<RestartTicket, 'checksum'>): string {
  return sha256(canonicalJson(ticket))
}

/** Build a complete ticket from a draft. */
export function buildTicket(draft: TicketDraft): RestartTicket {
  const createdAt = new Date(draft.nowMs).toISOString()
  const withoutChecksum: Omit<RestartTicket, 'checksum'> = {
    schemaVersion: TICKET_SCHEMA_VERSION,
    ticketId: draft.ticketId,
    requestId: draft.requestId,
    mode: draft.mode,
    reasonCode: draft.reasonCode,
    reasonSummary: draft.reasonSummary,
    pid: draft.pid,
    createdAt,
    expiresAt: new Date(draft.nowMs + draft.ttlMs).toISOString(),
    cleanShutdown: draft.cleanShutdown,
    checkpointId: draft.checkpointId,
  }
  return { ...withoutChecksum, checksum: ticketChecksum(withoutChecksum) }
}

/**
 * Verify a parsed ticket.
 *
 * Every check is a refusal, never a repair: a ticket that does not verify is
 * deleted by {@link TicketStore.consume}, because leaving a doubtful ticket where
 * a supervisor might read it is the failure mode this whole module exists to
 * prevent.
 */
export function verifyTicket(candidate: unknown, nowMs: number, expectedPid?: number): TicketVerification {
  if (candidate === null || candidate === undefined) {
    return { valid: false, ticket: null, rejection: 'missing', detail: 'no ticket file' }
  }
  if (typeof candidate !== 'object') {
    return { valid: false, ticket: null, rejection: 'malformed', detail: 'ticket is not an object' }
  }
  const ticket = candidate as RestartTicket
  if (ticket.schemaVersion !== TICKET_SCHEMA_VERSION) {
    return {
      valid: false,
      ticket: null,
      rejection: 'schema_version',
      detail: `ticket schemaVersion ${String(ticket.schemaVersion)} is not ${TICKET_SCHEMA_VERSION}`,
    }
  }
  const { checksum, ...rest } = ticket
  if (typeof checksum !== 'string' || checksum !== ticketChecksum(rest)) {
    return { valid: false, ticket: null, rejection: 'checksum', detail: 'ticket checksum does not match its contents' }
  }
  const expiresAt = Date.parse(ticket.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    return {
      valid: false,
      ticket: null,
      rejection: 'expired',
      detail: `ticket expired at ${String(ticket.expiresAt)}`,
    }
  }
  if (expectedPid !== undefined && ticket.pid !== expectedPid) {
    return {
      valid: false,
      ticket: null,
      rejection: 'wrong_pid',
      detail: `ticket targets pid ${ticket.pid}, not ${expectedPid}`,
    }
  }
  return { valid: true, ticket, rejection: null, detail: 'ticket verified' }
}

/** The store's paths, exposed so diagnostics can name them. */
export interface TicketStorePaths {
  readonly directory: string
  readonly ticket: string
  readonly heartbeat: string
  readonly ledger: string
}

/** Reads and writes the restart artifacts in one directory. */
export class TicketStore {
  /** Absolute paths of every artifact. */
  readonly paths: TicketStorePaths
  /**
   * Clock used for age and expiry decisions.
   *
   * Injectable because the honest answer to "how old is this heartbeat?" must come
   * from the same clock the caller is reasoning with; a test that drives simulated
   * time cannot ask the filesystem what time it is.
   */
  private readonly now: () => number

  constructor(directory: string, options: { readonly now?: () => number } = {}) {
    this.paths = {
      directory,
      ticket: join(directory, 'ticket.json'),
      heartbeat: join(directory, 'heartbeat.json'),
      ledger: join(directory, 'ledger.json'),
    }
    this.now = options.now ?? (() => Date.now())
  }

  /** Write a ticket atomically. */
  writeTicket(ticket: RestartTicket): void {
    writeJsonAtomic(this.paths.ticket, ticket)
  }

  /** Read and verify the current ticket. */
  readTicket(nowMs: number = this.now(), expectedPid?: number): TicketVerification {
    const raw = readJson<unknown>(this.paths.ticket)
    return verifyTicket(raw, nowMs, expectedPid)
  }

  /** Delete the ticket. Idempotent. */
  clearTicket(): void {
    if (existsSync(this.paths.ticket)) rmSync(this.paths.ticket, { force: true })
  }

  /** Whether a ticket file exists at all. */
  hasTicket(): boolean {
    return existsSync(this.paths.ticket)
  }

  /** Write a supervisor heartbeat. */
  writeHeartbeat(heartbeat: SupervisorHeartbeat): void {
    writeJsonAtomic(this.paths.heartbeat, heartbeat)
  }

  /** Read the supervisor heartbeat, or `null`. */
  readHeartbeat(): SupervisorHeartbeat | null {
    const raw = readJson<SupervisorHeartbeat>(this.paths.heartbeat)
    if (raw === null || typeof raw !== 'object') return null
    return raw
  }

  /**
   * Age of the heartbeat file in milliseconds, or `null` when absent.
   *
   * The heartbeat's own `timestamp` is preferred over the file's mtime, because a
   * supervisor that writes on a timer produces a timestamp with a known meaning,
   * while an mtime can be touched by anything. The mtime is the fallback for a
   * document written by an older version.
   */
  heartbeatAgeMs(nowMs: number = this.now()): number | null {
    const heartbeat = this.readHeartbeat()
    if (heartbeat !== null && typeof heartbeat.timestamp === 'string') {
      const writtenAt = Date.parse(heartbeat.timestamp)
      if (Number.isFinite(writtenAt)) return Math.max(0, nowMs - writtenAt)
    }
    const modified = mtimeMs(this.paths.heartbeat)
    return modified === null ? null : Math.max(0, nowMs - modified)
  }

  /** Read the supervisor ledger, or a fresh empty one. */
  readLedger(): SupervisorLedger {
    const raw = readJson<SupervisorLedger>(this.paths.ledger)
    if (raw === null || typeof raw !== 'object') return emptyLedger()
    return {
      schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1,
      uncleanStarts: Array.isArray(raw.uncleanStarts) ? raw.uncleanStarts : [],
      safeMode: raw.safeMode === true,
      safeModeReason: typeof raw.safeModeReason === 'string' ? raw.safeModeReason : null,
      safeModeAt: typeof raw.safeModeAt === 'string' ? raw.safeModeAt : null,
      relaunches: typeof raw.relaunches === 'number' ? raw.relaunches : 0,
    }
  }

  /** Write the supervisor ledger atomically. */
  writeLedger(ledger: SupervisorLedger): void {
    writeJsonAtomic(this.paths.ledger, ledger)
  }
}

/** A ledger with nothing recorded. */
export function emptyLedger(): SupervisorLedger {
  return {
    schemaVersion: 1,
    uncleanStarts: [],
    safeMode: false,
    safeModeReason: null,
    safeModeAt: null,
    relaunches: 0,
  }
}
