@echo off
setlocal
REM ============================================================
REM  Unify: instalador de la extension para Chrome/Edge (Windows)
REM  Es texto plano: abrilo con el Bloc de notas si queres ver
REM  exactamente que hace antes de ejecutarlo.
REM ============================================================

set "BASE=https://www.unify-meet.com"
if defined UNIFY_BASE set "BASE=%UNIFY_BASE%"
set "DEST=%LOCALAPPDATA%\Unify\extension"

echo.
echo  === Unify: instalador de la extension ===
echo.
echo  Descargando la ultima version...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Invoke-WebRequest -UseBasicParsing ('%BASE%/unify-extension.zip') -OutFile ($env:TEMP+'\unify-extension.zip'); Expand-Archive -Force ($env:TEMP+'\unify-extension.zip') '%DEST%'; Set-Clipboard -Value '%DEST%'"
if errorlevel 1 goto :error

echo  Lista: quedo instalada en:
echo    %DEST%
echo  (la ruta ya esta COPIADA al portapapeles)
echo.

REM Abrir la pagina de extensiones del navegador que haya.
set "NAV=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%NAV%" set "NAV=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%NAV%" set "NAV=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if exist "%NAV%" (
  start "" "%NAV%" chrome://extensions
) else (
  start "" msedge edge://extensions
)

echo  Ultimos DOS pasos, en la pestana que se acaba de abrir:
echo    1. Prende el "Modo de desarrollador" (arriba a la derecha)
echo    2. Toca "Cargar descomprimida" y pega la ruta con Ctrl+V
echo.
echo  Despues entra a cualquier reunion: Unify aparece solo.
echo.
pause
exit /b 0

:error
echo.
echo  Fallo la descarga. Proba de nuevo, o baja el ZIP a mano desde:
echo    %BASE%/instalar
echo.
pause
exit /b 1
