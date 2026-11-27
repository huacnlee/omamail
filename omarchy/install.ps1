# Installs the Omamail Windows release (built by `nsh package --target windows`)
# for the current user, the same way NSH's own setup does: program files in
# %LOCALAPPDATA%\Programs\Omamail and a Start menu shortcut whose
# AppUserModelID is the app id. Omamail updates itself from there.
#
#   irm https://huacnlee.github.io/omamail/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://huacnlee.github.io/omamail/install.ps1))) -Version 0.13.0
#
# It also removes what the Qt-era version of this script installed (program
# files in %LOCALAPPDATA%\omamail, its user PATH entry and its notification
# activator registration). Accounts, settings and saved passwords are never
# touched: they live in %APPDATA%\omamail, %LOCALAPPDATA%\OmamailData and
# Windows Credential Manager, outside every directory this script removes.
#
# Keep this file Windows PowerShell 5.1 compatible.
param(
    [string]$Version = "latest",
    [switch]$Uninstall,
    [Alias("Archive")]
    [string]$ArchivePath = "",
    [Alias("Checksums")]
    [string]$ChecksumPath = "",
    [switch]$TestMode,
    [string]$InstallRoot = "",
    [string]$StartMenuRoot = "",
    [string]$LegacyRoot = "",
    [string]$RegistryRoot = "",
    [string]$TestArchitecture = "",
    [switch]$TestRedirectPolicy,
    [object]$TestHttpHandler = $null,
    [string]$RedirectStateFile = "",
    [ValidateSet("", "AfterInstall", "AfterShortcut")]
    [string]$TestFailure = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Repository = "huacnlee/omamail"
$AppId = "dev.huacnlee.omamail"
$TopLevel = "Omamail"
$ExecutableName = "Omamail.exe"
$VersionPattern = '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$'
$AssetPattern = '^Omamail-([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)-windows-x86_64\.zip$'
$MaximumArchiveBytes = 2GB
$MaximumEntries = 4096
$MaximumEntryBytes = 512MB
$MaximumExpandedBytes = 2GB
$MaximumMetadataBytes = 1MB

# What the Qt-era installer created (omarchy/install.ps1 before the NSH port):
# the program directory %LOCALAPPDATA%\omamail with these top-level items, its
# bin directory on the user PATH, and this toast activator COM registration.
# bin goes last: it holds the marker that identifies a Qt-era directory.
$LegacyPackageItems = @("qml", "ui", "licenses", "manifest.json", "release.json",
    "app-icon.ico", "bin")
$LegacyMarker = "bin\omamail-app.exe"
$LegacyToastClsid = "{6E420BBE-A800-4FF9-BD65-472CC53922CA}"

function Save-BoundedDownload([string]$Uri, [string]$Path, [long]$Limit,
    [int]$TimeoutSeconds, [object]$HandlerOverride = $null) {
    Add-Type -AssemblyName System.Net.Http
    $OwnHandler = $null -eq $HandlerOverride
    $Handler = if ($OwnHandler) { New-Object Net.Http.HttpClientHandler } else { $HandlerOverride }
    if ($OwnHandler) { $Handler.AllowAutoRedirect = $false }
    $Client = New-Object Net.Http.HttpClient($Handler, $false)
    $Client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
    $Cancellation = New-Object Threading.CancellationTokenSource
    $Cancellation.CancelAfter([TimeSpan]::FromSeconds($TimeoutSeconds))
    $Response = $null
    $Reader = $null
    $Output = $null
    try {
        $CurrentUri = New-Object Uri($Uri, [UriKind]::Absolute)
        for ($Redirects = 0; $true; $Redirects++) {
            if ($CurrentUri.Scheme -cne "https") {
                throw "release download attempted a non-HTTPS request"
            }
            $Response = $Client.GetAsync($CurrentUri,
                [Net.Http.HttpCompletionOption]::ResponseHeadersRead,
                $Cancellation.Token).GetAwaiter().GetResult()
            $Status = [int]$Response.StatusCode
            if ($Status -notin @(301, 302, 303, 307, 308)) { break }
            if ($Redirects -ge 5) { throw "release download exceeded its redirect limit" }
            $Location = $Response.Headers.Location
            if ($null -eq $Location) { throw "release redirect has no destination" }
            $NextUri = if ($Location.IsAbsoluteUri) {
                $Location
            } else {
                New-Object Uri($CurrentUri, $Location)
            }
            if ($NextUri.Scheme -cne "https") {
                throw "release download redirected outside HTTPS"
            }
            $Response.Dispose()
            $Response = $null
            $CurrentUri = $NextUri
        }
        $Response.EnsureSuccessStatusCode() | Out-Null
        $Declared = $Response.Content.Headers.ContentLength
        if ($null -ne $Declared -and $Declared -gt $Limit) {
            throw "release download is too large"
        }
        $Reader = $Response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $Output = [IO.File]::Open($Path, [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write, [IO.FileShare]::None)
        $Buffer = New-Object byte[] 65536
        [long]$Total = 0
        while (($Read = $Reader.ReadAsync($Buffer, 0, $Buffer.Length,
                    $Cancellation.Token).GetAwaiter().GetResult()) -gt 0) {
            $Total += $Read
            if ($Total -gt $Limit) { throw "release download is too large" }
            $Output.Write($Buffer, 0, $Read)
        }
    } finally {
        if ($Output) { $Output.Dispose() }
        if ($Reader) { $Reader.Dispose() }
        if ($Response) { $Response.Dispose() }
        $Cancellation.Dispose()
        $Client.Dispose()
        if ($OwnHandler) { $Handler.Dispose() }
    }
}

function Copy-BoundedLocalFile([string]$Source, [string]$Destination, [long]$Limit,
    [string]$Description) {
    $Reader = [IO.File]::Open($Source, [IO.FileMode]::Open, [IO.FileAccess]::Read,
        [IO.FileShare]::Read)
    $Output = $null
    try {
        if ($Reader.Length -gt $Limit) { throw "$Description is too large" }
        $Output = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write, [IO.FileShare]::None)
        $Buffer = New-Object byte[] 65536
        [long]$Total = 0
        while (($Read = $Reader.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
            $Total += $Read
            if ($Total -gt $Limit) { throw "$Description is too large" }
            $Output.Write($Buffer, 0, $Read)
        }
    } catch {
        if ($Output) { $Output.Dispose(); $Output = $null }
        Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
        throw
    } finally {
        if ($Output) { $Output.Dispose() }
        $Reader.Dispose()
    }
}

function Assert-TestBoundary {
    if (-not $TestMode) {
        if ($InstallRoot -or $StartMenuRoot -or $LegacyRoot -or $RegistryRoot -or
            $TestArchitecture -or $TestFailure -or $TestRedirectPolicy -or
            $TestHttpHandler -or $RedirectStateFile) {
            throw "test-only arguments require -TestMode"
        }
        if ($env:OS -ne "Windows_NT") { throw "Omamail supports this installer only on Windows" }
        return
    }
    if ($env:OMAMAIL_PACKAGE_TEST_MODE -ne "1") {
        throw "-TestMode is restricted to the package test harness"
    }
    if (-not $InstallRoot -or -not $StartMenuRoot -or -not $LegacyRoot -or
        -not $RegistryRoot -or -not $TestArchitecture -or
        (-not $Uninstall -and (-not $ArchivePath -or -not $ChecksumPath))) {
        throw "-TestMode requires isolated archive, checksum, install, Start Menu, legacy, registry, and architecture inputs"
    }
    if ($RegistryRoot -cnotmatch '^Software\\OmamailInstallerTest-[0-9a-f]{32}$') {
        throw "-RegistryRoot must be a Software\OmamailInstallerTest-<guid> key"
    }
}

function Normalize-Version([string]$Value) {
    if ($Value -eq "latest") { return "latest" }
    $Normalized = if ($Value.StartsWith('v')) { $Value.Substring(1) } else { $Value }
    if ($Normalized -cnotmatch $VersionPattern) {
        throw "invalid release version: $Value"
    }
    return $Normalized
}

function Get-AssetVersion([string]$Name) {
    if ($Name -cmatch $AssetPattern) { return $Matches[1] }
    return ""
}

function Assert-X64Windows {
    $Architecture = if ($TestMode) {
        $TestArchitecture
    } elseif ($env:PROCESSOR_ARCHITEW6432) {
        $env:PROCESSOR_ARCHITEW6432
    } else {
        $env:PROCESSOR_ARCHITECTURE
    }
    if ($Architecture -ne "AMD64") {
        throw "Omamail supports only x86_64 Windows; found $Architecture"
    }
}

function Read-ChecksumEntries([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "checksum file is missing: $Path"
    }
    if ((Get-Item -LiteralPath $Path).Length -gt $MaximumMetadataBytes) {
        throw "checksum file is too large"
    }
    $Entries = @()
    foreach ($Line in [IO.File]::ReadAllLines($Path)) {
        if ($Line -match '^([0-9A-Fa-f]{64})\s+\*?(.+)$') {
            $Entries += ,@($Matches[1].ToLowerInvariant(), $Matches[2])
        }
    }
    return ,$Entries
}

function Get-ExpectedChecksum([string]$Path, [string]$ArchiveName) {
    $Digests = @()
    foreach ($Entry in (Read-ChecksumEntries $Path)) {
        if ($Entry[1] -ceq $ArchiveName) { $Digests += $Entry[0] }
    }
    if ($Digests.Count -ne 1) {
        throw "SHA256SUMS must contain exactly one entry for $ArchiveName"
    }
    return $Digests[0]
}

function Select-LatestAsset([string]$Path) {
    $Names = @()
    foreach ($Entry in (Read-ChecksumEntries $Path)) {
        if (Get-AssetVersion $Entry[1]) { $Names += $Entry[1] }
    }
    if ($Names.Count -ne 1) {
        throw "SHA256SUMS must list exactly one Omamail-<version>-windows-x86_64.zip"
    }
    return $Names[0]
}

function Test-ControlCharacter([string]$Value) {
    foreach ($Character in $Value.ToCharArray()) {
        $Code = [int][char]$Character
        if ($Code -lt 0x20 -or $Code -eq 0x7f) { return $true }
    }
    return $false
}

function Assert-SafeEntryName([string]$Name) {
    if (-not $Name -or $Name.Length -gt 1024 -or (Test-ControlCharacter $Name) -or
        $Name.Contains('\') -or $Name.StartsWith('/') -or
        $Name -match '^[A-Za-z]:' -or $Name.Contains(':')) {
        throw "release archive contains an unsafe path"
    }
    $Trimmed = $Name.TrimEnd('/')
    $Parts = $Trimmed.Split('/')
    foreach ($Part in $Parts) {
        if (-not $Part -or $Part -eq '.' -or $Part -eq '..' -or $Part.Length -gt 255 -or
            $Part -match '[<>"|?*]' -or $Part -match '[ .]$') {
            throw "release archive contains an unsafe path component"
        }
        $Stem = ($Part -split '\.')[0]
        if ($Stem -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$') {
            throw "release archive contains a reserved Windows path"
        }
    }
    if ($Parts[0] -cne $TopLevel) {
        throw "release archive must contain one $TopLevel top-level directory"
    }
}

function Get-ExternalAttributes($Entry) {
    return [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$Entry.ExternalAttributes), 0)
}

function Assert-SafeEntryType($Entry, [bool]$IsDirectory) {
    [uint64]$External = Get-ExternalAttributes $Entry
    [uint64]$UnixType = ($External -shr 16) -band 0xf000
    [uint64]$DosAttributes = $External -band 0xffff
    if (($DosAttributes -band 0x400) -ne 0) {
        throw "release archive contains a reparse point"
    }
    if ($UnixType -ne 0 -and $UnixType -ne 0x8000 -and $UnixType -ne 0x4000) {
        throw "release archive contains a symlink or special file"
    }
    if ($UnixType -ne 0 -and (($UnixType -eq 0x4000) -ne $IsDirectory)) {
        throw "release archive has conflicting file type metadata"
    }
}

function Read-ZipEntryBytes($Entry, [long]$Limit) {
    if ($Entry.Length -gt $Limit) { throw "release metadata is too large" }
    $Reader = $Entry.Open()
    $Memory = New-Object IO.MemoryStream
    try {
        $Buffer = New-Object byte[] 65536
        [long]$Total = 0
        while (($Read = $Reader.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
            $Total += $Read
            if ($Total -gt $Limit) { throw "release metadata is too large" }
            $Memory.Write($Buffer, 0, $Read)
        }
        return ,$Memory.ToArray()
    } finally {
        $Reader.Dispose()
        $Memory.Dispose()
    }
}

function Read-ZipEntryText($Entry) {
    $Encoding = New-Object Text.UTF8Encoding($false, $true)
    return $Encoding.GetString((Read-ZipEntryBytes $Entry $MaximumMetadataBytes))
}

function Read-ZipEntryPrefix($Entry, [long]$Limit) {
    $Reader = $Entry.Open()
    $Memory = New-Object IO.MemoryStream
    try {
        $Buffer = New-Object byte[] 65536
        [long]$Remaining = [Math]::Min($Entry.Length, $Limit)
        while ($Remaining -gt 0) {
            $Read = $Reader.Read($Buffer, 0, [int][Math]::Min($Buffer.Length, $Remaining))
            if ($Read -le 0) { break }
            $Memory.Write($Buffer, 0, $Read)
            $Remaining -= $Read
        }
        return ,$Memory.ToArray()
    } finally {
        $Reader.Dispose()
        $Memory.Dispose()
    }
}

function Assert-X64PeEntry($Entry, [string]$Description) {
    $Bytes = Read-ZipEntryPrefix $Entry 1MB
    if ($Bytes.Length -lt 70 -or $Bytes[0] -ne 0x4d -or $Bytes[1] -ne 0x5a) {
        throw "$Description is not a Windows PE file"
    }
    $Header = [BitConverter]::ToInt32($Bytes, 0x3c)
    if ($Header -lt 64 -or $Header -gt ($Bytes.Length - 6) -or
        [BitConverter]::ToUInt32($Bytes, $Header) -ne 0x00004550 -or
        [BitConverter]::ToUInt16($Bytes, $Header + 4) -ne 0x8664) {
        throw "$Description is not an x86_64 Windows binary"
    }
}

# Counts `"<Name>":` keys of the top-level object only, so a duplicate key
# (which ConvertFrom-Json resolves silently) is refused while nested objects
# may use the same names.
function Get-TopLevelJsonKeyCount([string]$Json, [string]$Name) {
    $Depth = 0
    $Count = 0
    $Index = 0
    $Length = $Json.Length
    while ($Index -lt $Length) {
        $Character = $Json[$Index]
        if ($Character -eq [char]'"') {
            $Start = $Index + 1
            $Index++
            while ($Index -lt $Length -and $Json[$Index] -ne [char]'"') {
                if ($Json[$Index] -eq [char]'\') { $Index++ }
                $Index++
            }
            if ($Index -ge $Length) { throw "nsh/app.json is not valid JSON" }
            $Text = $Json.Substring($Start, $Index - $Start)
            $Index++
            if ($Depth -eq 1) {
                $Next = $Index
                while ($Next -lt $Length -and [char]::IsWhiteSpace($Json[$Next])) { $Next++ }
                if ($Next -lt $Length -and $Json[$Next] -eq [char]':' -and $Text -ceq $Name) {
                    $Count++
                }
            }
            continue
        }
        if ($Character -eq [char]'{' -or $Character -eq [char]'[') {
            $Depth++
        } elseif ($Character -eq [char]'}' -or $Character -eq [char]']') {
            $Depth--
        }
        $Index++
    }
    return $Count
}

function Assert-AppMetadata($Entry, [string]$ExpectedVersion) {
    $Text = Read-ZipEntryText $Entry
    foreach ($Name in @("id", "version")) {
        if ((Get-TopLevelJsonKeyCount $Text $Name) -ne 1) {
            throw "nsh/app.json must contain one $Name property"
        }
    }
    try {
        $App = $Text | ConvertFrom-Json
    } catch {
        throw "nsh/app.json is not valid JSON"
    }
    if ($null -eq $App -or $App -is [array]) { throw "nsh/app.json is not a JSON object" }
    if ($App.id -isnot [string] -or $App.id -cne $AppId) {
        throw "release archive is not Omamail: nsh/app.json id is not $AppId"
    }
    if ($App.version -isnot [string] -or $App.version -cne $ExpectedVersion) {
        throw "nsh/app.json version does not match the release archive name"
    }
}

function Open-ValidatedArchive([string]$Path, [string]$ExpectedVersion) {
    $File = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $Zip = New-Object IO.Compression.ZipArchive($File, [IO.Compression.ZipArchiveMode]::Read, $false)
    } catch {
        $File.Dispose()
        throw
    }
    try {
        if ($Zip.Entries.Count -lt 1 -or $Zip.Entries.Count -gt $MaximumEntries) {
            throw "release archive has an invalid entry count"
        }
        $Names = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        $Kinds = New-Object 'Collections.Generic.Dictionary[string,bool]' ([StringComparer]::OrdinalIgnoreCase)
        $Entries = New-Object 'Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
        [long]$Expanded = 0
        foreach ($Entry in $Zip.Entries) {
            $Name = $Entry.FullName
            Assert-SafeEntryName $Name
            if (-not $Names.Add($Name.TrimEnd('/'))) {
                throw "release archive contains duplicate paths"
            }
            $IsDirectory = $Name.EndsWith('/')
            Assert-SafeEntryType $Entry $IsDirectory
            if ($IsDirectory -and $Entry.Length -ne 0) {
                throw "release archive contains a non-empty directory entry"
            }
            if ($Entry.Length -lt 0 -or $Entry.Length -gt $MaximumEntryBytes) {
                throw "release archive contains an oversized entry"
            }
            $Expanded += $Entry.Length
            if ($Expanded -gt $MaximumExpandedBytes) {
                throw "release archive expands past its size limit"
            }
            $Kinds[$Name.TrimEnd('/')] = $IsDirectory
            $Entries[$Name] = $Entry
        }
        foreach ($Name in @($Kinds.Keys)) {
            $Parts = $Name.Split('/')
            for ($Index = 1; $Index -lt $Parts.Count; $Index++) {
                $Parent = ($Parts[0..($Index - 1)] -join '/')
                if ($Kinds.ContainsKey($Parent) -and -not $Kinds[$Parent]) {
                    throw "release archive places a child below a file"
                }
            }
        }

        $Executable = "$TopLevel/$ExecutableName"
        $AppJson = "$TopLevel/nsh/app.json"
        $Bundle = "$TopLevel/nsh/bundle.nshc"
        foreach ($RequiredName in @($Executable, $AppJson, $Bundle)) {
            if (-not $Entries.ContainsKey($RequiredName) -or $Entries[$RequiredName].Length -eq 0) {
                throw "release archive is missing $RequiredName"
            }
        }
        Assert-AppMetadata $Entries[$AppJson] $ExpectedVersion
        Assert-X64PeEntry $Entries[$Executable] $ExecutableName
        return @{ File = $File; Zip = $Zip }
    } catch {
        $Zip.Dispose()
        $File.Dispose()
        throw
    }
}

function Expand-ValidatedArchive($Opened, [string]$Destination) {
    New-Item -ItemType Directory -Force $Destination | Out-Null
    [long]$Expanded = 0
    foreach ($Entry in $Opened.Zip.Entries) {
        $Relative = $Entry.FullName.Replace([char]'/', [IO.Path]::DirectorySeparatorChar)
        $Output = [IO.Path]::GetFullPath((Join-Path $Destination $Relative))
        $Prefix = [IO.Path]::GetFullPath($Destination).TrimEnd([IO.Path]::DirectorySeparatorChar) +
            [IO.Path]::DirectorySeparatorChar
        if (-not $Output.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "release archive escaped the staging directory"
        }
        if ($Entry.FullName.EndsWith('/')) {
            New-Item -ItemType Directory -Force $Output | Out-Null
            continue
        }
        $Parent = Split-Path -Parent $Output
        New-Item -ItemType Directory -Force $Parent | Out-Null
        $Reader = $Entry.Open()
        $Target = [IO.File]::Open($Output, [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $Buffer = New-Object byte[] 65536
            [long]$Written = 0
            while (($Read = $Reader.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
                $Written += $Read
                $Expanded += $Read
                if ($Written -gt $MaximumEntryBytes -or $Expanded -gt $MaximumExpandedBytes) {
                    throw "release archive exceeded its extraction limit"
                }
                $Target.Write($Buffer, 0, $Read)
            }
            if ($Written -ne $Entry.Length) { throw "release archive entry length changed during extraction" }
        } finally {
            $Target.Dispose()
            $Reader.Dispose()
        }
    }
}

function Path-Key([string]$Value) {
    if (-not $Value) { return "" }
    return $Value.Trim().Trim('"').TrimEnd('\', '/').ToLowerInvariant()
}

function Test-ReparsePoint([string]$Path) {
    $Item = Get-Item -LiteralPath $Path -Force
    return ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
}

function Assert-SeparateRoots([string]$First, [string]$Second) {
    $A = (Path-Key $First) + '\'
    $B = (Path-Key $Second) + '\'
    if ($A.StartsWith($B) -or $B.StartsWith($A)) {
        throw "install directory overlaps the Qt-era program directory"
    }
}

# The current user's registry, below -RegistryRoot in test mode.
function Get-UserRegistryPath([string]$Subkey) {
    if ($RegistryRoot) { return "$RegistryRoot\$Subkey" }
    return $Subkey
}

function Send-EnvironmentChange {
    if ($TestMode) { return }
    try {
        if (-not ("OmamailInstaller.EnvironmentBroadcast" -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace OmamailInstaller {
    public static class EnvironmentBroadcast {
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr SendMessageTimeout(IntPtr window, uint message,
            UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);

        public static void Send() {
            UIntPtr result;
            // HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG
            SendMessageTimeout(new IntPtr(0xffff), 0x001A, UIntPtr.Zero, "Environment",
                0x0002, 5000, out result);
        }
    }
}
'@
        }
        [OmamailInstaller.EnvironmentBroadcast]::Send()
    } catch {
        # New shells still read the updated PATH from the registry.
    }
}

# Removes the Qt-era `<legacy>\bin` entry from the user PATH, keeping every
# other entry and the value's registry type (REG_EXPAND_SZ stays expandable).
function Remove-LegacyPathEntry([string]$Entry) {
    $Key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(
        (Get-UserRegistryPath "Environment"), $true)
    if (-not $Key) { return }
    $Changed = $false
    try {
        if (@($Key.GetValueNames()) -notcontains "Path") { return }
        $Kind = $Key.GetValueKind("Path")
        if ($Kind -ne [Microsoft.Win32.RegistryValueKind]::String -and
            $Kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) { return }
        $Raw = [string]$Key.GetValue("Path", "",
            [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $Target = Path-Key $Entry
        $Parts = @($Raw.Split(';'))
        $Kept = @($Parts | Where-Object {
            (Path-Key $_) -ne $Target -and
            (Path-Key ([Environment]::ExpandEnvironmentVariables($_))) -ne $Target
        })
        if ($Kept.Count -eq $Parts.Count) { return }
        $Key.SetValue("Path", ($Kept -join ';'), $Kind)
        $Changed = $true
    } finally {
        $Key.Dispose()
    }
    if ($Changed) { Send-EnvironmentChange }
}

# Removes the Qt-era toast activator only while it still launches the Qt-era
# program, so a registration that something else now owns stays.
function Remove-LegacyToastRegistration([string]$LegacyExecutable) {
    $ClassPath = Get-UserRegistryPath "Software\Classes\CLSID\$LegacyToastClsid"
    $ServerPath = "$ClassPath\LocalServer32"
    $Root = [Microsoft.Win32.Registry]::CurrentUser
    $Key = $Root.OpenSubKey($ServerPath, $false)
    if (-not $Key) { return }
    $Command = ""
    try {
        if (@($Key.GetValueNames()) -contains "") {
            $Command = [string]$Key.GetValue("", "",
                [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        }
    } finally {
        $Key.Dispose()
    }
    if (-not ($Command -match '^"([^"\r\n]+)" -ToastActivated$')) { return }
    if ((Path-Key $Matches[1]) -ne (Path-Key $LegacyExecutable)) { return }
    $Root.DeleteSubKeyTree($ServerPath, $false)
    try {
        $Root.DeleteSubKey($ClassPath, $false)
    } catch {
        # Keep a class key that has gained other subkeys.
    }
}

# Removes the Qt package's own top-level items from a Qt-era program
# directory, then the directory if nothing else is left in it.
function Remove-LegacyProgramFiles([string]$Directory) {
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return }
    if (Test-ReparsePoint $Directory) {
        throw "refusing a reparse point at the Qt-era program directory $Directory"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Directory $LegacyMarker) -PathType Leaf)) {
        return
    }
    foreach ($Name in $LegacyPackageItems) {
        $Item = Join-Path $Directory $Name
        if (-not (Test-Path -LiteralPath $Item)) { continue }
        if (Test-ReparsePoint $Item) {
            throw "refusing a reparse point in the Qt-era program directory: $Item"
        }
        Remove-Item -LiteralPath $Item -Recurse -Force
    }
    if (-not (Get-ChildItem -LiteralPath $Directory -Force | Select-Object -First 1)) {
        Remove-Item -LiteralPath $Directory -Force
    }
}

function Remove-LegacyInstall {
    $LegacyBin = Join-Path $LegacyRoot "bin"
    Remove-LegacyPathEntry $LegacyBin
    Remove-LegacyToastRegistration (Join-Path $LegacyBin "omamail-app.exe")
    Remove-LegacyProgramFiles $LegacyRoot
    Remove-LegacyProgramFiles "$LegacyRoot.previous"
    $Parent = Split-Path -Parent $LegacyRoot
    $Pattern = '^' + [regex]::Escape((Split-Path -Leaf $LegacyRoot)) + '\.new-[0-9a-f]{32}$'
    if (Test-Path -LiteralPath $Parent -PathType Container) {
        foreach ($Stale in @(Get-ChildItem -LiteralPath $Parent -Directory -Force |
                Where-Object { $_.Name -match $Pattern })) {
            Remove-LegacyProgramFiles $Stale.FullName
        }
    }
}

# Removes an Omamail program directory (or its backup), recognised by its
# executable or NSH metadata; anything else at that path is left alone.
function Remove-ProgramDirectory([string]$Directory) {
    if (-not (Test-Path -LiteralPath $Directory)) { return }
    if (Test-ReparsePoint $Directory) {
        throw "refusing a reparse point at $Directory"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Directory $ExecutableName) -PathType Leaf) -and
        -not (Test-Path -LiteralPath (Join-Path $Directory "nsh\app.json") -PathType Leaf)) {
        Write-Warning "left $Directory in place: it does not hold Omamail"
        return
    }
    Remove-Item -LiteralPath $Directory -Recurse -Force
}

function Write-Shortcut([string]$Path, [string]$Executable, [string]$WorkingDirectory,
    [string]$ApplicationId) {
    $NewShortcut = "$Path.new-$([Guid]::NewGuid().ToString('N'))"
    try {
        if (-not ("OmamailInstaller.NshShortcutWriter" -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace OmamailInstaller {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    internal class NshShellLinkObject { }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown),
     Guid("000214F9-0000-0000-C000-000000000046")]
    internal interface INshShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int maxPath,
            IntPtr findData, uint flags);
        void GetIDList(out IntPtr itemList);
        void SetIDList(IntPtr itemList);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder description,
            int maxName);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string description);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory,
            int maxPath);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments,
            int maxPath);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int showCommand);
        void SetShowCmd(int showCommand);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder iconPath,
            int iconPathLength, out int iconIndex);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int iconIndex);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown),
     Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    internal interface INshPropertyStore {
        void GetCount(out uint count);
        void GetAt(uint index, out NshPropertyKey key);
        void GetValue(ref NshPropertyKey key, out NshPropVariant value);
        void SetValue(ref NshPropertyKey key, ref NshPropVariant value);
        void Commit();
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown),
     Guid("0000010b-0000-0000-C000-000000000046")]
    internal interface INshPersistFile {
        void GetClassID(out Guid classId);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, uint mode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, bool remember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string fileName);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    internal struct NshPropertyKey {
        internal Guid formatId;
        internal uint propertyId;
        internal NshPropertyKey(Guid formatId, uint propertyId) {
            this.formatId = formatId;
            this.propertyId = propertyId;
        }
    }

    [StructLayout(LayoutKind.Explicit)]
    internal struct NshPropVariant : IDisposable {
        [FieldOffset(0)] private ushort valueType;
        [FieldOffset(8)] private IntPtr pointerValue;

        internal NshPropVariant(string value) {
            valueType = 31; // VT_LPWSTR
            pointerValue = Marshal.StringToCoTaskMemUni(value);
        }

        [DllImport("ole32.dll")]
        private static extern int PropVariantClear(ref NshPropVariant value);

        public void Dispose() { PropVariantClear(ref this); }
    }

    public static class NshShortcutWriter {
        public static void Save(string path, string target, string workingDirectory,
                                string icon, string appUserModelId) {
            object link = new NshShellLinkObject();
            try {
                INshShellLinkW shellLink = (INshShellLinkW)link;
                shellLink.SetPath(target);
                shellLink.SetWorkingDirectory(workingDirectory);
                shellLink.SetIconLocation(icon, 0);

                // PKEY_AppUserModel_ID
                NshPropertyKey key = new NshPropertyKey(
                    new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
                NshPropVariant value = new NshPropVariant(appUserModelId);
                try {
                    INshPropertyStore properties = (INshPropertyStore)link;
                    properties.SetValue(ref key, ref value);
                    properties.Commit();
                } finally {
                    value.Dispose();
                }
                ((INshPersistFile)link).Save(path, true);
            } finally {
                if (Marshal.IsComObject(link)) Marshal.FinalReleaseComObject(link);
            }
        }
    }
}
'@
        }
        [OmamailInstaller.NshShortcutWriter]::Save(
            $NewShortcut, $Executable, $WorkingDirectory, $Executable, $ApplicationId)
        Move-Item -LiteralPath $NewShortcut -Destination $Path -Force
    } finally {
        Remove-Item -LiteralPath $NewShortcut -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-Uninstall([string]$Shortcut) {
    Remove-Item -LiteralPath $Shortcut -Force -ErrorAction SilentlyContinue
    Remove-ProgramDirectory $InstallRoot
    Remove-ProgramDirectory "$InstallRoot.previous"
    Remove-LegacyInstall
    Write-Output "Omamail removed; accounts, settings and saved passwords were preserved."
}

if ($TestRedirectPolicy) {
    if (-not $TestMode -or $env:OMAMAIL_PACKAGE_TEST_MODE -ne "1" -or
        $null -eq $TestHttpHandler -or -not $RedirectStateFile) {
        throw "redirect policy testing is restricted to the isolated test harness"
    }
    Save-BoundedDownload "https://release.test/archive" $RedirectStateFile 1024 10 `
        $TestHttpHandler
    return
}

Assert-TestBoundary
$RequestedVersion = Normalize-Version $Version
Assert-X64Windows

$LocalAppData = [Environment]::GetFolderPath('LocalApplicationData')
if (-not $InstallRoot -or -not $LegacyRoot) {
    if (-not $LocalAppData) { throw "could not find the local application data folder" }
}
if (-not $InstallRoot) { $InstallRoot = Join-Path $LocalAppData "Programs\Omamail" }
if (-not $LegacyRoot) { $LegacyRoot = Join-Path $LocalAppData "omamail" }
if (-not $StartMenuRoot) {
    $StartMenuRoot = Join-Path ([Environment]::GetFolderPath('StartMenu')) "Programs"
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$LegacyRoot = [IO.Path]::GetFullPath($LegacyRoot)
$StartMenuRoot = [IO.Path]::GetFullPath($StartMenuRoot)
Assert-SeparateRoots $InstallRoot $LegacyRoot
$Executable = Join-Path $InstallRoot $ExecutableName
$Shortcut = Join-Path $StartMenuRoot "Omamail.lnk"

if ($Uninstall) {
    Invoke-Uninstall $Shortcut
    return
}

$Temp = Join-Path ([IO.Path]::GetTempPath()) ("omamail-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $Temp | Out-Null
$Opened = $null
$Candidate = ""
try {
    if ($ArchivePath) {
        if (-not $ChecksumPath) { throw "a local archive requires -ChecksumPath" }
        $ArchiveSource = (Resolve-Path -LiteralPath $ArchivePath).Path
        $SumsSource = (Resolve-Path -LiteralPath $ChecksumPath).Path
        if (-not (Test-Path -LiteralPath $ArchiveSource -PathType Leaf) -or
            (Get-Item -LiteralPath $ArchiveSource).Length -gt $MaximumArchiveBytes) {
            throw "release archive is missing or too large"
        }
        if (-not (Test-Path -LiteralPath $SumsSource -PathType Leaf) -or
            (Get-Item -LiteralPath $SumsSource).Length -gt $MaximumMetadataBytes) {
            throw "checksum file is missing or too large"
        }
        $ArchiveName = [IO.Path]::GetFileName($ArchiveSource)
        if (-not (Get-AssetVersion $ArchiveName)) {
            throw "a local archive must be named Omamail-<version>-windows-x86_64.zip"
        }
        $Archive = Join-Path $Temp "release.zip"
        $Sums = Join-Path $Temp "SHA256SUMS"
        Copy-BoundedLocalFile $ArchiveSource $Archive $MaximumArchiveBytes "release archive"
        Copy-BoundedLocalFile $SumsSource $Sums $MaximumMetadataBytes "checksum file"
    } else {
        if ($ChecksumPath) { throw "-ChecksumPath requires -ArchivePath" }
        $Base = if ($RequestedVersion -eq "latest") {
            "https://github.com/$Repository/releases/latest/download"
        } else {
            "https://github.com/$Repository/releases/download/v$RequestedVersion"
        }
        $Sums = Join-Path $Temp "SHA256SUMS"
        Save-BoundedDownload "$Base/SHA256SUMS" $Sums $MaximumMetadataBytes 60
        $ArchiveName = if ($RequestedVersion -eq "latest") {
            Select-LatestAsset $Sums
        } else {
            "Omamail-$RequestedVersion-windows-x86_64.zip"
        }
        $Archive = Join-Path $Temp "release.zip"
        Save-BoundedDownload "$Base/$ArchiveName" $Archive $MaximumArchiveBytes 300
    }
    $ArchiveVersion = Get-AssetVersion $ArchiveName
    if (-not $ArchiveVersion) { throw "unexpected release archive name: $ArchiveName" }
    if ($RequestedVersion -ne "latest" -and $ArchiveVersion -cne $RequestedVersion) {
        throw "release archive version does not match the requested version"
    }
    if (-not (Test-Path -LiteralPath $Archive -PathType Leaf) -or
        (Get-Item -LiteralPath $Archive).Length -gt $MaximumArchiveBytes) {
        throw "release archive is missing or too large"
    }
    $Expected = Get-ExpectedChecksum $Sums $ArchiveName
    $Actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Actual -cne $Expected) { throw "checksum mismatch for $ArchiveName" }

    $Opened = Open-ValidatedArchive $Archive $ArchiveVersion
    $Extracted = Join-Path $Temp "extracted"
    Expand-ValidatedArchive $Opened $Extracted
    $Opened.Zip.Dispose()
    $Opened.File.Dispose()
    $Opened = $null
    $Source = Join-Path $Extracted $TopLevel

    $Backup = "$InstallRoot.previous"
    $InstallExisted = Test-Path -LiteralPath $InstallRoot
    if ($InstallExisted -and (Test-ReparsePoint $InstallRoot)) {
        throw "refusing a reparse point at the install path"
    }
    $Candidate = "$InstallRoot.new-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force (Split-Path -Parent $InstallRoot) | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Candidate -Recurse
    if ($InstallExisted) {
        # Keep the uninstaller of an install made by NSH's setup working.
        foreach ($Uninstaller in @(Get-ChildItem -LiteralPath $InstallRoot -File -Force |
                Where-Object { $_.Name -match '^unins[0-9]{3}\.(exe|dat|msg)$' })) {
            $Destination = Join-Path $Candidate $Uninstaller.Name
            if (-not (Test-Path -LiteralPath $Destination)) {
                Copy-Item -LiteralPath $Uninstaller.FullName -Destination $Destination
            }
        }
    }
    $ShortcutExisted = Test-Path -LiteralPath $Shortcut -PathType Leaf
    $ShortcutBackup = Join-Path $Temp "previous-shortcut.lnk"
    if ($ShortcutExisted) { Copy-Item -LiteralPath $Shortcut -Destination $ShortcutBackup }
    $StartMenuExisted = Test-Path -LiteralPath $StartMenuRoot -PathType Container

    if (Test-Path -LiteralPath $Backup) {
        if (Test-ReparsePoint $Backup) {
            throw "refusing a reparse point at the previous-install path"
        }
        Remove-Item -LiteralPath $Backup -Recurse -Force
    }
    $MovedOldInstall = $false
    $InstalledNew = $false
    try {
        if ($InstallExisted) {
            try {
                Move-Item -LiteralPath $InstallRoot -Destination $Backup
            } catch {
                throw "could not replace $InstallRoot; quit Omamail and run the installer again ($($_.Exception.Message))"
            }
            $MovedOldInstall = $true
        }
        Move-Item -LiteralPath $Candidate -Destination $InstallRoot
        $InstalledNew = $true
        if ($TestFailure -eq "AfterInstall") { throw "synthetic failure after install" }

        New-Item -ItemType Directory -Force $StartMenuRoot | Out-Null
        Write-Shortcut $Shortcut $Executable $InstallRoot $AppId
        if ($TestFailure -eq "AfterShortcut") { throw "synthetic failure after shortcut update" }
    } catch {
        $InstallFailure = $_
        $RollbackFailures = New-Object 'Collections.Generic.List[string]'
        try {
            Remove-Item -LiteralPath $Shortcut -Force -ErrorAction SilentlyContinue
            if ($ShortcutExisted -and (Test-Path -LiteralPath $ShortcutBackup -PathType Leaf)) {
                Copy-Item -LiteralPath $ShortcutBackup -Destination $Shortcut -Force
            } elseif (-not $StartMenuExisted -and (Test-Path -LiteralPath $StartMenuRoot)) {
                Remove-Item -LiteralPath $StartMenuRoot -Force -ErrorAction Stop
            }
        } catch {
            $RollbackFailures.Add("Start Menu shortcut: $($_.Exception.Message)")
        }
        try {
            if ($InstalledNew) {
                Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction Stop
            }
            if ($MovedOldInstall -and (Test-Path -LiteralPath $Backup)) {
                Move-Item -LiteralPath $Backup -Destination $InstallRoot
            }
        } catch {
            $RollbackFailures.Add("program files: $($_.Exception.Message)")
        }
        if ($RollbackFailures.Count -ne 0) {
            throw "installation failed ($($InstallFailure.Exception.Message)); rollback failed: $($RollbackFailures -join '; ')"
        }
        throw $InstallFailure
    }
    Remove-Item -LiteralPath $Backup -Recurse -Force -ErrorAction SilentlyContinue
    try {
        Remove-LegacyInstall
    } catch {
        Write-Warning "Omamail is installed, but the previous Qt-based version could not be fully removed: $($_.Exception.Message)"
    }
    Write-Output "Omamail $ArchiveVersion installed at $InstallRoot"
    Write-Output "Start it from the Start menu; Omamail checks for updates itself."
} finally {
    if ($Opened) {
        $Opened.Zip.Dispose()
        $Opened.File.Dispose()
    }
    if ($Candidate) {
        Remove-Item -LiteralPath $Candidate -Recurse -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
}
