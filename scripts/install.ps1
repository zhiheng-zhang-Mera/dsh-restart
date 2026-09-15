#Requires -Version 7.0
<#
.SYNOPSIS
    Registers dsh-restart into a DSH profile, verifies the profile, optionally
    launches the restart supervisor detached, and smoke-tests the supervisor.

.DESCRIPTION
    Performs the four install steps the design document asks for, in order, and
    reports exactly what it did:

      1. register  - `dsh plugin --profile <Profile> add <RepoPath>`
      2. verify    - `dsh --profile <Profile> --dump-config` must list dsh-restart
      3. supervisor- optionally start `node bin/supervisor.mjs` detached, hidden
      4. smoke test- `node bin/supervisor.mjs --help` must exit 0 and print usage

    The script is idempotent. It asks the profile whether the plugin is already
    registered *before* adding it, so running it twice installs once and says so.
    When the profile cannot be read it stops and reports the problem instead of
    adding a second registration on a guess.

    Nothing here reboots, kills or signals DS-Hns. The only process this script
    starts is the supervisor, and the only process it stops is the supervisor (see
    uninstall.ps1). It never stops DS-Hns.

.PARAMETER Profile
    DSH profile to install into. Defaults to `web`.

.PARAMETER RepoPath
    Path of this package (the directory holding package.json). Defaults to the
    parent directory of this script, i.e. the checkout it was run from.

.PARAMETER StateDirectory
    Directory the supervisor keeps ticket.json, heartbeat.json, ledger.json and
    supervisor.log in. Defaults to `$env:DSH_HOME\restart` when DSH_HOME is set,
    otherwise `<RepoPath>\.dsh-restart`. The same value must be passed to the
    plugin through `storage.directory`, or the plugin and the supervisor will use
    different directories and never see each other.

.PARAMETER LaunchCommand
    The command the detached supervisor relaunches when DS-Hns exits, for example
    `node`, `D:\DS-Hns\app\dsh.js`, `--profile`, `web`. Everything after `--` on the
    supervisor command line. Strongly recommended: without it the supervisor falls
    back to its own argv, which is the supervisor script itself and not DS-Hns.

.PARAMETER WatchPid
    Pass `--pid <n>` to the supervisor, so it watches that pid instead of its own
    parent process. Use this when launching the supervisor from a wrapper that
    exits immediately.

.PARAMETER SkipSupervisor
    Do not start the supervisor. The plugin is still registered and verified; the
    supervisor can be started later with the command this script prints.

.PARAMETER SkipVerification
    Do not run `--dump-config`. The install is then reported as unverified.

.PARAMETER DshCommand
    The dsh executable plus any prefix arguments, as an array. Defaults to
    `@('dsh')`. For a bundled dsh that is not on PATH, use for example
    `-DshCommand node,'D:\DS-Hns\app\node_modules\@deepseek-ai\dsh\lib\bin.js'`.

.PARAMETER NodePath
    Node executable used for the smoke test and for the supervisor. Defaults to
    `node` from PATH.

.EXAMPLE
    pwsh -File scripts/install.ps1

    Install into the default `web` profile from this checkout, verifying the
    profile, and leave the supervisor alone.

