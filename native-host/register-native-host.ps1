# Registers the Jumper native messaging host manifest with Edge, under the
# CURRENT USER hive (HKCU) - no admin required, unlike the BHO's own COM/BHO
# registration which needs HKLM.
#
# Run this once (and again if the extension ID or manifest path changes).

$ErrorActionPreference = "Stop"

$manifestPath = Join-Path $PSScriptRoot "com.jumper.native_host.json"
if (-not (Test-Path $manifestPath)) {
    throw "Manifest not found at $manifestPath"
}

$hostName = "com.jumper.native_host"
$regKeyPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"

New-Item -Path $regKeyPath -Force | Out-Null
Set-ItemProperty -Path $regKeyPath -Name "(Default)" -Value $manifestPath

Write-Host "Registered native messaging host '$hostName' -> $manifestPath"
Write-Host "Registry key: $regKeyPath"
Write-Host ""
Write-Host "If you change the extension ID (allowed_origins) or the exe path, edit"
Write-Host "com.jumper.native_host.json and re-run this script."
