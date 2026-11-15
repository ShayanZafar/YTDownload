@echo off
rem Gets the newest yt-dlp, the part of the app that talks to YouTube.
rem Run it when YouTube downloads stop working: YouTube changes things now and then.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app.ps1" update-yt-dlp %*
