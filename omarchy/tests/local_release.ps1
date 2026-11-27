# Runs install.ps1 with its downloads served from a local release tree:
# $env:FIXTURES\v<version>\<asset> answers .../releases/download/v<version>/<asset>,
# and the latest release is v$env:MOCK_LATEST. The installer's arguments come
# from $env:INSTALL_ARGS as a JSON object. Used by test_install.ps1 and by
# release.yml to install the archive it has just built.
$ErrorActionPreference = 'Stop'
function Invoke-RestMethod { [pscustomobject]@{ tag_name = "v$env:MOCK_LATEST" } }
function Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
    $parts = ($Uri -split '/releases/download/', 2)[1] -split '/', 2
    $source = Join-Path (Join-Path $env:FIXTURES $parts[0]) $parts[1]
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "404 $Uri" }
    Copy-Item -LiteralPath $source -Destination $OutFile
}
$named = @{}
if ($env:INSTALL_ARGS) {
    (ConvertFrom-Json $env:INSTALL_ARGS).psobject.Properties | ForEach-Object { $named[$_.Name] = $_.Value }
}
& (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'install.ps1') @named
