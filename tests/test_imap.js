const assert = require("assert")
const { load, deepEqual } = require("./load")

const imap = load("providers/ImapProtocol.js")
const mail = load("message/Message.js")

// ------------------------------------------------------------------ servers

assert.strictEqual(imap.domainOf("jane@fastmail.com"), "fastmail.com")
assert.strictEqual(imap.domainOf("Jane@FastMail.COM"), "fastmail.com")
assert.strictEqual(imap.domainOf("weird@name@example.org"), "example.org",
  "the last @ separates the domain")
assert.strictEqual(imap.domainOf("not-an-address"), "")

assert.strictEqual(imap.presetFor("jane@fastmail.com").id, "fastmail")
assert.strictEqual(imap.presetFor("jane@hotmail.com").id, "outlook", "aliases resolve")
assert.strictEqual(imap.presetFor("jane@me.com").id, "icloud")
assert.strictEqual(imap.presetFor("jane@example.org"), null)

// An unknown domain still gets a guess: imap.<domain> is right far more often
// than an empty field is useful, and a wrong guess is visible and editable.
const guess = imap.suggestedSettings("jane@example.org")
assert.strictEqual(guess.imapHost, "imap.example.org")
assert.strictEqual(guess.smtpHost, "smtp.example.org")
assert.strictEqual(guess.imapPort, 993)
assert.strictEqual(guess.username, "jane@example.org")
assert.strictEqual(guess.insecure, false)

const icloud = imap.suggestedSettings("jane@icloud.com")
assert.strictEqual(icloud.imapHost, "imap.mail.me.com")
assert.strictEqual(icloud.smtpPort, 587)
assert.ok(/app-specific password/i.test(icloud.note), "iCloud says what to go and get")

// Proton only speaks IMAP through a bridge on loopback, in clear text because
// it never leaves the machine.
const proton = imap.suggestedSettings("jane@proton.me")
assert.strictEqual(proton.imapHost, "127.0.0.1")
assert.strictEqual(proton.insecure, true)

// ------------------------------------------------------------- host safety
//
// Every one of these ends up inside a URL handed to an authenticated client.

assert.strictEqual(imap.isValidHost("imap.fastmail.com"), true)
assert.strictEqual(imap.isValidHost("127.0.0.1"), true)
assert.strictEqual(imap.isValidHost("mail-1.example.co.uk"), true)
assert.strictEqual(imap.isValidHost(""), false)
assert.strictEqual(imap.isValidHost("imap.example.com/../evil"), false)
assert.strictEqual(imap.isValidHost("evil.example.com:993"), false, "a port is a separate field")
assert.strictEqual(imap.isValidHost("user@evil.example.com"), false, "userinfo cannot be smuggled in")
assert.strictEqual(imap.isValidHost("imap example com"), false)
assert.strictEqual(imap.isValidHost("imap.example.com?x=1"), false)
assert.strictEqual(imap.isValidHost("-leading-dash.example.com"), false)

assert.strictEqual(imap.normalizedPort(993, 143), 993)
assert.strictEqual(imap.normalizedPort(0, 993), 993, "out of range falls back")
assert.strictEqual(imap.normalizedPort(70000, 993), 993)
assert.strictEqual(imap.normalizedPort("143", 993), 143)
assert.strictEqual(imap.normalizedPort("nonsense", 993), 993)

// Plaintext is loopback-only. Anywhere else it is a password on the wire, and
// the one legitimate case is a bridge that never leaves the machine.
assert.strictEqual(
  imap.normalizeSettings({ imapHost: "imap.example.com", insecure: true }).insecure, false,
  "insecure is refused for a remote host")
assert.strictEqual(
  imap.normalizeSettings({ imapHost: "127.0.0.1", insecure: true }).insecure, true)
assert.strictEqual(
  imap.normalizeSettings({ imapHost: "localhost", insecure: true }).insecure, true)

