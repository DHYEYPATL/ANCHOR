$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "1. Running Anchor Relay tests (pytest)" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Set-Location "$ScriptDir\anchor\services\relay"
& ".\.venv\Scripts\python.exe" -m pytest -q
if ($LASTEXITCODE -ne 0) { throw "Relay tests failed" }

Write-Host "`n==============================================" -ForegroundColor Cyan
Write-Host "2. Running Anchor Web tests (vitest)" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Set-Location "$ScriptDir\anchor\apps\web"
npm test
if ($LASTEXITCODE -ne 0) { throw "Web tests failed" }

Write-Host "`n==============================================" -ForegroundColor Cyan
Write-Host "3. Building Anchor Web app" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { throw "Web build failed" }

Write-Host "`n==============================================" -ForegroundColor Green
Write-Host "SUCCESS: All tests and builds passed!" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Green
