# Installs Git if needed, then commits and pushes this project to GitHub.
# Run from the MUSIC-BOT folder:  powershell -ExecutionPolicy Bypass -File scripts\push-to-github.ps1
$ErrorActionPreference = 'Stop'
$Repo  = 'https://github.com/Charancherry-code/DIiscord-Music-Bot.git'
$Name  = 'Charancherry-code'
$Email = 'charancherry1129@gmail.com'

Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing Git...'
  winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
  $env:Path = "C:\Program Files\Git\cmd;" + $env:Path
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host 'Git install failed. Install it from https://git-scm.com/download/win and run this again.'
    exit 1
  }
}

# Safety check: never upload the bot token.
if (Test-Path .env) {
  $ignored = git check-ignore .env 2>$null
  if (-not $ignored -and -not (Select-String -Path .gitignore -Pattern '^\.env$' -Quiet)) {
    Write-Host '.env is not in .gitignore. Stopping so your token is not uploaded.'
    exit 1
  }
}

if (-not (Test-Path .git)) { git init | Out-Null }
git add .

# Identity is set for these commands only (your global Git settings are not changed).
git -c "user.name=$Name" -c "user.email=$Email" commit -m 'Shadow Music Bot: Stage 1, HiFi profiles, new player card, server setup'
git branch -M main
if (-not (git remote 2>$null | Select-String -Pattern '^origin$' -Quiet)) { git remote add origin $Repo }

Write-Host 'Pushing (a browser window may open for GitHub login)...'
git push -u origin main
if ($LASTEXITCODE -eq 0) { Write-Host "Done: $Repo" } else { Write-Host 'Push failed, see the message above.' }
