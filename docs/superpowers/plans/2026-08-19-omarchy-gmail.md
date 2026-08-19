# Omarchy Gmail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native Gmail application window for Omarchy — read, triage, search, and reply to mail over the official Gmail REST API, in about 60 MB instead of a browser tab.

**Architecture:** A Quickshell plugin with three entry points inside the already-running `omarchy-shell` process: a headless `service` singleton owning auth and mailbox state, a `bar-widget` showing the unread badge, and a `panel` that is a real `FloatingWindow` application. Every parsing, formatting, and decision rule lives in `.pragma library` JavaScript so it runs under node in tests; QML stays a declarative description of the screen.

**Tech Stack:** QML (Qt 6.11) + Quickshell, plain ES5-style JS libraries, `qs.Commons` / `qs.Ui` from the Omarchy shell, Gmail REST API v1, Google OAuth 2.0 (PKCE, loopback), GNOME Keyring via `secret-tool`, node for tests, `qmllint` for QML.

**Spec:** `docs/SPEC.md`

## Global Constraints

- Plugin id is `gmail.omarchy`; the app window title is `Omarchy Gmail`.
- Every colour comes from the active Omarchy theme — `Color.foreground`, `Color.background`, `Color.accent`, `Color.urgent`, or a value derived from one of those with `Qt.darker` / `Qt.lighter` / `Qt.rgba`. No hex literals in QML outside a declared brand asset. Reusable components take the colours they need as required properties so a theme swap propagates.
- Every size and gap comes from `Style.space(px)` / `Style.font.*` / `Style.spacing.*`. No raw pixel numbers.
- Button and menu labels end in `...` when activating them opens a dialog, a page, a browser, or a terminal workflow rather than completing the action.
- JS libraries start with `.pragma library` and use `var` / `function` only — the QML JS engine and the node `vm` loader both have to read the same file. No `const`, `let`, arrow functions, template literals, or `class` in files under the repo root. Test files under `tests/` are node-only and may use modern syntax.
- No dependency beyond what Omarchy already ships: `socat`, `secret-tool`, `openssl`, `xdg-open`, `notify-send`, `sh`.
- OAuth scopes are exactly `https://www.googleapis.com/auth/gmail.modify` and `https://www.googleapis.com/auth/gmail.send`.
- Loopback redirect is `http://127.0.0.1:<port>/oauth2callback`, default port `9481`.
- Credentials file is `$XDG_CONFIG_HOME/omarchy-gmail/credentials.json`, mode 0600. Refresh tokens live only in GNOME Keyring under service `omarchy-gmail`. Access tokens live only in process memory.
- `make validate` must pass before any task is considered done. It runs the node tests, the source regression tests, `qmllint`, and `omarchy plugin validate .`.

---

## File Structure

| File | Responsibility |
|---|---|
| `manifest.json` | Declares the three entry points and the user-facing settings schema. |
| `OAuth.js` | PKCE, authorization URL, loopback callback parsing, token parsing, scope checking, credential redaction. |
| `Credentials.js` | Parsing and serialising the Google Cloud OAuth client, in the console's own JSON shape. |
| `GmailApi.js` | Gmail REST paths, query building, URL allow-listing, error translation, response shaping. |
| `Message.js` | base64 + UTF-8, RFC 2047 headers, address parsing, MIME body extraction, RFC 5322 composition. |
| `Html.js` | Sanitising message HTML down to the subset Qt's rich text engine renders, and blocking remote images. |
| `Model.js` | Mailboxes, setup state machine, optimistic list edits, notification de-duplication, display strings. |
| `AuthManager.qml` | The OAuth flow, keyring, and credentials file. Hands out access tokens. |
| `GmailApiClient.qml` | Authenticated transport. Owns `XMLHttpRequest` and nothing else. |
| `Service.qml` | Shared mailbox state and every decision about when to fetch. The `service` entry point. |
| `BarWidget.qml` | Bar icon, unread badge, launcher. The `bar-widget` entry point. |
| `App.qml` | The application window and its layout, navigation, and keyboard. The `panel` entry point. |
| `components/GmailIcon.qml` | The envelope, drawn at bar size, with a count badge. |
| `components/MailboxSidebar.qml` | Left column: system mailboxes and user labels. |
| `components/MailboxTabs.qml` | The same mailboxes as a horizontal strip, for narrow windows. |
| `components/MessageList.qml` | Middle column: rows, empty states, paging. |
| `components/MessageRow.qml` | One message row. |
| `components/MessageReader.qml` | Right column: headers, body, attachments, actions. |
| `components/ComposeWindow.qml` | Compose, reply, reply-all, forward — its own `FloatingWindow`. |
| `components/MessageMenu.qml` | The list's right-click triage menu. |
| `components/SearchBar.qml` | The search field and its clear/scope affordances. |
| `components/AppMenu.qml` | The `⋮` overflow menu. |
| `components/SetupPage.qml` | The four-step Google Cloud walkthrough. |
| `components/SetupCard.qml` | The compact "next thing to do" card. |
| `components/ShortcutHelp.qml` | The `Ctrl+/` reference sheet. |
| `scripts/pkce.sh` | Emits verifier, challenge, and state. |
| `scripts/keyring-store.sh` | Writes the refresh token to GNOME Keyring from stdin. |
| `scripts/credentials-store.sh` | Writes the OAuth client to a 0600 file from stdin. |
| `tests/*.js` | node tests for every JS library. |
| `tests/test_qml_names.py` | Checks every component file is reachable and named consistently. |
| `tests/test_source.sh` | Source regressions: no hard-coded colours, no modern JS in library files. |
| `Makefile`, `install.sh` | Verification and development install. |

---

## Design revisions (2026-08-19, after the UI review)

Three decisions from the design canvas change tasks below. They are recorded
here so a task's implementer sees them without having to open the canvas.

1. **Compose is its own window.** `components/ComposeWindow.qml` wraps a second
   `FloatingWindow` (720×560), declared in `App.qml` and shown while composing.
   It is not a column in the main window — Hyprland tiles it beside the
   mailbox, so the message being answered stays visible. Task 7 no longer
   reserves body space for it; Task 11 builds the window.
2. **The list has a right-click menu.** `components/MessageMenu.qml`, styled
   like the shell's other popups (`Color.popups.background`, 1px
   `Color.popups.border`, 28px rows). Reply / reply all / forward, archive /
   trash / spam, mark read-unread, star, open in browser. Added to Task 8.
3. **Reader actions are icons.** The labelled button row in Task 10 becomes
   icon buttons with tooltips, sharing one 16px stroke grid with the menu so no
   action is drawn twice.

---

## Task 1: JavaScript foundation — OAuth, credentials, API shaping, MIME, view models

**Status: COMPLETE.** Verified by `node tests/test_oauth.js tests/test_credentials.js tests/test_gmail_api.js tests/test_message.js tests/test_model.js` — all five pass.

**Files:**
- Created: `OAuth.js`, `Credentials.js`, `GmailApi.js`, `Message.js`, `Model.js`
- Created: `tests/load.js`, `tests/test_oauth.js`, `tests/test_credentials.js`, `tests/test_gmail_api.js`, `tests/test_message.js`, `tests/test_model.js`

**Interfaces produced (later tasks depend on these exact names):**

```
OAuth.js
  AUTH_URL, TOKEN_URL, DEFAULT_PORT, CALLBACK_PATH, SCOPES
  normalizedPort(value) -> int
  redirectUri(port) -> string
  formBody(object) -> string
  authorizationUrl({clientId, challenge, state, port, scopes, loginHint}) -> string
  parseCallbackRequestLine(line, expectedPath) -> {ok, code, state, error}
  parsePkceOutput(line) -> {ok, verifier, challenge, state, error}
  parseTokenResponse(status, text, previousRefreshToken)
      -> {ok, accessToken, refreshToken, expiresIn, scope, invalidGrant, error}
  missingScopes(grantedScopeString, requiredArray) -> array
  missingScopeMessage(missingArray) -> string
  redact(text) -> string
  successResponse() / failureResponse() -> raw HTTP response string

Credentials.js
  empty() -> {clientId, clientSecret, projectId}
  isValidClientId(value) -> bool
  isConfigured(credentials) -> bool
  parse(text) -> {ok, error, credentials}
  serialize(credentials) -> string        // the console's own {"installed":{...}} shape
  load(text) -> credentials
  path(home) -> string
  describe(credentials) -> string

GmailApi.js
  API_BASE, SYSTEM_LABELS
  safeApiUrl(path) -> string ("" when refused)
  appendQuery(url, values) -> string      // array values repeat the key
  messagesPath() messagePath(id) modifyPath(id) trashPath(id) untrashPath(id)
  batchModifyPath() sendPath() threadPath(id) labelsPath() labelPath(id)
  profilePath() attachmentPath(messageId, attachmentId)
  listQuery(query, maxResults, pageToken) -> {q, maxResults, pageToken}
  metadataQuery() -> {format, metadataHeaders}
  fullQuery() -> {format}
  responseError(status, payload, fallback) -> string
  rateLimitSuffix(retryAfter) -> string
  parseMessageList(payload) -> {ids, threadIds, nextPageToken, estimate}
  parseLabels(payload) -> [{id, name, rawName, system, unread, total, threadsUnread}]
  parseLabelCounts(payload) -> {id, unread, total, threadsUnread}
  parseProfile(payload) -> {email, messagesTotal, threadsTotal, historyId}
  webMessageUrl(id, accountIndex) / webSearchUrl(query, accountIndex) -> string

Message.js
  decodeBase64Url(text) / encodeBase64(text) / encodeBase64Url(text)
  decodeHeaderValue(value) -> string      // RFC 2047
  headerValue(message, name) / decodedHeader(message, name)
  parseAddress(value) -> {name, email, display}
  parseAddressList(value) -> [address]
  formatAddressList(addresses, limit) -> string
  extractBody(payload) -> {text, source}  // source is "plain" | "html" | ""
  extractHtml(payload) -> string          // ADDED IN TASK 5
  attachments(payload) -> [{filename, mimeType, size, attachmentId}]
  formatSize(bytes) -> string
  relativeTime(date, now) / fullTime(date) -> string
  summarize(message, now) -> summary      // see below
  replySubject(subject) / quoteBody(summary, body) -> string
  buildRawMessage(fields) / buildSendPayload(fields) -> string / {raw, threadId}

  summary = {id, threadId, from, replyTo, messageId, to, subject, snippet,
             date, time, fullTime, unread, starred, important, inInbox,
             inTrash, isDraft, labelIds, sizeEstimate}

Model.js
  MAILBOXES = [{key, label, query, labelId, icon}]   keys:
      inbox, unread, starred, sent, all, trash
  mailbox(key) / mailboxIndex(key) / mailboxQuery(key, extraQuery)
  setupState({toolsPresent, credentialsPresent, signingIn, signedIn}) -> string
      // "tools_missing" | "no_credentials" | "signing_in" | "signed_out" | "ready"
  setupHeadline(state) / setupDetail(state, missingTools) / setupActionLabel(state)
  survivesAction(mailboxKey, action) -> bool
  labelChangesFor(action) -> {add, remove} | null
  applyLabelChange(summary, action) -> summary       // pure, returns a copy
  removeById(list, id) / replaceById(list, summary) / indexById(list, id)
  unreadCount(list) / badgeText(count, cap) / barTooltip(state, email, unread)
  newArrivals(summaries, seenIds, primed) -> [summary]
  notificationBody(summary) -> string
  resultSummary(list, estimate, hasMore) / pluralize(n, s, p) / truncate(text, limit)
```

- [x] **Step 1: Confirm the suite still passes before building on it**

Run: `node tests/test_oauth.js && node tests/test_credentials.js && node tests/test_gmail_api.js && node tests/test_message.js && node tests/test_model.js`
Expected: five `... ok` lines, exit 0.

---

## Task 2: Auth and transport QML

