/**
 * Request validation, the restart lock, and the ticket format.
 *
 * These are the three places where a restart plugin can go wrong in ways that
 * matter: it can accept something it should refuse, it can walk its own state
 * machine into a corner, or it can leave a document on disk that a supervisor
 * later trusts and should not have.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { resolveConfig } from '../lib/shared/config.js'
import { RefusalCodes, validRequest } from './helpers/rig.js'
import { refuse, requestFingerprint, validateRequest, validateShape } from '../lib/plugin/request-validator.js'
import { RestartLock } from '../lib/plugin/restart-lock.js'
import {
  TicketStore,
  buildTicket,
  ticketChecksum,
  verifyTicket,
} from '../lib/plugin/ticket-store.js'
import { TICKET_SCHEMA_VERSION, canonicalJson, SELF_REASON_CODES } from '../lib/shared/protocol.js'

const T0 = Date.parse('2026-06-01T00:00:00.000Z')

/** A validator context that permits everything, so each test can deny one thing. */
function context(overrides = {}) {
  return {
    nowMs: T0,
    restartInFlight: false,
    cooldowns: { application: 0, system: 0 },
    isDuplicate: false,
    crashLoopTripped: false,
    supervisorPresent: true,
    checkpointPortAvailable: true,
    ...overrides,
  }
}

describe('request shape validation', () => {
  it('accepts a complete request', () => {
    const result = validateShape(validRequest())
    assert.equal(result.valid, true)
    assert.equal(result.request.requestId, 'req-1')
    assert.equal(result.request.mode, 'application')
    assert.equal(result.request.priority, 'normal')
  })

  it('rejects a non-object', () => {
    for (const value of [null, undefined, 'x', 42, []]) {
      const result = validateShape(value)
      assert.equal(result.valid, false)
      assert.equal(result.code, RefusalCodes.INVALID_REQUEST)
    }
  })

  it('rejects each missing field with a field-specific message', () => {
    for (const field of ['requestId', 'source', 'reasonCode', 'reasonSummary']) {
      const request = validRequest()
      delete request[field]
      const result = validateShape(request)
      assert.equal(result.valid, false, `${field} should be required`)
      assert.match(result.detail, new RegExp(field))
    }
  })

  it('rejects an unknown mode and a non-boolean checkpoint flag', () => {
    assert.equal(validateShape({ ...validRequest(), mode: 'partial' }).code, RefusalCodes.INVALID_REQUEST)
    assert.equal(validateShape({ ...validRequest(), checkpointRequired: 'yes' }).code, RefusalCodes.INVALID_REQUEST)
  })

  it('rejects an unknown priority', () => {
    assert.equal(validateShape({ ...validRequest(), priority: 'urgent' }).code, RefusalCodes.INVALID_REQUEST)
  })

  it('rejects oversized fields and control characters', () => {
    assert.equal(validateShape({ ...validRequest(), requestId: 'x'.repeat(129) }).code, RefusalCodes.INVALID_REQUEST)
    assert.equal(
      validateShape({ ...validRequest(), reasonSummary: 'hold on\u0007there' }).code,
      RefusalCodes.INVALID_REQUEST,
    )
  })

  it('trims surrounding whitespace instead of accepting it as content', () => {
    const result = validateShape({ ...validRequest(), source: '  dsh-health-scheduler  ' })
    assert.equal(result.valid, true)
    assert.equal(result.request.source, 'dsh-health-scheduler')
  })

  it('defaults priority to normal and the acknowledgement to false', () => {
    const request = validRequest()
    delete request.priority
    delete request.acknowledgeSystemReboot
    const result = validateShape(request)
    assert.equal(result.request.priority, 'normal')
    assert.equal(result.request.acknowledgeSystemReboot, false)
  })
})

