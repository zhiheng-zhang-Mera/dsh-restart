#!/usr/bin/env node
/**
 * Artifact check for the built package.
 *
 * Asserts that `lib/` is a usable, clean build before it is published or loaded by
 * the harness: the public entry point exposes the Cordis plugin contract and the
 * library surface, no emitted file still refers to a `.ts` specifier, the protocol
 * declaration ships, the shipped defaults resolve and include the documented
 * cooldown, genuinely invalid documents are refused rather than silently coerced,
 * the self-reported reason codes are all usable, and the supervisor entry point is
 * present and runnable.
 *
 * Zero dependencies, no test framework: one `ok`/`FAIL` line per check, and a
 * non-zero exit code when anything failed.
 *
 * Usage:
 *   npm run build && npm run verify:artifacts
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const libDir = join(projectRoot, 'lib')
const libEntry = join(libDir, 'index.js')
const protocolDeclaration = join(libDir, 'shared', 'protocol.d.ts')
const supervisorEntry = join(projectRoot, 'bin', 'supervisor.mjs')

/** A `from './x.ts'` / `import('../x.ts')` specifier in an emitted file. */
const TS_SPECIFIER = /(?:\bfrom\b|\bimport\b)\s*\(?\s*(['"])(\.{1,2}\/[^'"]+\.ts)\1/g

/** The cooldown the design document and the README both promise. */
const EXPECTED_APPLICATION_MIN_INTERVAL_MS = 1_200_000

let passed = 0
let failed = 0

/** Print one result line, plus an indented reason when a check failed. */
function report(ok, description, detail) {
  if (ok) {
    passed += 1
    console.log(`ok   ${description}`)
  } else {
    failed += 1
    console.log(`FAIL ${description}`)
    if (detail !== undefined && detail !== '') console.log(`     ${detail}`)
  }
}

/** Run one check; a thrown assertion (or any error) fails it. */
async function check(description, run) {
  try {
    const detail = await run()
    report(true, description, detail)
  } catch (error) {
    report(false, description, error instanceof Error ? error.message : String(error))
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Whether a path exists and is a regular file. */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Yield every regular file under `directory`, recursively. */
function* walkFiles(directory) {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) yield* walkFiles(full)
    else if (entry.isFile()) yield full
  }
}

/** `lib/index.js`, imported once and reused by the checks that need it. */
let plugin = null

// 1. The public entry point exists and exposes the plugin contract plus the library
//    surface an embedder or a requester needs.
await check(
  'lib/index.js exports apply, name, inject, resolveConfig, RestartManager and RestartSupervisor',
  async () => {
    assert(isFile(libEntry), `lib/index.js is missing; run \`npm run build\` (looked at ${libEntry})`)

    plugin = await import(pathToFileURL(libEntry).href)

    assert(typeof plugin.apply === 'function', `apply must be a function, received ${typeof plugin.apply}`)
    assert(
      typeof plugin.name === 'string' && plugin.name === 'dsh-restart',
      `name must be the string "dsh-restart", received ${JSON.stringify(plugin.name)}`,
    )
    assert(Array.isArray(plugin.inject), `inject must be an array, received ${typeof plugin.inject}`)
    assert(
      typeof plugin.resolveConfig === 'function',
      `resolveConfig must be a function, received ${typeof plugin.resolveConfig}`,
    )
    assert(
      typeof plugin.RestartManager === 'function',
      `RestartManager must be a function, received ${typeof plugin.RestartManager}`,
    )
    assert(
      typeof plugin.RestartSupervisor === 'function',
      `RestartSupervisor must be a function, received ${typeof plugin.RestartSupervisor}`,
    )

    return `name=${plugin.name}, inject=[${plugin.inject.join(', ')}]`
  },
)

// 2. No emitted file still points at a TypeScript source.
await check('no file under lib/ imports a ".ts" specifier', async () => {
  const offenders = []
  let scanned = 0

  for (const file of walkFiles(libDir)) {
    let source
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue // unreadable/binary artifact: nothing to scan
    }
    scanned += 1
    for (const match of source.matchAll(TS_SPECIFIER)) {
      offenders.push(`${relative(projectRoot, file).split(sep).join('/')} -> ${match[2]}`)
    }
  }

  assert(scanned > 0, 'no files found under lib/; run `npm run build` first')
  assert(
    offenders.length === 0,
    `found ${offenders.length} leftover TypeScript specifier(s): ${offenders.slice(0, 5).join('; ')}`,
  )

  return `${scanned} files scanned`
})

// 3. The protocol declaration the "exports" map advertises actually ships.
await check('lib/shared/protocol.d.ts exists', async () => {
  assert(isFile(protocolDeclaration), `lib/shared/protocol.d.ts is missing (looked at ${protocolDeclaration})`)
  return 'present'
})

// 4. The shipped defaults resolve, and the documented application cooldown is one of
//    them. A default that silently drifts is a documented behaviour that no longer
//    exists.
await check('resolveConfig() succeeds with applicationRestart.minIntervalMs === 1200000', async () => {
  assert(plugin !== null, 'lib/index.js could not be imported (see the first check)')

  const config = plugin.resolveConfig()
  assert(config !== null && typeof config === 'object', 'resolveConfig() did not return an object')
  const value = config.applicationRestart?.minIntervalMs
  assert(
    value === EXPECTED_APPLICATION_MIN_INTERVAL_MS,
    `applicationRestart.minIntervalMs must be ${EXPECTED_APPLICATION_MIN_INTERVAL_MS}, received ${JSON.stringify(value)}`,
  )

  return `application=${value}ms, system=${config.systemRestart?.minIntervalMs}ms, enabled=${config.enabled}`
})

// 5. A document that cannot be enforced is refused, not repaired.
await check(
  'resolveConfig throws on heartbeatTimeoutMs <= heartbeatIntervalMs and on an empty allowedSources',
  async () => {
    assert(plugin !== null, 'lib/index.js could not be imported (see the first check)')

    let heartbeatError = null
    try {
      plugin.resolveConfig({ supervisor: { heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 30_000 } })
    } catch (error) {
      heartbeatError = error
    }
    assert(
      heartbeatError !== null,
      'resolveConfig accepted a heartbeat timeout that does not exceed the heartbeat interval, so the supervisor ' +
        'would be declared absent between its own beats',
    )

    let sourcesError = null
    try {
      plugin.resolveConfig({ allowedSources: [] })
    } catch (error) {
      sourcesError = error
    }
    assert(
      sourcesError !== null,
      'resolveConfig accepted an empty allowedSources list, which would refuse every request including an operator one',
    )

    return `threw ${heartbeatError.name} and ${sourcesError.name}`
  },
)

// 6. Every self-reported reason code is usable as a message.
await check('every SELF_REASON_CODES value is a non-empty string', async () => {
  assert(plugin !== null, 'lib/index.js could not be imported (see the first check)')

  const codes = plugin.SELF_REASON_CODES
  assert(codes !== null && typeof codes === 'object', `SELF_REASON_CODES must be an object, received ${typeof codes}`)

  const entries = Object.entries(codes)
  assert(entries.length > 0, 'SELF_REASON_CODES is empty')

  const bad = entries
    .filter(([, value]) => typeof value !== 'string' || value.trim() === '')
    .map(([code]) => code)
  assert(bad.length === 0, `these codes have no usable explanation: ${bad.join(', ')}`)

  const unknown = entries.filter(([code]) => typeof code !== 'string' || code.trim() === '').map(([code]) => code)
  assert(unknown.length === 0, `these codes are not usable identifiers: ${unknown.join(', ')}`)

  return `${entries.length} codes`
})

// 7. The supervisor can actually be started and can explain itself. The task's
//    documented entry command is `node bin/supervisor.mjs --help`, so it must exit 0
//    *and* print usage: an entry point that exits 0 in silence looks healthy while
//    doing nothing at all.
await check('node bin/supervisor.mjs --help exits 0 and prints usage', async () => {
  assert(isFile(supervisorEntry), `bin/supervisor.mjs is missing (looked at ${supervisorEntry})`)

  let stdout = ''
  let status = 0
  try {
    stdout = execFileSync(process.execPath, [supervisorEntry, '--help'], {
      stdio: 'pipe',
      cwd: projectRoot,
      encoding: 'utf8',
    })
  } catch (error) {
    status = typeof error.status === 'number' ? error.status : -1
    stdout = String(error.stdout ?? '')
    throw new Error(
      `bin/supervisor.mjs --help exited ${status}${stdout.trim() === '' ? ' and printed nothing' : `: ${stdout.trim().split('\n')[0]}`}`,
    )
  }

  const text = String(stdout)
  assert(text.includes('Usage:'), 'the supervisor help output does not contain "Usage:"')
  assert(
    text.includes('--state'),
    'the supervisor help output does not document --state, which the operations guide tells operators to pass',
  )

  return `${text.trim().split('\n').length} lines of usage`
})

console.log('')
console.log(`${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
