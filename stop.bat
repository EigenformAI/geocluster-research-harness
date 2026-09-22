@echo off
setlocal enabledelayedexpansion

REM ============================================================================
REM Geocluster Research Harness -- single-run stopper (Windows)
REM
REM Counterpart to run.bat: stops and removes the container. The built image
REM is kept, so the next run.bat starts fast without rebuilding.
REM ============================================================================

cd /d "%~dp0"

if not exist docker-compose.yml (
    echo docker-compose.yml not found here - run this script from inside the cloned geocluster-research-harness folder.
    goto :fail
)

docker info >nul 2>nul
if errorlevel 1 (
    echo Docker isn't running, so there's nothing to stop.
    goto :fail
)

set "running="
for /f "delims=" %%c in ('docker compose ps -q 2^>nul') do set "running=1"
if not defined running (
    echo [OK] Nothing running - already stopped.
    goto :end
)

echo ==^> Stopping the harness...
docker compose down
if errorlevel 1 (
    echo Failed to stop the harness. See the output above.
    goto :fail
)
echo [OK] Stopped. Your projects are untouched in copy-your-files-here\.
echo    To start it again: run.bat

:end
pause
exit /b 0

:fail
echo.
echo Something went wrong - see the message above.
pause
exit /b 1
