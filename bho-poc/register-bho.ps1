<#
.SYNOPSIS
  Registers JumperBho.dll as a Browser Helper Object (BHO) for testing in
  Edge IE mode.

  MUST be run elevated (Administrator PowerShell) - it writes to HKLM.

.DESCRIPTION
  Does three things:
   1. Registers the COM class via regasm /codebase, using BOTH the 32-bit and
      64-bit regasm.exe (the assembly is built AnyCPU, so it's valid to advertise
      to either bitness - we don't know yet which bitness IE mode's host process
      uses in this deployment, so we cover both rather than guessing).
   2. Creates the "Browser Helper Objects" registry key for our CLSID - this is
      the actual switch that makes Trident/MSHTML load it into pages. Written to
      both the 64-bit and Wow6432Node views to be safe.
   3. Prints the log file path to tail while testing.
#>

$ErrorActionPreference = "Stop"

$clsid = "{6B1D4E2A-7F3C-4A9B-9E5D-2C8F1A3B6D71}"
$dllPath = Join-Path $PSScriptRoot "bin\Release\net472\JumperBho.dll"

if (-not (Test-Path $dllPath)) {
    $dllPath = Join-Path $PSScriptRoot "bin\Debug\net472\JumperBho.dll"
}
if (-not (Test-Path $dllPath)) {
    throw "JumperBho.dll not found. Build the project first (dotnet build -c Release), then re-run this script."
}
$dllPath = (Resolve-Path $dllPath).Path
Write-Host "Using DLL: $dllPath"

$regasm32 = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\RegAsm.exe"
$regasm64 = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\RegAsm.exe"

foreach ($regasm in @($regasm32, $regasm64)) {
    if (Test-Path $regasm) {
        Write-Host "Registering with $regasm ..."
        & $regasm $dllPath /codebase /nologo
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "$regasm exited with code $LASTEXITCODE (continuing - the other bitness may still succeed)"
        }
    } else {
        Write-Warning "Not found, skipping: $regasm"
    }
}

# Create the Browser Helper Objects key in both registry views.
$bhoPaths = @(
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Browser Helper Objects\$clsid",
    "HKLM:\SOFTWARE\Wow6432Node\Microsoft\Windows\CurrentVersion\Explorer\Browser Helper Objects\$clsid"
)
foreach ($path in $bhoPaths) {
    New-Item -Path $path -Force | Out-Null
    Write-Host "Created BHO key: $path"
}

Write-Host ""
Write-Host "Done. Log file (create it by opening ANY IE-mode tab, or any Chameleon page) will appear at:"
Write-Host "  C:\Temp\jumper-bho.log"
Write-Host ""
Write-Host "Next: close and reopen the Chameleon IE-mode tab (or open a brand new one), then check the log."
Write-Host "If nothing appears, restart Edge entirely (BHOs are read once, likely on IE-mode host process startup)."
