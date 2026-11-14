@echo off
rem Stops the YouTube Audio Extractor, however it was started.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app.ps1" stop %*
