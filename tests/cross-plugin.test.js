/**
 * The cross-repo seam, as documented.
 *
 * `dsh-health-scheduler` decides and `dsh-restart` executes, and neither repository
 * imports the other. That makes the seam between them prose until something exercises
 * it, so this file does: it builds the four-line restart adapter the health
 * scheduler's README documents on top of the restart plugin's real `RestartManager`,
 * then drives a real decision through a real `HealthScheduler` and checks what came out
 * the other side.
 *
 * It imports across repository boundaries on purpose. When the sibling checkout is
 * absent the whole file skips, so this suite still runs in isolation.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'

import { resolveConfig } from '../lib/shared/config.js'
import { FunctionCheckpointPort } from '../lib/plugin/ports.js'
import { RestartAuditLog } from '../lib/plugin/audit.js'
import { TicketStore } from '../lib/plugin/ticket-store.js'
import { RestartManager } from '../lib/plugin/restart-manager.js'
import { T0 } from './helpers/rig.js'

// Windows needs a real file URL before an absolute path can be imported, and the
// sibling checkout may legitimately be absent, in which case this file skips.
const siblingPath = join(process.cwd(), '..', 'dsh-health-scheduler', 'lib', 'index.js')
const sibling = pathToFileURL(siblingPath).href
const hasSibling = existsSync(siblingPath)

/** The bridge the health scheduler's README documents, built on the real manager. */
function buildRestartAdapter(manager) {
  return {
    id: 'dsh-restart',
    capability: 'available',
    requestApplicationRestart: (request) => manager.requestApplicationRestart(request),
    requestSystemRestart: (request) => manager.requestSystemRestart(request),
    cancelPendingRestart: (requestId) => manager.cancelPendingRestart(requestId),
  }
}

/** A restart manager whose checkpoint answers with `checkpoint`. */
function buildManager(directory, checkpoint) {
  const store = new TicketStore(directory, { now: () => T0 })
  const manager = new RestartManager({
    config: resolveConfig(),
    ports: {
      checkpoint: new FunctionCheckpointPort({ prepare: () => checkpoint, acknowledge: () => true }),
      shutdown: { id: 'test-shutdown', requestShutdown: () => true },
      systemShutdown: null,
    },
    store,
    audit: new RestartAuditLog({ directory, maxBytes: 1024 * 1024, maxRecords: 10, now: () => T0 }),
    pid: 4242,
    now: () => T0,
    processAlive: () => true,
  })
  // A restart is only attempted once a supervisor has been seen.
  store.writeHeartbeat({
    schemaVersion: 1,
    supervisorPid: 999,
    watchedPid: 4242,
    state: 'MONITORING',
    timestamp: new Date(T0).toISOString(),
    sequence: 1,
  })
  return { store, manager }
}

/**
 * Drive one real decision through a real `HealthScheduler` and return what the
 * restart adapter saw.
 *
 * The machine is calibrated so the rounded pressure lands between the app-restart and
 * system-reboot rungs of the ladder: one dimension is measured, its weight renormalizes
 * to 1.0, and the metric scores 100, giving a pressure in the twenties. The clock is
 * placed after the maintenance target so the window is genuinely open.
 */
