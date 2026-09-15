/**
 * Deployment-surface checks: the scripts an operator actually runs.
 *
 * These are the parts of the repository that cannot be covered by the unit suites —
 * PowerShell parsers, the supervisor's own command line, and the promise that
 * uninstalling changes nothing about DS-Hns.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const powershell = process.platform === 'win32' ? 'powershell.exe' : null

describe('supervisor command line', () => {
  it('prints usage and exits 0 for --help', () => {
    const result = spawnSync(process.execPath, [join(root, 'bin/supervisor.mjs'), '--help'], {
      encoding: 'utf8',
      timeout: 20_000,
    })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /dsh-restart supervisor/)
    assert.match(result.stdout, /--state/)
    assert.match(result.stdout, /--pid/)
    assert.match(result.stdout, /Everything after/)
  })

  it('rejects an unknown option instead of guessing', () => {
    const result = spawnSync(process.execPath, [join(root, 'bin/supervisor.mjs'), '--nope'], {
      encoding: 'utf8',
      timeout: 20_000,
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /unknown supervisor option: --nope/)
  })

  it('runs a bounded number of ticks and exits cleanly', () => {
    const state = join(root, '.dsh-restart-smoke')
    rmSync(state, { recursive: true, force: true })
    try {
      const result = spawnSync(
        process.execPath,
        [join(root, 'bin/supervisor.mjs'), '--state', state, '--max-ticks', '1'],
        { encoding: 'utf8', timeout: 30_000 },
      )
      assert.equal(result.status, 0, `stderr was: ${result.stderr}`)
      assert.match(result.stderr, /supervisor_boot/)
      assert.match(result.stderr, /supervisor_stopped/)
      // It must have written the heartbeat it promised to write.
      assert.ok(existsSync(join(state, 'heartbeat.json')))
      assert.ok(existsSync(join(state, 'supervisor.log')))
    } finally {
      rmSync(state, { recursive: true, force: true })
    }
  })

  it('reports safe mode as a distinct exit code, so a wrapper can tell', () => {
    const state = join(root, '.dsh-restart-smoke-safemode')
    rmSync(state, { recursive: true, force: true })
    mkdirSync(state, { recursive: true })
    try {
      // A tripped breaker is the one condition that must not look like success.
      writeFileSync(
        join(state, 'ledger.json'),
        JSON.stringify({
          schemaVersion: 1,
          uncleanStarts: [],
          safeMode: true,
          safeModeReason: 'crash_loop',
          safeModeAt: new Date().toISOString(),
          relaunches: 3,
        }),
      )
      const result = spawnSync(
        process.execPath,
        [join(root, 'bin/supervisor.mjs'), '--state', state, '--max-ticks', '1'],
        { encoding: 'utf8', timeout: 30_000 },
      )
      assert.equal(result.status, 3, `stderr was: ${result.stderr}`)
      assert.match(result.stderr, /SAFE_MODE/)
    } finally {
      rmSync(state, { recursive: true, force: true })
    }
  })
})

describe('PowerShell deployment scripts', () => {
  const scripts = ['install.ps1', 'uninstall.ps1', 'enable.ps1', 'disable.ps1']

  it('all four exist and declare their contract', () => {
    for (const script of scripts) {
      const path = join(root, 'scripts', script)
      assert.ok(existsSync(path), `${script} must exist`)
      const text = readFileSync(path, 'utf8')
      assert.match(text, /\.[A-Z]+/, `${script} must have comment-based help`)
      assert.match(text, /CmdletBinding/, `${script} must be an advanced function/script`)
      assert.match(text, /\[Parameter/, `${script} must document at least one parameter`)
      assert.match(text, /\$Profile/, `${script} must operate on a named profile`)
    }
  })

  it('never kills DS-Hns as a normal path', () => {
    for (const script of scripts) {
      const text = readFileSync(join(root, 'scripts', script), 'utf8')
      // The uninstall script may stop the *supervisor*, and must say so. Nothing
      // in this repository may grow a "stop DS-Hns" path: that is the core's job.
      const stopProcessCalls = text.match(/Stop-Process/g) ?? []
      if (stopProcessCalls.length > 0) {
        assert.match(
          text,
          /supervisor/i,
          `${script} uses Stop-Process but never mentions the supervisor, so a reader cannot tell what it stops`,
        )
        assert.equal(
          /Stop-Process[^\n]*\bDS-Hns\b/i.test(text),
          false,
          `${script} must never stop DS-Hns itself`,
        )
      }
      assert.equal(/\btaskkill\b/i.test(text), false, `${script} must not use taskkill`)
      assert.equal(/shutdown\s+\/[rsp]/i.test(text), false, `${script} must not reboot the machine`)
    }
  })

  it('parses cleanly and exposes its parameters', { skip: powershell === null }, () => {
    for (const script of scripts) {
      const path = join(root, 'scripts', script)
      // `-WhatIf` needs SupportsShouldProcess; every script is written to support it,
      // so asking for the parameter list is also a check that the attribute is there.
      const result = spawnSync(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference='Stop';` +
            `$t=$null;$f=$null;$e=$null;` +
            `[void][System.Management.Automation.Language.Parser]::ParseFile('${path.replace(/'/g, "''")}',[ref]$t,[ref]$e);` +
            `if($e -and $e.Count -gt 0){$e|ForEach-Object{Write-Output $_.Message};exit 1};` +
            `Write-Output 'parsed'`,
        ],
        { encoding: 'utf8', timeout: 60_000 },
      )
      assert.equal(result.status, 0, `${script} failed to parse:\n${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /parsed/)
    }
  })

  it('advertises -WhatIf so an operator can dry-run a deployment', { skip: powershell === null }, () => {
    for (const script of scripts) {
      const result = spawnSync(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Command '${join(root, 'scripts', script)}').Parameters.Keys -join ','`,
        ],
        { encoding: 'utf8', timeout: 60_000 },
      )
      assert.equal(result.status, 0, `could not read parameters for ${script}: ${result.stderr}`)
      assert.match(result.stdout, /WhatIf/, `${script} must support -WhatIf`)
      assert.match(result.stdout, /Profile/, `${script} must take -Profile`)
    }
  })

  it('resolves its own repository root and reports a failed precondition clearly', { skip: powershell === null }, () => {
    // `-WhatIf` with a bogus `dsh` command is the one run that is safe everywhere: it
    // proves the script resolved `$RepoPath` (the failure is about the *precondition*,
    // not about an empty path) and that it refuses rather than guessing. Only the two
    // scripts that shell out to `dsh` take `-DshCommand`.
    const withDsh = new Set(['install.ps1', 'uninstall.ps1'])
    for (const script of scripts) {
      const args = ['-NoProfile', '-NonInteractive', '-File', join(root, 'scripts', script), '-WhatIf']
      if (withDsh.has(script)) args.push('-DshCommand', 'definitely-not-on-path')
      const result = spawnSync(powershell, args, { encoding: 'utf8', timeout: 120_000 })
      const output = `${result.stdout}\n${result.stderr}`
      assert.equal(
        /Cannot bind argument to parameter 'Path'/.test(output),
        false,
        `${script} failed to resolve its own directory: ${output}`,
      )
      assert.match(
        output,
        /definitely-not-on-path|not found on PATH|no row for this plugin|no ledger/,
        `${script} did not report a specific precondition failure: ${output}`,
      )
      assert.notEqual(result.status, 0, `${script} must exit non-zero when a precondition fails`)
    }
  })
})

describe('repository hygiene', () => {
  it('ships no runtime artifacts in version control', () => {
    const ignored = ['.dsh-restart', 'ticket.json', 'heartbeat.json', 'ledger.json', 'supervisor.log']
    const gitignore = readFileSync(join(root, '.gitignore'), 'utf8')
    for (const entry of ignored) {
      assert.ok(gitignore.includes(entry), `.gitignore must exclude ${entry}`)
    }
  })

  it('declares the bundle patch and the supervisor binary in package.json', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
    assert.ok(manifest.bin['dsh-restart-supervisor'])
    assert.equal(manifest.type, 'module')
  })

  it('keeps the built entry point free of TypeScript specifiers', () => {
    const entries = ['lib/index.js', 'lib/plugin/index.js', 'lib/supervisor/index.js']
    for (const entry of entries) {
      const text = readFileSync(join(root, entry), 'utf8')
      assert.equal(/from\s+['"][^'"]+\.ts['"]/.test(text), false, `${entry} imports a .ts specifier`)
    }
  })

  it('does not import the health scheduler or any health vocabulary', () => {
    const files = [
      'lib/index.js',
      'lib/plugin/restart-manager.js',
      'lib/plugin/request-validator.js',
      'lib/supervisor/index.js',
    ]
    for (const file of files) {
      const text = readFileSync(join(root, file), 'utf8')
      assert.equal(text.includes('health-scheduler'), false, `${file} must not depend on the health plugin`)
    }
  })
})
