# The NSH port: ownership and contracts

The app is an NSH TSX app (`App.tsx`) with Rust in `ext/omamail-native` (an nshm)
over the `omamail` library in `core/`. The Qt/QML client under `omarchy/ui/` is
the behavioral specification: every feature, design detail and interaction it
has must exist here (100% parity), improved where NSH allows. `omarchy/` itself
shrinks to an install entry (see "Omarchy plugin").

## Layers

| Layer | Path | Rule |
| --- | --- | --- |
| Backend | `core/` | Unchanged mail logic; same JSON-RPC methods as `omamail serve` (docs/BACKEND.md) |
| Bridge | `ext/omamail-native` | `Backend.request(method, params)` → whole reply, `Backend.nextEvent()`, `Backend.shutdown()`, `Backend.os()` |
| Client | `src/backend/client.ts` | `call(method, params)` → `result` or throws `BackendError{code,message}`; `on(method, fn)` for notifications |
| Domain logic | `src/mail/` | Ports of `omarchy/ui/{account,providers,message,compose,calendar,keys,...}/*.js` to TypeScript: pure, tested |
| ui layer | `src/ui/` | The only place controls are styled. Features import from `src/ui` (index.ts), never `nsh/base` or `nsh-omarchy` directly |
| Shared state | `src/app/store.ts` | Navigation, selection, accounts, overlay. Feature data lives in `src/features/<f>/store.ts` |
| Features | `src/features/<f>/` | Each exports one entry component from `index.tsx` (name fixed, see below) |
| Shell | `src/shell/` | Window regions, responsive modes, split panes, status bar, global keymap |

## Ownership (one agent per row; edit only your paths)

