<#
.SYNOPSIS
    Builds the TRN Black Pearl Control desktop app for Windows.

.DESCRIPTION
    Bumps the version in frontend/package.json, src-tauri/Cargo.toml, and
    src-tauri/tauri.conf.json, builds the Go backend as a Tauri sidecar
    (CGO required for USB HID access), then runs `tauri build` to produce
    the MSI and NSIS installers. Copies the resulting installers into
    builds/ unless -SkipCopyToBuilds is passed.

.PARAMETER Version
    The version to build, e.g. "0.2.0" (semver, no "v" prefix).

.PARAMETER SkipCopyToBuilds
    Skip copying the built installers into builds/.

.EXAMPLE
    .\build-windows.ps1 -Version 0.2.0
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,

    [switch]$SkipCopyToBuilds
)

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# Deliberately not setting $ErrorActionPreference = 'Stop': in Windows
# PowerShell 5.1, that turns every stderr line from a native command (npm,
# go, npx, ...) into a terminating error, even purely informational output
# with a healthy exit code. Failures are instead caught explicitly below via
# Assert-LastExitCode and -ErrorAction Stop on the PowerShell cmdlets that
# read/write files.

function Step($msg) {
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function Assert-LastExitCode($what) {
    if ($LASTEXITCODE -ne 0) {
        throw "$what failed with exit code $LASTEXITCODE"
    }
}

# Pick up toolchains installed earlier in this shell session's parent
# processes (winget updates the registry, not the current process's PATH).
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + `
            [Environment]::GetEnvironmentVariable('Path', 'User')

Step "Checking toolchain"
foreach ($cmd in 'go', 'node', 'npm', 'rustc', 'cargo') {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        throw "'$cmd' not found on PATH. Install the required toolchain first (see README.md)."
    }
}

# npm's script-shell must not be PowerShell: Windows PowerShell 5.1 doesn't
# support '&&', which frontend's "tsc && vite build" script relies on.
$scriptShell = npm config get script-shell 2>$null
if ($scriptShell -match 'powershell') {
    throw "npm's script-shell is set to '$scriptShell', which breaks '&&' in npm scripts on " +
          "Windows PowerShell. Fix with: npm config delete script-shell"
}

Step "Setting version to $Version"

Push-Location "$RepoRoot\frontend"
npm version $Version --no-git-tag-version --allow-same-version | Out-Null
Assert-LastExitCode "npm version"
Pop-Location

(Get-Content "$RepoRoot\src-tauri\Cargo.toml" -ErrorAction Stop) `
    -replace '(?m)^version = ".*"$', "version = `"$Version`"" |
    Set-Content "$RepoRoot\src-tauri\Cargo.toml" -ErrorAction Stop

$tauriConfPath = "$RepoRoot\src-tauri\tauri.conf.json"
(Get-Content $tauriConfPath -Raw -ErrorAction Stop) `
    -replace '"version":\s*"[^"]*"', "`"version`": `"$Version`"" |
    Set-Content $tauriConfPath -NoNewline -ErrorAction Stop

if (-not (Test-Path "$RepoRoot\frontend\node_modules")) {
    Step "Installing frontend dependencies"
    Push-Location "$RepoRoot\frontend"
    npm install
    Assert-LastExitCode "npm install"
    Pop-Location
}

Step "Downloading Go module dependencies"
Push-Location "$RepoRoot\backend"
go mod download
Assert-LastExitCode "go mod download"
Pop-Location

$triple = (rustc -vV | Select-String '^host:').ToString().Split(' ')[1]
Step "Building Go backend sidecar for $triple"
New-Item -ItemType Directory -Force -Path "$RepoRoot\src-tauri\binaries" | Out-Null

Push-Location "$RepoRoot\backend"
$env:CGO_ENABLED = "1"
go build -trimpath -ldflags="-s -w" `
    -o "$RepoRoot\src-tauri\binaries\trncontrol-backend-$triple.exe" .
Assert-LastExitCode "go build"
Pop-Location

Step "Building the Tauri desktop app"
Push-Location "$RepoRoot\src-tauri"
npx tauri build
Assert-LastExitCode "tauri build"
Pop-Location

if (-not $SkipCopyToBuilds) {
    Step "Copying installers to builds\"
    New-Item -ItemType Directory -Force -Path "$RepoRoot\builds" | Out-Null
    $bundleRoot = "$RepoRoot\src-tauri\target\release\bundle"
    $installers = Get-ChildItem -Path "$bundleRoot\msi", "$bundleRoot\nsis" `
        -Filter "*$Version*" -ErrorAction SilentlyContinue
    if (-not $installers) {
        Write-Warning "No installers matching version $Version found under $bundleRoot"
    }
    foreach ($f in $installers) {
        Copy-Item $f.FullName -Destination "$RepoRoot\builds\" -Force
        Write-Host "  -> builds\$($f.Name)"
    }
}

Step "Done. Built version $Version."
