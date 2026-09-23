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
   5. Downloads the configured Enterprise Mode Site List, adds the three
      Chameleon shared-session cookies, writes a local merged copy, and points
      the current user's Edge policy to it.
   6. Prints a single combined summary instead of separate ones.

  Safe to re-run any time (e.g. after a rebuild, or after changing the
  extension ID in com.jumper.native_host.json).

.EXAMPLE
  powershell -File C:\Dev\install-jumper-bridge.ps1
  (will self-elevate; just accept the UAC prompt once)
#>

$ErrorActionPreference = "Stop"

$bhoDir = "C:\Dev\jumper-bridge\bho-poc"
$nativeHostDir = "C:\Dev\jumper-bridge\native-host"
$edgePolicyPath = "HKCU:\Software\Policies\Microsoft\Edge"
$jumperPolicyPath = "HKCU:\Software\JumperBridge"
$siteListPolicyName = "InternetExplorerIntegrationSiteList"
$siteListSourceValueName = "EnterpriseModeSiteListSource"
$mergedSiteListDir = Join-Path $env:ProgramData "JumperBridge"
$mergedSiteListPath = Join-Path $mergedSiteListDir "sites-with-shared-cookies.xml"

function Get-SiteListXml {
    param([Parameter(Mandatory = $true)][string]$Source)

    if ($Source -match '^https?://') {
        return (Invoke-WebRequest -Uri $Source -UseBasicParsing -UseDefaultCredentials).Content
    }

    if ($Source -match '^file://') {
        $sourcePath = ([Uri]$Source).LocalPath
    } else {
        $sourcePath = $Source
    }

    if (-not (Test-Path $sourcePath)) {
        throw "Enterprise Mode Site List source does not exist: $Source"
    }
    return Get-Content -Path $sourcePath -Raw
}

function Install-SharedCookieSiteList {
    param(
        [Parameter(Mandatory = $true)][string]$EdgePolicyPath,
        [Parameter(Mandatory = $true)][string]$JumperPolicyPath,
        [Parameter(Mandatory = $true)][string]$SiteListPolicyName,
        [Parameter(Mandatory = $true)][string]$SiteListSourceValueName,
        [Parameter(Mandatory = $true)][string]$MergedSiteListDir,
        [Parameter(Mandatory = $true)][string]$MergedSiteListPath
    )

    if (-not (Test-Path $EdgePolicyPath)) {
        New-Item -Path $EdgePolicyPath -Force | Out-Null
    }
    if (-not (Test-Path $JumperPolicyPath)) {
        New-Item -Path $JumperPolicyPath -Force | Out-Null
    }

    $currentPolicyItem = Get-ItemProperty -Path $EdgePolicyPath -Name $SiteListPolicyName -ErrorAction SilentlyContinue
    $currentPolicy = if ($currentPolicyItem) {
        $currentPolicyItem.PSObject.Properties[$SiteListPolicyName].Value
    } else {
        $null
    }
    $savedSourceItem = Get-ItemProperty -Path $JumperPolicyPath -Name $SiteListSourceValueName -ErrorAction SilentlyContinue
    $savedSource = if ($savedSourceItem) {
        $savedSourceItem.PSObject.Properties[$SiteListSourceValueName].Value
    } else {
        $null
    }
    $mergedSiteListUri = ([Uri]$MergedSiteListPath).AbsoluteUri

    if ($currentPolicy -and $currentPolicy -ne $mergedSiteListUri) {
        $source = $currentPolicy
        Set-ItemProperty -Path $JumperPolicyPath -Name $SiteListSourceValueName -Value $source
    } elseif ($savedSource) {
        $source = $savedSource
    } else {
        throw "Edge policy '$SiteListPolicyName' is not configured. Configure the corporate Enterprise Mode Site List first."
    }

    Write-Host "Downloading Enterprise Mode Site List from: $source"
    [xml]$siteList = Get-SiteListXml -Source $source
    $root = $siteList.SelectSingleNode("/site-list")
    if ($null -eq $root) {
        throw "The Enterprise Mode Site List source has no <site-list> root element."
    }

    $cookies = @(
        @{ Name = ".CHAMELEONAUTH"; Path = "/" },
        @{ Name = "ASP.NET_SessionId"; Path = "/" },
        @{ Name = "_cu"; Path = $null }
    )
    foreach ($cookie in $cookies) {
        $existing = @($root.SelectNodes("shared-cookie[@host='chsw.tasmc.corp' and @name='$($cookie.Name)']"))
        foreach ($node in $existing) {
            [void]$root.RemoveChild($node)
        }

        $node = $siteList.CreateElement("shared-cookie")
        $node.SetAttribute("host", "chsw.tasmc.corp")
        $node.SetAttribute("name", $cookie.Name)
        $node.SetAttribute("source-engine", "Both")
        if ($cookie.Path) {
            $node.SetAttribute("path", $cookie.Path)
        }

        $createdBy = $root.SelectSingleNode("created-by")
        if ($createdBy) {
            [void]$root.InsertBefore($node, $createdBy)
        } else {
            [void]$root.PrependChild($node)
        }
    }

    [long]$sourceVersion = 0
    [void][long]::TryParse($root.GetAttribute("version"), [ref]$sourceVersion)
    [long]$existingVersion = 0
    if (Test-Path $MergedSiteListPath) {
        [xml]$existingList = Get-Content -Path $MergedSiteListPath -Raw
        [void][long]::TryParse(
            $existingList.DocumentElement.GetAttribute("version"),
            [ref]$existingVersion
        )
    }
    $epochVersion = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $newVersion = [Math]::Max(
        [Math]::Max($sourceVersion + 1, $existingVersion + 1),
        $epochVersion
    )
    $root.SetAttribute("version", $newVersion.ToString())

    New-Item -ItemType Directory -Path $MergedSiteListDir -Force | Out-Null
    $tempPath = "$MergedSiteListPath.tmp"
    $settings = New-Object System.Xml.XmlWriterSettings
    $settings.Encoding = New-Object System.Text.UTF8Encoding($false)
    $settings.Indent = $true
    $settings.NewLineChars = "`r`n"
    $writer = [System.Xml.XmlWriter]::Create($tempPath, $settings)
    try {
        $siteList.Save($writer)
    } finally {
        $writer.Dispose()
    }
    Move-Item -Path $tempPath -Destination $MergedSiteListPath -Force

    Set-ItemProperty -Path $EdgePolicyPath -Name $SiteListPolicyName -Value $mergedSiteListUri
    Write-Host "Merged site list: $MergedSiteListPath"
    Write-Host "Edge policy: $SiteListPolicyName -> $mergedSiteListUri"
}

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

