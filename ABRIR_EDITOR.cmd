@echo off
cd /d "%~dp0"
python -c "import fitz" >nul 2>&1
if errorlevel 1 (
  echo Falta PyMuPDF. Instale la dependencia con:
  echo python -m pip install -r requirements.txt
  pause
  exit /b 1
)
python server.py
if errorlevel 1 pause
