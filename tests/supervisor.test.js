/**
 * The supervisor: pid watching, the crash-loop breaker, relaunching, safe mode,
 * and the ticket lifecycle it observes.
 *
 * The supervisor is driven with a scripted process list and a scripted launcher, so
 * these tests exercise the real state machine without starting or stopping anything.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { resolveConfig } from '../lib/shared/config.js'
import { TicketStore, buildTicket } from '../lib/plugin/ticket-store.js'
import { CrashLoopBreaker } from '../lib/supervisor/crash-loop-breaker.js'
import { RestartSupervisor } from '../lib/supervisor/index.js'
import {
  ScriptedLivenessProbe,
  parseTasklistOutput,
} from '../lib/supervisor/pid-watch.js'
import { ScriptedLauncher, deriveLaunchSpec } from '../lib/supervisor/relaunch.js'
import { MINUTE, T0 } from './helpers/rig.js'

const SECOND = 1_000

/** A scripted liveness answer. */
const alive = { alive: true, method: 'scripted', error: null, detail: 'alive' }
const dead = { alive: false, method: 'scripted', error: null, detail: 'gone' }
const unknown = { alive: null, method: 'scripted', error: 'probe_failed', detail: 'could not tell' }

/** A supervisor rig with a supervisable clock and scripted collaborators. */
function rig(options = {}) {
  const directory = options.directory ?? makeDirectory()
  const store = new TicketStore(directory, { now: () => state.now })
  const state = { now: options.now ?? T0 }
  const probe = new ScriptedLivenessProbe(options.answers ?? [alive], alive)
  const launcher = new ScriptedLauncher(options.launches ?? {})
  const supervisor = new RestartSupervisor({
    config: resolveConfig(options.config ?? {}),
    directory,
    watchPid: options.watchPid ?? 4242,
    now: () => state.now,
    probe,
    launcher,
    argv: options.argv ?? ['node', 'dsh.js', '--profile', 'web'],
    cwd: options.cwd ?? 'C:\\harness',
    terminateAfterVerify: options.terminateAfterVerify === true,
  })
  return {
    directory,
    store,
    state,
    probe,
    launcher,
    supervisor,
    advance(ms) {
      state.now += ms
      return this
    },
    writeTicket(overrides = {}) {
      const ticket = buildTicket({
        ticketId: 'application-1-1-abcdef',
        requestId: 'req-1',
        mode: 'application',
        reasonCode: 'RUNTIME_PRESSURE',
        reasonSummary: 'health policy requested a restart',
        pid: overrides.pid ?? 4242,
        ttlMs: overrides.ttlMs ?? 10 * MINUTE,
        cleanShutdown: true,
        checkpointId: 'ck-1',
        nowMs: state.now,
      })
      store.writeTicket(ticket)
      return ticket
    },
  }
}

let counter = 0
function makeDirectory() {
  counter += 1
  return mkdtempSync(join(tmpdir(), `dsh-restart-sup-${counter}-`))
}

describe('liveness probes', () => {
  it('parses tasklist CSV output, including the no-match informational line', () => {
    assert.equal(parseTasklistOutput('"node.exe","4242","Console","1","120,000 K"', 4242), true)
    assert.equal(parseTasklistOutput('"node.exe","4242","Console","1","120,000 K"', 4243), false)
    assert.equal(parseTasklistOutput('INFO: No tasks are running which match the specified criteria.', 4242), false)
    assert.equal(parseTasklistOutput('', 4242), false)
    assert.equal(
      parseTasklistOutput('"a.exe","1","Console","1","1 K"\r\n"node.exe","4242","Console","1","2 K"', 4242),
      true,
    )
  })

  it('requires the pid column to match exactly, not as a prefix', () => {
    assert.equal(parseTasklistOutput('"node.exe","42420","Console","1","1 K"', 4242), false)
  })
})

