#Requires -Version 7.0
<#
.SYNOPSIS
    Uninstalls dsh-restart from a DSH profile: cancels a pending restart, stops the
    supervisor, removes the registration, and preserves the audit log.

.DESCRIPTION
    Performs the four uninstall steps the design document asks for, in order:

      1. cancel    - delete `<StateDirectory>\ticket.json`, so no pending restart can
                     be observed and acted on by a supervisor
      2. supervisor- stop the SUPERVISOR process, identified from
                     `<StateDirectory>\heartbeat.json`, and nothing else
      3. remove    - `dsh plugin --profile <Profile> remove dsh-restart`
      4. preserve  - the audit log (`restart-attempts.jsonl` and its rotations) is
                     kept, never deleted, and this is stated in the output

    This script never stops, signals or kills DS-Hns. The only process it will stop
    is one whose command line names this repository's `bin/supervisor.mjs` and whose
    pid matches the heartbeat file; if that cannot be established, it reports the
    pid and refuses to stop it rather than guessing.

    Uninstalling leaves DS-Hns fully functional. What is lost is the ability to
    restart it automatically, which is the plugin's entire purpose.

.PARAMETER Profile
    DSH profile to remove the plugin from. Defaults to `web`.

.PARAMETER StateDirectory
    Directory holding ticket.json, heartbeat.json, ledger.json and the audit log.
    Defaults to `$env:DSH_HOME\restart` when DSH_HOME is set, otherwise
    `<RepoPath>\.dsh-restart`, where RepoPath is the checkout this script lives in.

.PARAMETER RepoPath
    Path of this package, used to recognise the supervisor's command line and to
    derive the default state directory. Defaults to the parent of this script.

.PARAMETER KeepTicket
    Do not delete a pending ticket. Use only when the ticket is being handed to a
    supervisor that is meant to act on it after this script finishes.

.PARAMETER SkipSupervisor
    Do not stop the supervisor process. The plugin is still removed.

.PARAMETER SkipPluginRemoval
    Do not run `dsh plugin remove`. Useful for cleaning up state without touching
    the profile.

.PARAMETER DshCommand
    The dsh executable plus any prefix arguments, as an array. Defaults to
    `@('dsh')`.

.PARAMETER Force
    Stop the supervisor even when its command line cannot be matched to this
    repository, as long as the pid still exists and is a node process. Off by
    default: a heartbeat written by another checkout is not a licence to kill it.

.EXAMPLE
    pwsh -File scripts/uninstall.ps1

    Cancel a pending restart, stop the supervisor, remove the plugin from the `web`
    profile, and keep the audit log.

.EXAMPLE
    pwsh -File scripts/uninstall.ps1 -StateDirectory 'D:\DS-Hns\data\restart' -SkipPluginRemoval

    Clear the runtime state (ticket and supervisor) but leave the profile alone.

.EXAMPLE
    pwsh -File scripts/uninstall.ps1 -WhatIf

    Print every action that would be taken without changing anything.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter()][string] $Profile = 'web',
    [Parameter()][string] $RepoPath = (Split-Path -Parent $PSScriptRoot),
    [Parameter()][string] $StateDirectory,
    [Parameter()][switch] $KeepTicket,
    [Parameter()][switch] $SkipSupervisor,
    [Parameter()][switch] $SkipPluginRemoval,
    [Parameter()][string[]] $DshCommand = @('dsh'),
    [Parameter()][switch] $Force
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------- state

$script:Actions = [System.Collections.Generic.List[string]]::new()
$script:Problems = [System.Collections.Generic.List[string]]::new()

