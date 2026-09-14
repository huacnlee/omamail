$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Net.Http

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Installer = Join-Path $RepoRoot "install.ps1"
$Temp = Join-Path ([IO.Path]::GetTempPath()) ("omamail-install-test-" + [Guid]::NewGuid().ToString('N'))
$Utf8 = New-Object Text.UTF8Encoding($false)

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

if (-not ("OmamailInstallerTests.DowngradeRedirectHandler" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace OmamailInstallerTests {
    public sealed class DowngradeRedirectHandler : HttpMessageHandler {
        public readonly List<string> Requests = new List<string>();

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken) {
            Requests.Add(request.RequestUri.AbsoluteUri);
            HttpResponseMessage response = new HttpResponseMessage(HttpStatusCode.Redirect);
            response.Headers.Location = new Uri("http://downgrade.test/payload");
            return Task.FromResult(response);
        }
    }
}
'@
}

function Utf8([string]$Text) { return ,$Utf8.GetBytes($Text) }

function Write-MarkerExecutable([string]$Path) {
    if ($env:OS -ne "Windows_NT") {
        $Bytes = New-Object byte[] 512
        $Bytes[0] = 0x4d
        $Bytes[1] = 0x5a
        [BitConverter]::GetBytes([int]128).CopyTo($Bytes, 0x3c)
        $Bytes[128] = 0x50
        $Bytes[129] = 0x45
        $Bytes[132] = 0x64
        $Bytes[133] = 0x86
        [IO.File]::WriteAllBytes($Path, $Bytes)
        return
    }
    $Source = @'
using System;
using System.IO;
public static class Program {
    public static int Main() {
        string marker = Environment.GetEnvironmentVariable("OMAMAIL_TEST_LAUNCH_MARKER");
        if (!String.IsNullOrEmpty(marker)) File.WriteAllText(marker, "launched");
        return 0;
    }
}
'@
    $SourcePath = "$Path.cs"
    [IO.File]::WriteAllText($SourcePath, $Source, $Utf8)
    $Compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    if (-not (Test-Path -LiteralPath $Compiler -PathType Leaf)) {
        throw "64-bit C# compiler is unavailable: $Compiler"
    }
    & $Compiler /nologo /target:exe /platform:x64 "/out:$Path" $SourcePath
    if ($LASTEXITCODE -ne 0) { throw "failed to compile the launch marker fixture" }
}

function Entry([string]$Name, [byte[]]$Bytes, $ExternalAttributes = $null) {
    return [pscustomobject]@{
        Name = $Name
        Bytes = $Bytes
        ExternalAttributes = $ExternalAttributes
    }
}

function Release-Bytes([string]$Version, [string]$Target = "windows-x86_64") {
    return Utf8 (([ordered]@{
        schemaVersion = 1
        name = "omamail"
        version = $Version
        target = $Target
        topLevel = "omamail"
    } | ConvertTo-Json) + "`n")
}

function Base-Entries([byte[]]$Executable, [string]$Version = "1.2.3",
    [string]$Target = "windows-x86_64") {
    return @(
        (Entry "omamail/release.json" (Release-Bytes $Version $Target)),
        (Entry "omamail/manifest.json" (Utf8 ('{"version":"' + $Version + '"}'))),
        (Entry "omamail/app-icon.ico" ([byte[]](0, 0, 1, 0))),
        (Entry "omamail/bin/omamail-app.exe" $Executable),
        (Entry "omamail/bin/omamail.exe" $Executable),
        (Entry "omamail/qml/Main.qml" (Utf8 "import QtQuick`nItem {}`n")),
        (Entry "omamail/ui/Service.qml" (Utf8 "import QtQuick`nQtObject {}`n")),
        (Entry "omamail/bin/platforms/qwindows.dll" $Executable)
    )
}

