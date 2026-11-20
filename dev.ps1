# Starts the widget in dev mode. Refreshes PATH so a fresh rustup install is picked up.
$env:PATH = [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH', 'User') + ";$env:USERPROFILE\.cargo\bin"
Set-Location $PSScriptRoot
pnpm tauri dev