const validated = imap.validateSettings({ username: "jane@example.org", imapHost: "imap.example.org" })
assert.strictEqual(validated.ok, true)
assert.strictEqual(imap.validateSettings({ imapHost: "imap.example.org" }).ok, false,
  "a mailbox with no username is not connectable")
assert.strictEqual(imap.validateSettings({ username: "jane", imapHost: "" }).ok, false)
assert.ok(/valid IMAP server/i.test(
  imap.validateSettings({ username: "jane", imapHost: "a b c" }).error))

// ------------------------------------------------------------------- URLs

assert.strictEqual(
  imap.imapUrl({ imapHost: "imap.fastmail.com", imapPort: 993 }, "INBOX"),
  "imaps://imap.fastmail.com:993/INBOX")
assert.strictEqual(
  imap.imapUrl({ imapHost: "127.0.0.1", imapPort: 1143, insecure: true }, "INBOX"),
  "imap://127.0.0.1:1143/INBOX")
// A folder is a path segment, so anything that could end it is encoded.
assert.strictEqual(
  imap.imapUrl({ imapHost: "imap.gmail.com" }, "[Gmail]/All Mail"),
  "imaps://imap.gmail.com:993/%5BGmail%5D%2FAll%20Mail")
assert.strictEqual(imap.imapUrl({ imapHost: "a b" }, "INBOX"), "",
  "an invalid host produces no URL at all")
assert.strictEqual(
  imap.smtpUrl({ smtpHost: "smtp.fastmail.com", smtpPort: 465 }),
  "smtps://smtp.fastmail.com:465")

// -------------------------------------------------------------- the query DSL

deepEqual(imap.parseQuery("folder:INBOX"), { folder: "INBOX", criteria: "" })
deepEqual(imap.parseQuery("folder:INBOX UNSEEN"), { folder: "INBOX", criteria: "UNSEEN" })
deepEqual(imap.parseQuery("folder:\\Sent"), { folder: "\\Sent", criteria: "" })
deepEqual(imap.parseQuery("folder:\"Sent Items\" UNSEEN"),
  { folder: "Sent Items", criteria: "UNSEEN" })
deepEqual(imap.parseQuery("folder:\"[Gmail]/All Mail\""),
  { folder: "[Gmail]/All Mail", criteria: "" })
deepEqual(imap.parseQuery("folder:INBOX TEXT \"invoice\""),
  { folder: "INBOX", criteria: "TEXT \"invoice\"" })
// A bare term is what the search box produces before the provider shapes it.
deepEqual(imap.parseQuery("UNSEEN"), { folder: "INBOX", criteria: "UNSEEN" })
deepEqual(imap.parseQuery(""), { folder: "INBOX", criteria: "" })
deepEqual(imap.parseQuery("folder: UNSEEN"), { folder: "INBOX", criteria: "UNSEEN" },
  "an empty folder is the inbox")

assert.strictEqual(imap.isSpecialUse("\\Sent"), true)
assert.strictEqual(imap.isSpecialUse("Sent"), false)
assert.strictEqual(imap.resolveFolder("\\Sent", { "\\sent": "Sent Items" }), "Sent Items")
assert.strictEqual(imap.resolveFolder("\\Sent", {}), "Sent",
  "a server with no SPECIAL-USE falls back to the plain word")
assert.strictEqual(imap.resolveFolder("INBOX", { "\\sent": "Sent Items" }), "INBOX")

// ------------------------------------------------------------- message ids
//
// A UID is unique only inside its folder, so an id that is only a UID would
// collide between folders — in the list, and in the body cache on disk.

assert.strictEqual(imap.messageId(42, "INBOX"), "42:INBOX")
assert.strictEqual(imap.messageId("42", "[Gmail]/All Mail"), "42:[Gmail]/All Mail")
assert.strictEqual(imap.messageId(0, "INBOX"), "", "a UID starts at 1")
assert.strictEqual(imap.messageId("nonsense", "INBOX"), "")

