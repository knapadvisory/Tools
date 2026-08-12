@echo off
title KNAP Tally Connector - uninstall
rem Removes the KNAP Tally Connector: stops it, removes the auto-start entry.
rem The data file (mappings + posted register) is kept unless you delete the
rem folder yourself.

set "DIR=%LOCALAPPDATA%\KnapTallyConnector"

reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v KnapTallyConnector /f >nul 2>nul

rem Stop the running connector (the node process started from our folder).
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*knap-tally-connector*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul

echo.
echo The connector has been stopped and removed from Windows startup.
echo Its folder (with the saved mappings/register data) is still at:
echo   %DIR%
echo Delete that folder too if you want a complete removal.
echo.
pause
