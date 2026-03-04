# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

[CmdletBinding()]
param(
    [int]$Port = 8080,
    [string]$LogLevel = "warn",
    [switch]$Build,
    [switch]$Background
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$binaryPath = Join-Path $repoRoot "target\release\ifc-lite-server.exe"

function Resolve-CargoCommand {
    $cargo = Get-Command cargo -ErrorAction SilentlyContinue
    if ($cargo) {
        return $cargo.Source
    }

    $fallback = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
    if (Test-Path $fallback) {
        return $fallback
    }

    throw "cargo not found. Install Rust toolchain and open a new terminal."
}

if ($Build -or -not (Test-Path $binaryPath)) {
    Write-Host "Building ifc-lite-server (release)..."
    $cargoExe = Resolve-CargoCommand
    & $cargoExe build -p ifc-lite-server --release
    if ($LASTEXITCODE -ne 0) {
        throw "Build failed with exit code $LASTEXITCODE."
    }
}

if (-not (Test-Path $binaryPath)) {
    throw "Server binary not found at: $binaryPath"
}

$env:PORT = "$Port"
$env:RUST_LOG = $LogLevel

if ($Background) {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $binaryPath
    $startInfo.WorkingDirectory = $repoRoot
    $startInfo.UseShellExecute = $false
    $startInfo.Environment["PORT"] = "$Port"
    $startInfo.Environment["RUST_LOG"] = $LogLevel

    $process = [System.Diagnostics.Process]::Start($startInfo)
    if ($null -eq $process) {
        throw "Failed to start ifc-lite-server in background."
    }

    Write-Host "ifc-lite-server started in background."
    Write-Host "PID: $($process.Id)"
    Write-Host "URL: http://127.0.0.1:$Port"
    exit 0
}

Write-Host "Starting ifc-lite-server on http://127.0.0.1:$Port (RUST_LOG=$LogLevel)"
& $binaryPath