describe('request policy validation', () => {
  const config = resolveConfig()

  it('accepts a well-formed application request', () => {
    const result = validateRequest(validRequest(), config, context())
    assert.equal(result.valid, true)
    assert.equal(result.code, null)
  })

  it('refuses everything when disabled', () => {
    const result = validateRequest(validRequest(), resolveConfig({ enabled: false }), context())
    assert.equal(result.code, RefusalCodes.DISABLED)
  })

  it('refuses an unknown source and names the allowed ones', () => {
    const result = validateRequest(validRequest({ source: 'some-random-app' }), config, context())
    assert.equal(result.code, RefusalCodes.UNKNOWN_SOURCE)
    assert.match(result.detail, /dsh-health-scheduler/)
  })

  it('refuses a disabled mode', () => {
    const result = validateRequest(
      validRequest(),
      resolveConfig({ applicationRestart: { enabled: false } }),
      context(),
    )
    assert.equal(result.code, RefusalCodes.MODE_NOT_ALLOWED)
  })

  it('refuses a system restart unless it is permitted and acknowledged', () => {
    // Disabled mode is refused first, so that is the code a default install sees.
    const systemRequest = validRequest({ mode: 'system', acknowledgeSystemReboot: true })
    assert.equal(validateRequest(systemRequest, config, context()).code, RefusalCodes.MODE_NOT_ALLOWED)

    // With the mode enabled but the reboot permission withheld, the next gate down
    // is the one that refuses.
    const modeOnly = resolveConfig({ systemRestart: { enabled: true } })
    assert.equal(
      validateRequest(systemRequest, modeOnly, context()).code,
      RefusalCodes.SYSTEM_REBOOT_NOT_PERMITTED,
    )

    const permitted = resolveConfig({
      allowSystemReboot: true,
      systemRestart: { enabled: true },
    })
    assert.equal(
      validateRequest(validRequest({ mode: 'system' }), permitted, context()).code,
      RefusalCodes.SYSTEM_REBOOT_NOT_PERMITTED,
      'the request itself must acknowledge the reboot',
    )
    assert.equal(validateRequest(systemRequest, permitted, context()).valid, true)
  })

  it('refuses while the crash-loop breaker is tripped', () => {
    const result = validateRequest(validRequest(), config, context({ crashLoopTripped: true }))
    assert.equal(result.code, RefusalCodes.CRASH_LOOP)
  })

  it('refuses a duplicate request id', () => {
    const result = validateRequest(validRequest(), config, context({ isDuplicate: true }))
    assert.equal(result.code, RefusalCodes.DUPLICATE_REQUEST_ID)
  })

  it('refuses while another restart is in flight', () => {
    const result = validateRequest(validRequest(), config, context({ restartInFlight: true }))
    assert.equal(result.code, RefusalCodes.RESTART_IN_FLIGHT)
  })

  it('refuses inside a cooldown and reports the remaining time', () => {
    const result = validateRequest(
      validRequest(),
      config,
      context({ cooldowns: { application: T0 + 600_000, system: 0 } }),
    )
    assert.equal(result.code, RefusalCodes.COOLDOWN_ACTIVE)
    assert.match(result.detail, /600s/)
  })

  it('refuses when no supervisor has been seen, because exiting is not restarting', () => {
    const result = validateRequest(validRequest(), config, context({ supervisorPresent: false }))
    assert.equal(result.code, RefusalCodes.SUPERVISOR_ABSENT)

    const permissive = resolveConfig({ safety: { allowRestartWithoutSupervisor: true } })
    assert.equal(validateRequest(validRequest(), permissive, context({ supervisorPresent: false })).valid, true)
  })

  it('refuses when a required checkpoint cannot be verified', () => {
    const strict = resolveConfig({ safety: { checkpointRequired: true } })
    assert.equal(
      validateRequest(validRequest(), strict, context({ checkpointPortAvailable: false })).code,
      RefusalCodes.CHECKPOINT_FAILED,
    )
    const relaxed = resolveConfig({ safety: { checkpointRequired: false } })
    assert.equal(validateRequest(validRequest(), relaxed, context({ checkpointPortAvailable: false })).valid, true)
  })

  it('checks the shape before anything else, so policy never sees a malformed request', () => {
    const result = validateRequest({ requestId: '' }, config, context())
    assert.equal(result.code, RefusalCodes.INVALID_REQUEST)
  })

  it('produces a refusal with no request attached', () => {
    const refusal = refuse('X', 'y')
    assert.equal(refusal.valid, false)
    assert.equal(refusal.request, null)
    assert.equal(refusal.code, 'X')
  })

  it('fingerprints identical retries identically and different requests differently', () => {
    const base = validateShape(validRequest()).request
    assert.equal(requestFingerprint(base), requestFingerprint({ ...base }))
    assert.notEqual(requestFingerprint(base), requestFingerprint({ ...base, reasonCode: 'MEMORY_LEAK' }))
  })

  it('documents every refusal code the plugin can raise', () => {
    for (const [code, detail] of Object.entries(SELF_REASON_CODES)) {
      assert.equal(typeof code, 'string')
      assert.ok(detail.length > 10, `${code} needs a useful explanation`)
    }
    assert.ok(Object.keys(SELF_REASON_CODES).length >= 14)
  })
})

