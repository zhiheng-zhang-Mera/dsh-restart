#Requires -Version 5.1
# Deliberately 5.1, not 7.0: nothing in these scripts uses a 7-only feature, and
# Windows PowerShell 5.1 ships with every supported Windows version, so this is the
# widest requirement that is still truthful. Verified under both 5.1 and 7.
<#
.SYNOPSIS
    Re-enables dsh-restart: clears the crash-loop safe-mode flag in
    `<StateDirectory>\ledger.json` and/or sets the plugin's `enabled: true` in the
    profile's cordis.patch.yml.

.DESCRIPTION
    This script toggles exactly two mechanisms, chosen with -Mechanism, and it says
    which one it used and which file it edited:

      SafeMode  - edits `<StateDirectory>\ledger.json`, clearing `safeMode`,
                  `safeModeReason` and `safeModeAt`. This is what the supervisor
                  itself tells an operator to do:
                  "delete the safeMode flag in ledger.json (or run
                  scripts/enable.ps1) to restore automatic restart".
                  Until this flag is cleared, the supervisor refuses to relaunch
                  anything, no matter how healthy DS-Hns looks.
                  `-ClearHistory` additionally empties `uncleanStarts`, so crashes
                  recorded before the fix stop counting toward the crash-loop limit.

      Plugin    - edits the region of the profile's `cordis.patch.yml` that belongs
                  to this plugin (a row with `id: restart` or `name: 'dsh-restart'`)
                  and sets its `enabled: true`. This is the plugin's master switch:
                  while it is false every request is refused with `DISABLED`.

      Both      - the default: both of the above.

    The two mechanisms are independent. Clearing safe mode does not re-enable a
    disabled plugin and vice versa. Neither of them starts the supervisor: if no
    supervisor is running, no restart can be observed, and the plugin refuses with
    `SUPERVISOR_ABSENT`.

    The script refuses to guess. If the ledger is not a ledger, or the profile patch
    has no unambiguous region for this plugin, it reports exactly what it expected
    and exits non-zero without writing anything.

    This script never stops DS-Hns and never reboots anything.

.PARAMETER Mechanism
    `SafeMode`, `Plugin`, or `Both`. Defaults to `Both`.

.PARAMETER Profile
    DSH profile whose cordis.patch.yml is edited. Defaults to `web`.

.PARAMETER ProfileDirectory
    Directory of the profile, when it cannot be derived. Defaults to
    `$env:DSH_HOME\profiles\<Profile>`.

.PARAMETER StateDirectory
    Directory holding ledger.json. Defaults to `$env:DSH_HOME\restart` when DSH_HOME
    is set, otherwise `<RepoPath>\.dsh-restart`.

.PARAMETER RepoPath
    Path of this package. Defaults to the parent of this script.

.PARAMETER ClearHistory
    With the SafeMode mechanism, also empty `uncleanStarts` in the ledger.

.PARAMETER AllowCreate
    With the Plugin mechanism, create the profile patch region when it does not
    exist yet, instead of refusing.

.EXAMPLE
    pwsh -File scripts/enable.ps1

    Recover from safe mode and re-enable the plugin in the `web` profile.

.EXAMPLE
    pwsh -File scripts/enable.ps1 -Mechanism SafeMode -ClearHistory

    Only clear safe mode, and forget the crashes that tripped it.

.EXAMPLE
    pwsh -File scripts/enable.ps1 -Mechanism Plugin

    Only flip the plugin's `enabled` flag back to true, leaving the ledger alone.

.EXAMPLE
    pwsh -File scripts/enable.ps1 -WhatIf

    Print what would change without writing anything.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter()][ValidateSet('SafeMode', 'Plugin', 'Both')][string] $Mechanism = 'Both',
    [Parameter()][string] $Profile = 'web',
    [Parameter()][string] $ProfileDirectory,
    [Parameter()][string] $StateDirectory,
    [Parameter()][string] $RepoPath,
    [Parameter()][switch] $ClearHistory,
    [Parameter()][switch] $AllowCreate
)

$ErrorActionPreference = 'Stop'

# Resolve defaults that depend on automatic variables.
#
# `$PSScriptRoot` is not populated yet when a `param()` default is evaluated under
# `powershell.exe -File`, so the repository root is derived here instead. The scripts
# live in `<repo>/scripts`, which makes the repository root their parent directory.
if ([string]::IsNullOrWhiteSpace($RepoPath)) {
    $scriptDirectory = if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        Split-Path -Parent $MyInvocation.MyCommand.Path
    } else {
        $PSScriptRoot
    }
    $RepoPath = (Resolve-Path (Join-Path $scriptDirectory '..')).Path
}

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