**Status: COMPLETE.** No test harness exists for these yet — they are covered indirectly by Task 14's source checks and by manual sign-in.

**Files:**
- Created: `AuthManager.qml`, `GmailApiClient.qml`
- Created: `scripts/pkce.sh`, `scripts/keyring-store.sh`, `scripts/credentials-store.sh`

**Interfaces produced:**

```
AuthManager (Item)
  required property string pluginDir
  property int oauthPort;  property var scopes;  property string loginHint
  readonly credentialsPresent, clientId, clientDescription, credentialsPath
  readonly toolsPresent, toolsChecked, missingTools
  property loggedIn, sessionChecked, loginBusy, sessionBusy, credentialsWriteBusy
  property lastError, grantedScope
  withAccessToken(callback(token, error))
  invalidateAccessToken() / restoreSession() / beginLogin() / cancelLogin() / logout()
  saveCredentials(text) -> bool
  signals: loginSucceeded(), loggedOut(), sessionUnavailable(reason), credentialsSaved()

GmailApiClient (Item)
  required property var auth
  readonly property bool busy
  newHandle() / abortRequest(handle)
  request(method, path, query, body, callback, retried, existingHandle) -> handle
  listMessages(query, maxResults, pageToken, callback(page, error)) -> handle
  getMessage(id, full, callback(payload, error)) -> handle
  getMessages(ids, full, callback(payloads, error), existingHandle) -> handle
  getLabels(callback(labels, error)) / getLabelCounts(labelId, callback(counts, error))
  getProfile(callback(profile, error))
  modifyMessage(id, add, remove, callback) / batchModify(ids, add, remove, callback)
  trashMessage(id, callback) / untrashMessage(id, callback)
  sendMessage(payload, callback)
```

- [x] **Step 1: Confirm the helper scripts are executable and self-contained**

Run: `sh -n scripts/pkce.sh && sh -n scripts/keyring-store.sh && sh -n scripts/credentials-store.sh && ls -l scripts/`
Expected: no syntax errors, all three `-rwxr-xr-x`.

---

## Task 3: Service becomes a real service entry point

`Service.qml` currently takes `pluginDir` and `settings` as properties a parent sets. A `service` plugin has no parent that can do that: the shell constructs it directly and injects `shell`, `manifest`, `pluginRegistry`, and `barWidgetRegistry` only. Settings live on the bar widget's `shell.json` entry, so the bar widget has to push them in — which is exactly what Omarchy-Spotify does with `spotify.applySettings(settings)`.

**Files:**
- Modify: `Service.qml:1-60` (the property block) and its tail (add `applySettings`)
- Test: `tests/test_service_source.sh` (new)

