Param(
    [switch]$Debug
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$repoRoot = Split-Path $scriptDir -Parent
Set-Location $repoRoot

if (-not (Get-Command poetry -ErrorAction SilentlyContinue)) {
    Write-Error "Poetry is not installed or not on PATH."
}

poetry install --no-interaction --with dev

$pyInstallerArgs = @(
    "--noconfirm"
    "--windowed"
    "--name"
    "ClipboardImageSaver"
    "clipboard_manager/__main__.py"
)

if ($Debug) {
    $pyInstallerArgs += "--debug"
}

poetry run pyinstaller @pyInstallerArgs

Write-Host "Executable created under dist/ClipboardImageSaver/"

