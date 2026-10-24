@echo off
echo ==============================================
echo   Starting Anchor Relay + Web Client
echo ==============================================
start "Anchor Relay (FastAPI)" "%~dp0run-relay.bat"
start "Anchor Web (Vite)" "%~dp0run-web.bat"
echo.
echo Both services have been launched in separate windows!
echo - Web Client:  http://localhost:5173
echo - Relay API:   http://127.0.0.1:8080 (Health: http://127.0.0.1:8080/healthz)
echo.
