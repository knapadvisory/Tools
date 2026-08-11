@echo off
setlocal EnableDelayedExpansion
title GSTR-2B Tally Poster
rem Double-click this file to start the GSTR-2B - Tally Poster.
rem Keep it in the same folder as gstr2b-tally-poster.mjs (e.g. C:\TallyPoster).
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

set "SCRIPT="
if exist "gstr2b-tally-poster.mjs" set "SCRIPT=gstr2b-tally-poster.mjs"
rem Older installs used this name - keep working with it.
if not defined SCRIPT if exist "gstr2btallyposter.mjs" set "SCRIPT=gstr2btallyposter.mjs"
if not defined SCRIPT for %%F in ("gstr2b*.mjs") do if not defined SCRIPT set "SCRIPT=%%~F"

if not defined SCRIPT (
  rem Some browsers add .txt to the downloaded name - fix that automatically.
  for %%F in ("gstr2b*.mjs.txt") do (
    ren "%%F" "gstr2b-tally-poster.mjs"
    set "SCRIPT=gstr2b-tally-poster.mjs"
  )
)

if not defined SCRIPT (
  echo.
  echo Could not find  gstr2b-tally-poster.mjs  in this folder:
  echo   %CD%
  echo.
  echo Please move the downloaded  gstr2b-tally-poster.mjs  file into this folder
  echo ^(the same folder as this .bat file^) and then double-click this file again.
  echo It is probably still in your Downloads folder.
  echo.
  pause
  exit /b 1
)

echo Starting the GSTR-2B Tally Poster ... the browser will open by itself.
echo Keep this window open while using the tool.
start /min cmd /c "timeout /t 2 >nul & start http://localhost:8787"
node "!SCRIPT!"
pause