.EXAMPLE
    pwsh -File scripts/install.ps1 -Profile web -StateDirectory 'D:\DS-Hns\data\restart' `
        -LaunchCommand node,'D:\DS-Hns\app\dsh.js','--profile','web'

    Register, verify, then start the supervisor detached, watching its own parent,
    relaunching the given command after an exit.

.EXAMPLE
    pwsh -File scripts/install.ps1 -WhatIf

    Print every action that would be taken without changing anything.

.EXAMPLE
    pwsh -File scripts/install.ps1 -SkipSupervisor -SkipVerification

    Register only. The summary states that the install was not verified.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter()][string] $Profile = 'web',
    [Parameter()][string] $RepoPath = (Split-Path -Parent $PSScriptRoot),
    [Parameter()][string] $StateDirectory,
    [Parameter()][string[]] $LaunchCommand,
    [Parameter()][int] $WatchPid,
    [Parameter()][switch] $SkipSupervisor,
    [Parameter()][switch] $SkipVerification,
    [Parameter()][string[]] $DshCommand = @('dsh'),
    [Parameter()][string] $NodePath = 'node'
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

# ------------------------------------------------------------------- command lines

$DshExecutable = $DshCommand[0]
$DshPrefix = @()
if ($DshCommand.Count -gt 1) { $DshPrefix = $DshCommand[1..($DshCommand.Count - 1)] }

function Get-DshDisplay {
    param([string[]] $Arguments)
    return (($DshCommand + $Arguments) -join ' ')
}

function Invoke-Dsh {
    <#
        Run dsh with the given arguments. Returns a result object with ExitCode,
        Output and ErrorText. Never throws for a non-zero exit: the caller decides
        what a failure means.
    #>
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

# ------------------------------------------------------------------------- 0. checks

Write-Host ''
Write-Host 'dsh-restart install' -ForegroundColor White
Write-Host "  profile        : $Profile"
Write-Host "  package path   : $RepoPath"
Write-Host "  dsh command    : $($DshCommand -join ' ')"
Write-Host "  dry run        : $($WhatIfPreference)"

$packageJson = Join-Path $RepoPath 'package.json'
$supervisorScript = Join-Path $RepoPath 'bin/supervisor.mjs'
$builtEntry = Join-Path $RepoPath 'lib/index.js'

if (-not (Test-Path -LiteralPath $packageJson -PathType Leaf)) {
    Write-Problem "no package.json under '$RepoPath'; pass -RepoPath <checkout>"
}
if (-not (Test-Path -LiteralPath $supervisorScript -PathType Leaf)) {
    Write-Problem "no bin/supervisor.mjs under '$RepoPath'; pass -RepoPath <checkout>"
}
if (-not (Test-Path -LiteralPath $builtEntry -PathType Leaf)) {
    Write-Problem "no lib/index.js under '$RepoPath'; run 'npm run build' before installing"
}

if (-not $StateDirectory) {
    if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') {
        $StateDirectory = Join-Path $env:DSH_HOME.Trim() 'restart'
    }
    else {
        $StateDirectory = Join-Path $RepoPath '.dsh-restart'
        Write-Note 'DSH_HOME is not set, so the state directory defaults to the package path'
    }
}

$dshAvailable = $null -ne (Get-Command $DshExecutable -ErrorAction SilentlyContinue)
if (-not $dshAvailable) {
    Write-Problem "the dsh executable '$DshExecutable' was not found on PATH; pass -DshCommand"
}
$nodeAvailable = $null -ne (Get-Command $NodePath -ErrorAction SilentlyContinue)
if (-not $nodeAvailable) {
    Write-Problem "the node executable '$NodePath' was not found on PATH; pass -NodePath"
}

if ($script:Problems.Count -gt 0) {
    Write-Host ''
    Write-Host 'Nothing was changed: a precondition failed.' -ForegroundColor Red
    foreach ($problem in $script:Problems) { Write-Host "  - $problem" -ForegroundColor Red }
    exit 1
}

# ------------------------------------------------------- 1. registration (idempotent)

Write-Step "Asking the profile whether dsh-restart is already registered"

$registered = $false
$detectionFailed = $null

if ($SkipVerification) {
    $detectionFailed = 'verification is disabled (-SkipVerification)'
}
else {
    $dumpArguments = @('--profile', $Profile, '--dump-config')
    Write-Host "    run: $(Get-DshDisplay $dumpArguments)"
    $dump = Invoke-Dsh -Arguments $dumpArguments
    if ($dump.ExitCode -ne 0) {
        $detectionFailed = "dsh --dump-config exited $($dump.ExitCode): $((($dump.ErrorText + $dump.Output) -replace '\s+', ' ').Trim())"
    }
    else {
        $registered = ($dump.Output -match 'dsh-restart')
        Write-Host "    dsh-restart present in the composed profile: $registered"
    }
}

if ($detectionFailed) {
    Write-Problem "could not determine whether dsh-restart is registered ($detectionFailed)"
    Write-Host ''
    Write-Host 'Nothing was changed: registering on an unknown state is how a profile ends up with the plugin twice.' -ForegroundColor Red
    Write-Host 'Fix the profile first, or pass -SkipVerification to register without asking.' -ForegroundColor Yellow
    exit 1
}

if ($registered) {
    Write-Skipped "dsh-restart is already registered in profile '$Profile' (idempotent install)"
}
else {
    $addArguments = @('plugin', '--profile', $Profile, 'add', $RepoPath)
    if ($PSCmdlet.ShouldProcess("profile '$Profile'", "add plugin dsh-restart from $RepoPath")) {
        Write-Host "    run: $(Get-DshDisplay $addArguments)"
        $add = Invoke-Dsh -Arguments $addArguments
        if ($add.ExitCode -ne 0) {
            Write-Problem "dsh plugin add exited $($add.ExitCode): $((($add.ErrorText + $add.Output) -replace '\s+', ' ').Trim())"
        }
        else {
            Write-Did "registered dsh-restart into profile '$Profile'"
        }
    }
    else {
        Write-Skipped "add dsh-restart into profile '$Profile' (WhatIf)"
    }

    if ($script:Problems.Count -gt 0) {
        Write-Host ''
        Write-Host 'Install failed at the registration step.' -ForegroundColor Red
        foreach ($problem in $script:Problems) { Write-Host "  - $problem" -ForegroundColor Red }
        exit 1
    }
}

# ------------------------------------------------------------------- 2. verification

Write-Step 'Verifying the composed profile'

$verified = $false
if ($SkipVerification) {
    Write-Skipped 'profile verification (-SkipVerification)'
}
elseif ($WhatIfPreference) {
    Write-Host "    would run: $(Get-DshDisplay @('--profile', $Profile, '--dump-config')) and search it for dsh-restart"
    Write-Skipped 'profile verification (WhatIf)'
}
else {
    $verifyArguments = @('--profile', $Profile, '--dump-config')
    Write-Host "    run: $(Get-DshDisplay $verifyArguments)"
    $verify = Invoke-Dsh -Arguments $verifyArguments
    if ($verify.ExitCode -ne 0) {
        Write-Problem "dsh --dump-config exited $($verify.ExitCode): $((($verify.ErrorText + $verify.Output) -replace '\s+', ' ').Trim())"
    }
    elseif ($verify.Output -notmatch 'dsh-restart') {
        Write-Problem "the composed profile does not mention dsh-restart; the registration did not take effect"
    }
    else {
        Write-Did "the composed profile lists dsh-restart (checked with --dump-config)"
        $verified = $true
    }
}

# --------------------------------------------------------------------- 3. supervisor

Write-Step 'Supervisor'

$supervisorStarted = $false
$supervisorCommand = @($supervisorScript, '--state', $StateDirectory)
if ($WatchPid -gt 0) { $supervisorCommand += @('--pid', $WatchPid) }
if ($LaunchCommand -and $LaunchCommand.Count -gt 0) { $supervisorCommand += @('--') + $LaunchCommand }

if ($SkipSupervisor) {
    Write-Skipped 'supervisor launch (-SkipSupervisor)'
}
else {
    if (-not (Test-Path -LiteralPath $StateDirectory -PathType Container)) {
        if ($PSCmdlet.ShouldProcess($StateDirectory, 'create the supervisor state directory')) {
            New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
            Write-Did "created state directory $StateDirectory"
        }
        else {
            Write-Skipped "create state directory $StateDirectory (WhatIf)"
        }
    }
    else {
        Write-Host "    state directory already exists: $StateDirectory"
    }

    if (-not $LaunchCommand -or $LaunchCommand.Count -eq 0) {
        Write-Note 'no -LaunchCommand was given, so the supervisor will fall back to its own argv, which is this'
        Write-Note 'script path rather than DS-Hns. Pass -LaunchCommand <exe>,<args...> for a working relaunch.'
    }

    $nodeCommandLine = (@($NodePath) + $supervisorCommand) -join ' '
    if ($PSCmdlet.ShouldProcess('supervisor', "start detached and hidden: $nodeCommandLine")) {
        $supervisorProcess = Start-Process -FilePath $NodePath -ArgumentList $supervisorCommand `
            -WindowStyle Hidden -PassThru
        Write-Did "started supervisor pid $($supervisorProcess.Id) hidden and detached: $nodeCommandLine"
        $supervisorStarted = $true
    }
    else {
        Write-Skipped "start supervisor: $nodeCommandLine (WhatIf)"
    }
}

