# Vodou Installer — PowerShell entry point (Windows)
# Usage: irm https://raw.githubusercontent.com/VodouAI/OS/main/install-vodou.ps1 | iex
#
# Options (environment variables):
#   $env:VODOU_INSTALL_DIR = "C:\Vodou"   # Custom install location (default: %USERPROFILE%\Vodou)
#   $env:VODOU_VERSION     = "0.6.14"     # Specific version (default: latest)

$ErrorActionPreference = 'Stop'
$Repo = 'VodouAI/OS'
$Version = if ($env:VODOU_VERSION) { $env:VODOU_VERSION.TrimStart('v') } else { 'latest' }
$InstallDir = if ($env:VODOU_INSTALL_DIR) { $env:VODOU_INSTALL_DIR } else { Join-Path $env:USERPROFILE 'Vodou' }

Write-Host ""
Write-Host "  +----------------------------------+"
Write-Host "  |         Vodou Installer          |"
Write-Host "  |   AI that learns YOU - locally   |"
Write-Host "  +----------------------------------+"
Write-Host ""

# Windows x64 only for now (the release ships win-x64; Win-ARM64 runs it under emulation).
$Arch = $env:PROCESSOR_ARCHITECTURE
if ($Arch -ne 'AMD64' -and $Arch -ne 'ARM64') {
  Write-Host "Unsupported architecture: $Arch" -ForegroundColor Red; exit 1
}
Write-Host "System: Windows (x64 build)"
Write-Host "Install to: $InstallDir"
Write-Host ""

if (Test-Path (Join-Path $InstallDir 'vodou-core.exe')) {
  Write-Host "Vodou is already installed at $InstallDir" -ForegroundColor Yellow
  Write-Host "To reinstall, remove it first:  Remove-Item -Recurse -Force '$InstallDir'"
  exit 1
}

# Resolve latest version
if ($Version -eq 'latest') {
  Write-Host "Resolving latest release version..."
  try {
    $rel = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'vodou-installer' }
    $Version = $rel.tag_name.TrimStart('v')
  } catch {
    Write-Host "Failed to resolve latest release. Set one manually: `$env:VODOU_VERSION='0.6.14'" -ForegroundColor Red
    exit 1
  }
}

$Asset = "Vodou-v$Version-prebuilt-win-x64.zip"
$Url = "https://github.com/$Repo/releases/download/v$Version/$Asset"
Write-Host "Downloading Vodou v$Version for Windows..."

$Temp = Join-Path $env:TEMP ("vodou-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Temp -Force | Out-Null
$Zip = Join-Path $Temp 'vodou.zip'
try {
  Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing
} catch {
  Write-Host ""
  Write-Host "Download failed: $Url" -ForegroundColor Red
  Write-Host "Version v$Version may not exist, or the Windows asset isn't attached."
  Write-Host "See: https://github.com/$Repo/releases"
  exit 1
}
$SizeMB = [math]::Round((Get-Item $Zip).Length / 1MB, 0)
Write-Host "Downloaded: ${SizeMB}MB"

Write-Host "Extracting..."
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
# The zip extracts to a top-level "Vodou/" folder — expand then flatten it in.
Expand-Archive -Path $Zip -DestinationPath $Temp -Force
$Inner = Join-Path $Temp 'Vodou'
if (-not (Test-Path (Join-Path $Inner 'vodou-core.exe'))) {
  Write-Host "Extraction failed - vodou-core.exe not found in the archive." -ForegroundColor Red
  exit 1
}
Copy-Item -Path (Join-Path $Inner '*') -Destination $InstallDir -Recurse -Force
Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
Write-Host "Extracted to: $InstallDir"

Write-Host ""
Write-Host "Running installer..."
Push-Location $InstallDir
$env:VODOU_PROJECT_PATH = $InstallDir
& (Join-Path $InstallDir 'install.bat')
Pop-Location

Write-Host ""
Write-Host "======================================"
Write-Host "  Vodou v$Version installed!"
Write-Host "======================================"
Write-Host ""
Write-Host "Web UI + onboarding: http://localhost:8765"
Write-Host ""
Write-Host "Manage Vodou (from $InstallDir):"
Write-Host "  vodou-core.exe service start | stop | status"
Write-Host "  do.cmd `"summarize my day`""
Write-Host ""
Write-Host "Note: this is an unsigned beta - Windows SmartScreen may warn on first run."
