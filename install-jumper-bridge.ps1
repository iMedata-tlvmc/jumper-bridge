<#
.SYNOPSIS
  Installs the Jumper Edge-extension bridge dependencies.

.DESCRIPTION
   1. Builds the Namer native messaging host in Release.
   2. Registers the native host for the current user.
   3. Downloads the configured Enterprise Mode Site List, adds the three
      Chameleon shared-session cookies, writes a local merged copy, and points
      the current user's Edge policy to it.

  Administrator rights are required only once when upgrading a machine that
  still has the retired Jumper BHO registered. New installations and later
  reruns do not require elevation.

.EXAMPLE
  powershell -File C:\Dev\jumper-bridge\install-jumper-bridge.ps1
#>

$ErrorActionPreference = "Stop"

$nativeHostDir = "C:\Dev\jumper-bridge\native-host"
$nativeHostExe = Join-Path $nativeHostDir "bin\Release\net472\JumperNativeHost.exe"
$nativeHostRegistryPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.jumper.native_host"
$edgePolicyPath = "HKCU:\Software\Policies\Microsoft\Edge"
$jumperPolicyPath = "HKCU:\Software\JumperBridge"
$siteListPolicyName = "InternetExplorerIntegrationSiteList"
$siteListSourceValueName = "EnterpriseModeSiteListSource"
$mergedSiteListDir = Join-Path $env:LOCALAPPDATA "JumperBridge"
$mergedSiteListPath = Join-Path $mergedSiteListDir "sites-with-shared-cookies.xml"
$legacyMergedSiteListPath = Join-Path $env:ProgramData "JumperBridge\sites-with-shared-cookies.xml"
$legacyBhoClsid = "{6B1D4E2A-7F3C-4A9B-9E5D-2C8F1A3B6D71}"
$legacyBhoPaths = @(
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Browser Helper Objects\$legacyBhoClsid",
    "HKLM:\SOFTWARE\Wow6432Node\Microsoft\Windows\CurrentVersion\Explorer\Browser Helper Objects\$legacyBhoClsid",
    "HKLM:\SOFTWARE\Classes\CLSID\$legacyBhoClsid",
    "HKLM:\SOFTWARE\Wow6432Node\Classes\CLSID\$legacyBhoClsid"
)

function Test-IsAdministrator {
    return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator
    )
}

function Remove-LegacyBhoRegistration {
    param([Parameter(Mandatory = $true)][string[]]$Paths)

    $existingPaths = @($Paths | Where-Object { Test-Path $_ })
    if ($existingPaths.Count -eq 0) {
        return
    }

    if (-not (Test-IsAdministrator)) {
        Write-Host "The retired Jumper BHO is still registered. Requesting elevation for one-time removal..."
        $elevated = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", "`"$PSCommandPath`""
        )
        exit $elevated.ExitCode
    }

    Write-Host "Removing retired Jumper BHO registration..." -ForegroundColor Cyan
    foreach ($path in $existingPaths) {
        Remove-Item -Path $path -Recurse -Force
        Write-Host "Removed: $path"
    }
}

function Stop-RegisteredNativeHost {
    param(
        [Parameter(Mandatory = $true)][string]$RegistryPath,
        [Parameter(Mandatory = $true)][string]$ExecutablePath
    )

    Remove-Item -Path $RegistryPath -Recurse -Force -ErrorAction SilentlyContinue

    $normalizedPath = [IO.Path]::GetFullPath($ExecutablePath)
    $hostProcesses = Get-CimInstance Win32_Process -Filter "Name='JumperNativeHost.exe'" |
        Where-Object {
            $_.ExecutablePath -and
            [string]::Equals(
                [IO.Path]::GetFullPath($_.ExecutablePath),
                $normalizedPath,
                [StringComparison]::OrdinalIgnoreCase
            )
        }

    foreach ($process in $hostProcesses) {
        Stop-Process -Id $process.ProcessId -Force
        Write-Host "Stopped previous native host process: $($process.ProcessId)"
    }
}

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
        [Parameter(Mandatory = $true)][string]$MergedSiteListPath,
        [Parameter(Mandatory = $true)][string]$LegacyMergedSiteListPath
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
    $legacyMergedSiteListUri = ([Uri]$LegacyMergedSiteListPath).AbsoluteUri
    $currentPolicyIsManaged = $currentPolicy -eq $mergedSiteListUri -or
        $currentPolicy -eq $legacyMergedSiteListUri

    if ($currentPolicy -and -not $currentPolicyIsManaged) {
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

Remove-LegacyBhoRegistration -Paths $legacyBhoPaths
Stop-RegisteredNativeHost `
    -RegistryPath $nativeHostRegistryPath `
    -ExecutablePath $nativeHostExe

Write-Host "=== 1/3: Building JumperNativeHost ===" -ForegroundColor Cyan
Push-Location $nativeHostDir
try {
    dotnet build -c Release
    if ($LASTEXITCODE -ne 0) { throw "JumperNativeHost build failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

Write-Host "`n=== 2/3: Registering the native messaging host (HKCU) ===" -ForegroundColor Cyan
& "$nativeHostDir\register-native-host.ps1"

Write-Host "`n=== 3/3: Installing Enterprise Mode shared-cookie policy (HKCU) ===" -ForegroundColor Cyan
Install-SharedCookieSiteList `
    -EdgePolicyPath $edgePolicyPath `
    -JumperPolicyPath $jumperPolicyPath `
    -SiteListPolicyName $siteListPolicyName `
    -SiteListSourceValueName $siteListSourceValueName `
    -MergedSiteListDir $mergedSiteListDir `
    -MergedSiteListPath $mergedSiteListPath `
    -LegacyMergedSiteListPath $legacyMergedSiteListPath

Write-Host ""
Write-Host "=== Done. Native host and shared-cookie policy installed. ===" -ForegroundColor Green
Write-Host "Next steps:"
Write-Host "  1. Fully restart Edge so the Enterprise Mode list is reloaded."
Write-Host "  2. Load the extension (edge://extensions -> Developer mode -> Load unpacked -> C:\Dev\jumper-bridge\edge), if not already loaded."
Write-Host "  3. Log out of Chameleon completely, then log back in so fresh session cookies are shared with Chromium."
Write-Host "  4. Use Gecko's Namer button once and confirm C:\Temp\jumper-native-host.log records LAUNCH_NAMER."