# --------------------------------------------------------------------- 4. smoke test

Write-Step 'Smoke test: node bin/supervisor.mjs --help'

$smokeOk = $false
if ($WhatIfPreference) {
    Write-Skipped 'smoke test (WhatIf)'
}
else {
    $stdoutFile = [System.IO.Path]::GetTempFileName()
    $stderrFile = [System.IO.Path]::GetTempFileName()
    try {
        $smoke = Start-Process -FilePath $NodePath -ArgumentList @($supervisorScript, '--help') `
            -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
        $smokeOutput = Get-Content -LiteralPath $stdoutFile -Raw -ErrorAction SilentlyContinue
        $smokeError = Get-Content -LiteralPath $stderrFile -Raw -ErrorAction SilentlyContinue
        if ($smoke.ExitCode -ne 0) {
            Write-Problem "the supervisor --help smoke test exited $($smoke.ExitCode): $((($smokeError + $smokeOutput) -replace '\s+', ' ').Trim())"
        }
        elseif ($smokeOutput -notmatch 'Usage:') {
            Write-Problem 'the supervisor --help smoke test printed no usage text, which means it did not run'
        }
        else {
            Write-Did 'the supervisor printed usage and exited 0'
            $smokeOk = $true
        }
    }
    finally {
        Remove-Item -LiteralPath $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
    }
}

# ------------------------------------------------------------------------ 5. summary

Write-Host ''
Write-Host '----- install summary -----' -ForegroundColor White
foreach ($action in $script:Actions) { Write-Host "  $action" }
Write-Host ''
Write-Host "  state directory : $StateDirectory"
Write-Host "  verified        : $(if ($verified) { 'yes' } else { 'no' })"
Write-Host "  supervisor      : $(if ($supervisorStarted) { 'started' } else { 'not started by this script' })"
Write-Host "  smoke test      : $(if ($smokeOk) { 'passed' } else { 'not run' })"
Write-Host ''
Write-Host '  To start the supervisor later, run exactly:' -ForegroundColor White
Write-Host "    $NodePath $((@($supervisorScript, '--state', $StateDirectory) + $(if ($LaunchCommand) { @('--') + $LaunchCommand } else { @() })) -join ' ')"
Write-Host ''
Write-Host '  To undo this install: pwsh -File scripts/uninstall.ps1 -Profile ' -NoNewline
Write-Host $Profile -NoNewline
Write-Host " -StateDirectory '$StateDirectory'"

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
    Write-Host 'SUCCESS: dsh-restart is installed. DS-Hns still runs without automatic restart until the supervisor is up.' -ForegroundColor Green
}
exit 0
