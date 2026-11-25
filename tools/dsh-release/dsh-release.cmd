@echo off
node "%~dp0bin\dsh-release.mjs" %*
exit /b %ERRORLEVEL%
