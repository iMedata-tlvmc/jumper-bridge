<#
.SYNOPSIS
  Removes the JumperBho BHO registration (registry keys + COM registration).
  MUST be run elevated (Administrator PowerShell).
#>

$ErrorActionPreference = "Continue"

$clsid = "{6B1D4E2A-7F3C-4A9B-9E5D-2C8F1A3B6D71}"

$bhoPaths = @(
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Browser Helper Objects\$clsid",
    "HKLM:\SOFTWARE\Wow6432Node\Microsoft\Windows\CurrentVersion\Explorer\Browser Helper Objects\$clsid"
)
foreach ($path in $bhoPaths) {
    if (Test-Path $path) {
        Remove-Item -Path $path -Force
        Write-Host "Removed BHO key: $path"
    }
}

$dllPath = Join-Path $PSScriptRoot "bin\Release\net472\JumperBho.dll"
if (-not (Test-Path $dllPath)) {
    $dllPath = Join-Path $PSScriptRoot "bin\Debug\net472\JumperBho.dll"
}
if (Test-Path $dllPath) {
    $dllPath = (Resolve-Path $dllPath).Path
    $regasm32 = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\RegAsm.exe"
    $regasm64 = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\RegAsm.exe"
    foreach ($regasm in @($regasm32, $regasm64)) {
        if (Test-Path $regasm) {
            Write-Host "Unregistering with $regasm ..."
            & $regasm $dllPath /unregister /nologo
        }
    }
} else {
    Write-Warning "DLL not found at expected build output paths - COM registration may need manual cleanup via regasm /unregister if it was registered from a different path."
}

Write-Host "Done. Restart Edge to make sure the BHO is fully unloaded."
