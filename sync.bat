@echo off
REM sync.bat — Push latest Drawings/ to GitHub Pages.
REM Auto-triggered by CC_SimplePDF / CC_DrawingPDF / CC_Assembly / CC_DrawingPDF_Batch.
REM Can also be double-clicked manually.

cd /d "%~dp0"

REM Paint bend-sequence tables onto any PDF whose bend_sim changed
REM (freshness-aware: no-op for non-bend parts / already-stamped PDFs; offline-safe).
node scripts\stamp_bends.mjs >nul 2>&1

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

REM Rebase onto latest origin so a parallel session's push doesn't cause a
REM silent non-fast-forward reject (two Claude sessions share this repo).
git pull --rebase --autostash >nul 2>&1
git push >nul 2>&1
exit /b 0
