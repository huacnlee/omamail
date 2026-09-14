param(
    [Alias("Host")]
    [string]$HostBinary = "app\build\Release\omamail-app.exe",
    [string]$Backend = "target\release\omamail.exe",
    [string]$Qml = "app\qml",
    [string]$Ui = "ui",
    [string]$Manifest = "manifest.json",
    [string]$Icon = "app\resources\windows\omamail.ico",
    [string]$Dist = "dist",
    [string]$Version = "",
    [string]$WindeployQt = "windeployqt.exe",
    [string]$Python = "python.exe",
    [string]$BackendApiTest = "tests\test_backend_api.py",
    [switch]$SyntheticTestMode
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Target = "windows-x86_64"
$Asset = "omamail-app-$Target.zip"

if ($SyntheticTestMode -and $env:OMAMAIL_PACKAGE_TEST_MODE -ne "1") {
    throw "-SyntheticTestMode is restricted to the package test harness"
}

function Resolve-InputPath([string]$Path) {
    if ([IO.Path]::IsPathRooted($Path)) { return [IO.Path]::GetFullPath($Path) }
    return [IO.Path]::GetFullPath((Join-Path $RepoRoot $Path))
}

function Assert-File([string]$Path, [string]$Description) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description is missing: $Path"
    }
}

function Assert-Directory([string]$Path, [string]$Description) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "$Description is missing: $Path"
    }
}

function Assert-X64Pe([string]$Path, [string]$Description) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read,
        [IO.FileShare]::Read)
    try {
        if ($stream.Length -lt 70) { throw "$Description is not a Windows PE file: $Path" }
        $reader = New-Object IO.BinaryReader($stream)
        if ($reader.ReadUInt16() -ne 0x5a4d) {
            throw "$Description is not a Windows PE file: $Path"
        }
        $stream.Position = 0x3c
        $header = $reader.ReadInt32()
        if ($header -lt 64 -or $header -gt ($stream.Length - 6)) {
            throw "$Description has an invalid PE header: $Path"
        }
        $stream.Position = $header
        if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne 0x8664) {
            throw "$Description is not an x86_64 Windows binary: $Path"
        }
    } finally {
        $stream.Dispose()
    }
}

$HostPath = Resolve-InputPath $HostBinary
$BackendPath = Resolve-InputPath $Backend
$QmlPath = Resolve-InputPath $Qml
$UiPath = Resolve-InputPath $Ui
$ManifestPath = Resolve-InputPath $Manifest
$IconPath = Resolve-InputPath $Icon
$DistPath = Resolve-InputPath $Dist
$NerdFontsLicensePath = Join-Path $RepoRoot "app\assets\fonts\NerdFonts-LICENSE"
$NerdFontsReadmePath = Join-Path $RepoRoot "app\assets\fonts\NerdFonts-README.md"
$NerdFontsProvenancePath = Join-Path $RepoRoot "app\assets\fonts\NerdFonts-PROVENANCE.md"
$NerdFontsThirdPartyPath = Join-Path $RepoRoot "app\assets\fonts\licenses"

Assert-File $HostPath "standalone host"
Assert-File $BackendPath "backend"
Assert-Directory $QmlPath "standalone QML directory"
Assert-Directory $UiPath "shared UI directory"
Assert-File $ManifestPath "manifest"
Assert-File $IconPath "application icon"
Assert-File $NerdFontsLicensePath "Nerd Fonts license"
Assert-File $NerdFontsReadmePath "Nerd Fonts notices"
Assert-File $NerdFontsProvenancePath "Nerd Fonts provenance"
Assert-Directory $NerdFontsThirdPartyPath "Nerd Fonts third-party licenses"
Assert-File (Join-Path $QmlPath "Main.qml") "standalone QML entry point"
Assert-File (Join-Path $UiPath "Service.qml") "shared UI entry point"
Assert-X64Pe $HostPath "standalone host"
Assert-X64Pe $BackendPath "backend"

$ManifestObject = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$ManifestVersion = $ManifestObject.version
if ($ManifestVersion -isnot [string] -or
    $ManifestVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw "manifest has an invalid version"
}
if ($Version) {
    $RequestedVersion = if ($Version.StartsWith('v')) { $Version.Substring(1) } else { $Version }
    if ($RequestedVersion -ne $ManifestVersion) {
        throw "requested version $RequestedVersion does not match manifest version $ManifestVersion"
    }
} else {
    $RequestedVersion = $ManifestVersion
}

if (-not $SyntheticTestMode -and -not (Get-Command $WindeployQt -ErrorAction SilentlyContinue)) {
    throw "windeployqt is required for a production Windows package"
}
if (-not $SyntheticTestMode -and -not (Get-Command $Python -ErrorAction SilentlyContinue)) {
    throw "Python is required for the packaged backend API test"
}
$BackendApiTestPath = Resolve-InputPath $BackendApiTest
if (-not $SyntheticTestMode) {
    Assert-File $BackendApiTestPath "backend API test"
}

