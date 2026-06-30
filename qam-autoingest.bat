@echo off
rem QAM auto-ingest launcher for Task Scheduler (ASCII only; logic in qam-autoingest.ps1).
rem Schedule this .bat (or call powershell with the .ps1 directly) at the desired ingest time.
pushd "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0qam-autoingest.ps1" %*
popd
