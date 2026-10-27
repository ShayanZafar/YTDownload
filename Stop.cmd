@echo off
rem Stops the YouTube Audio Extractor (scripts\windows\stop.cmd).
rem (One line, so this file can be replaced while it runs.)
call "%~dp0scripts\windows\stop.cmd" %* & exit /b