async function driveOneRestartRequest(health, adapter) {
  const at = new Date(T0)
  at.setHours(4, 30, 0, 0)
  const clock = () => at.getTime()
  const seen = { request: null, response: null, outcome: null }

  const recording = {
    ...adapter,
    requestApplicationRestart: async (request) => {
      seen.request = request
      const response = await adapter.requestApplicationRestart(request)
      seen.response = response
      return response
    },
  }

  const scheduler = new health.HealthScheduler({
    config: health.resolveConfig({
      // Only one dimension is measured, so its weight renormalizes to 1.0 and the
      // reported pressure *is* that dimension's score. A saturated single metric would
      // therefore read 100 and trip the top rung, so the metric is calibrated to score in
      // the forties (`timeout_rate` 0.10 in a 0.02..0.2 band) and the ladder is placed
      // around it: the request under test is an *application* restart, and the
      // system-reboot rung is deliberately out of reach because a reboot is not what this
      // seam is about.
      thresholds: {
        throttle: { enter: 20, exit: 12 },
        pause_new_work: { enter: 28, exit: 22 },
        request_app_restart: { enter: 35, exit: 30 },
        request_system_reboot: { enter: 90, exit: 85 },
      },
      antiFlap: { debounceEvaluations: 1, minStateDwellMs: 0, minRepeatActionMs: 0 },
      maintenance: {
        enabled: true,
        safePointRequired: true,
        targetTime: '04:00',
        windowStart: '03:30',
        windowEnd: '05:00',
      },
      disabledProviders: ['hardware', 'memory', 'runtime', 'workers', 'computer-use', 'ui', 'context'],
      metrics: { timeout_rate: { band: { warn: 0.02, critical: 0.2 }, sustainMs: 0 } },
    }),
    restart: recording,
    workerControl: {
      id: 'noop-worker-control',
      capability: 'available',
      setConcurrencyLimit: async () => {},
      pauseNewWorkers: async () => {},
      resumeNormalConcurrency: async () => {},
      currentConcurrencyLimit: () => null,
    },
    stateDirectory: null,
    clock,
  })
  scheduler.safePoints.register({
    id: 'dsh-core',
    readiness: () => ({ source: 'dsh-core', safe: true, reason: 'idle', estimatedState: 'idle' }),
  })
  scheduler.on('decision', (record) => {
    if (record.action === 'REQUEST_APP_RESTART') seen.outcome = record.outcome
  })
  scheduler.registerProvider({
    id: 'cross-double',
    group: 'workers',
    provides: ['timeout_rate'],
    enabled: true,
    sample: () => ({
      provider: 'cross-double',
      timestamp: new Date(clock()).toISOString(),
      metrics: { timeout_rate: 0.1 },
    }),
  })

  const snapshot = await scheduler.tick()
  seen.snapshot = snapshot
  if (seen.outcome === null) {
    // `autoFlap.debounceEvaluations` is 2 by default, so a high-risk rung needs a
    // second evaluation before it is acted on. Advance the clock rather than
    // disabling the debounce, so the test exercises the shipped pacing.
    at.setMinutes(at.getMinutes() + 1)
    seen.snapshot = await scheduler.tick()
  }
  return seen
}

describe('health scheduler to restart plugin', { skip: hasSibling ? false : 'sibling checkout not present' }, () => {
  it('accepts the request the health scheduler builds, field for field', async () => {
    const health = await import(sibling)
    const directory = mkdtempSync(join(tmpdir(), 'dsh-cross-'))
    try {
      const { store, manager } = buildManager(directory, {
        safe: true,
        reason: 'idle',
        checkpointId: 'ck-cross',
        resumeToken: 'rs-cross',
        completed: true,
        detail: 'the harness kernel reports an idle safe point',
      })

      const seen = await driveOneRestartRequest(health, buildRestartAdapter(manager))

      assert.equal(seen.snapshot.state, 'REQUEST_APP_RESTART', `state was ${seen.snapshot.state}`)
      assert.ok(seen.request !== null, 'the scheduler never reached the adapter')
      assert.equal(seen.request.source, 'dsh-health-scheduler')
      assert.equal(seen.request.mode, 'application')
      assert.equal(seen.request.reasonCode, 'RUNTIME_PRESSURE')
      assert.equal(seen.request.checkpointRequired, true, 'checkpointRequired follows maintenance.safePointRequired')
      assert.equal(typeof seen.request.requestId, 'string')

      assert.equal(seen.response.accepted, true, `restart refused: ${JSON.stringify(seen.response)}`)
      assert.equal(seen.outcome.applied, true)
      assert.equal(seen.outcome.adapter, 'dsh-restart')
      assert.equal(manager.lockState, 'SHUTTING_DOWN')

      const ticket = store.readTicket(T0).ticket
      assert.ok(ticket !== null, 'the restart plugin wrote a ticket')
      assert.equal(ticket.reasonCode, 'RUNTIME_PRESSURE')
      assert.equal(ticket.mode, 'application')
      assert.equal(ticket.pid, 4242)
      assert.equal(ticket.checkpointId, 'ck-cross', 'the checkpoint the kernel reported is the one cited')
      assert.equal(ticket.requestId, seen.request.requestId, 'the ticket is traceable to the request')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reports a refusal verbatim instead of retrying around it', async () => {
    const health = await import(sibling)
    const directory = mkdtempSync(join(tmpdir(), 'dsh-cross-'))
    try {
      const { store, manager } = buildManager(directory, {
        safe: false,
        reason: 'git_commit_in_progress',
        checkpointId: null,
        resumeToken: null,
        completed: false,
        detail: 'a git operation is in progress',
      })

      const seen = await driveOneRestartRequest(health, buildRestartAdapter(manager))
      assert.equal(seen.response.accepted, false, 'a refused checkpoint must not be reported as accepted')
      assert.equal(seen.response.reason, 'CHECKPOINT_REQUIRED')
      assert.match(seen.response.detail, /git_commit_in_progress/)
      assert.equal(seen.outcome.applied, false)
      assert.equal(manager.lockState, 'IDLE', 'a refused restart releases the lock')
      assert.equal(store.hasTicket(), false, 'and leaves no ticket for a supervisor to act on')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
