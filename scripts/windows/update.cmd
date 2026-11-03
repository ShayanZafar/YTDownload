@echo off
rem Updates the YouTube Audio Extractor to its newest version: the newest build in a
rem copy installed from the install branch, the newest code in a copy of the source.
rem A running app is stopped first and started again afterwards.
rem (One line, so this file can be replaced while the update runs.)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app.ps1" update %* & exit /b
