@echo off
setlocal
cd /d "%~dp0"

echo.
echo ==========================================
echo   MEMECOINER - PAPER TRADING LAB
echo ==========================================
echo.

if not exist ".env" (
  echo No .env file found.
  echo Creating one from .env.example...
  copy /Y ".env.example" ".env" >nul
  echo.
  echo Open .env and add your PUMPPORTAL_API_KEY, then run this file again.
  notepad ".env"
  pause
  exit /b 1
)

echo Checking dependencies...
call npm install --silent
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)

start "" cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:3210"

echo Starting live observer and dashboard...
echo Close this window or press Ctrl+C to stop.
echo.
call npm run app

echo.
echo Memecoiner stopped.
pause
