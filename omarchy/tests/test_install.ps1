# Runs install.ps1 against synthetic release archives.
#
#   pwsh -NoProfile -File omarchy/tests/test_install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File omarchy/tests/test_install.ps1
#
# Windows only, and only on a CI runner: the installer writes the user's Start
# menu shortcut and edits the user PATH, which the cases check and restore.
# Downloads come from a fixtures directory (local_release.ps1 shadows
# Invoke-WebRequest and Invoke-RestMethod); program files and the Qt-era
# leftovers live in a scratch %LOCALAPPDATA%. Results are checked by what is on
# disk and in the registry, not only by the exit status.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { Write-Error 'test_install.ps1 needs Windows'; exit 1 }
if ($env:GITHUB_ACTIONS -ne 'true') { Write-Error 'test_install.ps1 edits the user PATH and Start menu; run it on CI'; exit 1 }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$Shell = if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh' } else { 'powershell' }
$Temp = Join-Path ([IO.Path]::GetTempPath()) ('omamail-install-test-' + [Guid]::NewGuid().ToString('N'))
$InstallDir = Join-Path $Temp 'local\Programs\Omamail'
$Shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Omamail.lnk'
$Toast = 'HKCU:\Software\Classes\CLSID\{6E420BBE-A800-4FF9-BD65-472CC53922CA}'
$OriginalPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$Failures = 0
$Passed = 0

function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }

function New-Release([string]$Version, [hashtable]$Entries, [string]$Checksum = '') {
    $dir = Join-Path $Temp "fixtures\v$Version"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    # 0.13.0 published Omamail-*; later releases are lower case.
    $name = if ($Version -eq '0.13.0') { "Omamail-$Version-windows-x86_64.zip" } else { "omamail-$Version-windows-x86_64.zip" }
    $path = Join-Path $dir $name
    $zip = [IO.Compression.ZipFile]::Open($path, 'Create')
    try {
        foreach ($entry in $Entries.Keys) {
            $stream = $zip.CreateEntry($entry).Open()
            try { $bytes = [Text.Encoding]::UTF8.GetBytes([string]$Entries[$entry]); $stream.Write($bytes, 0, $bytes.Length) }
            finally { $stream.Dispose() }
        }
    } finally { $zip.Dispose() }
    if (-not $Checksum) { $Checksum = (Get-FileHash -Algorithm SHA256 $path).Hash.ToLowerInvariant() }
    [IO.File]::WriteAllText((Join-Path $dir 'SHA256SUMS'), "$Checksum  $name`n")
}

