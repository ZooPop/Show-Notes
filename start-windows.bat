@echo off
REM Double-click to run Show Notes on Windows.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
REM Install or update dependencies when package.json has changed (e.g. after updating Show Notes).
node -e "const f=require('fs'),l='node_modules/.package-lock.json';process.exit(!f.existsSync(l)||f.statSync('package.json').mtimeMs>f.statSync(l).mtimeMs?1:0)" || call npm install --no-audit --no-fund
REM Audio library copied from a different computer? Reinstall it for this one.
if exist node_modules\audify (
  node -e "require('audify')" >nul 2>nul || (echo Reinstalling the audio library for this computer... & rmdir /s /q node_modules\audify & call npm install --no-audit --no-fund)
)
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node server.js
pause
