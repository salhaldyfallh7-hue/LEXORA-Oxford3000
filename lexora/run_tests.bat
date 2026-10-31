@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required only for the project tests. Install Node.js then retry.
  pause
  exit /b 1
)
node --check js\app.js
if errorlevel 1 goto :failed
node --check js\core.js
if errorlevel 1 goto :failed
node --check js\db.js
if errorlevel 1 goto :failed
node --check sw.js
if errorlevel 1 goto :failed
node tests\core.test.mjs
if errorlevel 1 goto :failed
node tests\db.test.mjs
if errorlevel 1 goto :failed
echo.
echo All automated project tests passed.
pause
exit /b 0
:failed
echo.
echo A test failed. Read the error above.
pause
exit /b 1
