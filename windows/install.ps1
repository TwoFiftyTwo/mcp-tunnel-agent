<#
.SYNOPSIS
  Install the TwoFiftyTwo MCP tunnel agent as a Windows service.

.DESCRIPTION
  Run once, elevated, from the extracted release folder. Installs the agent
  binary and its service wrapper, enrolls it with the one-time token, waits
  for enrollment to complete, then removes the token from the service config
  so the only long-lived secret on disk is the ACL-protected state file.

  Idempotent enough to re-run for a credential replacement: pass a fresh
  -EnrollmentToken and it re-enrolls the existing install.

.PARAMETER ControlUrl
  Your TwoFiftyTwo API origin, e.g. https://api.twofiftytwo.ai (shown in the
  Data Sources wizard). Must be https.

.PARAMETER EnrollmentToken
  The one-time enrollment token from the Data Sources wizard.

.PARAMETER McpLocalUrl
  Your private MCP server's Streamable-HTTP endpoint as reachable from THIS
  host, e.g. http://localhost:8010/mcp. Never sent to TwoFiftyTwo.

.PARAMETER LocalAuthType / LocalAuthToken / LocalAuthHeaderName
  Optional credential the agent presents to your MCP server (bearer or a
  custom header). Stays on this host.

.PARAMETER HttpsProxy
  Optional outbound proxy for reaching TwoFiftyTwo, e.g.
  http://user:pass@proxy.corp:3128. Not used for the local MCP call.

.EXAMPLE
  .\install.ps1 -ControlUrl https://api.twofiftytwo.ai `
     -EnrollmentToken 'tfmcp_enroll_v1....' `
     -McpLocalUrl http://localhost:8010/mcp
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $ControlUrl,
  [Parameter(Mandatory)] [string] $EnrollmentToken,
  [Parameter(Mandatory)] [string] $McpLocalUrl,
  [ValidateSet('none','bearer','header')] [string] $LocalAuthType = 'none',
  [string] $LocalAuthToken,
  [string] $LocalAuthHeaderName,
  [string] $HttpsProxy,
  [string] $InstallDir = "$env:ProgramFiles\TwoFiftyTwo\MCP Tunnel",
  [string] $StateDir   = "$env:ProgramData\TwoFiftyTwo\mcp-tunnel-agent"
)

$ErrorActionPreference = 'Stop'
$ServiceId = 'twofiftytwo-mcp-tunnel'

function Assert-Admin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated (Administrator) PowerShell.'
  }
}

function Assert-Inputs {
  if ($ControlUrl -notmatch '^https://') { throw 'ControlUrl must be an https:// URL.' }
  if ($McpLocalUrl -notmatch '^https?://') { throw 'McpLocalUrl must be an http:// or https:// URL.' }
  if ($EnrollmentToken -notmatch '^tfmcp_enroll_v1\.') { throw 'EnrollmentToken does not look like a TwoFiftyTwo enrollment token.' }
  if ($LocalAuthType -ne 'none' -and -not $LocalAuthToken) { throw "LocalAuthType '$LocalAuthType' requires -LocalAuthToken." }
  if ($LocalAuthType -eq 'header' -and -not $LocalAuthHeaderName) { throw "LocalAuthType 'header' requires -LocalAuthHeaderName." }
}

function Escape-Xml([string] $s) {
  return [System.Security.SecurityElement]::Escape($s)
}

# Windows PowerShell 5.1 (what Windows Server ships) does NOT turn a native
# command's non-zero exit into a terminating error, whatever
# $ErrorActionPreference says. Every sc.exe / icacls / WinSW call goes through
# here so a failed ACL or a failed service registration stops the install
# instead of leaving a half-configured, possibly unprotected service behind.
function Invoke-Native([string] $What, [scriptblock] $Command) {
  $output = & $Command 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "$What failed (exit $LASTEXITCODE):`n$($output -join "`n")"
  }
  return $output
}

Assert-Admin
Assert-Inputs

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
foreach ($f in @('mcp-tunnel-agent.exe', "$ServiceId.exe", "$ServiceId.xml")) {
  if (-not (Test-Path (Join-Path $here $f))) { throw "Missing $f next to install.ps1 - run this from the extracted release folder." }
}

Write-Host "Installing to $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir, "$InstallDir\logs", $StateDir | Out-Null

# --- Stop an existing service before replacing binaries (re-run / upgrade / re-enroll) ---
$existing = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
if ($existing -and $existing.Status -ne 'Stopped') {
  Write-Host "Stopping existing $ServiceId"
  Invoke-Native "stopping the existing service" { & "$InstallDir\$ServiceId.exe" stop } | Out-Null
}

Copy-Item (Join-Path $here 'mcp-tunnel-agent.exe') $InstallDir -Force
Copy-Item (Join-Path $here "$ServiceId.exe")       $InstallDir -Force

