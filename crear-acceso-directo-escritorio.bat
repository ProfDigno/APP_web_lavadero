@echo off
setlocal
title Crear acceso directo - Sistema Lavadero

set "APP_DIR=%~dp0"
set "TARGET=%APP_DIR%iniciar-lavadero.bat"
set "SHORTCUT=%USERPROFILE%\Desktop\Sistema Lavadero.lnk"

if not exist "%TARGET%" (
  echo No se encontro iniciar-lavadero.bat.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$shell = New-Object -ComObject WScript.Shell; $shortcut = $shell.CreateShortcut('%SHORTCUT%'); $shortcut.TargetPath = '%TARGET%'; $shortcut.WorkingDirectory = '%APP_DIR%'; $shortcut.IconLocation = 'shell32.dll,220'; $shortcut.Save()"

if errorlevel 1 (
  echo No se pudo crear el acceso directo.
  echo.
  pause
  exit /b 1
)

echo Acceso directo creado en el Escritorio:
echo %SHORTCUT%
echo.
pause
