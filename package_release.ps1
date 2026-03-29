param(
    [string]$OutputDir = (Join-Path $PSScriptRoot "release")
)

$ErrorActionPreference = "Stop"

$pluginSourceDir = Join-Path $PSScriptRoot "plugin"
$manifestPath = Join-Path $pluginSourceDir "manifest.json"
$bundleScript = Join-Path $pluginSourceDir "build-bundle.js"
$bundlePath = Join-Path $pluginSourceDir "main.bundle.js"
$releaseReadmePath = Join-Path $PSScriptRoot "RELEASE_README.zh-CN.md"
$releaseInstallerPath = Join-Path $PSScriptRoot "release_install_plugin.ps1"

if (-not (Test-Path $manifestPath)) {
    throw "manifest.json not found: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$pluginId = [string]$manifest.id
$pluginVersion = [string]$manifest.version

if (-not $pluginId) {
    throw "Plugin id is missing from manifest.json"
}

if (-not $pluginVersion) {
    throw "Plugin version is missing from manifest.json"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js was not found in PATH. It is required to build the release bundle."
}

& node $bundleScript
if ($LASTEXITCODE -ne 0) {
    throw "Failed to build main.bundle.js"
}

if (-not (Test-Path $bundlePath)) {
    throw "Bundled plugin entry was not created: $bundlePath"
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$packageName = "$pluginId-v$pluginVersion"
$stageRoot = Join-Path $OutputDir $packageName
$pluginStageDir = Join-Path $stageRoot $pluginId
$zipPath = Join-Path $OutputDir "$packageName.zip"

if (Test-Path $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
}

if (Test-Path $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

New-Item -ItemType Directory -Path $pluginStageDir -Force | Out-Null

Get-ChildItem -LiteralPath $pluginSourceDir -File | ForEach-Object {
    if ($_.Name -eq "main.bundle.js") {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $pluginStageDir "main.js") -Force
    } elseif ((Test-Path $bundlePath) -and $_.Name -eq "main.js") {
        return
    } elseif ($_.Name -ne "build-bundle.js") {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $pluginStageDir $_.Name) -Force
    }
}

if (Test-Path $releaseInstallerPath) {
    Copy-Item -LiteralPath $releaseInstallerPath -Destination (Join-Path $stageRoot "install_plugin.ps1") -Force
}

if (Test-Path $releaseReadmePath) {
    Copy-Item -LiteralPath $releaseReadmePath -Destination (Join-Path $stageRoot "README.md") -Force
}

Compress-Archive -Path (Join-Path $stageRoot "*") -DestinationPath $zipPath -Force

Write-Host "Release ready:"
Write-Host "  Folder: $stageRoot"
Write-Host "  Zip:    $zipPath"