deepEqual(imap.parseMessageId("42:INBOX"), { uid: 42, folder: "INBOX" })
// A folder name may contain colons; the UID is digits, so the first colon is
// unambiguously the separator.
deepEqual(imap.parseMessageId("42:odd:folder:name"), { uid: 42, folder: "odd:folder:name" })
deepEqual(imap.parseMessageId("not-an-id"), { uid: 0, folder: "" })
deepEqual(imap.parseMessageId(""), { uid: 0, folder: "" })
deepEqual(imap.parseMessageId(null), { uid: 0, folder: "" })

// The round trip is what the list and the reader rely on.
const roundTripped = imap.parseMessageId(imap.messageId(7, "Sent Items"))
assert.strictEqual(roundTripped.uid, 7)
assert.strictEqual(roundTripped.folder, "Sent Items")

// Every command runs against the folder the connection selected, so a batch is
// grouped by folder — one conversation each, in the order first seen.
deepEqual(imap.groupByFolder(["3:INBOX", "5:Archive", "4:INBOX"]), [
  { folder: "INBOX", uids: [3, 4] },
  { folder: "Archive", uids: [5] }
])
deepEqual(imap.groupByFolder(["bad", "3:INBOX"]), [{ folder: "INBOX", uids: [3] }],
  "an unparseable id is dropped rather than aimed at some default folder")
deepEqual(imap.groupByFolder([]), [])
deepEqual(imap.groupByFolder(null), [])

// ----------------------------------------------------------------- quoting
//
// An unquoted folder with a space is a syntax error; an unescaped quote is a
// way to end the argument early and append a command of somebody's choosing.

assert.strictEqual(imap.quote("INBOX"), "\"INBOX\"")
assert.strictEqual(imap.quote("Sent Items"), "\"Sent Items\"")
assert.strictEqual(imap.quote("say \"hi\""), "\"say \\\"hi\\\"\"")
assert.strictEqual(imap.quote("back\\slash"), "\"back\\\\slash\"")
assert.strictEqual(imap.quote("ends\r\nLOGOUT"), "\"ends LOGOUT\"",
  "a newline cannot end the command and start another")

// A sequence set is built from numbers only, so nothing from a response can
// extend a command.
assert.strictEqual(imap.sequenceSet([3, 1, 2]), "3,1,2")
assert.strictEqual(imap.sequenceSet(["4", 5]), "4,5")
assert.strictEqual(imap.sequenceSet([]), "")
assert.strictEqual(imap.sequenceSet(["1 UID STORE"]), "", "a smuggled command is not a number")
assert.strictEqual(imap.sequenceSet([0, -1, NaN]), "")
assert.strictEqual(imap.sequenceSet(null), "")

// ---------------------------------------------------------------- commands

assert.strictEqual(imap.searchCommand("UNSEEN"), "UID SEARCH UNSEEN")
assert.strictEqual(imap.searchCommand(""), "UID SEARCH ALL",
  "empty criteria is a syntax error; ALL is what it means")

// BODY.PEEK, never BODY: reading the list must not mark the mailbox seen.
const summaryFetch = imap.summaryFetchCommand([7, 9])
assert.ok(summaryFetch.indexOf("BODY.PEEK[") >= 0, "the list fetch peeks")
assert.ok(summaryFetch.indexOf("BODY[") < 0 || summaryFetch.indexOf("BODY.PEEK[") >= 0)
assert.ok(/^UID FETCH 7,9 /.test(summaryFetch))
assert.ok(summaryFetch.indexOf("UID FLAGS INTERNALDATE RFC822.SIZE") >= 0)
assert.strictEqual(imap.summaryFetchCommand([]), "")

const fullFetch = imap.fullFetchCommand(12)
assert.ok(fullFetch.indexOf("BODY.PEEK[]") >= 0, "opening a message peeks too")
assert.ok(/^UID FETCH 12 /.test(fullFetch))
// One UID or many: refilling a page of bodies is the same request at a
// different size, and must not become one connection per message.
assert.ok(/^UID FETCH 3,4,5 /.test(imap.fullFetchCommand([3, 4, 5])))
assert.strictEqual(imap.fullFetchCommand([]), "")

