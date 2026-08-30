# What the standalone client still owes the plugin

The QML plugin at the repository root is the complete client. The standalone
GPUI client under `app/` and `src/` is a port of it, and this is the list of
what has not arrived yet — read out of the QML sources and checked against the
port's own call sites, not against its file names.

One pattern accounts for most of it, and it is worth stating on its own because
it is invisible to every other kind of review: **the domain libraries are
generated from the QML, so the logic is present whether or not anything calls
it.** `scripts/qml-js-to-esm.mjs` copies `message/`, `providers/`, `account/`,
`cache/`, `compose/`, `keys/` and `bar/` into `app/`, and
`tests/test_generated_app_modules.mjs` proves the copy matches. It proves
nothing about whether the port reaches the code. Several finished features are
sitting in this repository having never once run.

Grep for a function's name outside the file that defines it. That is the whole
technique, and it is how every "ported and uncalled" row below was found.

Status words: **missing** — the behaviour is absent. **partial** — some of it
arrives. **blocked** — the host or gpui cannot express it today, and the row
says what would have to change. A divergence argued in `AGENTS.md` is not a gap
and is not listed.

## Wrong, rather than absent

These mislead or lose data, so they come first regardless of size.

| What happens | Where it goes wrong |
|---|---|
| The From address the composer picked is discarded on the wire. Gmail sends as the account id, IMAP as the context's address. | `ComposeDraft.from` is deserialized and validated and then not returned by `into_parts()` — `src/providers/groupware.rs`, `src/native_groupware_runtime.rs` |
| A forward goes out without the original's attachments, silently. | `compose.loadingForwardAttachments` / `loadedForwardAttachments` exist to hold Send until the files arrive and have no call site; `app/application/compose-response.js` calls `compose.forward` and nothing else |
| An IMAP action the server refused is reported as done, with the row already moved. | `parse_transport_output` checks curl's exit code only; a tagged `NO`/`BAD` is not read. `Protocol.isFailure` / `failureDetail` / `failureCompletion` ported, uncalled |
| A message read a moment ago comes back bold, and a trashed row reappears. | `controller.act` neither writes the edit back through `cache.writeList` nor stops the in-flight list read. `MailAccount.qml:1452` documents both as bugs it already fixed |
| A draft saved with files, reopened and sent, goes out without them. | `openDraft` never asks for the attachment bytes |
| Leaving the composer on IMAP or HEY discards the draft with no warning. | `compose-exit.js` returns early unless the provider is Gmail, because the host has no draft save for the other two |

## The core loop

| Capability | Status | Where |
|---|---|---|
| Opening an unread message marks it read | missing | `controller.openCursor` reads the body and never calls `act` |
| HEY rows carry read state, star state and labels | missing | nothing calls `Message.summarize` for HEY, so every row draws as read, the badge is always 0, and optimistic updates are inert |
| IMAP Sent / Drafts / Archive / Trash reach the server's own folder | missing | the placeholders `folder:\Sent` are passed through literally; `resolveFolder` / `isSpecialUse` ported, uncalled |
| IMAP Unread, Flagged and typed search | missing | the runtime refuses any criteria that is not `ALL`, while `Imap.CAPABILITIES.search` still advertises them |
| IMAP paging, and honouring the page size | missing | `MailOperation::List` is an unbounded fetch over the whole folder, capped only by an output ceiling |
| Per-account unread poll | missing | only the active account is ever read; `Registry.unreadQuery` ported, uncalled. Mail arriving in another account is announced never |
| The unread badge is the mailbox's count | missing | it is the number of unread rows in the page on screen |
| User labels and IMAP folders in the sidebar | missing | no `labels` operation exists in any host route; the rail renders the section for an array that is always empty |
| Gmail send-as aliases | missing | no sendAs operation host-side; the whole `GmailApi` alias half ported, uncalled |
| Switching accounts keeps the mailbox you were in | missing | `mailboxAfterAccountSwitch` ported, uncalled |
| Local search across the cache while the server looks | missing | `Cache.searchSummaries` ported, uncalled; the list is empty until the round trip lands |
| Search submits on Enter and closes the open message | partial | every keystroke issues a list read, with no debounce and no in-flight guard |

## Whole features that never run

| Capability | Status | Where |
|---|---|---|
| The unsubscribe notice, and unsubscribing | missing | no adapter calls `Unsubscribe.fromMessage`. The controller, the plan logic and the host's one-click POST are finished. Two of the three plans additionally throw |
| Calendar invitations, and answering one | missing | no adapter parses the `text/calendar` part, so `message/Calendar.js` and the whole invite card are dark. RSVP also needs a calendar part in the Rust `message()` builder |
| The bar's three-message preview | missing | `bar/Preview.js` imported by nothing, while the setting that turns it on is still offered |
| Sign out without removing the mailbox | missing | settings offers removal only |
| A picture behind an `[image N]` marker | missing | `Html.imageLinkIndex` ported, uncalled; no popover exists |
| A `mailto:` link in a message body | missing | the reader's link handler has no mailto branch |

