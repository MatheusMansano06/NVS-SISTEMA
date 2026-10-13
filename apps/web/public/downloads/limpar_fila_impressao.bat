@echo off
setlocal
title Limpador de Fila de Impressao - NVS

echo ======================================================
echo    EMERGENCIA: ZERAR FILA E REINICIAR SPOOLER
echo ======================================================
echo.
echo ATENCAO:
echo - Este processo cancela tudo que estiver na fila do Windows.
echo - Use somente quando a Zebra/impressao travar.
echo - Feche o agente antes de limpar a fila, se ele estiver aberto.
echo - Depois da limpeza, abra novamente o iniciar_operacao.bat.
echo.

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERRO] Este script precisa ser executado como ADMINISTRADOR.
    echo.
    echo Clique com o botao direito no arquivo e selecione:
    echo "Executar como administrador".
    echo.
    pause
    exit /b 1
)

tasklist /FI "IMAGENAME eq ZebraAgent-WP.exe" | find /I "ZebraAgent-WP.exe" >nul 2>&1
if %errorLevel% equ 0 (
    echo [AVISO] O agente ZebraAgent-WP.exe esta aberto.
    echo.
    choice /C SN /M "Deseja fechar o agente automaticamente antes de limpar"
    if errorlevel 2 (
        echo Operacao cancelada. Feche o agente e rode este arquivo novamente.
        pause
        exit /b 1
    )
    taskkill /F /IM ZebraAgent-WP.exe /T >nul 2>&1
    timeout /T 2 /NOBREAK >nul
)

echo.
choice /C SN /M "Confirma limpar TODA a fila de impressao agora"
if errorlevel 2 (
    echo Operacao cancelada.
    pause
    exit /b 0
)

echo.
echo [1/5] Parando o servico de Spooler...
net stop spooler /y
echo.

echo [2/5] Encerrando processo do Spooler, se necessario...
taskkill /F /IM spoolsv.exe /T >nul 2>&1
echo.

echo [3/5] Limpando arquivos temporarios da fila...
if exist "%systemroot%\System32\Spool\Printers" (
    del /Q /F "%systemroot%\System32\Spool\Printers\*.*" >nul 2>&1
)
echo.

echo [4/5] Reiniciando o servico de Spooler...
net start spooler
if %errorLevel% neq 0 (
    echo [ERRO] Nao foi possivel reiniciar o Spooler.
    echo Reinicie o Windows antes de voltar a imprimir.
    pause
    exit /b 1
)
echo.

echo [5/5] Tentando colocar impressoras ONLINE via PowerShell...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Printer | Where-Object {$_.JobCount -gt 0 -or $_.PrinterStatus -eq 'Offline'} | Set-Printer -IsOffline $false"
echo.

echo ======================================================
echo    PROCESSO CONCLUIDO
echo ======================================================
echo.
echo Fila limpa e Spooler reiniciado.
echo Agora abra novamente o agente:
echo.
echo   iniciar_operacao.bat
echo.
echo Se ainda aparecer Offline, abra a fila da impressora e desmarque:
echo "Usar Impressora Offline".
echo.
pause
endlocal
