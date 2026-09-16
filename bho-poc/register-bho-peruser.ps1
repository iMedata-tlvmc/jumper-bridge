<#
.SYNOPSIS
  Attempts to register JumperBho as a BHO WITHOUT admin rights, entirely under
  HKEY_CURRENT_USER. This is an experiment, not a known-good path:

   - The COM class registration under HKCU\Software\Classes is a genuinely
     supported, documented no-admin mechanism (per-user COM registration).
   - The "Browser Helper Objects" activation key is, as far as we know,
     ONLY ever read by Internet Explorer/Trident from HKLM (+ Wow6432Node) -
     by deliberate design, so a non-admin process can't inject code into any
     user's browser. We are NOT aware of a per-user equivalent, but since this
     script costs nothing and needs no elevation, we're testing empirically
     rather than assuming.

  If this doesn't work, it tells us something useful (confirms BHOs need an
  admin-installed activation key) at zero cost. If it DOES work, it's a huge
  simplification for deployment.
#>

$ErrorActionPreference = "Stop"

$clsid = "{6B1D4E2A-7F3C-4A9B-9E5D-2C8F1A3B6D71}"
$progId = "JumperBho.BhoObject"
$typeName = "JumperBho.BhoObject"
$assemblyName = "JumperBho, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null"
$runtimeVersion = "v4.0.30319"

$dllPath = Join-Path $PSScriptRoot "bin\Release\net472\JumperBho.dll"
if (-not (Test-Path $dllPath)) {
    $dllPath = Join-Path $PSScriptRoot "bin\Debug\net472\JumperBho.dll"
}
if (-not (Test-Path $dllPath)) {
    throw "JumperBho.dll not found. Build the project first (dotnet build -c Release), then re-run this script."
}
$dllPath = (Resolve-Path $dllPath).Path
$codeBase = "file:///" + ($dllPath -replace '\\', '/')

Write-Host "Using DLL: $dllPath"
Write-Host "Registering per-user (HKCU) - no admin required for this part..."

# --- COM class registration under HKCU\Software\Classes ---
$clsidKey = "HKCU:\Software\Classes\CLSID\$clsid"
New-Item -Path $clsidKey -Force | Out-Null
Set-ItemProperty -Path $clsidKey -Name "(default)" -Value $typeName

$inprocKey = "$clsidKey\InprocServer32"
New-Item -Path $inprocKey -Force | Out-Null
# System32 path is transparently redirected to SysWOW64 per-process-bitness by
# Windows' file-system redirector, independent of which registry hive/view
# this string lives in - so one path string works for both 32- and 64-bit
# hosts loading it.
Set-ItemProperty -Path $inprocKey -Name "(default)" -Value "$env:WINDIR\System32\mscoree.dll"
Set-ItemProperty -Path $inprocKey -Name "ThreadingModel" -Value "Both"
Set-ItemProperty -Path $inprocKey -Name "Class" -Value $typeName
Set-ItemProperty -Path $inprocKey -Name "Assembly" -Value $assemblyName
Set-ItemProperty -Path $inprocKey -Name "RuntimeVersion" -Value $runtimeVersion
Set-ItemProperty -Path $inprocKey -Name "CodeBase" -Value $codeBase

$progIdKey = "$clsidKey\ProgId"
New-Item -Path $progIdKey -Force | Out-Null
Set-ItemProperty -Path $progIdKey -Name "(default)" -Value $progId

$progIdRootKey = "HKCU:\Software\Classes\$progId"
New-Item -Path $progIdRootKey -Force | Out-Null
Set-ItemProperty -Path $progIdRootKey -Name "(default)" -Value $progId
New-Item -Path "$progIdRootKey\CLSID" -Force | Out-Null
Set-ItemProperty -Path "$progIdRootKey\CLSID" -Name "(default)" -Value $clsid

Write-Host "COM class registered under HKCU\Software\Classes."

# --- BHO activation key - the part we're not sure will actually be honored ---
$bhoKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Browser Helper Objects\$clsid"
New-Item -Path $bhoKey -Force | Out-Null
Write-Host "Created (experimental) per-user BHO key: $bhoKey"

Write-Host ""
Write-Host "Done - no admin rights were needed for any of this."
Write-Host "Now fully restart Edge, open the Chameleon IE-mode tab, and check for C:\Temp\jumper-bho.log."
Write-Host "If the log never appears, this confirms IE mode only honors the HKLM-based BHO key (expected outcome)."
