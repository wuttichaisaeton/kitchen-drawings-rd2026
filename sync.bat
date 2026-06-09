@echo off
REM sync.bat — Push latest Drawings/ to GitHub Pages.
REM Auto-triggered by CC_SimplePDF / CC_DrawingPDF / CC_Assembly / CC_DrawingPDF_Batch.
REM Can also be double-clicked manually.

cd /d "%~dp0"

REM Delayed expansion so !PUSHED! / !errorlevel! update inside the retry loop.
setlocal enabledelayedexpansion
set "LOG=%~dp0sync.log"

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
REM wmic is deprecated/removed on current Windows -> use PowerShell Get-Date.
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm'"`) do set "TS=%%I"

echo [%TS%] sync.bat: committing + pushing>>"%LOG%"
git commit -m "Update drawings %TS%" >>"%LOG%" 2>&1

REM Rebase onto latest origin + push, retrying non-fast-forward rejects from
REM out-of-band writers (web PAT uploads, parallel agent / CC_ pushes share
REM this repo). 3 attempts w/ ~2s backoff; all output logged to sync.log
REM (was a silent >nul before -> zero push telemetry).
set PUSHED=0
for /l %%N in (1,1,3) do (
  if "!PUSHED!"=="0" (
    git pull --rebase --autostash >>"%LOG%" 2>&1
    git push >>"%LOG%" 2>&1
    if !errorlevel! equ 0 (
      set PUSHED=1
      echo [%TS%] push OK on attempt %%N>>"%LOG%"
    ) else (
      echo [%TS%] push attempt %%N FAILED, retrying>>"%LOG%"
      ping -n 3 127.0.0.1 >nul
    )
  )
)
if "!PUSHED!"=="0" echo [%TS%] PUSH FAILED after 3 attempts>>"%LOG%"
endlocal
exit /b 0
