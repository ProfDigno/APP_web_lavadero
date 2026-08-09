@echo off
setlocal
title Sistema Lavadero

set "APP_DIR=%~dp0"
set "APP_URL=http://localhost:3010"

cd /d "%APP_DIR%"

echo ========================================
echo        Sistema Lavadero
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo No se encontro Node.js instalado.
  echo Instale Node.js y vuelva a ejecutar este archivo.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo No se encontro npm instalado.
  echo Revise la instalacion de Node.js y vuelva a intentar.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Preparando el sistema por primera vez...
  call npm install
  if errorlevel 1 (
    echo.
    echo No se pudieron instalar las dependencias.
    pause
    exit /b 1
  )
  echo.
)

echo Iniciando en %APP_URL%
echo Esta ventana debe quedar abierta mientras usa el sistema.
echo Para cerrar el sistema, cierre esta ventana.
echo.

start "" powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 3; Start-Process '%APP_URL%'"

call npm start

echo.
echo El sistema se detuvo.
pause