describe('crash-loop breaker', () => {
  const config = resolveConfig().safety

  it('allows relaunches until the limit, then trips', () => {
    const breaker = new CrashLoopBreaker({ config })
    assert.equal(breaker.recordUncleanStart('x', T0).allowed, true)
    assert.equal(breaker.recordUncleanStart('x', T0 + SECOND).allowed, true)
    const third = breaker.recordUncleanStart('x', T0 + 2 * SECOND)
    assert.equal(third.allowed, false)
    assert.equal(third.tripped, true)
    assert.equal(third.reason, 'CRASH_LOOP')
    assert.equal(breaker.isTripped, true)
  })

  it('uses a rolling window, so old crashes stop counting', () => {
    const breaker = new CrashLoopBreaker({ config })
    breaker.recordUncleanStart('x', T0)
    breaker.recordUncleanStart('x', T0 + SECOND)
    // Eleven minutes later the window has moved past the first two.
    const verdict = breaker.recordUncleanStart('x', T0 + 11 * MINUTE)
    assert.equal(verdict.allowed, true, 'an hourly crash must not trip a per-minute breaker')
    assert.equal(verdict.failuresInWindow, 1)
  })

  it('reports the limit and the window in its state', () => {
    const breaker = new CrashLoopBreaker({ config })
    breaker.recordUncleanStart('why', T0)
    const state = breaker.state(T0 + SECOND)
    assert.equal(state.limit, 3)
    assert.equal(state.windowMs, 10 * MINUTE)
    assert.equal(state.failuresInWindow, 1)
    assert.equal(state.tripped, false)
  })

  it('restores a tripped state from the ledger, so a restart cannot clear it', () => {
    const ledger = {
      schemaVersion: 1,
      uncleanStarts: [],
      safeMode: true,
      safeModeReason: 'crash_loop',
      safeModeAt: new Date(T0).toISOString(),
      relaunches: 7,
    }
    const breaker = new CrashLoopBreaker({ config, ledger })
    assert.equal(breaker.isTripped, true)
    assert.equal(breaker.tripReason, 'crash_loop')
    assert.equal(breaker.verdict(T0).allowed, false)
  })

  it('clears completely on reset', () => {
    const breaker = new CrashLoopBreaker({ config })
    for (let i = 0; i < 3; i += 1) breaker.recordUncleanStart('x', T0 + i)
    assert.equal(breaker.isTripped, true)
    breaker.reset()
    assert.equal(breaker.isTripped, false)
    assert.equal(breaker.verdict(T0).allowed, true)
    assert.equal(breaker.state(T0).failuresInWindow, 0)
  })

  it('serialises the fields it owns', () => {
    const breaker = new CrashLoopBreaker({ config })
    breaker.recordUncleanStart('probe_failed', T0)
    const fields = breaker.toLedgerFields()
    assert.equal(fields.uncleanStarts.length, 1)
    assert.equal(fields.uncleanStarts[0].reason, 'probe_failed')
    assert.equal(fields.safeMode, false)
  })
})

describe('launch command derivation', () => {
  it('prefers the configured command', () => {
    const spec = deriveLaunchSpec({
      config: resolveConfig({ supervisor: { launchCommand: ['C:\\node.exe', 'dsh.js'], launchArgs: ['--port', '3080'] } }).supervisor,
      supervisorArgv: ['node', 'other.js'],
      supervisorCwd: 'C:\\harness',
    })
    assert.equal(spec.file, 'C:\\node.exe')
    assert.deepEqual(spec.args, ['dsh.js', '--port', '3080'])
  })

  it('falls back to the supervisor own argv', () => {
    const spec = deriveLaunchSpec({
      config: resolveConfig().supervisor,
      supervisorArgv: ['node', 'dsh.js', '--profile', 'web'],
      supervisorCwd: 'C:\\harness',
    })
    assert.equal(spec.file, 'node')
    assert.deepEqual(spec.args, ['dsh.js', '--profile', 'web'])
    assert.equal(spec.cwd, 'C:\\harness')
  })

  it('reports that it cannot derive anything from an empty argv', () => {
    const spec = deriveLaunchSpec({
      config: resolveConfig().supervisor,
      supervisorArgv: [],
      supervisorCwd: 'C:\\harness',
    })
    assert.equal(spec, null)
  })

  it('honours a configured working directory over its own', () => {
    const spec = deriveLaunchSpec({
      config: resolveConfig({ supervisor: { launchCwd: 'D:\\elsewhere' } }).supervisor,
      supervisorArgv: ['node', 'dsh.js'],
      supervisorCwd: 'C:\\harness',
    })
    assert.equal(spec.cwd, 'D:\\elsewhere')
  })
})

