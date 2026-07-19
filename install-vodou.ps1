# =============================================================================
# install-vodou.ps1 — Windows installer (BETA) for the open-core split.
#   irm https://raw.githubusercontent.com/VodouAI/OS/main/install-vodou.ps1 | iex
#
# Two-source install (mirrors install-vodou.sh): the OPEN tree (MIT) comes from
# VodouAI/OS; the proprietary ENGINE (win-x64, EULA) is fetched from
# VodouAI/vodou-core Releases and sha256-verified before it runs.
#
# STATUS: beta. The engine is unsigned (SmartScreen will warn). Source-server
# dependency provisioning (Node + npm) is handled by install.bat on first run.
# Validate on a clean Windows box before relying on it.
# =============================================================================
$ErrorActionPreference = "Stop"

$OsRepo   = "VodouAI/OS"
$CoreRepo = "VodouAI/vodou-core"
$Version  = if ($env:VODOU_VERSION) { $env:VODOU_VERSION.TrimStart('v') } else { "latest" }
$InstallDir = if ($env:VODOU_INSTALL_DIR) { $env:VODOU_INSTALL_DIR } else { Join-Path (Get-Location) "vodou" }

Write-Host ""
Write-Host "  Vodou Installer (Windows, beta)"
Write-Host "  AI that learns YOU — locally"
Write-Host ""

# Only x64 engine is published for Windows today.
$arch = (Get-CimInstance Win32_Processor).Architecture
if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
    Write-Host "This build supports Windows x64 only (found $env:PROCESSOR_ARCHITECTURE)." -ForegroundColor Yellow
    exit 1
}

# Resolve engine version from vodou-core (authoritative).
if ($Version -eq "latest") {
    $rel = Invoke-RestMethod "https://api.github.com/repos/$CoreRepo/releases/latest"
    $Version = $rel.tag_name.TrimStart('v')
}
Write-Host "Installing Vodou v$Version (win-x64) to $InstallDir"

if (Test-Path (Join-Path $InstallDir "vodou-core.exe")) {
    Write-Host "Vodou already present at $InstallDir. Remove it or set VODOU_INSTALL_DIR." -ForegroundColor Yellow
    exit 1
}

$tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("vodou-" + [System.Guid]::NewGuid())) -Force

# 1. Open tree from VodouAI/OS (main).
Write-Host "Downloading open tree from $OsRepo ..."
$treeZip = Join-Path $tmp "os.zip"
Invoke-WebRequest "https://github.com/$OsRepo/archive/refs/heads/main.zip" -OutFile $treeZip
Expand-Archive -Path $treeZip -DestinationPath $tmp -Force
$extracted = Get-ChildItem -Path $tmp -Directory | Where-Object { $_.Name -like "OS-*" } | Select-Object -First 1
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item -Path (Join-Path $extracted.FullName "*") -Destination $InstallDir -Recurse -Force

# 2. Engine from vodou-core, sha256-verified (refuse on mismatch).
Write-Host "Fetching engine (win-x64), verifying checksum ..."
$base = "https://github.com/$CoreRepo/releases/download/v$Version"
$manifest = Invoke-RestMethod "$base/manifest.json"
$eng = $manifest.engines.'windows-x64'
if (-not $eng) { Write-Host "No windows-x64 engine in v$Version manifest." -ForegroundColor Red; exit 1 }
$asset = Join-Path $tmp $eng.asset
Invoke-WebRequest "$base/$($eng.asset)" -OutFile $asset
$got = (Get-FileHash -Algorithm SHA256 $asset).Hash.ToLower()
if ($got -ne $eng.sha256.ToLower()) {
    Write-Host "CHECKSUM MISMATCH — refusing to install." -ForegroundColor Red
    Write-Host "  expected $($eng.sha256)"; Write-Host "  got      $got"
    exit 1
}
Write-Host "  sha256 verified"
# Engine assets are .tar.gz; tar ships with Windows 10+.
tar -xzf $asset -C $InstallDir
if (-not (Test-Path (Join-Path $InstallDir "vodou-core.exe"))) {
    Write-Host "Engine missing after extract." -ForegroundColor Red; exit 1
}

# 3. Run the Windows setup (env, dirs, provisioning on first run).
Write-Host "Running installer ..."
Push-Location $InstallDir
cmd /c install.bat
Pop-Location

Remove-Item -Recurse -Force $tmp
Write-Host ""
Write-Host "Vodou v$Version installed to $InstallDir" -ForegroundColor Green
Write-Host "Note: the engine is unsigned — SmartScreen may warn on first run."