// Two STOREs, because IMAP has no combined add-and-remove.
deepEqual(imap.storeCommand([4], ["\\Seen"], []), ["UID STORE 4 +FLAGS.SILENT (\\Seen)"])
deepEqual(imap.storeCommand([4], [], ["\\Seen"]), ["UID STORE 4 -FLAGS.SILENT (\\Seen)"])
deepEqual(imap.storeCommand([4, 5], ["\\Seen"], ["\\Flagged"]), [
  "UID STORE 4,5 +FLAGS.SILENT (\\Seen)",
  "UID STORE 4,5 -FLAGS.SILENT (\\Flagged)"
])

assert.strictEqual(imap.moveCommand([4], "Archive"), "UID MOVE 4 \"Archive\"")
assert.strictEqual(imap.copyCommand([4], "Sent Items"), "UID COPY 4 \"Sent Items\"")
assert.strictEqual(imap.statusCommand("INBOX"), "STATUS \"INBOX\" (MESSAGES UNSEEN)")

// UID EXPUNGE, never plain EXPUNGE: the latter removes every \Deleted message
// in the folder, including ones another client marked.
assert.strictEqual(imap.expungeCommand([4, 5]), "UID EXPUNGE 4,5")
assert.strictEqual(imap.expungeCommand([]), "")

// ------------------------------------------------------ splitting responses
//
// The reason this file has a parser at all: a literal is measured in octets and
// may contain any number of CRLFs, so no line-based split can find where one
// response ends and the next begins.

deepEqual(imap.splitResponse("* 1 EXISTS\r\n* 2 RECENT\r\n"), ["* 1 EXISTS", "* 2 RECENT"])

const withLiteral =
  "* 1 FETCH (UID 3 BODY[] {14}\r\nline1\r\nline2\r\n)\r\n" +
  "* 2 FETCH (UID 4 FLAGS (\\Seen))\r\n"
const split = imap.splitResponse(withLiteral)
assert.strictEqual(split.length, 2, "a literal holding CRLFs is still one response")
assert.ok(split[0].indexOf("line1\r\nline2") >= 0)
assert.ok(/^\* 2 FETCH/.test(split[1]), "the next response starts where the literal ended")

// curl strips each custom IMAP request's tagged completion and closing syntax
// from stdout. With --next, the following FETCH therefore starts immediately
// after the previous literal rather than after a closing ')' line.
const curlJoined =
  "* 1 FETCH (UID 3 BODY[] {4}\r\none\r" +
  "* 2 FETCH (UID 4 BODY[] {4}\r\ntwo\r"
deepEqual(imap.parseFetch(curlJoined).map((m) => m.uid), [3, 4])

// A literal whose content contains something that looks like another response
// must not be read as one — this is the injection the octet count prevents.
const spoofed =
  "* 1 FETCH (UID 3 BODY[] {31}\r\n* 9 FETCH (UID 99 FLAGS ())\r\n\r\n)\r\n"
const spoofedSplit = imap.splitResponse(spoofed)
assert.strictEqual(spoofedSplit.length, 1,
  "a forged response inside a literal stays inside it")
deepEqual(imap.parseFetch(spoofed).map((m) => m.uid), [3],
  "a message body cannot inject a second message")

// ------------------------------------------------------------------ SEARCH

deepEqual(imap.parseSearch("* SEARCH 1 4 9\r\nA1 OK SEARCH completed\r\n"), [1, 4, 9])
deepEqual(imap.parseSearch("* SEARCH\r\nA1 OK\r\n"), [], "nothing matched")
deepEqual(imap.parseSearch("A1 OK SEARCH completed\r\n"), [],
  "a server may answer with no SEARCH line at all")
deepEqual(imap.parseSearch(""), [])

// ------------------------------------------------------------------- FETCH

const fetchResponse =
  "* 1 FETCH (UID 42 FLAGS (\\Seen \\Flagged) INTERNALDATE \"17-Jul-2026 09:02:11 +0000\" " +
  "RFC822.SIZE 2048 BODY[HEADER.FIELDS (FROM)] {26}\r\nFrom: jane@example.org\r\n\r\n)\r\n" +
  "A1 OK FETCH completed\r\n"
