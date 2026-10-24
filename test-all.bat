@echo off
echo ==============================================
echo 1. Running Anchor Relay tests (pytest)
echo ==============================================
cd /d "%~dp0anchor\services\relay"
call .\.venv\Scripts\python.exe -m pytest -q
if %errorlevel% neq 0 (
    echo [ERROR] Relay tests failed!
    exit /b %errorlevel%
)

echo.
echo ==============================================
echo 2. Running Anchor Web tests (vitest)
echo ==============================================
cd /d "%~dp0anchor\apps\web"
call npm test
if %errorlevel% neq 0 (
    echo [ERROR] Web tests failed!
    exit /b %errorlevel%
)

echo.
echo ==============================================
echo 3. Building Anchor Web app
echo ==============================================
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] Web build failed!
    exit /b %errorlevel%
)

echo.
echo ==============================================
echo SUCCESS: All tests and builds passed!
echo ==============================================
