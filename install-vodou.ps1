# =============================================================================
# install-vodou.ps1 — Windows installer (BETA) for the open-core split.
#   irm https://raw.githubusercontent.com/VodouAI/OS/main/install-vodou.ps1 | iex
#
# SINGLE-source install (deliberately NOT the two-source shape install-vodou.sh
# uses on Unix): Windows installs the complete win-x64 bundle, because it is the
# only Windows artifact that carries Node, node_modules and the MCP servers.
# The tree+engine pair install-vodou.sh assembles works on Unix only because
# install-prebuilt.sh provisions Node there; nothing does that on Windows.
# The bundle is sha256-verified against the release API before anything runs,
# and a missing checksum is a hard refusal (same posture as the auto-updater).
#
# STATUS: beta. The engine is unsigned (SmartScreen will warn).
# NOT YET RUN ON A CLEAN WINDOWS BOX — see ALPHA-READINESS §9.2 check 8.
# =============================================================================
$ErrorActionPreference = "Stop"

$OsRepo   = "VodouAI/OS"
$ApiBase  = if ($env:VODOU_API_BASE) { $env:VODOU_API_BASE } else { "https://app.vodou.ai" }
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

# =============================================================================
# FR-6 / RC-4 (ALPHA-READINESS §9 A0) — Windows installs the FULL BUNDLE.
#
# This script used to mirror install-vodou.sh: fetch the open tree from
# VodouAI/OS, fetch the engine tarball from vodou-core, then run install.bat out
# of the tree. On Unix that works because install-prebuilt.sh downloads Node and
# the runtime deps itself. On Windows nothing does — the open tree has no
# node_modules and no bundled Node, and the engine tarball is one .exe. So
# `vodou-core.exe service install` started a gateway that is a Node application
# with no Node, on every Windows machine that ever ran the documented one-liner.
# The file it invoked was the wrong install.bat as well (RC-4), but even the
# right one could not have worked from that pair of sources.
#
# The win-x64 zip is the only Windows artifact that has ever been complete:
# engine, .node\node.exe, node_modules, MCP servers, ONNX runtime, and the
# install.bat that runs `service install` / `service start`. So fetch that.
#
# Checksum posture matches src/auto_updater.rs: the release API is the source of
# truth, and a MISSING checksum is a hard failure, not a warning — an install
# that cannot verify what it downloaded should not proceed.
# =============================================================================

Write-Host "Resolving the Windows bundle from $ApiBase ..."
$checkUrl = "$ApiBase/api/version/check?version=0.0.0&platform=windows-x86_64&os_name=Windows&os_version=$([System.Environment]::OSVersion.Version.ToString())&architecture=x86_64&user_id=installer"
try {
    $info = Invoke-RestMethod $checkUrl
} catch {
    Write-Host "Could not reach the release API ($ApiBase)." -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)"
    exit 1
}

$zipUrl = $info.download_url
$expected = $info.checksum_sha256
if (-not $zipUrl) {
    # Fall back to the published naming convention, still checksum-gated below.
    $zipUrl = "https://github.com/$OsRepo/releases/download/v$Version/Vodou-v$Version-prebuilt-win-x64.zip"
    Write-Host "  API gave no download_url — using $zipUrl"
}
if (-not $expected) {
    Write-Host "Release API returned no checksum for the Windows bundle — refusing to install." -ForegroundColor Red
    Write-Host "  Nothing verifies what would be downloaded. Report this at https://github.com/$OsRepo/issues"
    exit 1
}

Write-Host "Downloading the Vodou bundle (~450 MB) ..."
$zip = Join-Path $tmp "vodou-win-x64.zip"
Invoke-WebRequest $zipUrl -OutFile $zip
$got = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
if ($got -ne $expected.ToLower()) {
    Write-Host "CHECKSUM MISMATCH - refusing to install." -ForegroundColor Red
    Write-Host "  expected $expected"; Write-Host "  got      $got"
    exit 1
}
Write-Host "  sha256 verified"

Write-Host "Extracting to $InstallDir ..."
Expand-Archive -Path $zip -DestinationPath $tmp -Force
# The packer stages every archive under a top-level Vodou\ directory
# (build-release-multi-arch-prebuilt.sh:1584-1586).
$bundle = Join-Path $tmp "Vodou"
if (-not (Test-Path $bundle)) {
    Write-Host "Bundle did not contain the expected Vodou\ directory." -ForegroundColor Red
    exit 1
}
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item -Path (Join-Path $bundle "*") -Destination $InstallDir -Recurse -Force

if (-not (Test-Path (Join-Path $InstallDir "vodou-core.exe"))) {
    Write-Host "Engine missing after extract." -ForegroundColor Red; exit 1
}
# The bundle must carry its own Node - this is the check that would have caught
# the tree+engine install shipping a Node-less gateway.
if (-not (Test-Path (Join-Path $InstallDir ".node\node.exe"))) {
    Write-Host "Bundle has no .node\node.exe - the gateway cannot start." -ForegroundColor Red
    Write-Host "  This is a packaging fault, not something you did. Report it at https://github.com/$OsRepo/issues"
    exit 1
}
if (-not (Select-String -Path (Join-Path $InstallDir "install.bat") -Pattern "service install" -Quiet)) {
    Write-Host "install.bat in this bundle does not register the service - refusing to run it." -ForegroundColor Red
    exit 1
}

# Run the Windows setup: writes .env, registers the scheduled task, starts services.
Write-Host "Running installer ..."
Push-Location $InstallDir
cmd /c install.bat
Pop-Location

Remove-Item -Recurse -Force $tmp
Write-Host ""
Write-Host "Vodou v$Version installed to $InstallDir" -ForegroundColor Green
Write-Host "Note: the engine is unsigned — SmartScreen may warn on first run."
