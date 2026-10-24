@echo off
cd /d "%~dp0anchor\apps\web"
echo Starting Anchor Web Client on http://localhost:5173...
call npm run dev
