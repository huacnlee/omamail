$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$PackageScript = Join-Path $RepoRoot "app\scripts\package-release.ps1"
$Temp = Join-Path ([IO.Path]::GetTempPath()) ("omamail-package-test-" + [Guid]::NewGuid().ToString('N'))

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Expect-Failure([scriptblock]$Action, [string]$Pattern) {
    try {
        & $Action
        throw "expected failure matching: $Pattern"
    } catch {
        if ($_.Exception.Message -notmatch $Pattern) { throw }
    }
}

function Write-X64Pe([string]$Path) {
    $Bytes = New-Object byte[] 512
    $Bytes[0] = 0x4d
    $Bytes[1] = 0x5a
    [BitConverter]::GetBytes([int]128).CopyTo($Bytes, 0x3c)
    $Bytes[128] = 0x50
    $Bytes[129] = 0x45
    $Bytes[130] = 0
    $Bytes[131] = 0
    $Bytes[132] = 0x64
    $Bytes[133] = 0x86
    [IO.File]::WriteAllBytes($Path, $Bytes)
}

New-Item -ItemType Directory -Force $Temp | Out-Null
try {
    $Inputs = Join-Path $Temp "inputs"
    $Qml = Join-Path $Inputs "qml"
    $Ui = Join-Path $Inputs "ui"
    $Dist = Join-Path $Temp "dist"
    New-Item -ItemType Directory -Force $Qml, $Ui | Out-Null
    $HostBinary = Join-Path $Inputs "host.exe"
    $Backend = Join-Path $Inputs "backend.exe"
    $Manifest = Join-Path $Inputs "manifest.json"
    Write-X64Pe $HostBinary
    Write-X64Pe $Backend
    [IO.File]::WriteAllText((Join-Path $Qml "Main.qml"), "import QtQuick`nItem {}`n")
    [IO.File]::WriteAllText((Join-Path $Ui "Service.qml"), "import QtQuick`nQtObject {}`n")
    [IO.File]::WriteAllText($Manifest, '{"version":"1.2.3"}')

    Remove-Item Env:OMAMAIL_PACKAGE_TEST_MODE -ErrorAction SilentlyContinue
    Expect-Failure {
        & $PackageScript -HostBinary $HostBinary -Backend $Backend -Qml $Qml -Ui $Ui `
            -Manifest $Manifest -Dist $Dist -SyntheticTestMode
    } 'restricted to the package test harness'
    $env:OMAMAIL_PACKAGE_TEST_MODE = "1"

    $Archive = (& $PackageScript -HostBinary $HostBinary -Backend $Backend -Qml $Qml -Ui $Ui `
        -Manifest $Manifest -Dist $Dist -Version "v1.2.3" -SyntheticTestMode |
        Select-Object -Last 1)
    Assert-True (Test-Path -LiteralPath $Archive -PathType Leaf) "package archive was not created"
    Assert-True ([IO.Path]::GetFileName($Archive) -ceq "omamail-app-windows-x86_64.zip") `
        "package archive has the wrong name"

    $Zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $Names = @($Zip.Entries | ForEach-Object { $_.FullName })
        Assert-True (-not @($Names | Where-Object { -not $_.StartsWith("omamail/") }).Count) `
            "archive contains more than one top-level directory"
        Assert-True (-not @($Names | Where-Object { $_ -match "JetBrainsMono" }).Count) `
            "archive must use the platform text font instead of bundling JetBrains Mono"
        foreach ($Required in @(
            "omamail/bin/omamail-app.exe",
            "omamail/bin/omamail.exe",
            "omamail/qml/Main.qml",
            "omamail/ui/Service.qml",
            "omamail/bin/platforms/qwindows.dll",
            "omamail/manifest.json",
            "omamail/licenses/NerdFonts-LICENSE",
            "omamail/licenses/NerdFonts-README.md",
            "omamail/licenses/NerdFonts-PROVENANCE.md",
            "omamail/licenses/Apache-2.0.txt",
            "omamail/licenses/Pomicons-OFL-1.1.txt",
            "omamail/licenses/GLYPH-SOURCES.md",
            "omamail/app-icon.ico",
            "omamail/release.json"
        )) {
            Assert-True ($Names -ccontains $Required) "archive is missing $Required"
        }
        $IconEntry = $Zip.GetEntry("omamail/app-icon.ico")
        $IconMemory = New-Object IO.MemoryStream
        try {
            $IconStream = $IconEntry.Open()
            try { $IconStream.CopyTo($IconMemory) } finally { $IconStream.Dispose() }
            $ExpectedIcon = [IO.File]::ReadAllBytes(
                (Join-Path $RepoRoot "app\resources\windows\omamail.ico"))
            Assert-True ([Convert]::ToBase64String($IconMemory.ToArray()) -ceq
                [Convert]::ToBase64String($ExpectedIcon)) `
                "package does not contain the reviewed Windows Omamail icon"
        } finally {
            $IconMemory.Dispose()
        }
        $ReleaseEntry = $Zip.GetEntry("omamail/release.json")
        $Reader = New-Object IO.StreamReader($ReleaseEntry.Open())
        try { $Release = $Reader.ReadToEnd() | ConvertFrom-Json } finally { $Reader.Dispose() }
        Assert-True ([string]$Release.version -ceq "1.2.3") "release version is wrong"
        Assert-True ([string]$Release.target -ceq "windows-x86_64") "release target is wrong"
        Assert-True ([string]$Release.topLevel -ceq "omamail") "release top-level is wrong"
    } finally {
        $Zip.Dispose()
    }

    $MissingDist = Join-Path $Temp "missing-dist"
    Expect-Failure {
        & $PackageScript -HostBinary $HostBinary -Backend (Join-Path $Inputs "missing.exe") `
            -Qml $Qml -Ui $Ui -Manifest $Manifest -Dist $MissingDist -SyntheticTestMode
    } 'backend is missing'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $MissingDist "omamail-app-windows-x86_64.zip"))) `
        "missing-input failure left an archive"

    $MissingIconDist = Join-Path $Temp "missing-icon-dist"
    Expect-Failure {
        & $PackageScript -HostBinary $HostBinary -Backend $Backend -Qml $Qml -Ui $Ui `
            -Manifest $Manifest -Icon (Join-Path $Inputs "missing.svg") `
            -Dist $MissingIconDist -SyntheticTestMode
    } 'application icon is missing'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $MissingIconDist "omamail-app-windows-x86_64.zip"))) `
        "missing-icon failure left an archive"

    $ProductionDist = Join-Path $Temp "production-dist"
    Expect-Failure {
        & $PackageScript -HostBinary $HostBinary -Backend $Backend -Qml $Qml -Ui $Ui `
            -Manifest $Manifest -Dist $ProductionDist -WindeployQt "no-such-windeployqt.exe"
    } 'windeployqt is required'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $ProductionDist "omamail-app-windows-x86_64.zip"))) `
        "production packaging bypassed windeployqt"

    $PackageSource = [IO.File]::ReadAllText($PackageScript)
    foreach ($SmokeCommand in @("--check-resources", "--smoke-test", "--version", "test_backend_api.py")) {
        Assert-True ($PackageSource.Contains($SmokeCommand)) `
            "production packaging does not run $SmokeCommand against the extracted archive"
    }
    Assert-True ($PackageSource -match 'test_backend_api\.py[\s\S]+--standalone') `
        "packaged backend API smoke does not use the standalone contract"

    Write-Output "Windows package tests passed"
} finally {
    Remove-Item Env:OMAMAIL_PACKAGE_TEST_MODE -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
}
