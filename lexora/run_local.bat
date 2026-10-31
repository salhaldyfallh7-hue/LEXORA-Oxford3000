@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Install Python 3 and try again.
  pause
  exit /b 1
)
python -c "import json,sys; d=json.load(open('data/oxford3000.json',encoding='utf-8')); sys.exit(0 if isinstance(d.get('words'),list) and len(d['words'])>0 else 1)"
if errorlevel 1 (
  echo No vocabulary records found in data\oxford3000.json.
  echo Add a dataset you are authorized to use, then validate it with:
  echo python scripts\validate_database.py --file data\oxford3000.json
  pause
  exit /b 1
)
start "LEXORA local server" /min cmd /c "python -m http.server 8000"
timeout /t 2 /nobreak >nul
start "" http://localhost:8000/index.html
