<#
.SYNOPSIS
  One-shot installer for the Jumper Edge-extension bridge POC: builds and
  registers BOTH the BHO (jumper-bho-poc) and the native messaging host
  (jumper-native-host) in a single run, with a single elevation prompt.

.DESCRIPTION
  This does NOT merge the two projects into one binary - that's still
  architecturally blocked (the BHO must be an in-proc COM DLL loaded by
  Trident via InprocServer32; the native host must be a standalone EXE
  launched by Edge via connectNative - two different OS activation models).
  What this DOES do is remove the "two separate manual scripts, one of which
  needs admin" friction:

   1. Self-elevates once (BHO registration needs HKLM; native host registration
      only needs HKCU, but running both under the same elevated session avoids
      a second UAC prompt).
   2. Builds both projects in Release (dotnet build).
   3. Runs the existing register-bho.ps1 (regasm both bitness + BHO key,
      both registry views).
   4. Runs the existing register-native-host.ps1 (HKCU manifest pointer).
   5. Prints a single combined summary instead of two separate ones.

  Safe to re-run any time (e.g. after a rebuild, or after changing the
  extension ID in com.jumper.native_host.json).

.EXAMPLE
  powershell -File C:\Dev\install-jumper-bridge.ps1
  (will self-elevate; just accept the UAC prompt once)
#>

$ErrorActionPreference = "Stop"

$bhoDir = "C:\Dev\jumper-bridge\bho-poc"
$nativeHostDir = "C:\Dev\jumper-bridge\native-host"

# --- Self-elevate if not already running as Administrator ---------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Not elevated - relaunching this script as Administrator (one UAC prompt covers both installs)..."
    $psi = @{
        FilePath     = "powershell.exe"
        ArgumentList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
        Verb         = "RunAs"
    }
    Start-Process @psi
    exit
}

Write-Host "=== 1/4: Building JumperBho (BHO) ===" -ForegroundColor Cyan
Push-Location $bhoDir
try {
    dotnet build -c Release
    if ($LASTEXITCODE -ne 0) { throw "JumperBho build failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

Write-Host "`n=== 2/4: Building JumperNativeHost ===" -ForegroundColor Cyan
Push-Location $nativeHostDir
try {
    dotnet build -c Release
    if ($LASTEXITCODE -ne 0) { throw "JumperNativeHost build failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

Write-Host "`n=== 3/4: Registering the BHO (regasm + BHO key, HKLM) ===" -ForegroundColor Cyan
& "$bhoDir\register-bho.ps1"

Write-Host "`n=== 4/4: Registering the native messaging host (HKCU) ===" -ForegroundColor Cyan
& "$nativeHostDir\register-native-host.ps1"

Write-Host ""
Write-Host "=== Done. Both components installed. ===" -ForegroundColor Green
Write-Host "Next steps:"
Write-Host "  1. Fully restart Edge (BHOs are read once per iexplore.exe/Edge-IE-mode host process startup)."
Write-Host "  2. Load the extension (edge://extensions -> Developer mode -> Load unpacked -> C:\Dev\jumper-bridge\edge), if not already loaded."
Write-Host "  3. Open a Chameleon IE-mode tab and confirm C:\Temp\jumper-bho.log is growing."
Write-Host "  4. Confirm C:\Temp\jumper-native-host.log is growing (the extension polls it every ~1.5s)."