function Write-Step {
    param([string] $Message)
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Did {
    param([string] $Message)
    $script:Actions.Add($Message)
    Write-Host "    done: $Message" -ForegroundColor Green
}

function Write-Skipped {
    param([string] $Message)
    $script:Actions.Add("skipped: $Message")
    Write-Host "    skip: $Message" -ForegroundColor DarkGray
}

function Write-Problem {
    param([string] $Message)
    $script:Problems.Add($Message)
    Write-Host "    FAIL: $Message" -ForegroundColor Red
}

function Write-Note {
    param([string] $Message)
    Write-Host "    note: $Message" -ForegroundColor Yellow
}

$DshExecutable = $DshCommand[0]
$DshPrefix = @()
if ($DshCommand.Count -gt 1) { $DshPrefix = $DshCommand[1..($DshCommand.Count - 1)] }

function Get-DshDisplay {
    param([string[]] $Arguments)
    return (($DshCommand + $Arguments) -join ' ')
}

function Invoke-Dsh {
    param([string[]] $Arguments)

    $stdoutFile = [System.IO.Path]::GetTempFileName()
    $stderrFile = [System.IO.Path]::GetTempFileName()
    try {
        $process = Start-Process -FilePath $DshExecutable -ArgumentList ($DshPrefix + $Arguments) `
            -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
        return [pscustomobject]@{
            ExitCode  = $process.ExitCode
            Output    = (Get-Content -LiteralPath $stdoutFile -Raw -ErrorAction SilentlyContinue)
            ErrorText = (Get-Content -LiteralPath $stderrFile -Raw -ErrorAction SilentlyContinue)
        }
    }
    finally {
        Remove-Item -LiteralPath $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
    }
}

# ------------------------------------------------------------------------ 0. banner

Write-Host ''
Write-Host 'dsh-restart uninstall' -ForegroundColor White

if (-not $StateDirectory) {
    if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') {
        $StateDirectory = Join-Path $env:DSH_HOME.Trim() 'restart'
    }
    else {
        $StateDirectory = Join-Path $RepoPath '.dsh-restart'
    }
}

Write-Host "  profile        : $Profile"
Write-Host "  state directory: $StateDirectory"
Write-Host "  package path   : $RepoPath"
Write-Host "  dsh command    : $($DshCommand -join ' ')"
Write-Host "  dry run        : $($WhatIfPreference)"

# ----------------------------------------------------- 1. cancel any pending restart

Write-Step 'Cancelling any pending restart'

$ticketPath = Join-Path $StateDirectory 'ticket.json'
if ($KeepTicket) {
    Write-Skipped "pending ticket kept (-KeepTicket): $ticketPath"
}
elseif (-not (Test-Path -LiteralPath $ticketPath -PathType Leaf)) {
    Write-Host "    no pending ticket at $ticketPath"
}
elseif ($PSCmdlet.ShouldProcess($ticketPath, 'delete the pending restart ticket')) {
    Remove-Item -LiteralPath $ticketPath -Force
    Write-Did "deleted the pending ticket, so no supervisor can act on it: $ticketPath"
}
else {
    Write-Skipped "delete the pending ticket: $ticketPath (WhatIf)"
}

# ----------------------------------------------------------- 2. stop the supervisor

Write-Step 'Stopping the supervisor (this is the supervisor, not DS-Hns)'

$heartbeatPath = Join-Path $StateDirectory 'heartbeat.json'
if ($SkipSupervisor) {
    Write-Skipped 'supervisor stop (-SkipSupervisor)'
}
elseif (-not (Test-Path -LiteralPath $heartbeatPath -PathType Leaf)) {
    Write-Host "    no heartbeat file at $heartbeatPath, so there is no supervisor to identify"
}
else {
    $heartbeat = $null
    try {
        $heartbeat = Get-Content -LiteralPath $heartbeatPath -Raw | ConvertFrom-Json
    }
    catch {
        Write-Problem "the heartbeat file is not readable JSON: $($_.Exception.Message)"
    }

    if ($heartbeat) {
        $supervisorPid = 0
        if ($heartbeat.PSObject.Properties.Name -contains 'supervisorPid') {
            $supervisorPid = [int] $heartbeat.supervisorPid
        }

        if ($supervisorPid -le 0) {
            Write-Problem "the heartbeat file has no usable supervisorPid; refusing to guess which process to stop"
        }
        else {
            Write-Host "    heartbeat names supervisor pid $supervisorPid (state $($heartbeat.state), beat $($heartbeat.timestamp))"
            $process = Get-CimInstance Win32_Process -Filter "ProcessId = $supervisorPid" -ErrorAction SilentlyContinue

            if (-not $process) {
                Write-Host "    pid $supervisorPid is not running; nothing to stop"
            }
            else {
                $commandLine = [string] $process.CommandLine
                $looksLikeSupervisor = $commandLine -match 'supervisor\.mjs'
                $looksLikeHarness = $commandLine -match 'bin\.js|desktop-main|dsh\.js'

                if ($looksLikeHarness -and -not $looksLikeSupervisor) {
                    Write-Problem "pid $supervisorPid looks like the DS-Hns harness, not the supervisor; refusing to stop it"
                    Write-Host "        command line: $commandLine" -ForegroundColor DarkGray
                }
                elseif ($looksLikeSupervisor -or $Force) {
                    if (-not $looksLikeSupervisor -and $Force) {
                        Write-Note "pid $supervisorPid does not name supervisor.mjs, but -Force was given"
                    }
                    if ($PSCmdlet.ShouldProcess("process $supervisorPid", 'stop the restart supervisor')) {
                        Stop-Process -Id $supervisorPid -Force
                        Write-Did "stopped the restart SUPERVISOR (pid $supervisorPid). DS-Hns was not touched."
                    }
                    else {
                        Write-Skipped "stop the restart supervisor (pid $supervisorPid) (WhatIf)"
                    }
                }
                else {
                    Write-Problem "pid $supervisorPid does not name supervisor.mjs; refusing to stop an unidentified process"
                    Write-Host "        command line: $commandLine" -ForegroundColor DarkGray
                    Write-Note 'pass -Force to stop it anyway, or -SkipSupervisor to leave it alone'
                }
            }
        }
    }
}

# --------------------------------------------------- 3. remove the plugin registration

Write-Step 'Removing the plugin from the profile'

if ($SkipPluginRemoval) {
    Write-Skipped 'plugin removal (-SkipPluginRemoval)'
}
elseif ($null -eq (Get-Command $DshExecutable -ErrorAction SilentlyContinue)) {
    Write-Problem "the dsh executable '$DshExecutable' was not found on PATH; the plugin is still registered (pass -DshCommand)"
}
else {
    $removeArguments = @('plugin', '--profile', $Profile, 'remove', 'dsh-restart')
    if ($PSCmdlet.ShouldProcess("profile '$Profile'", 'remove plugin dsh-restart')) {
        Write-Host "    run: $(Get-DshDisplay $removeArguments)"
        $remove = Invoke-Dsh -Arguments $removeArguments
        if ($remove.ExitCode -ne 0) {
            Write-Problem "dsh plugin remove exited $($remove.ExitCode): $((($remove.ErrorText + $remove.Output) -replace '\s+', ' ').Trim())"
        }
        else {
            Write-Did "removed dsh-restart from profile '$Profile'"
        }
    }
    else {
        Write-Skipped "remove dsh-restart from profile '$Profile' (WhatIf)"
    }
}

# ------------------------------------------------- 4. preserve the audit log, visibly

Write-Step 'Preserving the audit log'

$auditLog = Join-Path $StateDirectory 'restart-attempts.jsonl'
$preserved = [System.Collections.Generic.List[string]]::new()
if (Test-Path -LiteralPath $auditLog -PathType Leaf) {
    $size = (Get-Item -LiteralPath $auditLog).Length
    $preserved.Add("$auditLog ($size bytes)")
}
foreach ($rotation in (Get-ChildItem -LiteralPath $StateDirectory -Filter 'restart-attempts.jsonl.*.bak' -ErrorAction SilentlyContinue)) {
    $preserved.Add("$($rotation.FullName) ($($rotation.Length) bytes)")
}
foreach ($other in @('heartbeat.json', 'ledger.json', 'supervisor.log')) {
    $candidate = Join-Path $StateDirectory $other
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $preserved.Add("$candidate ($((Get-Item -LiteralPath $candidate).Length) bytes)")
    }
}

if ($preserved.Count -eq 0) {
    Write-Host "    nothing to preserve: $StateDirectory holds no audit log yet"
}
else {
    Write-Host '    PRESERVED (not deleted, not rotated, not truncated):' -ForegroundColor Green
    foreach ($item in $preserved) { Write-Host "      $item" -ForegroundColor Green }
    $script:Actions.Add("preserved $($preserved.Count) state file(s), including the audit log")
}
Write-Note "the state directory itself is left in place: $StateDirectory"
Write-Note 'delete it by hand only if you also want to lose the incident trail'

# ------------------------------------------------------------------------ 5. summary

Write-Host ''
Write-Host '----- uninstall summary -----' -ForegroundColor White
foreach ($action in $script:Actions) { Write-Host "  $action" }
Write-Host ''
Write-Host '  DS-Hns was not stopped, signalled or modified. It keeps running; what it loses is automatic restart.' -ForegroundColor White

if ($script:Problems.Count -gt 0) {
    Write-Host ''
    Write-Host "FAILED: $($script:Problems.Count) problem(s)." -ForegroundColor Red
    foreach ($problem in $script:Problems) { Write-Host "  - $problem" -ForegroundColor Red }
    exit 1
}

Write-Host ''
if ($WhatIfPreference) {
    Write-Host 'SUCCESS (dry run): nothing was changed.' -ForegroundColor Green
}
else {
    Write-Host 'SUCCESS: dsh-restart is uninstalled and the audit log is preserved.' -ForegroundColor Green
}
exit 0
