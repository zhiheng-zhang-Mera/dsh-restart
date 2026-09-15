// Throwaway diagnostic: what pressure does the calibrated cross-plugin rig produce?
import { pathToFileURL } from 'node:url'

const health = await import(pathToFileURL('../dsh-health-scheduler/lib/index.js').href)

const at = new Date(Date.parse('2026-06-01T00:00:00.000Z'))
at.setHours(4, 30, 0, 0)
const clock = () => at.getTime()

const calls = []
const scheduler = new health.HealthScheduler({
  config: health.resolveConfig({
    thresholds: {
      throttle: { enter: 1, exit: 0.5 },
      pause_new_work: { enter: 2, exit: 1 },
      request_app_restart: { enter: 3, exit: 2 },
      request_system_reboot: { enter: 90, exit: 85 },
    },
    antiFlap: { debounceEvaluations: 1, minStateDwellMs: 0, minRepeatActionMs: 0 },
    maintenance: { enabled: true, safePointRequired: true, targetTime: '04:00', windowStart: '03:30', windowEnd: '05:00' },
    disabledProviders: ['hardware', 'memory', 'runtime', 'workers', 'computer-use', 'ui', 'context'],
    metrics: { timeout_rate: { band: { warn: 0.02, critical: 0.2 }, sustainMs: 0 } },
  }),
  restart: {
    id: 'dsh-restart',
    capability: 'available',
    requestApplicationRestart: async (r) => {
      calls.push(r)
      return { accepted: true, state: 'shutting_down', detail: 'ok', requestId: r.requestId, ticketId: 't' }
    },
    requestSystemRestart: async (r) => {
      calls.push({ system: r })
      return { accepted: false, state: 'rejected', detail: 'no', requestId: r.requestId }
    },
    cancelPendingRestart: async () => true,
  },
  workerControl: {
    id: 'noop',
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
scheduler.registerProvider({
  id: 'cross-double',
  group: 'workers',
  provides: ['timeout_rate'],
  enabled: true,
  sample: () => ({ provider: 'cross-double', timestamp: new Date(clock()).toISOString(), metrics: { timeout_rate: 0.9 } }),
})

for (let i = 0; i < 3; i += 1) {
  const s = await scheduler.tick()
  console.log(
    `tick ${i}: pressure=${s.pressure} state=${s.state} action=${s.action} dims=${s.dimensions
      .filter((d) => d.score !== null)
      .map((d) => `${d.dimension}=${d.score}(w=${d.weight},ew=${d.effectiveWeight.toFixed(2)})`)
      .join(' ')} calls=${calls.length}`,
  )
  at.setMinutes(at.getMinutes() + 1)
}
