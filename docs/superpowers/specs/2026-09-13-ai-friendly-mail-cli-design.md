# AI-friendly mail CLI

## Purpose

Omamail is already a mail program, so its primary command-line interface should
name mail tasks directly. An AI agent should be able to discover an account,
list mail, read safe content, change message state, and send mail without
learning Gmail, JMAP, IMAP, or HEY RPC parameters.

The existing `call` and `serve` commands remain available as lower-level tools.
The new commands are a stable task interface over a provider-neutral Rust mail
layer, not aliases that reproduce provider routing inside `src/cli/`.

## Command surface

The first complete task surface is:

```text
omamail list
omamail read <MESSAGE_ID>
omamail mark <read|unread|star|unstar> <MESSAGE_ID>...
omamail archive <MESSAGE_ID>...
omamail trash <MESSAGE_ID>...
omamail spam <MESSAGE_ID>...
omamail send ...
```

There is no `mail` prefix: the binary already supplies that context. Existing
auxiliary commands (`accounts`, `providers`, `message parse`, `info`, `version`,
`call`, and `serve`) keep their current names and behavior.

All task commands accept `--account <ID>`. When it is absent, Omamail resolves
the active account. An explicitly named account must exist; there is no provider
fallback and no fuzzy account selection.

### Listing

`list` defaults to the Inbox and 25 rows. It accepts:

```text
--account <ID>
--mailbox <inbox|unread|starred|sent|drafts|archive|spam|trash>
--query <TEXT>
--limit <COUNT>
--page-token <TOKEN>
```

Mailbox and free-text search are canonical inputs. The mail layer translates
them with the existing native provider-domain query rules. Provider query
languages are not exposed as the primary interface. The result names the
resolved account and mailbox, contains provider-neutral message summaries, and
returns an opaque continuation token when another page exists.

Conversation providers retain their established row semantics: a collapsed
conversation is one row with its thread metadata. Stable message IDs remain
opaque strings and are returned without rewriting.

### Reading

`read <MESSAGE_ID>` returns the safe reader result, including summary and header
metadata, plain body text, sanitized display content, attachment descriptors,
and conversation members when present. It reuses the native reader pipeline;
raw sender HTML and attachment bytes are not copied into the ordinary result.
Remote resources remain disabled by default.

The command is named `read`; state changes remain unambiguous because they are
spelled `mark read` and `mark unread`.

### State changes

`mark` takes one of the four canonical action names `read`, `unread`, `star`, or
`unstar`. `archive`, `trash`, and `spam` remain top-level commands because they
are distinct mailbox operations rather than flags.

Targets are rows returned by `list`. For a collapsed conversation, an action
uses the same applicable-member expansion and exclusions as the desktop. The
mail layer checks the provider capability ceiling and account refusals before
building a preview. It must not optimistically change cached rows to make a
refused provider operation appear successful.

Every state-changing task is a dry run unless `--execute` is present. A dry run
performs account resolution, capability checks, target expansion, input
validation, and normalization, then returns:

```json
{
  "dryRun": true,
  "executed": false,
  "operation": "archive",
  "accountId": "person@example.org",
  "requestedIds": ["message-id"],
  "targetIds": ["message-id"]
}
```

It performs no provider mutation, cache mutation, file write, or outbox enqueue.
It may make bounded read-only provider requests when current message or
conversation state is required to produce an honest preview. `--execute` uses
the same normalized request to perform the operation and reports per-target
success and failure. There is no confirmation code: `--execute` is an explicit
execution switch, not proof of human review.

### Sending

`send` accepts repeatable `--to`, `--cc`, `--bcc`, and `--attach` arguments,
plus `--from` and `--subject`. The UTF-8 body is read from stdin so private mail
content does not have to appear in process arguments. Empty stdin is a valid
empty body. Recipient parsing, sender identity validation, attachment limits,
MIME composition, direction handling, and provider capability checks reuse the
existing Rust domain implementations.

The dry-run result contains normalized envelope fields, subject, body text, and
attachment names and sizes so a person can review the exact semantic message.
It does not expose attachment bytes. Dry-run may read explicitly named local
attachment files and bounded provider identity metadata to validate the
preview, but it must not write a draft, submit a message, or enqueue delivery.

With `--execute`, the same normalized message is composed and submitted through
the durable outbox. The result includes the send ID and authoritative outbox
state. A delivery whose outcome is unknown remains unknown and is never retried
merely because the CLI lost its reply.

## Architecture

A new `src/mail/` module owns account resolution and provider-neutral list,
read, action, and send operations. It may call provider sessions through a
small internal interface owned by the backend session, but provider IDs are not
matched in `src/cli/`.

`src/cli/` owns only clap declarations, stdin and local-file input bounds, calls
into the mail layer, and human/JSON rendering. It does not construct Gmail label
patches, JMAP mailbox patches, IMAP commands, or HEY verbs.

The provider-neutral operations are also exposed as public backend methods:
`mail.list`, `mail.read`, `mail.act`, and `mail.send`. CLI commands and
persistent JSON-RPC clients therefore share validation, dry-run behavior, and
results. These methods are added to the method inventory and `backend-api.json`
under the normal API-revision rules; the CLI does not bypass the backend API
contract.