# --------------------------------------------------------------------------- paths

if (-not $StateDirectory) {
    if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') {
        $StateDirectory = Join-Path $env:DSH_HOME.Trim() 'restart'
    }
    else {
        $StateDirectory = Join-Path $RepoPath '.dsh-restart'
    }
}
if (-not $ProfileDirectory) {
    if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') {
        $ProfileDirectory = Join-Path (Join-Path $env:DSH_HOME.Trim() 'profiles') $Profile
    }
}

$ledgerPath = Join-Path $StateDirectory 'ledger.json'
$patchPath = if ($ProfileDirectory) { Join-Path $ProfileDirectory 'cordis.patch.yml' } else { $null }

Write-Host ''
Write-Host 'dsh-restart enable' -ForegroundColor White
Write-Host "  mechanism      : $Mechanism"
Write-Host "  state directory: $StateDirectory"
Write-Host "  ledger         : $ledgerPath"
Write-Host "  profile patch  : $(if ($patchPath) { $patchPath } else { '<unknown: DSH_HOME is not set and -ProfileDirectory was not given>' })"
Write-Host "  dry run        : $($WhatIfPreference)"

# --------------------------------------------------------------- ledger: safe mode

function Get-JsonIndent {
    <# The profile patch's own line ending, so an edit does not rewrite every line. #>
    param([string] $Text)
    if ($Text -match "`r`n") { return "`r`n" }
    return "`n"
}

function Set-LedgerSafeMode {
    <#
        Clear (or set) the safe-mode fields in a ledger document.

        Refuses when the file is not recognisable as a ledger, rather than writing a
        document the supervisor would then misinterpret.
    #>
    param(
        [string] $Path,
        [bool] $Cleared,
        [string] $Reason,
        [bool] $ClearHistory,
        [switch] $DryRun
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Write-Problem "no ledger at $Path; the supervisor has never run, so there is no safe-mode flag to change"
        return $false
    }

    try {
        $ledger = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    }
    catch {
        Write-Problem "the ledger at $Path is not readable JSON ($($_.Exception.Message)); refusing to rewrite it"
        return $false
    }

    if ($null -eq $ledger -or $ledger -isnot [System.Management.Automation.PSCustomObject]) {
        Write-Problem "the ledger at $Path is not a JSON object; refusing to rewrite it"
        return $false
    }

    $names = $ledger.PSObject.Properties.Name
    if (-not ($names -contains 'safeMode') -and -not ($names -contains 'schemaVersion')) {
        Write-Problem "the document at $Path has neither 'safeMode' nor 'schemaVersion'; it does not look like a supervisor ledger"
        return $false
    }

    $before = if ($names -contains 'safeMode') { [bool] $ledger.safeMode } else { $false }

    if ($Cleared) {
        if ($names -contains 'safeMode') { $ledger.safeMode = $false } else { $ledger | Add-Member -NotePropertyName safeMode -NotePropertyValue $false }
        if ($names -contains 'safeModeReason') { $ledger.safeModeReason = $null } else { $ledger | Add-Member -NotePropertyName safeModeReason -NotePropertyValue $null }
        if ($names -contains 'safeModeAt') { $ledger.safeModeAt = $null } else { $ledger | Add-Member -NotePropertyName safeModeAt -NotePropertyValue $null }
        if ($ClearHistory) {
            if ($names -contains 'uncleanStarts') { $ledger.uncleanStarts = @() } else { $ledger | Add-Member -NotePropertyName uncleanStarts -NotePropertyValue @() }
        }
    }
    else {
        if ($names -contains 'safeMode') { $ledger.safeMode = $true } else { $ledger | Add-Member -NotePropertyName safeMode -NotePropertyValue $true }
        if ($names -contains 'safeModeReason') { $ledger.safeModeReason = $Reason } else { $ledger | Add-Member -NotePropertyName safeModeReason -NotePropertyValue $Reason }
        if ($names -contains 'safeModeAt') { $ledger.safeModeAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') } else { $ledger | Add-Member -NotePropertyName safeModeAt -NotePropertyValue ((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) }
    }

    $json = ($ledger | ConvertTo-Json -Depth 10) + "`n"

    if ($DryRun) {
        Write-Skipped "write $Path (WhatIf)"
        return $true
    }

    # UTF-8 without a BOM: a BOM makes the file unparseable by the supervisor's
    # reader, which would silently look like "no ledger" and quietly re-arm automatic
    # restart instead of reporting the problem.
    [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))

    if ($Cleared) {
        Write-Did "cleared safeMode in $Path (was $before)$(if ($ClearHistory) { ', and emptied uncleanStarts' })"
    }
    else {
        Write-Did "set safeMode = true in $Path (was $before, reason '$Reason')"
    }
    return $true
}

