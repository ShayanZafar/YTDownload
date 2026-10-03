@echo off
rem Starts the YouTube Audio Extractor and opens it in your browser.
rem Keep this window open while you use the app: closing it stops the app (so does stop.cmd).
rem   start.cmd -NoBrowser    starts it without opening the browser
setlocal
title YouTube Audio Extractor
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app.ps1" start %*
rem 2: it's running already (the page was opened); 1: a problem, explained above.
if errorlevel 2 exit /b 0
if errorlevel 1 (
  pause
  exit /b 1
)
cd /d "%~dp0..\.."
set NODE_ENV=
set YOUTUBE_DL_SKIP_PYTHON_CHECK=1
rem A copy of the source code runs the development server; a ready-to-run build
rem (installed from the install branch) runs the built app.
if exist "server\index.ts" (
  call npm.cmd run dev
) else (
  call npm.cmd start
)
if errorlevel 1 pause
