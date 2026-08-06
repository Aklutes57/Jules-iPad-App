@echo off
REM ===================================================================
REM  Jules for iPad - start the server on this Windows PC
REM
REM  Double-click this file. It starts a small web server in this folder
REM  and prints the address to type into Safari on your iPad.
REM
REM  Keep this window open. Closing it stops the server.
REM  Full instructions and troubleshooting: SETUP-WINDOWS.md
REM ===================================================================

setlocal enabledelayedexpansion
title Jules for iPad - server

REM Work from the folder this file lives in, wherever that is.
cd /d "%~dp0"

set PORT=8080

echo.
echo  ==============================================
echo   Jules for iPad
echo  ==============================================
echo.

REM --- Find Python -------------------------------------------------
REM  "py" is the launcher that ships with python.org installs; "python"
REM  is the fallback. Windows also ships a fake python.exe that opens
REM  the Microsoft Store, so verify the command actually runs.

set PY=
py -3 --version >nul 2>&1
if %errorlevel%==0 (
    set PY=py -3
) else (
    python --version >nul 2>&1
    if !errorlevel!==0 set PY=python
)

if "%PY%"=="" (
    echo  Python is not installed, or Windows cannot find it.
    echo.
    echo  To fix this:
    echo    1. Go to  https://www.python.org/downloads/
    echo    2. Download Python for Windows and run the installer.
    echo    3. IMPORTANT: on the first screen of the installer, tick
    echo       "Add python.exe to PATH" before clicking Install.
    echo       This is the step almost everyone misses.
    echo    4. Restart this window and double-click this file again.
    echo.
    pause
    exit /b 1
)

REM --- Find this PC's address on the local network -----------------
REM  Prefer the address that actually routes to the internet: a PC can
REM  have several (Wi-Fi, Ethernet, VirtualBox, WSL, VPN) and picking
REM  the wrong one gives the iPad an address it cannot reach.

REM  In "route print 0.0.0.0" the default-route line reads:
REM    0.0.0.0    0.0.0.0    <gateway>    <this PC's address>    <metric>
REM  so the 4th token is the address the iPad should be given.
set IP=
for /f "tokens=4" %%A in ('route print 0.0.0.0 ^| findstr /r /c:"^ *0\.0\.0\.0 "') do (
    if "!IP!"=="" set IP=%%A
)

REM Fall back to the first IPv4 address ipconfig reports.
if "%IP%"=="" (
    for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
        if "!IP!"=="" (
            set IP=%%A
            set IP=!IP: =!
        )
    )
)

echo  Serving this folder:
echo    %cd%
echo.

if "%IP%"=="" (
    echo  Could not work out this PC's network address automatically.
    echo.
    echo  Find it by hand: open a new Command Prompt, type  ipconfig
    echo  and press Enter. Look for "IPv4 Address" under your Wi-Fi
    echo  adapter - something like 192.168.1.42
    echo.
    echo  Then on the iPad, open Safari and go to:
    echo    http://THAT-ADDRESS:%PORT%
) else (
    echo  ----------------------------------------------------
    echo   On your iPad, open Safari and go to:
    echo.
    echo        http://%IP%:%PORT%
    echo.
    echo   The iPad must be on the same Wi-Fi as this PC.
    echo  ----------------------------------------------------
)

echo.
echo  The first time you run this, Windows may ask whether to allow
echo  Python through the firewall. Tick "Private networks" and allow
echo  it, or the iPad will not be able to connect.
echo.
echo  Keep this window open while you use the app.
echo  Press Ctrl+C, or just close this window, to stop the server.
echo.

%PY% -m http.server %PORT%

REM  http.server only returns here if it stopped or failed to start.
echo.
echo  The server has stopped.
echo.
echo  If it exited immediately, port %PORT% may already be in use by
echo  something else. See the troubleshooting section of
echo  SETUP-WINDOWS.md for how to use a different port.
echo.
pause
