param(
    [string]$Version = "latest",
    [switch]$Uninstall,
    [string]$ArchivePath = "",
    [string]$ChecksumPath = "",
    [string]$InstallRoot = "",
    [string]$StartMenuRoot = "",
    [switch]$TestMode,
    [string]$TestArchitecture = "",
    [string]$PathStateFile = "",
    [string]$RegistryStateFile = "",
    [switch]$TestRedirectPolicy,
    [object]$TestHttpHandler = $null,
    [string]$RedirectStateFile = "",
    [ValidateSet("", "AfterInstall", "AfterPath", "AfterRegistration", "AfterShortcut")]
    [string]$TestFailure = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Repository = "huacnlee/omamail"
$Asset = "omamail-app-windows-x86_64.zip"
$ExpectedTarget = "windows-x86_64"
$AppUserModelId = "com.omamail.app"
$ToastActivatorClsid = "{6E420BBE-A800-4FF9-BD65-472CC53922CA}"
$ToastClassSubkey = "Software\Classes\CLSID\$ToastActivatorClsid"
$ToastServerSubkey = "$ToastClassSubkey\LocalServer32"
$MaximumArchiveBytes = 2GB
$MaximumEntries = 4096
$MaximumEntryBytes = 512MB
$MaximumExpandedBytes = 2GB
$MaximumMetadataBytes = 1MB

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
    $Input = $null
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
        $Input = $Response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $Output = [IO.File]::Open($Path, [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write, [IO.FileShare]::None)
        $Buffer = New-Object byte[] 65536
        [long]$Total = 0
        while (($Read = $Input.ReadAsync($Buffer, 0, $Buffer.Length,
                    $Cancellation.Token).GetAwaiter().GetResult()) -gt 0) {
            $Total += $Read
            if ($Total -gt $Limit) { throw "release download is too large" }
            $Output.Write($Buffer, 0, $Read)
        }
    } finally {
        if ($Output) { $Output.Dispose() }
        if ($Input) { $Input.Dispose() }
        if ($Response) { $Response.Dispose() }
        $Cancellation.Dispose()
        $Client.Dispose()
        if ($OwnHandler) { $Handler.Dispose() }
    }
}

