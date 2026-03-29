param(
    [Parameter(Mandatory = $true)]
    [string]$VaultPath
)

$ErrorActionPreference = "Stop"

$pluginDir = Join-Path $PSScriptRoot "codex-agent"
$manifestPath = Join-Path $pluginDir "manifest.json"

if (-not (Test-Path $VaultPath)) {
    throw "Vault path does not exist: $VaultPath"
}

if (-not (Test-Path (Join-Path $VaultPath ".obsidian"))) {
    throw "The target path does not look like an Obsidian vault: $VaultPath"
}

if (-not (Test-Path $manifestPath)) {
    throw "Plugin files were not found next to this installer: $pluginDir"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$pluginId = [string]$manifest.id
$legacyPluginId = "codex-agent-bridge"

if (-not $pluginId) {
    throw "Plugin id is missing from manifest.json"
}

$targetDir = Join-Path $VaultPath ".obsidian\plugins\$pluginId"
$legacyDir = Join-Path $VaultPath ".obsidian\plugins\$legacyPluginId"

New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $pluginDir "*") -Destination $targetDir -Recurse -Force

$legacyDataPath = Join-Path $legacyDir "data.json"
$targetDataPath = Join-Path $targetDir "data.json"
if ((Test-Path $legacyDataPath) -and -not (Test-Path $targetDataPath)) {
    Copy-Item -LiteralPath $legacyDataPath -Destination $targetDataPath -Force
    Write-Host "Migrated existing plugin settings from $legacyPluginId"
}

if ((Test-Path $legacyDir) -and ($legacyDir -ne $targetDir)) {
    Write-Warning "Legacy plugin folder detected: $legacyDir"
    Write-Warning "After confirming the new plugin works, you can remove the old folder manually."
}

Write-Host "Installed plugin to $targetDir"