# ------------------------------------------------- plugin: enabled flag in the patch

function Get-PluginRegion {
    <#
        Locate the row in a patch document that belongs to this plugin.

        Returns the row's index, its indentation and the index one past its last
        line, or $null when there is no unambiguous row.
    #>
    param([string[]] $Lines)

    $starts = [System.Collections.Generic.List[int]]::new()
    for ($index = 0; $index -lt $Lines.Count; $index++) {
        if ($Lines[$index] -match "^\s*-\s*(id|name)\s*:\s*['""]?(restart|dsh-restart)['""]?\s*(#.*)?$") {
            $starts.Add($index)
        }
    }

    if ($starts.Count -eq 0) { return $null }
    if ($starts.Count -gt 1) {
        return [pscustomobject]@{ Ambiguous = $true; Count = $starts.Count }
    }

    $start = $starts[0]
    $rowIndent = $Lines[$start].Length - $Lines[$start].TrimStart().Length

    $end = $Lines.Count
    for ($index = $start + 1; $index -lt $Lines.Count; $index++) {
        $line = $Lines[$index]
        if ($line.Trim() -eq '' -or $line.TrimStart().StartsWith('#')) { continue }
        $indent = $line.Length - $line.TrimStart().Length
        if ($indent -le $rowIndent -and $line.TrimStart().StartsWith('-')) { $end = $index; break }
        if ($indent -lt $rowIndent) { $end = $index; break }
    }

    return [pscustomobject]@{ Ambiguous = $false; Start = $start; End = $end; RowIndent = $rowIndent }
}

function Set-PluginEnabledInPatch {
    <#
        Set `enabled:` inside this plugin's region of a patch document, editing the
        existing key when there is one and otherwise inserting it as the first child
        of the region's `config:` block.
    #>
    param(
        [string] $Path,
        [bool] $Enabled,
        [bool] $AllowCreate,
        [switch] $DryRun
    )

    $value = if ($Enabled) { 'true' } else { 'false' }

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        if (-not $AllowCreate) {
            Write-Problem "no patch file at $Path; pass -AllowCreate to create one for profile '$Profile'"
            return $false
        }
        $document = "# Your patch layer for this dsh profile, applied after every bundle layer.`n" +
                    "# Created by scripts/enable.ps1 to carry this plugin's enabled flag.`n" +
                    "- id: restart`n" +
                    "  config:`n" +
                    "    enabled: $value`n"
        if ($DryRun) {
            Write-Skipped "create $Path with an id: restart row (WhatIf)"
            return $true
        }
        [System.IO.File]::WriteAllText($Path, $document, (New-Object System.Text.UTF8Encoding($false)))
        Write-Did "created $Path with an 'id: restart' row and enabled: $value"
        return $true
    }

    $text = Get-Content -LiteralPath $Path -Raw
    $newline = Get-JsonIndent -Text $text
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in ($text -split "`r?`n")) { $lines.Add($line) }
    while ($lines.Count -gt 0 -and $lines[$lines.Count - 1].Trim() -eq '') { $lines.RemoveAt($lines.Count - 1) }

    $region = Get-PluginRegion -Lines $lines

    if ($null -eq $region) {
        if (-not $AllowCreate) {
            Write-Problem "no row for this plugin in $Path; expected a line like '- id: restart' or ""- name: 'dsh-restart'"""
            Write-Note 'pass -AllowCreate to append such a row instead of refusing'
            return $false
        }
        if ($lines.Count -eq 1 -and $lines[0].Trim() -eq '[]') { $lines.Clear() }
        $lines.Add('- id: restart')
        $lines.Add('  config:')
        $lines.Add("    enabled: $value")
        if (-not $DryRun) {
            [System.IO.File]::WriteAllText($Path, (($lines -join $newline).TrimEnd("`r", "`n") + $newline), (New-Object System.Text.UTF8Encoding($false)))
        }
        Write-Did "appended an 'id: restart' row with enabled: $value to $Path"
        return $true
    }

    if ($region.Ambiguous) {
        Write-Problem "$Path has $($region.Count) rows for this plugin; refusing to guess which one to edit"
        return $false
    }

    $enabledIndex = -1
    $configIndex = -1
    for ($index = $region.Start; $index -lt $region.End; $index++) {
        if ($lines[$index] -match "^(\s*)enabled\s*:") {
            if ($enabledIndex -lt 0) { $enabledIndex = $index }
        }
        if ($lines[$index] -match "^(\s*)config\s*:") {
            if ($configIndex -lt 0) { $configIndex = $index }
        }
    }

    if ($enabledIndex -ge 0) {
        $indent = $lines[$enabledIndex].Length - $lines[$enabledIndex].TrimStart().Length
        $lines[$enabledIndex] = (' ' * $indent) + "enabled: $value"
    }
    elseif ($configIndex -ge 0) {
        $configIndent = $lines[$configIndex].Length - $lines[$configIndex].TrimStart().Length
        $childIndent = ' ' * ($configIndent + 2)
        # Match the indentation of an existing sibling when there is one.
        for ($index = $configIndex + 1; $index -lt $region.End; $index++) {
            if ($lines[$index].Trim() -eq '' -or $lines[$index].TrimStart().StartsWith('#')) { continue }
            $siblingIndent = $lines[$index].Length - $lines[$index].TrimStart().Length
            if ($siblingIndent -gt $configIndent) { $childIndent = ' ' * $siblingIndent }
            break
        }
        $lines.Insert($configIndex + 1, $childIndent + "enabled: $value")
    }
    else {
        Write-Problem "the row for this plugin in $Path has no 'config:' block and no 'enabled:' key; refusing to guess where the flag belongs"
        Write-Host "        region starts at line $($region.Start + 1)" -ForegroundColor DarkGray
        return $false
    }

    $document = ($lines -join $newline).TrimEnd("`r", "`n") + $newline
    if ($DryRun) {
        Write-Skipped "write $Path (WhatIf)"
        return $true
    }
    [System.IO.File]::WriteAllText($Path, $document, (New-Object System.Text.UTF8Encoding($false)))
    Write-Did "set enabled: $value in this plugin's region of $Path (line $($region.Start + 1))"
    return $true
}

