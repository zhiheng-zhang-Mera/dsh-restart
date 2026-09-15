/**
 * Harness integration and cross-plugin protocol conformance.
 *
 * Two things matter here. First, that a misconfigured or half-installed plugin
 * degrades instead of taking the host down with it. Second, that the request this
 * plugin accepts is the request `dsh-health-scheduler` actually sends — the whole
 * point of a two-plugin split is that the seam between them holds.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import * as plugin from '../lib/index.js'
import { writeJsonAtomic } from '../lib/plugin/atomic.js'
import { SETTINGS_NAMESPACE, TOOL_NAMES, applyRestart, statusPayload } from '../lib/plugin/index.js'
import { RecordingLifecycle } from '../lib/plugin/ports.js'
import { RestartSupervisor } from '../lib/supervisor/index.js'
import { ScriptedLivenessProbe } from '../lib/supervisor/pid-watch.js'
import { ScriptedLauncher } from '../lib/supervisor/relaunch.js'
import { resolveConfig } from '../lib/shared/config.js'
import { checkpoints, validRequest, T0 } from './helpers/rig.js'

/** A fake harness context that records everything the plugin registers. */
function fakeContext(options = {}) {
  const tools = new Map()
  const logs = []
  const context = {
    logger: {
      debug: (message) => logs.push(['debug', message]),
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
    },
    ...(options.noTools === true
      ? {}
      : {
          tools: {
            register(definition) {
              if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
              tools.set(definition.name, definition)
              return () => tools.delete(definition.name)
            },
          },
        }),
    ...(options.noSettings === true
      ? {}
      : {
          settings: {
            register(ns, schema, registerOptions) {
              context.registeredSettings = { ns, schema, registerOptions }
              return { get: () => registerOptions.base }
            },
          },
        }),
  }
  return { context, tools, logs }
}

/** A fresh state directory per test. */
function stateDirectory() {
  return mkdtempSync(join(tmpdir(), 'dsh-restart-plugin-'))
}

/** Call one registered tool. */
async function callTool(tools, name, args = {}) {
  const definition = tools.get(name)
  assert.ok(definition, `tool ${name} is not registered`)
  const value = await definition.execute(args)
  return { value, blocks: definition.output.render(args, value) }
}

/** Publish a fresh heartbeat so the manager sees a live supervisor. */
function beat(directory, nowMs = T0) {
  writeJsonAtomic(join(directory, 'heartbeat.json'), {
    schemaVersion: 1,
    supervisorPid: 999,
    watchedPid: 4242,
    state: 'MONITORING',
    timestamp: new Date(nowMs).toISOString(),
    sequence: 1,
  })
}

describe('plugin exports', () => {
  it('exposes the Cordis plugin contract', () => {
    assert.equal(plugin.name, 'dsh-restart')
    assert.deepEqual(plugin.inject, [], 'this plugin must not require a service to load')
    assert.equal(typeof plugin.apply, 'function')
    assert.equal(typeof plugin.resolveConfig, 'function')
    assert.equal(typeof plugin.RestartManager, 'function')
    assert.equal(typeof plugin.RestartSupervisor, 'function')
    assert.equal(plugin.PROTOCOL_VERSION, 1)
    assert.equal(plugin.TICKET_SCHEMA_VERSION, 1)
  })

  it('exposes the public surface a requester needs', () => {
    for (const name of [
      'RestartManager',
      'RestartSupervisor',
      'RestartLock',
      'CheckpointGate',
      'TicketStore',
      'RestartAuditLog',
      'CrashLoopBreaker',
      'validateRequest',
      'verifyTicket',
      'buildTicket',
      'canonicalJson',
      'resolveConfig',
      'deriveLaunchSpec',
    ]) {
      assert.equal(typeof plugin[name], 'function', `${name} should be exported as a function`)
    }
    for (const name of [
      'UnboundCheckpointPort',
      'FileCheckpointPort',
      'FunctionCheckpointPort',
      'HostShutdownPort',
      'RecordingLifecycle',
      'WindowsSystemShutdownPort',
      'SystemLivenessProbe',
      'ScriptedLivenessProbe',
      'ChildProcessLauncher',
      'ScriptedLauncher',
      'HeartbeatWriter',
    ]) {
      assert.equal(typeof plugin[name], 'function', `${name} should be exported as a constructor`)
    }
  })

  it('contains no health policy and no scheduling of any kind', async () => {
    const fs = await import('node:fs')
    const source = fs
      .readdirSync(new URL('../lib', import.meta.url), { recursive: true })
      .filter((name) => typeof name === 'string' && name.endsWith('.js'))
      .map((name) => fs.readFileSync(new URL(`../lib/${name}`, import.meta.url), 'utf8'))
      .join('\n')
    for (const forbidden of [
      'temperature',
      'thermal_throttle',
      'gpu_temp',
      'cpu_temp',
      'restart_pressure',
      'pressureScore',
      'maintenanceWindow',
      'targetTime',
      'cron',
      'scheduleAt',
      'workerConcurrency',
    ]) {
      assert.equal(
        source.toLowerCase().includes(forbidden.toLowerCase()),
        false,
        `the built output must not contain "${forbidden}": deciding when to restart is not this plugin's job`,
      )
    }

    // `THERMAL_STRESS` is a reason *code* the requester chooses, not a threshold
    // this plugin evaluates, so one occurrence — the default code list — is right.
    const occurrences = source.match(/THERMAL_STRESS/g) ?? []
    assert.ok(occurrences.length <= 1, 'the thermal reason code must exist only as a listed code')
  })
})

