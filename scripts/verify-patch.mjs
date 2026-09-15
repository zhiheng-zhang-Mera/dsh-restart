// Validate the shipped bundle patch against the resolved defaults:
//   - the file is parseable YAML with exactly one insert row
//   - the row names this package
//   - every configuration key it sets exists in DEFAULT_CONFIG
//   - every DEFAULT_CONFIG key is at least mentioned, so the patch documents the
//     whole surface rather than a convenient subset
import { readFileSync } from 'node:fs'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/shared/config.js'

const text = readFileSync('cordis.patch.yml', 'utf8')
const problems = []
const note = (message) => problems.push(message)

if (text.includes('\t')) note('the file contains a tab character, which YAML forbids for indentation')
if (!text.includes('- insert:')) note('the file has no `- insert:` row')
if (!/name: 'dsh-restart'/.test(text)) note("the row does not name 'dsh-restart'")
if (!/^\s*- id: restart\s*$/m.test(text)) note('the row id is not `restart`')

const keys = [...text.matchAll(/^ {8}([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1])
const defaults = Object.keys(DEFAULT_CONFIG)
const unknown = keys.filter((key) => !defaults.includes(key))
if (unknown.length > 0) note(`the patch sets keys that are not in DEFAULT_CONFIG: ${unknown.join(', ')}`)

const undocumented = defaults.filter((key) => !keys.includes(key))
if (undocumented.length > 0) note(`DEFAULT_CONFIG keys the patch does not mention: ${undocumented.join(', ')}`)

// The defaults themselves must resolve, and the patch must describe them exactly:
// a patch that silently changes a default is a patch that lies about being inert.
const resolved = resolveConfig()
if (resolved.applicationRestart.minIntervalMs !== 20 * 60_000) note('applicationRestart default drifted')
if (resolved.systemRestart.enabled !== false) note('systemRestart must default to disabled')
if (resolved.allowSystemReboot !== false) note('allowSystemReboot must default to false')
if (resolved.safety.checkpointRequired !== true) note('checkpointRequired must default to true')
if (resolved.safety.allowRestartWithoutSupervisor !== false) {
  note('allowRestartWithoutSupervisor must default to false')
}

console.log(`patch config keys: ${keys.length} of ${defaults.length} default keys`)
for (const problem of problems) console.log(`FAIL ${problem}`)
if (problems.length === 0) console.log('ok   the bundle patch matches DEFAULT_CONFIG and changes no default')
process.exitCode = problems.length === 0 ? 0 : 1
