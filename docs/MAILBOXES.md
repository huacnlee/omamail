# Mailbox setup

Open Settings and choose Add mailbox, then select your provider.

**Gmail** signs in with Google directly. Google issues Gmail API access per
project, so this route needs an OAuth client you create once — the setup page
walks through it. In exchange it gets labels, conversations, Gmail's own search
syntax, and a "report spam" that Google actually learns from.

Calendar rides the same sign-in but is a separate API: enable **Google
Calendar API** in the Cloud project too, alongside Gmail API, from
[the API library](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
or `gcloud services enable calendar-json.googleapis.com`. Skipping this step
does not surface as a missing-permission message — the calendar panel just
answers every request with a generic "Google calendar request failed. Sign in
again and check Calendar access," because the native backend deliberately
withholds the server's own error text. If calendar requests fail right after
a fresh sign-in, check the Cloud project's enabled APIs before anything else.

Calendar sync reads the account's **primary** calendar only. A secondary,
shared, or delegated calendar — including the separate "Birthdays" calendar
Google generates from Contacts — is never fetched, and editing one has no
effect on what Omamail shows. Older Google accounts can also carry birthday
events written directly into the primary calendar from before Google split
Birthdays out on its own; those show up here and have to be removed from the
primary calendar itself, not from the Birthdays calendar.

Add a Gmail mailbox through **Add mailbox → Gmail**, not by changing an
existing entry's provider: a mailbox already saved as IMAP for the same
address stays a separate row until the OAuth one is signed in and working,
and only then is the IMAP row worth removing.

**Outlook** signs in on Microsoft's own page and uses [Microsoft's supported OAuth route for IMAP and SMTP][microsoft-mail-oauth]. It works with Outlook.com, Hotmail, Live and MSN accounts; Omamail never asks for the Microsoft account password. Until Omamail ships a maintainer-owned public client, the setup page asks for an Application (client) ID from a one-time Microsoft Entra app registration. Make it a public client for personal Microsoft accounts; the sign-in asks for `IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access` and `openid` and shows the device code to enter in the Microsoft page it opens. Microsoft Graph — sending where the tenant has SMTP off, the calendar — is a second code for `Mail.Send` and `Calendars.ReadWrite`, asked for once, when Microsoft refuses the Graph exchange for want of consent: straight after the sign-in where the mailbox sends through Graph, else from the mailbox's settings (*Allow Microsoft Graph...*).

A **work or school** mailbox (Microsoft 365) is the same sign-in addressed to its own tenant: turn on *Work or school account* on the setup page, and register the client in that tenant, or as multi-tenant. Where the tenant has switched authenticated SMTP off — the common Microsoft 365 default, which fails a send with "SmtpClientAuthentication is disabled" — turn on *Send through Microsoft Graph*: the same message goes to Graph's `sendMail` with a token of Graph's own audience, obtained with the same refresh token, and Graph files the sent copy itself. That needs the `Mail.Send` permission on the registration.

