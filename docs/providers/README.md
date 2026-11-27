# Provider invariants

Required when changing provider adapters, account identity, capabilities or provider-dependent UI.

- Keep provider differences in descriptors and adapters, not in higher-level views: the Rust providers in `core/src/providers/`, the TSX list clients in `src/mail/list/providers/` and the provider descriptors in `src/mail/providers/registry.ts`. Chooser order is Gmail, Outlook, Microsoft 365, HEY, JMAP, IMAP; prefer the specific protocol before the catch-all.
- Every list client implements the same `MailClient` interface (`src/mail/list/providers/shared.ts`) with the same result shapes; `clientFor` in `src/mail/list/providers/index.ts` picks one per account.
- Every provider returns Gmail's message-resource shape: headers, MIME tree and base64url bodies. RFC 822 adapters parse with `message::parse` (`core/src/message/mod.rs`); HEY builds the same shape from postings and topics (`core/src/providers/hey.rs`). Conversation listings add the `thread` block read by `blockOf` in `src/mail/listModel.ts`.
- Detail reads update only fields they carry (the `detailSummary` operation in `core/src/account/model.rs`); absence must not erase listing metadata.
- Provider capabilities are a ceiling. Account refusals can remove capabilities, never add them. Hide unsupported buttons and mailbox roles, filter key hints, and refuse actions before optimistic updates (`act` in `src/features/list/store.ts`, with `capabilitiesOf` from `src/mail/list/providers/facts.ts`). Hiding a button does not disable its shortcut.
- `threads` means server thread identity; `conversations` means a collapsed listing. Do not infer one from the other.
- Gmail account IDs remain the lower-cased address for compatibility. Other IDs are `<provider>:<lower-cased-address>`; the same address can identify different providers.
- Resolve web locations through the `providers.resolve` operations `webMessageUrl` and `webBoxUrl` (`core/src/providers/domain.rs`), and open a message URL only after `webMessageUrlAllowed` (`src/mail/list/providers/facts.ts`).
- A provider's `mark` in `src/mail/providers/registry.ts` supplies its square artwork; preserve official artwork colors. Unbranded providers (`mark: null`) use the themed envelope.

Read the provider-specific [HEY](hey.md), [IMAP](imap.md), [JMAP](jmap.md) or [Microsoft 365](m365.md) notes when applicable, and [security boundaries](../SECURITY-BOUNDARIES.md) before touching transport or authentication.
