/**
 * Scripted checkpoint ports.
 *
 * The checkpoint seam is where a restart plugin is most tempted to be optimistic,
 * so the test doubles make every interesting answer easy to produce — including the
 * ones a real harness produces when it is busy, broken, or slow to reply.
 */

import { FunctionCheckpointPort } from '../../lib/plugin/ports.js'

/** A checkpoint answer, in the harness's vocabulary. */
export function outcome(overrides = {}) {
  return {
    safe: true,
    reason: 'idle',
    checkpointId: 'ck-1',
    resumeToken: 'rs-1',
    completed: true,
    detail: 'harness reports an idle safe point',
    ...overrides,
  }
}

/** Ready-made checkpoint ports. */
export const checkpoints = {
  /** Reports a completed, safe checkpoint. */
  ok(overrides = {}) {
    const answer = outcome(overrides)
    return new FunctionCheckpointPort({ id: 'scripted-ok', prepare: () => answer })
  },

  /** Reports that the harness is busy and cannot be interrupted. */
  unsafe(reason = 'git_commit_in_progress') {
    return new FunctionCheckpointPort({
      id: 'scripted-unsafe',
      prepare: () =>
        outcome({
          safe: false,
          reason,
          checkpointId: null,
          resumeToken: null,
          completed: false,
          detail: `harness reports ${reason}`,
        }),
    })
  },

  /** Reports a safe point but fails to complete the checkpoint. */
  incomplete() {
    return new FunctionCheckpointPort({
      id: 'scripted-incomplete',
      prepare: () =>
        outcome({ safe: true, completed: false, detail: 'checkpoint started but did not finish' }),
    })
  },

  /** Throws, as a harness bug would. */
  throwing(message = 'checkpoint subsystem exploded') {
    return new FunctionCheckpointPort({
      id: 'scripted-throwing',
      prepare: () => {
        throw new Error(message)
      },
    })
  },

  /** Never answers, as a deadlocked harness would. */
  hanging() {
    return new FunctionCheckpointPort({
      id: 'scripted-hanging',
      prepare: () => new Promise(() => {}),
    })
  },

  /** Counts calls, so a test can assert the gate ran at all. */
  counting(overrides = {}) {
    const calls = []
    const port = new FunctionCheckpointPort({
      id: 'scripted-counting',
      prepare: (mode) => {
        calls.push(mode)
        return outcome(overrides)
      },
    })
    return { port, calls }
  },
}
