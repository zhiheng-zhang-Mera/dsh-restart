/**
 * The bridge `dsh-health-scheduler` looks for.
 *
 * The two plugins are separate packages and neither imports the other at runtime, so
 * the seam between them has to be a real object published under a name both sides know.
 * That name is `healthScheduler` — it is what the health scheduler reads off the harness
 * context — and this module is the thing that belongs there.
 *
 * It exists as its own module because the two interfaces were designed independently and
 * do not line up by accident:
 *
 * - the health scheduler wants `capability: 'available' | 'unavailable' | 'failed'`,
 *   `id`, `requestApplicationRestart`, `requestSystemRestart` and `cancelPendingRestart`;
 * - {@link RestartManager} has the four methods but no `capability` field, because a
 *   manager's availability is a function of its configuration rather than a property.
 *
 * Without this adapter the health scheduler's structural check rejects a manager handed
 * to it directly, silently falls back to {@link UnavailableRestartAdapter}, and every
 * restart decision is downgraded to `PAUSE_NEW_WORK` forever. That failure is quiet,
 * which is exactly why the bridge is a named, tested export instead of an inline object
 * in someone's wiring script.
 *
 * @module dsh-restart/plugin/health-scheduler-bridge
 */

import type { RestartManager } from './restart-manager.js'
import type { RestartResponse } from '../shared/protocol.js'

/**
 * The slice of the health scheduler's `RestartAdapter` this bridge implements.
 *
 * Declared structurally rather than imported: depending on the sibling package would
 * make the two repositories uninstallable independently, which is the property the
 * split exists to preserve.
 */
export interface HealthSchedulerRestartAdapter {
  /** Adapter id, recorded in the health scheduler's audit log. */
  readonly id: string
  /** What the health scheduler must see before it will raise a restart request. */
  readonly capability: 'available' | 'unavailable' | 'failed'
  /** Ask for an application restart. */
  requestApplicationRestart(request: RestartRequestLike): Promise<RestartResponse>
  /** Ask for a machine restart. */
  requestSystemRestart(request: RestartRequestLike): Promise<RestartResponse>
  /** Abandon a pending request. */
  cancelPendingRestart(requestId: string): Promise<boolean>
}

/** The request fields the bridge forwards; the manager validates the rest. */
export interface RestartRequestLike {
  readonly requestId: string
  readonly source: string
  readonly mode: 'application' | 'system'
  readonly reasonCode: string
  readonly reasonSummary: string
  readonly checkpointRequired: boolean
  readonly priority: 'low' | 'normal' | 'high' | 'emergency'
  /** Required by the manager for `mode: 'system'`. */
  readonly acknowledgeSystemReboot?: boolean
}

/** A capability-annotated view of a {@link RestartManager}. */
export interface HealthSchedulerBridge extends HealthSchedulerRestartAdapter {
  /** The manager behind the bridge, for a caller that needs more than the seam. */
  readonly manager: RestartManager
}

/**
 * Wrap a manager so the health scheduler can use it.
 *
 * The capability is derived, not asserted: `available` only when restart execution is
 * enabled and a restart mode is actually on. A manager that would refuse everything
 * reports `unavailable`, so the health scheduler downgrades its decision and says
 * `restart_capability_unavailable` instead of raising a request that cannot succeed.
 *
 * @param manager - the real manager.
 * @returns the adapter to publish under `healthScheduler`.
 */
export function createHealthSchedulerBridge(manager: RestartManager): HealthSchedulerBridge {
  return {
    id: 'dsh-restart',
    get capability(): 'available' | 'unavailable' | 'failed' {
      return manager.capabilityForHealthScheduler
    },
    manager,
    requestApplicationRestart: (request) => manager.requestApplicationRestart(request as never),
    requestSystemRestart: (request) => manager.requestSystemRestart(request as never),
    cancelPendingRestart: (requestId) => manager.cancelPendingRestart(requestId),
  }
}
