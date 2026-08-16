@echo off
REM ============================================================================
REM qam-launch.bat - one-click: start relay + open the SharePoint site
REM ----------------------------------------------------------------------------
REM Keep this file ASCII-only (cmd.exe parses .bat as ANSI / CP932). All
REM Japanese messages live in qam-launch.ps1.
REM The final "pause" keeps this window open so messages / errors stay readable.
REM ============================================================================
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0qam-launch.ps1" %*
echo.
echo [qam-launch] done (exit code %ERRORLEVEL%). Press any key to close.
pause >nul
