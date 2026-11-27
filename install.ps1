# Install the published Omamail app for the current Windows user.
#   irm https://huacnlee.github.io/omamail/install.ps1 | iex
# Works in Windows PowerShell 5.1 and PowerShell 7.
[CmdletBinding()]
param(
    [string]$Version = $(if ($env:OMAMAIL_VERSION) { $env:OMAMAIL_VERSION } else { 'latest' }),
    [string]$InstallDir = $(if ($env:OMAMAIL_INSTALL_DIR) { $env:OMAMAIL_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\Omamail' }),
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ($env:OS -ne 'Windows_NT') { throw 'This installer requires Windows. Use install.sh on macOS or Linux.' }
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($architecture -ne 'AMD64') { throw "Windows releases are for x86_64 only; this is $architecture." }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Omamail.lnk'

# The Qt-era app (0.12 and earlier): %LOCALAPPDATA%\omamail with its bin on
# the user PATH and a toast activator. Only the Qt package's own items go;
# accounts and settings are shared with this app and stay.
function Remove-QtApp {
    $legacy = Join-Path $env:LOCALAPPDATA 'omamail'
    $bin = Join-Path $legacy 'bin'
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    if ($key) {
        try {
            if (@($key.GetValueNames()) -contains 'Path') {
                $kind = $key.GetValueKind('Path')
                $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                $parts = @($raw.Split(';'))
                $kept = @($parts | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ne $bin })
                if ($kept.Count -ne $parts.Count) { $key.SetValue('Path', ($kept -join ';'), $kind) }
            }
        } finally { $key.Dispose() }
    }
    $toast = 'HKCU:\Software\Classes\CLSID\{6E420BBE-A800-4FF9-BD65-472CC53922CA}'
    $server = (Get-ItemProperty -LiteralPath "$toast\LocalServer32" -ErrorAction SilentlyContinue).'(default)'
    if ($server -eq ('"{0}" -ToastActivated' -f (Join-Path $bin 'omamail-app.exe'))) {
        Remove-Item -LiteralPath $toast -Recurse -Force
    }
    if (Test-Path -LiteralPath (Join-Path $bin 'omamail-app.exe') -PathType Leaf) {
        foreach ($item in 'qml', 'ui', 'licenses', 'manifest.json', 'release.json', 'app-icon.ico', 'bin') {
            Remove-Item -LiteralPath (Join-Path $legacy $item) -Recurse -Force -ErrorAction SilentlyContinue
        }
        if (-not (Get-ChildItem -LiteralPath $legacy -Force)) { Remove-Item -LiteralPath $legacy -Force }
    }
}

if ($Uninstall) {
    if (Test-Path -LiteralPath $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
    Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue
    Remove-QtApp
    Write-Host 'Removed Omamail. Accounts and settings were kept.'
    return
}

$repository = 'https://github.com/huacnlee/omamail'
if ($Version -eq 'latest') {
    $release = Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/huacnlee/omamail/releases/latest'
    $Version = $release.tag_name
}
$Version = $Version -replace '^v', ''
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version must be a release version such as 0.13.0 or v0.13.0.' }
$asset = "Omamail-$Version-windows-x86_64.zip"
$base = "$repository/releases/download/v$Version"
$work = Join-Path ([IO.Path]::GetTempPath()) ('omamail-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    Write-Host "Downloading Omamail $Version for Windows x86_64..."
    $archive = Join-Path $work $asset
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $archive
    } catch {
        throw "Could not download $asset. Releases before 0.13.0 are not installed by this script."
    }
    $checksums = Join-Path $work 'SHA256SUMS'
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $checksums
    $expected = @(Get-Content $checksums | ForEach-Object {
        if ($_ -match '^([a-fA-F0-9]{64})\s+\*?(.+)$' -and $Matches[2] -ceq $asset) { $Matches[1] }
    })
    if ($expected.Count -ne 1) { throw "Missing or ambiguous checksum for $asset" }
    if ((Get-FileHash $archive -Algorithm SHA256).Hash -ine $expected[0]) { throw 'Checksum verification failed; nothing was installed.' }

    # Only entries inside the app's one top-level directory.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName -replace '\\', '/'
            if (-not $name.StartsWith('Omamail/') -or $name -match '(^|/)\.\.(/|$)' -or $name -match ':') {
                throw 'Release archive contains an unsafe path.'
            }
        }
    } finally { $zip.Dispose() }
    $unpacked = Join-Path $work 'unpacked'
    Expand-Archive -LiteralPath $archive -DestinationPath $unpacked
    $app = Join-Path $unpacked 'Omamail'
    foreach ($file in 'Omamail.exe', 'nsh\app.json', 'nsh\bundle.nshc') {
        if (-not (Test-Path -LiteralPath (Join-Path $app $file) -PathType Leaf)) { throw "Release archive is missing $file." }
    }

    # Replace the app as a unit; put the previous version back if that fails.
    # Windows refuses while Omamail is running: close it and run this again.
    $parent = Split-Path -Parent $InstallDir
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $staging = Join-Path $parent ('.omamail-install-' + [Guid]::NewGuid().ToString('N'))
    Move-Item -LiteralPath $app -Destination $staging
    $previous = "$InstallDir.previous"
    if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }
    if (Test-Path -LiteralPath $InstallDir) {
        try { Move-Item -LiteralPath $InstallDir -Destination $previous }
        catch { Remove-Item -LiteralPath $staging -Recurse -Force; throw 'Close Omamail, then run the installer again.' }
    }
    try { Move-Item -LiteralPath $staging -Destination $InstallDir }
    catch {
        if (Test-Path -LiteralPath $previous) { Move-Item -LiteralPath $previous -Destination $InstallDir }
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        throw 'Could not replace the installed app; the previous version was kept.'
    }
    if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }

    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($shortcut)
    $link.TargetPath = Join-Path $InstallDir 'Omamail.exe'
    $link.WorkingDirectory = $InstallDir
    $link.IconLocation = "$(Join-Path $InstallDir 'Omamail.exe'),0"
    $link.Save()
    Remove-QtApp
    Write-Host "Installed $InstallDir. Launch Omamail from the Start menu; it updates itself from then on."
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