The desktop UI is not required to migrate to these methods in the first change.
The new mail layer must reuse its existing native domain rules and fixtures so
it cannot establish a contradictory provider model. A later UI migration can
be evaluated separately.

## Output and errors

Human output remains Markdown-oriented and terminal-safe. `--json` returns the
same stable data objects regardless of whether the flag precedes or follows a
subcommand. Dry runs are successful results and exit zero. A successful dry run
always contains `dryRun: true` and `executed: false`; an executed result contains
`dryRun: false` and `executed: true`.

Invalid syntax exits 2 through clap. Invalid parameters, an unknown account,
unsupported capability, missing mailbox, refused sender identity, unsafe or
oversized attachment, provider failure, and outbox failure exit 1 with stable
machine error codes. JSON-mode errors keep the existing
`{"ok":false,"error":{"code":"..."}}` envelope and do not echo attacker-
controlled or credential-bearing input. Human errors go to stderr.

Partial batch mutations return explicit successful and failed target IDs. They
must not turn a partial provider response into whole-command success, nor retry
a mutation whose outcome is uncertain.

## Security boundaries

Account records are resolved internally. Command results never contain account
credentials, tokens, server passwords, provider diagnostics, or raw account
settings. Provider capability checks occur before mutation preparation.

Message IDs, query text, addresses, headers, body text, attachment names, page
tokens, and provider replies are untrusted. Existing length, control-character,
address, MIME, HTML, transport, and terminal-output validation remains in their
authoritative modules. A new caller must not weaken those checks or interpolate
values into shell commands, curl configuration, URLs, or protocol text.

Attachment paths are explicit caller inputs. The implementation must reject
nonregular inputs and enforce existing per-file and total message limits before
delivery. The preview prints metadata, not file content. No credential enters
argv or a world-readable setting.

Security verdict for the design: **NOT VERIFIED** until regression tests prove
dry-run cannot reach a provider mutation, local write, or outbox enqueue and
exercise the untrusted inputs listed below. The feature cannot be approved for
release while that evidence is missing.

## Verification

Unit tests cover account/default resolution, mailbox/query translation, action
normalization, conversation target expansion, capability refusals, batch result
aggregation, and send preview normalization.

Provider fixtures cover Gmail, Outlook, HEY, JMAP, and IMAP list, read, action,
and send routing without live credentials. Contract tests exercise
`mail.list`, `mail.read`, `mail.act`, and `mail.send` through the public session
dispatcher and verify the versioned API inventory.

CLI integration tests cover help, global `--json` placement, stable JSON shapes,
active and explicit accounts, pagination, safe reader output, all four `mark`
states, archive/trash/spam, send stdin and attachments, partial failures, and
exit codes.

Separate security regressions prove that dry-run cannot invoke a provider
mutation, mutate a cache or account, write a file, create a draft, submit a
message, or enqueue an outbox entry. Read-only preview calls use controlled
local targets. Tests cover CR, LF, CRLF, NUL, malformed encodings, control and
bidirectional characters, oversized values, nonregular and escaping attachment
paths, quotes, backslashes, Unicode, multiline bodies, unknown accounts, and
unsupported actions. Synthetic credentials are used; no live mailbox is
required for the release gate.

Documentation updates include CLI help examples and `docs/BACKEND.md`. The
existing source, Rust, backend-contract, and published-backend gates continue to
run, with fixtures updated for the new API revision rather than bypassed.

## Companion compose-exit correction

The same delivery includes a keyboard correction for the existing composer.
`Escape` already routes through the single `back` action correctly; the current
exit decision is wrong because it treats any nonempty prefilled reply as a
draft. A reply opened with `r` has recipients, subject, quote, and possibly a
signature before the writer changes anything, so content presence cannot answer
whether the user edited it.

`ComposeView` records a separate `userModified` state. Only user text edits,
sender/contact choices, Cc/Bcc/Reply-To visibility choices, and user attachment
addition/removal set it. Programmatic reply/forward fields, quotes, signatures,
opening a provider-saved draft, and asynchronous attachment hydration do not.
Beginning a new/reply/forward composition or opening an existing provider draft
resets the state after synchronous setup. Restoring unsaved recovery data or a
failed save preserves its prior modified state.

Back or `Escape` immediately closes an unmodified composition without saving,
including an untouched prefilled reply and an untouched existing draft. A
modified composition opens a modal choice with `Save draft`, `Discard`, and
`Cancel`. Saving uses the existing durable draft/recovery path, Discard leaves
without saving the changes, and Cancel keeps the composer open. `Escape` inside
the modal means Cancel; Tab/Shift+Tab and Enter make every choice reachable from
the keyboard. The composer's existing explicit Discard button remains an
immediate destructive action.

No key binding is added: `ui/keys/Keymap.js` remains the sole owner of the
existing `back` binding, and `App.goBack()` remains its router. Tests must prove
the distinction between programmatic defaults and user edits, all three dialog
outcomes, save-failure recovery, and keyboard focus after dismissing the modal.