| Owner | Paths | Entry export | Ports from `omarchy/ui` |
| --- | --- | --- | --- |
| shell | `src/shell/`, `src/keys/`, `App.tsx`, `src/app/` | `Shell` | App.qml regions, KeyRouter, KeyHints, ShortcutHelp, AppMenu, SearchBar, keys/Keymap.js, hyprland, diagnostics |
| ui | `src/ui/` (except Icon.tsx names, which anyone may append to) | `src/ui/index.ts` | components that are generic controls; Style.* derivations; skeletons, notices, split handle, key hint, gallery |
| mailbox | `src/features/mailbox/`, `src/mail/mailboxes*`, `src/mail/labels*` | `MailboxSidebar` | MailboxSidebar, MailboxTabs, AccountSwitcher, LabelMenu/Picker, MovePicker, MAILBOXES.md |
| list | `src/features/list/`, `src/mail/list*`, `src/mail/unified*`, `src/mail/batch*` | `MessageList` | MessageList, MessageRow, MessageMenu, ListSkeleton, BatchAction, Unified*, ConversationRail, account/Model.js, Conversation.js |
| list: provider mail clients | `src/mail/list/providers/*.ts` | `MailClient`, `clientFor(account)`, `createClient(rpc, ...)` (read-only for reader/mailbox) | the list/page/summaries/actions/watch halves of providers/{GmailApiClient,ImapClient,JmapClient,M365Client,HeyClient}.qml and BackendSync.qml; auth, tokens and credentials stay with accounts in `src/mail/providers/` |
| reader | `src/features/reader/`, `src/mail/message/` | `Reader` | MessageReader, MessageImages, ImagePopover, Reader* notices, InviteCard, EventSuggestionCard, message/*.js (Html sanitizer, Direction, Unsubscribe, Calendar), Rsvp, Unsubscribe |
| compose | `src/features/compose/`, `src/mail/compose/` | `ComposeSurface` | ComposeView, ContactsPicker, RecipientSuggestions, UndoSendToast, DraftSavedToast, compose/*.js, SendQueue, DraftList, Recovery, Senders, Signature, Mailto, Outbox |
| calendar | `src/features/calendar/`, `src/mail/calendar/` | `CalendarView` | CalendarView, WeekCalendarView, EventComposer, EventDetail, Reminders, calendar/*.js |
| accounts+settings | `src/features/accounts/`, `src/features/settings/`, `src/mail/providers/`, `src/mail/accounts*` | `AccountSetup`, `SettingsPage` | ProviderPicker, SetupPages, Imap/Jmap/M365/Outlook/Hey/Gmail setup, providers/*.js, account/Accounts.js, Aliases, ContactBook, SettingsPage/Sidebar, AiSettings, settings/ |
| assistant+plugin | `src/features/assistant/`, `src/mail/agent/`, `omarchy/` | `AssistantDock` | AssistantDock, ComposeAgent, agent/*, the Omarchy plugin shrink |

Shared files (`src/app/store.ts`, `src/ui/index.ts`, `src/shell/Shell.tsx`) are
owned by shell/ui. Another agent that needs a change there adds **only** new
exports or fields and says so in its report; it never rewrites them.

## Contracts

- Backend: methods and params exactly as the Qt client sends them (grep
  `service.backend.call(` / `.call("` in `omarchy/ui`). No new backend methods
  without a fixture and API revision (AGENTS.md "Backend compatibility").
- Notifications: `on("mail.updated", ...)`, outbox and `gmail.settled` as in
  `omarchy/ui/account/BackendSync.qml`.
- State: `app.select(id)` opens a message; `app.moveCursor(id)` moves the
  keyboard cursor; `app.openOverlay("compose")` opens compose. Compose takes
  its draft from `compose` feature store (`openCompose(draft)` exported from
  `src/features/compose/store.ts`).
- Look: tokens only (`bg-background`, `bg-surface`, `text-text-secondary`,
  `border-border`, `text-danger`, ... from `theme.json`, which is
  nsh-omarchy's `themes/omarchy.json`). No raw colors. Icons through
  `src/ui/Icon.tsx` (`<Icon name="archive" />`), Lucide via nsh-icon.
- Motion: tokens in `src/ui/motion.ts`; each screen's motion inventory goes in
  `DESIGN.md` under its feature heading.
- Security (docs/SECURITY-BOUNDARIES.md): sender-controlled text as plain text;
  message HTML only through the sanitizer and `TextView html` with remote
  images gated by `renderImage`; never fetch remote resources directly; no
  credentials in logs; AI proposals need human approval; model text never
  supplies routing or permission to send.
- Tests: `*.test.ts(x)` beside the code, run by `nsh test`. Port the
  `omarchy/ui/tests` cases for each module you port.

## Omarchy plugin

`omarchy/` keeps one bar widget: a tray entry that, when the standalone app is
missing or older, says so and offers "Install Omamail..." (and opens it when
present). Existing plugin users update into it without losing settings.

The entry is staged in `omarchy/notice/`, beside the Qt plugin it replaces
(which stays as the port's spec until the port is done):

| File | What it is |
| --- | --- |
| `notice/manifest.json` | The plugin's next manifest: the same id `omamail`, kind `bar-widget` only, entry `notice/BarWidget.qml`, no settings schema |
| `notice/BarWidget.qml` | An envelope in the bar. Installed app: a click opens it. Missing: a dot, the tooltip "Omamail is now a standalone app. Install Omamail...", and a click opens the homepage (a fixed URL). It runs no backend and reads no mail |
| `notice/omamail-app.sh` | Fixed commands only: `status` (finds the desktop entry `dev.huacnlee.omamail` or `omamail-app` on PATH), `open`, and `export-settings` |

Settings: on first load the widget writes the old plugin's settings once to
`$XDG_CONFIG_HOME/omamail/plugin-settings.json` (mode 600, at most 64 KiB,
`{version: 1, settings}`). Accounts, credentials, drafts, the outbox and AI
jobs need no migration: the app runs the same `core/` with the same state
directories. On its first run (no settings of its own stored yet) the app
imports that file once (`src/features/settings/store.ts`). It reads the file
through `Backend.readConfig("plugin-settings.json")`, which is read-only:
`core/src/platform/app_config.rs` `READ_ONLY_NAMES`, and writeConfig refuses
it. The file is untrusted: only the `{version: 1, settings}` envelope is
taken, and each owner validates its own keys.

- Settings page keys: through `Model.normalizeSettings`.
- `aiAgent` and `aiModel`: through `aiSettings.setAgent` / `setModel`.
- The calendar's five keys: through `importCalendarSettings` in
  `src/features/calendar/settings.ts`.

Nothing in the file is a credential, and none is read from it.

"Older" is not detected yet: the app has no version the helper can read
without starting it. Decide it with packaging (a version in the desktop
entry, `X-Omamail-Version`, is the simplest), then compare it in `status`.

At the cutover, in one release PR:

1. Move `notice/manifest.json` to `omarchy/manifest.json` and bump its version
   past the last Qt plugin release.
2. Remove `omarchy/ui/` whole: `App.qml`, `Service.qml`, `BarWidget.qml` and
   every directory under it (`account`, `agent`, `assets`, `backend`, `bar`,
   `cache`, `calendar`, `components`, `compose`, `diagnostics`, `hyprland`,
   `keys`, `message`, `providers`, `settings`, `tests`).
3. Remove the plugin's backend plumbing: `omarchy/scripts/` except what the
   release still needs (`release-notes.sh`, `bump.sh`, `publish.sh` are
   repository tooling, not plugin code; move them to the root `scripts/`),
   `omarchy/install.sh`, `omarchy/install.ps1`, `omarchy/dev/`, the plugin's
   binary pin `core/backend-version` with its handshake checks (the app links
   the backend, so there is no binary to pin), and `omarchy/Makefile`'s QML
   lint and test targets.
4. Point `omarchy/omastore.toml` at the NSH app's package.

### Settings sections not ported

- **Bar** (show the bar icon): dropped. The standalone app has no bar widget
  of its own; the notice widget in `omarchy/notice/` is always shown and has
  no settings. `showBarIcon` is ignored on import.
- **Default mail client**: Linux only, through `MailClient` in
  `ext/omamail-native/src/mail_client.rs`. It is a port of
  `scripts/default-mail.sh`: fixed argv, no shell. It does two things:
  - writes the app's own hidden entry
    `$XDG_DATA_HOME/applications/dev.huacnlee.omamail.mailto.desktop`
    (`Exec=<this executable, quoted per the Desktop Entry spec> %u`,
    `MimeType=x-scheme-handler/mailto;`, `NoDisplay=true`), written
    atomically as 0644 without following links. It then runs
    `update-desktop-database` on that folder and makes the entry the default
    with `xdg-mime` and `xdg-settings` (as `scripts/register-mailto.sh` did);
  - writes the same managed block in `$XDG_CONFIG_HOME/hypr/bindings.lua`,
    now pointing at `gtk-launch dev.huacnlee.omamail` and `xdg-open mailto:`.

  Then it runs `hyprctl reload`. The link reaches the running app through
  `Backend.launchMailto()` (wired by shell and compose).

  Known behaviour, as in Qt's `default-mail.sh`:
  - `bindings.lua` is replaced through a temporary file and a rename
    (Qt: `mktemp` + `mv`), so a symlinked `bindings.lua` (dotfiles) becomes
    a regular file and the link's target is left unchanged.
  - On then off removes only a whole managed block, but it normalizes the
    rest (Qt: `awk`): CRLF becomes LF, and trailing blank lines and a
    missing final newline are not restored byte for byte.

  On macOS and Windows the section is hidden. There, the system's mail
  settings own the default mail app; macOS asks the user itself, and nothing
  in the app can claim it silently.

## Keys and commands (shell contract)

All keys go through `src/keys/commands.ts`; never bind keys yourself.

- `registerCommand(id, ({ slot, sequence }) => ...)`: `id` is a binding id from
  `src/keys/keymap.ts` (the KEYS.md table: archive, trash, star, reply, compose,
  cursorDown, goMailbox (slot 0..8), send, saveEvent, calendarNext, zoomIn,
  refresh, undoSend, ...). Newest registration wins; it is removed when the
  registering component unmounts. A key is bound only while something answers
  it, so unclaimed keys reach the focused control.
- The shell handles, when unclaimed: back, help, search, settings,
  toggleSidebar, calendar, mailView, calendarView, backToList, openReader/open
  (`app.select(cursorId)`), goAccount, switchAccount (`openOverlay("accounts")`),
  compose (`openOverlay("compose")`).
- Escape order: `registerEscape(() => boolean)` layers newest first (assistant,
  calendar preview, guest suggestions, compose agent return true when handled)
  → a popup overlay closes → ticked rows untick → navigation back.
- Leaving compose / eventComposer / calendarDetail: register `"leave:compose"`,
  `"leave:eventComposer"`, `"leave:calendarDetail"` to ask or save, then call
  `app.closeOverlay()` yourself; unregistered, the shell pops it.
- `reportKeyState(() => ({...}))` while mounted. Context: assistantEditing,
  assistantCommands, eventComposing, guestSuggestions, eventDescriptionFocused.
  Hints: `unavailable: string[]`, `actions: { archive: "unarchive", ... }`.
  Status: listLoading, serverSearching, activity, lastError, calendarAvailable,
  canOpenWebInbox, hasAgent, assistantWidth.
- Commands the shell's buttons/menus run: "refresh", "compose",
  "markAllRead", "openWebInbox", "diagnoseError" (status bar shows "Diagnose
  with AI..." only when registered and lastError is set).

Navigation is a history stack (`src/app/navigation.ts`, port of Navigation.js);
`app.page()/overlay()/readerOpen()` derive from it. `select(id)` pushes the
reader; `openPage("settings"|"setup")` pushes, `openPage("mail"|"calendar")`
swaps the root; `openOverlay("compose"|"shortcuts"|"eventComposer")` pushes.
Also: `nav() navPage() navOverlay() composing() helpOpen() calendarVisible()
showPage() push(kind) resetNav() back() toggleHelp() setSidebarCollapsed()
searchFocused() setSearchFocused() focusSearch()`. `setNotice` clears after 6 s.

## Deviations from the Qt client

Deliberate differences, each an improvement or a platform necessity.

- **Status-bar account control** (`src/shell/AccountMenu.tsx`): a tool button
  whose tooltip names its shortcut, Alt+A; Qt's `accountControl` had no
  tooltip. The tooltip hides while the switcher is open. Screen readers hear
  "Mailbox: <address>. Switch account...", as before.

## Deviations from the Qt client

Deliberate differences, each with the Qt behaviour, why it changed and what
the port does instead.

### Base size reaches the ui layer, not every pixel (ui)

- **Qt:** every QML item took its type and spacing from the shell's
  `Style.font` / `Style.space`, so `[font] base-size` in shell.toml scaled the
  whole window.
- **Why:** nsh-omarchy draws its controls at Rust constants
  (`tokens::CONTROL_*`, `TEXT_*`, `SPACE_*`), and NSH's own text scale
  (`set_font_scale`) belongs to the embedding host, not the app.
- **Port:** `src/ui/font.ts` reads shell.toml through `Backend.omarchyFont()`
  (while the app has the focus) and scales by base-size / 14: `TYPE` / `TEXT`,
  control heights, `Icon`, every 4pt spacing class built with `cx`; the ui
  wrappers of nsh-omarchy's Button, IconButton, Input, Textarea, NumberInput,
  ListItem and TitleBar (`src/ui/Controls.tsx`, sizes as host classes; the
  bar's title is drawn by the wrapper); and nsh-omarchy's Checkbox, Switch,
  Tooltip, Tabs / Tab, Calendar, DatePicker, HoverCard, Toaster / `toast()`,
  Menu / ContextMenu / MenuItem / MenuLabel / MenuSeparator, Field, Select,
  Dialog / AlertDialog / Sheet and Popover, redrawn on nsh/base with
  nsh-omarchy's look and props. At 14 they measure as nsh-omarchy's
  (`src/ui/parity.test.tsx`, `calendar.test.tsx`, `datepicker.test.tsx`,
  `toast.test.tsx`). Of nsh-omarchy's components, `src/ui/index.ts` re-exports
  only `Separator` (a line, no size) and `Omarchy` (theme and font API), so a
  feature cannot pick up an unscaled one. Not scaled: the title bar's height
  (the window's title-bar option, 36), nsh-omarchy's glyphs inside the
  wrapped controls, and feature-local classes written without `cx` or with
  fixed arbitrary values.

### `confirm()` asks in the window (ui)

- **Qt:** confirmations were in-app dialogs that followed the theme.
- **Why:** nsh-omarchy's `confirm()` is the platform's native alert, which
  neither follows the Omarchy theme nor the base size.
- **Port:** `confirm()` and `confirmAction()` from `src/ui` ask in the ui
  `AlertDialog` of a mounted `ConfirmHost` (the main window's shell mounts
  one), one question at a time in the order asked. With no host mounted (a
  preview, a window without one) they fall back to the platform's alert.

### Suggested events skip list mail (reader)

- **Qt:** `EventSuggester.qml` passes `!!account.selectedUnsubscribe` to
  `Agent.worthALook` as "list mail". The look is considered when
  `selectedBody` changes, and `MailAccount.qml` sets `selectedBody` before
  `selectedUnsubscribe`, which it reset to null on selection. So the value is
  always null at that moment, and newsletters with a date in them were looked
  at.
- **Why:** the gate's own comment says mail from a list is not asked about.
  The old ordering defeated it, which spent agent runs on bulk mail.
- **Port:** `src/features/reader/assistant.ts` passes
  `reader.listMail()` (`unsubscribe().available`). That is read from the
  same resource as the body, so a message that offers an unsubscribe is never
  looked at.
- **mailto: links** (`src/shell/launch.ts`): NSH lets an app claim only a
  scheme of its own (`nsh.json` "schemes" refuses `mailto`), so the handler is
  registered outside NSH, as Qt's was, and only on Linux (desktop entry
  `MimeType=x-scheme-handler/mailto;`, Settings > Default mail client). A
  later launch's link reaches the running app through `"singleInstance": true`
  and opens a draft; a link that starts the app is read once from
  `Backend.launchMailto()` (NSH 0.7.2 has no `process.argv`). Links are untrusted: only a `mailto:` argument up
  to 32 KiB is taken, read by compose's RFC 6068 parser, and it only fills a
  draft.

## Plugin cutover, steps 1-3 (shell)

- Core reads nothing from `omarchy/` any more. The 30 files its tests read
  (found by tracing every node read during `cargo test --lib`) are copied
  into `core/tests/oracles/ui/` with their `omarchy/ui` layout, so
  `load('message/Direction.js')` resolves as before.
  `NativeDomain.js` is copied to `core/assets/`, which the
  `include_str!` now points at. `attachment.sh` and `agent-job.py` are copied
  to `core/tests/fixtures/`. Neither was ever spawned at run time.
  `legacy_worker_args` checks the fixture copy under `cfg(test)`. Outside
  tests it still checks the old checkout path, which stops matching once
  `omarchy/scripts` is gone.
- The repository root `manifest.json` is the notice widget's (id `omamail`,
  entry `omarchy/notice/BarWidget.qml`). Omarchy installs a plugin as a git
  checkout and reads only its top-level manifest, so existing installs keep
  their entry after `omarchy plugin update`.
  `omarchy/tests/test_manifest.sh` checks:
  - the manifest is strict JSON;
  - the id, the kinds and the single entry;
  - the entry is relative, has no `..`, and resolves inside the checkout to
    that file;
  - the helper beside it is executable and not world-writable;
  - the empty settings schema.
  The notice's staging manifest is removed. `omarchy/notice` is git-added.
- Not done yet: `git rm` of `omarchy/ui`, the plugin scripts and
  `omarchy/manifest.json`; the `omarchy/Makefile` and ci.yml wiring.
  Pending NSH packaging: install.sh/.ps1, pages.yml, release.yml app
  packaging, omastore.toml.

## Plugin cutover, step 4 (shell)

- Removed: `omarchy/ui/` (430 files), `omarchy/dev`, `omarchy/manifest.json`
  and 30 plugin scripts from `omarchy/scripts/`. Kept there: the release
  tooling `release.yml` and `make publish` run (`bump.sh`, `publish.sh`,
  `publish-backend.sh`, `package-backend.py`, `release-notes.sh`,
  `release-source.sh`) and `google-cloud-project.sh`, which Gmail setup
  names to the user.
- `omarchy/Makefile` now covers only the plugin entry that stays:
  `test` (`tests/test_manifest.sh`, `tests/test_app_helper.sh`), `lint`
  (shellcheck) and `validate` (`omarchy plugin validate` where installed).
  CI runs `make -C omarchy test lint` as the "Omarchy plugin entry" job.
- The agent-job checkout path in `core/src/agent/jobs.rs` now names a file
  that is gone outside tests; it only ever recognised a running worker, so a
  missing file matches nothing.
- Left for their owners: `core/tests/test_*.{sh,py}` that drove the removed
  scripts (no workflow on this branch runs them), and docs that describe the
  Qt plugin's scripts (`docs/NETWORK-MIGRATION.md`, `docs/BACKEND-RUNTIME.md`,
  `docs/SECURITY-BOUNDARIES.md`, `docs/MESSAGE-RENDERING.md`,
  `docs/providers/{jmap,imap}.md`, `docs/MAILBOXES.md`, `docs/SPEC.md`,
  `docs/ARCHITECTURE.md`), plus the `ui/` lines in AGENTS.md's "Structure
  and boundaries", which predate this branch.

## Plugin cutover, step 4 follow-ups (shell)

- `core/tests`: the scripts tests that drove only removed plugin scripts are
  gone (`git rm`): test_attachment{,_open,_save,_common}, test_calendar_{delete,
  transport,write}, test_config_store, test_default_mail, test_imap_ordering,
  test_jmap_transport, test_jmap_stream, test_link_plugin, test_mailto,
  test_source, test_source_hash_tools, test_transport, test_agent_job,
  test_backend_runtime, test_calendar_notifications, test_contacts,
  test_curl_config, test_diagnostics, test_notification, test_plugin_workflow,
  test_public_http, test_runtime_release_contract, test_app_make, test_dev.
  All of them already failed on this branch (they expected `core/scripts/`).
- Moved to `omarchy/tests/` and run by `make -C omarchy test` (CI job
  "Omarchy plugin entry"): test_release_notes.sh, test_release_source.sh,
  test_publish.sh, test_publish_backend.py.
- Kept in place because a protected workflow names them or another test
  imports them: test_backend_release.py, test_backend_api.py (release.yml),
  test_website_install.py (pages.yml), test_agent_bridge.py (imported by
  test_agent_native_bridge.py). These, and the QML-era tests in `core/tests`
  (test_qml_*, test_sidebar_text, test_tooltip_text, test_service_source,
  test_clipboard, test_outlook_http, test_backend_process,
  test_agent_published_qml, run_qml_native.py, *_backend.js,
  test_reader_pipeline.js), still assume the old layout and fail; they need
  an owner's port or removal.
- Security properties of removed tests, and where Rust covers them now:
  public addresses, pinning, redirects and size bounds:
  `core/src/public_http/tests.rs`; unsubscribe:
  `core/src/mail/read_links.rs` and `public_http`; redirects never carrying
  credentials: `core/src/auth/mod.rs`, `calendar/discovery_runtime_tests.rs`;
  attachment paths: `compose/tests.rs`, `mail/send_tests.rs`; mailto argv:
  `ext/omamail-native/src/lib.rs`; agent jobs: `core/src/agent/jobs.rs`.
  The curl config batch has no successor (nothing runs curl any more).
  New-mail notifications are `notify()` in `src/features/list/store.ts`.
  Default mail client and diagnostics: `ext/omamail-native/src/mail_client.rs`
  and `diagnostics.rs` (`cargo test` in `ext/omamail-native`; Linux-only
  process paths unverified on macOS).
- CI: core-tests also runs `cargo test --no-default-features --features
  standalone,integration-test-credentials --tests`, as main did, so
  `tests/cli.rs` runs off the keyring.

### Follow-up doc work

These still describe the Qt plugin's scripts and need rewriting for NSH:
`docs/NETWORK-MIGRATION.md`, `docs/BACKEND-RUNTIME.md`,
`docs/SECURITY-BOUNDARIES.md`, `docs/MESSAGE-RENDERING.md`,
`docs/providers/jmap.md`, `docs/providers/imap.md`, `docs/MAILBOXES.md`,
`docs/SPEC.md`, `docs/ARCHITECTURE.md`, and CONTRIBUTING.md's
`tests/test_source.sh` rows. AGENTS.md's QML lint and `Service.qml` bullets
are stale too.

## NSH issue: title-bar presses lost while a field is focused

Draft, not filed. NSH 0.7.2 (CLI 0c29b5e), macOS 27.2, `nsh test --target
macos`. In a window with a hidden title bar (nsh-omarchy `TitleBar`), a
`Button` inside the title bar's area never gets its press while a text field
is the first responder; with no focused field it does, and buttons below the
area always do. The content view gets the pointer's enter and moves (and the
tooltip shows) but no touch start, press down or mouse up for that click.
`desktop={{ windowDrag: false }}` and a plain `View` with title-bar insets
behave the same. Suspected: `crates/nsh-platform-macos/src/input.rs`,
`window_press` / `window_press_drag` / `window_press_up` and `window_drag`;
AppKit may route the mouse-down through the titlebar container while a field
editor is first responder.

Repro: a `TitleBar` holding a `Button` that counts presses, an `Input` with
`autoFocus`, and `app.press` on the button: the count stays 0.

Stopgap in Omamail until it is fixed: `releaseSearchFocus` in
`src/shell/SearchBar.tsx`, called by each header button's wrapper
(`ReleasesSearch` in `src/shell/Header.tsx`) on `onMouseEnter` and
`onTouchStartCapture`, and only when the field holds the focus; tested by
`src/shell/Header.stopgap.test.tsx` (passes headless and on macOS, fails on
both without the stopgap). Inline compose's header has the same stopgap:
`releaseFieldFocus` in `src/features/compose/ComposeView.tsx`, on each header
control's `onMouseEnter` / `onTouchStartCapture`, tested by
`src/features/compose/header.stopgap.test.tsx` (passes on macOS, fails there
without the stopgap).

A second case, with no field focused: an nsh/base `Toolbar` (ui's
`ActionBar`) in the hidden title bar's area takes a press only on its first
item, the roving tab stop; its other items lose a press in about the top 31pt
of the window and take one below that. A plain row there takes every press.
Stopgap: ui's `ActionBar` renders a plain row in the band (`inTitleBar`, or
inside ui's `TitleBar`); compose's header passes `inTitleBar` where the
window's title bar is hidden, and `detach.test.tsx` runs again. Suspected: the same
`window_press` path, for views that refuse first responder.

Remove the stopgaps and their tests once NSH delivers the press.

## Packaging and releases

Done in the release-nsh-packages change; this supersedes the "pending NSH
packaging" items above.

- `nsh package` builds the release on each desktop: macOS arm64 (ad hoc
  signed `Omamail.app`), Linux x86_64 (`Omamail/` with its desktop entry) and
  Windows x86_64 (`Omamail\`). The update archives it names
  (`Omamail-<version>-<os>-<arch>`) are the release assets.
- The app updates itself through `nsh/updater` from GitHub releases. The
  release's `latest.json` is signed with the key whose public half is
  `nsh.json`'s `updater.publicKey`; the secret is the `NSH_UPDATE_KEY`
  repository secret.
- `release.yml`, `omarchy/scripts/{publish,bump,release}`, the installers and
  `omastore.toml` serve that release. The standalone `omamail` binary
  packages, `core/backend-version` and the binary release scripts are gone;
  the app runs its own executable for `serve` and the agent entry points.
- The app icon is `assets/icon.png`, rendered from the Qt app's macOS plate
  and logo by `assets/icon/render.sh`.