New-Item -ItemType Directory -Force $DistPath | Out-Null
$Stage = Join-Path $DistPath ".package-windows-x86_64"
$Package = Join-Path $Stage "omamail"
$Archive = Join-Path $DistPath $Asset
$Smoke = Join-Path $DistPath ".smoke-windows-x86_64"
Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $Archive -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $Smoke -Recurse -Force -ErrorAction SilentlyContinue

$Succeeded = $false
try {
    $Bin = Join-Path $Package "bin"
    New-Item -ItemType Directory -Force $Bin | Out-Null
    Copy-Item -LiteralPath $HostPath -Destination (Join-Path $Bin "omamail-app.exe")
    Copy-Item -LiteralPath $BackendPath -Destination (Join-Path $Bin "omamail.exe")
    Copy-Item -LiteralPath $QmlPath -Destination (Join-Path $Package "qml") -Recurse
    Copy-Item -LiteralPath $UiPath -Destination (Join-Path $Package "ui") -Recurse
    Copy-Item -LiteralPath $ManifestPath -Destination (Join-Path $Package "manifest.json")
    $Licenses = Join-Path $Package "licenses"
    New-Item -ItemType Directory -Force $Licenses | Out-Null
    Copy-Item -LiteralPath $NerdFontsLicensePath -Destination (Join-Path $Licenses "NerdFonts-LICENSE")
    Copy-Item -LiteralPath $NerdFontsReadmePath -Destination (Join-Path $Licenses "NerdFonts-README.md")
    Copy-Item -LiteralPath $NerdFontsProvenancePath -Destination (Join-Path $Licenses "NerdFonts-PROVENANCE.md")
    Copy-Item -Path (Join-Path $NerdFontsThirdPartyPath "*") -Destination $Licenses

    if ($SyntheticTestMode) {
        $Platforms = Join-Path $Bin "platforms"
        New-Item -ItemType Directory -Force $Platforms | Out-Null
        Copy-Item -LiteralPath $HostPath -Destination (Join-Path $Platforms "qwindows.dll")
        Copy-Item -LiteralPath $IconPath -Destination (Join-Path $Package "app-icon.ico")
    } else {
        Copy-Item -LiteralPath $IconPath -Destination (Join-Path $Package "app-icon.ico")
        & $WindeployQt --release --no-translations --qmldir $Package --dir $Bin `
            (Join-Path $Bin "omamail-app.exe")
        if ($LASTEXITCODE -ne 0) { throw "windeployqt failed with exit code $LASTEXITCODE" }
    }

    Assert-File (Join-Path $Bin "platforms\qwindows.dll") "Qt Windows platform plugin"
    Assert-File (Join-Path $Package "app-icon.ico") "Windows application icon"
    Assert-X64Pe (Join-Path $Bin "platforms\qwindows.dll") "Qt Windows platform plugin"

    $Release = [ordered]@{
        schemaVersion = 1
        name = "omamail"
        version = $RequestedVersion
        target = $Target
        topLevel = "omamail"
    } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $Package "release.json"), $Release + "`n",
        (New-Object Text.UTF8Encoding($false)))

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory(
        $Stage, $Archive, [IO.Compression.CompressionLevel]::Optimal, $false)
    if (-not $SyntheticTestMode) {
        [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Smoke)
        $SmokePackage = Join-Path $Smoke "omamail"
        $SmokeHost = Join-Path $SmokePackage "bin\omamail-app.exe"
        $SmokeBackend = Join-Path $SmokePackage "bin\omamail.exe"
        $ReadyFile = Join-Path $Smoke "ready.json"
        & $SmokeHost --check-resources
        if ($LASTEXITCODE -ne 0) { throw "packaged host resource check failed" }
        & $SmokeHost --smoke-test $ReadyFile
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $ReadyFile -PathType Leaf)) {
            throw "packaged host smoke test failed"
        }
        $BackendVersion = (& $SmokeBackend --version | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $BackendVersion -cne "omamail $RequestedVersion") {
            throw "packaged backend version does not match $RequestedVersion"
        }
        & $Python $BackendApiTestPath --binary $SmokeBackend --expected-version $RequestedVersion `
            --standalone
        if ($LASTEXITCODE -ne 0) { throw "packaged backend API test failed" }
    }
    $Succeeded = $true
    Write-Output $Archive
} finally {
    Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $Smoke -Recurse -Force -ErrorAction SilentlyContinue
    if (-not $Succeeded) {
        Remove-Item -LiteralPath $Archive -Force -ErrorAction SilentlyContinue
    }
}
