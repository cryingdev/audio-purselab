@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Install it from https://nodejs.org
  pause
  exit /b 1
)

rem package-lock.json 의 해시를 마지막으로 설치한 때의 값과 비교한다.
rem 의존성이 바뀐 채 pull 했을 때 npm install 을 건너뛰지 않도록 하기 위해서다.
set "NEWHASH="
for /f "skip=1 tokens=*" %%h in ('certutil -hashfile package-lock.json SHA256') do (
  if not defined NEWHASH set "NEWHASH=%%h"
)
set "OLDHASH="
if exist node_modules\.lockhash set /p OLDHASH=<node_modules\.lockhash

set "NEED_INSTALL="
if not exist node_modules set "NEED_INSTALL=1"
if not "%NEWHASH%"=="%OLDHASH%" set "NEED_INSTALL=1"

if defined NEED_INSTALL (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
  >node_modules\.lockhash echo %NEWHASH%
)

echo Starting dev server...
call npm run dev -- --open
pause
