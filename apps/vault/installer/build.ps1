$ErrorActionPreference = 'Stop'
[Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal'
$appDir = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $appDir 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$version = $config.version
$exportDir = Join-Path $env:USERPROFILE 'Documents\Project Exports\Vault\Windows'
$iscc = (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source
if (-not $iscc) {
    $iscc = @(
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $iscc) { throw 'Inno Setup 6 (ISCC.exe) was not found.' }

function Invoke-BuildCommand([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
}

Push-Location $appDir
try {
    Invoke-BuildCommand 'node.exe' @('build.mjs')
    Push-Location 'src-tauri'
    try {
        # Cargo metadata respects CARGO_TARGET_DIR and .cargo/config.toml, including relative paths.
        $metadata = & cargo.exe metadata --no-deps --format-version 1
        if ($LASTEXITCODE -ne 0) { throw 'cargo metadata failed.' }
        $payload = Join-Path (($metadata | ConvertFrom-Json).target_directory) 'release'
        Invoke-BuildCommand 'cargo.exe' @('build', '--release', '-j', '2', '--features', 'tauri/custom-protocol')
    } finally { Pop-Location }
    Invoke-BuildCommand $iscc @('/Q', "/DAppVersion=$version", "/DPayload=$payload", "/DOutDir=$exportDir", (Join-Path $PSScriptRoot 'Vault.iss'))
    Invoke-BuildCommand $iscc @('/Q', "/DAppVersion=$version", "/DOutDir=$exportDir", (Join-Path $PSScriptRoot 'Vault-Uninstaller.iss'))
    Write-Host "Setup: $exportDir\Vault-$version-setup.exe"
    Write-Host "Standalone uninstaller: $exportDir\Vault-Uninstaller.exe"
} finally { Pop-Location }
