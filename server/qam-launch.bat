@echo off
rem QAM 起動（このファイルのショートカットをデスクトップに置く）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0qam-launch.ps1" %*
