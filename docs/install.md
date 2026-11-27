# Install a release

Releases are published at <https://github.com/huacnlee/omamail/releases>. The
installers download the latest release for your system and check it against
the release's `SHA256SUMS` before installing anything. They run as the current
user and need no administrator access. Releases are built for macOS on Apple
silicon, Linux on x86_64 and Windows on x86_64. The installers install 0.13.0
and later; 0.12 and earlier were the Qt app, which they replace.

Once installed, Omamail updates itself: it asks when a new version is out, and
**Check for Updates...** in the app menu and in Settings looks right away.
Updates are signed, and the app refuses one whose signature does not match.

## macOS and Linux

```sh
curl -fsSL https://huacnlee.github.io/omamail/install.sh | sh
```

To pass options, replace `sh` with `sh -s --` followed by the options, for
example `sh -s -- --version 0.13.0`.

| Option | Environment | Default |
| --- | --- | --- |
| `--version VERSION` | `OMAMAIL_VERSION` | the latest release |
| `--dir DIRECTORY` | `OMAMAIL_INSTALL_DIR` | `~/Applications` on macOS, `~/.local` on Linux |
| `--uninstall` | | |

**macOS** (14 or later): the installer puts `Omamail.app` in
`~/Applications`, replacing the copy that is there. The app is ad hoc signed,
not notarized. Open it from Finder or Spotlight.

**Linux**: `--dir` is an installation prefix. Under it the installer puts:

- the app in `share/omamail/Omamail`,
- the desktop entry `share/applications/dev.huacnlee.omamail.desktop`, so app
  launchers find Omamail,
- the command `bin/omamail-app`.

A prefix other than `~/.local` needs its `share` directory on `XDG_DATA_DIRS`
for launchers to find the entry. The app needs glibc 2.39 or later, GTK 4.14 or
later and WebKitGTK 6.0: `gtk4` and `webkitgtk-6.0` on Arch, `libgtk-4-1` and
`libwebkitgtk-6.0-4` on Debian and Ubuntu. The installer changes no
package-manager or shell configuration.

Upgrading from Omamail 0.12 or earlier removes the Qt app from
`~/.local/omamail.app`, its `omamail.desktop` entry, and its `~/.local/bin/omamail`
link when that link still points into it.

## Windows

In PowerShell:

```powershell
irm https://huacnlee.github.io/omamail/install.ps1 | iex
```

The installer puts Omamail in `%LOCALAPPDATA%\Programs\Omamail` and adds a
Start menu shortcut. Close Omamail before running it again. For options,
download the script first:

```powershell
Invoke-WebRequest https://huacnlee.github.io/omamail/install.ps1 -OutFile "$env:TEMP\omamail-install.ps1"
& "$env:TEMP\omamail-install.ps1" -Version 0.13.0
```

| Option | Environment | Default |
| --- | --- | --- |
| `-Version VERSION` | `OMAMAIL_VERSION` | the latest release |
| `-InstallDir PATH` | `OMAMAIL_INSTALL_DIR` | `%LOCALAPPDATA%\Programs\Omamail` |
| `-Uninstall` | | |

Upgrading from Omamail 0.12 or earlier removes the Qt app's files from
`%LOCALAPPDATA%\omamail`, its `bin` entry on your `PATH`, and its notification
registration. If PowerShell's policy refuses to run scripts, download the zip
from the release page instead.

## Manual installation and removal

Every release archive is portable. Download the one for your system, check its
SHA-256 against `SHA256SUMS`, and extract it:

| System | Archive | Contains |
| --- | --- | --- |
| macOS | `Omamail-VERSION-macos-aarch64.tar.gz` | `Omamail.app`; move it to Applications |
| Linux | `Omamail-VERSION-linux-x86_64.tar.gz` | `Omamail/`, with the `Omamail` runner and a desktop entry |
| Windows | `Omamail-VERSION-windows-x86_64.zip` | `Omamail\`, with `Omamail.exe` |

The app updates itself where it was extracted, so put it somewhere your user
can write to.

To uninstall, close Omamail and run the installer with `--uninstall` (or
`-Uninstall` on Windows), or remove what it installed: `Omamail.app` on macOS;
on Linux, `share/omamail/Omamail`, `share/applications/dev.huacnlee.omamail.desktop`
and `bin/omamail-app` under the prefix; on Windows, the install directory and
the Omamail Start menu shortcut. Neither way removes your accounts, settings or
downloaded mail. Those stay in Omamail's own directories (on Linux,
`~/.config/omamail`, `~/.local/state/omamail` and `~/.cache/omamail`) and in
your system's credential store.
