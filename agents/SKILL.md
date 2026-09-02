---
name: omamail
description: >
  Read, search, send, and triage mail through the omamail CLI — the same
  Gmail, HEY, and IMAP mailboxes signed into the Omamail window.
  Use when the user asks to check email, list unread, search mail, read a
  message, send or reply, star, archive, or trash.
  Triggers: omamail, email, mail, inbox, unread, IMAP, Gmail, HEY, send mail,
  search mail, star, archive, reply, mailbox.
  Use when the user runs /omamail.
---

# Omamail

Talk to mail only through `omamail --json`. It is another client of the accounts file and keyring the Omamail window already uses. Do not call Gmail, IMAP, SMTP, or `hey` yourself.

`omamail --help` is the live map. `omamail help send` (and the other verbs) is the flag list.

## Before anything else

- If `omamail` is not on PATH, the plugin is not installed or `~/.local/bin` is missing from PATH. Say so. Do not invent a mail client.
- `omamail --json account list` when the mailbox is unknown or there might be more than one. Exit 3 means nobody is signed in: the user adds a mailbox in the Omamail window. The CLI does not start OAuth, ask for an IMAP password, or run `hey auth login`.
- `-a` / `OMAMAIL_ACCOUNT` selects a mailbox by address, account id (`imap:you@example.com`, `hey:you@hey.com`), unique prefix, or the switcher label.

## Commands that surprise

**Search is not every folder.** Gmail takes Gmail operators (`from:`, `newer_than:`). IMAP typed search is Inbox headers and body (`folder:INBOX TEXT "…"`). HEY searches across boxes. For IMAP Sent, Junk, Trash, or any other folder, `omamail --json mailbox list` then `omamail --json message list --mailbox KEY --limit 100`, paging with `--page-token` until it is empty. Filter those rows in the agent; do not pass `--query` expecting it to stay in that folder.

**Ids are one argv token.** Gmail's message id, `<uid>:<folder>` on IMAP, `<posting>:<topic>` on HEY — never a row number. Quote every id (`omamail --json message star "$id"`). An IMAP folder name can contain spaces; an unquoted id splits and the server never sees a complete one.

**A missing verb is exit 5.** HEY has no star and no archive. IMAP has no junk verb. `account list` names the provider; do not offer an action it cannot honour.

**Send needs `--to` and a body** (`--body`, `--body-file`, or `--stdin`). IMAP send is SMTP and may not appear in Sent. Gmail and HEY return their own ids when they have them.

**HEY `read` is the thread body**, not the subject or sender. List first, then read.

## Acting

Do the verb the user asked for. Trash and spam only when they named that action.

Do not put other people's addresses, message bodies, or refresh tokens into git, pull requests, or commit messages. Keyring secrets never belong on a command line; `omamail` already reads them from stdin.

Exit status: 0 ok, 1 error, 2 usage, 3 not signed in, 4 not found, 5 unavailable. A JSON failure is `{ "ok": false, "error": "…", "code": "…" }` on stdout.
