@echo off
rem Stops starting the YouTube Audio Extractor when you sign in to Windows.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app.ps1" autostart-off %*