function App-Files([string]$Version) {
    return @{
        'Omamail/Omamail.exe' = "MZ $Version"
        'Omamail/nsh/app.json' = "{`"id`":`"dev.huacnlee.omamail`",`"version`":`"$Version`"}"
        'Omamail/nsh/bundle.nshc' = 'bytecode'
    }
}

function Run-Installer([hashtable]$Arguments = @{}, [string]$Latest = '0.13.0') {
    $Arguments['InstallDir'] = $InstallDir
    $env:INSTALL_ARGS = ConvertTo-Json $Arguments -Compress
    $env:FIXTURES = Join-Path $Temp 'fixtures'
    $env:MOCK_LATEST = $Latest
    $saved = $env:LOCALAPPDATA
    $env:LOCALAPPDATA = Join-Path $Temp 'local'
    # Windows PowerShell 5.1 turns a child's stderr into a terminating error
    # under Stop; the refusals are read from it instead.
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $Shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'local_release.ps1') 2>&1 | Out-String
        return [pscustomobject]@{ Code = $LASTEXITCODE; Output = $output }
    } finally { $env:LOCALAPPDATA = $saved }
}

function Assert-Refused($Result, [string]$Message) {
    Assert ($Result.Code -ne 0) "expected a refusal: $($Result.Output)"
    Assert ($Result.Output -like "*$Message*") "expected '$Message' in: $($Result.Output)"
    Assert (-not (Test-Path -LiteralPath $InstallDir)) 'a refused install left the app'
    Assert (-not (Test-Path -LiteralPath $Shortcut)) 'a refused install left the shortcut'
    $staging = @(Get-ChildItem -LiteralPath (Join-Path $Temp 'local') -Recurse -Force -Filter '.omamail-install-*' -ErrorAction SilentlyContinue)
    Assert ($staging.Count -eq 0) 'a refused install left staging'
}

function Case([string]$Name, [scriptblock]$Body) {
    if (Test-Path -LiteralPath $Temp) { Remove-Item -LiteralPath $Temp -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Join-Path $Temp 'local') | Out-Null
    Remove-Item -LiteralPath $Shortcut -Force -ErrorAction SilentlyContinue
    try {
        & $Body
        Write-Host "ok   [$Shell] $Name"
        $script:Passed++
    } catch {
        Write-Host "FAIL [$Shell] ${Name}: $_"
        $script:Failures++
    } finally {
        [Environment]::SetEnvironmentVariable('Path', $OriginalPath, 'User')
        Remove-Item -LiteralPath $Toast -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $Shortcut -Force -ErrorAction SilentlyContinue
    }
}

try {
    Case 'installs the latest release and removes the Qt-era app, keeping its data' {
        $legacy = Join-Path $Temp 'local\omamail'
        $legacyBin = Join-Path $legacy 'bin'
        New-Item -ItemType Directory -Force -Path $legacyBin, (Join-Path $legacy 'qml'), (Join-Path $legacy 'cache') | Out-Null
        [IO.File]::WriteAllText((Join-Path $legacyBin 'omamail-app.exe'), 'qt')
        [IO.File]::WriteAllText((Join-Path $legacy 'cache\mail.db'), 'mail')
        [Environment]::SetEnvironmentVariable('Path', "$OriginalPath;$legacyBin", 'User')
        New-Item -Force -Path "$Toast\LocalServer32" | Out-Null
        Set-Item -Path "$Toast\LocalServer32" -Value ('"{0}" -ToastActivated' -f (Join-Path $legacyBin 'omamail-app.exe'))
        New-Release '0.13.0' (App-Files '0.13.0')
        $result = Run-Installer
        Assert ($result.Code -eq 0) $result.Output
        Assert ([IO.File]::ReadAllText((Join-Path $InstallDir 'Omamail.exe')) -eq 'MZ 0.13.0') 'Omamail.exe was not installed'
        Assert (Test-Path -LiteralPath $Shortcut) 'no Start menu shortcut'
        Assert (-not (Test-Path -LiteralPath $legacyBin)) 'the Qt-era bin is left'
        Assert (-not (Test-Path -LiteralPath (Join-Path $legacy 'qml'))) 'the Qt-era qml is left'
        Assert ([IO.File]::ReadAllText((Join-Path $legacy 'cache\mail.db')) -eq 'mail') 'data beside the Qt-era app was removed'
        Assert (-not (@([Environment]::GetEnvironmentVariable('Path', 'User') -split ';') -contains $legacyBin)) 'the Qt-era PATH entry is left'
        Assert (-not (Test-Path -LiteralPath $Toast)) 'the Qt-era toast activator is left'
    }

    Case 'a toast activator owned by another program stays' {
        New-Item -Force -Path "$Toast\LocalServer32" | Out-Null
        Set-Item -Path "$Toast\LocalServer32" -Value '"C:\Other\other.exe" -ToastActivated'
        New-Release '0.13.0' (App-Files '0.13.0')
        $result = Run-Installer
        Assert ($result.Code -eq 0) $result.Output
        Assert (Test-Path -LiteralPath "$Toast\LocalServer32") 'another program''s activator was removed'
    }

    Case 'a named version replaces the installed app' {
        New-Release '0.13.0' (App-Files '0.13.0')
        Assert ((Run-Installer).Code -eq 0) 'first install failed'
        New-Release '0.14.0' (App-Files '0.14.0')
        $result = Run-Installer @{ Version = 'v0.14.0' } '9.9.9'
        Assert ($result.Code -eq 0) $result.Output
        Assert ([IO.File]::ReadAllText((Join-Path $InstallDir 'Omamail.exe')) -eq 'MZ 0.14.0') 'the upgrade did not replace the app'
        Assert (-not (Test-Path -LiteralPath "$InstallDir.previous")) 'the previous version was left'
    }

    Case 'refuses: checksum mismatch' {
        New-Release '0.13.0' (App-Files '0.13.0') ('0' * 64)
        Assert-Refused (Run-Installer) 'Checksum verification failed'
    }

    Case 'refuses: parent-directory entry' {
        $files = App-Files '0.13.0'; $files['Omamail/../escaped'] = 'x'
        New-Release '0.13.0' $files
        Assert-Refused (Run-Installer) 'unsafe path'
    }

    Case 'refuses: entry outside the app directory' {
        $files = App-Files '0.13.0'; $files['Other/file'] = 'x'
        New-Release '0.13.0' $files
        Assert-Refused (Run-Installer) 'unsafe path'
    }

    Case 'refuses: missing Omamail.exe' {
        $files = App-Files '0.13.0'; $files.Remove('Omamail/Omamail.exe')
        New-Release '0.13.0' $files
        Assert-Refused (Run-Installer) 'missing Omamail.exe'
    }

    Case 'refuses: a Qt-era release' {
        Assert-Refused (Run-Installer @{ Version = '0.12.0' }) 'Releases before 0.13.0'
    }

    Case 'refuses: an invalid version' {
        Assert-Refused (Run-Installer @{ Version = '0.13.0-rc.1' }) 'Version must be'
    }

    Case '-Uninstall removes the app and its shortcut' {
        New-Release '0.13.0' (App-Files '0.13.0')
        Assert ((Run-Installer).Code -eq 0) 'install failed'
        $result = Run-Installer @{ Uninstall = $true }
        Assert ($result.Code -eq 0) $result.Output
        Assert (-not (Test-Path -LiteralPath $InstallDir)) 'uninstall left the app'
        Assert (-not (Test-Path -LiteralPath $Shortcut)) 'uninstall left the shortcut'
    }
} finally {
    Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "$Failures failed, $Passed passed"
if ($Failures -gt 0) { exit 1 }