const fetched = imap.parseFetch(fetchResponse)
assert.strictEqual(fetched.length, 1)
assert.strictEqual(fetched[0].uid, 42)
deepEqual(fetched[0].flags, ["\\Seen", "\\Flagged"])
assert.strictEqual(fetched[0].size, 2048)
assert.strictEqual(fetched[0].raw, "From: jane@example.org\r\n\r\n")
assert.strictEqual(new Date(fetched[0].internalDate).toISOString(), "2026-07-17T09:02:11.000Z")

// The declared size is what cuts the body off, which is why the closing paren
// of the FETCH response does not end up inside the message.
assert.ok(fetched[0].raw.indexOf(")") < 0, "the response's own syntax stays out of the body")

// A UID is the id everything upstream uses. A sequence number changes whenever
// something ahead of the message is expunged, so a response without a UID is
// dropped rather than guessed at.
deepEqual(imap.parseFetch("* 1 FETCH (FLAGS (\\Seen))\r\n"), [])

// Order is the server's, and several messages arrive in one response.
const multi =
  "* 1 FETCH (UID 5 FLAGS ())\r\n" +
  "* 2 FETCH (UID 6 FLAGS (\\Seen))\r\n" +
  "* 3 FETCH (UID 7 FLAGS (\\Flagged))\r\n"
deepEqual(imap.parseFetch(multi).map((m) => m.uid), [5, 6, 7])
deepEqual(imap.parseFetch(multi)[0].flags, [])

// An INTERNALDATE nothing can parse must not become 1970.
assert.strictEqual(imap.parseFetch("* 1 FETCH (UID 8 INTERNALDATE \"nonsense\")\r\n")[0].internalDate, 0)

// ------------------------------------------------------------------ STATUS

deepEqual(imap.parseStatus("* STATUS \"INBOX\" (MESSAGES 42 UNSEEN 3)\r\nA1 OK\r\n"),
  { messages: 42, unseen: 3 })
deepEqual(imap.parseStatus("* STATUS INBOX (UNSEEN 0 MESSAGES 7)\r\n"),
  { messages: 7, unseen: 0 }, "the items are unordered")
deepEqual(imap.parseStatus("A1 NO no such mailbox\r\n"), { messages: 0, unseen: 0 })

// -------------------------------------------------------------------- LIST

const listResponse =
  "* LIST (\\HasNoChildren) \"/\" \"INBOX\"\r\n" +
  "* LIST (\\HasNoChildren \\Sent) \"/\" \"Sent Items\"\r\n" +
  "* LIST (\\Noselect \\HasChildren) \"/\" \"[Gmail]\"\r\n" +
  "* LIST (\\HasNoChildren \\Trash) \"/\" \"Deleted Items\"\r\n"
const folders = imap.parseList(listResponse)
assert.strictEqual(folders.length, 4)
assert.strictEqual(folders[1].name, "Sent Items")
assert.strictEqual(folders[1].delimiter, "/")
assert.strictEqual(folders[2].selectable, false, "\\Noselect holds folders, not mail")
assert.strictEqual(folders[0].selectable, true)

const special = imap.specialFolders(folders)
assert.strictEqual(special["\\sent"], "Sent Items")
assert.strictEqual(special["\\trash"], "Deleted Items")

// A server that advertises no SPECIAL-USE at all is still the common case, so
// the names are matched as a fallback — and only to fill gaps the flags left.
const plainList = imap.parseList(
  "* LIST () \"/\" \"INBOX\"\r\n" +
  "* LIST () \"/\" \"Sent\"\r\n" +
  "* LIST () \"/\" \"Junk\"\r\n" +
  "* LIST () \"/\" \"Archive\"\r\n")
const plainSpecial = imap.specialFolders(plainList)
assert.strictEqual(plainSpecial["\\sent"], "Sent")
assert.strictEqual(plainSpecial["\\junk"], "Junk")
assert.strictEqual(plainSpecial["\\archive"], "Archive")