**Interfaces:**
- Consumes: everything from Tasks 1 and 2.
- Produces: `Service.applySettings(values)`, `Service.pluginId`, `Service.pluginDir`, and the `windowOpen` property that `App.qml` drives (replacing today's `panelOpen`).

- [ ] **Step 1: Write the failing source test**

Create `tests/test_service_source.sh`:

```bash
#!/usr/bin/env bash
# The shell constructs a service plugin itself and injects only these four
# properties. A `required property` the shell does not know about makes the
# whole plugin fail to instantiate, with the reason buried in a console warning.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail() { printf 'test_service_source.sh: %s\n' "$1" >&2; exit 1; }

grep -q 'property var shell' Service.qml || fail "Service.qml must accept an injected shell"
grep -q 'property var manifest' Service.qml || fail "Service.qml must accept an injected manifest"
grep -q '__sourceDir' Service.qml || fail "pluginDir must come from manifest.__sourceDir"
grep -q 'function applySettings' Service.qml || fail "the bar widget pushes settings in via applySettings"

if grep -qE '^\s*required property' Service.qml; then
  fail "Service.qml must not declare required properties: the shell cannot satisfy them"
fi

printf 'test_service_source.sh ok\n'
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/test_service_source.sh`
Expected: FAIL with `Service.qml must not declare required properties`.

- [ ] **Step 3: Rewrite the Service property block**

Replace the top of `Service.qml` (from `required property string pluginDir` through `property bool panelOpen: false`) with:

```qml
  // Injected by the shell when it constructs the service singleton. Nothing
  // else is handed over, which is why settings arrive later from the bar
  // widget rather than as a property binding.
  property var shell: null
  property var manifest: null
  property var pluginRegistry: null
  property var barWidgetRegistry: null

  readonly property string pluginId: manifest && manifest.id
    ? String(manifest.id) : "gmail.omarchy"
  readonly property string pluginDir: manifest && manifest.__sourceDir
    ? String(manifest.__sourceDir) : ""

  readonly property var defaultSettingValues: ({
    refreshIntervalSec: 120,
    maxMessages: 25,
    defaultQuery: "in:inbox",
    showUnreadCount: "On",
    notifyNewMail: "On",
    oauthPort: 9481
  })
  property var settings: defaultSettingValues

  // The window drives this; the unread poll keeps running when it is false.
  property bool windowOpen: false

  // Reassigning the whole object is what makes the readonly settings below
  // re-evaluate. Mutating it in place would not.
  function applySettings(values) {
    var next = ({})
    for (var key in defaultSettingValues) next[key] = defaultSettingValues[key]
    var source = values || ({})
    for (var name in source) {
      if (source[name] === undefined || source[name] === null) continue
      next[name] = source[name]
    }
    if (JSON.stringify(next) !== JSON.stringify(settings)) settings = next
  }
```

- [ ] **Step 4: Rename every remaining `panelOpen` to `windowOpen`**

Run: `sed -i 's/\bpanelOpen\b/windowOpen/g' Service.qml && grep -n windowOpen Service.qml`
Expected: the `onWindowOpenChanged` handler and the three reads inside `refresh()` and `pollTimer`.

- [ ] **Step 5: Point AuthManager at the derived plugin directory**

In `Service.qml`, the `AuthManager { pluginDir: root.pluginDir }` binding already reads the property — confirm it still resolves now that `pluginDir` is `readonly` and derived:

Run: `grep -n 'pluginDir' Service.qml`
Expected: the `readonly property string pluginDir` declaration and the single `pluginDir: root.pluginDir` binding.

- [ ] **Step 6: Run the test to verify it passes**

Run: `bash tests/test_service_source.sh`
Expected: `test_service_source.sh ok`

- [ ] **Step 7: Commit**

```bash
git add Service.qml tests/test_service_source.sh
git commit -m "feat: make Service a self-contained service entry point"
```

---

## Task 4: Three entry points, and a verification harness that runs them

**Files:**
- Modify: `manifest.json`
- Create: `Makefile`, `install.sh`, `tests/test_install.sh`

**Interfaces:**
- Consumes: `Service.qml` from Task 3.
- Produces: `make test`, `make qml-check`, `make validate`; the entry point names `Service.qml` / `BarWidget.qml` / `App.qml` that Tasks 6 and 7 create.

- [ ] **Step 1: Write the failing manifest test**

Create `tests/test_install.sh`:

```bash
#!/usr/bin/env bash
# The manifest is the contract with the shell. Every entry point it names has
# to exist, or the plugin loads halfway and fails at the moment the user
# clicks something.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail() { printf 'test_install.sh: %s\n' "$1" >&2; exit 1; }

python3 -c "import json; json.load(open('manifest.json'))" || fail "manifest.json is not valid JSON"

kinds=$(python3 -c "import json; print(' '.join(json.load(open('manifest.json'))['kinds']))")
for kind in service bar-widget panel; do
  case " $kinds " in *" $kind "*) ;; *) fail "manifest kinds must include $kind" ;; esac
done

for entry in service:Service.qml barWidget:BarWidget.qml panel:App.qml; do
  key=${entry%%:*}
  file=${entry##*:}
  declared=$(python3 -c "import json; print(json.load(open('manifest.json'))['entryPoints'].get('$key',''))")
  [ "$declared" = "$file" ] || fail "entryPoints.$key must be $file, found '$declared'"
  [ -f "$file" ] || fail "$file is declared in the manifest but does not exist"
done

[ -x install.sh ] || fail "install.sh must be executable"
grep -q 'plugin-backups' install.sh || fail "backups must not land inside the plugins directory"

printf 'test_install.sh ok\n'
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/test_install.sh`
Expected: FAIL with `manifest kinds must include service`.

- [ ] **Step 3: Rewrite the manifest head**

Replace the top of `manifest.json` down to and including `"entryPoints"`:

```json
{
  "schemaVersion": 1,
  "id": "gmail.omarchy",
  "name": "Omarchy Gmail",
  "version": "0.1.0",
  "author": "Jason Lee",
  "license": "MIT",
  "description": "Read, triage, and reply to Gmail in a native Omarchy window, over the official Gmail API.",
  "kinds": [
    "service",
    "bar-widget",
    "panel"
  ],
  "activation": "on-demand",
  "entryPoints": {
    "service": "Service.qml",
    "barWidget": "BarWidget.qml",
    "panel": "App.qml"
  },
```

Keep the existing `barWidget` block, and add one setting to it, in the `defaults` and in the `schema`:

```json
      "openOnClick": "Window"
```

```json
      {
        "key": "openOnClick",
        "type": "enum",
        "label": "Clicking the bar icon opens",
        "options": [
          "Window",
          "Quick preview"
        ],
        "defaultValue": "Window",
        "description": "The full window, or a small card with the most recent unread mail."
      }
```

- [ ] **Step 4: Create placeholder entry points so the manifest is honest**

```bash
printf 'import QtQuick\n\nItem {}\n' > BarWidget.qml
printf 'import QtQuick\n\nItem {}\n' > App.qml
```

These are replaced wholesale in Tasks 6 and 7. They exist now so `make validate` is runnable from this task onward.

- [ ] **Step 5: Write the Makefile**

```makefile
QMLLINT := /usr/lib/qt6/bin/qmllint
QML_FILES := Service.qml BarWidget.qml App.qml \
	AuthManager.qml GmailApiClient.qml \
	components/GmailIcon.qml \
	components/MailboxSidebar.qml \
	components/MailboxTabs.qml \
	components/MessageList.qml \
	components/MessageRow.qml \
	components/MessageReader.qml \
	components/ComposeView.qml \
	components/SearchBar.qml \
	components/AppMenu.qml \
	components/SetupPage.qml \
	components/SetupCard.qml \
	components/ShortcutHelp.qml

.PHONY: test test-js test-shell qml-check validate

test: test-js test-shell

# The parsing, formatting, and command-building live in plain JS precisely so
# they can be tested without a compositor. These run anywhere node does.
test-js:
	node tests/test_oauth.js
	node tests/test_credentials.js
	node tests/test_gmail_api.js
	node tests/test_message.js
	node tests/test_html.js
	node tests/test_model.js

test-shell:
	python3 tests/test_qml_names.py
	bash tests/test_source.sh
	bash tests/test_service_source.sh
	bash tests/test_install.sh

# Needs the Omarchy shell's qs.Commons / qs.Ui on the import path.
qml-check:
	$(QMLLINT) -I /usr/share/omarchy/shell $(QML_FILES)

validate: test qml-check
	omarchy plugin validate .
	git diff --check
```

- [ ] **Step 6: Write install.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugin_id="gmail.omarchy"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
plugin_home="$config_home/omarchy/plugins"
install_path="$plugin_home/$plugin_id"
# Backups must live outside the plugins directory. Omarchy scans every
# subdirectory of it for a manifest, so a backup left alongside the install is
# a second plugin with the same id — and the shell then loads the stale copy.
backup_home="$config_home/omarchy/plugin-backups"
restart_shell=true

usage() { printf 'Usage: %s [--no-restart]\n' "$0"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-restart) restart_shell=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

command -v omarchy >/dev/null 2>&1 || {
  printf '%s\n' 'omarchy is required to install this plugin.' >&2
  exit 1
}

for tool in socat secret-tool openssl xdg-open; do
  command -v "$tool" >/dev/null 2>&1 || {
    printf 'Note: %s is not on PATH. Google sign-in needs it.\n' "$tool" >&2
  }
done

printf '%s\n' 'Validating plugin…'
omarchy plugin validate "$project_dir"

mkdir -p "$plugin_home"
if [[ -L "$install_path" && "$(readlink -f "$install_path")" == "$project_dir" ]]; then
  :
elif [[ -e "$install_path" || -L "$install_path" ]]; then
  mkdir -p "$backup_home"
  backup_path="$backup_home/$plugin_id.bak.$(date +%Y%m%d%H%M%S)"
  mv "$install_path" "$backup_path"
  printf 'Backed up the previous install to %s\n' "$backup_path"
  ln -s "$project_dir" "$install_path"
else
  ln -s "$project_dir" "$install_path"
fi

if $restart_shell; then
  printf '%s\n' 'Restarting Omarchy shell…'
  omarchy restart shell
fi

printf '%s\n' 'Registering Omarchy Gmail in the bar…'
omarchy-shell shell rescanPlugins
omarchy plugin enable "$plugin_id"

printf 'Omarchy Gmail installed for development at %s\n' "$install_path"
printf '%s\n' 'Click the envelope in the bar. QML edits are read through the symlink.'
```

Run: `chmod +x install.sh`

- [ ] **Step 7: Run the test to verify it passes**

Run: `bash tests/test_install.sh`
Expected: `test_install.sh ok`

- [ ] **Step 8: Commit**

```bash
git add manifest.json Makefile install.sh BarWidget.qml App.qml tests/test_install.sh
git commit -m "feat: declare service, bar widget, and window entry points"
```

---

## Task 5: HTML rendering — sanitise to Qt's rich text subset, block remote images

Qt's rich text engine renders a subset of HTML 4 and CSS 2.1 natively, with no browser engine involved: tables, inline styles, `<font>`, links, and images all work, which covers the table-and-inline-style HTML that almost every real email uses. Two things must be handled before handing it to `TextEdit`:

1. `<script>`, `<style>`, `<iframe>`, `<object>`, `<meta>`, and event-handler attributes are noise at best. Qt ignores most of them, but `<style>` blocks leak their raw CSS text into the rendered output.
2. Qt **does** fetch `<img src="https://…">` over the network. Every tracking pixel in the message fires the moment the reader opens it. Remote images are therefore rewritten out by default and restored only when the reader asks.

**Files:**
- Create: `Html.js`
- Create: `tests/test_html.js`
- Modify: `Message.js` (add `extractHtml`)
- Modify: `tests/test_message.js` (cover `extractHtml`)

**Interfaces:**
- Consumes: `Message.extractBody`, `Message.decodePart` behaviour from Task 1.
- Produces:
  ```
  Html.sanitize(html, options) -> {html, blockedImages}
      options = {allowRemoteImages: bool}
  Html.hasRemoteImages(html) -> bool
  Html.documentFor(bodyHtml, colors) -> string
      colors = {foreground, background, link, quote}
  Message.extractHtml(payload) -> string
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/test_html.js`:

```javascript
const assert = require("assert")
const { load } = require("./load")

const html = load("Html.js")

// ------------------------------------------------------------- stripping
//
// Qt's rich text engine ignores unknown tags but renders the *text content*
// of a <style> block, so a message with a stylesheet shows its CSS as a wall
// of text unless the block is removed outright.

assert.strictEqual(html.sanitize("<style>p{color:red}</style><p>hi</p>").html, "<p>hi</p>")
assert.strictEqual(html.sanitize("<script>alert(1)</script>text").html, "text")
assert.strictEqual(html.sanitize("<iframe src='x'></iframe>text").html, "text")
assert.strictEqual(html.sanitize("<p onclick='x()'>hi</p>").html, "<p>hi</p>")
assert.strictEqual(html.sanitize("<a href='javascript:x()'>hi</a>").html, "<a>hi</a>")
assert.strictEqual(html.sanitize("<!-- c -->kept").html, "kept")

// The tags that carry an email's actual layout must survive untouched.
const table = "<table><tr><td style=\"color:#333\"><b>Total</b></td></tr></table>"
assert.strictEqual(html.sanitize(table).html, table)
assert.strictEqual(html.sanitize("<a href=\"https://example.com\">link</a>").html,
  "<a href=\"https://example.com\">link</a>")

// -------------------------------------------------------- remote images
//
// Qt fetches <img src="https://..."> for real. Left alone, every tracking
// pixel in the message fires the moment the reader opens it.

const tracked = "<p>Hi</p><img src=\"https://track.example/pixel.gif\" width=\"1\">"
const blocked = html.sanitize(tracked)
assert.strictEqual(blocked.blockedImages, 1)
assert.ok(blocked.html.indexOf("track.example") < 0, "the URL must not reach the renderer")
assert.ok(blocked.html.indexOf("<p>Hi</p>") === 0, "the rest of the message is untouched")

const allowed = html.sanitize(tracked, { allowRemoteImages: true })
assert.strictEqual(allowed.blockedImages, 0)
assert.ok(allowed.html.indexOf("https://track.example/pixel.gif") > 0)

// cid: images point at attachments this plugin does not fetch, and data: URIs
// are already local. Neither is a network request, and neither is counted.
assert.strictEqual(html.sanitize("<img src=\"cid:logo\">").blockedImages, 0)
assert.strictEqual(html.sanitize("<img src=\"data:image/png;base64,AAA\">").blockedImages, 0)
assert.strictEqual(html.sanitize("<img src='http://a/b.png'><img src='https://c/d.png'>").blockedImages, 2)

assert.strictEqual(html.hasRemoteImages(tracked), true)
assert.strictEqual(html.hasRemoteImages("<p>none</p>"), false)

assert.strictEqual(html.sanitize("").html, "")
assert.strictEqual(html.sanitize(null).html, "")

// ------------------------------------------------------------- document
//
// Colours are passed in from the panel, which read them off the active theme.
// Nothing in this file may name a colour.

const doc = html.documentFor("<p>hi</p>", {
  foreground: "#cacccc", background: "#101315", link: "#7aa2f7", quote: "#707880"
})
assert.ok(doc.indexOf("<p>hi</p>") > 0)
assert.ok(doc.indexOf("#cacccc") > 0, "the theme foreground reaches the document")
assert.ok(doc.indexOf("blockquote") > 0, "quoted replies get their own colour")

console.log("test_html.js ok")
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/test_html.js`
Expected: FAIL — `Html.js` does not exist, `ENOENT`.

- [ ] **Step 3: Write Html.js**

```javascript
.pragma library

// Message HTML, reduced to what Qt's rich text engine actually renders.
//
// Qt supports a subset of HTML 4 and CSS 2.1 natively — tables, inline
// styles, <font>, links, images — which is most of what real email uses,
// because real email is still table-and-inline-style HTML written for
// Outlook. What it does not support it ignores, with two exceptions this
// module exists to handle:
//
//   - a <style> block's CSS text is rendered as body text
//   - <img src="https://..."> is genuinely fetched, so every tracking pixel
//     in the message fires the moment the reader opens it
//
// Remote images are therefore removed by default and the count is reported so
// the reader can offer to load them.

var DROPPED_ELEMENTS = ["script", "style", "iframe", "object", "embed", "applet", "noscript"]

function stripElement(text, name) {
  var open = new RegExp("<" + name + "\\b[^>]*>[\\s\\S]*?<\\/" + name + "\\s*>", "gi")
  var lone = new RegExp("<\\/?" + name + "\\b[^>]*>", "gi")
  return String(text).replace(open, "").replace(lone, "")
}

function isRemoteSource(value) {
  return /^\s*(https?:)?\/\//i.test(String(value || ""))
}

// Only http(s) and mailto survive. A javascript: href does nothing in Qt's
// renderer, but it would still be handed to xdg-open by the link handler.
function safeHref(value) {
  return /^\s*(https?:|mailto:)/i.test(String(value || ""))
}

function sanitize(html, options) {
  var settings = options || {}
  var text = String(html === undefined || html === null ? "" : html)
  if (text === "") return { html: "", blockedImages: 0 }

  text = text.replace(/<!--[\s\S]*?-->/g, "")
  for (var i = 0; i < DROPPED_ELEMENTS.length; i++) text = stripElement(text, DROPPED_ELEMENTS[i])
  text = text.replace(/<(meta|link|base)\b[^>]*>/gi, "")

  // Event handlers, which Qt ignores but which have no business surviving a
  // trip through a mail client.
  text = text.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")

  text = text.replace(/\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    function(match, raw, dq, sq, bare) {
      var value = dq !== undefined ? dq : (sq !== undefined ? sq : bare)
      return safeHref(value) ? match : ""
    })

  var blocked = 0
  if (settings.allowRemoteImages !== true) {
    text = text.replace(/<img\b[^>]*>/gi, function(tag) {
      var source = tag.match(/\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i)
      if (!source) return tag
      var value = source[2] !== undefined ? source[2]
        : (source[3] !== undefined ? source[3] : source[4])
      if (!isRemoteSource(value)) return tag
      blocked++
      // Removed rather than emptied: an <img> with no src still reserves a
      // broken-image box in Qt's layout, which reads as a rendering fault.
      return ""
    })
  }

  return { html: text, blockedImages: blocked }
}

function hasRemoteImages(html) {
  return sanitize(html).blockedImages > 0
}

// Wraps the sanitised body in a document that carries the active Omarchy
// theme. Every colour is passed in — nothing here names one.
function documentFor(bodyHtml, colors) {
  var palette = colors || {}
  var foreground = String(palette.foreground || "")
  var background = String(palette.background || "")
  var link = String(palette.link || foreground)
  var quote = String(palette.quote || foreground)
  return "<html><head><style type=\"text/css\">"
    + "body{color:" + foreground + ";background-color:" + background + ";}"
    + "a{color:" + link + ";}"
    + "blockquote{color:" + quote + ";margin-left:8px;padding-left:8px;}"
    + "td,th{padding:2px;}"
    + "</style></head><body>" + String(bodyHtml || "") + "</body></html>"
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/test_html.js`
Expected: `test_html.js ok`

- [ ] **Step 5: Add `extractHtml` to Message.js**

`extractBody` already walks the MIME tree and converts HTML to text. The reader needs the HTML itself. Add, directly after `extractBody`:

```javascript
// The same walk as extractBody, kept separate because the reader wants the
// markup and the list row wants the flattened text, and neither should pay
// for the other's work.
function extractHtml(payload) {
  var found = ""

  function walk(part, depth) {
    if (!part || depth > 12 || found) return
    var mime = String(part.mimeType || "").toLowerCase()
    var children = Array.isArray(part.parts) ? part.parts : []
    if (children.length > 0) {
      for (var i = 0; i < children.length; i++) walk(children[i], depth + 1)
      return
    }
    if (isAttachment(part)) return
    if (mime.indexOf("text/html") === 0) found = decodePart(part)
  }

  walk(payload, 0)
  return found
}
```

- [ ] **Step 6: Cover it in the message tests**

Append to `tests/test_message.js`, before the final `console.log`:

```javascript
// The reader wants the markup; the list row wants the flattened text. Both
// walks must find the same part.
assert.strictEqual(message.extractHtml(multipart), "<p>html body</p>")
assert.strictEqual(message.extractHtml(nested), "<p>outer html</p>")
assert.strictEqual(message.extractHtml({ mimeType: "text/plain", body: { data: b64url("x") } }), "")
assert.strictEqual(message.extractHtml(null), "")
```

- [ ] **Step 7: Run both suites**

Run: `node tests/test_html.js && node tests/test_message.js`
Expected: two `... ok` lines.

- [ ] **Step 8: Commit**

```bash
git add Html.js Message.js tests/test_html.js tests/test_message.js
git commit -m "feat: render message HTML through Qt rich text, with remote images blocked"
```

---

## Task 6: The bar widget

**Files:**
- Replace: `BarWidget.qml`
- Uses: `components/GmailIcon.qml` (already written)

**Interfaces:**
- Consumes: `Service.badgeText`, `Service.barTooltip`, `Service.inboxUnread`, `Service.setupState`, `Service.applySettings`, `Service.refresh()`, `Service.markAllRead()`, `Service.openWebInbox()`.
- Produces: nothing other tasks read. It is a leaf.

- [ ] **Step 1: Write BarWidget.qml**

```qml
import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model
import "components"

// The bar's job is one number and one click. Everything the widget knows comes
// from the shared service, which keeps running whether or not the window is
// open — that is the whole reason the unread count can be trusted.
BarWidget {
  id: root

  moduleName: "gmail.omarchy"

  readonly property var gmail: bar && bar.shell
    ? bar.shell.serviceFor("gmail.omarchy") : null
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property bool windowMode: String(root.setting("openOnClick", "Window")) !== "Quick preview"

  // The service is a singleton shared with the window, so the widget pushes
  // the user's settings into it rather than reading them itself.
  onSettingsChanged: if (gmail) gmail.applySettings(settings)
  Component.onCompleted: if (gmail) gmail.applySettings(settings)
  onGmailChanged: if (gmail) gmail.applySettings(settings)

  function openWindow() {
    if (bar && bar.shell && typeof bar.shell.toggle === "function")
      bar.shell.toggle("gmail.omarchy", "{}")
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    tooltipText: root.gmail ? root.gmail.barTooltip : "Gmail"

    // Read from inside `iconComponent`. Both BarIconButton and GmailIcon name
    // their own root object `root`, so nothing inside a Component declared
    // here refers to `root` — it would be ambiguous about which one it meant.
    readonly property color glyphColor: root.gmail && root.gmail.ready
      ? root.barForeground
      : Qt.darker(root.barForeground, 1.55)
    readonly property string countText: root.gmail ? root.gmail.badgeText : ""
    readonly property bool unreadPresent: countText !== ""
    readonly property bool disconnected: !root.gmail || !root.gmail.ready

    iconComponent: Component {
      Item {
        GmailIcon {
          anchors.centerIn: parent
          iconSize: Style.space(12)
          color: button.glyphColor
          badgeColor: Color.urgent
          badgeText: button.countText
          open: button.unreadPresent
          crossed: button.disconnected
        }
      }
    }

    onPressed: function(buttonCode) {
      if (buttonCode === Qt.MiddleButton) {
        if (root.gmail) root.gmail.refresh()
      } else if (buttonCode === Qt.RightButton) {
        if (root.gmail) root.gmail.openWebInbox()
      } else {
        root.openWindow()
      }
    }
  }
}
```

- [ ] **Step 2: Lint it**

Run: `/usr/lib/qt6/bin/qmllint -I /usr/share/omarchy/shell BarWidget.qml components/GmailIcon.qml`
Expected: no errors. Warnings about unqualified access to `bar` are expected — `bar` is injected by the host.

- [ ] **Step 3: Commit**

```bash
git add BarWidget.qml
git commit -m "feat: bar widget with unread badge that launches the window"
```

---

## Task 7: The application window

The panel entry point is an `Item` the shell keeps loaded only while open, calling `open(payloadJson)` and `close()` on it. The window itself is a `FloatingWindow` bound to that state.

**Files:**
- Replace: `App.qml`
- Delete: `components/MailboxTabs.qml` is kept (narrow layout uses it)

**Interfaces:**
- Consumes: `Service` (injected as `service`), every component from Tasks 8–13.
- Produces:
  - `App.currentView` — `"list"` | `"reader"` | `"compose"` | `"setup"`
  - `App.cursorId` — the message id under the keyboard cursor
  - `App.compact` / `App.wide` — the two layout breakpoints
  - `App.startCompose(mode, summary)` where mode is `"new"` | `"reply"` | `"replyAll"` | `"forward"`

- [ ] **Step 1: Write the window shell**

```qml
import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model
import "components"

// The application window. The shell loads this entry point when the plugin is
// summoned and calls open()/close() on it; the FloatingWindow follows.
Item {
  id: root

  property var shell: null
  property var manifest: null
  property var service: null
  property bool opened: false
  property bool closingFromHost: false

  readonly property string pluginId: manifest && manifest.id
    ? String(manifest.id) : "gmail.omarchy"

  readonly property color foreground: Color.foreground
  readonly property color background: Color.background
  readonly property color accent: Color.accent
  readonly property color urgent: Color.urgent
  readonly property color dim: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.55)
  readonly property string fontFamily: Style.font.family

  // Two breakpoints, not a continuum: three columns, list-plus-reader with the
  // sidebar collapsed to a strip, and a single column that switches between
  // list and reader.
  readonly property bool wide: window.width >= Style.space(1000)
  readonly property bool compact: window.width < Style.space(760)

  property string currentView: "list"
  property string cursorId: ""
  property bool imagesAllowed: false
  property bool plainTextForced: false
  property bool shortcutHelpVisible: false

  readonly property bool setupRequired: !service || !service.ready
  readonly property bool composing: currentView === "compose"

  function open(payloadJson) {
    var payload = ({})
    try { payload = JSON.parse(String(payloadJson || "{}")) || ({}) } catch (e) {}
    closingFromHost = false
    opened = true
    if (service) service.windowOpen = true
    if (payload.mailbox && service) service.selectMailbox(String(payload.mailbox))
    if (payload.compose === true) startCompose("new", null)
    Qt.callLater(function() { focusScope.forceActiveFocus() })
  }

  function close() {
    closingFromHost = true
    opened = false
    if (service) service.windowOpen = false
    closingFromHost = false
  }

  function requestClose() {
    if (shell && typeof shell.hide === "function") shell.hide(pluginId)
    else close()
  }

  // Opening a message resets the two per-message reader toggles: a decision to
  // load images applies to the message it was made on, never to the next one.
  function openMessage(id) {
    if (!service) return
    imagesAllowed = false
    plainTextForced = false
    cursorId = String(id || "")
    service.select(cursorId)
    currentView = "reader"
  }

  function backToList() {
    if (service) service.clearSelection()
    currentView = "list"
    Qt.callLater(function() { focusScope.forceActiveFocus() })
  }

  function moveCursor(delta) {
    if (!service) return
    var next = service.selectOffset(delta)
    if (next === "") return
    cursorId = next
    if (currentView === "reader") service.select(next)
  }

  function startCompose(mode, summary) {
    compose.begin(mode, summary || (service ? service.selectedMessage : null))
    currentView = "compose"
  }

  function cancelCompose() {
    compose.reset()
    currentView = service && service.selectedId !== "" ? "reader" : "list"
    Qt.callLater(function() { focusScope.forceActiveFocus() })
  }

  Connections {
    target: root.service
    ignoreUnknownSignals: true
    function onReplySent() { root.cancelCompose() }
  }

  FloatingWindow {
    id: window
    visible: root.opened
    title: "Omarchy Gmail"
    color: root.background
    implicitWidth: Style.space(980)
    implicitHeight: Style.space(720)
    minimumSize: Qt.size(Style.space(760), Style.space(520))

    onVisibleChanged: {
      if (!visible && root.opened && !root.closingFromHost) root.requestClose()
    }

    FocusScope {
      id: focusScope
      anchors.fill: parent
      focus: true

      // ... header, three columns, and status bar go here (Steps 2-4)
    }
  }
}
```

- [ ] **Step 2: Add the header row inside the FocusScope**

```qml
      Item {
        id: header
        anchors.top: parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        height: Style.space(48)

        Row {
          anchors.left: parent.left
          anchors.leftMargin: Style.space(14)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(8)

          GmailIcon {
            anchors.verticalCenter: parent.verticalCenter
            iconSize: Style.font.iconLarge
            color: root.foreground
            badgeColor: root.urgent
            open: root.service && root.service.inboxUnread > 0
          }

          Text {
            anchors.verticalCenter: parent.verticalCenter
            visible: !root.compact
            text: "Gmail"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.title
          }
        }

        SearchBar {
          id: searchBar
          anchors.centerIn: parent
          width: Math.min(Style.space(460), parent.width - Style.space(260))
          textColor: root.foreground
          accentColor: root.accent
          panelFontFamily: root.fontFamily
          enabled: !root.setupRequired
          onSubmitted: function(query) { if (root.service) root.service.search(query) }
          onCleared: if (root.service) root.service.search("")
        }

        Row {
          anchors.right: parent.right
          anchors.rightMargin: Style.space(14)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(4)

          PanelActionButton {
            iconText: "⟳"
            tooltipText: "Refresh"
            foreground: root.foreground
            enabled: !root.setupRequired && !(root.service && root.service.listLoading)
            onClicked: if (root.service) root.service.refresh()
          }

          Button {
            text: root.compact ? "✉" : "Compose"
            foreground: root.foreground
            bordered: true
            fontSize: Style.font.bodySmall
            enabled: !root.setupRequired
            onClicked: root.startCompose("new", null)
          }

          AppMenu {
            textColor: root.foreground
            panelFontFamily: root.fontFamily
            signedIn: root.service && root.service.ready
            onMarkAllReadRequested: if (root.service) root.service.markAllRead()
            onOpenWebRequested: if (root.service) root.service.openWebInbox()
            onShortcutsRequested: root.shortcutHelpVisible = true
            onSetupRequested: root.currentView = "setup"
            onSignOutRequested: if (root.service) root.service.signOut()
          }
        }

        PanelSeparator {
          anchors.bottom: parent.bottom
          width: parent.width
          foreground: root.foreground
        }
      }
```

- [ ] **Step 3: Add the three-column body**

```qml
      Item {
        id: body
        anchors.top: header.bottom
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: statusBar.top

        MailboxSidebar {
          id: sidebar
          anchors.left: parent.left
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          width: root.wide ? Style.space(180) : Style.space(52)
          visible: !root.compact && !root.setupRequired
          collapsed: !root.wide
          service: root.service
          textColor: root.foreground
          accentColor: root.accent
          panelFontFamily: root.fontFamily
          onMailboxSelected: function(key) {
            root.service.selectMailbox(key)
            root.backToList()
          }
        }

        // Narrow windows lose the sidebar and get the same mailboxes as a
        // scrollable strip above the list.
        MailboxTabs {
          id: tabs
          anchors.top: parent.top
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.margins: Style.space(8)
          visible: root.compact && !root.setupRequired
          textColor: root.foreground
          panelFontFamily: root.fontFamily
          current: root.service ? root.service.mailboxKey : "inbox"
          unread: root.service ? root.service.inboxUnread : 0
          onSelected: function(key) {
            root.service.selectMailbox(key)
            root.backToList()
          }
        }

        Item {
          id: listColumn
          anchors.left: sidebar.visible ? sidebar.right : parent.left
          anchors.top: tabs.visible ? tabs.bottom : parent.top
          anchors.bottom: parent.bottom
          anchors.topMargin: tabs.visible ? Style.space(8) : 0
          width: root.compact
            ? (root.currentView === "list" ? parent.width : 0)
            : Style.space(340)
          visible: width > 0 && !root.setupRequired

          Flickable {
            id: listFlick
            anchors.fill: parent
            anchors.margins: Style.space(8)
            contentWidth: width
            contentHeight: list.implicitHeight
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            MessageList {
              id: list
              width: listFlick.width
              service: root.service
              textColor: root.foreground
              accentColor: root.accent
              panelFontFamily: root.fontFamily
              cursorId: root.cursorId
              onMessageActivated: function(id) { root.openMessage(id) }
              onRowHovered: function(id, isHovered) { if (isHovered) root.cursorId = id }
            }
          }

          PanelSeparator {
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            width: 1
            visible: !root.compact
            foreground: root.foreground
          }
        }

        MessageReader {
          id: reader
          anchors.left: listColumn.visible ? listColumn.right : parent.left
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          visible: !root.setupRequired && !root.composing
            && (!root.compact || root.currentView === "reader")
          service: root.service
          textColor: root.foreground
          backgroundColor: root.background
          accentColor: root.accent
          urgentColor: root.urgent
          panelFontFamily: root.fontFamily
          allowRemoteImages: root.imagesAllowed
          forcePlainText: root.plainTextForced
          showBack: root.compact
          onLoadImagesRequested: root.imagesAllowed = true
          onTogglePlainTextRequested: root.plainTextForced = !root.plainTextForced
          onBackRequested: root.backToList()
          onReplyRequested: root.startCompose("reply", null)
          onReplyAllRequested: root.startCompose("replyAll", null)
          onForwardRequested: root.startCompose("forward", null)
        }

        ComposeView {
          id: compose
          anchors.left: listColumn.visible && !root.compact ? listColumn.right : parent.left
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          visible: root.composing
          service: root.service
          textColor: root.foreground
          accentColor: root.accent
          panelFontFamily: root.fontFamily
          onCancelled: root.cancelCompose()
        }

        // Setup takes the whole body: there is nothing else to look at until
        // the mailbox is connected.
        Flickable {
          anchors.fill: parent
          anchors.margins: Style.space(18)
          visible: root.setupRequired || root.currentView === "setup"
          contentWidth: width
          contentHeight: setup.implicitHeight
          clip: true
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          SetupPage {
            id: setup
            width: Math.min(parent.width, Style.space(560))
            service: root.service
            textColor: root.foreground
            panelFontFamily: root.fontFamily
            onBackRequested: root.currentView = "list"
          }
        }
      }
```

- [ ] **Step 4: Add the status bar**

```qml
      Item {
        id: statusBar
        anchors.bottom: parent.bottom
        anchors.left: parent.left
        anchors.right: parent.right
        height: Style.space(28)

        PanelSeparator {
          anchors.top: parent.top
          width: parent.width
          foreground: root.foreground
        }

        Text {
          anchors.left: parent.left
          anchors.leftMargin: Style.space(14)
          anchors.verticalCenter: parent.verticalCenter
          text: root.service && root.service.accountEmail !== ""
            ? root.service.accountEmail + " · " + Model.pluralize(root.service.inboxUnread, "unread")
            : "Not connected"
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }

        // One line for whatever the window most needs to say: what it is
        // doing, or what went wrong.
        Text {
          anchors.right: parent.right
          anchors.rightMargin: Style.space(14)
          anchors.verticalCenter: parent.verticalCenter
          text: root.service
            ? (root.service.actionStatus !== "" ? root.service.actionStatus : root.service.lastError)
            : ""
          color: root.service && root.service.lastError !== "" && root.service.actionStatus === ""
            ? root.urgent : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }
```

- [ ] **Step 5: Lint**

Run: `make qml-check`
Expected: no errors. (Components from Tasks 8–13 must exist first; if running this task standalone, lint only `App.qml` after creating empty stubs for the missing components.)

- [ ] **Step 6: Commit**

```bash
git add App.qml
git commit -m "feat: application window with three-column responsive layout"
```

---

## Task 8: The mailbox sidebar

**Files:**
- Create: `components/MailboxSidebar.qml`

**Interfaces:**
- Consumes: `Service.mailboxKey`, `Service.labels`, `Service.inboxUnread`, `Model.MAILBOXES`.
- Produces: signal `mailboxSelected(string key)`, signal `labelSelected(string labelId, string name)`.

- [ ] **Step 1: Write the component**

```qml
import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "../Model.js" as Model

// The left column: the six built-in mailboxes, then whatever labels the user
// has made. Collapsed to a strip of initials on medium windows, gone entirely
// on narrow ones (MailboxTabs takes over there).
Item {
  id: root

  required property var service
  required property color textColor
  required property color accentColor
  required property string panelFontFamily
  property bool collapsed: false

  signal mailboxSelected(string key)
  signal labelSelected(string labelId, string name)

  readonly property color dim: Qt.rgba(textColor.r, textColor.g, textColor.b, 0.55)
  readonly property var userLabels: {
    var all = root.service ? root.service.labels : []
    var out = []
    for (var i = 0; i < all.length; i++) {
      if (!all[i].system) out.push(all[i])
    }
    return out
  }

  Flickable {
    anchors.fill: parent
    anchors.margins: Style.space(8)
    contentWidth: width
    contentHeight: column.implicitHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

    Column {
      id: column
      width: parent.width
      spacing: Style.space(2)

      Repeater {
        model: Model.MAILBOXES

        Entry {
          required property var modelData
          label: modelData.label
          count: modelData.key === "inbox" && root.service ? root.service.inboxUnread : 0
          selected: root.service && root.service.mailboxKey === modelData.key
            && root.service.searchQuery === ""
          onActivated: root.mailboxSelected(modelData.key)
        }
      }

      Item {
        width: parent.width
        implicitHeight: Style.space(14)
        visible: root.userLabels.length > 0

        PanelSeparator {
          anchors.verticalCenter: parent.verticalCenter
          width: parent.width
          foreground: root.textColor
        }
      }

      PanelSectionHeader {
        visible: root.userLabels.length > 0 && !root.collapsed
        text: "LABELS"
        foreground: root.textColor
        fontFamily: root.panelFontFamily
      }

      Repeater {
        model: root.userLabels

        Entry {
          required property var modelData
          label: modelData.name
          count: modelData.unread
          selected: root.service
            && root.service.searchQuery === "label:" + modelData.rawName
          onActivated: root.labelSelected(modelData.id, modelData.rawName)
        }
      }
    }
  }

  // A row that shows its full name when there is room and its first character
  // when there is not. The count stays visible either way: it is the reason to
  // look at this column at all.
  component Entry: Rectangle {
    id: entry
    required property string label
    property int count: 0
    property bool selected: false
    signal activated()

    width: column.width
    implicitHeight: Style.space(30)
    radius: Style.cornerRadius
    color: entry.selected
      ? Style.selectedFillFor(root.textColor, root.accentColor)
      : (hover.hovered ? Style.hoverFillFor(root.textColor, root.accentColor) : "transparent")

    Text {
      anchors.left: parent.left
      anchors.leftMargin: Style.space(10)
      anchors.right: badge.visible ? badge.left : parent.right
      anchors.rightMargin: Style.space(6)
      anchors.verticalCenter: parent.verticalCenter
      text: root.collapsed ? entry.label.substring(0, 1) : entry.label
      color: entry.selected ? root.textColor : root.dim
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: entry.selected
      elide: Text.ElideRight
    }

    Text {
      id: badge
      anchors.right: parent.right
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      visible: entry.count > 0 && !root.collapsed
      text: Model.badgeText(entry.count, 999)
      color: root.accentColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      font.bold: true
    }

    HoverHandler { id: hover }
    TapHandler { onTapped: entry.activated() }

    PanelToolTip {
      visible: root.collapsed && hover.hovered
      text: entry.label
      fontFamily: root.panelFontFamily
    }
  }
}
```

- [ ] **Step 2: Wire label selection in App.qml**

Add to the `MailboxSidebar` block in `App.qml`:

```qml
          onLabelSelected: function(labelId, name) {
            root.service.search("label:" + name)
            root.backToList()
          }
```

- [ ] **Step 3: Lint**

Run: `/usr/lib/qt6/bin/qmllint -I /usr/share/omarchy/shell components/MailboxSidebar.qml`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add components/MailboxSidebar.qml App.qml
git commit -m "feat: mailbox sidebar with user labels"
```

---

## Task 9: Search bar and overflow menu

**Files:**
- Create: `components/SearchBar.qml`, `components/AppMenu.qml`

**Interfaces:**
- `SearchBar`: signals `submitted(string query)`, `cleared()`; function `focusField()`.
- `AppMenu`: signals `markAllReadRequested()`, `openWebRequested()`, `shortcutsRequested()`, `setupRequested()`, `signOutRequested()`; property `signedIn`.

- [ ] **Step 1: Write SearchBar.qml**

```qml
import QtQuick
import qs.Commons
import qs.Ui

// Gmail's own operator syntax goes straight through — `from:`, `has:attachment`,
// `older_than:7d`. Translating it would only take away what people already know.
Item {
  id: root

  required property color textColor
  required property color accentColor
  required property string panelFontFamily

  signal submitted(string query)
  signal cleared()

  implicitHeight: field.implicitHeight

  function focusField() {
    field.forceActiveFocus()
    field.selectAll()
  }

  function clear() {
    field.text = ""
    root.cleared()
  }

  TextField {
    id: field
    anchors.fill: parent
    foreground: root.textColor
    accent: root.accentColor
    placeholderText: "Search mail — from:jane has:attachment"
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.bodySmall
    onAccepted: root.submitted(text.trim())
    Keys.onEscapePressed: function(event) {
      if (text === "") return
      root.clear()
      event.accepted = true
    }
  }

  PanelActionButton {
    anchors.right: parent.right
    anchors.rightMargin: Style.space(4)
    anchors.verticalCenter: parent.verticalCenter
    visible: field.text !== ""
    iconText: "×"
    tooltipText: "Clear search"
    foreground: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.55)
    fontSize: Style.font.body
    onClicked: root.clear()
  }
}
```

- [ ] **Step 2: Write AppMenu.qml**

```qml
import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui

// Links out, plus the handful of actions that have no natural home on screen.
Item {
  id: root

  required property color textColor
  required property string panelFontFamily
  property bool signedIn: false

  signal markAllReadRequested()
  signal openWebRequested()
  signal shortcutsRequested()
  signal setupRequested()
  signal signOutRequested()

  implicitWidth: Style.space(24)
  implicitHeight: Style.space(24)

  Button {
    id: menuButton
    anchors.fill: parent
    text: "⋮"
    foreground: root.textColor
    bordered: false
    onClicked: menu.opened ? menu.close() : menu.open()
  }

  QQC.Popup {
    id: menu
    x: menuButton.width - width
    y: menuButton.height + Style.space(4)
    width: Style.space(210)
    implicitHeight: menuItems.implicitHeight + Style.space(8)
    padding: Style.space(4)
    modal: false
    focus: true
    closePolicy: QQC.Popup.CloseOnEscape | QQC.Popup.CloseOnPressOutside
    background: Rectangle {
      radius: Style.cornerRadius
      color: Color.background
      border.width: 1
      border.color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.16)
    }
    contentItem: Column {
      id: menuItems
      spacing: Style.space(2)

      MenuRow {
        text: "Mark everything here read"
        enabled: root.signedIn
        onActivated: { menu.close(); root.markAllReadRequested() }
      }
      MenuRow {
        text: "Open in browser..."
        enabled: root.signedIn
        onActivated: { menu.close(); root.openWebRequested() }
      }

      Separator {}

      MenuRow {
        text: "Keyboard shortcuts..."
        onActivated: { menu.close(); root.shortcutsRequested() }
      }
      MenuRow {
        text: "OAuth client..."
        onActivated: { menu.close(); root.setupRequested() }
      }

      Separator {}

      MenuRow {
        text: "Sign out"
        enabled: root.signedIn
        onActivated: { menu.close(); root.signOutRequested() }
      }
    }
  }

  component Separator: Item {
    width: menu.width - menu.leftPadding - menu.rightPadding
    implicitHeight: Style.space(7)
    PanelSeparator {
      anchors.verticalCenter: parent.verticalCenter
      width: parent.width
      foreground: root.textColor
    }
  }

  // `enabled` is Item's own, and it already stops the handlers below from
  // firing, so a disabled row only has to look disabled.
  component MenuRow: Rectangle {
    id: row
    required property string text
    signal activated()

    width: menu.width - menu.leftPadding - menu.rightPadding
    implicitHeight: Style.space(32)
    radius: Style.cornerRadius
    opacity: row.enabled ? 1.0 : 0.4
    color: hover.hovered
      ? Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.08)
      : "transparent"

    Text {
      anchors.left: parent.left
      anchors.leftMargin: Style.space(9)
      anchors.verticalCenter: parent.verticalCenter
      text: row.text
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
    }

    HoverHandler { id: hover }
    TapHandler { onTapped: row.activated() }
  }
}
```

- [ ] **Step 3: Lint and commit**

Run: `/usr/lib/qt6/bin/qmllint -I /usr/share/omarchy/shell components/SearchBar.qml components/AppMenu.qml`
Expected: no errors.

```bash
git add components/SearchBar.qml components/AppMenu.qml
git commit -m "feat: search bar and overflow menu"
```

---

## Task 10: The reader

**Files:**
- Create: `components/MessageReader.qml`
- Modify: `Service.qml` — add `selectedHtml` alongside `selectedBody`

**Interfaces:**
- Consumes: `Service.selectedMessage`, `Service.selectedBody`, `Service.selectedHtml`, `Service.selectedAttachments`, `Service.detailLoading`, `Html.sanitize`, `Html.documentFor`, `Message.formatSize`, `Message.formatAddressList`.
- Produces: signals `backRequested()`, `replyRequested()`, `replyAllRequested()`, `forwardRequested()`, `loadImagesRequested()`, `togglePlainTextRequested()`.

- [ ] **Step 1: Capture the HTML in the service**

In `Service.qml`, add next to `selectedBody`:

```qml
  property string selectedHtml: ""
```

In `select(id)`, alongside `root.selectedBody = Mail.extractBody(payload.payload)`:

```qml
      root.selectedHtml = Mail.extractHtml(payload.payload)
```

and in `clearSelection()`:

```qml
    selectedHtml = ""
```

- [ ] **Step 2: Write MessageReader.qml**

```qml
import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "../Html.js" as Html
import "../Message.js" as Mail

// The right column. The body is rendered with Qt's own rich text engine —
// a real HTML renderer, not a browser — after Html.sanitize has taken out the
// parts Qt would render badly and the remote images that would fire tracking
// pixels the moment this opens.
Item {
  id: root

  required property var service
  required property color textColor
  required property color backgroundColor
  required property color accentColor
  required property color urgentColor
  required property string panelFontFamily
  property bool allowRemoteImages: false
  property bool forcePlainText: false
  property bool showBack: false

  signal backRequested()
  signal replyRequested()
  signal replyAllRequested()
  signal forwardRequested()
  signal loadImagesRequested()
  signal togglePlainTextRequested()

  readonly property var summary: service ? service.selectedMessage : null
  readonly property color dim: Qt.rgba(textColor.r, textColor.g, textColor.b, 0.55)
  readonly property string rawHtml: service ? service.selectedHtml : ""
  readonly property var sanitized: Html.sanitize(rawHtml, { allowRemoteImages: root.allowRemoteImages })
  readonly property bool htmlAvailable: rawHtml !== "" && !root.forcePlainText
  readonly property int blockedImages: root.htmlAvailable ? root.sanitized.blockedImages : 0

  Text {
    anchors.centerIn: parent
    visible: !root.summary
    text: root.service && root.service.detailLoading ? "Opening…" : "Select a message"
    color: root.dim
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.bodySmall
  }

  Column {
    id: headerBlock
    visible: !!root.summary
    anchors.top: parent.top
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.margins: Style.space(14)
    spacing: Style.space(4)

    Row {
      width: parent.width
      spacing: Style.space(6)

      Button {
        visible: root.showBack
        text: "←"
        foreground: root.textColor
        bordered: false
        fontSize: Style.font.title
        onClicked: root.backRequested()
      }

      Text {
        width: parent.width - (root.showBack ? Style.space(40) : 0) - starButton.width - Style.space(12)
        text: root.summary ? root.summary.subject : ""
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.subtitle
        font.bold: true
        wrapMode: Text.WordWrap
      }

      PanelActionButton {
        id: starButton
        iconText: root.summary && root.summary.starred ? "★" : "☆"
        tooltipText: root.summary && root.summary.starred ? "Unstar" : "Star"
        foreground: root.summary && root.summary.starred ? root.accentColor : root.dim
        onClicked: if (root.service && root.summary) root.service.toggleStar(root.summary.id)
      }
    }

    Text {
      width: parent.width
      text: root.summary
        ? root.summary.from.display + "  <" + root.summary.from.email + ">"
        : ""
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      elide: Text.ElideRight
    }

    Text {
      width: parent.width
      text: root.summary
        ? "to " + Mail.formatAddressList(root.summary.to, 3) + " · " + root.summary.fullTime
        : ""
      color: root.dim
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight
    }
  }

  // Remote images are a tracking channel, so the choice is explicit and it is
  // per message: the banner comes back on the next one.
  Rectangle {
    id: imageBanner
    visible: root.blockedImages > 0
    anchors.top: headerBlock.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.margins: Style.space(14)
    anchors.topMargin: Style.space(8)
    implicitHeight: Style.space(30)
    radius: Style.cornerRadius
    color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.05)
    border.width: 1
    border.color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.12)

    Text {
      anchors.left: parent.left
      anchors.leftMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      text: root.blockedImages === 1
        ? "1 remote image blocked"
        : root.blockedImages + " remote images blocked"
      color: root.dim
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
    }

    Button {
      anchors.right: parent.right
      anchors.rightMargin: Style.space(6)
      anchors.verticalCenter: parent.verticalCenter
      text: "Show images"
      foreground: root.textColor
      bordered: false
      fontSize: Style.font.caption
      onClicked: root.loadImagesRequested()
    }
  }

  Flickable {
    id: bodyFlick
    anchors.top: imageBanner.visible ? imageBanner.bottom : headerBlock.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: footer.top
    anchors.margins: Style.space(14)
    contentWidth: width
    contentHeight: bodyText.implicitHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

    // TextEdit rather than Text so the body can be selected and copied, which
    // is most of what anyone does with a message they did not write.
    TextEdit {
      id: bodyText
      width: bodyFlick.width
      readOnly: true
      selectByMouse: true
      wrapMode: TextEdit.Wrap
      textFormat: root.htmlAvailable ? TextEdit.RichText : TextEdit.PlainText
      text: root.htmlAvailable
        ? Html.documentFor(root.sanitized.html, {
            foreground: root.textColor,
            background: root.backgroundColor,
            link: root.accentColor,
            quote: root.dim
          })
        : (root.service ? root.service.selectedBody.text : "")
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      onLinkActivated: function(link) { Qt.openUrlExternally(link) }
    }
  }

  Column {
    id: footer
    anchors.bottom: parent.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.margins: Style.space(14)
    spacing: Style.space(6)
    visible: !!root.summary

    Repeater {
      model: root.service ? root.service.selectedAttachments : []

      Row {
        required property var modelData
        spacing: Style.space(6)

        Text {
          text: "📎 " + modelData.filename
          color: root.dim
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }

        Text {
          text: Mail.formatSize(modelData.size)
          color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.38)
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }

    PanelSeparator {
      width: parent.width
      foreground: root.textColor
    }

    Row {
      spacing: Style.space(6)

      Button {
        text: "Reply"
        foreground: root.textColor
        bordered: true
        fontSize: Style.font.bodySmall
        onClicked: root.replyRequested()
      }
      Button {
        text: "Reply all"
        foreground: root.textColor
        bordered: false
        fontSize: Style.font.bodySmall
        onClicked: root.replyAllRequested()
      }
      Button {
        text: "Forward"
        foreground: root.textColor
        bordered: false
        fontSize: Style.font.bodySmall
        onClicked: root.forwardRequested()
      }
      Button {
        text: "Archive"
        foreground: root.textColor
        bordered: false
        fontSize: Style.font.bodySmall
        onClicked: if (root.service && root.summary) root.service.act(root.summary.id, "archive")
      }
      Button {
        text: "Delete"
        foreground: root.urgentColor
        bordered: false
        fontSize: Style.font.bodySmall
        onClicked: if (root.service && root.summary) root.service.act(root.summary.id, "trash")
      }
      Button {
        visible: root.rawHtml !== ""
        text: root.forcePlainText ? "Formatted" : "Plain text"
        foreground: root.dim
        bordered: false
        fontSize: Style.font.caption
        onClicked: root.togglePlainTextRequested()
      }
    }
  }
}
```

- [ ] **Step 3: Lint**

Run: `/usr/lib/qt6/bin/qmllint -I /usr/share/omarchy/shell components/MessageReader.qml`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add components/MessageReader.qml Service.qml
git commit -m "feat: reader with sanitised HTML rendering and blocked remote images"
```

---

## Task 11: Compose, reply, reply-all, forward

**Files:**
- Create: `components/ComposeView.qml`
- Modify: `Service.qml` — replace `sendReply` with a general `send`

**Interfaces:**
- Consumes: `Message.replySubject`, `Message.quoteBody`, `Message.formatAddressList`, `Service.accountEmail`, `Service.sending`.
- Produces:
  - `Service.send({to, cc, subject, body, threadId, inReplyTo, references})`
  - `ComposeView.begin(mode, summary)` where mode is `"new"` | `"reply"` | `"replyAll"` | `"forward"`
  - `ComposeView.reset()`
  - signal `cancelled()`

- [ ] **Step 1: Replace `sendReply` in Service.qml**

Delete the whole `sendReply` function and put this in its place:

```qml
  // One entry point for every kind of outgoing message. Reply, reply-all and
  // forward differ only in what the compose view puts in the fields, which is
  // where that decision belongs.
  function send(fields) {
    if (!ready || sending) return
    var values = fields || ({})
    var body = String(values.body || "").trim()
    if (body === "") {
      fail("Write something before sending")
      return
    }
    var to = String(values.to || "").trim()
    if (to === "") {
      fail("Add a recipient first")
      return
    }
    sending = true
    apiClient.sendMessage(Mail.buildSendPayload({
      to: to,
      cc: String(values.cc || "").trim(),
      subject: String(values.subject || ""),
      body: body,
      threadId: values.threadId,
      inReplyTo: values.inReplyTo,
      references: values.references
    }), function(payload, error) {
      root.sending = false
      if (error) {
        root.fail(error)
        return
      }
      root.note("Sent")
      root.replySent()
    })
  }
```

- [ ] **Step 2: Write ComposeView.qml**

```qml
import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "../Message.js" as Mail

// Composing, replying, and forwarding are the same form with different
// starting values, so `begin()` fills the fields and everything after that is
// one code path.
Item {
  id: root

  required property var service
  required property color textColor
  required property color accentColor
  required property string panelFontFamily

  signal cancelled()

  property string mode: "new"
  property string threadId: ""
  property string inReplyTo: ""

  readonly property color dim: Qt.rgba(textColor.r, textColor.g, textColor.b, 0.55)
  readonly property string title: {
    if (mode === "reply") return "Reply"
    if (mode === "replyAll") return "Reply all"
    if (mode === "forward") return "Forward"
    return "New message"
  }

  function reset() {
    toField.text = ""
    ccField.text = ""
    subjectField.text = ""
    bodyEdit.text = ""
    root.mode = "new"
    root.threadId = ""
    root.inReplyTo = ""
  }

  // Everyone on the original except this mailbox: replying to yourself is
  // never what reply-all was for.
  function otherRecipients(summary) {
    if (!summary) return ""
    var mine = String(root.service ? root.service.accountEmail : "").toLowerCase()
    var list = Array.isArray(summary.to) ? summary.to : []
    var kept = []
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].email || "").toLowerCase() === mine) continue
      kept.push(list[i].email)
    }
    return kept.join(", ")
  }

  function begin(nextMode, summary) {
    reset()
    root.mode = String(nextMode || "new")
    if (!summary || root.mode === "new") {
      Qt.callLater(function() { toField.forceActiveFocus() })
      return
    }

    var replyTo = summary.replyTo && summary.replyTo.email
      ? summary.replyTo.email : summary.from.email
    root.threadId = summary.threadId
    root.inReplyTo = summary.messageId

    if (root.mode === "forward") {
      subjectField.text = "Fwd: " + summary.subject
      bodyEdit.text = "\n\n" + Mail.quoteBody(summary,
        root.service ? root.service.selectedBody.text : "")
      Qt.callLater(function() { toField.forceActiveFocus() })
      return
    }

    toField.text = replyTo
    if (root.mode === "replyAll") ccField.text = otherRecipients(summary)
    subjectField.text = Mail.replySubject(summary.subject)
    bodyEdit.text = "\n\n" + Mail.quoteBody(summary,
      root.service ? root.service.selectedBody.text : "")
    Qt.callLater(function() {
      bodyEdit.forceActiveFocus()
      bodyEdit.cursorPosition = 0
    })
  }

  function submit() {
    if (!root.service) return
    root.service.send({
      to: toField.text,
      cc: ccField.text,
      subject: subjectField.text,
      body: bodyEdit.text,
      // A forward starts a new conversation; a reply must stay in the old one.
      threadId: root.mode === "forward" ? "" : root.threadId,
      inReplyTo: root.mode === "forward" ? "" : root.inReplyTo
    })
  }

  Column {
    anchors.fill: parent
    anchors.margins: Style.space(14)
    spacing: Style.space(8)

    Row {
      width: parent.width
      spacing: Style.space(8)

      Button {
        text: "←"
        foreground: root.textColor
        bordered: false
        fontSize: Style.font.title
        onClicked: root.cancelled()
      }

      PanelSectionHeader {
        anchors.verticalCenter: parent.verticalCenter
        text: root.title.toUpperCase()
        foreground: root.textColor
        fontFamily: root.panelFontFamily
      }
    }

    TextField {
      id: toField
      width: parent.width
      foreground: root.textColor
      accent: root.accentColor
      placeholderText: "To"
      font.pixelSize: Style.font.bodySmall
      onAccepted: subjectField.forceActiveFocus()
    }

    TextField {
      id: ccField
      width: parent.width
      visible: root.mode === "replyAll" || text !== ""
      foreground: root.textColor
      accent: root.accentColor
      placeholderText: "Cc"
      font.pixelSize: Style.font.bodySmall
    }

    TextField {
      id: subjectField
      width: parent.width
      foreground: root.textColor
      accent: root.accentColor
      placeholderText: "Subject"
      font.pixelSize: Style.font.bodySmall
      onAccepted: bodyEdit.forceActiveFocus()
    }

    // The kit has no multi-line field, so this is a TextEdit on the same
    // bordered surface every other control uses.
    BorderSurface {
      width: parent.width
      height: parent.height - toField.height - subjectField.height
        - (ccField.visible ? ccField.height + Style.space(8) : 0)
        - actions.height - Style.space(60)
      radius: Style.cornerRadius
      color: Style.controlFill(bodyEdit.activeFocus, false, root.textColor, root.accentColor)
      borderSpec: Border.controlSpec(bodyEdit.activeFocus ? "focus" : "normal",
        root.textColor, root.accentColor)

      Flickable {
        anchors.fill: parent
        anchors.margins: Style.space(8)
        contentWidth: width
        contentHeight: bodyEdit.implicitHeight
        clip: true
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        TextEdit {
          id: bodyEdit
          width: parent.width
          selectByMouse: true
          wrapMode: TextEdit.Wrap
          textFormat: TextEdit.PlainText
          color: root.textColor
          selectionColor: Style.selectionFillFor(root.textColor, root.accentColor)
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
        }
      }
    }

    Row {
      id: actions
      spacing: Style.space(8)

      Button {
        text: root.service && root.service.sending ? "Sending…" : "Send"
        foreground: root.textColor
        bordered: true
        fontSize: Style.font.bodySmall
        enabled: root.service && !root.service.sending
        onClicked: root.submit()
      }

      Button {
        text: "Discard"
        foreground: root.dim
        bordered: false
        fontSize: Style.font.bodySmall
        onClicked: root.cancelled()
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: "Ctrl+Enter sends"
        color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.38)
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }

  Shortcut {
    sequence: "Ctrl+Return"
    enabled: root.visible
    onActivated: root.submit()
  }
}
```

- [ ] **Step 3: Lint**

Run: `/usr/lib/qt6/bin/qmllint -I /usr/share/omarchy/shell components/ComposeView.qml`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add components/ComposeView.qml Service.qml
git commit -m "feat: compose, reply, reply-all, and forward"
```

