# AI Overlay setup script
Write-Host "Setting up AI Overlay..." -ForegroundColor Cyan

# Install Node deps
Write-Host "`n[1/3] Installing Node.js dependencies..." -ForegroundColor Yellow
npm install

# Set up Python venv
Write-Host "`n[2/3] Setting up Python virtual environment..." -ForegroundColor Yellow
python -m venv agent/.venv
& "agent/.venv/Scripts/pip.exe" install -r agent/requirements.txt

# Check for API key
Write-Host "`n[3/3] Checking .env..." -ForegroundColor Yellow
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "Created .env - add your ANTHROPIC_API_KEY or OPENAI_API_KEY!" -ForegroundColor Red
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
        Write-Host "Add ANTHROPIC_API_KEY or OPENAI_API_KEY to .env before running!" -ForegroundColor Red
    }
}

Write-Host "`nSetup complete! Run: npm run dev" -ForegroundColor Green
