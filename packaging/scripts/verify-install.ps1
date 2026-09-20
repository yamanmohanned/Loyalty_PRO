<#
.SYNOPSIS
  Post-reboot verification of an installed Walaa API service.

.DESCRIPTION
  Run this from an ELEVATED PowerShell prompt AFTER a full reboot. It checks the five
  properties the packaging phase depends on:

    (a) the service is registered and set to start automatically
    (b) it is running after a reboot, with no user login and no dashboard open
    (c) the LocalSystem service account can read AND write the database, and no
        ordinary local account can read it
    (d) the API answers on the machine's LAN address, not only on localhost
    (e) Windows Firewall allows the API port inbound on Private networks

  Check (b) is the one that validates docs/legacy/CLAUDE_v3.md §3's choice of a Windows Service
  over a Tauri sidecar. If it fails, that decision is wrong and the Loyalty Station
  cannot be built on it.

  One step cannot be automated from this machine: browsing to the API from the tablet.
  The script reports it as MANUAL and prints the exact URL to open.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File verify-install.ps1
#>

[CmdletBinding()]
param(
    [string] $ServiceName = 'LoyaltyProApi',
    [string] $DataDir = (Join-Path $env:ProgramData 'LoyaltyPro'),
    [string] $FirewallRule = 'Loyalty Pro API'
)

$ErrorActionPreference = 'Continue'
$script:Failures = 0
$script:Manual = 0

function Write-Check {
    param([bool] $Ok, [string] $Description, [string] $Evidence = '')
    $label = if ($Ok) { 'PASS' } else { 'FAIL' }
    if (-not $Ok) { $script:Failures++ }
    Write-Host ("  {0}  {1}" -f $label, $Description)
    if ($Evidence) { Write-Host ("        {0}" -f $Evidence) -ForegroundColor DarkGray }
}

function Write-Manual {
    param([string] $Description, [string] $Instruction)
    $script:Manual++
    Write-Host ("  MANUAL  {0}" -f $Description) -ForegroundColor Yellow
    Write-Host ("        {0}" -f $Instruction) -ForegroundColor DarkGray
}

function Write-Section { param([string] $Title) Write-Host ""; Write-Host $Title }

Write-Host ""
Write-Host "Walaa - post-reboot verification"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host ""
    Write-Host "  This script must run from an elevated prompt: it reads the service" -ForegroundColor Red
    Write-Host "  configuration file, whose permissions are deliberately restricted." -ForegroundColor Red
    Write-Host ""
    exit 2
}

$bootTime = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
Write-Host ("  machine booted at {0}" -f $bootTime)

# ── (a) registration and start type ─────────────────────────────────────────────
Write-Section "(a) Service registration"

$service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
Write-Check ($null -ne $service) "the service $ServiceName is registered"
if ($null -eq $service) {
    Write-Host ""
    Write-Host "  Nothing further can be checked. Install with:" -ForegroundColor Red
    Write-Host "    loyalty-pro-service.exe install" -ForegroundColor Red
    Write-Host ""
    exit 1
}

# A delayed-start service still reports StartMode 'Auto'; the distinction lives in the
# registry, and it is worth printing because it changes how long after boot the shop
# has a working till.
$delayed = (Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName" -Name 'DelayedAutostart' -ErrorAction SilentlyContinue).DelayedAutostart
Write-Check ($service.StartMode -eq 'Auto') "start type is Automatic" (
    "StartMode={0}; DelayedAutostart={1}" -f $service.StartMode, $(if ($delayed) { $delayed } else { '0 (starts at boot)' })
)
Write-Check ($service.StartName -eq 'LocalSystem') "runs as LocalSystem" ("StartName={0}" -f $service.StartName)

# ── (b) running after reboot, without a login ───────────────────────────────────
Write-Section "(b) Running after reboot, without a user login"

Write-Check ($service.State -eq 'Running') "the service is running" ("State={0}" -f $service.State)

$apiProcess = $null
if ($service.ProcessId -gt 0) {
    $apiProcess = Get-Process -Id $service.ProcessId -ErrorAction SilentlyContinue
}
Write-Check ($null -ne $apiProcess) "the service host process is alive" (
    "PID={0}" -f $service.ProcessId
)

if ($apiProcess) {
    # StartTime on a LocalSystem-owned process throws for a non-elevated caller and
    # silently yields an empty value. This script demands elevation, but a clear message
    # beats an arithmetic result of minus two thousand years.
    $startTime = $null
    try { $startTime = $apiProcess.StartTime } catch { $startTime = $null }

    if ($startTime) {
        $sinceBoot = [math]::Round(($startTime - $bootTime).TotalSeconds, 1)
        Write-Check ($startTime -ge $bootTime) "it started during this boot, not a leftover process" (
            "started {0} ({1}s after boot)" -f $startTime, $sinceBoot
        )

        # The decisive evidence for 'no login required': the service was already running
        # before an interactive session existed. explorer.exe is the shell, so its start
        # time is when somebody logged in.
        $shell = Get-Process explorer -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1
        if ($shell) {
            Write-Check ($startTime -lt $shell.StartTime) "the API was up BEFORE anyone logged in" (
                "api {0} < logon {1}" -f $startTime.ToString('HH:mm:ss'), $shell.StartTime.ToString('HH:mm:ss')
            )
        } else {
            Write-Check $true "no interactive shell is running at all" "explorer.exe not found - stronger than the usual case"
        }
    } else {
        Write-Check $false "the service process start time could be read" "needs an elevated prompt"
    }
}
# The dashboard must be irrelevant to the API being up. That is the entire argument
# for a service over a Tauri sidecar (docs/legacy/CLAUDE_v3.md §3).
$dashboard = Get-Process 'loyalty-pro-manager' -ErrorAction SilentlyContinue
Write-Check ($null -eq $dashboard) "the manager dashboard is NOT running" $(
    if ($dashboard) { "loyalty-pro-manager.exe is open - close it and re-run for a clean result" } else { "the API is up with the dashboard closed" }
)

# ── configuration, needed by (c) (d) (e) ────────────────────────────────────────
$envFile = Join-Path $DataDir 'loyalty-pro.env'
$configuredPort = 4100
$databasePath = Join-Path $DataDir 'loyalty-pro.db'

if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*API_PORT\s*=\s*"?(\d+)"?') { $configuredPort = [int]$Matches[1] }
        if ($line -match '^\s*DATABASE_URL\s*=\s*"?file:(.+?)"?\s*$') { $databasePath = $Matches[1].Replace('/', [char]92) }
    }
}

