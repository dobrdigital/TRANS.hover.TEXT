@echo off
rem Запуск рабочего Chrome (профиль Profile 4) с отладочным портом 9222.
rem Перед запуском закройте все окна Chrome, иначе флаги не применятся.

if not exist "C:\chrome-real\Local State" (
  echo Создаю junction C:\chrome-real ...
  mklink /J "C:\chrome-real" "%LOCALAPPDATA%\Google\Chrome\User Data"
)

start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir=C:\chrome-real --profile-directory="Profile 4" --remote-debugging-port=9222 --enable-unsafe-extension-debugging

echo Chrome запущен. Проверка: http://127.0.0.1:9222/json/version
