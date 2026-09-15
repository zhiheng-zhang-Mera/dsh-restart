/**
 * Request validation.
 *
 * `dsh-restart` does not parse business meaning. It checks exactly the things the
 * design lists — id uniqueness, source permission, mode permission, cooldown,
 * pending restart, checkpoint requirement, checkpoint token validity — and refuses
 * everything else with a machine-readable code.
 *
 * The order of the checks matters: cheap, structural refusals come first, so a
 * malformed request never reaches the code that writes files.
 *
 * @module dsh-restart/request-validator
 */

import type { RestartConfig } from '../shared/types.js'
import type { NormalizedRequest, ValidationResult } from '../shared/types.js'
import type { RestartRequest } from '../shared/protocol.js'
import { canonicalJson } from '../shared/protocol.js'

/** The facts a validator needs about the world right now. */
export interface ValidatorContext {
  /** Evaluation instant, epoch milliseconds. */
  readonly nowMs: number
  /** Whether a restart is already in flight. */
  readonly restartInFlight: boolean
  /** Cooldown deadlines per mode, epoch milliseconds. */
  readonly cooldowns: { readonly application: number; readonly system: number }
  /** Whether a duplicated request id has already been seen. */
  readonly isDuplicate: boolean
  /** Whether the crash-loop breaker is holding automatic restart disabled. */
  readonly crashLoopTripped: boolean
  /** Whether the supervisor has been seen inside its timeout. */
  readonly supervisorPresent: boolean
  /** Whether a checkpoint port is bound. */
  readonly checkpointPortAvailable: boolean
}

/** Upper bounds that keep a request from being used as a log-injection vector. */
const MAX_ID_LENGTH = 128
const MAX_SOURCE_LENGTH = 64
const MAX_REASON_CODE_LENGTH = 64
const MAX_SUMMARY_LENGTH = 500

/** Field-level shape validation, before any policy check. */
export function validateShape(value: unknown): ValidationResult {
  if (typeof value !== 'object' || value === null) {
    return refuse('INVALID_REQUEST', `request must be an object, received ${typeof value}`)
  }
  const request = value as Partial<RestartRequest>

  const stringField = (
    field: keyof RestartRequest,
    value: unknown,
    max: number,
  ): { ok: true; value: string } | { ok: false; result: ValidationResult } => {
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, result: refuse('INVALID_REQUEST', `${String(field)} must be a non-empty string`) }
    }
    const trimmed = value.trim()
    if (trimmed.length > max) {
      return { ok: false, result: refuse('INVALID_REQUEST', `${String(field)} exceeds ${max} characters`) }
    }
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
      return { ok: false, result: refuse('INVALID_REQUEST', `${String(field)} contains control characters`) }
    }
    return { ok: true, value: trimmed }
  }

  const requestId = stringField('requestId', request.requestId, MAX_ID_LENGTH)
  if (!requestId.ok) return requestId.result
  const source = stringField('source', request.source, MAX_SOURCE_LENGTH)
  if (!source.ok) return source.result
  const reasonCode = stringField('reasonCode', request.reasonCode, MAX_REASON_CODE_LENGTH)
  if (!reasonCode.ok) return reasonCode.result
  const reasonSummary = stringField('reasonSummary', request.reasonSummary, MAX_SUMMARY_LENGTH)
  if (!reasonSummary.ok) return reasonSummary.result

  if (request.mode !== 'application' && request.mode !== 'system') {
    return refuse('INVALID_REQUEST', `mode must be "application" or "system", received ${JSON.stringify(request.mode)}`)
  }
  if (typeof request.checkpointRequired !== 'boolean') {
    return refuse('INVALID_REQUEST', 'checkpointRequired must be a boolean')
  }
  const priority = request.priority ?? 'normal'
  if (!['low', 'normal', 'high', 'emergency'].includes(priority)) {
    return refuse('INVALID_REQUEST', `priority must be low, normal, high or emergency, received ${JSON.stringify(priority)}`)
  }
  if (request.createdAt !== undefined && typeof request.createdAt !== 'string') {
    return refuse('INVALID_REQUEST', 'createdAt must be an ISO-8601 string when present')
  }
  if (request.acknowledgeSystemReboot !== undefined && typeof request.acknowledgeSystemReboot !== 'boolean') {
    return refuse('INVALID_REQUEST', 'acknowledgeSystemReboot must be a boolean when present')
  }

  return {
    valid: true,
    code: null,
    detail: 'request shape is valid',
    request: {
      requestId: requestId.value,
      source: source.value,
      mode: request.mode,
      reasonCode: reasonCode.value,
      reasonSummary: reasonSummary.value,
      checkpointRequired: request.checkpointRequired,
      priority,
      createdAt: request.createdAt ?? new Date(0).toISOString(),
      acknowledgeSystemReboot: request.acknowledgeSystemReboot === true,
    },
  }
}