// Flags win over names: a server that says so is not second-guessed.
const conflicting = imap.parseList(
  "* LIST (\\Sent) \"/\" \"Verzonden\"\r\n" +
  "* LIST () \"/\" \"Sent\"\r\n")
assert.strictEqual(imap.specialFolders(conflicting)["\\sent"], "Verzonden",
  "a declared SPECIAL-USE beats a guess from the name")

// Which folders the mailbox row already covers, so the sidebar lists only the
// rest underneath. Judged on SPECIAL-USE and the name — never on the structural
// flags, because every server sends \HasNoChildren on almost everything and
// treating those as "system" hides the user's whole folder tree.
{
  const listed = imap.parseList(
    "* LIST (\\HasNoChildren) \"/\" \"INBOX\"\r\n" +
    "* LIST (\\HasNoChildren \\Sent) \"/\" \"Sent Items\"\r\n" +
    "* LIST (\\HasNoChildren) \"/\" \"Receipts\"\r\n" +
    "* LIST (\\HasNoChildren) \"/\" \"Trash\"\r\n")
  const map = imap.specialFolders(listed)

  assert.strictEqual(imap.isSpecialFolder(listed[0], map), true, "INBOX always is")
  assert.strictEqual(imap.isSpecialFolder(listed[1], map), true, "\\Sent says so")
  assert.strictEqual(imap.isSpecialFolder(listed[3], map), true,
    "a server with no SPECIAL-USE still had Trash matched by name")
  assert.strictEqual(imap.isSpecialFolder(listed[2], map), false,
    "a folder the user made is not a system folder — this is the one that "
    + "would hide the whole tree if the structural flags decided it")

  assert.strictEqual(imap.isSpecialFolder({ name: "inbox" }, {}), true,
    "INBOX is case-insensitive, which the RFC declares outright")
  assert.strictEqual(imap.isSpecialFolder(null, {}), false)
}

// ------------------------------------------------------------ flags ↔ labels
//
// Unread is the *absence* of \Seen. It is the one inversion in the mapping and
// the easiest thing in the file to get backwards.

deepEqual(imap.labelIdsFor([], "INBOX", {}), ["UNREAD", "INBOX"])
deepEqual(imap.labelIdsFor(["\\Seen"], "INBOX", {}), ["INBOX"])
deepEqual(imap.labelIdsFor(["\\Seen", "\\Flagged"], "INBOX", {}), ["STARRED", "INBOX"])
deepEqual(imap.labelIdsFor(["\\seen"], "INBOX", {}), ["INBOX"], "flags are case-insensitive")
deepEqual(imap.labelIdsFor(["\\Seen"], "Sent Items", { "\\sent": "Sent Items" }), ["SENT"])
deepEqual(imap.labelIdsFor(["\\Seen"], "Junk", { "\\junk": "Junk" }), ["SPAM"])
deepEqual(imap.labelIdsFor(["\\Seen", "\\Deleted"], "INBOX", {}), ["TRASH", "INBOX"])
// A folder is matched case-insensitively; "inbox" is the one name the RFC
// declares case-insensitive outright.
deepEqual(imap.labelIdsFor(["\\Seen"], "inbox", {}), ["INBOX"])

// The mapping has to survive the round trip through Message.summarize, which
// is the whole point of speaking Gmail's label vocabulary.
const summarized = mail.summarize({
  id: "42",
  labelIds: imap.labelIdsFor([], "INBOX", {}),
  payload: { headers: [
    { name: "From", value: "Jane <jane@example.org>" },
    { name: "Subject", value: "=?UTF-8?B?5L2g5aW9?=" }
  ] },
  internalDate: Date.UTC(2026, 6, 17)
}, new Date(Date.UTC(2026, 6, 17)))
assert.strictEqual(summarized.unread, true, "no \\Seen reads as unread all the way up")
assert.strictEqual(summarized.starred, false)
assert.strictEqual(summarized.inInbox, true)
assert.strictEqual(summarized.subject, "你好", "an encoded subject decodes unchanged")
assert.strictEqual(summarized.from.email, "jane@example.org")

