# Runs omarchy/install.ps1 against synthetic NSH release archives.
#
#   pwsh -NoProfile -File omarchy/tests/test_install.ps1
#
# Needs Windows (registry, shortcuts) and no Pester. Each case builds the zip
# `nsh package --target windows` would, lists it in a SHA256SUMS, and runs the
# installer in test mode in a child process, once under Windows PowerShell 5.1
# (what `irm | iex` runs on stock Windows) and once under the PowerShell that
# runs this script. Program files, the Start menu and the Qt-era leftovers
# live in a scratch directory; the registry is a scratch key under
# HKCU\Software. Results are checked by what is on disk and in the registry,
# not only by the exit status. Exits non-zero when any case fails.
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    Write-Error "test_install.ps1 needs Windows"
    exit 1
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Net.Http

$Installer = Join-Path (Split-Path -Parent $PSScriptRoot) "install.ps1"
$AppId = "dev.huacnlee.omamail"
$ToastClsid = "{6E420BBE-A800-4FF9-BD65-472CC53922CA}"
$Utf8 = New-Object Text.UTF8Encoding($false)
$Temp = Join-Path ([IO.Path]::GetTempPath()) ("omamail-install-test-" + [Guid]::NewGuid().ToString('N'))
$Failures = New-Object 'Collections.Generic.List[string]'
$Passed = 0

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Utf8([string]$Text) { return ,$Utf8.GetBytes($Text) }

function Write-TextFile([string]$Path, [string]$Text) {
    New-Item -ItemType Directory -Force (Split-Path -Parent $Path) | Out-Null
    [IO.File]::WriteAllText($Path, $Text, $Utf8)
}

function Read-TextFile([string]$Path) { return [IO.File]::ReadAllText($Path) }

# The smallest PE header the installer inspects: MZ, e_lfanew, PE\0\0, machine.
function New-PeBytes([int]$Machine) {
    $Bytes = New-Object byte[] 512
    $Bytes[0] = 0x4d
    $Bytes[1] = 0x5a
    [BitConverter]::GetBytes([int]128).CopyTo($Bytes, 0x3c)
    $Bytes[128] = 0x50
    $Bytes[129] = 0x45
    [BitConverter]::GetBytes([uint16]$Machine).CopyTo($Bytes, 132)
    return ,$Bytes
}

function Entry([string]$Name, [byte[]]$Bytes = $null) {
    return [pscustomobject]@{ Name = $Name; Bytes = $Bytes }
}

function App-Json([string]$Id, [string]$Version) {
    return '{"name":"Omamail","id":"' + $Id + '","version":"' + $Version + '","singleInstance":true}'
}

# What `nsh package --target windows` zips: Omamail/ with the runner, nsh/.
function App-Entries([string]$Version, [string]$Id = $AppId, [int]$Machine = 0x8664,
    [string]$Json = "") {
    if (-not $Json) { $Json = App-Json $Id $Version }
    return @(
        (Entry "Omamail/"),
        (Entry "Omamail/Omamail.exe" (New-PeBytes $Machine)),
        (Entry "Omamail/nsh/"),
        (Entry "Omamail/nsh/app.json" (Utf8 $Json)),
        (Entry "Omamail/nsh/bundle.nshc" (Utf8 "bytecode $Version")),
        (Entry "Omamail/nsh/icon.ico" ([byte[]](0, 0, 1, 0))),
        (Entry "Omamail/nsh/assets/"),
        (Entry "Omamail/nsh/assets/icon.png" ([byte[]](0x89, 0x50, 0x4e, 0x47)))
    )
}