---

## Task 12: Keyboard

Gmail's bindings are muscle memory for anyone who would want this app. They go on the window's `FocusScope`, and every one of them is disabled while a text field has focus — otherwise typing `e` in the search box archives a message.

**Files:**
- Modify: `App.qml` — add the shortcut block inside `FocusScope`
- Create: `components/ShortcutHelp.qml`

**Interfaces:**
- Consumes: everything already on `App`.
- Produces: `App.typing` — true when a text field owns focus.

- [ ] **Step 1: Add the typing guard and shortcuts to App.qml**

Inside `FocusScope`, after the body block:

```qml
      // Every shortcut below is a bare letter, so all of them have to stand
      // down while a field has focus. `activeFocusItem` is the window's, which
      // is the only place that knows what is actually being typed into.
      readonly property bool typing: {
        var item = window.activeFocusItem
        if (!item) return false
        return item instanceof TextInput || item instanceof TextEdit
      }

      Keys.onEscapePressed: function(event) {
        if (root.shortcutHelpVisible) root.shortcutHelpVisible = false
        else if (root.composing) root.cancelCompose()
        else if (root.currentView === "reader") root.backToList()
        else if (root.currentView === "setup") root.currentView = "list"
        else if (root.service && root.service.searchQuery !== "") root.service.search("")
        else root.requestClose()
        event.accepted = true
      }

      Shortcut { sequence: "Ctrl+K"; enabled: !root.composing; onActivated: searchBar.focusField() }
      Shortcut { sequence: "/"; enabled: !focusScope.typing && !root.composing; onActivated: searchBar.focusField() }
      Shortcut { sequence: "j"; enabled: !focusScope.typing && !root.composing; onActivated: root.moveCursor(1) }
      Shortcut { sequence: "k"; enabled: !focusScope.typing && !root.composing; onActivated: root.moveCursor(-1) }
      Shortcut { sequence: "Return"; enabled: !focusScope.typing && root.currentView === "list"; onActivated: root.openMessage(root.cursorId) }
      Shortcut { sequence: "u"; enabled: !focusScope.typing && !root.composing; onActivated: root.backToList() }
      Shortcut { sequence: "e"; enabled: !focusScope.typing && !root.composing; onActivated: root.actOnCursor("archive") }
      Shortcut { sequence: "#"; enabled: !focusScope.typing && !root.composing; onActivated: root.actOnCursor("trash") }
      Shortcut { sequence: "s"; enabled: !focusScope.typing && !root.composing; onActivated: if (root.service) root.service.toggleStar(root.cursorId) }
      Shortcut { sequence: "Shift+I"; enabled: !focusScope.typing && !root.composing; onActivated: root.actOnCursor("markRead") }
      Shortcut { sequence: "Shift+U"; enabled: !focusScope.typing && !root.composing; onActivated: root.actOnCursor("markUnread") }
      Shortcut { sequence: "r"; enabled: !focusScope.typing && root.currentView === "reader"; onActivated: root.startCompose("reply", null) }
      Shortcut { sequence: "a"; enabled: !focusScope.typing && root.currentView === "reader"; onActivated: root.startCompose("replyAll", null) }
      Shortcut { sequence: "f"; enabled: !focusScope.typing && root.currentView === "reader"; onActivated: root.startCompose("forward", null) }
      Shortcut { sequence: "c"; enabled: !focusScope.typing && !root.composing; onActivated: root.startCompose("new", null) }
      Shortcut { sequence: "g,i"; enabled: !focusScope.typing && !root.composing; onActivated: root.goMailbox("inbox") }
      Shortcut { sequence: "g,s"; enabled: !focusScope.typing && !root.composing; onActivated: root.goMailbox("starred") }
      Shortcut { sequence: "g,u"; enabled: !focusScope.typing && !root.composing; onActivated: root.goMailbox("unread") }
      Shortcut { sequence: "g,t"; enabled: !focusScope.typing && !root.composing; onActivated: root.goMailbox("sent") }
      Shortcut { sequence: "Ctrl+/"; onActivated: root.shortcutHelpVisible = !root.shortcutHelpVisible }
      Shortcut { sequence: "F5"; enabled: !root.composing; onActivated: if (root.service) root.service.refresh() }
```

