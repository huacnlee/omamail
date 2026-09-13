# AI-friendly Mail CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add root-level, provider-neutral `list`, `read`, `mark`, `archive`, `trash`, `spam`, and `send` commands with stable JSON output and dry-run-by-default mutations.

**Architecture:** `src/mail/` owns canonical account, query, action, preview, and send inputs. `src/backend/mail.rs` adapts those operations to the existing stateful Gmail, JMAP, IMAP/Outlook, HEY, reader, conversation, compose, and outbox implementations; `src/cli/` only parses inputs and renders results. The same safe operations are exposed as `mail.list`, `mail.read`, `mail.act`, and `mail.send` JSON-RPC methods.

**Tech Stack:** Rust 2024, clap 4, serde/serde_json, Tokio, existing Omamail provider and outbox modules, Rust integration tests, Python backend-contract tests.

**Spec:** `docs/superpowers/specs/2026-09-13-ai-friendly-mail-cli-design.md`

## Global Constraints

- Work in the current checkout; do not create a Git worktree.
- Root commands are exactly `list`, `read`, `mark`, `archive`, `trash`, `spam`, and `send`; do not add a `mail` CLI prefix.
- `mark` accepts exactly `read`, `unread`, `star`, and `unstar`.
- Every state-changing command is a dry run unless `execute: true` / `--execute` is present; there is no confirmation code.
- Dry-run may perform bounded read-only lookups but must not invoke provider mutations, mutate caches/accounts, write files, create drafts, submit messages, or enqueue outbox entries.
- Provider IDs and provider-specific query/action/send parameters must not branch in `src/cli/`.
- Omitted `--account` resolves the active account; an explicit unknown account fails without fallback.
- Message IDs and page tokens remain opaque strings; do not split or rewrite them above the provider adapter.
- JSON errors retain `{"ok":false,"error":{"code":"..."}}`; invalid clap syntax exits 2 and operation failures exit 1.
- Add public RPC methods at API revision 3 while leaving `releasedApiVersion` at 2 and naming every new method/case under `unreleased`.
- Security approval requires explicit dry-run no-write/no-mutation regression evidence and a separate PASS/BLOCK/NOT VERIFIED verdict.

---

### Task 1: Canonical mail requests and account resolution

**Files:**
- Create: `src/mail/mod.rs`
- Create: `src/mail/account.rs`
- Create: `src/mail/types.rs`
- Modify: `src/lib.rs`
- Test: `src/mail/tests.rs`

**Interfaces:**
- Consumes: `crate::account::list() -> Result<Value, &'static str>` and `crate::providers::domain::mailbox_query(provider, mailbox)`.
- Produces: `Account { id: String, provider: Provider }`, `Provider`, `Mailbox`, `Mark`, `ListRequest`, `ReadRequest`, `ActRequest`, `SendRequest`, `resolve_account(&str)`, and strict `TryFrom<&Value>` request parsers used by every later task.

- [ ] **Step 1: Write failing account and enum tests**

Add `#[cfg(test)] mod tests;` to `src/mail/mod.rs`, then create `src/mail/tests.rs` with table tests that set an isolated `XDG_CONFIG_HOME`, write a version-1 account registry, and assert:

```rust
#[test]
fn omitted_account_uses_active_and_explicit_account_never_falls_back() {
    let _env = account_fixture(json!({
        "version": 1,
        "activeId": "imap:active@example.org",
        "accounts": [
            {"provider":"gmail","email":"other@example.org"},
            {"provider":"imap","email":"active@example.org","imap":{"username":"active@example.org"}}
        ]
    }));
    assert_eq!(resolve_account("").unwrap().id, "imap:active@example.org");
    assert_eq!(resolve_account("OTHER@EXAMPLE.ORG").unwrap().id, "other@example.org");
    assert_eq!(resolve_account("missing@example.org"), Err("mail_account_unknown"));
}

#[test]
fn public_vocabulary_is_closed() {
    assert_eq!(Mailbox::try_from("starred").unwrap(), Mailbox::Starred);
    assert_eq!(Mailbox::try_from("all"), Err("mail_mailbox_unknown"));
    for (text, expected) in [("read", Mark::Read), ("unread", Mark::Unread),
                             ("star", Mark::Star), ("unstar", Mark::Unstar)] {
        assert_eq!(Mark::try_from(text).unwrap(), expected);
    }
    assert_eq!(Mark::try_from("starred"), Err("mail_mark_unknown"));
}
```

The fixture guard must serialize environment changes with a static mutex and restore the previous environment on drop, matching existing environment-mutating Rust tests.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `cargo test mail::tests --lib`

Expected: FAIL because `crate::mail`, `resolve_account`, `Mailbox`, and `Mark` do not exist.

- [ ] **Step 3: Add strict canonical types and resolver**

Add `pub mod mail;` to `src/lib.rs`. Define in `src/mail/types.rs`:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Provider { Gmail, Outlook, Hey, Jmap, Imap }