function New-TestArchive([string]$Case, [string]$FileName, [object[]]$Entries,
    [switch]$WrongChecksum) {
    $Directory = Join-Path $Temp "archives\$Case"
    New-Item -ItemType Directory -Force $Directory | Out-Null
    $Archive = Join-Path $Directory $FileName
    $Stream = [IO.File]::Open($Archive, [IO.FileMode]::CreateNew,
        [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $Zip = New-Object IO.Compression.ZipArchive($Stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($Value in $Entries) {
            $ZipEntry = $Zip.CreateEntry($Value.Name, [IO.Compression.CompressionLevel]::Optimal)
            if ($null -eq $Value.Bytes) { continue }
            $Output = $ZipEntry.Open()
            try { $Output.Write($Value.Bytes, 0, $Value.Bytes.Length) } finally { $Output.Dispose() }
        }
    } finally {
        $Zip.Dispose()
        $Stream.Dispose()
    }
    $Hash = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($WrongChecksum) { $Hash = "0" * 64 }
    $Sums = Join-Path $Directory "SHA256SUMS"
    $Other = "1" * 64
    Write-TextFile $Sums ("$Other  Omamail-0.0.1-linux-x86_64.tar.gz`n" +
        "$Hash  $FileName`n")
    return @{ Archive = $Archive; Sums = $Sums }
}

function Archive-Name([string]$Version) { return "Omamail-$Version-windows-x86_64.zip" }

# ---- registry helpers (below the scratch key) -------------------------------

function Open-TestKey([string]$Subkey, [bool]$Create = $false) {
    $Path = "$script:RegistryRoot\$Subkey"
    if ($Create) { return [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($Path) }
    return [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Path, $false)
}

function Get-TestPath {
    $Key = Open-TestKey "Environment"
    if (-not $Key) { return $null }
    try {
        if (@($Key.GetValueNames()) -notcontains "Path") { return $null }
        return @{
            Value = [string]$Key.GetValue("Path", $null,
                [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            Kind = $Key.GetValueKind("Path")
        }
    } finally {
        $Key.Dispose()
    }
}

function Get-TestToastCommand {
    $Key = Open-TestKey "Software\Classes\CLSID\$ToastClsid\LocalServer32"
    if (-not $Key) { return $null }
    try { return [string]$Key.GetValue("") } finally { $Key.Dispose() }
}

function Test-ToastClassKey {
    $Key = Open-TestKey "Software\Classes\CLSID\$ToastClsid"
    if ($Key) { $Key.Dispose(); return $true }
    return $false
}

# ---- scratch state -----------------------------------------------------------

function Initialize-Scratch([string]$Name) {
    $script:Root = Join-Path $Temp "roots\$Name"
    $script:LocalAppData = Join-Path $script:Root "LocalAppData"
    $script:InstallRoot = Join-Path $script:LocalAppData "Programs\Omamail"
    $script:LegacyRoot = Join-Path $script:LocalAppData "omamail"
    $script:StartMenuRoot = Join-Path $script:Root "StartMenu\Programs"
    $script:ShortcutPath = Join-Path $script:StartMenuRoot "Omamail.lnk"
    $script:RegistryRoot = "Software\OmamailInstallerTest-" + [Guid]::NewGuid().ToString('N')
    $script:RegistryRoots.Add($script:RegistryRoot)
    $script:AccountsFile = Join-Path $script:LocalAppData "OmamailData\State\accounts.json"
    $script:SettingsFile = Join-Path $script:Root "RoamingAppData\omamail\settings.json"
    $script:QtCacheFile = Join-Path $script:LegacyRoot "Omamail\cache\qmlcache\Main.qmlc"
    $script:LegacyPath = "C:\Tools;$($script:LegacyRoot)\bin;%USERPROFILE%\bin"
    $script:LegacyToast = '"' + (Join-Path $script:LegacyRoot "bin\omamail-app.exe") + '" -ToastActivated'
}

function Reset-Scratch {
    if (Test-Path -LiteralPath $script:Root) {
        Remove-Item -LiteralPath $script:Root -Recurse -Force
    }
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($script:RegistryRoot, $false)
    New-Item -ItemType Directory -Force $script:LocalAppData | Out-Null
    # User data the installer must never touch.
    Write-TextFile $script:AccountsFile '{"accounts":["synthetic@example.test"]}'
    Write-TextFile $script:SettingsFile '{"theme":"synthetic"}'
}

# What the Qt-era install.ps1 left behind.
function Install-QtLeftovers([string]$ToastCommand = "") {
    if (-not $ToastCommand) { $ToastCommand = $script:LegacyToast }
    $Pe = New-PeBytes 0x8664
    foreach ($Relative in @("bin\omamail-app.exe", "bin\omamail.exe", "bin\platforms\qwindows.dll")) {
        $Path = Join-Path $script:LegacyRoot $Relative
        New-Item -ItemType Directory -Force (Split-Path -Parent $Path) | Out-Null
        [IO.File]::WriteAllBytes($Path, $Pe)
    }
    Write-TextFile (Join-Path $script:LegacyRoot "qml\Main.qml") "import QtQuick"
    Write-TextFile (Join-Path $script:LegacyRoot "ui\Service.qml") "import QtQuick"
    Write-TextFile (Join-Path $script:LegacyRoot "licenses\NerdFonts-LICENSE") "license"
    Write-TextFile (Join-Path $script:LegacyRoot "manifest.json") '{"version":"0.11.0"}'
    Write-TextFile (Join-Path $script:LegacyRoot "release.json") '{"version":"0.11.0"}'
    Write-TextFile (Join-Path $script:LegacyRoot "app-icon.ico") "icon"
    # Qt's own cache below the program directory is not something the old
    # installer created, so it stays.
    Write-TextFile $script:QtCacheFile "cache"
    Write-TextFile (Join-Path "$($script:LegacyRoot).previous" "bin\omamail-app.exe") "old"
    Write-TextFile (Join-Path "$($script:LegacyRoot).previous" "qml\Main.qml") "old"
    $Stale = "$($script:LegacyRoot).new-" + [Guid]::NewGuid().ToString('N')
    Write-TextFile (Join-Path $Stale "bin\omamail-app.exe") "stale"
    New-Item -ItemType Directory -Force $script:StartMenuRoot | Out-Null
    Write-TextFile $script:ShortcutPath "qt shortcut"

    $Environment = Open-TestKey "Environment" $true
    try {
        $Environment.SetValue("Path", $script:LegacyPath,
            [Microsoft.Win32.RegistryValueKind]::ExpandString)
    } finally { $Environment.Dispose() }
    $Server = Open-TestKey "Software\Classes\CLSID\$ToastClsid\LocalServer32" $true
    try {
        $Server.SetValue("", $ToastCommand, [Microsoft.Win32.RegistryValueKind]::String)
    } finally { $Server.Dispose() }
}

# ---- running the installer ----------------------------------------------------

# The child runs the installer through a wrapper that writes the exception
# message to a file, so assertions do not depend on how a host wraps stderr.
function Invoke-Installer([hashtable]$Arguments) {
    $script:Invocation++
    $Directory = Join-Path $Temp "runs\$($script:Invocation)"
    New-Item -ItemType Directory -Force $Directory | Out-Null
    $ArgumentsFile = Join-Path $Directory "arguments.json"
    $ErrorFile = Join-Path $Directory "error.txt"
    Write-TextFile $ArgumentsFile ($Arguments | ConvertTo-Json)
    $Saved = $ErrorActionPreference
    $SavedModulePath = $env:PSModulePath
    $ErrorActionPreference = "Continue"
    try {
        # Windows PowerShell started from pwsh must not load pwsh's modules.
        if ($script:CurrentHost -match 'WindowsPowerShell') {
            [Environment]::SetEnvironmentVariable("PSModulePath", $null, "Process")
        }
        $Output = & $script:CurrentHost -NoProfile -NonInteractive -ExecutionPolicy Bypass `
            -File $script:Wrapper -Installer $Installer -ArgumentsFile $ArgumentsFile `
            -ErrorFile $ErrorFile 2>&1 | ForEach-Object { "$_" }
        $Code = $LASTEXITCODE
    } finally {
        [Environment]::SetEnvironmentVariable("PSModulePath", $SavedModulePath, "Process")
        $ErrorActionPreference = $Saved
    }
    $Message = if (Test-Path -LiteralPath $ErrorFile) { Read-TextFile $ErrorFile } else { "" }
    return @{ Code = $Code; Output = (@($Output) -join "`n"); Error = $Message }
}

function Scratch-Arguments {
    return @{
        TestMode = $true
        InstallRoot = $script:InstallRoot
        StartMenuRoot = $script:StartMenuRoot
        LegacyRoot = $script:LegacyRoot
        RegistryRoot = $script:RegistryRoot
        TestArchitecture = "AMD64"
    }
}

function Install-Bundle($Bundle, [hashtable]$Extra = @{}) {
    $Arguments = Scratch-Arguments
    # The short aliases the release workflow and docs use.
    $Arguments["Archive"] = $Bundle.Archive
    $Arguments["Checksums"] = $Bundle.Sums
    foreach ($Key in $Extra.Keys) { $Arguments[$Key] = $Extra[$Key] }
    return Invoke-Installer $Arguments
}

function Expect-Success($Result, [string]$What) {
    if ($Result.Code -ne 0) {
        throw "$What failed with exit code $($Result.Code): $($Result.Error)`n$($Result.Output)"
    }
}

function Expect-Failure($Result, [string]$Pattern, [string]$What) {
    if ($Result.Code -eq 0) { throw "$What was accepted:`n$($Result.Output)" }
    if ($Result.Error -notmatch $Pattern) {
        throw "$What failed for the wrong reason (expected /$Pattern/): $($Result.Error)`n$($Result.Output)"
    }
}

# ---- assertions ------------------------------------------------------------------

function Get-InstalledVersion {
    $Json = Read-TextFile (Join-Path $script:InstallRoot "nsh\app.json") | ConvertFrom-Json
    return $Json.version
}

function Assert-NoStaging([string]$Case) {
    Assert-True (-not (Test-Path -LiteralPath "$($script:InstallRoot).previous")) `
        "$Case left an installation backup"
    $Parent = Split-Path -Parent $script:InstallRoot
    if (Test-Path -LiteralPath $Parent) {
        $Candidates = @(Get-ChildItem -LiteralPath $Parent -Force |
            Where-Object { $_.Name -like "Omamail.new-*" })
        Assert-True ($Candidates.Count -eq 0) "$Case left a staged install"
    }
    $Shortcuts = @(Get-ChildItem -LiteralPath $script:StartMenuRoot -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "Omamail.lnk.new-*" })
    Assert-True ($Shortcuts.Count -eq 0) "$Case left a staged shortcut"
}

function Assert-UserDataKept([string]$Case) {
    Assert-True ((Read-TextFile $script:AccountsFile) -ceq '{"accounts":["synthetic@example.test"]}') `
        "$Case changed account data"
    Assert-True ((Read-TextFile $script:SettingsFile) -ceq '{"theme":"synthetic"}') `
        "$Case changed settings"
}

function Assert-QtLeftoversIntact([string]$Case) {
    Assert-True (Test-Path -LiteralPath (Join-Path $script:LegacyRoot "bin\omamail-app.exe") -PathType Leaf) `
        "$Case removed the Qt-era program before installing"
    Assert-True (Test-Path -LiteralPath (Join-Path $script:LegacyRoot "qml\Main.qml") -PathType Leaf) `
        "$Case removed Qt-era files before installing"
    $Path = Get-TestPath
    Assert-True ($null -ne $Path -and $Path.Value -ceq $script:LegacyPath) `
        "$Case changed the user PATH before installing"
    Assert-True ((Get-TestToastCommand) -ceq $script:LegacyToast) `
        "$Case changed the toast registration before installing"
    Assert-True ((Read-TextFile $script:ShortcutPath) -ceq "qt shortcut") `
        "$Case changed the Start menu shortcut"
}

function Assert-QtLeftoversRemoved([string]$Case) {
    foreach ($Name in @("bin", "qml", "ui", "licenses", "manifest.json", "release.json", "app-icon.ico")) {
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $script:LegacyRoot $Name))) `
            "$Case kept the Qt-era $Name"
    }
    Assert-True (-not (Test-Path -LiteralPath "$($script:LegacyRoot).previous")) `
        "$Case kept the Qt-era installation backup"
    $Stale = @(Get-ChildItem -LiteralPath $script:LocalAppData -Force |
        Where-Object { $_.Name -like "omamail.new-*" })
    Assert-True ($Stale.Count -eq 0) "$Case kept a Qt-era staged install"
    Assert-True ((Read-TextFile $script:QtCacheFile) -ceq "cache") `
        "$Case removed files the Qt-era installer did not create"
    $Path = Get-TestPath
    Assert-True ($null -ne $Path) "$Case removed the user PATH"
    Assert-True ($Path.Value -ceq "C:\Tools;%USERPROFILE%\bin") `
        "$Case left the wrong user PATH: $($Path.Value)"
    Assert-True ($Path.Kind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) `
        "$Case changed the user PATH's registry type to $($Path.Kind)"
    Assert-True (-not (Test-ToastClassKey)) "$Case kept the Qt-era toast activator"
}

function Assert-Shortcut([string]$Case) {
    $Executable = Join-Path $script:InstallRoot "Omamail.exe"
    $Shell = New-Object -ComObject WScript.Shell
    $Link = $Shell.CreateShortcut($script:ShortcutPath)
    Assert-True ($Link.TargetPath -ieq $Executable) "$Case shortcut targets $($Link.TargetPath)"
    Assert-True ($Link.WorkingDirectory -ieq $script:InstallRoot) `
        "$Case shortcut starts in $($Link.WorkingDirectory)"
    Assert-True ($Link.IconLocation.Split(',')[0] -ieq $Executable) `
        "$Case shortcut icon is $($Link.IconLocation)"
    $ShellApplication = New-Object -ComObject Shell.Application
    $Item = $ShellApplication.Namespace($script:StartMenuRoot).ParseName("Omamail.lnk")
    $Aumid = [string]$Item.ExtendedProperty("System.AppUserModel.ID")
    Assert-True ($Aumid -ceq $AppId) "$Case shortcut AppUserModelID is '$Aumid'"
}

function Assert-Installed([string]$Case, [string]$Version) {
    foreach ($Relative in @("Omamail.exe", "nsh\app.json", "nsh\bundle.nshc", "nsh\assets\icon.png")) {
        Assert-True (Test-Path -LiteralPath (Join-Path $script:InstallRoot $Relative) -PathType Leaf) `
            "$Case did not install $Relative"
    }
    Assert-True ((Get-InstalledVersion) -ceq $Version) "$Case installed $(Get-InstalledVersion), not $Version"
    Assert-Shortcut $Case
    Assert-NoStaging $Case
}

# ---- cases -------------------------------------------------------------------------

function Test-Case([string]$Name, [scriptblock]$Body) {
    try {
        & $Body
        $script:Passed++
        Write-Output "ok   [$($script:HostLabel)] $Name"
    } catch {
        $script:Failures.Add("[$($script:HostLabel)] $Name`: $($_.Exception.Message)")
        Write-Output "FAIL [$($script:HostLabel)] $Name"
    }
}

function Invoke-Cases {
    $V1 = New-TestArchive "v1" (Archive-Name "1.2.3") (App-Entries "1.2.3")
    $V2 = New-TestArchive "v2" (Archive-Name "2.0.0") (App-Entries "2.0.0")

    Test-Case "fresh install from the latest archive replaces the Qt-era app" {
        Reset-Scratch
        Install-QtLeftovers
        $Result = Install-Bundle $V1
        Expect-Success $Result "install"
        Assert-True ($Result.Output -match 'Omamail 1\.2\.3 installed at') "no installed message: $($Result.Output)"
        Assert-True ($Result.Output -match 'checks for updates itself') "no update message: $($Result.Output)"
        Assert-Installed "install" "1.2.3"
        Assert-QtLeftoversRemoved "install"
        Assert-UserDataKept "install"
    }

    Test-Case "a toast activator owned by another program stays" {
        Reset-Scratch
        Install-QtLeftovers '"C:\Elsewhere\other.exe" -ToastActivated'
        Expect-Success (Install-Bundle $V1 @{ Version = "v1.2.3" }) "install"
        Assert-True ((Get-TestToastCommand) -ceq '"C:\Elsewhere\other.exe" -ToastActivated') `
            "removed a toast activator the Qt-era app no longer owned"
    }

    $Escape = "omamail-escape-" + [Guid]::NewGuid().ToString('N') + ".txt"
    $Refusals = @(
        @{ Name = "checksum mismatch"; Pattern = 'checksum mismatch'; Extra = @{};
            Bundle = (New-TestArchive "bad-checksum" (Archive-Name "1.2.3") (App-Entries "1.2.3") -WrongChecksum) },
        @{ Name = "wrong app id"; Pattern = 'is not Omamail'; Extra = @{};
            Bundle = (New-TestArchive "wrong-id" (Archive-Name "1.2.3") (App-Entries "1.2.3" "com.example.other")) },
        @{ Name = "app.json version differs from the archive name"; Pattern = 'version does not match the release archive name'; Extra = @{};
            Bundle = (New-TestArchive "json-version" (Archive-Name "1.2.3") (App-Entries "1.2.3" -Json (App-Json $AppId "1.2.4"))) },
        @{ Name = "archive version differs from -Version"; Pattern = 'requested version'; Extra = @{ Version = "9.9.9" };
            Bundle = $V1 },
        @{ Name = "arm64 executable"; Pattern = 'not an x86_64 Windows binary'; Extra = @{};
            Bundle = (New-TestArchive "arm64" (Archive-Name "1.2.3") (App-Entries "1.2.3" -Machine 0xAA64)) },
        @{ Name = "parent-directory entry"; Pattern = 'unsafe path component'; Extra = @{};
            Bundle = (New-TestArchive "dotdot" (Archive-Name "1.2.3") (@(App-Entries "1.2.3") +
                (Entry "Omamail/../../../$Escape" (Utf8 "escaped")))) },
        @{ Name = "duplicate id key"; Pattern = 'one id property'; Extra = @{};
            Bundle = (New-TestArchive "duplicate-id" (Archive-Name "1.2.3") (App-Entries "1.2.3" -Json `
                ('{"id":"' + $AppId + '","version":"1.2.3","id":"com.example.other"}'))) },
        @{ Name = "missing bundle"; Pattern = 'missing Omamail/nsh/bundle\.nshc'; Extra = @{};
            Bundle = (New-TestArchive "no-bundle" (Archive-Name "1.2.3") @(App-Entries "1.2.3" |
                Where-Object { $_.Name -cne "Omamail/nsh/bundle.nshc" })) },
        @{ Name = "wrong top-level directory"; Pattern = 'top-level'; Extra = @{};
            Bundle = (New-TestArchive "top-level" (Archive-Name "1.2.3") @(App-Entries "1.2.3" |
                ForEach-Object { Entry ($_.Name -creplace '^Omamail', 'Other') $_.Bytes })) },
        @{ Name = "Qt-era archive name"; Pattern = 'must be named'; Extra = @{};
            Bundle = (New-TestArchive "qt-name" "omamail-app-windows-x86_64.zip" (App-Entries "1.2.3")) }
    )
    foreach ($Refusal in $Refusals) {
        Test-Case "refuses: $($Refusal.Name)" {
            Reset-Scratch
            Install-QtLeftovers
            Expect-Failure (Install-Bundle $Refusal.Bundle $Refusal.Extra) $Refusal.Pattern $Refusal.Name
            Assert-True (-not (Test-Path -LiteralPath $script:InstallRoot)) "$($Refusal.Name) installed files"
            Assert-NoStaging $Refusal.Name
            Assert-QtLeftoversIntact $Refusal.Name
            Assert-UserDataKept $Refusal.Name
            foreach ($Directory in @($env:TEMP, [IO.Path]::GetTempPath(), $Temp)) {
                Assert-True (-not (Test-Path -LiteralPath (Join-Path $Directory $Escape))) `
                    "$($Refusal.Name) wrote outside the extraction directory"
            }
        }
    }

    Test-Case "failures after the swap restore the previous install" {
        Reset-Scratch
        Expect-Success (Install-Bundle $V1) "first install"
        Write-TextFile (Join-Path $script:InstallRoot "keep.txt") "previous"
        Write-TextFile (Join-Path $script:InstallRoot "unins000.dat") "inno log"
        $ShortcutHash = (Get-FileHash -LiteralPath $script:ShortcutPath -Algorithm SHA256).Hash
        foreach ($Stage in @("AfterInstall", "AfterShortcut")) {
            Expect-Failure (Install-Bundle $V2 @{ Version = "2.0.0"; TestFailure = $Stage }) `
                'synthetic failure' "upgrade failing $Stage"
            Assert-True ((Read-TextFile (Join-Path $script:InstallRoot "keep.txt")) -ceq "previous") `
                "$Stage rollback did not restore the previous program files"
            Assert-True ((Get-InstalledVersion) -ceq "1.2.3") "$Stage rollback left version $(Get-InstalledVersion)"
            Assert-True ((Get-FileHash -LiteralPath $script:ShortcutPath -Algorithm SHA256).Hash -ceq $ShortcutHash) `
                "$Stage rollback did not restore the shortcut"
            Assert-NoStaging "$Stage rollback"
        }
        Expect-Success (Install-Bundle $V2 @{ Version = "2.0.0" }) "upgrade"
        Assert-Installed "upgrade" "2.0.0"
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $script:InstallRoot "keep.txt"))) `
            "upgrade kept files of the previous version"
        Assert-True ((Read-TextFile (Join-Path $script:InstallRoot "unins000.dat")) -ceq "inno log") `
            "upgrade dropped the setup's uninstaller files"
        Assert-UserDataKept "upgrade"
    }

    Test-Case "-Uninstall removes the app and the Qt-era leftovers, keeps data" {
        Reset-Scratch
        Expect-Success (Install-Bundle $V1) "install"
        Install-QtLeftovers
        $Result = Invoke-Installer ((Scratch-Arguments) + @{ Uninstall = $true })
        Expect-Success $Result "uninstall"
        Assert-True (-not (Test-Path -LiteralPath $script:InstallRoot)) "uninstall kept program files"
        Assert-True (-not (Test-Path -LiteralPath $script:ShortcutPath)) "uninstall kept the shortcut"
        Assert-QtLeftoversRemoved "uninstall"
        Assert-UserDataKept "uninstall"
    }

    Test-Case "test-only arguments are refused outside test mode" {
        Reset-Scratch
        Install-QtLeftovers
        $Result = Invoke-Installer @{ InstallRoot = $script:InstallRoot; Archive = $V1.Archive;
            Checksums = $V1.Sums }
        Expect-Failure $Result 'test-only arguments require -TestMode' "unguarded install root"
        Assert-True (-not (Test-Path -LiteralPath $script:InstallRoot)) "unguarded install root installed files"
        Assert-QtLeftoversIntact "unguarded install root"
    }
}

