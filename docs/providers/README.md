# Provider invariants

Required when changing provider adapters, account identity, capabilities or provider-dependent UI.

- Keep provider differences in descriptors/adapters and the registry, not higher-level views. Chooser order is Gmail, Outlook, HEY, JMAP, IMAP; prefer the specific protocol before the catch-all.
- Auth and fetching adapters expose the same methods and callback shapes to `MailAccount`.
- Every client returns Gmail's message-resource shape: headers, MIME tree and base64url bodies. RFC 822 adapters use `Message.parseRfc822`; HEY constructs the same shape from postings and topics. Conversation listings add the `thread` block consumed by `Message.threadOf`.
- Detail reads update only fields they carry (`Model.detailSummary`); absence must not erase listing metadata.
- Provider capabilities are a ceiling. Account refusals can remove capabilities, never add them. Hide unsupported buttons and mailbox roles, filter key hints, and refuse actions in `MailAccount.act` before optimistic updates. Hiding a button does not disable its shortcut.
- `threads` means server thread identity; `conversations` means a collapsed listing. Do not infer one from the other.
- Gmail account IDs remain the lower-cased address for compatibility. Other IDs are `<provider>:<lower-cased-address>`; the same address can identify different providers.
- Resolve web locations through `Registry.webMessageUrl` / `webBoxUrl`.
- `Registry.mark` supplies the square icon and `logo` the lockup; preserve official artwork colors. Unbranded providers use the themed envelope.

Read the provider-specific [HEY](hey.md), [IMAP](imap.md) or [JMAP](jmap.md) notes when applicable, and [security boundaries](../SECURITY-BOUNDARIES.md) before touching transport or authentication.