impl Provider {
    pub fn id(self) -> &'static str {
        match self {
            Self::Gmail => "gmail", Self::Outlook => "outlook", Self::Hey => "hey",
            Self::Jmap => "jmap", Self::Imap => "imap",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mailbox { Inbox, Unread, Starred, Sent, Drafts, Archive, Spam, Trash }

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mark { Read, Unread, Star, Unstar }

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Account { pub id: String, pub provider: Provider }

pub struct ListRequest { pub account: Account, pub mailbox: Mailbox, pub query: String,
    pub limit: u16, pub page_token: String }
pub struct ReadRequest { pub account: Account, pub id: String }
pub struct ActRequest { pub account: Account, pub operation: String,
    pub ids: Vec<String>, pub execute: bool }
pub struct AttachmentInput { pub path: PathBuf, pub name: String, pub size: u64 }
pub struct SendRequest { pub account: Account, pub from: String, pub to: Vec<String>,
    pub cc: Vec<String>, pub bcc: Vec<String>, pub subject: String, pub body: String,
    pub attachments: Vec<AttachmentInput>, pub execute: bool }
```

Implement closed, case-sensitive `TryFrom<&str>` parsers for `Mailbox` and `Mark`; keep account IDs case-insensitive only through lowercase normalization. In `src/mail/account.rs`, implement `resolve_account` solely from the credential-free `account::list()` summary:

```rust
pub fn resolve_account(wanted: &str) -> Result<Account, &'static str> {
    let summary = crate::account::list()?;
    let id = if wanted.trim().is_empty() {
        summary["activeId"].as_str().unwrap_or("").to_owned()
    } else {
        wanted.trim().to_lowercase()
    };
    let row = summary["accounts"].as_array().and_then(|rows|
        rows.iter().find(|row| row["id"] == id)).ok_or("mail_account_unknown")?;
    Ok(Account { id, provider: Provider::try_from(row["provider"].as_str().unwrap_or(""))? })
}
```

Reject empty IDs, control characters, more than 1000 action IDs, query/page-token values above 32 KiB, limits outside 1–100, non-object params, unknown fields, and scalar values of the wrong JSON type in the request parsers.

- [ ] **Step 4: Run formatting and focused tests**

Run: `cargo fmt --all -- --check && cargo test mail::tests --lib`

Expected: PASS.

- [ ] **Step 5: Commit the canonical request layer**

```bash
git add src/lib.rs src/mail
git commit -m "feat: add canonical mail task requests"
```

---

### Task 2: Provider-neutral list operation

**Files:**
- Create: `src/mail/list.rs`
- Create: `src/backend/mail.rs`
- Modify: `src/mail/mod.rs`
- Modify: `src/backend/mod.rs`
- Test: `src/mail/list_tests.rs`
- Test: `tests/cli.rs`

**Interfaces:**
- Consumes: Task 1 `ListRequest`; existing `providers::domain::resolve`; provider calls `gmail.list`, `hey.list`, `jmap.list`, `imap.list`/`imap.listContinue`; `message.summaries`/provider message reads.
- Produces: `Session::mail_call`, internal `Session::provider_list`, and public `mail.list` result `{accountId, mailbox, messages, nextPageToken, estimate}`.

- [ ] **Step 1: Write failing list normalization and routing tests**

Create `src/mail/list_tests.rs` around an injected async adapter rather than real credentials:

```rust
#[tokio::test]
async fn list_translates_canonical_mailbox_and_returns_summaries() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let result = list_with(
        ListRequest { account: account(Provider::Imap), mailbox: Mailbox::Unread,
            query: String::new(), limit: 25, page_token: String::new() },
        recording_adapter(seen.clone(), json!({
            "ids":["7:INBOX"], "messages":[message("7:INBOX")],
            "nextPageToken":"next", "estimate":1
        }))
    ).await.unwrap();
    assert_eq!(seen.lock().unwrap()[0]["query"], "folder:INBOX UNSEEN");
    assert_eq!(result["accountId"], "imap:a@example.org");
    assert_eq!(result["messages"][0]["id"], "7:INBOX");
    assert_eq!(result["nextPageToken"], "next");
}
```

Add cases for Gmail, HEY, JMAP, Outlook/IMAP continuation, free-text search overriding mailbox selection, unsupported provider mailbox (`archive` on HEY) returning `mail_mailbox_unavailable`, and a partial page returning an error rather than a continuation beyond missing rows.

- [ ] **Step 2: Run tests and verify the missing operation fails**

Run: `cargo test mail::list_tests --lib`

Expected: FAIL because `list_with` and the adapter interface do not exist.

- [ ] **Step 3: Implement list normalization and backend adapter**

Define a private boxed-future trait in `src/mail/list.rs` so normalization is unit-testable:

```rust
pub(crate) trait ListAdapter: Send + Sync {
    fn list<'a>(&'a self, request: &'a ListRequest, provider_query: String)
        -> Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>>;
}