## Diagnosis and wording

The port collapses failures the plugin distinguishes. Each row is a sentence a
user cannot currently be shown.

| Capability | Status | Where |
|---|---|---|
| Only `invalid_grant` signs an account out | missing, and inverted | any non-2xx from the token endpoint reads as a revoked grant, so a Google 500 sends the user back through consent |
| Gmail's HTTP status reaches the wording | missing | every non-2xx collapses to one sentence; the rate-limit and permission branches are unreachable |
| IMAP response codes reach the wording | missing | `AUTHENTICATIONFAILED`, `[OVERQUOTA]`, `[ALERT]`, `NONEXISTENT` are all unreachable |
| A HEY failure carries the CLI's reason | partial | the host drops it, and the adapter renders `(exit undefined)` |
| Missing-scope detection after consent | missing | the granted scope is length-checked, never compared, so unticking a consent box yields an account that fails at the first archive |
| The six-state setup machine and its wording | partial | `Model.setupState` / `setupDetail` ported, uncalled; only `signed_out` survives |
| The tools probe (`curl`, `secret-tool`, the HEY CLI) | missing | a machine without `curl` is told "Google could not be reached" |
| A keyring miss on IMAP says "sign in again" | partial | it says "provider unavailable", with a Retry that cannot work |
| The status line confirms an action | missing | `Model.actionLabel` has no port; archive, star and mark-read say nothing at all |

## Interaction

| Capability | Status | Where |
|---|---|---|
| `j` / `k` scroll the cursor row into view | missing | `Model.contentYToReveal` ported, tested, uncalled; the list has no scroll handle. `v_virtual_list` + `scroll_to_item` is available |
| Clicking a row in Drafts resumes the draft | partial | the keyboard path does; the mouse path shows the reader |
| Arrow keys and Enter in the recipient completion | missing | `compose.moveSuggestion` ported, uncalled |
| Held Ctrl numbers the rail | missing | the chip is implemented and nothing sets `numbersVisible` |
| Search is reachable on a narrow window | partial | the field is dropped below 760px and `/` is unbound, so there is no way to search at all |
| The key hints stand down on a narrow window | missing | a compact status line draws a row of key caps it has no room for |
| The mailbox row goes unlit while a search narrows the list | missing | the rail still claims you are in a mailbox whose contents are off screen |
| The window's transient notice, cleared on a timer | missing | a duplicate mailbox surfaces as a permanent protocol phrase |

## Blocked on the host

These need a change in gpui-shell or gpui, not here.

| Capability | What is missing |
|---|---|
| Dragging across the message to select part of it | `materialize` never registers a selection run, so the `TextSelectionLayer` the shell already draws has nothing to select. `runtime.rs`'s failure screen is a working reference |
| The keyboard lands in a field when the composer opens | `InputState` carries no focus handle a script can move the keyboard onto |
| `/` focuses the search field | the same |
| The sender's own formatting, and inline images | no HTML engine, and `image()` takes a path rather than a `data:` URI. The image *fetch* is complete and its result reaches no pixel |
| Emphasis and links inside a paragraph | no inline text run; a paragraph is one string in one style |
| Escape closes the window | the host gives a script no way to close its window |
| A responsive inset, and hiding the legend by height | a render is given no measured size |

## Ported and never called

The fastest index of what is missing. Whole files first.

- `app/providers/OAuth.js` and `app/providers/Credentials.js` — nothing imports
  either; the tests resolve the QML copies instead.
- `app/bar/Preview.js` and `app/bar/Status.js` — imported by nothing.
- `app/providers/GmailApi.js` — every parser and every non-web path builder.
- `app/providers/ImapProtocol.js` — 35 uncalled exports, about half
  re-implemented in Rust and half simply absent.
- `account/Model.js` — `setupState`, `setupProvider`, `setupDetail`,
  `mailboxAfterAccountSwitch`, `windowPrefs`, `mergeSearchResults`,
  `settledSearchResults`, `missingSearchSummaryIds`, `resultSummary`,
  `statusSummary`, `barTooltip`, `showListFooter`, `contentYToReveal`,
  `actionLabel`.
- `providers/Registry.js` — `unreadQuery`, `labelQuery`, `isConnectable`,
  `unavailableReason`, `cachedSummaryInSearch`.
- `message/Calendar.js` and `message/Unsubscribe.js` — reached from nowhere in
  the mail path.
- `compose/Senders.js` alias handling, `cache/Cache.js`'s search half,
  `components/Menu.js`'s `position` (correctly — base owns placement now).

## Settings that drive nothing

`oauthPort` and `openOnClick` are offered in the settings page and read by no
code path.
