@echo off
REM sync.bat — Push latest Drawings/ to GitHub Pages.
REM Auto-triggered by CC_DrawingPDFExport / CC_ProjectBOM / CC_DrawingPDFExport_Batch.
REM Can also be double-clicked manually.

cd /d "%~dp0"

REM Stage everything under Drawings/ (PDFs, manifest, projects/*.json)
git add Drawings/ >nul 2>&1

REM Skip if nothing to commit
git diff --cached --quiet
if %errorlevel% equ 0 (
  REM Nothing new — exit cleanly without noise
  exit /b 0
)

REM Timestamp commit
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value 2^>nul') do set DT=%%I
set TS=%DT:~0,4%-%DT:~4,2%-%DT:~6,2% %DT:~8,2%:%DT:~10,2%

git commit -m "Update drawings %TS%" >nul 2>&1
git push >nul 2>&1
exit /b 0