pub(crate) async fn list_with(request: ListRequest, adapter: &impl ListAdapter)
    -> Result<Value, &'static str>;
```

Resolve the provider query through `providers::domain::resolve` using
`operation: "query"`, provider ID, mailbox name, and search text, but first
require an explicit `domain_queries.json` mapping. Map canonical `archive` to
Gmail's existing `all` query; do not let `resolve` silently turn an unavailable
mailbox into Inbox. Require the provider adapter to return complete
provider-neutral summaries in page order; never hand raw sender HTML to this
result.

Add `mod mail;` under `src/backend/mod.rs`. In `src/backend/mail.rs`, implement the adapter with the existing provider calls. Gmail first lists IDs then reads summary resources; HEY consumes the messages its list already composes; JMAP and IMAP consume their native message blocks. Preserve provider continuation semantics, including IMAP's internal `listContinue` loop, behind one opaque `nextPageToken`.

Route `mail.list` at the start of `Session::dispatch` to `self.mail_call(method, params)`.

- [ ] **Step 4: Add a credential-free CLI-facing contract test**

In `tests/cli.rs`, add an isolated empty account registry case using the
existing JSON `call` process helper with `XDG_CONFIG_HOME` pointed at the empty
fixture directory:

```rust
#[test]
fn list_without_a_configured_account_is_a_stable_json_error() {
    let output = call_in_empty_home("mail.list", b"{}");
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({"ok":false,"error":{"code":"mail_account_unknown"}}));
    assert!(output.stderr.is_empty());
}
```

The root `list` command is intentionally not asserted until Task 7 wires clap.

- [ ] **Step 5: Run focused and regression tests**

Run: `cargo fmt --all -- --check && cargo test mail::list_tests --lib && cargo test --test cli`

Expected: PASS.

- [ ] **Step 6: Commit provider-neutral listing**

```bash
git add src/mail src/backend tests/cli.rs
git commit -m "feat: add provider-neutral mail listing"
```

---

### Task 3: Safe read operation

**Files:**
- Create: `src/mail/read.rs`
- Modify: `src/backend/mail.rs`
- Modify: `src/mail/mod.rs`
- Test: `src/mail/read_tests.rs`
- Test: `tests/cli.rs`

**Interfaces:**
- Consumes: Task 1 `ReadRequest`, `Session::reader_call("reader.open", ...)`, and `account.conversation`.
- Produces: `mail.read` result `{accountId, message, conversation}` with prepared safe content and no raw sender HTML or attachment bytes.

- [ ] **Step 1: Write failing safe-read tests**

Create a cached MIME fixture containing plain text, sender HTML with a script and remote image, and a base64 attachment. Assert through `mail.read` that:

```rust
assert_eq!(result["message"]["nativeContent"]["body"]["text"], "Safe text");
assert!(result["message"]["nativeContent"].get("html").is_none());
assert!(!result.to_string().contains("forbiddenScript"));
assert!(!result.to_string().contains("https://tracker.example/pixel"));
assert!(result["message"]["attachments"][0]["data"].is_null());
assert_eq!(result["conversation"], json!([]));
```

Add rejection cases for unknown accounts, empty/control-character IDs, provider-returned mismatched IDs, and a conversation response whose members do not belong to the requested account.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `cargo test mail::read_tests --lib`

Expected: FAIL because `mail.read` is not implemented.

- [ ] **Step 3: Implement read through the native reader pipeline**

Build the internal reader request with a generated collision-resistant request ID, current epoch milliseconds, `cacheOnly: false`, and `options: {"allowRemoteImages":false,"withReader":true}`. Call `reader.open`, then call `account.conversation` only when the prepared summary carries conversation metadata. Return only the reader's safe prepared/rendered fields and validated summary members; strip internal `readerKey`, raw source fields, and body/attachment octets that are not already excluded by the reader boundary.

Do not add a second HTML sanitizer. Treat any raw HTML escaping `reader.open` as a test failure and fix the reader projection at the boundary.

- [ ] **Step 4: Run read, reader, and contract-adjacent tests**

Run: `cargo fmt --all -- --check && cargo test mail::read_tests --lib && cargo test backend::reader --lib && cargo test --test message`

Expected: PASS.

- [ ] **Step 5: Commit safe mail reading**

```bash
git add src/mail src/backend/mail.rs
git commit -m "feat: add safe provider-neutral mail reads"
```

---

### Task 4: Dry-run action planning and capability enforcement

**Files:**
- Create: `src/mail/action.rs`
- Modify: `src/mail/mod.rs`
- Modify: `src/backend/mail.rs`
- Test: `src/mail/action_tests.rs`

**Interfaces:**
- Consumes: Task 1 `ActRequest`; `account::model` action vocabulary; `providers::can`; `account.conversation` target expansion.
- Produces: `ActionPlan { account, operation, requested_ids, target_ids, add_label_ids, remove_label_ids }`, `plan_action`, and dry-run `mail.act` results.

- [ ] **Step 1: Write failing action-plan tests**

Cover the public-to-domain mapping exactly:

```rust
#[test]
fn mark_vocabulary_maps_once_to_domain_actions() {
    assert_eq!(domain_action("read"), Ok("markRead"));
    assert_eq!(domain_action("unread"), Ok("markUnread"));
    assert_eq!(domain_action("star"), Ok("star"));
    assert_eq!(domain_action("unstar"), Ok("unstar"));
}
```

Add table tests for expected label changes (`read` removes `UNREAD`, `unread` adds it, `star` adds `STARRED`, `unstar` removes it, `archive` removes `INBOX`, `spam` adds `SPAM` and removes `INBOX`) and a dedicated trash plan. Add conversation fixtures proving duplicate members are deduplicated in stable order and sent/self/excluded members follow the existing desktop action rules.

Add one fixture for each provider capability ceiling: HEY refuses archive/star, IMAP and Outlook refuse spam, JMAP account refusals remove a nominal capability, and unknown providers never inherit Gmail permissions.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cargo test mail::action_tests --lib`

