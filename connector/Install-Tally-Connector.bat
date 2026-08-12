@echo off
setlocal EnableDelayedExpansion
title KNAP Tally Connector - installer
rem One-time installer for the KNAP Tally Connector.
rem Downloads the connector, sets it to start with Windows (invisibly),
rem starts it now, and keeps any existing GSTR-2B data (mappings + posted
rem register) from the old standalone poster if found.

set "HUB=https://apps.knapadvisory.com"
set "DIR=%LOCALAPPDATA%\KnapTallyConnector"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed on this computer.
  echo Please install the LTS version from  https://nodejs.org  and run this file again.
  echo.
  pause
  exit /b 1
)

where curl >nul 2>nul
if errorlevel 1 (
  echo.
  echo This installer needs curl.exe ^(built into Windows 10/11^).
  echo.
  pause
  exit /b 1
)

echo.
echo Installing the KNAP Tally Connector to:
echo   %DIR%
echo.
if not exist "%DIR%" mkdir "%DIR%"

rem Stop any already-running connector/engine and their run-loops, so a
rem re-run of this installer always upgrades in place (an old copy would
rem otherwise keep the port and block the new one).
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ($_.CommandLine -like '*knap-tally*' -or $_.CommandLine -like '*run-loop.bat*') -and $_.CommandLine -notlike '*Install-Tally*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul
timeout /t 2 /nobreak >nul

echo Downloading the connector...
curl -fsSL "%HUB%/connector/knap-tally-connector.mjs" -o "%DIR%\knap-tally-connector.mjs"
if errorlevel 1 (
  echo.
  echo Could not download the connector. Check the internet connection and try again.
  echo.
  pause
  exit /b 1
)

echo Downloading the audit engine...
curl -fsSL "%HUB%/connector/knap-tally-audit-engine.mjs" -o "%DIR%\knap-tally-audit-engine.mjs"

rem Keep the old standalone poster's memory if this PC used it (C:\TallyPoster):
rem supplier mappings and the posted-documents register carry over.
if not exist "%DIR%\gstr2b-tally-data.json" (
  if exist "C:\TallyPoster\gstr2b-tally-data.json" (
    copy /y "C:\TallyPoster\gstr2b-tally-data.json" "%DIR%\gstr2b-tally-data.json" >nul
    echo Existing Tally Poster data found and carried over.
  )
)

rem The run-loop: restarts the connector after a self-update (it exits 0).
> "%DIR%\run-loop.bat" (
  echo @echo off
  echo title KNAP Tally Connector
  echo cd /d "%DIR%"
  echo :loop
  echo node knap-tally-connector.mjs
  echo timeout /t 5 /nobreak ^>nul
  echo goto loop
)

rem Invisible launcher so no black window stays on screen.
> "%DIR%\run-invisible.vbs" (
  echo CreateObject^("Wscript.Shell"^).Run "cmd /c ""%DIR%\run-loop.bat""", 0, False
)

rem Start with Windows (per-user, no admin needed).
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v KnapTallyConnector /t REG_SZ /d "wscript.exe \"%DIR%\run-invisible.vbs\"" /f >nul

rem Start it now.
wscript.exe "%DIR%\run-invisible.vbs"

echo.
echo ============================================================
echo  Done. The connector is running and will start with Windows.
echo.
echo  Open the tool:  %HUB%/gstr2b/
echo.
echo  It updates itself automatically. To remove it later, run
echo  Uninstall-Tally-Connector.bat from %HUB%/connector/
echo ============================================================
echo.
pause