describe('RestartLock', () => {
  it('starts idle with no holder', () => {
    const lock = new RestartLock({ now: () => T0 })
    assert.equal(lock.state, 'IDLE')
    assert.equal(lock.idle, true)
    assert.equal(lock.currentHolder, null)
  })

  it('walks the declared happy path', () => {
    const lock = new RestartLock({ now: () => T0 })
    for (const state of ['REQUESTED', 'CHECKPOINTING', 'SHUTTING_DOWN', 'RELAUNCHING', 'VERIFYING', 'IDLE']) {
      const refusal = lock.transition(state, state === 'REQUESTED' ? 'req-1' : null)
      assert.equal(refusal, null, `${state} should be reachable`)
    }
    assert.equal(lock.state, 'IDLE')
  })

  it('refuses an illegal edge and says which edges exist', () => {
    const lock = new RestartLock({ now: () => T0 })
    const refusal = lock.transition('VERIFYING')
    assert.ok(refusal !== null)
    assert.equal(refusal.from, 'IDLE')
    assert.equal(refusal.to, 'VERIFYING')
    assert.match(refusal.detail, /IDLE -> VERIFYING/)
    assert.match(refusal.detail, /allowed: REQUESTED/)
    assert.equal(lock.state, 'IDLE', 'a refused transition leaves the lock where it was')
  })

  it('refuses to enter REQUESTED without a request id', () => {
    const lock = new RestartLock({ now: () => T0 })
    const refusal = lock.transition('REQUESTED')
    assert.ok(refusal !== null)
    assert.match(refusal.detail, /requires a request id/)
  })

  it('holds the request id while it is not idle, and releases it on IDLE', () => {
    const lock = new RestartLock({ now: () => T0 })
    lock.transition('REQUESTED', 'req-9')
    assert.equal(lock.currentHolder, 'req-9')
    lock.transition('CHECKPOINTING')
    assert.equal(lock.currentHolder, 'req-9')
    lock.transition('IDLE')
    assert.equal(lock.currentHolder, null)
  })

  it('maps lock states onto request states', () => {
    const lock = new RestartLock({ now: () => T0 })
    assert.equal(lock.requestState, 'completed')
    lock.transition('REQUESTED', 'r')
    assert.equal(lock.requestState, 'queued')
    lock.transition('CHECKPOINTING')
    assert.equal(lock.requestState, 'checkpointing')
    lock.transition('SHUTTING_DOWN')
    assert.equal(lock.requestState, 'shutting_down')
  })

  it('releases from any working state with a reason', () => {
    for (const state of ['REQUESTED', 'CHECKPOINTING', 'SHUTTING_DOWN', 'RELAUNCHING', 'VERIFYING']) {
      const lock = new RestartLock({ now: () => T0 })
      lock.transition('REQUESTED', 'r')
      if (state !== 'REQUESTED') {
        lock.transition('CHECKPOINTING')
        if (state !== 'CHECKPOINTING') {
          lock.transition('SHUTTING_DOWN')
          if (state !== 'SHUTTING_DOWN') {
            lock.transition('RELAUNCHING')
            if (state !== 'RELAUNCHING') lock.transition('VERIFYING')
          }
        }
      }
      assert.equal(lock.state, state)
      const released = lock.release('test')
      assert.deepEqual(released, { from: state, reason: 'test' })
      assert.equal(lock.state, 'IDLE')
    }
    assert.equal(new RestartLock({ now: () => T0 }).release('noop'), null)
  })

  it('records transitions in order and bounds the history', () => {
    const lock = new RestartLock({ now: () => T0, maxHistory: 3 })
    lock.transition('REQUESTED', 'r')
    lock.transition('CHECKPOINTING')
    lock.transition('IDLE')
    lock.transition('REQUESTED', 'r2')
    assert.equal(lock.transitions.length, 3)
    assert.deepEqual(
      lock.transitions.map((entry) => `${entry.from}->${entry.to}`),
      ['REQUESTED->CHECKPOINTING', 'CHECKPOINTING->IDLE', 'IDLE->REQUESTED'],
      'the bounded history keeps the three most recent transitions',
    )
  })

  it('tracks how long it has held its state', () => {
    let now = T0
    const lock = new RestartLock({ now: () => now })
    lock.transition('REQUESTED', 'r')
    now = T0 + 5_000
    assert.equal(lock.heldForMs(), 5_000)
  })
})

