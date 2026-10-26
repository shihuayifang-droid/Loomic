<#
.SYNOPSIS
  Read-only precheck for the hahart self-hosted stack (machine .74) before a machine migration.

.DESCRIPTION
  Prints one OK/MISSING line per checked item, then a final SUMMARY line:
      SUMMARY ok=<n> missing=<m>
  Exits 1 when at least one item is MISSING, exits 0 when every item is present.

  The script is strictly read-only: it never writes any file and never starts or stops
  any service. Secret values are never printed - only file existence and, for the two
  env files, the number of KEY=VALUE lines.

.PARAMETER RepoRoot
  Repository root. Defaults to the parent of the directory holding this script.

.PARAMETER HahartBase
  Root of the machine-local runtime (bin / cf / pgdata / ci). Default: D:\hahart-local

.PARAMETER PgPort
  Local PostgreSQL port to look for. Default: 55432

.NOTES
  ASCII only (Windows PowerShell 5.1 reads .ps1 as GBK). Run with:
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts/migration-precheck.ps1
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [string]$HahartBase = 'D:\hahart-local',
    [int]$PgPort = 55432
)

$ErrorActionPreference = 'Continue'

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $scriptDir = $PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($scriptDir)) {
        $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
    }
    $RepoRoot = Split-Path -Parent $scriptDir
}

$script:okCount = 0
$script:missingCount = 0

function Write-Item {
    param([string]$Status, [string]$Item, [string]$Detail)
    if ($Status -eq 'OK') {
        $script:okCount = $script:okCount + 1
    }
    else {
        $script:missingCount = $script:missingCount + 1
    }
    Write-Output ('{0} {1} {2}' -f $Status, $Item, $Detail)
}

function Test-ItemPath {
    param([string]$Item, [string]$Path)
    if (Test-Path -LiteralPath $Path) {
        Write-Item 'OK' $Item $Path
    }
    else {
        Write-Item 'MISSING' $Item $Path
    }
}

function Get-FirstPresent {
    param([string[]]$Candidates)
    foreach ($candidate in $Candidates) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            if (Test-Path -LiteralPath $candidate) {
                return $candidate
            }
        }
    }
    return $null
}

function Join-Part {
    param([string]$Base, [string]$Child)
    if ([string]::IsNullOrWhiteSpace($Base)) { return $null }
    return ($Base.TrimEnd('\') + '\' + $Child)
}

function Format-Candidates {
    param([string[]]$Candidates)
    $present = @()
    foreach ($candidate in $Candidates) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            $present += $candidate
        }
    }
    if ($present.Count -eq 0) {
        return 'no candidate path known'
    }
    return ($present -join ' | ')
}

function Get-EnvKeyCount {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return -1
    }
    $keyPattern = '^\s*[A-Za-z_][A-Za-z0-9_]*\s*='
    $count = 0
    $lines = Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue
    foreach ($line in $lines) {
        if ($line -match $keyPattern) {
            $count = $count + 1
        }
    }
    return $count
}

function Get-TaskExePath {
    param([string]$TaskName)
    $exe = $null
    try {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        $action = $task.Actions | Select-Object -First 1
        if ($null -ne $action) {
            if (-not [string]::IsNullOrWhiteSpace($action.Execute)) {
                $exe = $action.Execute.Trim('"')
            }
        }
    }
    catch {
        $exe = $null
    }
    return $exe
}

$binDir = Join-Part $HahartBase 'bin'
$cfDir = Join-Part $HahartBase 'cf'
$userCf = Join-Part $env:USERPROFILE '.cloudflared'

# ---------------------------------------------------------------- 1. repository
Write-Output ('repo-root={0}' -f $RepoRoot)
Test-ItemPath 'repo' $RepoRoot

# ---------------------------------------------------------------- 2. web build output
Test-ItemPath 'apps/web/out' (Join-Part $RepoRoot 'apps\web\out')

# ---------------------------------------------------------------- 3. env files (key count ONLY)
foreach ($rel in @('.env.local', 'apps\web\.env.local')) {
    $envPath = Join-Part $RepoRoot $rel
    $keyCount = Get-EnvKeyCount $envPath
    if ($keyCount -lt 0) {
        Write-Item 'MISSING' ('env ' + $rel) 'file not found'
    }
    else {
        Write-Item 'OK' ('env ' + $rel) ('keys=' + $keyCount)
    }
}

# ---------------------------------------------------------------- 4. caddy
$caddyExeCandidates = @(
    (Join-Part $binDir 'caddy.exe'),
    $env:HAHART_CADDY_EXE,
    'C:\caddy\caddy.exe',
    'C:\Program Files\Caddy\caddy.exe'
)
$caddyExe = Get-FirstPresent $caddyExeCandidates
if ($null -eq $caddyExe) {
    Write-Item 'MISSING' 'caddy.exe' (Format-Candidates $caddyExeCandidates)
}
else {
    Write-Item 'OK' 'caddy.exe' $caddyExe
}

