@echo off
setlocal
title FocusDesk
where node >nul 2>&1
if errorlevel 1 (
  echo FocusDesk needs Node.js 24 or newer.
  echo Install the Windows LTS runtime from https://nodejs.org/ then open this file again.
  pause
  exit /b 1
)
node "%~dp0scripts\start-focusdesk.mjs" --open %*
if errorlevel 1 (
  echo.
  echo FocusDesk could not start. Read the message above, then try again.
  pause
  exit /b 1
)
