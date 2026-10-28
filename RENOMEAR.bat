@echo off
REM ===========================================================================
REM  Renomeia a pasta do projeto: invictuspay-main  ->  thmuitopena
REM
REM  COMO USAR:
REM    1. FECHE o VS Code (ele segura a pasta aberta)
REM    2. FECHE a sessao do Claude Code que esta nesta pasta
REM    3. Clique duas vezes neste arquivo
REM
REM  Ele para o Node, renomeia, e avisa o resultado.
REM ===========================================================================

echo.
echo  Renomeando: invictuspay-main  ---^>  thmuitopena
echo.

cd /d "C:\Meus Sites"

if exist "thmuitopena" (
    echo  [ERRO] Ja existe uma pasta chamada "thmuitopena".
    echo         Apague ou renomeie ela antes de rodar isto.
    pause
    exit /b 1
)

if not exist "invictuspay-main" (
    echo  [ERRO] Nao achei a pasta "invictuspay-main" em C:\Meus Sites
    pause
    exit /b 1
)

echo  Parando processos do Node...
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo  Renomeando...
move "invictuspay-main" "thmuitopena" >nul 2>&1

if exist "thmuitopena" (
    echo.
    echo  [OK] Pronto. O projeto agora esta em:
    echo       C:\Meus Sites\thmuitopena
    echo.
    echo  Para subir o servidor de novo:
    echo       cd "C:\Meus Sites\thmuitopena"
    echo       npm start
    echo.
) else (
    echo.
    echo  [ERRO] Nao consegui renomear. Algum programa ainda esta com a
    echo         pasta aberta. Feche o VS Code, o Explorer e os terminais,
    echo         depois rode este arquivo de novo.
    echo.
)

pause