Before signing in, enable IMAP in Outlook.com: **Settings > Mail > Forwarding and IMAP > Let devices and apps use IMAP**, then save. Microsoft disables IMAP by default; OAuth consent alone does not enable mailbox access. See [Microsoft's IMAP setup instructions](https://support.microsoft.com/en-us/outlook/pop-imap-and-smtp-settings-for-outlook-com).

**HEY** needs no address and no password. HEY publishes no IMAP, no POP and no
public API, so Omamail reads it through the [HEY CLI][hey-cli] client 37signals
ship for exactly this — which means the sign-in, the token and the keyring entry
it lives in are all `hey`'s, and Omamail never asks for your HEY password.

Install it once:

```bash
omarchy-mise-install github:basecamp/hey-cli hey
```

Recent versions of Omarchy install it for you as a lazy mise tool, so that line
is only for doing it by hand; [37signals' own installer][hey-cli] is the other
route. Either way it lands in `~/.local/bin`, which is where Omamail looks when
it is not already on `PATH`. Then choose **HEY** on the setup page and press
**Sign in to HEY** — that opens HEY in your browser, and nothing else is asked
of you.

The rail is HEY's own: Imbox, New for you, Reply Later, Set Aside, The Feed and
Paper Trail. **No Sent** — HEY's API has one, but `hey` does not serve it yet:
there is no `hey box sent`, and search only scopes to the Imbox, the Feed, Paper
Trail and Trash. When the client gains it, it is one more line in the rail.

What HEY does not have, the panel does not offer: **no star** and **no
archive**, because HEY moves a thread to one of those boxes instead, and a key
that quietly meant "file this in Paper Trail" would be a promise this could not
keep — `e` and `s` say so rather than pretending. Reading, marking read,
replying, searching, labels, trashing and a "report spam" HEY trains its filter
on all work.

Three more differences worth knowing. A HEY row is a *conversation*, not a
single message. Message bodies read as `hey` serves them — as the sender's own
HTML where your `hey` is new enough to hand it over, and as text elsewhere;
Omamail asks for the richer one every time and takes whichever comes back, so
upgrading `hey` improves it with nothing to change here. And the meeting card,
the one-click unsubscribe, attachments and the Screener are all read out of
parts of a message that `hey` does not serve, or out of an endpoint it does not
expose — so they stay in HEY's own app, which the setup page links to.

**JMAP** is an address and an app password or an API token — Fastmail, a Stalwart server of your own, or anything else that speaks the protocol. Discovery starts at `https://<your-address-domain>/.well-known/jmap`. If your domain does not serve that endpoint, enter the server URL under **Server settings**. Discovery uses HTTPS and may follow its authenticated redirect; an unsigned DNS SRV record cannot choose where your credential goes. The credential goes to that server and to the addresses inside its session object.

Where a server offers JMAP and IMAP alike, this is the better of the two. A JMAP row is a *conversation* rather than a single message, and the reader draws a rail of that conversation's other messages down its side — `n` and `p` walk it. Mail also arrives when the server sends it rather than when the next check comes round: every signed-in JMAP mailbox holds one event stream open whether or not the window is, so a message that lands on the server is in the list about a second later.

What your particular server does not have, the panel does not offer — and here that is a fact about your account rather than about the protocol. A server with no Archive mailbox has no Archive row and no `e`; one whose Junk folder trains nothing has no "report spam"; a credential that cannot submit mail makes the mailbox read-only. Each of them says which it is instead of failing after you have pressed it.


**IMAP** is an address and a password. Fastmail, iCloud, Zoho, GMX, Proton via its Bridge, or a server of your own: the servers are filled in from the address for the ones this knows, and shown behind a disclosure so they can be corrected for the ones it does not. Most providers want an *app password* rather than the one you sign in to their website with, and the form says so before you find out the hard way.

What IMAP does not have, the panel does not offer: no labels, no server-side
conversations, no "report spam" — moving a message to a Junk folder teaches a
server nothing, and a button that quietly meant that would be a promise this
could not keep. Archive appears only when the server has an archive folder to
move to. Sending goes out over SMTP, or the mailbox is read-only if no SMTP
server is set.

The sent copy is filed by Omamail rather than left to the server: a message handed to SMTP submission lands nowhere on its own. It goes to the server's own Sent folder, named by the server rather than guessed, and arrives already marked read; a server that reports no Sent folder holds no copy, and the status row says so. One thing worth knowing: a Gmail account read over IMAP has Google file its own copy of anything sent through Gmail's SMTP, so those accounts hold two.

If you enabled the optional CLI link, first run
`python3 scripts/backend-runtime.py disable-cli` from the plugin directory.
Omarchy has no verified uninstall hook to remove that external link for you.
Then remove the plugin:

```bash
omarchy plugin remove omamail
```

That removes the plugin and its private runtime. Account data, caches, drafts
and keyring entries stay in place. Removing those is separate and up to you:

```bash
secret-tool clear service omamail    # refresh tokens and JMAP and IMAP passwords
hey auth logout                      # the HEY session, if you added one
rm -rf ~/.config/omamail             # the OAuth client and account list
rm -rf ~/.cache/omamail              # cached mail
rm ~/.local/share/applications/omamail.desktop
```

Signing out from inside the app clears the keyring entry on its own. The plugin
never edits your shell, Hyprland or theme configuration. The keybinding above
and the mailto desktop file are yours to add and yours to remove.


[Back to installation](../README.md#install)

[hey-cli]: https://github.com/basecamp/hey-cli
[microsoft-mail-oauth]: https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth
