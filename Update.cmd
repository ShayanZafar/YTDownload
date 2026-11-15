@echo off
rem Updates the YouTube Audio Extractor to the newest build (scripts\windows\update.cmd).
rem (One line, so this file can be replaced while it runs.)
call "%~dp0scripts\windows\update.cmd" %* & exit /b