describe('supervisor state machine', () => {
  it('monitors quietly while the process is alive and no ticket exists', async () => {
    const r = rig({ answers: [alive] })
    try {
      const result = await r.supervisor.tick()
      assert.equal(result.state, 'MONITORING')
      assert.equal(result.reason, 'MONITORING')
      assert.equal(r.launcher.specs.length, 0, 'nothing should be launched')
    } finally {
      cleanup(r)
    }
  })

  it('honours a ticket: waits for the exit, relaunches, and verifies', async () => {
    // Alive while waiting, then gone, then the relaunched process is alive.
    const r = rig({ answers: [alive, alive, dead] })
    try {
      r.writeTicket({ pid: 4242 })

      const waiting = await r.supervisor.tick()
      assert.equal(waiting.state, 'WAITING_FOR_EXIT')
      assert.equal(waiting.reason, 'WAITING')

      const stillWaiting = await r.supervisor.tick()
      assert.equal(stillWaiting.state, 'WAITING_FOR_EXIT')

      const relaunched = await r.supervisor.tick()
      assert.equal(relaunched.state, 'WAITING_FOR_HEARTBEAT')
      assert.equal(relaunched.reason, 'RELAUNCHED')
      assert.equal(r.launcher.specs.length, 1)
      assert.equal(r.launcher.specs[0].file, 'node')
      assert.equal(r.store.hasTicket(), false, 'the ticket is consumed by the relaunch')

      const verified = await r.supervisor.tick()
      assert.equal(verified.reason, 'VERIFIED')
      assert.equal(r.supervisor.currentState, 'MONITORING')
      assert.equal(r.supervisor.hasVerifiedRelaunch, true)
    } finally {
      cleanup(r)
    }
  })

  it('adopts the pid named by the ticket', async () => {
    const r = rig({ answers: [alive, dead] })
    try {
      r.writeTicket({ pid: 7777 })
      await r.supervisor.tick()
      assert.equal(r.supervisor.pid, 7777)
      assert.ok(r.probe.checks.includes(7777))
    } finally {
      cleanup(r)
    }
  })

  it('discards a ticket that does not verify instead of acting on it', async () => {
    const r = rig({ answers: [alive] })
    try {
      r.writeTicket()
      // Tamper with the ticket after its checksum was computed.
      const path = r.store.paths.ticket
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      writeFileSync(path, JSON.stringify({ ...raw, reasonCode: 'tampered' }), 'utf8')

      const result = await r.supervisor.tick()
      assert.equal(result.state, 'MONITORING', 'a doubtful ticket must not start a restart')
      assert.equal(r.store.hasTicket(), false, 'and must be removed')
      assert.ok(r.supervisor.log.some((event) => event.code === 'discarded_unverifiable_ticket'))
    } finally {
      cleanup(r)
    }
  })

  it('relaunches after an unexpected death, counting it as unclean', async () => {
    const r = rig({ answers: [dead, alive] })
    try {
      const result = await r.supervisor.tick()
      assert.equal(result.reason, 'RELAUNCHED')
      assert.equal(r.launcher.specs.length, 1)
      assert.ok(r.supervisor.log.some((event) => event.code === 'process_died_without_ticket'))
    } finally {
      cleanup(r)
    }
  })

  it('enters safe mode after the crash-loop limit instead of looping forever', async () => {
    const r = rig({
      // The pid is gone on every check, so every relaunch looks like it never came
      // back. The relaunch budget is shortened so the run reaches the limit inside
      // the test instead of after ninety simulated seconds.
      answers: Array.from({ length: 40 }, () => dead),
      launches: { fallback: { pid: 5000, ok: true, detail: 'scripted' } },
      config: {
        supervisor: { relaunchTimeoutMs: 5_000, heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 30_000 },
      },
    })
    try {
      let result = await r.supervisor.tick()
      for (let i = 0; i < 20 && result.state !== 'SAFE_MODE'; i += 1) {
        r.advance(6 * SECOND)
        result = await r.supervisor.tick()
      }
      assert.equal(result.state, 'SAFE_MODE')
      assert.equal(result.safeMode, true)
      assert.ok(r.launcher.specs.length <= 3, `expected at most 3 launches, saw ${r.launcher.specs.length}`)
      assert.ok(r.supervisor.log.some((event) => event.code === 'safe_mode_manual_action_required'))
      const ledger = r.store.readLedger()
      assert.equal(ledger.safeMode, true)
    } finally {
      cleanup(r)
    }
  })

  it('stays in safe mode once tripped, even if a ticket arrives', async () => {
    const r = rig({ answers: Array.from({ length: 10 }, () => alive) })
    try {
      // Pre-trip the breaker the way a previous run would have.
      r.store.writeLedger({
        schemaVersion: 1,
        uncleanStarts: [],
        safeMode: true,
        safeModeReason: 'crash_loop',
        safeModeAt: new Date(T0).toISOString(),
        relaunches: 3,
      })
      const tripped = new (await import('../lib/supervisor/index.js')).RestartSupervisor({
        config: resolveConfig(),
        directory: r.directory,
        watchPid: 4242,
        now: () => r.state.now,
        probe: r.probe,
        launcher: r.launcher,
        argv: ['node', 'dsh.js'],
      })
      r.writeTicket()
      const result = await tripped.tick()
      assert.equal(result.state, 'SAFE_MODE')
      assert.equal(result.reason, 'CRASH_LOOP')
      assert.equal(r.launcher.specs.length, 0, 'safe mode must not launch anything')
    } finally {
      cleanup(r)
    }
  })

  it('gives up cleanly when no launch command can be derived', async () => {
    const r = rig({ answers: [dead], argv: [] })
    try {
      const result = await r.supervisor.tick()
      assert.equal(result.state, 'SAFE_MODE')
      assert.equal(result.reason, 'NO_LAUNCH_COMMAND')
      assert.ok(r.supervisor.log.some((event) => event.code === 'no_launch_command'))
    } finally {
      cleanup(r)
    }
  })

  it('counts a failed launch against the breaker rather than retrying blindly', async () => {
    const r = rig({
      answers: [dead],
      launches: { fallback: { pid: -1, ok: false, detail: 'spawn failed: ENOENT' } },
    })
    try {
      let result = await r.supervisor.tick()
      for (let i = 0; i < 8 && result.state !== 'SAFE_MODE'; i += 1) {
        r.advance(SECOND)
        result = await r.supervisor.tick()
      }
      assert.equal(result.state, 'SAFE_MODE')
      assert.ok(r.supervisor.log.some((event) => event.code === 'relaunch_failed'))
    } finally {
      cleanup(r)
    }
  })

  it('never acts on a liveness probe that could not answer', async () => {
    const r = rig({ answers: [unknown, unknown, alive] })
    try {
      r.writeTicket()
      const first = await r.supervisor.tick()
      assert.equal(first.state, 'WAITING_FOR_EXIT')
      const second = await r.supervisor.tick()
      assert.equal(second.reason, 'PROBE_FAILED')
      assert.equal(r.launcher.specs.length, 0, 'an unanswered probe is not a death')
      assert.ok(r.supervisor.log.some((event) => event.code === 'liveness_probe_failed'))
    } finally {
      cleanup(r)
    }
  })

  it('gives up on a relaunch that never comes back alive', async () => {
    const r = rig({
      answers: Array.from({ length: 20 }, () => dead),
      config: {
        supervisor: { relaunchTimeoutMs: 5_000, heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 30_000 },
      },
    })
    try {
      let result = await r.supervisor.tick()
      for (let i = 0; i < 20 && result.state !== 'SAFE_MODE'; i += 1) {
        r.advance(6 * SECOND)
        result = await r.supervisor.tick()
      }
      assert.equal(result.state, 'SAFE_MODE')
      assert.ok(r.supervisor.log.some((event) => event.code === 'relaunch_verification_failed'))
    } finally {
      cleanup(r)
    }
  })
})

