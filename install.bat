@echo off
REM OI Windows Installation Script
REM Installs OI in the current directory (allows multiple versions)

set INSTALL_DIR=%~dp0
set INSTALL_DIR=%INSTALL_DIR:~0,-1%

echo 🚀 OI Windows Installation
echo ==========================
echo 📁 Installing to current directory: %INSTALL_DIR%
echo.
echo 💡 This allows you to run multiple versions of OI on the same machine!
echo    Each directory can have its own version and database.
echo.

REM Verify we're in the right location
if not exist "vodou-core.exe" (
    echo ⚠️  Warning: vodou-core.exe not found in current directory
    echo    Make sure you've extracted the release archive first
    pause
    exit /b 1
)

echo 📦 Setting up files...

REM Create screenshots directory
echo 📸 Creating screenshots directory...
if not exist "screenshots" (
    mkdir screenshots
    echo    ✅ Created screenshots directory
) else (
    echo    ℹ️  Screenshots directory already exists
)

REM Create .env from .env.example if .env doesn't exist
if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo    Created .env file from .env.example
    )
)

REM Add VODOU_PROJECT_PATH to .env if it doesn't exist
if exist ".env" (
    findstr /C:"VODOU_PROJECT_PATH=" .env >nul 2>&1
    if errorlevel 1 (
        echo. >> .env
        echo # Project root directory (auto-configured during installation) >> .env
        echo VODOU_PROJECT_PATH=%CD% >> .env
        echo    ✅ Added VODOU_PROJECT_PATH to .env: %CD%
    ) else (
        echo    ℹ️  VODOU_PROJECT_PATH already exists in .env
    )
)

REM Initialize database if it doesn't exist
if not exist "vodou-core.db" (
    echo 💾 Database will be created on first run
)

echo.
echo ✅ Installation complete!
echo.
echo 🎯 Next steps:
echo 1. Run from this directory: .\oi.bat "cpu memory disk"
echo 2. Or add this directory to your PATH to use globally
echo 3. Start services: .\start-vodou-services.sh
echo.
echo 📚 Documentation: %INSTALL_DIR%\docs\
echo ⚙️ Configuration: %INSTALL_DIR%\.env
echo 💾 Database: %INSTALL_DIR%\vodou-core.db
echo.
echo 🌐 Optional: Install Browser Extension
echo    To use browser automation features (screenshots, console logs, etc.),
echo    install the Chrome extension:
echo    See: %INSTALL_DIR%\docs\browser-extension-installation.md
echo    Or: MCP-servers\browser-tools-mcp\chrome-extension\
echo.
echo 💡 Tip: To install multiple versions, extract each release to a different directory!
pause
