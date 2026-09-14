# Omamail

Omamail is a native email and calendar app with multiple accounts and keyboard navigation. It runs either as an Omarchy shell plugin or as a standalone Qt desktop application.

<img width="800" alt="Omamail — reading mail with AI assistance" src="docs/images/full-mail.webp" />

## Install

### Omarchy plugin

The plugin requires **Omarchy 4** and follows the active Omarchy theme. It includes the bar widget, `mailto:` integration, and AI assistance through the configured Omarchy agent.

```bash
omarchy plugin add https://github.com/huacnlee/omamail.git --enable
```

Update it with:

```bash
omarchy plugin update omamail
```

Click the envelope in the bar, install the pinned backend when prompted, and add your mailbox. Prebuilt plugin backends are available for Linux x86_64 and aarch64.

### Standalone desktop app

The standalone app includes mail, calendar, and native desktop notifications. This first release has no system tray, AI assistance, or operating-system `mailto:` registration.

| Platform | Published package | Requirement | Installed location |
| --- | --- | --- | --- |
| macOS | `omamail-app-macos-aarch64.tar.gz` | Apple silicon (arm64) | `~/Applications/Omamail.app` |
| Linux | `omamail-app-linux-x86_64.tar.gz` | x86_64, glibc 2.35 or newer | `~/.local/omamail.app` |
| Windows | `omamail-app-windows-x86_64.zip` | x64 Windows | `%LOCALAPPDATA%\omamail` |

Linux uses the tar.gz package; there is no AppImage. The Linux installer also creates `~/.local/bin/omamail` and `~/.local/share/applications/omamail.desktop`. The Windows installer adds the app's `bin` directory to the user PATH and creates a Start Menu shortcut.

On macOS or Linux, install the latest release with curl:

```bash
curl -fsSL https://raw.githubusercontent.com/huacnlee/omamail/main/install.sh | sh
```

On Windows PowerShell, download and run the installer:

```powershell
$installer = Join-Path $env:TEMP 'omamail-install.ps1'
Invoke-WebRequest https://raw.githubusercontent.com/huacnlee/omamail/main/install.ps1 -OutFile $installer
& $installer
```

Both installers download the platform archive and `SHA256SUMS` from the GitHub release, verify the checksum and package layout, and replace an existing installation transactionally. They do not launch the app during installation.

To install a specific version, pass the version without or with the leading `v`:

```bash
curl -fsSL https://raw.githubusercontent.com/huacnlee/omamail/main/install.sh | sh -s -- --version 0.10.1
```

```powershell
& $installer -Version 0.10.1
```

To install a downloaded archive, keep the release's `SHA256SUMS` beside it and run:

```bash
sh ./install.sh --version 0.10.1 --archive ./omamail-app-linux-x86_64.tar.gz --checksums ./SHA256SUMS
```

```powershell
& .\install.ps1 -Version 0.10.1 -ArchivePath .\omamail-app-windows-x86_64.zip -ChecksumPath .\SHA256SUMS
```

Use the matching macOS archive in the shell command when installing locally on macOS.

Uninstalling removes the application and its launcher integration while preserving accounts, drafts, caches, and keyring entries:

```bash
curl -fsSL https://raw.githubusercontent.com/huacnlee/omamail/main/install.sh | sh -s -- --uninstall
```

```powershell
& $installer -Uninstall
```

Standalone release archives are currently unsigned. The macOS app is not notarized and the Windows executable is not code signed, so the operating system may show a publisher or first-launch warning. Build from source if you do not want to approve an unsigned download.

## Run from source

Install Rust, CMake 3.21 or newer, and Qt 6.5 or newer, then use the repository Make targets:

```bash
make app-build
make app-run
```

`make app-run` builds the standalone backend without the AI feature, builds the Qt host, and launches it from the source resources. See [Contributing](CONTRIBUTING.md) for validation commands.

## Features

- **Multiple mailboxes:** Gmail, Outlook, HEY, JMAP and IMAP/SMTP, including Fastmail, iCloud and self-hosted servers.
- **Mail and calendar:** read, search, compose, manage attachments and respond to meeting invitations. Available actions depend on your provider.
- **Keyboard navigation:** `j`/`k` to move, `r` to reply, `c` to compose, `/` to search and `?` for all shortcuts.
- **AI assistance in Omarchy:** ask about selected messages and review suggested drafts using your Omarchy AI setup. See [AI assistance](docs/AGENT.md).
- **Desktop integration:** native notifications and a compact layout for smaller windows; the Omarchy plugin also provides the bar widget and `mailto:` integration.
- **Privacy controls:** credentials stored in the system keyring and remote images blocked until you choose to load them.

<img width="265" alt="Omamail calendar" src="docs/images/full-calendar.webp" /> <img width="265" alt="Writing a message" src="docs/images/full-compose.webp" /> <img width="265" alt="Compact message list" src="docs/images/mini-list.webp" />

## Add your mailbox

Choose a provider in Settings. Gmail needs a Google OAuth client; Outlook needs a Microsoft app registration. HEY uses the official [HEY CLI](https://github.com/basecamp/hey-cli). JMAP and IMAP usually use an app password or API token.

See [mailbox setup](docs/MAILBOXES.md) for provider instructions and limitations, including Microsoft 365 and Proton Mail Bridge.

## Open the Omarchy plugin from the keyboard

Add this to `~/.config/hypr/bindings.lua`:

```lua
o.bind("SUPER + SHIFT + G", "Omamail", "omarchy shell shell toggle omamail '{}'")
```

Press `?` in Omamail for the shortcut sheet, or see the [keyboard guide](docs/KEYS.md).

## Help and contributing

- [Backend installation, updates, release flow, and recovery](docs/BACKEND-RUNTIME.md)
- [Contributing](CONTRIBUTING.md)

Omamail is an independent project and is not affiliated with Google, Microsoft or 37signals. Gmail, Outlook and HEY belong to their respective trademark owners.

Licensed under the [MIT License](LICENSE).
