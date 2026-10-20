# One-time secret setup (run by the owner). Nothing here is a secret: values are typed (hidden) or generated,
# piped straight into `wrangler secret put`, and never printed. Laptop-only copies go to Satya\.env (gitignored).
#   cd <path-to>/aj-platform; powershell -ExecutionPolicy Bypass -File scripts\set-secrets.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path (Split-Path -Parent $PSScriptRoot) "gateway")

function Read-Secret($prompt, [switch]$Optional) {
  $secure = Read-Host -AsSecureString $prompt
  # Works on Windows PowerShell 5.1 (.NET Framework has no PtrToStringAuth).
  $plain = (New-Object System.Management.Automation.PSCredential("x", $secure)).GetNetworkCredential().Password
  if (-not $plain -and -not $Optional) { throw "$prompt is required" }
  return $plain
}
function New-RandomHex([int]$bytes = 32) {
  $b = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return -join ($b | ForEach-Object { $_.ToString("x2") })
}
function Put-Secret($worker, $name, $value) {
  $value | npx wrangler secret put $name --name $worker 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "failed to set $name on $worker" }
  Write-Host "  set $name on $worker"
}

Write-Host "Paste each value and press Enter (input is hidden)."
$groq = Read-Secret "Groq API key (console.groq.com/keys)"
$turnstile = Read-Secret "Turnstile SECRET key (dashboard > Turnstile > aj-projects > Settings)"
$tavily = Read-Secret "Tavily API key (optional - press Enter to skip)" -Optional

$admin = New-RandomHex; $session = New-RandomHex; $satyaAdmin = New-RandomHex; $owner = New-RandomHex

Put-Secret "aj-gateway" "GROQ_API_KEY" $groq
Put-Secret "aj-gateway" "TURNSTILE_SECRET" $turnstile
Put-Secret "aj-gateway" "ADMIN_TOKEN" $admin
Put-Secret "aj-gateway" "SESSION_KEY" $session
Put-Secret "satya-api" "SATYA_ADMIN_TOKEN" $satyaAdmin
Put-Secret "satya-api" "SATYA_OWNER_TOKEN" $owner
if ($tavily) { Put-Secret "satya-api" "TAVILY_API_KEY" $tavily }

# Laptop copies (gitignored): admin token for record/parity/QA scripts, owner token for "owner mode" in your browser.
$envFile = Join-Path $PSScriptRoot "..\..\Satya\.env"  # the Satya repo sits next to aj-platform
$lines = @("SATYA_ADMIN_TOKEN=$satyaAdmin", "SATYA_OWNER_TOKEN=$owner", "AJ_ADMIN_TOKEN=$admin")
if ($tavily) { $lines += "TAVILY_API_KEY=$tavily" }
Set-Content -Path $envFile -Value $lines -Encoding ascii
Write-Host "Done. Laptop tokens saved to Satya\.env (never committed)."
