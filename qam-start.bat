@echo off
rem QAM launcher (ASCII only; Japanese lives in qam-start.ps1).
rem pushd maps a temp drive letter for UNC paths so cmd does not warn
rem "CMD does not support UNC paths as current directories" when launched from a share.
pushd "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0qam-start.ps1"
echo exit code: %ERRORLEVEL%
popd
pause
