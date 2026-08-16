@echo off
rem ============================================================
rem  Dynamic Island - desktop dev launcher (ASCII-only stub)
rem
rem  All real logic lives in scripts/dev.mjs (Node handles UTF-8
rem  natively). This .bat stays pure ASCII on purpose: cmd.exe
rem  mis-decodes UTF-8 batch lines even after "chcp 65001"
rem  (known pitfall - cmd reads batch blocks with the codepage
rem  active when the batch started, so Chinese lines get
rem  corrupted into garbage commands).
rem
rem  The chcp below switches the console to UTF-8 so Node's
rem  Chinese output (and the app's own logs) render correctly.
rem ============================================================
chcp 65001 >nul
title Dynamic Island - Dev Launcher
color 0B
cd /d "%~dp0"
cls
echo.
echo   ==============================================
echo    Dynamic Island  -  Desktop Dev Launcher
echo   ==============================================
echo.
node scripts/dev.mjs
if errorlevel 1 goto :fail
echo.
pause
exit /b 0
:fail
echo.
echo   Build/launch failed - see messages above.
echo.
pause
exit /b 1