- [ ] **Step 2: Add the two helper functions to App.qml**

```qml
  function actOnCursor(action) {
    if (!service || cursorId === "") return
    // Acting on the open message closes it: it is about to leave this list.
    var wasOpen = currentView === "reader" && service.selectedId === cursorId
    var next = service.selectOffset(1)
    service.act(cursorId, action)
    if (wasOpen && !Model.survivesAction(service.mailboxKey, action)) {
      if (next !== "" && next !== cursorId) openMessage(next)
      else backToList()
    }
  }

  function goMailbox(key) {
    if (!service) return
    service.selectMailbox(key)
    backToList()
  }
```

- [ ] **Step 3: Write ShortcutHelp.qml**

```qml
import QtQuick
import qs.Commons
import qs.Ui

// The reference sheet behind Ctrl+/. It is a plain list rather than a dialog
// because it never needs an answer — Esc or Ctrl+/ again puts it away.
Rectangle {
  id: root

  required property color textColor
  required property color backgroundColor
  required property string panelFontFamily

  signal dismissed()

  readonly property color dim: Qt.rgba(textColor.r, textColor.g, textColor.b, 0.55)
  readonly property var rows: [
    { keys: "j / k", action: "Move down / up" },
    { keys: "Enter", action: "Open the selected message" },
    { keys: "u", action: "Back to the list" },
    { keys: "e", action: "Archive" },
    { keys: "#", action: "Move to trash" },
    { keys: "s", action: "Star or unstar" },
    { keys: "Shift+I / Shift+U", action: "Mark read / unread" },
    { keys: "r / a / f", action: "Reply, reply all, forward" },
    { keys: "c", action: "Compose" },
    { keys: "Ctrl+Enter", action: "Send" },
    { keys: "/ or Ctrl+K", action: "Search" },
    { keys: "g then i / s / u / t", action: "Inbox, starred, unread, sent" },
    { keys: "F5", action: "Refresh" },
    { keys: "Ctrl+/", action: "Toggle this sheet" },
    { keys: "Esc", action: "Back, or close the window" }
  ]

  color: Qt.rgba(backgroundColor.r, backgroundColor.g, backgroundColor.b, 0.96)

  MouseArea {
    anchors.fill: parent
    onClicked: root.dismissed()
  }

  Column {
    anchors.centerIn: parent
    width: Math.min(parent.width - Style.space(80), Style.space(420))
    spacing: Style.space(6)

    Text {
      text: "Keyboard shortcuts"
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.subtitle
      font.bold: true
    }

    Repeater {
      model: root.rows

      Item {
        required property var modelData
        width: parent.width
        implicitHeight: Style.space(20)

        Text {
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          width: Style.space(150)
          text: modelData.keys
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
        }

        Text {
          anchors.left: parent.left
          anchors.leftMargin: Style.space(155)
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          text: modelData.action
          color: root.dim
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }
    }
  }
}
```

