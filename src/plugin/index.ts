/**
 * Harness integration for `dsh-restart`.
 *
 * Design point worth stating once, in the place it is implemented: **nothing here
 * can prevent DS-Hns from starting.** Configuration problems are reported and the
 * plugin continues on the defaults; a missing checkpoint port means restarts are
 * refused, not that the host fails to boot; and the plugin registers exactly one
 * settings namespace
 * and three tools, so removing it removes all of them.
 *
 * @module dsh-restart/plugin
 */

import { resolveConfig, tryResolveConfig } from '../shared/config.js'
import type { RestartConfig, RestartConfigOverrides } from '../shared/types.js'
import type { HarnessContextLike, ToolDefinitionLike } from './context.js'
import { loggerOf } from './context.js'
import { RestartAuditLog } from './audit.js'
import { TicketStore } from './ticket-store.js'
import { RestartManager } from './restart-manager.js'
import { UnboundCheckpointPort } from './checkpoint-gate.js'
import { createHealthSchedulerBridge } from './health-scheduler-bridge.js'
import { HostShutdownPort, RecordingLifecycle, WindowsSystemShutdownPort, type HostLifecycle } from './ports.js'
import type { CheckpointPort, ShutdownPort, SystemShutdownPort } from '../shared/types.js'
import type { RestartResponse, RestartStatus } from '../shared/protocol.js'

/** Settings namespace owned by this plugin. */
export const SETTINGS_NAMESPACE = 'restart'

/** Tool names registered for the model. */
export const TOOL_NAMES = Object.freeze({
  status: 'restart_status',
  request: 'restart_request',
  cancel: 'restart_cancel',
})

/** Collaborators the entry point injects, so this module stays testable. */
export interface PluginDependencies {
  resolveConfig(overrides: RestartConfigOverrides): RestartConfig
  tryResolveConfig(overrides: RestartConfigOverrides): { config: RestartConfig; error: Error | null }
}

/** Test seams and deployment overrides. */
export interface ApplyOptions {
  /** Where tickets, heartbeats and the ledger live. Defaults to `<state>/restart`. */
  readonly stateDirectory?: string
  /** The checkpoint seam. Defaults to the unbound port, which refuses everything. */
  readonly checkpoint?: CheckpointPort
  /** The graceful-shutdown seam. Defaults to a recording lifecycle. */
  readonly shutdown?: ShutdownPort
  /** The OS-reboot seam, or `null` when the machine cannot be rebooted. */
  readonly systemShutdown?: SystemShutdownPort | null
  /** The host lifecycle behind the default shutdown port. */
  readonly lifecycle?: HostLifecycle
  /** Injectable clock. */
  readonly now?: () => number
  /** Pid the supervisor should watch. Defaults to this process. */
  readonly pid?: number
}

/** The applied plugin. */
export interface AppliedRestart {
  readonly manager: RestartManager
  readonly config: RestartConfig
  readonly store: TicketStore
  readonly audit: RestartAuditLog
  readonly toolNames: readonly string[]
  /** What startup reconciliation found, or `null`. */
  readonly reconciled: { readonly ticketId: string; readonly detail: string } | null
  dispose(): void
}

/**
 * Wire the plugin into a harness context.
 *
 * @param ctx - the harness context, structurally typed in `./context.js`.
 * @param overrides - bundle configuration.
 * @param deps - configuration resolvers from the package entry point.
 * @param options - deployment overrides and test seams.
 */
