<#
.SYNOPSIS
  Publishes the finished swarm-dashboard image (tag latest + version) to
  Git-Mirror (container registry) and GitHub (release asset on the "latest" tag).

.DESCRIPTION
  Run after a build + git push. Requires the local images swarm-dashboard:<version>
  and swarm-dashboard:latest.

  Git-Mirror:  The staging daemon cannot verify the registry certificate (internal CA)
          and the dev machine cannot resolve registry.example.com, so the image is
          copied with skopeo from a throw-away container on the staging node
          (reads the daemon's image, TLS verification off for this one transfer).
          Nothing is changed on the host.
  GitHub: Uploads a docker-loadable tarball as asset of the release "latest"
          (needs only the gh "repo" scope). ghcr.io would need write:packages.

  Secrets: the Git-Mirror password is never stored. Pass it via $env:GITEA_PW or
           enter it when prompted.

.EXAMPLE
  $env:GITEA_PW = '...' ; .\scripts\publish-image.ps1
#>
param(
  [string]$Version,
  [string]$Git-MirrorHost = 'registry.example.com',
  [string]$Git-MirrorRepo = 'admin/swarm-dashboard',
  [string]$Git-MirrorUser = 'admin',
  [string]$StagingContext = 'staging',
  [string]$GitHubRepo = 'kevinmomber/swarm-dashboard',
  [switch]$SkipGit-Mirror,
  [switch]$SkipGitHub
)
$ErrorActionPreference = 'Continue'   # native tools write to stderr on expected misses; exit codes are checked explicitly
function Test-Native([scriptblock]$Block) { & $Block *> $null; return ($LASTEXITCODE -eq 0) }
function Assert-Native([string]$What) { if ($LASTEXITCODE -ne 0) { throw "$What fehlgeschlagen (Exit $LASTEXITCODE)" } }
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $Version) { $Version = (Get-Content server\package.json -Raw | ConvertFrom-Json).version }
Write-Host "Publishing swarm-dashboard $Version (+ latest)" -ForegroundColor Cyan

foreach ($t in @($Version, 'latest')) {
  if (-not (Test-Native { docker image inspect "swarm-dashboard:$t" })) { throw "Lokales Image swarm-dashboard:$t fehlt - zuerst bauen." }
}
$idV = docker image inspect "swarm-dashboard:$Version" --format '{{.Id}}'
$idL = docker image inspect 'swarm-dashboard:latest' --format '{{.Id}}'
if ($idV -ne $idL) { throw "swarm-dashboard:latest zeigt nicht auf $Version - zuerst 'docker tag swarm-dashboard:$Version swarm-dashboard:latest'." }

$tar = Join-Path $root "deploy\swarm-dashboard-$Version.tar"
if (-not (Test-Path $tar)) {
  New-Item -ItemType Directory -Force (Split-Path $tar) | Out-Null
  docker save "swarm-dashboard:$Version" swarm-dashboard:latest -o $tar
}

# ---------------------------------------------------------------- Git-Mirror
if (-not $SkipGit-Mirror) {
  $pw = $env:GITEA_PW
  if (-not $pw) {
    $sec = Read-Host "Git-Mirror-Passwort fuer $Git-MirrorUser" -AsSecureString
    $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  }
  # Make sure the staging daemon has exactly this image.
  $remoteId = docker --context $StagingContext image inspect "swarm-dashboard:$Version" --format '{{.Id}}' 2>$null
  if ($remoteId -ne $idV) {
    Write-Host "Lade Image auf $StagingContext ..." -ForegroundColor Yellow
    docker --context $StagingContext load -i $tar | Out-Null
  }
  $sh = @'
set -e
apk add --no-cache skopeo >/dev/null 2>&1
for t in $TAGS; do
  echo "--> $REG/$REPO:$t"
  skopeo copy --dest-tls-verify=false --dest-creds "$REG_USER:$REG_PW" docker-daemon:swarm-dashboard:$t docker://$REG/$REPO:$t 2>&1 | tail -1
done
'@
  $env:REG_PW = $pw
  $env:SCRIPT_B64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($sh -replace "`r`n", "`n")))
  try {
    docker --context $StagingContext run --rm -e REG_PW -e SCRIPT_B64 -e "REG_USER=$Git-MirrorUser" -e "REG=$Git-MirrorHost" -e "REPO=$Git-MirrorRepo" -e "TAGS=latest $Version" `
      -v /var/run/docker.sock:/var/run/docker.sock alpine sh -c 'echo $SCRIPT_B64 | base64 -d > /p.sh && sh /p.sh'
    if ($LASTEXITCODE -ne 0) { throw 'Git-Mirror-Push fehlgeschlagen' }
  } finally { Remove-Item Env:\REG_PW, Env:\SCRIPT_B64 -ErrorAction SilentlyContinue }
  Write-Host "Git-Mirror: $Git-MirrorHost/${Git-MirrorRepo}:latest und :$Version" -ForegroundColor Green
}

# --------------------------------------------------------------- GitHub
if (-not $SkipGitHub) {
  $notes = "Fertiges Docker-Image (docker load -i swarm-dashboard-latest.tar). Enthaelt die Tags swarm-dashboard:$Version und swarm-dashboard:latest. Stand: $(git rev-parse --short HEAD)."
  $title = "latest (v$Version)"
  gh release view latest --repo $GitHubRepo *> $null
  $exists = ($LASTEXITCODE -eq 0)
  if (-not $exists) {
    gh release create latest --repo $GitHubRepo --verify-tag --title $title --notes $notes | Out-Null
    Assert-Native 'GitHub-Release anlegen'
  } else {
    gh release edit latest --repo $GitHubRepo --title $title --notes $notes | Out-Null
    Assert-Native 'GitHub-Release aktualisieren'
  }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) 'swarm-dashboard-latest.tar'
  Copy-Item $tar $tmp -Force
  try { gh release upload latest $tmp --repo $GitHubRepo --clobber; Assert-Native 'GitHub-Upload (Image)' } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  # Stack file next to the image, so the quick start needs no repository clone.
  gh release upload latest (Join-Path $root 'docker-stack.yml') --repo $GitHubRepo --clobber
  Assert-Native 'GitHub-Upload (docker-stack.yml)'
  Write-Host "GitHub: Release 'latest' mit swarm-dashboard-latest.tar + docker-stack.yml" -ForegroundColor Green
}