- [ ] **Step 4: Mount it in App.qml, as the last child of FocusScope**

```qml
      ShortcutHelp {
        anchors.fill: parent
        visible: root.shortcutHelpVisible
        textColor: root.foreground
        backgroundColor: root.background
        panelFontFamily: root.fontFamily
        onDismissed: root.shortcutHelpVisible = false
      }
```

- [ ] **Step 5: Lint and commit**

Run: `make qml-check`
Expected: no errors.

```bash
git add App.qml components/ShortcutHelp.qml
git commit -m "feat: Gmail keyboard bindings and a reference sheet"
```

---

## Task 13: First-run setup inside the window

`components/SetupPage.qml` and `components/SetupCard.qml` already exist from earlier work, written against a `service` that exposes `openCloudConsole()`, `openGmailApiPage()`, `signIn()`, and `auth`. This task verifies that contract still holds after Task 3's rewrite and adds the missing progress feedback during sign-in.

**Files:**
- Modify: `components/SetupPage.qml`
- Modify: `Service.qml` — expose `signInProgress`

**Interfaces:**
- Consumes: `AuthManager.loginBusy`, `AuthManager.toolsChecked`, `AuthManager.missingTools`, `AuthManager.credentialsPresent`.
- Produces: `Service.signInProgress` — a sentence describing what the sign-in is waiting on.