Write-Host "=== 1/5: Building JumperBho (BHO) ===" -ForegroundColor Cyan
Push-Location $bhoDir
try {
    dotnet build -c Release
    if ($LASTEXITCODE -ne 0) { throw "JumperBho build failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

Write-Host "`n=== 2/5: Building JumperNativeHost ===" -ForegroundColor Cyan
Push-Location $nativeHostDir
try {
    dotnet build -c Release
    if ($LASTEXITCODE -ne 0) { throw "JumperNativeHost build failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

Write-Host "`n=== 3/5: Registering the BHO (regasm + BHO key, HKLM) ===" -ForegroundColor Cyan
& "$bhoDir\register-bho.ps1"

Write-Host "`n=== 4/5: Registering the native messaging host (HKCU) ===" -ForegroundColor Cyan
& "$nativeHostDir\register-native-host.ps1"

Write-Host "`n=== 5/5: Installing Enterprise Mode shared-cookie policy (HKCU) ===" -ForegroundColor Cyan
Install-SharedCookieSiteList `
    -EdgePolicyPath $edgePolicyPath `
    -JumperPolicyPath $jumperPolicyPath `
    -SiteListPolicyName $siteListPolicyName `
    -SiteListSourceValueName $siteListSourceValueName `
    -MergedSiteListDir $mergedSiteListDir `
    -MergedSiteListPath $mergedSiteListPath

Write-Host ""
Write-Host "=== Done. Components and shared-cookie policy installed. ===" -ForegroundColor Green
Write-Host "Next steps:"
Write-Host "  1. Fully restart Edge (BHO and Enterprise Mode list changes require a fresh browser process)."
Write-Host "  2. Load the extension (edge://extensions -> Developer mode -> Load unpacked -> C:\Dev\jumper-bridge\edge), if not already loaded."
Write-Host "  3. Log in to Chameleon again so the shared cookies are copied between IE mode and Chromium."
Write-Host "  4. Open a Chameleon IE-mode tab and confirm C:\Temp\jumper-bho.log is growing."
Write-Host "  5. Confirm C:\Temp\jumper-native-host.log is growing (the extension polls it every ~1.5s)."
