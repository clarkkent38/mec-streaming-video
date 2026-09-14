@echo off
title MEC Edge Node Agent Launcher
color 0A

echo ==============================================================================
echo                MEC Edge Node Agent - Quick Windows Launcher
echo ==============================================================================
echo.

:: Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js from https://nodejs.org/ (LTS version)
    echo.
    pause
    exit /b 1
)

:: Prompt for configuration (with defaults)
set /p ORCH_INPUT="Enter Orchestrator URL [default: https://orchestrator-xfwd.onrender.com]: "
if "%ORCH_INPUT%"=="" (
    set "ORCHESTRATOR_URL=https://orchestrator-xfwd.onrender.com"
) else (
    set "ORCHESTRATOR_URL=%ORCH_INPUT%"
)

set /p LABEL_INPUT="Enter Node Label/Name [default: Windows-Edge-PC]: "
if "%LABEL_INPUT%"=="" (
    set "NODE_LABEL=Windows-Edge-PC"
) else (
    set "NODE_LABEL=%LABEL_INPUT%"
)

set /p PORT_INPUT="Enter Port to run on [default: 5001]: "
if "%PORT_INPUT%"=="" (
    set "PORT=5001"
) else (
    set "PORT=%PORT_INPUT%"
)

echo.
echo Installing dependencies if needed...
if not exist node_modules (
    call npm install --production
)

echo.
echo Starting Edge Agent...
echo Orchestrator : %ORCHESTRATOR_URL%
echo Node Label   : %NODE_LABEL%
echo Port         : %PORT%
echo.

node server.js
pause
