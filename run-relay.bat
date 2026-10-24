@echo off
cd /d "%~dp0anchor\services\relay"
set ANCHOR_RELAY_DB=./data/relay.sqlite3
set ANCHOR_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
echo Starting Anchor Encrypted Relay on http://127.0.0.1:8080...
.\.venv\Scripts\python.exe -m uvicorn anchor_relay.app:app --host 127.0.0.1 --port 8080