export function applyRestart(
  ctx: HarnessContextLike,
  overrides: RestartConfigOverrides = {},
  deps: PluginDependencies,
  options: ApplyOptions = {},
): AppliedRestart {
  const log = loggerOf(ctx)
  const { config, error } = deps.tryResolveConfig(overrides)
  if (error !== null) {
    log.error(
      `dsh-restart: configuration was rejected (${error.message}); continuing with the shipped defaults. ` +
        'Fix the offending value and reload the profile to activate it.',
    )
  }

  const directory = options.stateDirectory ?? defaultStateDirectory(ctx)
  const store = new TicketStore(directory)
  const audit = new RestartAuditLog({
    directory: config.storage.directory === null ? directory : config.storage.directory,
    maxBytes: config.storage.maxLogBytes,
    maxRecords: config.storage.maxRecentAttempts,
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  const manager = new RestartManager({
    config,
    ports: {
      checkpoint: options.checkpoint ?? new UnboundCheckpointPort(),
      shutdown: options.shutdown ?? new HostShutdownPort(options.lifecycle ?? new RecordingLifecycle()),
      systemShutdown: options.systemShutdown === undefined ? defaultSystemShutdown() : options.systemShutdown,
    },
    store,
    audit,
    ...(options.pid === undefined ? {} : { pid: options.pid }),
    ...(options.now === undefined ? {} : { now: options.now }),
    onAttempt: (record) => {
      log.info(
        `dsh-restart: ${record.state} ${record.mode} restart for ${record.requestId} (${record.outcomeCode}) — ${record.detail}`,
      )
    },
  })

  const reconciled = manager.reconcileAfterRestart()
  if (reconciled !== null) {
    log.warn(`dsh-restart: ${reconciled.detail}`)
  }

  // Publish the bridge the health scheduler reads. Without this the two plugins each
  // work but never connect: the health scheduler silently falls back to its unavailable
  // adapter and every restart decision is downgraded with
  // `restart_capability_unavailable`, which looks like a policy choice rather than a
  // missing wire.
  const bridge = createHealthSchedulerBridge(manager)
  let published = false
  try {
    ctx.healthScheduler = bridge
    published = true
  } catch (error) {
    log.warn(
      `dsh-restart: could not publish the restart adapter on the context (${(error as Error).message}); ` +
        'dsh-health-scheduler will report the restart capability as unavailable',
    )
  }

  if (published) {
    log.info(
      `dsh-restart: published its restart adapter as ctx.healthScheduler (capability ${bridge.capability}), so dsh-health-scheduler can request restarts`,
    )
  }

  const toolNames = ctx.tools === undefined ? [] : registerTools(ctx, manager, config, log)
  if (ctx.tools === undefined) {
    log.warn('dsh-restart: no tool runtime in this profile; restart control is available through the plugin API only')
  }
  registerSettings(ctx, config, deps, manager, log)

  log.info(
    `dsh-restart: ready (application=${config.applicationRestart.enabled}, system=${config.systemRestart.enabled && config.allowSystemReboot}, adapter=${published ? `published (${bridge.capability})` : 'not published'}, state=${directory})`,
  )

  const dispose = (): void => {
    log.info('dsh-restart: disposed')
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)

  return { manager, config, store, audit, toolNames, reconciled, dispose }
}

/** State directory: `<DSH_HOME>/restart`, or a temp fallback. */
function defaultStateDirectory(ctx: HarnessContextLike): string {
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home.trim() !== '' ? home.trim() : ctx.stateDirectory
  if (typeof base === 'string' && base.trim() !== '') {
    return `${base.replace(/[\\/]+$/, '')}${process.platform === 'win32' ? '\\' : '/'}restart`
  }
  return `${process.cwd()}${process.platform === 'win32' ? '\\' : '/'}.dsh-restart`
}

/** The system-shutdown port, present only where it means something. */
function defaultSystemShutdown(): SystemShutdownPort | null {
  return process.platform === 'win32' ? new WindowsSystemShutdownPort() : null
}

/** Register the three restart tools. */
function registerTools(
  ctx: HarnessContextLike,
  manager: RestartManager,
  config: RestartConfig,
  log: ReturnType<typeof loggerOf>,
): readonly string[] {
  const tools = ctx.tools
  if (tools === undefined) return []
  const disposers: Array<() => void> = []

  const status = tool({
    name: TOOL_NAMES.status,
    description:
      'Report the restart subsystem: whether a restart is possible right now and why not, the restart lock state, ' +
      'cooldowns, crash-loop breaker state, supervisor presence, and the most recent restart attempts. Read-only.',
    parameters: {},
    execute: async () => JSON.stringify(statusPayload(manager.getRestartStatus()), null, 2),
  })

  const request = tool({
    name: TOOL_NAMES.request,
    description:
      'Request a restart. This tool only submits a request: it does not decide whether one is warranted, and it ' +
      'cannot bypass the checkpoint, cooldown or supervisor checks. An application restart asks the host to shut ' +
      'down gracefully; an external supervisor then relaunches it. A system restart requires allowSystemReboot in ' +
      'the configuration plus acknowledge_system_reboot here. Reason codes: ' +
      `${config.knownReasonCodes.slice(0, 6).join(', ')}, …`,
    parameters: {
      mode: {
        type: 'string',
        required: true,
        enum: ['application', 'system'],
        description: 'Restart scope. "application" restarts DS-Hns; "system" reboots the machine.',
      },
      reason_code: {
        type: 'string',
        required: true,
        description: 'Stable reason code, for example RUNTIME_PRESSURE or OPERATOR_REQUEST.',
      },
      reason_summary: {
        type: 'string',
        required: true,
        description: 'One line explaining why the restart is wanted. Recorded verbatim in the audit log.',
      },
      checkpoint_required: {
        type: 'boolean',
        required: false,
        description: 'Whether a checkpoint must succeed first. Defaults to true, which is the safe choice.',
      },
      priority: {
        type: 'string',
        required: false,
        enum: ['low', 'normal', 'high', 'emergency'],
        description: 'Priority hint. Never bypasses validation. Defaults to normal.',
      },
      acknowledge_system_reboot: {
        type: 'boolean',
        required: false,
        description: 'Required for mode "system": an explicit statement that rebooting the machine is intended.',
      },
    },
    execute: async (args: {
      mode: string
      reason_code: string
      reason_summary: string
      checkpoint_required?: boolean
      priority?: string
      acknowledge_system_reboot?: boolean
    }) => {
      const requestId = `tool-${Date.now()}-${Math.round(Math.random() * 1e6)}`
      const payload = {
        requestId,
        source: 'dsh-cli',
        mode: args.mode,
        reasonCode: args.reason_code,
        reasonSummary: args.reason_summary,
        checkpointRequired: args.checkpoint_required !== false,
        priority: args.priority ?? 'normal',
        createdAt: new Date().toISOString(),
        acknowledgeSystemReboot: args.acknowledge_system_reboot === true,
      }
      const response: RestartResponse =
        args.mode === 'system'
          ? await manager.requestSystemRestart(payload as never)
          : await manager.requestApplicationRestart(payload as never)
      return JSON.stringify(response, null, 2)
    },
    timeoutMs: 30_000,
  })

  const cancel = tool({
    name: TOOL_NAMES.cancel,
    description:
      'Cancel a pending restart before the shutdown has been requested. Once the host is shutting down there is ' +
      'nothing left to cancel, and the ticket has already been handed to the supervisor.',
    parameters: {
      request_id: { type: 'string', required: true, description: 'The request id returned when it was submitted.' },
    },
    execute: async (args: { request_id: string }) => {
      const cancelled = await manager.cancelPendingRestart(args.request_id)
      return JSON.stringify(
        {
          cancelled,
          detail: cancelled
            ? `request ${args.request_id} cancelled; no restart will happen`
            : `request ${args.request_id} is not pending (it may have completed, been refused, or never existed)`,
        },
        null,
        2,
      )
    },
  })

  for (const definition of [status, request, cancel]) {
    try {
      disposers.push(tools.register(definition))
    } catch (registerError) {
      log.error(
        `dsh-restart: tool registration failed for ${definition.name}: ${(registerError as Error).message}`,
      )
    }
  }
  return [TOOL_NAMES.status, TOOL_NAMES.request, TOOL_NAMES.cancel].slice(0, disposers.length)
}

/** Register the settings namespace, when the profile has a settings service. */
function registerSettings(
  ctx: HarnessContextLike,
  config: RestartConfig,
  deps: PluginDependencies,
  manager: RestartManager,
  log: ReturnType<typeof loggerOf>,
): void {
  if (ctx.settings === undefined) {
    log.warn('dsh-restart: no settings service in this profile; configuration comes from the bundle patch only')
    return
  }
  try {
    const scope = ctx.settings.register<RestartConfig>(SETTINGS_NAMESPACE, schema(), {
      base: config,
      applies: 'live',
    })
    if (typeof scope.watch === 'function') {
      scope.watch((next) => {
        // Configuration is validated but not hot-swapped: replacing the safety
        // bounds under an in-flight restart is how a checkpoint gets skipped. The
        // new document takes effect on the next profile load, and the plugin says
        // so rather than pretending otherwise.
        try {
          deps.resolveConfig(next as RestartConfigOverrides)
          log.info('dsh-restart: configuration changed; the new bounds apply after the next profile load')
        } catch (error) {
          log.error(`dsh-restart: rejected settings update: ${(error as Error).message}`)
        }
      })
    }
  } catch (error) {
    log.error(`dsh-restart: settings registration failed: ${(error as Error).message}`)
  }
  void manager
}

/** The settings schema handed to the harness. */
function schema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', description: 'Master switch for restart execution.' },
      allowSystemReboot: {
        type: 'boolean',
        description: 'Whether a system reboot may ever be performed. Requires a restart ticket as well.',
      },
    },
    additionalProperties: true,
  }
}

/** The status payload, with the names a caller sees. */
export function statusPayload(status: RestartStatus): Record<string, unknown> {
  return {
    timestamp: status.timestamp,
    enabled: status.enabled,
    lock: status.lock,
    can_restart: status.canRestart.allowed,
    can_restart_reason: status.canRestart.reason,
    active: status.active,
    cooldowns: status.cooldowns,
    crash_loop: status.crashLoop,
    supervisor: status.supervisor,
    capabilities: status.capabilities,
    recent: status.recent,
  }
}

/** Build a tool definition that satisfies the harness contract. */
function tool(spec: {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: never) => Promise<string>
  timeoutMs?: number
}): ToolDefinitionLike {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    execute: spec.execute as ToolDefinitionLike['execute'],
    timeoutMs: spec.timeoutMs ?? 10_000,
  }
}

/** Re-exported so the entry point can hand them to {@link applyRestart}. */
export const configResolvers: PluginDependencies = { resolveConfig, tryResolveConfig }