- [ ] **Step 1: Add the progress line to Service.qml**

```qml
  // The sign-in has three waits that look identical from outside: the helper
  // script, the browser, and Google's token endpoint. Naming which one is
  // happening is the difference between "it is working" and "it is stuck".
  readonly property string signInProgress: {
    if (!authManager.toolsChecked) return "Checking for socat and secret-tool…"
    if (!authManager.credentialsPresent) return ""
    if (authManager.loginBusy) return "Finish the sign-in in your browser…"
    if (authManager.sessionBusy) return "Restoring the saved session…"
    return ""
  }
```

- [ ] **Step 2: Show it in SetupPage.qml**

After the `Row` holding the Save and Sign in buttons, add:

```qml
  Text {
    width: parent.width
    visible: root.service.signInProgress !== ""
    text: root.service.signInProgress
    color: root.dim
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }

  // Cancelling has to be reachable: a browser closed without finishing leaves
  // the listener waiting out its full three minutes otherwise.
  Button {
    visible: root.auth.loginBusy
    text: "Cancel sign-in"
    foreground: root.dim
    bordered: false
    fontSize: Style.font.caption
    onClicked: root.service.cancelSignIn()
  }
```

- [ ] **Step 3: Add the missing-tools case**

At the top of `SetupPage.qml`'s `Column`, after the intro `Text`:

```qml
  Rectangle {
    width: parent.width
    visible: root.auth.toolsChecked && root.auth.missingTools.length > 0
    implicitHeight: missingText.implicitHeight + Style.space(20)
    radius: Style.cornerRadius
    color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.05)
    border.width: 1
    border.color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.16)

    Text {
      id: missingText
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.margins: Style.space(12)
      anchors.verticalCenter: parent.verticalCenter
      text: "Install " + root.auth.missingTools.join(", ")
        + " before signing in. Omarchy Gmail uses them for the loopback listener and the keyring."
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }
```

- [ ] **Step 4: Lint and commit**

Run: `/usr/lib/qt6/bin/qmllint -I /usr/share/omarchy/shell components/SetupPage.qml`
Expected: no errors.

```bash
git add components/SetupPage.qml Service.qml
git commit -m "feat: name what the sign-in is waiting on"
```

---

## Task 14: Source regressions, docs, and validation

**Files:**
- Create: `tests/test_source.sh`, `tests/test_qml_names.py`
- Create: `README.md`, `AGENTS.md`
- Modify: `Makefile` (already lists these — verify)

**Interfaces:**
- Consumes: every file in the repo.
- Produces: `make validate` as the single gate.

- [ ] **Step 1: Write the failing source test**

Create `tests/test_source.sh`:

```bash
#!/usr/bin/env bash
# Two rules that are easy to break by accident and invisible until someone
# switches to a light theme or the QML engine chokes on modern syntax.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail() { printf 'test_source.sh: %s\n' "$1" >&2; exit 1; }

# 1. No hard-coded colours in QML. Every colour must come from the active
#    Omarchy theme, or a light theme renders unreadable text.
if grep -nE '(color|Color)\s*:\s*"#[0-9A-Fa-f]{3,8}"' -- *.qml components/*.qml; then
  fail "hard-coded colour in QML: use Color.* or a colour passed in from App.qml"
fi
if grep -nE ':\s*"(red|blue|green|white|black|yellow|orange|purple|gray|grey)"' -- *.qml components/*.qml; then
  fail "named display colour in QML: use Color.* instead"
fi

# 2. The JS libraries are read by the QML engine, which does not accept ES6.
#    tests/ is node-only and exempt.
for file in OAuth.js Credentials.js GmailApi.js Message.js Model.js Html.js; do
  head -1 "$file" | grep -q '^\.pragma library$' || fail "$file must start with .pragma library"
  if grep -nE '^\s*(const|let)\s|=>|`' "$file"; then
    fail "$file uses ES6 syntax the QML engine will not parse"
  fi
done

# 3. Nothing may name a colour inside a JS library either: colours are passed
#    in from QML, which is the only place that can read the theme.
if grep -nE '#[0-9A-Fa-f]{6}' Html.js Model.js GmailApi.js Message.js; then
  fail "a JS library names a colour: pass it in from QML instead"
fi

printf 'test_source.sh ok\n'
```

- [ ] **Step 2: Run it and fix whatever it finds**

Run: `bash tests/test_source.sh`
Expected: either `test_source.sh ok`, or a named file and rule to fix. Fix by replacing the literal with a theme colour or a passed-in property.

- [ ] **Step 3: Write tests/test_qml_names.py**

```python
#!/usr/bin/env python3
"""Every component file must be reachable and consistently named.

A component that nothing imports is dead weight; a component named in the
Makefile that does not exist makes `make qml-check` fail with a path error
rather than a useful message.
"""
import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parent.parent
failures = []

components = sorted(p.name for p in (root / "components").glob("*.qml"))
sources = "\n".join(
    p.read_text(encoding="utf-8")
    for p in list(root.glob("*.qml")) + list((root / "components").glob("*.qml"))
)

for name in components:
    stem = name[:-4]
    if not re.search(rf"\b{stem}\s*{{", sources):
        failures.append(f"components/{name} is never instantiated")

makefile = (root / "Makefile").read_text(encoding="utf-8")
for name in components:
    if f"components/{name}" not in makefile:
        failures.append(f"components/{name} is missing from QML_FILES in the Makefile")

for listed in re.findall(r"components/(\w+\.qml)", makefile):
    if listed not in components:
        failures.append(f"Makefile lists components/{listed}, which does not exist")

for entry in ("Service.qml", "BarWidget.qml", "App.qml"):
    if not (root / entry).is_file():
        failures.append(f"{entry} is declared in the manifest but missing")

if failures:
    for line in failures:
        print(f"test_qml_names.py: {line}", file=sys.stderr)
    sys.exit(1)

print("test_qml_names.py ok")
```

- [ ] **Step 4: Run it**

Run: `python3 tests/test_qml_names.py`
Expected: `test_qml_names.py ok`

- [ ] **Step 5: Write AGENTS.md**

```markdown
# Repository working agreements

## Colors

- Use colors from the active Omarchy system theme. Do not hard-code UI colors.
- Pass semantic colors down from `App.qml` as required component properties so
  theme changes propagate through every view.
- Derive muted, hover, and selected variants from an inherited color with
  alpha. Do not introduce literal fallback grays.
- `tests/test_source.sh` enforces this. Keep it updated rather than working
  around it.

## JavaScript libraries

- Files at the repository root ending in `.js` are read by the QML engine.
  They start with `.pragma library` and use `var` and `function` only — no
  `const`, `let`, arrow functions, or template literals.
- Everything that parses, formats, or decides lives in one of them, so the
  node tests can reach it without a compositor. QML holds no logic worth
  testing.

## UI labels

- Suffix button and menu labels with `...` when activating them opens a
  dialog, a page, a browser, or a terminal workflow instead of completing the
  action immediately.

## Secrets

- Refresh tokens go to GNOME Keyring over stdin, never through a command line.
- The OAuth client goes to a 0600 file, never to plugin settings: `shell.json`
  is world-readable.
- Anything that could carry a credential passes through `OAuth.redact` before
  it can reach a label.

## Verification

- Run `make validate` after any QML or behavior change.
```

- [ ] **Step 6: Write README.md**

Cover, in this order: what it is and why it is not a browser tab; the two-minute Google Cloud setup with the exact click path; installation via `omarchy plugin add`; the keyboard table; what it does not do (no embedded browser, one account, no attachment download yet); where secrets live; and the licence.

- [ ] **Step 7: Run the whole gate**

Run: `make validate`
Expected: every node test prints `ok`, the shell and python tests print `ok`, `qmllint` is silent, `omarchy plugin validate .` reports the manifest is valid, and `git diff --check` finds no whitespace errors.

- [ ] **Step 8: Commit**

```bash
git add tests/test_source.sh tests/test_qml_names.py AGENTS.md README.md
git commit -m "test: source regressions, plus contributor and user docs"
```

---

## Task 15: Live verification against a real mailbox

Nothing above proves the OAuth flow works — it cannot be tested without a browser and a Google account. This task is the manual gate.

**Files:** none.

- [ ] **Step 1: Install the plugin from the checkout**

Run: `./install.sh`
Expected: the envelope appears in the bar, crossed out (not connected).

- [ ] **Step 2: Open the window**

Click the envelope.
Expected: a real Hyprland window titled `Omarchy Gmail`, showing the four-step setup page.

- [ ] **Step 3: Create the OAuth client and sign in**

Follow the four steps in the window. Paste the client ID, save, sign in.
Expected: a browser tab opens on Google's consent screen; approving it returns "Authorization complete"; the window shows the inbox within a second or two.

- [ ] **Step 4: Verify the state that only a real mailbox exercises**

- A message with a Chinese subject renders as Chinese, not as `=?UTF-8?B?…?=`
- A marketing message renders its table layout, and the banner reports blocked images
- Pressing `e` on a row removes it from Inbox and leaves it in All mail
- The bar badge drops by one when a message is opened
- `secret-tool lookup service omarchy-gmail kind refresh-token client-id <id>` prints a token
- `stat -c %a ~/.config/omarchy-gmail/credentials.json` prints `600`
- Restarting the shell (`omarchy restart shell`) leaves the mailbox signed in

- [ ] **Step 5: Verify sign-out is complete**

Sign out from the `⋮` menu, then run:
`secret-tool lookup service omarchy-gmail kind refresh-token client-id <id>`
Expected: no output, exit 1.

---

## Self-Review

**Spec coverage.** Every row of the spec's feature table maps to a task: mailboxes and labels → Task 8; list and paging → Task 1 (`MessageList` exists) and Task 7; reader → Task 10; actions → Task 1 (`Model.applyLabelChange`, `Service.act`) and Task 10; compose/reply/forward → Task 11; search → Task 9; badge and notifications → Tasks 3 and 6; CJK → Task 1; keyboard → Task 12; setup → Task 13; the three entry points → Task 4. The two rendering decisions the spec records (RichText, no browser engine) are implemented in Task 5 and enforced by no task adding a WebEngine dependency.

**Placeholders.** None: every step carries the code it needs, and the one prose step (Task 14 Step 6, the README) names its required sections in order rather than saying "write docs".

**Type consistency.** `Service.windowOpen` is introduced in Task 3 and read in Task 7. `Service.selectedHtml` is added in Task 10 and read only there. `Service.send(fields)` replaces `sendReply` in Task 11, and no earlier task calls `sendReply`. `Model.survivesAction` is used in Task 12's `actOnCursor` with the same `(mailboxKey, action)` signature Task 1 defines. `Html.sanitize` returns `{html, blockedImages}` in Task 5 and is destructured that way in Task 10. `ComposeView.begin(mode, summary)` in Task 11 matches every `startCompose` call in Tasks 7 and 12.

**Known gap, deliberate.** `MessageList.qml`, `MessageRow.qml`, `MailboxTabs.qml`, `SetupCard.qml`, `SetupPage.qml`, and `GmailIcon.qml` were written before this plan and are not re-derived here. Task 14's `test_qml_names.py` and `test_source.sh` bring them under the same gates as everything else.