describe('supervisor run loop', () => {
  it('beats a heartbeat while it runs and stops when told to', async () => {
    const r = rig({ answers: Array.from({ length: 20 }, () => alive) })
    try {
      const running = r.supervisor.run({ tickMs: 1, maxTicks: 3 })
      assert.equal(r.supervisor.isRunning, true)
      const result = await running
      assert.equal(r.supervisor.isRunning, false)
      assert.equal(result.reason, 'TICK_LIMIT')

      const heartbeat = r.store.readHeartbeat()
      assert.ok(heartbeat !== null, 'a heartbeat must be written')
      assert.equal(heartbeat.watchedPid, 4242)
      assert.ok(heartbeat.sequence >= 1)
    } finally {
      cleanup(r)
    }
  })

  it('reports the run result and the relaunch count', async () => {
    const r = rig({ answers: [dead, alive] })
    try {
      const result = await r.supervisor.run({ tickMs: 1, maxTicks: 2 })
      assert.equal(result.relaunches, 1)
      assert.equal(result.safeMode, false)
    } finally {
      cleanup(r)
    }
  })

  it('logs every state change with a machine-readable code', async () => {
    const r = rig({ answers: [dead, alive] })
    try {
      await r.supervisor.run({ tickMs: 1, maxTicks: 2 })
      assert.ok(r.supervisor.log.length >= 3)
      for (const event of r.supervisor.log) {
        assert.ok(event.code.length > 0)
        assert.ok(event.timestamp.length > 0)
        assert.ok(event.state.length > 0)
      }
      const codes = r.supervisor.log.map((event) => event.code)
      assert.ok(codes.includes('supervisor_started'))
      assert.ok(codes.includes('relaunched'))
    } finally {
      cleanup(r)
    }
  })

  it('contains a throwing log observer', async () => {
    const r = rig({ answers: [dead, alive] })
    try {
      const supervisor = new (await import('../lib/supervisor/index.js')).RestartSupervisor({
        config: resolveConfig(),
        directory: r.directory,
        watchPid: 4242,
        now: () => r.state.now,
        probe: r.probe,
        launcher: r.launcher,
        argv: ['node', 'dsh.js'],
        onEvent: () => {
          throw new Error('log observer exploded')
        },
      })
      const result = await supervisor.run({ tickMs: 1, maxTicks: 2 })
      assert.equal(result.relaunches, 1, 'supervision must continue')
    } finally {
      cleanup(r)
    }
  })
})

/** Remove a rig's directory. */
function cleanup(r) {
  assert.equal(existsSync(r.directory), true)
  rmSync(r.directory, { recursive: true, force: true })
}