# --- Render the service XML with this install's values ---
$stateFile = Join-Path $StateDir 'state.json'
$extraEnv = @()
if ($LocalAuthType -ne 'none') {
  $extraEnv += "<env name=`"MCP_LOCAL_AUTH_TYPE`" value=`"$LocalAuthType`"/>"
  $extraEnv += "<env name=`"MCP_LOCAL_AUTH_TOKEN`" value=`"$(Escape-Xml $LocalAuthToken)`"/>"
  if ($LocalAuthType -eq 'header') {
    $extraEnv += "<env name=`"MCP_LOCAL_AUTH_HEADER_NAME`" value=`"$(Escape-Xml $LocalAuthHeaderName)`"/>"
  }
}
if ($HttpsProxy) { $extraEnv += "<env name=`"MCP_TUNNEL_HTTPS_PROXY`" value=`"$(Escape-Xml $HttpsProxy)`"/>" }

$xml = Get-Content (Join-Path $here "$ServiceId.xml") -Raw
$xml = $xml.Replace('__CONTROL_URL__',      (Escape-Xml $ControlUrl)).
            Replace('__ENROLLMENT_TOKEN__', (Escape-Xml $EnrollmentToken)).
            Replace('__MCP_LOCAL_URL__',    (Escape-Xml $McpLocalUrl)).
            Replace('__STATE_FILE__',       (Escape-Xml $stateFile)).
            Replace('__EXTRA_ENV__',        ($extraEnv -join "`n  "))
Set-Content -Path "$InstallDir\$ServiceId.xml" -Value $xml -Encoding UTF8

# --- Register the service (WinSW), run it under its own virtual service account ---
if (-not $existing) {
  Invoke-Native "registering the service" { & "$InstallDir\$ServiceId.exe" install } | Out-Null
}
# Per-service SID + virtual account: no password to store, and the ACL below
# can name exactly this service and nothing else.
Invoke-Native "sc.exe sidtype" { & sc.exe sidtype $ServiceId unrestricted } | Out-Null
Invoke-Native "sc.exe config obj=" { & sc.exe config $ServiceId obj= "NT SERVICE\$ServiceId" } | Out-Null

# --- Lock the credential directory down. This is the real protection on Windows:
#     Deno's chmod cannot express owner-only here. ACL the DIRECTORY (inheritable),
#     because the agent writes temp -> rename, and a file-level ACL would be lost
#     on the first credential rotation. Numeric SIDs so this works on localized
#     Windows. The service gets Modify, not Full, so it cannot rewrite its own ACL.
Invoke-Native "icacls (state dir, remove inheritance)" { & icacls $StateDir /inheritance:r } | Out-Null
Invoke-Native "icacls (state dir, grant)" { & icacls $StateDir /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "NT SERVICE\${ServiceId}:(OI)(CI)M" } | Out-Null

# --- The install directory holds the service XML, which carries the local MCP
#     credential (-LocalAuthType) and, until enrollment completes, the enrollment
#     token. Program Files inherits Read for every local user by default, so
#     lock the whole install dir down too: SYSTEM and Administrators full, the
#     service account read-only (it only needs to read its config and binaries),
#     plus Modify on the logs folder it writes.
Invoke-Native "icacls (install dir, remove inheritance)" { & icacls $InstallDir /inheritance:r } | Out-Null
Invoke-Native "icacls (install dir, grant)" { & icacls $InstallDir /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "NT SERVICE\${ServiceId}:(OI)(CI)RX" } | Out-Null
Invoke-Native "icacls (logs dir)" { & icacls "$InstallDir\logs" /grant "NT SERVICE\${ServiceId}:(OI)(CI)M" } | Out-Null

# --- Start and wait for enrollment ---
# On a re-run (Replace tunnel credential) state.json already exists, holding
# the REVOKED credential. The agent starts with it, gets a 401, then re-enrolls
# with the token and rewrites the file. Waiting for the file to merely exist
# would pass immediately and strip the token before that happened, leaving the
# service looping on 401. So: remember the pre-start write time and wait for a
# NEWER one.
$priorWrite = if (Test-Path $stateFile) { (Get-Item $stateFile).LastWriteTimeUtc } else { [datetime]::MinValue }
Write-Host "Starting $ServiceId"
Invoke-Native "starting the service" { & "$InstallDir\$ServiceId.exe" start } | Out-Null

$deadline = (Get-Date).AddSeconds(60)
$enrolled = $false
while ((Get-Date) -lt $deadline) {
  if ((Test-Path $stateFile) -and ((Get-Item $stateFile).LastWriteTimeUtc -gt $priorWrite)) { $enrolled = $true; break }
  Start-Sleep -Seconds 2
}

if (-not $enrolled) {
  Write-Warning "The service started but has not enrolled after 60s. Check $InstallDir\logs\$ServiceId.err.log"
  Write-Warning "Common causes: token already used or expired (generate a new one in Data Sources), no outbound 443 to $ControlUrl, or a TLS-inspecting proxy."
  exit 1
}

# --- Enrolled: drop the one-time token from the service config so no long-lived
#     secret sits in the XML. The agent prefers its stored credential and never
#     replays a spent token, so this is purely hygiene. Restart to apply.
$xml = Get-Content "$InstallDir\$ServiceId.xml" -Raw
$xml = [regex]::Replace($xml, '\s*<env name="MCP_TUNNEL_ENROLLMENT_TOKEN"[^>]*/>', '')
Set-Content -Path "$InstallDir\$ServiceId.xml" -Value $xml -Encoding UTF8
Invoke-Native "restarting the service" { & "$InstallDir\$ServiceId.exe" restart } | Out-Null

Write-Host ''
Write-Host "Enrolled. The tunnel is running as service '$ServiceId' and will start with Windows." -ForegroundColor Green
Write-Host "  Status : Get-Service $ServiceId"
Write-Host "  Logs   : $InstallDir\logs\"
Write-Host "  Next   : in TwoFiftyTwo, Data Sources -> your server -> Refresh tools, then an administrator approves it."