Expected: FAIL because the planner does not exist.

- [ ] **Step 3: Implement a pure action planner**

Define:

```rust
pub struct ActionPlan {
    pub account: Account,
    pub operation: String,
    pub requested_ids: Vec<String>,
    pub target_ids: Vec<String>,
    pub add_label_ids: Vec<String>,
    pub remove_label_ids: Vec<String>,
}

pub async fn plan_action(request: &ActRequest, lookup: &impl ActionLookup)
    -> Result<ActionPlan, &'static str>;
```

Use the Rust `account::model` rules as the authority. If a missing Rust helper prevents direct reuse, expose focused `pub(crate)` helpers from `src/account/model.rs`; do not copy the mapping into `src/mail/action.rs`. Read account refusals from the internal registry entry and call `providers::can` before any target lookup that is unnecessary for a refused action.

Serialize the dry-run as `{dryRun:true, executed:false, operation, accountId, requestedIds, targetIds}`. Planning must not call provider mutation adapters, cache methods, account saves, filesystem writes, or outbox methods.

- [ ] **Step 4: Add no-side-effect security tests**

Use an injected lookup/adapter with atomic counters and a temporary sentinel directory. Assert every dry-run action leaves mutation, cache-write, account-write, outbox, and filesystem counters at zero. Include IDs containing `\r`, `\n`, `\r\n`, NUL, bidi controls, quotes, backslashes, and oversized text; all invalid batches fail before lookup or mutation.

- [ ] **Step 5: Run focused security and model tests**

Run: `cargo fmt --all -- --check && cargo test mail::action_tests --lib && cargo test account::model --lib`

Expected: PASS, including zero mutation counters.

- [ ] **Step 6: Commit dry-run planning**

```bash
git add src/mail src/backend/mail.rs src/account/model.rs
git commit -m "feat: plan mail actions without side effects"
```

---

### Task 5: Execute provider-neutral actions and report partial results

**Files:**
- Modify: `src/mail/action.rs`
- Modify: `src/backend/mail.rs`
- Test: `src/mail/action_tests.rs`
- Test: `tests/hey.rs`
- Test: `tests/gmail.rs`

**Interfaces:**
- Consumes: Task 4 `ActionPlan`; provider mutations `gmail.modify/batchModify/trash`, `hey.act`, `jmap.batchModify/trash`, `imap.modify/trash`.
- Produces: executed `mail.act` result `{dryRun:false, executed:true, operation, accountId, requestedIds, targetIds, succeededIds, failedIds}`.

- [ ] **Step 1: Write failing provider-routing tests**

Use a recording mutation adapter to assert exact existing provider calls:

```rust
// Gmail star
("gmail.batchModify", json!({"accountId":"a@example.org","ids":["m1"],
  "addLabelIds":["STARRED"],"removeLabelIds":[]}))
// HEY read
("hey.act", json!({"accountId":"hey:a@example.org","verb":"markRead","ids":["1:9"]}))
// IMAP trash
("imap.trash", json!({"accountId":"imap:a@example.org","ids":["7:INBOX"]}))
// JMAP archive
("jmap.batchModify", json!({"accountId":"jmap:a@example.org","ids":["e1"],
  "addLabelIds":[],"removeLabelIds":["INBOX"]}))
```

Add partial failure fixtures proving failed IDs stay explicit and a timeout/unknown delivery result is never automatically retried. Assert `execute:false` never reaches this adapter.

- [ ] **Step 2: Run action tests and verify routing failures**

Run: `cargo test mail::action_tests --lib`

Expected: FAIL on missing mutation routing.

- [ ] **Step 3: Implement execution from the immutable plan**

