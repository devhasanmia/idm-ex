@echo off
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
echo [IDM-RS] Building Turbo Download Manager in Release mode...
cargo build --release
if %ERRORLEVEL% EQU 0 (
    echo.
    echo =======================================================
    echo [IDM-RS] Build successful! Binary: target\release\idm-rs.exe
    echo =======================================================
) else (
    echo [IDM-RS] Build failed.
)
pause