describe('applyRestart', () => {
  it('registers the three tools, its settings namespace, and reports readiness', () => {
    const directory = stateDirectory()
    try {
      const { context, tools, logs } = fakeContext()
      const applied = applyRestart(context, {}, plugin, {
        stateDirectory: directory,
        checkpoint: checkpoints.ok(),
        lifecycle: new RecordingLifecycle(),
      })
      assert.deepEqual([...tools.keys()].sort(), Object.values(TOOL_NAMES).sort())
      assert.equal(context.registeredSettings.ns, SETTINGS_NAMESPACE)
      assert.equal(context.registeredSettings.registerOptions.applies, 'live')
      assert.ok(logs.some(([level, message]) => level === 'info' && message.includes('ready')))
      assert.equal(applied.reconciled, null)
      applied.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reports a rejected configuration and keeps running on the defaults', () => {
    const directory = stateDirectory()
    try {
      const { context, tools, logs } = fakeContext()
      const applied = applyRestart(
        context,
        { supervisor: { heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 30_000 } },
        plugin,
        { stateDirectory: directory, checkpoint: checkpoints.ok() },
      )
      assert.ok(logs.some(([level, message]) => level === 'error' && message.includes('configuration was rejected')))
      assert.equal(applied.config.supervisor.heartbeatTimeoutMs, 30_000, 'the shipped default is used')
      assert.equal(tools.size, 3, 'the plugin still works')
      applied.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('runs without a tools service or a settings service', () => {
    const directory = stateDirectory()
    try {
      const { context, logs } = fakeContext({ noTools: true, noSettings: true })
      const applied = applyRestart(context, {}, plugin, { stateDirectory: directory, checkpoint: checkpoints.ok() })
      assert.deepEqual(applied.toolNames, [])
      assert.ok(logs.some(([level, message]) => level === 'warn' && message.includes('no tool runtime')))
      assert.ok(logs.some(([level, message]) => level === 'warn' && message.includes('no settings service')))
      applied.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reconciles a ticket left by a previous process and says so', () => {
    const directory = stateDirectory()
    try {
      const first = fakeContext()
      const appliedOnce = applyRestart(first.context, {}, plugin, {
        stateDirectory: directory,
        checkpoint: checkpoints.ok(),
        lifecycle: new RecordingLifecycle(),
        now: () => T0,
      })
      appliedOnce.store.writeTicket(
        plugin.buildTicket({
          ticketId: 'application-x',
          requestId: 'req-stale',
          mode: 'application',
          reasonCode: 'TEST',
          reasonSummary: 'left behind',
          pid: 1,
          ttlMs: 600_000,
          cleanShutdown: true,
          checkpointId: null,
          nowMs: T0,
        }),
      )

      const second = fakeContext()
      const appliedTwice = applyRestart(second.context, {}, plugin, {
        stateDirectory: directory,
        checkpoint: checkpoints.ok(),
        now: () => T0 + 1_000,
      })
      assert.ok(appliedTwice.reconciled !== null)
      assert.match(appliedTwice.reconciled.detail, /did not exit/)
      assert.ok(second.logs.some(([level]) => level === 'warn'))
      appliedTwice.dispose()
      appliedOnce.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('defaults to the unbound checkpoint port, so an unconfigured install refuses to restart', async () => {
    const directory = stateDirectory()
    try {
      const { context } = fakeContext()
      const applied = applyRestart(context, {}, plugin, {
        stateDirectory: directory,
        lifecycle: new RecordingLifecycle(),
        now: () => T0,
      })
      const status = applied.manager.getRestartStatus()
      assert.equal(status.capabilities.checkpointPort, false)
      const response = await applied.manager.requestApplicationRestart(validRequest())
      assert.equal(response.accepted, false)
      assert.match(response.detail, /no checkpoint port/)
      applied.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('model-facing tools', () => {
  function wired(options = {}) {
    const directory = stateDirectory()
    const { context, tools } = fakeContext()
    const applied = applyRestart(context, options.config ?? {}, plugin, {
      stateDirectory: directory,
      checkpoint: options.checkpoint ?? checkpoints.ok(),
      lifecycle: options.lifecycle ?? new RecordingLifecycle(),
      systemShutdown: options.systemShutdown,
      now: () => T0,
    })
    return { applied, tools, directory }
  }

  it('restart_status explains why a restart is or is not possible', async () => {
    const { applied, tools, directory } = wired()
    try {
      const { value, blocks } = await callTool(tools, TOOL_NAMES.status)
      const payload = JSON.parse(value)
      assert.equal(payload.can_restart, false)
      assert.equal(payload.can_restart_reason, 'SUPERVISOR_ABSENT', 'no heartbeat has been written yet')
      assert.equal(payload.lock, 'IDLE')
      assert.equal(payload.capabilities.applicationRestart, true)
      assert.equal(blocks[0].type, 'text')

      // With a heartbeat present the answer flips.
      beat(directory)
      const withSupervisor = JSON.parse((await callTool(tools, TOOL_NAMES.status)).value)
      assert.equal(withSupervisor.can_restart, true)
      assert.equal(withSupervisor.can_restart_reason, 'OK')
      assert.equal(withSupervisor.supervisor.present, true)
      applied.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('restart_request submits a request and reports the refusal verbatim', async () => {
    const { applied, tools, directory } = wired()
    try {
      const { value } = await callTool(tools, TOOL_NAMES.request, {
        mode: 'application',
        reason_code: 'OPERATOR_REQUEST',
        reason_summary: 'the operator asked for a restart from the chat',
      })
      const response = JSON.parse(value)
      assert.equal(response.accepted, false)
      assert.equal(response.reason, 'SUPERVISOR_ABSENT', 'the tool must not bypass any check')
      applied.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('restart_request accepts a request once a supervisor is present', async () => {
    const directory = stateDirectory()
    try {
      const lifecycle = new RecordingLifecycle()
      const { context, tools } = fakeContext()
      const applied = applyRestart(context, {}, plugin, {
        stateDirectory: directory,
        checkpoint: checkpoints.ok(),
        lifecycle,
        now: () => T0,
      })
      beat(directory)
      const { value } = await callTool(tools, TOOL_NAMES.request, {
        mode: 'application',
        reason_code: 'OPERATOR_REQUEST',
        reason_summary: 'restart requested through the tool',
      })
      const response = JSON.parse(value)
      assert.equal(response.accepted, true)
      assert.equal(lifecycle.requests.length, 1)
      applied.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('restart_request refuses a system reboot without the acknowledgement', async () => {
    const directory = stateDirectory()
    try {
      const { context, tools } = fakeContext()
      const applied = applyRestart(
        context,
        { allowSystemReboot: true, systemRestart: { enabled: true } },
        plugin,
        {
          stateDirectory: directory,
          checkpoint: checkpoints.ok(),
          lifecycle: new RecordingLifecycle(),
          systemShutdown: { id: 'scripted', requestSystemRestart: () => true },
          now: () => T0,
        },
      )
      beat(directory)
      const { value } = await callTool(tools, TOOL_NAMES.request, {
        mode: 'system',
        reason_code: 'SYSTEM_PRESSURE',
        reason_summary: 'escalating to a machine restart',
      })
      const response = JSON.parse(value)
      assert.equal(response.accepted, false)
      assert.equal(response.reason, 'SYSTEM_REBOOT_NOT_PERMITTED')

      const acknowledged = JSON.parse(
        (
          await callTool(tools, TOOL_NAMES.request, {
            mode: 'system',
            reason_code: 'SYSTEM_PRESSURE',
            reason_summary: 'escalating to a machine restart',
            acknowledge_system_reboot: true,
          })
        ).value,
      )
      assert.equal(acknowledged.accepted, true)
      applied.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('restart_cancel cancels a pending request and reports the outcome', async () => {
    const directory = stateDirectory()
    try {
      const { context, tools } = fakeContext()
      const applied = applyRestart(context, {}, plugin, {
        stateDirectory: directory,
        checkpoint: checkpoints.ok(),
        lifecycle: new RecordingLifecycle(),
        now: () => T0,
      })
      beat(directory)
      const submitted = JSON.parse(
        (
          await callTool(tools, TOOL_NAMES.request, {
            mode: 'application',
            reason_code: 'TEST',
            reason_summary: 'to be cancelled',
          })
        ).value,
      )
      assert.equal(submitted.accepted, true)

      const cancelled = JSON.parse(
        (await callTool(tools, TOOL_NAMES.cancel, { request_id: submitted.requestId })).value,
      )
      assert.equal(cancelled.cancelled, true)
      assert.match(cancelled.detail, /no restart will happen/)
      assert.equal(applied.store.hasTicket(), false)

      const again = JSON.parse(
        (await callTool(tools, TOOL_NAMES.cancel, { request_id: submitted.requestId })).value,
      )
      assert.equal(again.cancelled, false)
      applied.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('advertises bounded timeouts and a string output schema', () => {
    const { applied, tools, directory } = wired()
    try {
      for (const definition of tools.values()) {
        assert.equal(definition.output.schema.type, 'string')
        assert.ok(typeof definition.timeoutMs === 'number' && definition.timeoutMs > 0)
        assert.ok(definition.description.length > 40)
      }
      applied.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('renders a status payload with snake_case wire names', async () => {
    const { applied, directory } = wired()
    try {
      const payload = statusPayload(applied.manager.getRestartStatus())
      assert.equal(typeof payload.timestamp, 'string')
      assert.equal(typeof payload.can_restart, 'boolean')
      assert.equal(typeof payload.can_restart_reason, 'string')
      assert.ok('cooldowns' in payload)
      assert.ok('crash_loop' in payload)
      assert.ok('supervisor' in payload)
      assert.ok('capabilities' in payload)
      assert.equal(JSON.stringify(payload).includes('undefined'), false)
      applied.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('protocol conformance with dsh-health-scheduler', () => {
  it('accepts exactly the request shape the health scheduler sends', async () => {
    const directory = stateDirectory()
    try {
      const { context } = fakeContext()
      const applied = applyRestart(
        context,
        { allowedSources: ['dsh-health-scheduler'] },
        plugin,
        {
          stateDirectory: directory,
          checkpoint: checkpoints.ok(),
          lifecycle: new RecordingLifecycle(),
          now: () => T0,
        },
      )
      beat(directory)

      // Shaped exactly like `HealthScheduler.applyAction` builds it: camelCase
      // requestId, a `priority` of normal/high, and `checkpointRequired` set from
      // the maintenance configuration.
      const response = await applied.manager.requestApplicationRestart({
        requestId: 'hs-1772297190000-1',
        source: 'dsh-health-scheduler',
        mode: 'application',
        reasonCode: 'RUNTIME_PRESSURE',
        reasonSummary: 'pressure_84_gte_app_restart_80, memory_slope_high, maintenance_window_open',
        checkpointRequired: true,
        priority: 'normal',
      })
      assert.equal(response.accepted, true)
      assert.equal(response.state, 'shutting_down')
      assert.ok(response.ticketId)

      const ticket = applied.store.readTicket(T0).ticket
      assert.equal(ticket.pid, process.pid, 'the ticket names the process the supervisor should watch')
      assert.equal(ticket.reasonCode, 'RUNTIME_PRESSURE')
      assert.equal(ticket.requestId, 'hs-1772297190000-1')
      applied.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reads a health scheduler response shape back out of the status call', async () => {
    const directory = stateDirectory()
    try {
      const { context } = fakeContext()
      const applied = applyRestart(context, {}, plugin, {
        stateDirectory: directory,
        checkpoint: checkpoints.ok(),
        lifecycle: new RecordingLifecycle(),
        now: () => T0,
      })
      beat(directory)
      const response = await applied.manager.requestApplicationRestart(validRequest({ requestId: 'hs-1' }))
      // The health scheduler reads `accepted`, `state` and `reason`; all three must
      // be present and correctly typed.
      assert.equal(typeof response.accepted, 'boolean')
      assert.equal(typeof response.state, 'string')
      assert.ok(['rejected', 'queued', 'checkpointing', 'shutting_down', 'relaunching', 'verifying', 'completed', 'failed'].includes(response.state))
      assert.equal(typeof response.detail, 'string')
      applied.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('refuses a request from a source that is not in the allow list', async () => {
    const directory = stateDirectory()
    try {
      const { context } = fakeContext()
      const applied = applyRestart(context, {}, plugin, {
        stateDirectory: directory,
        checkpoint: checkpoints.ok(),
        lifecycle: new RecordingLifecycle(),
        now: () => T0,
      })
      beat(directory)
      const response = await applied.manager.requestApplicationRestart(
        validRequest({ source: 'some-other-plugin' }),
      )
      assert.equal(response.accepted, false)
      assert.equal(response.reason, 'UNKNOWN_SOURCE')
      applied.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('supervisor and plugin agree on the ticket', () => {
  it('writes a ticket the supervisor accepts, consumes and erases', async () => {
    const directory = stateDirectory()
    try {
      const lifecycle = new RecordingLifecycle()
      const { context } = fakeContext()
      const applied = applyRestart(context, {}, plugin, {
        stateDirectory: directory,
        checkpoint: checkpoints.ok(),
        lifecycle,
        now: () => T0,
      })
      beat(directory)
      await applied.manager.requestApplicationRestart(validRequest({ requestId: 'hs-77' }))

      let now = T0
      const probe = new ScriptedLivenessProbe([
        { alive: true, method: 'scripted', error: null, detail: 'alive' },
        { alive: false, method: 'scripted', error: null, detail: 'gone' },
        { alive: true, method: 'scripted', error: null, detail: 'relaunched' },
      ])
      const launcher = new ScriptedLauncher({ startPid: 6000 })
      const supervisor = new RestartSupervisor({
        config: resolveConfig(),
        directory,
        watchPid: process.pid,
        now: () => now,
        probe,
        launcher,
        argv: ['node', 'dsh.js', '--profile', 'web'],
      })

      await supervisor.tick()
      assert.equal(supervisor.currentState, 'WAITING_FOR_EXIT')
      assert.equal(supervisor.pendingTicket().requestId, 'hs-77')

      await supervisor.tick()
      assert.equal(supervisor.currentState, 'WAITING_FOR_HEARTBEAT')
      assert.equal(launcher.specs.length, 1, 'the supervisor relaunched the harness')
      assert.equal(applied.store.hasTicket(), false, 'and consumed the ticket')

      await supervisor.tick()
      assert.equal(supervisor.hasVerifiedRelaunch, true)
      applied.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('ignores a ticket for a restart the plugin refused', async () => {
    const directory = stateDirectory()
    try {
      const { context } = fakeContext()
      // The unbound checkpoint port refuses every request, so no ticket is written.
      const applied = applyRestart(context, {}, plugin, {
        stateDirectory: directory,
        lifecycle: new RecordingLifecycle(),
        now: () => T0,
      })
      const response = await applied.manager.requestApplicationRestart(validRequest())
      assert.equal(response.accepted, false)
      assert.equal(applied.store.hasTicket(), false, 'a refused restart leaves nothing for a supervisor to find')

      const supervisor = new RestartSupervisor({
        config: resolveConfig(),
        directory,
        watchPid: process.pid,
        now: () => T0,
        probe: new ScriptedLivenessProbe([{ alive: true, method: 'scripted', error: null, detail: 'alive' }]),
        launcher: new ScriptedLauncher(),
        argv: ['node', 'dsh.js'],
      })
      const result = await supervisor.tick()
      assert.equal(result.reason, 'MONITORING')
      applied.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
