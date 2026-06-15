#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Generate fresh production secrets for the Retale LAN stack.

.DESCRIPTION
  Produces cryptographically random replacements for the `replace-me`
  placeholders in .env.prod:

    MARIADB_PASSWORD / MARIADB_ROOT_PASSWORD  hex   (URL-safe — they go into
                                                     DATABASE_URL)
    JWT_SIGNING_KEY / TWO_FACTOR_ENC_KEY      base64

  By default it just prints the values. Pass -Write to create/update .env.prod
  (copying .env.prod.example if it doesn't exist yet), filling ONLY lines still
  set to `replace-me` — any real secret already in the file is left untouched.

.EXAMPLE
  ./deploy/gen-secrets.ps1
  Print four fresh secrets to copy into .env.prod by hand.

.EXAMPLE
  ./deploy/gen-secrets.ps1 -Write
  Create or top up .env.prod, replacing only the remaining `replace-me` lines.
#>
[CmdletBinding()]
param(
  # Create/update .env.prod instead of just printing.
  [switch]$Write,
  # Path to the env file (defaults to repo-root .env.prod).
  [string]$EnvFile = (Join-Path $PSScriptRoot '..' '.env.prod')
)

$ErrorActionPreference = 'Stop'

function New-Hex([int]$Bytes = 32) {
  [System.Convert]::ToHexString(
    [System.Security.Cryptography.RandomNumberGenerator]::GetBytes($Bytes)
  ).ToLower()
}

function New-Base64([int]$Bytes = 48) {
  [System.Convert]::ToBase64String(
    [System.Security.Cryptography.RandomNumberGenerator]::GetBytes($Bytes)
  )
}

$secrets = [ordered]@{
  MARIADB_PASSWORD      = New-Hex 32
  MARIADB_ROOT_PASSWORD = New-Hex 32
  JWT_SIGNING_KEY       = New-Base64 48
  TWO_FACTOR_ENC_KEY    = New-Base64 48
}

if (-not $Write) {
  foreach ($k in $secrets.Keys) { "$k=$($secrets[$k])" }
  return
}

$example = Join-Path $PSScriptRoot '..' '.env.prod.example'

if (-not (Test-Path $EnvFile)) {
  if (-not (Test-Path $example)) {
    throw "Neither $EnvFile nor $example exists — cannot create .env.prod."
  }
  Copy-Item $example $EnvFile
  Write-Host "Created $EnvFile from .env.prod.example"
}

$lines = Get-Content $EnvFile
$filled = @()
foreach ($k in $secrets.Keys) {
  $pattern = "^$([regex]::Escape($k))=replace-me\s*$"
  if (($lines | Select-String -Pattern $pattern -Quiet)) {
    $lines = $lines -replace $pattern, "$k=$($secrets[$k])"
    $filled += $k
  }
}

Set-Content -Path $EnvFile -Value $lines -Encoding utf8NoBOM

if ($filled.Count -gt 0) {
  Write-Host "Filled in: $($filled -join ', ')"
} else {
  Write-Host "No 'replace-me' placeholders left in $EnvFile — nothing changed."
}