# ── (c) database permissions under the service account ──────────────────────────
Write-Section "(c) Database access for the service account"

Write-Check (Test-Path $envFile) "the configuration file exists" $envFile
Write-Check (Test-Path $databasePath) "the database exists where the configuration points" $databasePath

# Machine-scoped, not per-user. A database under a manager's AppData is readable by the
# service only by accident, and invisible to it if the profile is not loaded.
$underUserProfile = $databasePath -like "*$([char]92)Users$([char]92)*"
Write-Check (-not $underUserProfile) "the database is machine-scoped, not inside a user profile" $databasePath

if (Test-Path $databasePath) {
    $acl = icacls $databasePath | Out-String
    # The SYSTEM entry specifically, and that it carries (F) — Full control. Matching
    # 'SYSTEM' anywhere in the output would pass on a read-only entry, which is exactly
    # the failure this check exists to catch: a service that can open the database but
    # not write a transaction to it.
    $systemLine = ($acl -split "`n") | Where-Object { $_ -match 'NT AUTHORITY.SYSTEM' } | Select-Object -First 1
    $systemHasFull = ($null -ne $systemLine) -and $systemLine.Contains('(F)')
    Write-Check $systemHasFull "the service account (SYSTEM) has Full control of the database file" ($systemLine).Trim()

    $upper = $acl.ToUpper()
    $groupWide = $upper.Contains('USERS:') -or $upper.Contains('EVERYONE') -or $upper.Contains('AUTHENTICATED USERS')
    Write-Check (-not $groupWide) "no ordinary local account can read the customer database" (
        ($acl -split "`n" | Where-Object { $_.Trim() -and $_ -notmatch 'Successfully processed' } | Select-Object -Skip 0 -First 4 | ForEach-Object { $_.Trim() }) -join ' | '
    )

    # Read proof: /health runs `SELECT 1` through Prisma, so a 200 means the service
    # account actually opened the database file — the exact failure this check exists
    # for is a service that runs happily while unable to open its database.
    $readOk = $false
    $readEvidence = 'no response'
    try {
        $health = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/health" -f $configuredPort) -TimeoutSec 5 -UseBasicParsing
        $readOk = $health.StatusCode -eq 200
        $readEvidence = $health.Content
    } catch {
        $readEvidence = $_.Exception.Message
    }
    Write-Check $readOk "the service can OPEN and query the database (/health runs a SELECT)" $readEvidence

    # Write proof. The WAL sidecar exists while a connection is open and is removed on a
    # clean shutdown, so its absence alone proves nothing; the database's own timestamp
    # covers the checkpointed case.
    $wal = "$databasePath-wal"
    $walWritten = if (Test-Path $wal) { (Get-Item $wal).LastWriteTime } else { $null }
    $dbWritten = (Get-Item $databasePath).LastWriteTime
    $wroteSinceBoot = ($null -ne $walWritten -and $walWritten -ge $bootTime) -or ($dbWritten -ge $bootTime)
    Write-Check $wroteSinceBoot "the service has WRITTEN to the database since boot" (
        "db last written {0}; wal {1}" -f $dbWritten, $(if ($walWritten) { $walWritten } else { 'absent (checkpointed)' })
    )

    # And that the account can write in the data directory at all — the log the service
    # host itself keeps.
    $serviceLog = Join-Path $DataDir 'logs\service.log'
    if (Test-Path $serviceLog) {
        $logWritten = (Get-Item $serviceLog).LastWriteTime
        Write-Check ($logWritten -ge $bootTime) "the service wrote its own log during this boot" (
            "service.log last written {0}" -f $logWritten
        )
    } else {
        Write-Check $false "the service host log exists" "$serviceLog not found"
    }
}
# ── (d) LAN reachability ────────────────────────────────────────────────────────
Write-Section "(d) LAN reachability"

