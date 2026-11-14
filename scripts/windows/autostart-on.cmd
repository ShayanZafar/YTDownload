@echo off
rem Starts the YouTube Audio Extractor (minimized, without opening the browser)
rem whenever you sign in to Windows. autostart-off.cmd undoes it.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app.ps1" autostart-on %*
