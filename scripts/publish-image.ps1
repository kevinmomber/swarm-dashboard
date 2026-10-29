<#
.SYNOPSIS
  Publishes the finished swarm-dashboard image (tag latest + version) as a GitHub
  release asset and, optionally, to a container registry.

.DESCRIPTION
  Run after a build + git push. Requires the local images swarm-dashboard:<version>
  and swarm-dashboard:latest.

  GitHub:   Uploads a docker-loadable tarball (swarm-dashboard-latest.tar) and the
            docker-stack.yml as assets of the release "latest" (needs only the gh
            "repo" scope; ghcr.io would need write:packages).

  Registry: Optional. Set -RegistryHost / -RegistryRepo (or the environment variables
            PUBLISH_REGISTRY_HOST / PUBLISH_REGISTRY_REPO / PUBLISH_REGISTRY_USER /
            PUBLISH_REGISTRY_CONTEXT). Without a host this step is skipped.
            The image is copied with skopeo from a throw-away container on the
            Docker host selected by -RegistryContext, i.e. a host that can reach the
            registry and trusts its certificate. This is useful when the registry
            uses a private CA that the development machine cannot resolve or verify
            (TLS verification is switched off for this single transfer only).

  Secrets:  The registry password is never stored. Pass it via
            $env:PUBLISH_REGISTRY_PW or enter it when prompted.

.EXAMPLE
  .\scripts\publish-image.ps1 -SkipRegistry

.EXAMPLE
  $env:PUBLISH_REGISTRY_HOST = 'registry.example.com'
  $env:PUBLISH_REGISTRY_REPO = 'team/swarm-dashboard'
  $env:PUBLISH_REGISTRY_USER = 'ci'
  $env:PUBLISH_REGISTRY_CONTEXT = 'my-docker-host'
  $env:PUBLISH_REGISTRY_PW = '...'
  .\scripts\publish-image.ps1
#>
param(
  [string]$Version,
  [string]$RegistryHost = $env:PUBLISH_REGISTRY_HOST,
  [string]$RegistryRepo = $env:PUBLISH_REGISTRY_REPO,
  [string]$RegistryUser = $env:PUBLISH_REGISTRY_USER,
  [string]$RegistryContext = $env:PUBLISH_REGISTRY_CONTEXT,
  [string]$GitHubRepo,
  [switch]$SkipRegistry,
  [switch]$SkipGitHub
)
$ErrorActionPreference = 'Continue'   # native tools write to stderr on expected misses; exit codes are checked explicitly
function Test-Native([scriptblock]$Block) { & $Block *> $null; return ($LASTEXITCODE -eq 0) }
function Assert-Native([string]$What) { if ($LASTEXITCODE -ne 0) { throw "$What fehlgeschlagen (Exit $LASTEXITCODE)" } }
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $Version) { $Version = (Get-Content server\package.json -Raw | ConvertFrom-Json).version }
if (-not $GitHubRepo) { $GitHubRepo = (gh repo view --json nameWithOwner --jq .nameWithOwner 2>$null) }
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

# ------------------------------------------------------------- Registry
if ($SkipRegistry -or -not $RegistryHost) {
  Write-Host 'Registry: uebersprungen (kein -RegistryHost / PUBLISH_REGISTRY_HOST)' -ForegroundColor DarkGray
} else {
  if (-not $RegistryRepo -or -not $RegistryUser -or -not $RegistryContext) {
    throw 'Fuer die Registry werden -RegistryRepo, -RegistryUser und -RegistryContext benoetigt.'
  }
  $pw = $env:PUBLISH_REGISTRY_PW
  if (-not $pw) {
    $sec = Read-Host "Registry-Passwort fuer $RegistryUser" -AsSecureString
    $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  }
  # Make sure the Docker host used for the transfer has exactly this image.
  $remoteId = docker --context $RegistryContext image inspect "swarm-dashboard:$Version" --format '{{.Id}}' 2>$null
  if ($remoteId -ne $idV) {
    Write-Host "Lade Image auf $RegistryContext ..." -ForegroundColor Yellow
    docker --context $RegistryContext load -i $tar | Out-Null
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
    docker --context $RegistryContext run --rm -e REG_PW -e SCRIPT_B64 -e "REG_USER=$RegistryUser" -e "REG=$RegistryHost" -e "REPO=$RegistryRepo" -e "TAGS=latest $Version" `
      -v /var/run/docker.sock:/var/run/docker.sock alpine sh -c 'echo $SCRIPT_B64 | base64 -d > /p.sh && sh /p.sh'
    if ($LASTEXITCODE -ne 0) { throw 'Registry-Push fehlgeschlagen' }
  } finally { Remove-Item Env:\REG_PW, Env:\SCRIPT_B64 -ErrorAction SilentlyContinue }
  Write-Host "Registry: $RegistryHost/${RegistryRepo}:latest und :$Version" -ForegroundColor Green
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