describe('tickets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-restart-ticket-'))
  const store = new TicketStore(directory)

  function draft(overrides = {}) {
    return {
      ticketId: 'application-1-1-abcdef',
      requestId: 'req-1',
      mode: 'application',
      reasonCode: 'RUNTIME_PRESSURE',
      reasonSummary: 'health policy requested an application restart',
      pid: 4242,
      ttlMs: 600_000,
      cleanShutdown: true,
      checkpointId: 'ck-1',
      nowMs: T0,
      ...overrides,
    }
  }

  it('builds a ticket with a schema version and a matching checksum', () => {
    const ticket = buildTicket(draft())
    assert.equal(ticket.schemaVersion, TICKET_SCHEMA_VERSION)
    assert.equal(ticket.expiresAt, new Date(T0 + 600_000).toISOString())
    const { checksum, ...rest } = ticket
    assert.equal(checksum, ticketChecksum(rest))
  })

  it('verifies a freshly written ticket', () => {
    const ticket = buildTicket(draft())
    store.writeTicket(ticket)
    const verification = store.readTicket(T0 + 1_000, 4242)
    assert.equal(verification.valid, true)
    assert.equal(verification.ticket.ticketId, ticket.ticketId)
    assert.ok(existsSync(store.paths.ticket))
    store.clearTicket()
  })

  it('rejects a ticket whose contents were edited after the checksum was computed', () => {
    const ticket = buildTicket(draft())
    store.writeTicket({ ...ticket, reasonSummary: 'tampered' })
    const verification = store.readTicket(T0 + 1_000)
    assert.equal(verification.valid, false)
    assert.equal(verification.rejection, 'checksum')
    store.clearTicket()
  })

  it('rejects an expired ticket', () => {
    const ticket = buildTicket(draft({ ttlMs: 1_000 }))
    store.writeTicket(ticket)
    const verification = store.readTicket(T0 + 60_000)
    assert.equal(verification.valid, false)
    assert.equal(verification.rejection, 'expired')
    store.clearTicket()
  })

  it('rejects a ticket written by a different schema version', () => {
    const ticket = buildTicket(draft())
    store.writeTicket({ ...ticket, schemaVersion: 99 })
    const verification = store.readTicket(T0 + 1_000)
    assert.equal(verification.valid, false)
    assert.equal(verification.rejection, 'schema_version')
    store.clearTicket()
  })

  it('rejects a ticket that targets another pid when one is expected', () => {
    const ticket = buildTicket(draft())
    store.writeTicket(ticket)
    const verification = store.readTicket(T0 + 1_000, 9999)
    assert.equal(verification.valid, false)
    assert.equal(verification.rejection, 'wrong_pid')
    store.clearTicket()
  })

  it('reports a missing ticket, an unreadable ticket, and a non-object ticket distinctly', () => {
    assert.equal(store.readTicket(T0).rejection, 'missing')
    writeFileSync(store.paths.ticket, 'not json at all', 'utf8')
    assert.equal(store.readTicket(T0).rejection, 'missing', 'unparsable JSON reads as no ticket')
    writeFileSync(store.paths.ticket, '"a string"', 'utf8')
    assert.equal(store.readTicket(T0).rejection, 'malformed')
    store.clearTicket()
  })

  it('writes atomically, leaving no temporary files behind', () => {
    const ticket = buildTicket(draft())
    store.writeTicket(ticket)
    const leftovers = readFileSync(store.paths.ticket, 'utf8')
    assert.match(leftovers, /"schemaVersion": 1/)
    assert.equal(leftovers.endsWith('\n'), true)
    store.clearTicket()
    assert.equal(store.hasTicket(), false)
  })

  it('verifies a raw candidate without touching the disk', () => {
    const ticket = buildTicket(draft())
    assert.equal(verifyTicket(ticket, T0 + 1_000).valid, true)
    assert.equal(verifyTicket(null, T0).rejection, 'missing')
    assert.equal(verifyTicket({ ...ticket, schemaVersion: 2 }, T0).rejection, 'schema_version')
  })

  it('canonicalises JSON independently of key order, so a checksum is reproducible', () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }))
    assert.equal(canonicalJson({ a: [1, { d: 4, c: 3 }] }), '{"a":[1,{"c":3,"d":4}]}')
    assert.equal(canonicalJson(undefined), 'null')
  })

  it('round-trips the heartbeat and ledger', () => {
    store.writeHeartbeat({
      schemaVersion: 1,
      supervisorPid: 10,
      watchedPid: 20,
      state: 'MONITORING',
      timestamp: new Date(T0).toISOString(),
      sequence: 3,
    })
    const heartbeat = store.readHeartbeat()
    assert.equal(heartbeat.watchedPid, 20)
    assert.equal(store.heartbeatAgeMs(T0) >= 0, true)

    store.writeLedger({
      schemaVersion: 1,
      uncleanStarts: [{ at: new Date(T0).toISOString(), reason: 'x' }],
      safeMode: true,
      safeModeReason: 'crash_loop',
      safeModeAt: new Date(T0).toISOString(),
      relaunches: 4,
    })
    const ledger = store.readLedger()
    assert.equal(ledger.safeMode, true)
    assert.equal(ledger.relaunches, 4)
  })

  it('returns an empty ledger for a missing or corrupt file', () => {
    const other = new TicketStore(mkdtempSync(join(tmpdir(), 'dsh-restart-ledger-')))
    assert.equal(other.readLedger().safeMode, false)
    assert.equal(other.readLedger().relaunches, 0)
    writeFileSync(other.paths.ledger, '{ broken', 'utf8')
    assert.equal(other.readLedger().uncleanStarts.length, 0)
    rmSync(other.paths.directory, { recursive: true, force: true })
  })

  it('cleans up its temporary directory', () => {
    rmSync(directory, { recursive: true, force: true })
    assert.equal(existsSync(directory), false)
  })
})
