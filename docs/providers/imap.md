# IMAP, SMTP and Proton Bridge

Required when touching native IMAP/SMTP transport, IMAP parsing, listing, paging or mutations.

- Loopback connections, including custom Proton Bridge ports, upgrade with STARTTLS before authentication; 993/465 use implicit TLS. `insecure` permits a self-signed certificate only on loopback, never plaintext or downgrade after failed STARTTLS. Remote connections use STARTTLS on standard STARTTLS ports and implicit TLS otherwise, with certificate verification. Plaintext synthetic peers require `testPlaintext` compiled only for tests or `integration-test-credentials`.
- `Imap.js` owns protocol strings/parsing; RFC 822 formatting belongs to the message module. The legacy `scripts/mail-transport.sh` carries base64 fields over stdin and passes curl config over stdin. Follow [security boundaries](../SECURITY-BOUNDARIES.md); base64 does not validate config values.
- Keep responses byte-preserving: IMAP literal lengths count octets, not UTF-8 characters. The legacy base64 transport preserves that distinction.
- UID order is not arrival order: Bridge can assign imported mail UIDs newest-first. Snapshot UIDs with `UID FETCH 1:* (UID)`, fetch INTERNALDATE in explicit batches of at most 4096, search stable UID windows, and sort by date before paging. Descending UID is only a date tie-breaker. Do not settle a newest prefix from a high-UID window or substitute shifting sequence-number windows. Unsolicited UID/FLAGS updates must preserve known dates.
- Use `BODY.PEEK`, not `BODY`, for reads that must not mark mail seen.
- Use `UID EXPUNGE`, never bare `EXPUNGE`, which also deletes messages marked by other clients.
- IDs are `<uid>:<folder>`; UIDs alone collide across folders.
- Discover folders with LIST and SPECIAL-USE; do not guess localized/provider-specific names.