// ------------------------------------------------------------ action plans

deepEqual(imap.actionPlan("markRead", {}), { add: ["\\Seen"], remove: [], move: "" })
deepEqual(imap.actionPlan("markUnread", {}), { add: [], remove: ["\\Seen"], move: "" })
deepEqual(imap.actionPlan("star", {}), { add: ["\\Flagged"], remove: [], move: "" })
deepEqual(imap.actionPlan("unstar", {}), { add: [], remove: ["\\Flagged"], move: "" })
deepEqual(imap.actionPlan("trash", { "\\trash": "Deleted Items" }),
  { add: [], remove: [], move: "Deleted Items" })
deepEqual(imap.actionPlan("archive", { "\\archive": "Archive" }),
  { add: [], remove: [], move: "Archive" })

// No archive folder means nowhere for the message to go. An empty move is what
// the caller checks before it offers the button — silently deleting instead is
// the failure this guards.
assert.strictEqual(imap.actionPlan("archive", {}).move, "")
assert.strictEqual(imap.actionPlan("trash", {}).move, "")
assert.strictEqual(imap.actionPlan("nonesuch", {}), null)

// -------------------------------------------------- label changes -> flags
//
// MailAccount asks for a label change in Gmail's vocabulary whichever provider
// it holds. This is where that becomes IMAP, and the two inversions here are
// the ones that would silently do the opposite of what the user pressed.

deepEqual(imap.flagPlanForLabels([], ["UNREAD"], {}),
  { add: ["\\Seen"], remove: [], move: "" }, "removing UNREAD is adding \\Seen")
deepEqual(imap.flagPlanForLabels(["UNREAD"], [], {}),
  { add: [], remove: ["\\Seen"], move: "" }, "adding UNREAD is removing \\Seen")
deepEqual(imap.flagPlanForLabels(["STARRED"], [], {}),
  { add: ["\\Flagged"], remove: [], move: "" })
deepEqual(imap.flagPlanForLabels([], ["STARRED"], {}),
  { add: [], remove: ["\\Flagged"], move: "" })

// Gmail archives by dropping a label; IMAP has one folder per message, so the
// same request is a move.
deepEqual(imap.flagPlanForLabels([], ["INBOX"], { "\\archive": "Archive" }),
  { add: [], remove: [], move: "Archive" })
deepEqual(imap.flagPlanForLabels(["INBOX"], [], {}),
  { add: [], remove: [], move: "INBOX" }, "unarchiving is a move back")
deepEqual(imap.flagPlanForLabels([], ["INBOX"], {}),
  { add: [], remove: [], move: "" },
  "no archive folder means no move -- the caller must not delete instead")

// Marking read while starring is one plan, not two round trips.
deepEqual(imap.flagPlanForLabels(["STARRED"], ["UNREAD"], {}),
  { add: ["\\Seen", "\\Flagged"], remove: [], move: "" })

deepEqual(imap.flagPlanForLabels(null, null, null), { add: [], remove: [], move: "" })

// ------------------------------------------------------------------ errors

assert.strictEqual(imap.responseError(7, "", ""),
  "Could not reach the mail server. Check the address, the port, and the network")
assert.strictEqual(imap.responseError(35, "TLS connect error: unexpected eof", ""),
  "A secure connection to the mail server could not be established")
assert.strictEqual(imap.responseError(6, "", ""),
  "Could not find that mail server. Check the server address")
assert.strictEqual(imap.responseError(67, "", ""),
  "The server rejected that username or password")
assert.strictEqual(imap.responseError(0, "A1 NO [AUTHENTICATIONFAILED] Invalid credentials", ""),
  "The server rejected that username or password")