Pass `ActionPlan` by value into `execute_action`; do not rebuild it from raw CLI/RPC params. Route only inside `src/backend/mail.rs`. Preserve the provider's supported batch primitive and translate returned per-ID failures into stable `succeededIds` and `failedIds`; if the provider supplies only whole-operation success, all planned IDs succeed or all fail together.

Never apply `model.intent` optimistic updates in the CLI path. Invalidate or update caches only after confirmed provider success, using existing cache invalidation APIs rather than direct file writes.

- [ ] **Step 4: Run provider mutation regressions**

Run: `cargo fmt --all -- --check && cargo test mail::action_tests --lib && cargo test --test gmail && cargo test --test hey`

Expected: PASS.

- [ ] **Step 5: Commit action execution**

```bash
git add src/mail/action.rs src/backend/mail.rs src/mail/action_tests.rs tests/gmail.rs tests/hey.rs
git commit -m "feat: execute provider-neutral mail actions"
```

---

### Task 6: Send preview, attachment validation, and outbox execution

**Files:**
- Create: `src/mail/send.rs`
- Modify: `src/mail/mod.rs`
- Modify: `src/backend/mail.rs`
- Test: `src/mail/send_tests.rs`
- Test: `src/outbox/tests.rs`

**Interfaces:**
- Consumes: Task 1 `SendRequest`; existing sender identity/account settings, `message.compose`, and `Outbox::call("outbox.enqueue", ...)`.
- Produces: dry-run `mail.send` preview and executed result containing `sendId` plus authoritative outbox snapshot.

- [ ] **Step 1: Write failing send-preview tests**

Test normalization of repeated To/Cc/Bcc values, explicit/default From identity, Unicode subject and multiline body, and attachment metadata. The representative JSON assertion is:

```rust
assert_eq!(preview, json!({
  "dryRun": true, "executed": false, "accountId": "a@example.org",
  "from": "Alias <alias@example.org>", "to": ["one@example.org"],
  "cc": [], "bcc": [], "subject": "Plan", "body": "Line one\nLine two\n",
  "attachments": [{"name":"brief.txt","size":5}]
}));
```

Add rejection tests for no To/Cc/Bcc recipients, CR/LF/NUL in address or subject fields, malformed addresses, a From identity not authorized for the account, more than 32 attachments, nonabsolute paths, symlinks/nonregular files, files replaced between validation and read, individual/aggregate size limits, invalid UTF-8 stdin, and body/message limits. Include valid quotes, backslashes, Unicode names, and multiline bodies.

- [ ] **Step 2: Run send tests and verify failure**

Run: `cargo test mail::send_tests --lib`

Expected: FAIL because preview and attachment validation do not exist.

- [ ] **Step 3: Implement preview normalization without writes**

Open attachment paths with `O_RDONLY | O_NOFOLLOW | O_CLOEXEC`, validate regular-file metadata from the opened descriptor, and retain the open file or verified bytes so execution cannot silently read a replacement path. Reuse the existing MIME/address limits and composition validation. Return attachment name and size only; never serialize bytes in the preview.

Resolve sender identities through the existing provider-neutral identity path. Read-only identity discovery is allowed; provider send/draft methods and outbox enqueue are not. Add atomic-counter tests proving dry-run performs no send, draft, outbox, cache/account mutation, or file write.

- [ ] **Step 4: Write failing outbox execution tests**

Inject an outbox whose executor records jobs. Call `mail.send` with `execute:true`, then assert exactly one `outbox.enqueue`, a provider-neutral MIME payload produced by `message.compose`, the resolved account/provider, and a result containing the send ID and snapshot state. Repeating a request with the same explicit `sendId` must use the outbox's existing digest/idempotency behavior; never invent an automatic retry.

- [ ] **Step 5: Implement compose and enqueue from normalized input**

Compose once through the existing Rust message composer, preserving outgoing direction and attachment limits. For HEY, retain attachment paths in the provider payload expected by the official CLI; for Gmail/JMAP/IMAP/Outlook, use the composed raw MIME payload. Enqueue with the existing default 10-second undo delay unless a future separately designed CLI option changes it.

Return:

```json
{"dryRun":false,"executed":true,"accountId":"a@example.org",
 "sendId":"send-...","outbox":{"state":"queued"}}
```

Do not report `sent` until the authoritative outbox state says so. Preserve `unknown` delivery results.

- [ ] **Step 6: Run send, message, and outbox tests**

Run: `cargo fmt --all -- --check && cargo test mail::send_tests --lib && cargo test outbox --lib && cargo test message --lib`

Expected: PASS.

- [ ] **Step 7: Commit sending**

```bash
git add src/mail src/backend/mail.rs src/outbox/tests.rs
git commit -m "feat: preview and enqueue mail sends"
```

---

### Task 7: Root clap commands and stable output

**Files:**
- Modify: `src/cli/mod.rs`
- Create: `src/cli/mail.rs`
- Modify: `src/cli/output.rs`
- Modify: `src/cli/call.rs`
- Test: `tests/cli.rs`