$caddyfileCandidates = @(
    (Join-Part $binDir 'Caddyfile'),
    (Join-Part $binDir 'caddy\Caddyfile'),
    $env:HAHART_CADDYFILE,
    'C:\caddy\Caddyfile'
)
$caddyfile = Get-FirstPresent $caddyfileCandidates
if ($null -eq $caddyfile) {
    Write-Item 'MISSING' 'Caddyfile' (Format-Candidates $caddyfileCandidates)
}
else {
    Write-Item 'OK' 'Caddyfile' $caddyfile
}

# ---------------------------------------------------------------- 5. cloudflared
$cloudflaredCandidates = @(
    (Join-Part $binDir 'cloudflared.exe'),
    $env:HAHART_CLOUDFLARED_EXE,
    (Get-TaskExePath 'hahart-tunnel'),
    'C:\cloudflared\cloudflared.exe',
    'C:\Program Files\cloudflared\cloudflared.exe'
)
$cloudflaredExe = Get-FirstPresent $cloudflaredCandidates
if ($null -eq $cloudflaredExe) {
    Write-Item 'MISSING' 'cloudflared.exe' (Format-Candidates $cloudflaredCandidates)
}
else {
    Write-Item 'OK' 'cloudflared.exe' $cloudflaredExe
}

$cfConfigCandidates = @(
    (Join-Part $cfDir 'config.yml'),
    $env:HAHART_CLOUDFLARED_CONFIG,
    (Join-Part $userCf 'config.yml'),
    'C:\ProgramData\cloudflared\config.yml'
)
$cfConfig = Get-FirstPresent $cfConfigCandidates
if ($null -eq $cfConfig) {
    Write-Item 'MISSING' 'cloudflared config' (Format-Candidates $cfConfigCandidates)
}
else {
    Write-Item 'OK' 'cloudflared config' $cfConfig
}

$credCandidates = @()
foreach ($dir in @($cfDir, $userCf)) {
    $jsonFiles = $null
    if (-not [string]::IsNullOrWhiteSpace($dir)) {
        $jsonFiles = Get-ChildItem -LiteralPath $dir -Filter *.json -ErrorAction SilentlyContinue
    }
    if ($null -ne $jsonFiles) {
        foreach ($file in $jsonFiles) {
            $credCandidates += $file.FullName
        }
    }
}
$credFile = Get-FirstPresent $credCandidates
if ($null -eq $credFile) {
    Write-Item 'MISSING' 'cloudflared credentials' ('no *.json under ' + $cfDir + ' or ' + $userCf)
}
else {
    $credCount = @($credCandidates).Count
    Write-Item 'OK' 'cloudflared credentials' ($credFile + ' (json files found=' + $credCount + ')')
}

# ---------------------------------------------------------------- 6. scheduled tasks
foreach ($taskName in @('hahart-tunnel', 'hahart-jenkins-agent')) {
    $found = $false
    $taskState = 'unknown'
    try {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
        if ($null -ne $task) {
            $found = $true
            $taskState = [string]$task.State
        }
    }
    catch {
        $found = $false
    }
    if ($found) {
        Write-Item 'OK' ('task ' + $taskName) ('state=' + $taskState)
    }
    else {
        Write-Item 'MISSING' ('task ' + $taskName) 'not registered'
    }
}

# ---------------------------------------------------------------- 7. postgres port
$portListening = $false
$portDetail = 'nothing listening on port ' + $PgPort
try {
    $conn = Get-NetTCPConnection -LocalPort $PgPort -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($null -ne $conn) {
        $portListening = $true
        $portDetail = 'listen ' + $conn.LocalAddress + ':' + $conn.LocalPort + ' pid=' + $conn.OwningProcess
    }
}
catch {
    $portListening = $false
}
if (-not $portListening) {
    try {
        $netstatLines = & netstat -an 2>$null
        foreach ($line in $netstatLines) {
            if (($line -match ('[:.]' + $PgPort + '\s')) -and ($line -match 'LISTEN')) {
                $portListening = $true
                $portDetail = 'listen via netstat: ' + $line.Trim()
                break
            }
        }
    }
    catch {
        $portListening = $false
    }
}
if ($portListening) {
    Write-Item 'OK' ('pg port ' + $PgPort) $portDetail
}
else {
    Write-Item 'MISSING' ('pg port ' + $PgPort) $portDetail
}

# ---------------------------------------------------------------- summary
Write-Output ('SUMMARY ok={0} missing={1}' -f $script:okCount, $script:missingCount)
if ($script:missingCount -gt 0) {
    exit 1
}
exit 0
