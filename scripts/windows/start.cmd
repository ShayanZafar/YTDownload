@echo off
rem Starts the YouTube Audio Extractor and opens it in your browser.
rem Keep this window open while you use the app: closing it stops the app (so does stop.cmd).
rem   start.cmd -NoBrowser    starts it without opening the browser
rem   start.cmd -Dev          runs a copy of the source code with the development server
setlocal
title YouTube Audio Extractor
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app.ps1" start %*
rem 3: run the development server; 2: it's running already (the page was opened);
rem 1: a problem, explained above; 0: run the built app.
set started=%errorlevel%
if %started%==2 exit /b 0
if %started%==1 (
  pause
  exit /b 1
)
cd /d "%~dp0..\.."
set NODE_ENV=
set YOUTUBE_DL_SKIP_PYTHON_CHECK=1
rem The built app is a ready-to-run build (installed from the install branch), or a
rem copy of the source code's build, which app.ps1 has just made again if its code changed.
if %started%==3 (
  call npm.cmd run dev
) else (
  call npm.cmd start
)
if errorlevel 1 pause
