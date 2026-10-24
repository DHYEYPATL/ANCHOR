$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "Starting Anchor Relay & Web..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$ScriptDir\anchor\services\relay'; `$env:ANCHOR_RELAY_DB='./data/relay.sqlite3'; `$env:ANCHOR_ALLOWED_ORIGINS='http://localhost:5173,http://127.0.0.1:5173'; & '.\.venv\Scripts\python.exe' -m uvicorn anchor_relay.app:app --host 127.0.0.1 --port 8080"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$ScriptDir\anchor\apps\web'; npm run dev"

Write-Host "Services launched in separate PowerShell windows!" -ForegroundColor Green
Write-Host "- Web App:  http://localhost:5173" -ForegroundColor Yellow
Write-Host "- Relay API: http://127.0.0.1:8080" -ForegroundColor Yellow
