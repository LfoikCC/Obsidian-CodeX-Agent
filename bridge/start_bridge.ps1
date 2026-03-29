param(
    [string]$Host = "127.0.0.1",
    [int]$Port = 8765
)

$env:CODEX_BRIDGE_HOST = $Host
$env:CODEX_BRIDGE_PORT = "$Port"

python (Join-Path $PSScriptRoot "server.py")
