@echo off
cd /d "%~dp0"
if not exist node_modules (
  npm install
)
if "%PORT%"=="" set PORT=8080
if "%WORKER_TOKEN%"=="" set WORKER_TOKEN=test123
echo Starting ChainAuth worker on http://127.0.0.1:%PORT%
npm run start:local
