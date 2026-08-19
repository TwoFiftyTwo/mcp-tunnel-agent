<#
.SYNOPSIS
  Remove the TwoFiftyTwo MCP tunnel agent service.

.DESCRIPTION
  Stops and unregisters the service and deletes the installed binaries. The
  enrolled credential under ProgramData is kept unless -RemoveState is passed,
  so a reinstall can reconnect without a new enrollment token.
#>
[CmdletBinding()]
param(
  [switch] $RemoveState,
  [string] $InstallDir = "$env:ProgramFiles\TwoFiftyTwo\MCP Tunnel",
  [string] $StateDir   = "$env:ProgramData\TwoFiftyTwo\mcp-tunnel-agent"
)

$ErrorActionPreference = 'Stop'
$ServiceId = 'twofiftytwo-mcp-tunnel'

$p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script from an elevated (Administrator) PowerShell.'
}

$wrapper = "$InstallDir\$ServiceId.exe"
if (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue) {
  if (Test-Path $wrapper) {
    & $wrapper stop      | Out-Null
    & $wrapper uninstall | Out-Null
  } else {
    & sc.exe stop   $ServiceId | Out-Null
    & sc.exe delete $ServiceId | Out-Null
  }
  Write-Host "Removed service $ServiceId"
}

if (Test-Path $InstallDir) {
  Remove-Item -Recurse -Force $InstallDir
  Write-Host "Removed $InstallDir"
}

if ($RemoveState -and (Test-Path $StateDir)) {
  Remove-Item -Recurse -Force $StateDir
  Write-Host "Removed $StateDir (the tunnel credential). A fresh enrollment token is needed to reconnect."
} elseif (Test-Path $StateDir) {
  Write-Host "Kept $StateDir so a reinstall reconnects without a new token. Pass -RemoveState to delete it."
}
