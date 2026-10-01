# Builds the Rust sidecar (native/target/release/lumen-native.exe) for packaging.
# Uses cargo from PATH, else %USERPROFILE%\.cargo\bin\cargo.exe.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$cargo = (Get-Command cargo -ErrorAction SilentlyContinue).Source
if (-not $cargo) {
  $cargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
  if (-not (Test-Path $cargo)) {
    throw 'cargo not found. Install Rust from https://rustup.rs and run this again.'
  }
}

& $cargo build --release --manifest-path (Join-Path $root 'native/Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)" }

$exe = Join-Path $root 'native/target/release/lumen-native.exe'
if (-not (Test-Path $exe)) { throw "missing $exe" }
$mb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "lumen-native.exe ready ($mb MB)"
