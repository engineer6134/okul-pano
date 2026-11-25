@echo off
chcp 65001 >nul
rem ===== Okul Pano: sunucuyu başlatır, panoyu Chrome'da tam ekran (kiosk) açar =====
rem Panoyu 2. ekranda açmak için EKRAN_X değerini birinci ekranın genişliğine ayarlayın (ör. 1920). Tek ekranda 0 bırakın.
set EKRAN_X=1920
set ADRES=http://localhost:3000/
cd /d "%~dp0"
start "Okul Pano Sunucu" /min cmd /c "node server.js"
timeout /t 3 /nobreak >nul
set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" set CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
start "" "%CHROME%" --kiosk --app=%ADRES% --window-position=%EKRAN_X%,0 --user-data-dir="%TEMP%\okul-pano-chrome" --no-first-run --disable-session-crashed-bubble