assert.ok(/certificate/i.test(imap.responseError(60, "", "")))
assert.strictEqual(imap.responseError(0, "", "fallback text"), "fallback text")
assert.ok(/over its storage quota/i.test(imap.responseError(0, "A1 NO [OVERQUOTA] mailbox full", "")))
assert.ok(/no longer on the server/i.test(imap.responseError(0, "A1 NO [NONEXISTENT] no such folder", "")))

// A server's [ALERT] is written for the user by definition — the RFC says a
// client must show it — so it is passed through rather than translated.
assert.strictEqual(
  imap.responseError(0, "* OK [ALERT] Your mailbox will be archived on Friday", ""),
  "Your mailbox will be archived on Friday")

// Nothing that could carry a password reaches a label without passing here.
assert.strictEqual(imap.redact("A1 LOGIN jane@example.org hunter2"), "A1 LOGIN [redacted]")
assert.strictEqual(imap.redact("A1 AUTHENTICATE PLAIN amFuZQBodW50ZXIy"),
  "A1 AUTHENTICATE [redacted]")
assert.strictEqual(imap.redact("failed on imaps://jane:hunter2@imap.example.org/INBOX"),
  "failed on imaps://[redacted]@imap.example.org/INBOX")
assert.strictEqual(imap.redact("password=hunter2"), "password=[redacted]")
// An error carrying a password must not reach the label through the error path
// either — responseError redacts whatever it passes through.
assert.strictEqual(imap.responseError(0, "A1 BAD LOGIN jane hunter2", ""),
  "A1 BAD LOGIN [redacted]")

assert.strictEqual(imap.isFailure("A1 OK completed\r\n"), false)
assert.strictEqual(imap.isFailure("A1 NO [AUTHENTICATIONFAILED] nope\r\n"), true)
assert.strictEqual(imap.isFailure("A1 BAD syntax\r\n"), true)
assert.strictEqual(imap.isFailure("* OK still going\r\n"), false, "untagged OK is not a failure")
assert.strictEqual(imap.failureDetail("A1 NO [AUTHENTICATIONFAILED] Invalid credentials\r\n"),
  "[AUTHENTICATIONFAILED] Invalid credentials")

// ------------------------------------------------------------ capabilities

const caps = imap.parseCapabilities(
  "* CAPABILITY IMAP4rev1 MOVE UIDPLUS SPECIAL-USE\r\nA1 OK\r\n")
deepEqual(caps, ["IMAP4REV1", "MOVE", "UIDPLUS", "SPECIAL-USE"])
assert.strictEqual(imap.hasCapability(caps, "MOVE"), true)
assert.strictEqual(imap.hasCapability(caps, "move"), true)
assert.strictEqual(imap.hasCapability(caps, "IDLE"), false)
assert.strictEqual(imap.hasCapability(null, "MOVE"), false)

// ------------------------------------------------------- decoding the wire
//
// The transport hands back base64 precisely so the octet counts survive. This
// is the round trip that makes the literal parser correct for a body with an
// accent in it — where character counts and octet counts differ.

const accented = "* 1 FETCH (UID 3 BODY[] {12}\r\nCafé crème\r\n)\r\n"
const encoded = Buffer.from(accented, "utf8").toString("base64")
const decoded = imap.decodeResponse(encoded, mail.base64ToBytes, mail.bytesToLatin1)
assert.strictEqual(decoded.length, Buffer.byteLength(accented, "utf8"),
  "one character per octet after decoding")
const accentedFetch = imap.parseFetch(decoded)
assert.strictEqual(accentedFetch.length, 1)
assert.strictEqual(accentedFetch[0].raw.length, 12, "the literal is 12 octets, not 12 characters")
// And those octets are still valid UTF-8 for Message.js to decode later.
assert.strictEqual(
  mail.bytesToUtf8(accentedFetch[0].raw.split("").map((c) => c.charCodeAt(0))),
  "Café crème")

assert.strictEqual(imap.decodeResponse("", mail.base64ToBytes, mail.bytesToLatin1), "")
assert.strictEqual(imap.decodeResponse("abc", null, null), "",
  "no decoder is an empty response, not a crash")

console.log("Imap.js ok")
