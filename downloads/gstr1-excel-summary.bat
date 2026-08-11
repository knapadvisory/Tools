@echo off
setlocal EnableDelayedExpansion
title GSTR-1 to Excel summary
rem Double-click this file to start the GSTR-1 to Excel tool.
rem It needs Node.js (free, one-time install from https://nodejs.org).
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed on this computer.
  echo Please install the LTS version from  https://nodejs.org  and run this file again.
  echo.
  pause
  exit /b 1
)

set "SCRIPT=gstr1-excel-summary.mjs"

if not exist "!SCRIPT!" (
  rem The download is sometimes saved under a slightly different name - use any .mjs here.
  for %%F in (*.mjs) do set "SCRIPT=%%F"
)

if not exist "!SCRIPT!" (
  rem Some browsers add .txt to the downloaded name - fix that automatically.
  for %%F in (*.mjs.txt) do (
    ren "%%F" "gstr1-excel-summary.mjs"
    set "SCRIPT=gstr1-excel-summary.mjs"
  )
)

if not exist "!SCRIPT!" (
  echo.
  echo Could not find  gstr1-excel-summary.mjs  in this folder:
  echo   %CD%
  echo.
  echo Files currently in this folder:
  dir /b
  echo.
  echo Please move the downloaded  gstr1-excel-summary.mjs  file into this folder
  echo ^(the same folder as this .bat file^) and then double-click this file again.
  echo It is probably still in your Downloads folder.
  echo.
  pause
  exit /b 1
)

echo Starting GSTR-1 to Excel summary ... the browser will open by itself.
echo Keep this window open while using the tool.
node "!SCRIPT!"
pause