# ------------------------------------------------------------------------ 1. ledger

if ($Mechanism -in @('SafeMode', 'Both')) {
    Write-Step 'Clearing the crash-loop safe-mode flag in the ledger'
    $null = Set-LedgerSafeMode -Path $ledgerPath -Cleared $true -Reason '' -ClearHistory ([bool] $ClearHistory) -DryRun:([bool] $WhatIfPreference)
}
else {
    Write-Step 'Ledger'
    Write-Skipped "safe-mode flag (-Mechanism $Mechanism)"
}

# ------------------------------------------------------------------------ 2. patch

if ($Mechanism -in @('Plugin', 'Both')) {
    Write-Step "Setting the plugin's enabled flag in the profile patch"
    if (-not $patchPath) {
        Write-Problem 'the profile directory is unknown; set DSH_HOME or pass -ProfileDirectory'
    }
    else {
        $null = Set-PluginEnabledInPatch -Path $patchPath -Enabled $true -AllowCreate ([bool] $AllowCreate) -DryRun:([bool] $WhatIfPreference)
    }
}
else {
    Write-Step 'Profile patch'
    Write-Skipped "plugin enabled flag (-Mechanism $Mechanism)"
}

# ------------------------------------------------------------------------ 3. summary

Write-Host ''
Write-Host '----- enable summary -----' -ForegroundColor White
foreach ($action in $script:Actions) { Write-Host "  $action" }
Write-Host ''
Write-Host '  Configuration changes take effect on the next profile load: this script does not' -ForegroundColor White
Write-Host '  reload the running profile, and the plugin does not hot-swap its safety bounds.' -ForegroundColor White
Write-Host '  Safe mode is cleared for the SUPERVISOR: if it is not running, nothing will relaunch DS-Hns.' -ForegroundColor White

if ($script:Problems.Count -gt 0) {
    Write-Host ''
    Write-Host "FAILED: $($script:Problems.Count) problem(s); nothing was written where a problem was reported." -ForegroundColor Red
    foreach ($problem in $script:Problems) { Write-Host "  - $problem" -ForegroundColor Red }
    exit 1
}

Write-Host ''
if ($WhatIfPreference) {
    Write-Host 'SUCCESS (dry run): nothing was changed.' -ForegroundColor Green
}
else {
    Write-Host 'SUCCESS: dsh-restart is enabled.' -ForegroundColor Green
}
exit 0