function New-TestArchive([string]$Name, [object[]]$Entries) {
    $Directory = Join-Path $Temp "archives"
    New-Item -ItemType Directory -Force $Directory | Out-Null
    $Archive = Join-Path $Directory ($Name + ".zip")
    Remove-Item -LiteralPath $Archive -Force -ErrorAction SilentlyContinue
    $Stream = [IO.File]::Open($Archive, [IO.FileMode]::CreateNew,
        [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $Zip = New-Object IO.Compression.ZipArchive($Stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($Value in $Entries) {
            $ZipEntry = $Zip.CreateEntry($Value.Name, [IO.Compression.CompressionLevel]::Optimal)
            if ($null -ne $Value.ExternalAttributes) {
                $ZipEntry.ExternalAttributes = [int32]$Value.ExternalAttributes
            }
            $Output = $ZipEntry.Open()
            try { $Output.Write($Value.Bytes, 0, $Value.Bytes.Length) } finally { $Output.Dispose() }
        }
    } finally {
        $Zip.Dispose()
        $Stream.Dispose()
    }
    $Sums = "$Archive.SHA256SUMS"
    $Hash = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($Sums, "$Hash *$([IO.Path]::GetFileName($Archive))`n", $Utf8)
    return @{ Archive = $Archive; Sums = $Sums }
}

function Remove-Entry([object[]]$Entries, [string]$Name) {
    return @($Entries | Where-Object { $_.Name -cne $Name })
}

function Replace-Entry([object[]]$Entries, [string]$Name, [byte[]]$Bytes) {
    return @($Entries | ForEach-Object {
        if ($_.Name -ceq $Name) { Entry $Name $Bytes $_.ExternalAttributes } else { $_ }
    })
}

function Invalid-Case([string]$Name, [object[]]$Entries, [string]$Pattern) {
    return [pscustomobject]@{ Name = $Name; Entries = $Entries; Pattern = $Pattern }
}

function Invoke-TestInstall($Bundle, [hashtable]$Overrides = @{}) {
    $Arguments = @{
        Version = "1.2.3"
        ArchivePath = $Bundle.Archive
        ChecksumPath = $Bundle.Sums
        InstallRoot = $script:InstallRoot
        StartMenuRoot = $script:StartMenuRoot
        TestMode = $true
        TestArchitecture = "AMD64"
        PathStateFile = $script:PathState
        RegistryStateFile = $script:RegistryState
    }
    foreach ($Key in $Overrides.Keys) { $Arguments[$Key] = $Overrides[$Key] }
    & $Installer @Arguments | Out-Null
}

function Expect-InstallFailure($Bundle, [string]$Pattern, [hashtable]$Overrides = @{}) {
    try {
        Invoke-TestInstall $Bundle $Overrides
        throw "expected install failure matching: $Pattern"
    } catch {
        if ($_.Exception.Message -notmatch $Pattern) { throw }
    }
}

function Reset-OldInstallation {
    Remove-Item -LiteralPath $script:InstallRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "$script:InstallRoot.previous" -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:StartMenuRoot -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force $script:InstallRoot, $script:StartMenuRoot | Out-Null
    [IO.File]::WriteAllText((Join-Path $script:InstallRoot "old.txt"), "old", $Utf8)
    [IO.File]::WriteAllText((Join-Path $script:StartMenuRoot "Omamail.lnk"), "old shortcut", $Utf8)
    [IO.File]::WriteAllText($script:PathState, "C:\Tools", $Utf8)
    [IO.File]::WriteAllText($script:RegistryState, '"C:\Old\omamail-app.exe" -ToastActivated', $Utf8)
}

function Assert-NoMutation([string]$Case) {
    Assert-True (Test-Path -LiteralPath (Join-Path $script:InstallRoot "old.txt") -PathType Leaf) `
        "$Case replaced the prior installation"
    Assert-True ([IO.File]::ReadAllText((Join-Path $script:StartMenuRoot "Omamail.lnk")) -ceq "old shortcut") `
        "$Case changed the Start Menu shortcut"
    Assert-True ([IO.File]::ReadAllText($script:PathState) -ceq "C:\Tools") `
        "$Case changed the user PATH"
    Assert-True ([IO.File]::ReadAllText($script:RegistryState) -ceq `
        '"C:\Old\omamail-app.exe" -ToastActivated') "$Case changed the toast registration"
    Assert-True (-not (Test-Path -LiteralPath "$script:InstallRoot.previous")) `
        "$Case left an installation backup"
    Assert-True (-not (Test-Path -LiteralPath $script:LaunchMarker)) `
        "$Case launched the application"
}

New-Item -ItemType Directory -Force $Temp | Out-Null
try {
    $env:OMAMAIL_PACKAGE_TEST_MODE = "1"
    $RedirectHandler = New-Object OmamailInstallerTests.DowngradeRedirectHandler
    $RedirectOutput = Join-Path $Temp "redirect-download"
    try {
        & $Installer -TestMode -TestRedirectPolicy -TestHttpHandler $RedirectHandler `
            -RedirectStateFile $RedirectOutput
        throw "HTTPS downgrade redirect was accepted"
    } catch {
        if ($_.Exception.Message -notmatch 'redirected outside HTTPS') { throw }
    }
    Assert-True ($RedirectHandler.Requests.Count -eq 1) `
        "installer issued a request after the HTTPS downgrade redirect"
    Assert-True ($RedirectHandler.Requests[0] -ceq "https://release.test/archive") `
        "redirect test did not begin at the expected HTTPS endpoint"
    Assert-True (-not (Test-Path -LiteralPath $RedirectOutput)) `
        "redirect failure left downloaded bytes"

    $Executable = Join-Path $Temp "marker.exe"
    Write-MarkerExecutable $Executable
    $ExecutableFileBytes = [IO.File]::ReadAllBytes($Executable)
    $ExecutableBytes = New-Object byte[] 2097152
    [Array]::Copy($ExecutableFileBytes, $ExecutableBytes, $ExecutableFileBytes.Length)
    $script:InstallRoot = Join-Path $Temp "installed\omamail"
    $script:StartMenuRoot = Join-Path $Temp "start-menu"
    $script:PathState = Join-Path $Temp "user-path.txt"
    $script:RegistryState = Join-Path $Temp "toast-registration.txt"
    $script:LaunchMarker = Join-Path $Temp "launched.txt"
    $env:OMAMAIL_TEST_LAUNCH_MARKER = $script:LaunchMarker
    New-Item -ItemType Directory -Force (Split-Path -Parent $script:InstallRoot) | Out-Null

    $Valid = New-TestArchive "valid" (Base-Entries $ExecutableBytes)
    Reset-OldInstallation
    Invoke-TestInstall $Valid
    Assert-True (Test-Path -LiteralPath (Join-Path $script:InstallRoot "bin\omamail-app.exe") -PathType Leaf) `
        "valid package did not install the host"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $script:InstallRoot "old.txt"))) `
        "valid package retained old program files"
    $InstalledPath = [IO.File]::ReadAllText($script:PathState)
    Assert-True (@($InstalledPath.Split(';') | Where-Object {
        $_.TrimEnd('\') -ieq (Join-Path $script:InstallRoot "bin").TrimEnd('\')
    }).Count -eq 1) "valid install did not add one PATH entry: $InstalledPath"
    $ShortcutPath = Join-Path $script:StartMenuRoot "Omamail.lnk"
    if ($env:OS -eq "Windows_NT") {
        $WScriptShell = New-Object -ComObject WScript.Shell
        $ShortcutObject = $WScriptShell.CreateShortcut($ShortcutPath)
        Assert-True ($ShortcutObject.TargetPath -ieq (Join-Path $script:InstallRoot "bin\omamail-app.exe")) `
            "shortcut does not target the standalone host"
        Assert-True ($ShortcutObject.IconLocation.Split(',')[0] -ieq (Join-Path $script:InstallRoot "app-icon.ico")) `
            "shortcut does not use the packaged application icon"
        $ShellApplication = New-Object -ComObject Shell.Application
        $ShortcutFolder = $ShellApplication.Namespace((Split-Path -Parent $ShortcutPath))
        $ShortcutItem = $ShortcutFolder.ParseName((Split-Path -Leaf $ShortcutPath))
        Assert-True ([string]$ShortcutItem.ExtendedProperty("System.AppUserModel.ID") -ceq "com.omamail.app") `
            "shortcut has the wrong AppUserModel.ID"
        $ShortcutActivator = $ShortcutItem.ExtendedProperty("System.AppUserModel.ToastActivatorCLSID")
        Assert-True ([Guid]$ShortcutActivator -eq [Guid]"6E420BBE-A800-4FF9-BD65-472CC53922CA") `
            "shortcut has the wrong ToastActivatorCLSID"
        $ShortcutContent = [Text.Encoding]::Unicode.GetString([IO.File]::ReadAllBytes($ShortcutPath))
        Assert-True (-not $ShortcutContent.Contains("mailto")) "shortcut registered mailto"
    } else {
        $ShortcutContent = [IO.File]::ReadAllText($ShortcutPath)
        Assert-True ($ShortcutContent.Contains("target=$(Join-Path $script:InstallRoot 'bin\omamail-app.exe')")) `
            "shortcut does not target the standalone host"
        Assert-True ($ShortcutContent.Contains("appUserModelId=com.omamail.app")) `
            "shortcut has the wrong AppUserModel.ID"
        Assert-True ($ShortcutContent.Contains("toastActivatorClsid={6E420BBE-A800-4FF9-BD65-472CC53922CA}")) `
            "shortcut has the wrong ToastActivatorCLSID"
        Assert-True ($ShortcutContent.Contains("icon=$(Join-Path $script:InstallRoot 'app-icon.ico')")) `
            "shortcut does not use the packaged application icon"
        Assert-True (-not $ShortcutContent.Contains("mailto")) "shortcut registered mailto"
    }
    Assert-True (-not (Test-Path -LiteralPath $script:LaunchMarker)) "installer launched the application"
    $ExpectedToastCommand = '"' + (Join-Path $script:InstallRoot "bin\omamail-app.exe") +
        '" -ToastActivated'
    Assert-True ([IO.File]::ReadAllText($script:RegistryState) -ceq $ExpectedToastCommand) `
        "installer wrote the wrong toast LocalServer32 command"
    Assert-True ($ExpectedToastCommand -notmatch '[0-9a-f]{64}') `
        "toast registration put a notification token in argv"

    $InstalledHostHash = (Get-FileHash -LiteralPath (Join-Path $script:InstallRoot "bin\omamail-app.exe") `
        -Algorithm SHA256).Hash
    [IO.File]::WriteAllText((Join-Path $script:InstallRoot "keep.txt"), "keep", $Utf8)
    $OriginalShortcutHash = (Get-FileHash -LiteralPath $ShortcutPath -Algorithm SHA256).Hash
    $OriginalPath = [IO.File]::ReadAllText($script:PathState)
    $OriginalToastRegistration = [IO.File]::ReadAllText($script:RegistryState)
    $Upgrade = New-TestArchive "upgrade" (Base-Entries $ExecutableBytes "2.0.0")
    Expect-InstallFailure $Upgrade 'synthetic failure after shortcut update' @{
        Version = "2.0.0"; TestFailure = "AfterShortcut"
    }
    Assert-True (Test-Path -LiteralPath (Join-Path $script:InstallRoot "keep.txt")) `
        "rollback did not restore prior program files"
    Assert-True ((Get-FileHash -LiteralPath (Join-Path $script:InstallRoot "bin\omamail-app.exe") `
        -Algorithm SHA256).Hash -ceq $InstalledHostHash) "rollback changed the prior host"
    Assert-True ([IO.File]::ReadAllText($script:PathState) -ceq $OriginalPath) `
        "rollback did not restore PATH"
    Assert-True ([IO.File]::ReadAllText($script:RegistryState) -ceq $OriginalToastRegistration) `
        "rollback did not restore the toast registration"
    Assert-True ((Get-FileHash -LiteralPath $ShortcutPath -Algorithm SHA256).Hash -ceq $OriginalShortcutHash) `
        "rollback did not restore the shortcut"
    if ($env:OS -eq "Windows_NT") {
        $RestoredFolder = $ShellApplication.Namespace((Split-Path -Parent $ShortcutPath))
        $RestoredItem = $RestoredFolder.ParseName((Split-Path -Leaf $ShortcutPath))
        Assert-True ([string]$RestoredItem.ExtendedProperty("System.AppUserModel.ID") -ceq "com.omamail.app") `
            "rollback changed the shortcut AppUserModel.ID"
    }
    Assert-True (-not (Test-Path -LiteralPath "$script:InstallRoot.previous")) `
        "rollback left the backup in place"
    Assert-True (-not (Test-Path -LiteralPath $script:LaunchMarker)) `
        "rollback path launched the application"

    Expect-InstallFailure $Upgrade 'synthetic failure after toast registration' @{
        Version = "2.0.0"; TestFailure = "AfterRegistration"
    }
    Assert-True ([IO.File]::ReadAllText($script:RegistryState) -ceq $OriginalToastRegistration) `
        "registration-stage rollback did not restore the toast registration"
    Assert-True ((Get-FileHash -LiteralPath $ShortcutPath -Algorithm SHA256).Hash -ceq $OriginalShortcutHash) `
        "registration-stage rollback changed the shortcut"
    Assert-True (-not (Test-Path -LiteralPath $script:LaunchMarker)) `
        "registration-stage rollback launched the application"

    $InvalidCases = New-Object 'Collections.Generic.List[object]'
    $InvalidCases.Add((Invalid-Case "absolute" (@((Base-Entries $ExecutableBytes) +
        (Entry "/absolute.txt" (Utf8 "bad")))) "unsafe path"))
    $InvalidCases.Add((Invalid-Case "traversal" (@((Base-Entries $ExecutableBytes) +
        (Entry "omamail/../escape.txt" (Utf8 "bad")))) "unsafe path component"))
    $InvalidCases.Add((Invalid-Case "backslash" (@((Base-Entries $ExecutableBytes) +
        (Entry 'omamail\escape.txt' (Utf8 "bad")))) "unsafe path"))
    $InvalidCases.Add((Invalid-Case "control" (@((Base-Entries $ExecutableBytes) +
        (Entry "omamail/control`nname" (Utf8 "bad")))) "unsafe path"))
    $InvalidCases.Add((Invalid-Case "case-duplicate-critical" (@((Base-Entries $ExecutableBytes) +
        (Entry "omamail/bin/OMAMAIL-APP.exe" $ExecutableBytes))) "duplicate paths"))
    $InvalidCases.Add((Invalid-Case "file-directory-duplicate" (@((Base-Entries $ExecutableBytes) + @(
        (Entry "omamail/collision" (Utf8 "file")),
        (Entry "omamail/collision/" (New-Object byte[] 0))
    ))) "duplicate paths"))
    $SymlinkAttributes = [BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]2684354560), 0)
    $FifoAttributes = [BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]268435456), 0)
    $InvalidCases.Add((Invalid-Case "symlink" (@((Base-Entries $ExecutableBytes) +
        (Entry "omamail/link" (Utf8 "target") $SymlinkAttributes))) "symlink or special"))
    $InvalidCases.Add((Invalid-Case "reparse" (@((Base-Entries $ExecutableBytes) +
        (Entry "omamail/reparse" (Utf8 "bad") 0x400))) "reparse point"))
    $InvalidCases.Add((Invalid-Case "special" (@((Base-Entries $ExecutableBytes) +
        (Entry "omamail/fifo" (Utf8 "bad") $FifoAttributes))) "symlink or special"))
    $InvalidCases.Add((Invalid-Case "long-path" (@((Base-Entries $ExecutableBytes) +
        (Entry ("omamail/" + ("x" * 1100)) (Utf8 "bad")))) "unsafe path"))

    foreach ($Case in $InvalidCases) {
        Reset-OldInstallation
        $Bundle = New-TestArchive ("hostile-" + $Case.Name) $Case.Entries
        Expect-InstallFailure $Bundle $Case.Pattern
        Assert-NoMutation $Case.Name
    }

    Reset-OldInstallation
    $WrongTopEntries = @((Base-Entries $ExecutableBytes) | ForEach-Object {
        Entry ($_.Name -replace '^omamail', 'other') $_.Bytes $_.ExternalAttributes
    })
    $WrongTop = New-TestArchive "wrong-top" $WrongTopEntries
    Expect-InstallFailure $WrongTop 'top-level'
    Assert-NoMutation "wrong top-level"

    Reset-OldInstallation
    $WrongTarget = New-TestArchive "wrong-target" (Base-Entries $ExecutableBytes "1.2.3" "windows-arm64")
    Expect-InstallFailure $WrongTarget 'does not describe'
    Assert-NoMutation "wrong release target"

    $MetadataCases = @(
        (Invalid-Case "metadata-missing-field" (Replace-Entry (Base-Entries $ExecutableBytes) `
            "omamail/release.json" (Utf8 '{"schemaVersion":1,"name":"omamail","version":"1.2.3","target":"windows-x86_64"}')) `
            'one topLevel property'),
        (Invalid-Case "metadata-extra-field" (Replace-Entry (Base-Entries $ExecutableBytes) `
            "omamail/release.json" (Utf8 '{"schemaVersion":1,"name":"omamail","version":"1.2.3","target":"windows-x86_64","topLevel":"omamail","extra":true}')) `
            'unexpected schema'),
        (Invalid-Case "metadata-duplicate-field" (Replace-Entry (Base-Entries $ExecutableBytes) `
            "omamail/release.json" (Utf8 '{"schemaVersion":1,"name":"omamail","version":"1.2.3","target":"windows-x86_64","topLevel":"omamail","topLevel":"other"}')) `
            'one topLevel property')
    )
    foreach ($Case in $MetadataCases) {
        Reset-OldInstallation
        $Bundle = New-TestArchive $Case.Name $Case.Entries
        Expect-InstallFailure $Bundle $Case.Pattern
        Assert-NoMutation $Case.Name
    }

    Reset-OldInstallation
    Expect-InstallFailure $Valid 'requested version' @{ Version = "9.9.9" }
    Assert-NoMutation "wrong requested version"

    Reset-OldInstallation
    Expect-InstallFailure $Valid 'supports only x86_64' @{ TestArchitecture = "ARM64" }
    Assert-NoMutation "wrong operating-system architecture"

    $WrongPe = New-Object byte[] $ExecutableBytes.Length
    [Array]::Copy($ExecutableBytes, $WrongPe, $ExecutableBytes.Length)
    $Header = [BitConverter]::ToInt32($WrongPe, 0x3c)
    $WrongPe[$Header + 4] = 0x4c
    $WrongPe[$Header + 5] = 0x01
    Reset-OldInstallation
    $WrongHost = New-TestArchive "wrong-host-architecture" `
        (Replace-Entry (Base-Entries $ExecutableBytes) "omamail/bin/omamail-app.exe" $WrongPe)
    Expect-InstallFailure $WrongHost 'not an x86_64 Windows binary'
    Assert-NoMutation "wrong host architecture"

    foreach ($Missing in @(
        "omamail/release.json",
        "omamail/manifest.json",
        "omamail/app-icon.ico",
        "omamail/bin/omamail-app.exe",
        "omamail/bin/omamail.exe",
        "omamail/qml/Main.qml",
        "omamail/ui/Service.qml",
        "omamail/bin/platforms/qwindows.dll"
    )) {
        Reset-OldInstallation
        $MissingBundle = New-TestArchive ("missing-" + ($Missing -replace '[^A-Za-z]', '-')) `
            (Remove-Entry (Base-Entries $ExecutableBytes) $Missing)
        Expect-InstallFailure $MissingBundle 'is missing'
        Assert-NoMutation "missing $Missing"
    }

    Reset-OldInstallation
    $BadSums = Join-Path $Temp "bad.SHA256SUMS"
    [IO.File]::WriteAllText($BadSums,
        (("0" * 64) + " *$([IO.Path]::GetFileName($Valid.Archive))`n"), $Utf8)
    $BadChecksum = @{ Archive = $Valid.Archive; Sums = $BadSums }
    Expect-InstallFailure $BadChecksum 'checksum mismatch'
    Assert-NoMutation "checksum mismatch"

    Reset-OldInstallation
    $OversizedSums = Join-Path $Temp "oversized.SHA256SUMS"
    [IO.File]::WriteAllBytes($OversizedSums, (New-Object byte[] (1MB + 1)))
    Expect-InstallFailure @{ Archive = $Valid.Archive; Sums = $OversizedSums } `
        'checksum file is missing or too large'
    Assert-NoMutation "oversized local checksum"

    Reset-OldInstallation
    $ManyEntries = [Collections.Generic.List[object]]::new()
    foreach ($Value in (Base-Entries $ExecutableBytes)) { $ManyEntries.Add($Value) }
    for ($Index = 0; $Index -lt 4096; $Index++) {
        $ManyEntries.Add((Entry ("omamail/limit/$Index") (New-Object byte[] 0)))
    }
    $TooMany = New-TestArchive "too-many" $ManyEntries.ToArray()
    Expect-InstallFailure $TooMany 'invalid entry count'
    Assert-NoMutation "entry count limit"

    Remove-Item -LiteralPath $script:InstallRoot -Recurse -Force
    New-Item -ItemType Directory -Force $script:InstallRoot | Out-Null
    [IO.File]::WriteAllText((Join-Path $script:InstallRoot "program.txt"), "program", $Utf8)
    New-Item -ItemType Directory -Force $script:StartMenuRoot | Out-Null
    [IO.File]::WriteAllText((Join-Path $script:StartMenuRoot "Omamail.lnk"), "shortcut", $Utf8)
    [IO.File]::WriteAllText($script:PathState,
        "C:\Tools;$(Join-Path $script:InstallRoot 'bin')", $Utf8)
    [IO.File]::WriteAllText($script:RegistryState,
        ('"' + (Join-Path $script:InstallRoot "bin\omamail-app.exe") + '" -ToastActivated'), $Utf8)
    $UserData = Join-Path $Temp "user-data"
    New-Item -ItemType Directory -Force $UserData | Out-Null
    [IO.File]::WriteAllText((Join-Path $UserData "accounts.json"), "preserve", $Utf8)
    Invoke-TestInstall $Valid @{ Uninstall = $true }
    Assert-True (-not (Test-Path -LiteralPath $script:InstallRoot)) "uninstall retained program files"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $script:StartMenuRoot "Omamail.lnk"))) `
        "uninstall retained the shortcut"
    Assert-True ([IO.File]::ReadAllText($script:PathState) -ceq "C:\Tools") `
        "uninstall retained the PATH entry"
    Assert-True (-not (Test-Path -LiteralPath $script:RegistryState)) `
        "uninstall retained its toast registration"
    Assert-True ([IO.File]::ReadAllText((Join-Path $UserData "accounts.json")) -ceq "preserve") `
        "uninstall removed user data"
    Assert-True (-not (Test-Path -LiteralPath $script:LaunchMarker)) `
        "uninstall launched the application"

    [IO.File]::WriteAllText($script:RegistryState,
        '"C:\Other\omamail-app.exe" -ToastActivated', $Utf8)
    Invoke-TestInstall $Valid @{ Uninstall = $true }
    Assert-True ([IO.File]::ReadAllText($script:RegistryState) -ceq `
        '"C:\Other\omamail-app.exe" -ToastActivated') `
        "uninstall removed another installation's toast registration"

    $InstallerText = [IO.File]::ReadAllText($Installer)
    Assert-True ($InstallerText -notmatch '(?i)mailto') "installer contains mailto registration"
    Assert-True ($InstallerText.Contains("Save-BoundedDownload")) `
        "network downloads are not size and deadline bounded"
    Assert-True (-not $InstallerText.Contains("Invoke-WebRequest")) `
        "installer still uses an unbounded download path"
    Assert-True ($InstallerText.Contains('$Handler.AllowAutoRedirect = $false')) `
        "installer delegates redirect policy to HttpClientHandler"
    Assert-True ($InstallerText.Contains('$NextUri.Scheme -cne "https"')) `
        "installer does not refuse HTTPS downgrade before following a redirect"
    Write-Output "Windows installer tests passed"
} finally {
    Remove-Item Env:OMAMAIL_TEST_LAUNCH_MARKER -ErrorAction SilentlyContinue
    Remove-Item Env:OMAMAIL_PACKAGE_TEST_MODE -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
}