/**
 * Validate a request against configuration and world state.
 *
 * @param value - the untrusted request.
 * @param config - resolved configuration.
 * @param context - current world state.
 */
export function validateRequest(value: unknown, config: RestartConfig, context: ValidatorContext): ValidationResult {
  const shape = validateShape(value)
  if (!shape.valid || shape.request === null) return shape
  const request: NormalizedRequest = shape.request

  if (!config.enabled) {
    return refuse('DISABLED', 'restart execution is disabled by configuration')
  }

  if (!config.allowedSources.includes(request.source)) {
    return refuse(
      'UNKNOWN_SOURCE',
      `source ${JSON.stringify(request.source)} is not allowed; allowed sources: ${config.allowedSources.join(', ')}`,
    )
  }

  if (!config.allowedPriorities.includes(request.priority)) {
    return refuse('INVALID_REQUEST', `priority ${request.priority} is not accepted by this deployment`)
  }

  const mode = request.mode === 'system' ? config.systemRestart : config.applicationRestart
  if (!mode.enabled) {
    return refuse('MODE_NOT_ALLOWED', `${request.mode} restart is disabled by configuration`)
  }

  if (request.mode === 'system') {
    if (!config.allowSystemReboot) {
      return refuse(
        'SYSTEM_REBOOT_NOT_PERMITTED',
        'system restart requires allowSystemReboot = true in the configuration',
      )
    }
    if (!request.acknowledgeSystemReboot) {
      return refuse(
        'SYSTEM_REBOOT_NOT_PERMITTED',
        'system restart requires acknowledgeSystemReboot = true on the request itself',
      )
    }
  }

  if (context.crashLoopTripped) {
    return refuse(
      'CRASH_LOOP',
      'the crash-loop breaker has disabled automatic restart; clear it before requesting another restart',
    )
  }

  if (context.isDuplicate && config.safety.duplicateSuppression) {
    return refuse('DUPLICATE_REQUEST_ID', `request id ${request.requestId} has already been processed`)
  }

  if (context.restartInFlight) {
    return refuse('RESTART_IN_FLIGHT', 'another restart is already in progress')
  }

  const cooldown = request.mode === 'system' ? context.cooldowns.system : context.cooldowns.application
  if (cooldown > context.nowMs) {
    const remaining = Math.ceil((cooldown - context.nowMs) / 1000)
    return refuse(
      'COOLDOWN_ACTIVE',
      `${request.mode} restart is in cooldown for another ${remaining}s (minimum interval ${Math.round(
        mode.minIntervalMs / 1000,
      )}s)`,
    )
  }

  if (!context.checkpointPortAvailable) {
    /*
     * No checkpoint port means the plugin cannot verify that a restart is safe.
     * When the deployment says a checkpoint is required, that is a refusal: the
     * design is explicit that a checkpoint that cannot be confirmed defaults to
     * aborting, and "no port" is the strongest form of "not confirmed".
     */
    if (config.safety.checkpointRequired) {
      return refuse(
        'CHECKPOINT_FAILED',
        'no checkpoint port is bound and safety.checkpointRequired is true, so a restart cannot be authorized',
      )
    }
  }

  if (!context.supervisorPresent && !config.safety.allowRestartWithoutSupervisor) {
    return refuse(
      'SUPERVISOR_ABSENT',
      'no supervisor heartbeat was seen; set safety.allowRestartWithoutSupervisor = true to restart anyway',
    )
  }

  return { valid: true, code: null, detail: 'request accepted', request }
}

/** Build a refusal result. */
export function refuse(code: string, detail: string): ValidationResult {
  return { valid: false, code, detail, request: null }
}

/**
 * A stable identity for a request's *content*, used to tell a genuine retry from a
 * different request that happens to reuse an id.
 */
export function requestFingerprint(request: NormalizedRequest): string {
  return canonicalJson({
    requestId: request.requestId,
    source: request.source,
    mode: request.mode,
    reasonCode: request.reasonCode,
    checkpointRequired: request.checkpointRequired,
    priority: request.priority,
  })
}
