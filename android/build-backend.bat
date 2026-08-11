@echo off
REM ---------------------------------------------------------------------
REM Builds the Go backend into android\app\libs\trncontrol.aar.
REM
REM Run from anywhere; paths are resolved relative to this script.
REM Prerequisites are listed in android\README.md -- in short: Go, the
REM Android NDK, and gomobile on PATH.
REM ---------------------------------------------------------------------
setlocal

set SCRIPT_DIR=%~dp0
set BACKEND_DIR=%SCRIPT_DIR%..\backend
set OUT=%SCRIPT_DIR%app\libs\trncontrol.aar

where gomobile >nul 2>nul
if errorlevel 1 (
    echo ERROR: gomobile is not on PATH.
    echo   go install golang.org/x/mobile/cmd/gomobile@latest
    echo   gomobile init
    exit /b 1
)

if "%ANDROID_NDK_HOME%"=="" (
    if "%ANDROID_NDK_ROOT%"=="" (
        echo ERROR: set ANDROID_NDK_HOME to your NDK, e.g.
        echo   set ANDROID_NDK_HOME=%%LOCALAPPDATA%%\Android\Sdk\ndk\27.0.12077973
        exit /b 1
    )
)

if not exist "%SCRIPT_DIR%app\libs" mkdir "%SCRIPT_DIR%app\libs"

pushd "%BACKEND_DIR%"

echo Building trncontrol.aar (android/arm64, android/arm)...
gomobile bind ^
    -target=android/arm64,android/arm ^
    -androidapi 26 ^
    -javapkg=dev.trncontrol.backend ^
    -trimpath ^
    -ldflags "-s -w" ^
    -o "%OUT%" ^
    ./mobile

if errorlevel 1 (
    popd
    echo.
    echo Build failed. If the error mentions golang.org/x/mobile, run:
    echo   go get golang.org/x/mobile/bind
    exit /b 1
)

popd
echo.
echo Wrote %OUT%
endlocal