**Interfaces:**
- Consumes: `mail.list`, `mail.read`, `mail.act`, and `mail.send` session methods from Tasks 2–6.
- Produces: root commands and their documented flags; stdin-body and attachment input conversion; stable pretty/JSON results.

- [ ] **Step 1: Write failing clap/help tests**

Extend `tests/cli.rs` to parse help and assert root commands, while proving removed alternatives do not exist:

```rust
for command in ["list", "read", "mark", "archive", "trash", "spam", "send"] {
    assert!(root_help.contains(command));
}
assert_eq!(omamail(&["mail", "list"]).status.code(), Some(2));
assert_eq!(omamail(&["unstar", "m1"]).status.code(), Some(2));
assert_eq!(omamail(&["mark", "starred", "m1"]).status.code(), Some(2));
```

Assert global `--json` works before and after each root subcommand. Assert `mark` accepts only the four approved values, mutation commands expose `--execute`, and read-only commands do not.

- [ ] **Step 2: Run CLI tests and verify failure**

Run: `cargo test --test cli`

Expected: FAIL because the root commands are absent.

- [ ] **Step 3: Add clap declarations and request conversion**

Use focused structs in `src/cli/mail.rs`:

```rust
#[derive(Args)] pub struct AccountArg { #[arg(long)] pub account: Option<String> }
#[derive(ValueEnum, Clone)] pub enum MarkArg { Read, Unread, Star, Unstar }
#[derive(Args)] pub struct ExecuteArg { #[arg(long)] pub execute: bool }
```

Define `List`, `Read`, `Mark`, `Archive`, `Trash`, `Spam`, and `Send` variants directly in the existing `Command` enum. `send` reads at most the existing message body limit from stdin as UTF-8; other commands must not consume stdin. Convert to JSON parameters and call only the four provider-neutral session methods.

For `mark`, translate the clap enum to exactly `read`, `unread`, `star`, or `unstar`; archive/trash/spam call `mail.act` with their own operation. `--attach` remains a repeated absolute `PathBuf`, validated in the mail layer rather than trusted by clap.

- [ ] **Step 4: Add output and dry-run integration tests**

Using isolated account/provider fixtures, assert JSON key sets, pretty output escaping, dry-run exit 0, operation errors on stdout in JSON mode, and stderr in pretty mode. Inject a fake provider executable/local server and sentinel files to prove every CLI mutation without `--execute` makes zero mutation requests and zero writes.

Add stdin tests proving Unicode/multiline send bodies do not appear in process argv or error output. Add control/bidi text to returned sender fields and assert `src/cli/output.rs::safe` prevents terminal escape or table-row injection.

- [ ] **Step 5: Run CLI and source tests**

Run: `cargo fmt --all -- --check && cargo test --test cli && bash tests/test_source.sh`

Expected: PASS.

- [ ] **Step 6: Commit the root CLI surface**

```bash
git add src/cli tests/cli.rs
git commit -m "feat: add task-oriented mail commands"
```

---

### Task 8: Keyboard-safe composer exit

**Files:**
- Create: `ui/components/ComposeExitDialog.qml`
- Modify: `ui/components/ComposeView.qml`
- Modify: `ui/App.qml`
- Modify: `Makefile`
- Modify: `docs/KEYS.md`
- Test: `ui/tests/qml/tst_app_compose_pending.qml`
- Test: `tests/test_qml_names.py`

**Interfaces:**
- Consumes: the existing `back` action, `App.saveAndLeaveCompose`, `ComposeView.snapshotDraft`/`restoreDraft`, and the established modal-dialog color/property pattern.
- Produces: `ComposeView.userModified`, `ComposeView.hasUserChanges()`, and a keyboard-operable `ComposeExitDialog` with `saveRequested` and `discardRequested` signals.

- [ ] **Step 1: Write a failing untouched-reply regression test**

In `tst_app_compose_pending.qml`, open a reply through the real `app.runShortcut("reply", "R")` path, complete its existing asynchronous body/quote setup, call `app.goBack()`, and assert:

```qml
compare(compose.opened, false, "an untouched prefilled reply leaves immediately")
compare(mailService.draftSaveCallbacks.length, 0,
  "programmatic recipient, subject, quote and signature are not user edits")
```

Repeat for an existing provider draft opened and left unchanged. Add a case where asynchronous quote/forward attachment hydration completes after opening and still leaves `userModified === false`.

- [ ] **Step 2: Write failing modified-compose dialog tests**

Use `QTest.keyClicks` on the To, Cc, Bcc, Reply-To, Subject, and body fields and explicit calls/clicks for sender choice, contact acceptance, visibility toggles, attachment addition, and attachment removal. For each interaction, assert `compose.userModified === true`, `app.goBack()` keeps `compose.opened === true`, and `compose-exit-dialog.opened === true`.

Cover all outcomes:

```qml
dialog.cancel()
compare(compose.opened, true)
dialog.discard()
compare(compose.opened, false)
// reopen and edit
dialog.save()
compare(mailService.draftSaveCallbacks.length, 1)
```

Add a save-failure case proving the same snapshot is restored with `userModified === true`, plus a test that Escape inside the popup cancels it and returns active focus to the appropriate compose field. Use Tab/Shift+Tab and Enter to activate each button in separate rows so the workflow is fully keyboard-operable.

- [ ] **Step 3: Run the focused QML test and verify the current behavior fails**

Run:

```bash
make test-qml QML_TEST_ARGS='tst_app_compose_pending'
```

If the Makefile runner does not support a per-file argument, run `make test-qml` and confirm the new named test functions fail for the current `hasMeaningfulDraft()` path.

Expected: untouched replies attempt a save, and no exit-choice popup exists.

- [ ] **Step 4: Track user edits separately from programmatic content**

In `ComposeView.qml`, add:

```qml
property bool userModified: false
function noteUserModified() {
  if (!opened) return
  userModified = true
  draftChanged()
}
function hasUserChanges() { return userModified }
```

Keep `noteDraftChanged()` for recovery scheduling, but set `userModified` only from user-originating signals. Add `onTextEdited: root.noteUserModified()` to each editable text control while preserving existing `onTextChanged` behavior. Call `noteUserModified()` from `chooseFrom`, `acceptTo`/`acceptCc`/`acceptBcc`, the Cc/Bcc/Reply-To toggle clicks, successful user attachment addition, and `removeAttachment`.

Set `userModified = false` after synchronous initialization in `begin` and `beginDraft`; programmatic quote/signature/attachment callbacks must not set it. Add `userModified` to `snapshotDraft`. In `restoreDraft`, restore the saved boolean; for legacy recovery snapshots without the field, derive `true` from `hasMeaningfulDraft()` so a crash-recovered user draft is not silently discarded. `clearCurrentDraft` resets it to false.

- [ ] **Step 5: Add the modal exit choice**

Create `ComposeExitDialog.qml` by following the complete `AccountRemovalDialog.qml` popup pattern: required semantic colors arrive from `App.qml`; no literal color is added. Its title is `Save this draft?`, explanatory text says the message changed, and its buttons are ordered `Cancel`, `Discard`, `Save draft`. Expose test-callable methods:

```qml
readonly property bool opened: dialog.opened
signal saveRequested()
signal discardRequested()
function open() { dialog.open() }
function close() { dialog.close() }
function cancel() { dialog.close() }
function discard() { dialog.close(); discardRequested() }
function save() { dialog.close(); saveRequested() }
```

Use `QQC.Popup.CloseOnEscape`; initial focus goes to `Save draft`, Tab/Shift+Tab traverses all buttons, and Enter activates the focused button. Popup-local keys remain within the popup because an open `QQC.Popup` consumes them before `KeyRouter`.

Instantiate it at App's dialog layer with `foreground`, `dim`, `urgent`, popup background/border, and font properties. Add it to `QML_FILES` in `Makefile` so `qmllint` and `tests/test_qml_names.py` cover it.

- [ ] **Step 6: Route Back through the dirty decision without adding a key**

Add to `App.qml`:

```qml
function requestLeaveCompose() {
  if (!compose.hasUserChanges()) {
    compose.finish()
    return
  }
  composeExitDialog.open()
}
```

Change both the `leaving.kind === "compose"` branch in `back()` and `ComposeView.onCloseRequested` to call `requestLeaveCompose()`. Connect dialog Save to the existing `saveAndLeaveCompose(true)` durable save/recovery path and dialog Discard to `compose.finish()`. Extend `saveAndLeaveCompose(force)` so an explicit Save can persist a changed existing draft even when its current fields are empty; keep the old meaningful-content check for non-forced internal callers. Leave the composer's visible Discard button directly wired to `finish()`.

Do not add a `Keys` handler or a second Escape binding. Keep `ui/keys/Keymap.js` unchanged.

- [ ] **Step 7: Update keyboard documentation and run UI checks**

Replace the old `docs/KEYS.md` claim that Back automatically saves every nonempty composition with the exact dirty-dialog behavior, including untouched prefilled replies and existing drafts.

Run:

```bash
make test-qml
python3 tests/test_qml_names.py
bash tests/test_source.sh
make qml-check
git diff --check
```

Expected: PASS. Confirm the generated key table is unchanged.

- [ ] **Step 8: Commit the composer exit fix**

```bash
git add ui/components/ComposeExitDialog.qml ui/components/ComposeView.qml ui/App.qml ui/tests/qml/tst_app_compose_pending.qml Makefile docs/KEYS.md
git commit -m "fix: make compose exit keyboard-safe"
```

---

### Task 9: Versioned backend contract and documentation

**Files:**
- Modify: `src/backend/methods.rs`
- Modify: `src/backend/mod.rs`
- Modify: `backend-api.json`
- Modify: `tests/test_backend_api.py`
- Modify: `docs/BACKEND.md`
- Test: `tests/test_backend_release.py`

