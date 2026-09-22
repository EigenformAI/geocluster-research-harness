@echo off
setlocal enabledelayedexpansion

REM ============================================================================
REM Geocluster Research Harness -- single-run launcher (Windows)
REM
REM For someone who doesn't want to know about Docker: double-click this from
REM inside the cloned repo and it builds (first run only), starts, waits
REM until ready, and opens the IDE in your browser.
REM ============================================================================

cd /d "%~dp0"

if not exist docker-compose.yml (
    echo docker-compose.yml not found here - run this script from inside the cloned geocluster-research-harness folder.
    goto :fail
)

where docker >nul 2>nul
if errorlevel 1 (
    echo Docker isn't installed. Install Docker Desktop first: https://docs.docker.com/get-docker/
    echo Then run this script again.
    goto :fail
)

docker info >nul 2>nul
if errorlevel 1 (
    echo Docker is installed but not running. Open Docker Desktop, wait for it to finish starting, then run this script again.
    goto :fail
)
echo [OK] Docker is installed and running

docker compose version >nul 2>nul
if errorlevel 1 (
    echo 'docker compose' isn't available - update Docker Desktop to a recent version.
    goto :fail
)

if exist .git (
    where git >nul 2>nul
    if errorlevel 1 (
        echo [WARN] git isn't installed - can't sync the MCP server submodule automatically.
        echo         Install git, then run: git submodule update --init
    ) else (
        echo ==^> Syncing the MCP server ^(git submodule^)...
        git submodule update --init
        if errorlevel 1 (
            echo Failed to sync the git submodule. Check your network connection and try again.
            goto :fail
        )
        echo [OK] MCP server in sync
    )
) else (
    echo [WARN] This doesn't look like a git checkout - skipping submodule setup.
    echo         If mcp-server is empty, the build will fail. Re-clone with:
    echo         git clone --recurse-submodules https://github.com/EigenformAI/geocluster-research-harness.git
)

if not exist copy-your-files-here mkdir copy-your-files-here
echo [OK] copy-your-files-here\ ready - that's where your project files go

echo ==^> Building and starting the harness ^(first run takes a few minutes^)...
docker compose up --build -d
if errorlevel 1 (
    echo Build failed. See the output above for details.
    goto :fail
)

echo ==^> Waiting for the IDE to become ready...
set /a elapsed=0
set /a timeout_s=600

:waitloop
set "health="
for /f "delims=" %%h in ('docker inspect -f "{{.State.Health.Status}}" geocluster-research-harness 2^>nul') do set "health=%%h"
if "!health!"=="healthy" goto :healthy
if !elapsed! geq !timeout_s! (
    echo Timed out waiting for the harness to become healthy. Run "docker compose logs" to see what happened.
    goto :fail
)
timeout /t 3 /nobreak >nul
set /a elapsed+=3
goto :waitloop

:healthy
echo [OK] Harness is up and healthy

set "hostaddr="
for /f "delims=" %%p in ('docker compose port harness 3000 2^>nul') do set "hostaddr=%%p"
if defined hostaddr (
    set "url=http://!hostaddr!"
) else (
    echo [WARN] Couldn't read the published port from docker compose - falling back to localhost:3000.
    set "url=http://localhost:3000"
)

start "" "!url!"

echo.
echo [OK] Ready! Opening !url!
echo    Your projects live in: %cd%\copy-your-files-here\
echo    To stop it later: stop.bat
echo.
pause
exit /b 0

:fail
echo.
echo Something went wrong - see the message above.
pause
exit /b 1