function Test-RedirectPolicy {
    if (-not ("OmamailInstallerTests.DowngradeRedirectHandler" -as [type])) {
        $Source = @'
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
        if ($PSVersionTable.PSEdition -eq "Desktop") {
            Add-Type -TypeDefinition $Source -ReferencedAssemblies System.Net.Http
        } else {
            Add-Type -TypeDefinition $Source
        }
    }
    $Handler = New-Object OmamailInstallerTests.DowngradeRedirectHandler
    $Output = Join-Path $Temp "redirect-download"
    $Refused = $false
    try {
        & $Installer -TestMode -TestRedirectPolicy -TestHttpHandler $Handler -RedirectStateFile $Output
    } catch {
        if ($_.Exception.Message -notmatch 'redirected outside HTTPS') { throw }
        $Refused = $true
    }
    Assert-True $Refused "an HTTPS downgrade redirect was followed"
    Assert-True ($Handler.Requests.Count -eq 1) "the installer made a request after the downgrade redirect"
    Assert-True ($Handler.Requests[0] -ceq "https://release.test/archive") "the download began elsewhere"
    Assert-True (-not (Test-Path -LiteralPath $Output)) "the refused download left bytes"
}

$RegistryRoots = New-Object 'Collections.Generic.List[string]'
New-Item -ItemType Directory -Force $Temp | Out-Null
$env:OMAMAIL_PACKAGE_TEST_MODE = "1"
try {
    $HostLabel = "in-process"
    Test-Case "download refuses an HTTPS-to-HTTP redirect" { Test-RedirectPolicy }

    $Invocation = 0
    $Wrapper = Join-Path $Temp "harness\run-installer.ps1"
    Write-TextFile $Wrapper @'
param([string]$Installer, [string]$ArgumentsFile, [string]$ErrorFile)
$ErrorActionPreference = "Stop"
$Arguments = @{}
$Parsed = [IO.File]::ReadAllText($ArgumentsFile) | ConvertFrom-Json
foreach ($Property in $Parsed.PSObject.Properties) {
    if ($Property.Value -is [bool]) {
        $Arguments[$Property.Name] = [switch]$Property.Value
    } else {
        $Arguments[$Property.Name] = [string]$Property.Value
    }
}
try {
    & $Installer @Arguments
} catch {
    [IO.File]::WriteAllText($ErrorFile, $_.Exception.Message)
    exit 1
}
exit 0
'@
    $Hosts = New-Object 'Collections.Generic.List[string]'
    $WindowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    if (Test-Path -LiteralPath $WindowsPowerShell -PathType Leaf) { $Hosts.Add($WindowsPowerShell) }
    if ($PSVersionTable.PSEdition -eq "Core") { $Hosts.Add((Get-Process -Id $PID).Path) }
    if ($Hosts.Count -eq 0) { throw "no PowerShell host to run the installer with" }
    foreach ($CurrentHost in $Hosts) {
        $script:CurrentHost = $CurrentHost
        $script:HostLabel = if ($CurrentHost -match 'WindowsPowerShell') { "powershell 5.1" } else { "pwsh" }
        Initialize-Scratch ($script:HostLabel -replace '[^a-z0-9]', '')
        Invoke-Cases
    }
} catch {
    $Failures.Add("harness: $($_.Exception.Message)")
} finally {
    Remove-Item Env:\OMAMAIL_PACKAGE_TEST_MODE -ErrorAction SilentlyContinue
    foreach ($Key in $RegistryRoots) {
        try { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($Key, $false) } catch { }
    }
    Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($Failures.Count -ne 0) {
    Write-Output ""
    foreach ($Failure in $Failures) { Write-Output "FAIL $Failure" }
    Write-Output "$($Failures.Count) failed, $Passed passed"
    exit 1
}
Write-Output "$Passed passed"
exit 0
