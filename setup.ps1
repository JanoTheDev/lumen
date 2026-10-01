# Lumen dev setup
Write-Host "Setting up Lumen..." -ForegroundColor Cyan

Write-Host "`n[1/3] Installing Node.js dependencies..." -ForegroundColor Yellow
npm install

Write-Host "`n[2/3] Building the native helper (lumen-native)..." -ForegroundColor Yellow
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo -and (Test-Path "$env:USERPROFILE\.cargo\bin\cargo.exe")) { $cargo = "$env:USERPROFILE\.cargo\bin\cargo.exe" }
if ($cargo) {
    npm run build:native
} else {
    Write-Host "Rust not found. Install it from https://rustup.rs and run: npm run build:native" -ForegroundColor Red
}

Write-Host "`n[3/3] Checking .env..." -ForegroundColor Yellow
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "Created .env - add ANTHROPIC_API_KEY or OPENAI_API_KEY (or paste a key in the app's setup)." -ForegroundColor Yellow
} else {
    $anthropic = (Get-Content ".env" | Select-String "ANTHROPIC_API_KEY=(.+)")
    $openai    = (Get-Content ".env" | Select-String "OPENAI_API_KEY=(.+)")

    $anthropicVal = if ($anthropic) { $anthropic.Matches.Groups[1].Value } else { "" }
    $openaiVal    = if ($openai)    { $openai.Matches.Groups[1].Value }    else { "" }

    $hasKey = ($anthropicVal -and $anthropicVal -notmatch "^your_") -or
              ($openaiVal    -and $openaiVal    -notmatch "^your_")

    if ($hasKey) {
        Write-Host "API key found." -ForegroundColor Green
    } else {
        Write-Host "No key in .env; you can paste one in the app's setup instead." -ForegroundColor Yellow
    }
}

Write-Host "`nSetup complete! Run: npm run dev" -ForegroundColor Green
