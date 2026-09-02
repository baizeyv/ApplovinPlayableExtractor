@echo off
setlocal

cd /d "%~dp0"
title Build Playable Media Extractor

echo.
echo ========================================
echo   Playable Media Extractor Build Tool
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
	echo [ERROR] Node.js not found.
	echo Please install Node.js 18 or newer, then run this script again.
	echo.
	pause
	exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
	echo [ERROR] npm not found.
	echo Please make sure Node.js and npm are installed correctly.
	echo.
	pause
	exit /b 1
)

if not exist node_modules\.bin\electron-builder.cmd (
	echo [INFO] Installing dependencies...
	call npm install
	if errorlevel 1 (
		echo.
		echo [ERROR] npm install failed.
		pause
		exit /b 1
	)
) else (
	echo [INFO] electron-builder already present. Skipping npm install.
)

echo.
echo [INFO] Building portable Windows package...
call node_modules\.bin\electron-builder.cmd --win portable
if errorlevel 1 (
	echo.
	echo [ERROR] Build failed.
	pause
	exit /b 1
)

if exist dist (
	echo.
	echo [OK] Build complete.
	echo Output folder: %CD%\dist
	start "" "%CD%\dist"
) else (
	echo.
	echo [WARN] Build command finished, but dist folder was not found.
)

echo.
pause