$listener = Get-NetTCPConnection -State Listen -LocalPort $configuredPort -ErrorAction SilentlyContinue
$anyAddress = $listener | Where-Object { $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' }
Write-Check ($null -ne $anyAddress) "the API listens on all interfaces, not just loopback" $(
    if ($listener) { ($listener | ForEach-Object { "{0}:{1}" -f $_.LocalAddress, $_.LocalPort }) -join ', ' } else { "nothing is listening on port $configuredPort" }
)

# Virtual adapters are excluded by name. A WSL or Hyper-V switch address answers just
# as happily as the real one and would send the operator to the tablet with an address
# that cannot possibly work from the shop floor.
$virtual = 'vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|Bluetooth'
$candidates = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
        $_.IPAddress -ne '127.0.0.1' -and
        $_.IPAddress -notlike '169.254.*' -and
        $_.PrefixOrigin -ne 'WellKnown' -and
        $_.InterfaceAlias -notmatch $virtual
    } |
    Select-Object InterfaceAlias, IPAddress
$addresses = $candidates | Select-Object -ExpandProperty IPAddress

$lanOk = $false
$lanEvidence = 'no LAN address found'
foreach ($address in $addresses) {
    try {
        $response = Invoke-WebRequest -Uri ("http://{0}:{1}/health" -f $address, $configuredPort) -TimeoutSec 5 -UseBasicParsing
        if ($response.StatusCode -eq 200) {
            $lanOk = $true
            $lanEvidence = "http://{0}:{1}/health -> {2}" -f $address, $configuredPort, $response.Content
            break
        }
    } catch {
        $lanEvidence = "http://{0}:{1}/health -> {2}" -f $address, $configuredPort, $_.Exception.Message
    }
}
Write-Check $lanOk "the API answers on the machine's own LAN address" $lanEvidence

if ($candidates) {
    $urls = ($candidates | ForEach-Object { "http://{0}:{1}/health  ({2})" -f $_.IPAddress, $configuredPort, $_.InterfaceAlias }) -join "`n        "
    Write-Manual "the API answers from a SECOND DEVICE on the store network" (
        "On the tablet, open the address on the shop's own network:`n        {0}`n        Expect: {{`"status`":`"ok`",`"service`":`"loyalty-pro-api`"}}" -f $urls
    )
} else {
    Write-Check $false "the machine has a usable LAN address" "only loopback or virtual adapters found"
}

# ── (e) firewall ────────────────────────────────────────────────────────────────
Write-Section "(e) Windows Firewall"

$rule = Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue
Write-Check ($null -ne $rule) "an inbound rule named '$FirewallRule' exists"

if ($rule) {
    Write-Check ($rule.Enabled -eq 'True' -and $rule.Direction -eq 'Inbound' -and $rule.Action -eq 'Allow') "the rule is enabled, inbound, allow" (
        "Enabled={0}; Direction={1}; Action={2}" -f $rule.Enabled, $rule.Direction, $rule.Action
    )
    Write-Check ($rule.Profile -match 'Private|Any') "it covers the Private profile" ("Profile={0}" -f $rule.Profile)

    $portFilter = $rule | Get-NetFirewallPortFilter
    Write-Check ("$($portFilter.LocalPort)" -eq "$configuredPort") "it opens the configured port" (
        "rule port={0}; configured port={1}" -f $portFilter.LocalPort, $configuredPort
    )
}

# The rule only applies if the shop's network is classified Private or Domain. A
# network set to Public silently blocks the Station, and looks like a broken app.
$profiles = Get-NetConnectionProfile | Select-Object InterfaceAlias, NetworkCategory
$publicNetworks = $profiles | Where-Object { $_.NetworkCategory -eq 'Public' }
Write-Check ($null -eq $publicNetworks) "the active network is Private or Domain, so the rule applies" (
    ($profiles | ForEach-Object { "{0}={1}" -f $_.InterfaceAlias, $_.NetworkCategory }) -join ', '
)
if ($publicNetworks) {
    Write-Host "        Fix: Set-NetConnectionProfile -InterfaceAlias '<name>' -NetworkCategory Private" -ForegroundColor DarkGray
}

# ── summary ─────────────────────────────────────────────────────────────────────
Write-Host ""
if ($script:Failures -eq 0) {
    Write-Host "  all automated checks passed" -ForegroundColor Green
    if ($script:Manual -gt 0) {
        Write-Host ("  {0} manual step(s) still to confirm - see MANUAL above" -f $script:Manual) -ForegroundColor Yellow
    }
} else {
    Write-Host ("  {0} check(s) failed" -f $script:Failures) -ForegroundColor Red
}
Write-Host ""
exit $(if ($script:Failures -eq 0) { 0 } else { 1 })
