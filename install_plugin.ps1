param(
    [Parameter(Mandatory = $true)]
    [string]$VaultPath
)

$pluginId = "codex-agent"
$legacyPluginId = "codex-agent-bridge"
$sourceDir = Join-Path $PSScriptRoot "plugin"
$targetDir = Join-Path $VaultPath ".obsidian\plugins\$pluginId"
$legacyDir = Join-Path $VaultPath ".obsidian\plugins\$legacyPluginId"
$bundlePath = Join-Path $sourceDir "main.bundle.js"

if (-not (Test-Path $VaultPath)) {
    throw "Vault path does not exist: $VaultPath"
}

if (-not (Test-Path (Join-Path $VaultPath ".obsidian"))) {
    throw "The target path does not look like an Obsidian vault: $VaultPath"
}

if (Test-Path $bundlePath) {
    Write-Host "Using bundled main.js from $bundlePath"
} else {
    Write-Warning "main.bundle.js was not found. Falling back to raw plugin files."
}

New-Item -ItemType Directory -Path $targetDir -Force | Out-Null

Get-ChildItem -LiteralPath $sourceDir -File | ForEach-Object {
    if ($_.Name -eq "main.bundle.js") {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $targetDir "main.js") -Force
    } elseif ((Test-Path $bundlePath) -and $_.Name -eq "main.js") {
        return
    } elseif ($_.Name -ne "build-bundle.js") {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $targetDir $_.Name) -Force
    }
}

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