function Copy-BoundedLocalFile([string]$Source, [string]$Destination, [long]$Limit,
    [string]$Description) {
    $Input = [IO.File]::Open($Source, [IO.FileMode]::Open, [IO.FileAccess]::Read,
        [IO.FileShare]::Read)
    $Output = $null
    try {
        if ($Input.Length -gt $Limit) { throw "$Description is too large" }
        $Output = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write, [IO.FileShare]::None)
        $Buffer = New-Object byte[] 65536
        [long]$Total = 0
        while (($Read = $Input.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
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
        $Input.Dispose()
    }
}

function Assert-TestBoundary {
    if (-not $TestMode) {
        if ($TestArchitecture -or $PathStateFile -or $RegistryStateFile -or $TestFailure -or
            $TestRedirectPolicy -or $TestHttpHandler -or $RedirectStateFile) {
            throw "test-only arguments require -TestMode"
        }
        if ($env:OS -ne "Windows_NT") { throw "Omamail supports this installer only on Windows" }
        return
    }
    if ($env:OMAMAIL_PACKAGE_TEST_MODE -ne "1") {
        throw "-TestMode is restricted to the package test harness"
    }
    if (-not $InstallRoot -or -not $StartMenuRoot -or -not $PathStateFile -or
        -not $RegistryStateFile -or
        -not $TestArchitecture -or
        (-not $Uninstall -and (-not $ArchivePath -or -not $ChecksumPath))) {
        throw "-TestMode requires isolated archive, checksum, install, Start Menu, PATH, and architecture inputs"
    }
}

function Normalize-Version([string]$Value) {
    if ($Value -eq "latest") { return "latest" }
    $Normalized = if ($Value.StartsWith('v')) { $Value.Substring(1) } else { $Value }
    if ($Normalized -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$') {
        throw "invalid release version: $Value"
    }
    return $Normalized
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

function Get-ExpectedChecksum([string]$Path, [string]$ArchiveName) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "checksum file is missing: $Path"
    }
    if ((Get-Item -LiteralPath $Path).Length -gt $MaximumMetadataBytes) {
        throw "checksum file is too large"
    }
    $Digests = @()
    foreach ($Line in (Get-Content -LiteralPath $Path)) {
        if ($Line -match '^([0-9A-Fa-f]{64})\s+\*?(.+)$' -and $Matches[2] -ceq $ArchiveName) {
            $Digests += $Matches[1].ToLowerInvariant()
        }
    }
    if ($Digests.Count -ne 1) {
        throw "SHA256SUMS must contain exactly one entry for $ArchiveName"
    }
    return $Digests[0]
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
    if ($Parts.Count -lt 1 -or $Parts[0] -cne "omamail") {
        throw "release archive must contain one omamail top-level directory"
    }
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
    $Input = $Entry.Open()
    $Memory = New-Object IO.MemoryStream
    try {
        $Buffer = New-Object byte[] 65536
        [long]$Total = 0
        while (($Read = $Input.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
            $Total += $Read
            if ($Total -gt $Limit) { throw "release metadata is too large" }
            $Memory.Write($Buffer, 0, $Read)
        }
        return ,$Memory.ToArray()
    } finally {
        $Input.Dispose()
        $Memory.Dispose()
    }
}

function Read-ZipEntryText($Entry) {
    $Encoding = New-Object Text.UTF8Encoding($false, $true)
    return $Encoding.GetString((Read-ZipEntryBytes $Entry $MaximumMetadataBytes))
}

function Read-ZipEntryPrefix($Entry, [long]$Limit) {
    $Input = $Entry.Open()
    $Memory = New-Object IO.MemoryStream
    try {
        $Buffer = New-Object byte[] 65536
        [long]$Remaining = [Math]::Min($Entry.Length, $Limit)
        while ($Remaining -gt 0) {
            $Read = $Input.Read($Buffer, 0, [int][Math]::Min($Buffer.Length, $Remaining))
            if ($Read -le 0) { break }
            $Memory.Write($Buffer, 0, $Read)
            $Remaining -= $Read
        }
        return ,$Memory.ToArray()
    } finally {
        $Input.Dispose()
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

function Test-JsonPropertyOnce([string]$Json, [string]$Name) {
    return [regex]::Matches($Json, ('"' + [regex]::Escape($Name) + '"\s*:'),
        [Text.RegularExpressions.RegexOptions]::IgnoreCase).Count -eq 1
}

function Assert-ReleaseMetadata($ReleaseEntry, $ManifestEntry, [string]$RequestedVersion) {
    $ReleaseText = Read-ZipEntryText $ReleaseEntry
    foreach ($Name in @("schemaVersion", "name", "version", "target", "topLevel")) {
        if (-not (Test-JsonPropertyOnce $ReleaseText $Name)) {
            throw "release.json must contain one $Name property"
        }
    }
    $Release = $ReleaseText | ConvertFrom-Json
    $PropertyNames = @($Release.PSObject.Properties | ForEach-Object { $_.Name })
    $UnexpectedProperties = @($PropertyNames | Where-Object {
        $_ -cnotin @("schemaVersion", "name", "version", "target", "topLevel")
    })
    if ($PropertyNames.Count -ne 5 -or $UnexpectedProperties.Count -ne 0) {
        throw "release.json has an unexpected schema"
    }
    $SchemaIsInteger = $Release.schemaVersion -is [int] -or $Release.schemaVersion -is [long]
    if (-not $SchemaIsInteger -or $Release.schemaVersion -ne 1 -or
        $Release.name -isnot [string] -or $Release.name -cne "omamail" -or
        $Release.target -isnot [string] -or $Release.target -cne $ExpectedTarget -or
        $Release.topLevel -isnot [string] -or $Release.topLevel -cne "omamail") {
        throw "release.json does not describe the Windows x86_64 Omamail package"
    }
    if ($Release.version -isnot [string]) { throw "release archive version must be a string" }
    $ArchiveVersion = $Release.version
    if ($ArchiveVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$' -or
        ($RequestedVersion -ne "latest" -and $ArchiveVersion -cne $RequestedVersion)) {
        throw "release archive version does not match the requested version"
    }

    $ManifestText = Read-ZipEntryText $ManifestEntry
    if (-not (Test-JsonPropertyOnce $ManifestText "version")) {
        throw "manifest must contain one version property"
    }
    $Manifest = $ManifestText | ConvertFrom-Json
    if ($Manifest.version -isnot [string] -or $Manifest.version -cne $ArchiveVersion) {
        throw "manifest version does not match release.json"
    }
}

function Open-ValidatedArchive([string]$Path, [string]$RequestedVersion) {
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

        $Required = @(
            "omamail/release.json",
            "omamail/manifest.json",
            "omamail/app-icon.ico",
            "omamail/bin/omamail-app.exe",
            "omamail/bin/omamail.exe",
            "omamail/qml/Main.qml",
            "omamail/ui/Service.qml",
            "omamail/bin/platforms/qwindows.dll"
        )
        $Entries = @{}
        foreach ($Entry in $Zip.Entries) { $Entries[$Entry.FullName.ToLowerInvariant()] = $Entry }
        foreach ($RequiredName in $Required) {
            if (-not $Entries.ContainsKey($RequiredName) -or $Entries[$RequiredName].Length -eq 0) {
                throw "release archive is missing $RequiredName"
            }
        }
        Assert-ReleaseMetadata $Entries["omamail/release.json"] `
            $Entries["omamail/manifest.json"] $RequestedVersion
        Assert-X64PeEntry $Entries["omamail/bin/omamail-app.exe"] "standalone host"
        Assert-X64PeEntry $Entries["omamail/bin/omamail.exe"] "backend"
        Assert-X64PeEntry $Entries["omamail/bin/platforms/qwindows.dll"] "Qt platform plugin"
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
        $Input = $Entry.Open()
        $Target = [IO.File]::Open($Output, [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $Buffer = New-Object byte[] 65536
            [long]$Written = 0
            while (($Read = $Input.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
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
            $Input.Dispose()
        }
    }
}

function Get-PathValue {
    if ($TestMode) {
        if (-not (Test-Path -LiteralPath $PathStateFile)) { return "" }
        return [IO.File]::ReadAllText($PathStateFile)
    }
    return [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::User)
}

function Set-PathValue([AllowEmptyString()][string]$Value) {
    if ($TestMode) {
        [IO.File]::WriteAllText($PathStateFile, $Value, (New-Object Text.UTF8Encoding($false)))
    } else {
        [Environment]::SetEnvironmentVariable("Path", $Value, [EnvironmentVariableTarget]::User)
    }
}

function Path-Key([string]$Value) {
    if (-not $Value) { return "" }
    return $Value.Trim().Trim('"').TrimEnd('\', '/').ToLowerInvariant()
}

function Add-PathEntry([string]$Value, [string]$Entry) {
    $Parts = @(if ($Value) { $Value.Split(';') | Where-Object { $_ } })
    $Key = Path-Key $Entry
    if (-not @($Parts | Where-Object { (Path-Key $_) -eq $Key }).Count) { $Parts += $Entry }
    return ($Parts -join ';')
}

function Remove-PathEntry([string]$Value, [string]$Entry) {
    $Key = Path-Key $Entry
    return (@($Value.Split(';') | Where-Object { $_ -and (Path-Key $_) -ne $Key }) -join ';')
}

function Get-ToastRegistration {
    if ($TestMode) {
        $Exists = Test-Path -LiteralPath $RegistryStateFile -PathType Leaf
        return @{
            ClassExisted = $Exists
            ServerKeyExisted = $Exists
            ValueExisted = $Exists
            Value = if ($Exists) { [IO.File]::ReadAllText($RegistryStateFile) } else { $null }
            Kind = [Microsoft.Win32.RegistryValueKind]::String
        }
    }
    $Class = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($ToastClassSubkey, $false)
    $ClassExisted = $null -ne $Class
    if ($Class) { $Class.Dispose() }
    $Key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($ToastServerSubkey, $false)
    if (-not $Key) {
        return @{
            ClassExisted = $ClassExisted
            ServerKeyExisted = $false
            ValueExisted = $false
            Value = $null
            Kind = [Microsoft.Win32.RegistryValueKind]::String
        }
    }
    try {
        $ValueExisted = @($Key.GetValueNames()) -contains ""
        return @{
            ClassExisted = $ClassExisted
            ServerKeyExisted = $true
            ValueExisted = $ValueExisted
            Value = if ($ValueExisted) {
                $Key.GetValue("", $null,
                    [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            } else { $null }
            Kind = if ($ValueExisted) {
                $Key.GetValueKind("")
            } else { [Microsoft.Win32.RegistryValueKind]::String }
        }
    } finally {
        $Key.Dispose()
    }
}

function Set-ToastRegistration([string]$Command) {
    if ($TestMode) {
        [IO.File]::WriteAllText($RegistryStateFile, $Command,
            (New-Object Text.UTF8Encoding($false)))
        return
    }
    $Key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($ToastServerSubkey, $true)
    if (-not $Key) { throw "could not create the toast activation registration" }
    try {
        $Key.SetValue("", $Command, [Microsoft.Win32.RegistryValueKind]::String)
    } finally {
        $Key.Dispose()
    }
}

function Remove-EmptyToastClass {
    if ($TestMode) { return }
    try {
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($ToastClassSubkey, $false)
    } catch {
        # Preserve a class key if another value or subkey exists.
    }
}

function Restore-ToastRegistration($Snapshot) {
    if ($TestMode) {
        if ($Snapshot.ValueExisted) {
            [IO.File]::WriteAllText($RegistryStateFile, [string]$Snapshot.Value,
                (New-Object Text.UTF8Encoding($false)))
        } else {
            Remove-Item -LiteralPath $RegistryStateFile -Force -ErrorAction SilentlyContinue
        }
        return
    }
    if (-not $Snapshot.ServerKeyExisted) {
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($ToastServerSubkey, $false)
        if (-not $Snapshot.ClassExisted) { Remove-EmptyToastClass }
        return
    }
    $Key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($ToastServerSubkey, $true)
    if (-not $Key) { throw "could not restore the toast activation registration" }
    try {
        if ($Snapshot.ValueExisted) {
            $Key.SetValue("", $Snapshot.Value, $Snapshot.Kind)
        } else {
            $Key.DeleteValue("", $false)
        }
    } finally {
        $Key.Dispose()
    }
}

function Get-RegisteredToastExecutable([string]$Command) {
    if ($Command -match '^"([^"\r\n]+)" -ToastActivated$') { return $Matches[1] }
    return ""
}

function Remove-OwnedToastRegistration([string]$Executable) {
    $Snapshot = Get-ToastRegistration
    if (-not $Snapshot.ValueExisted) { return }
    $Registered = Get-RegisteredToastExecutable ([string]$Snapshot.Value)
    if ((Path-Key $Registered) -ne (Path-Key $Executable)) { return }
    if ($TestMode) {
        Remove-Item -LiteralPath $RegistryStateFile -Force -ErrorAction SilentlyContinue
        return
    }
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($ToastServerSubkey, $false)
    Remove-EmptyToastClass
}

function Write-Shortcut([string]$Path, [string]$Executable, [string]$WorkingDirectory,
    [string]$Icon, [string]$ApplicationId, [string]$ActivatorClsid) {
    $NewShortcut = "$Path.new-$([Guid]::NewGuid().ToString('N'))"
    try {
        if ($TestMode -and $env:OS -ne "Windows_NT") {
            [IO.File]::WriteAllText($NewShortcut,
                "target=$Executable`nworkingDirectory=$WorkingDirectory`nicon=$Icon`nappUserModelId=$ApplicationId`ntoastActivatorClsid=$ActivatorClsid`n",
                (New-Object Text.UTF8Encoding($false)))
        } else {
            if (-not ("OmamailInstaller.ShortcutWriter" -as [type])) {
                Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace OmamailInstaller {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    internal class ShellLinkObject { }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown),
     Guid("000214F9-0000-0000-C000-000000000046")]
    internal interface IShellLinkW {
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
    internal interface IPropertyStore {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown),
     Guid("0000010b-0000-0000-C000-000000000046")]
    internal interface IPersistFile {
        void GetClassID(out Guid classId);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, uint mode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, bool remember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string fileName);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    internal struct PropertyKey {
        internal Guid formatId;
        internal uint propertyId;
        internal PropertyKey(Guid formatId, uint propertyId) {
            this.formatId = formatId;
            this.propertyId = propertyId;
        }
    }

    [StructLayout(LayoutKind.Explicit)]
    internal struct PropVariant : IDisposable {
        [FieldOffset(0)] private ushort valueType;
        [FieldOffset(8)] private IntPtr pointerValue;

        internal PropVariant(string value) {
            valueType = 31; // VT_LPWSTR
            pointerValue = Marshal.StringToCoTaskMemUni(value);
        }

        internal PropVariant(Guid value) {
            valueType = 72; // VT_CLSID
            pointerValue = Marshal.AllocCoTaskMem(Marshal.SizeOf(typeof(Guid)));
            Marshal.StructureToPtr(value, pointerValue, false);
        }

        [DllImport("ole32.dll")]
        private static extern int PropVariantClear(ref PropVariant value);

        public void Dispose() { PropVariantClear(ref this); }
    }

    public static class ShortcutWriter {
        public static void Save(string path, string target, string workingDirectory,
                                string icon, string appUserModelId,
                                string toastActivatorClsid) {
            object link = new ShellLinkObject();
            try {
                IShellLinkW shellLink = (IShellLinkW)link;
                shellLink.SetPath(target);
                shellLink.SetWorkingDirectory(workingDirectory);
                shellLink.SetIconLocation(icon, 0);

                PropertyKey key = new PropertyKey(
                    new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
                PropVariant value = new PropVariant(appUserModelId);
                PropertyKey activatorKey = new PropertyKey(
                    new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 26);
                PropVariant activatorValue = new PropVariant(new Guid(toastActivatorClsid));
                try {
                    IPropertyStore properties = (IPropertyStore)link;
                    properties.SetValue(ref key, ref value);
                    properties.SetValue(ref activatorKey, ref activatorValue);
                    properties.Commit();
                } finally {
                    activatorValue.Dispose();
                    value.Dispose();
                }
                ((IPersistFile)link).Save(path, true);
            } finally {
                if (Marshal.IsComObject(link)) Marshal.FinalReleaseComObject(link);
            }
        }
    }
}
'@
            }
            [OmamailInstaller.ShortcutWriter]::Save(
                $NewShortcut, $Executable, $WorkingDirectory, $Icon, $ApplicationId,
                $ActivatorClsid)
        }
        Move-Item -LiteralPath $NewShortcut -Destination $Path -Force
    } finally {
        Remove-Item -LiteralPath $NewShortcut -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-Uninstall([string]$ProgramRoot, [string]$ProgramBin, [string]$HostExecutable,
    [string]$ShortcutPath) {
    $CurrentPath = Get-PathValue
    Set-PathValue (Remove-PathEntry $CurrentPath $ProgramBin)
    Remove-OwnedToastRegistration $HostExecutable
    Remove-Item -LiteralPath $ShortcutPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $ProgramRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "$ProgramRoot.previous" -Recurse -Force -ErrorAction SilentlyContinue
    Write-Output "Omamail removed; user data was preserved."
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

if (-not $InstallRoot) {
    $InstallRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "omamail"
}
if (-not $StartMenuRoot) {
    $StartMenuRoot = Join-Path ([Environment]::GetFolderPath('StartMenu')) "Programs"
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$BinDir = Join-Path $InstallRoot "bin"
$HostExecutable = Join-Path $BinDir "omamail-app.exe"
if ($HostExecutable.Contains('"') -or (Test-ControlCharacter $HostExecutable)) {
    throw "install path cannot be safely registered for toast activation"
}
$StartMenuRoot = [IO.Path]::GetFullPath($StartMenuRoot)
$Shortcut = Join-Path $StartMenuRoot "Omamail.lnk"

if ($Uninstall) {
    Invoke-Uninstall $InstallRoot $BinDir $HostExecutable $Shortcut
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
        $Archive = Join-Path $Temp "local-release.zip"
        $Sums = Join-Path $Temp "local.SHA256SUMS"
        Copy-BoundedLocalFile $ArchiveSource $Archive $MaximumArchiveBytes "release archive"
        Copy-BoundedLocalFile $SumsSource $Sums $MaximumMetadataBytes "checksum file"
    } else {
        if ($ChecksumPath) { throw "-ChecksumPath requires -ArchivePath" }
        $Tag = if ($RequestedVersion -eq "latest") { "latest" } else { "v$RequestedVersion" }
        $Base = if ($Tag -eq "latest") {
            "https://github.com/$Repository/releases/latest/download"
        } else {
            "https://github.com/$Repository/releases/download/$Tag"
        }
        $Archive = Join-Path $Temp $Asset
        $Sums = Join-Path $Temp "SHA256SUMS"
        $ArchiveName = $Asset
        Save-BoundedDownload "$Base/$Asset" $Archive $MaximumArchiveBytes 300
        Save-BoundedDownload "$Base/SHA256SUMS" $Sums $MaximumMetadataBytes 60
    }
    if (-not (Test-Path -LiteralPath $Archive -PathType Leaf) -or
        (Get-Item -LiteralPath $Archive).Length -gt $MaximumArchiveBytes) {
        throw "release archive is missing or too large"
    }
    $Expected = Get-ExpectedChecksum $Sums $ArchiveName
    $Actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Actual -cne $Expected) { throw "checksum mismatch for $ArchiveName" }

    $Opened = Open-ValidatedArchive $Archive $RequestedVersion
    $Extracted = Join-Path $Temp "extracted"
    Expand-ValidatedArchive $Opened $Extracted
    $Opened.Zip.Dispose()
    $Opened.File.Dispose()
    $Opened = $null
    $Source = Join-Path $Extracted "omamail"

    $Backup = "$InstallRoot.previous"
    $Candidate = "$InstallRoot.new-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force (Split-Path -Parent $InstallRoot) | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Candidate -Recurse
    $OriginalPath = Get-PathValue
    $OriginalToastRegistration = Get-ToastRegistration
    $ShortcutExisted = Test-Path -LiteralPath $Shortcut -PathType Leaf
    $ShortcutBackup = Join-Path $Temp "previous-shortcut.lnk"
    if ($ShortcutExisted) { Copy-Item -LiteralPath $Shortcut -Destination $ShortcutBackup }
    $StartMenuExisted = Test-Path -LiteralPath $StartMenuRoot -PathType Container

    if (Test-Path -LiteralPath $Backup) {
        $BackupItem = Get-Item -LiteralPath $Backup -Force
        if (($BackupItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "refusing a reparse point at the previous-install path"
        }
        Remove-Item -LiteralPath $Backup -Recurse -Force
    }
    $MovedOldInstall = $false
    $InstalledNew = $false
    try {
        if (Test-Path -LiteralPath $InstallRoot) {
            $InstallItem = Get-Item -LiteralPath $InstallRoot -Force
            if (($InstallItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "refusing a reparse point at the install path"
            }
            Move-Item -LiteralPath $InstallRoot -Destination $Backup
            $MovedOldInstall = $true
        }
        Move-Item -LiteralPath $Candidate -Destination $InstallRoot
        $InstalledNew = $true
        if ($TestFailure -eq "AfterInstall") { throw "synthetic failure after install" }

        Set-PathValue (Add-PathEntry $OriginalPath $BinDir)
        if ($TestFailure -eq "AfterPath") { throw "synthetic failure after PATH update" }

        $ToastCommand = '"' + $HostExecutable + '" -ToastActivated'
        Set-ToastRegistration $ToastCommand
        if ($TestFailure -eq "AfterRegistration") {
            throw "synthetic failure after toast registration"
        }

        New-Item -ItemType Directory -Force $StartMenuRoot | Out-Null
        Write-Shortcut $Shortcut $HostExecutable $InstallRoot `
            (Join-Path $InstallRoot "app-icon.ico") $AppUserModelId $ToastActivatorClsid
        if ($TestFailure -eq "AfterShortcut") { throw "synthetic failure after shortcut update" }
    } catch {
        $InstallFailure = $_
        $RollbackFailures = New-Object 'Collections.Generic.List[string]'
        try { Set-PathValue $OriginalPath } catch {
            $RollbackFailures.Add("PATH: $($_.Exception.Message)")
        }
        try { Restore-ToastRegistration $OriginalToastRegistration } catch {
            $RollbackFailures.Add("toast registration: $($_.Exception.Message)")
        }
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
    Write-Output "Omamail installed at $InstallRoot"
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