**Interfaces:**
- Consumes: completed public methods and CLI surface.
- Produces: API revision 3 inventory/fixtures and user-facing command documentation.

- [ ] **Step 1: Add failing inventory and contract fixtures**

Add `mail.list`, `mail.read`, `mail.act`, and `mail.send` to `src/backend/methods.rs` and the same ordered positions in `backend-api.json`. Set:

```json
"apiVersion": 3,
"releasedApiVersion": 2,
"unreleased": {
  "methods": ["mail.list", "mail.read", "mail.act", "mail.send"],
  "cases": ["mail list requires an account", "mail action dry run", "mail send dry run"]
}
```

Add contract cases that require no credentials or network: missing-account `mail.list` returns the expected JSON-RPC error; a synthetic account fixture exercises `mail.act` and `mail.send` dry runs without execution. Extend the contract harness with an isolated account registry and sentinel state so it can assert no mutation/write effect.

- [ ] **Step 2: Run contract tests and verify failure**

Run: `python3 tests/test_backend_api.py --binary target/debug/omamail`

Expected: FAIL until `system.info.apiVersion` reports 3 and every new fixture/method matches.

- [ ] **Step 3: Finish API version wiring**

Update the `system.info` result in `src/backend/mod.rs` to `apiVersion: 3`. Ensure the public dispatcher rejects unknown fields and `execute` values of the wrong type before any side effect. Keep QML feature requirements unchanged because the desktop does not consume the new methods in this release step.

- [ ] **Step 4: Document exact task workflows**

Update `docs/BACKEND.md` with copyable examples for list/read, `mark star`, archive dry-run followed by `--execute`, and send body over stdin. State explicitly that `--execute` is not a human-approval proof, dry-run may make read-only queries, JSON dry runs exit 0, and executed delivery is authoritative only through returned outbox state.

- [ ] **Step 5: Run API and release metadata checks**

Run: `cargo build && python3 tests/test_backend_api.py --binary target/debug/omamail && python3 -m unittest tests.test_backend_release`

Expected: PASS for the checkout contract; the published-backend gate continues to test revision 2 because all new methods/cases are listed as unreleased.

- [ ] **Step 6: Commit contract and documentation**

```bash
git add src/backend/methods.rs src/backend/mod.rs backend-api.json tests/test_backend_api.py tests/test_backend_release.py docs/BACKEND.md
git commit -m "docs: publish the AI-friendly CLI contract"
```

---

### Task 10: Full verification and security verdict

**Files:**
- Modify only if verification exposes a scoped defect in files already listed above.
- Test: all suites named below.

**Interfaces:**
- Consumes: Tasks 1–9.
- Produces: release-quality evidence and an explicit security verdict.

- [ ] **Step 1: Verify formatting, compilation, and lint**

Run:

```bash
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --all-targets
```

Expected: all commands exit 0 with no warnings.

- [ ] **Step 2: Verify repository integration gates**

Run:

```bash
bash tests/test_source.sh
python3 tests/test_backend_api.py --binary target/debug/omamail
make test-local
```

Expected: all commands exit 0. If `make test-local` requires unavailable compositor/system services, record the exact missing service and still run every independent Rust, Node, Python, and shell test it contains; do not convert missing evidence into PASS.

- [ ] **Step 3: Run adversarial dry-run audit**

Repeat the CLI security fixtures with all supported providers and assert from controlled server/process logs and sentinel files that dry runs performed only documented reads and produced no mutation request, send, draft, cache/account write, attachment write, or outbox record. Verify CR/LF/CRLF, NUL, malformed UTF-8/encoding, bidi controls, oversized fields, symlink/nonregular/replaced attachments, quotes, backslashes, Unicode, and legitimate multiline bodies.

Expected: every forbidden-effect counter and sentinel diff is zero; valid inputs retain exact semantic content.

- [ ] **Step 4: Record the review verdict**

Review untrusted data from CLI input through canonicalization, provider requests, MIME, outbox persistence, and terminal/JSON output. Report exactly one verdict:

- `PASS` only when Steps 1–3 cover every affected security boundary.
- `BLOCK` for a demonstrated violation.
- `NOT VERIFIED` when a required provider/runtime boundary lacks evidence.

Do not approve or release on `BLOCK` or `NOT VERIFIED`; name the missing evidence.

- [ ] **Step 5: Commit only verification-driven fixes**

If verification required code changes, rerun the affected focused test plus Steps 1–3, then commit only those fixes:

```bash
git status --short
git add src/mail/action.rs src/mail/action_tests.rs
git commit -m "fix: close mail CLI verification gaps"
```

The two paths illustrate an action-layer verification fix. If another scoped
file was fixed, replace them with the literal paths shown by `git status`; do
not use a glob or stage unrelated user work. If no files changed, do not create
an empty commit.
