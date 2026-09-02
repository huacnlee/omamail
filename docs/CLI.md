# Omamail CLI

A `gh`-style interface to the mailboxes signed into Omamail. Agents, scripts and a terminal all go through `omamail`. It is another client of the same accounts file and the same keyring as the window — not a second copy of your mail, and not a way around signing in through the window.

The plugin puts `~/.local/bin/omamail` on PATH when it loads. `omamail --help` is the live map; this file is the same contract written down.

## Conventions

Noun-verb commands, GNU flags, JSON opt-in, stable ids, no secrets on a command line. That is the shape `gh`, Himalaya and the HEY CLI already taught agents.

| Rule | What it means here |
| --- | --- |
| `--json` | Machine-readable object on stdout. Agents should always pass it. |
| `--pretty` | Indent JSON. Implies `--json`. |
| `-a, --account` | Address, account id (`hey:you@hey.com`, `imap:you@fastmail.com`), unique prefix, or the label from the switcher. |
| `OMAMAIL_ACCOUNT` / `OMAMAIL_FORMAT=json` | The same two flags, from the environment. |
| Ids | Gmail's message id, `<uid>:<folder>` on IMAP, `<posting>:<topic>` on HEY. Never a row number. |
| Exit status | 0 ok, 1 error, 2 usage, 3 not signed in, 4 not found, 5 the provider cannot honour that verb. |
| Body | `--body`, `--body-file`, or `--stdin`. A piped stdin is the body when neither of the first two is set. |

A capability the provider does not declare is refused before anything is sent. HEY has no archive and no star; IMAP has no junk verb. The window already hides those buttons; the CLI says so and exits 5.

## Commands

```
omamail account list
omamail mailbox list
omamail message list [--mailbox inbox] [--query TEXT] [--limit N] [--page-token TOKEN]
omamail message read <id>
omamail message send --to ADDR [--cc ADDR] [--bcc ADDR] [--from ADDR] --subject TEXT [--body TEXT]
omamail message reply <id> [--all] [--quote] --body TEXT
omamail message forward <id> --to ADDR [--body TEXT]
omamail message archive|trash|star|unstar|seen|unseen|spam <id>…
omamail search <query>
omamail status
```

Shortcuts: `list`, `read`, `send`, `reply`, `archive`, `trash`, `star`, `search`.

`--mailbox` takes the same keys the rail uses: `inbox`, `unread`, `sent`, `starred`, `drafts`, `trash`, and on HEY `later`, `aside`, `feed`, `papertrail`.

## JSON shape

A list is one object:

```
{
  "account": { "id": "me@gmail.com", "email": "me@gmail.com", "provider": "gmail" },
  "mailbox": "inbox",
  "estimate": 12,
  "nextPageToken": "",
  "messages": [
    {
      "id": "18c3…",
      "threadId": "18c3…",
      "from": { "name": "Jane", "email": "jane@example.com", "display": "Jane" },
      "subject": "Hello",
      "snippet": "Hi there",
      "date": "2026-01-02T03:04:05.000Z",
      "unread": true,
      "starred": false
    }
  ]
}
```

A failure with `--json` is `{ "ok": false, "error": "…", "code": "auth" }` on stdout.

## What it does not do

It does not sign a mailbox in. Gmail's OAuth walkthrough, IMAP's password form and HEY's browser flow stay in the window, because each of those is a one-time conversation with a human. It does not download attachments. It does not send until `--to` and a body are both present.

HEY's thread read returns the conversation body and not the subject or sender — that is how `hey threads` answers. List first, then read.
