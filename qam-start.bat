@echo off
rem QAM launcher (ASCII only; Japanese lives in qam-start.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0qam-start.ps1"
echo exit code: %ERRORLEVEL%
pause
