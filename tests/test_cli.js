const assert = require("assert")
const { load, deepEqual } = require("./load")

const Cli = load("cli/Cli.js")
const View = load("cli/View.js")
const Accounts = load("account/Accounts.js")

function parse(argv, env) {
  return Cli.parseArgv(argv, env || {})
}

function ok(argv, env) {
  const parsed = Cli.validateCommand(parse(argv, env))
  assert.strictEqual(parsed.ok, true, parsed.error)
  return parsed
}

// ----------------------------------------------------------------- parse

let parsed = ok(["--help"])
assert.strictEqual(parsed.group, "help")

parsed = ok(["-h"])
assert.strictEqual(parsed.group, "help")

parsed = ok(["-V"])
assert.strictEqual(parsed.group, "version")

parsed = ok(["account", "list"])
assert.strictEqual(parsed.group, "account")
assert.strictEqual(parsed.verb, "list")

parsed = ok(["list"])
assert.strictEqual(parsed.group, "message")
assert.strictEqual(parsed.verb, "list")
assert.strictEqual(parsed.flags.limit, 25)

parsed = ok(["ls", "--limit", "10"])
assert.strictEqual(parsed.verb, "list")
assert.strictEqual(parsed.flags.limit, 10)

parsed = ok(["message", "list", "--mailbox", "sent", "--json"])
assert.strictEqual(parsed.flags.mailbox, "sent")
assert.strictEqual(parsed.flags.json, true)

parsed = ok(["-ja", "me@example.com", "status"])
assert.strictEqual(parsed.group, "status")
assert.strictEqual(parsed.flags.json, true)
assert.strictEqual(parsed.flags.account, "me@example.com")

parsed = ok(["read", "abc123"])
assert.strictEqual(parsed.verb, "read")
deepEqual(parsed.flags.ids, ["abc123"])

parsed = ok(["view", "abc123"])
assert.strictEqual(parsed.verb, "read")

parsed = ok(["send", "--to", "a@b.com,c@d.com", "--subject", "Hi", "--body", "Hello"])
deepEqual(parsed.flags.to, ["a@b.com", "c@d.com"])
assert.strictEqual(parsed.flags.subject, "Hi")
assert.strictEqual(parsed.flags.body, "Hello")

parsed = ok(["send", "--to", "a@b.com", "--to", "c@d.com", "--body", "x"])
deepEqual(parsed.flags.to, ["a@b.com", "c@d.com"])

parsed = ok(["search", "from:jane", "invoice"])
assert.strictEqual(parsed.group, "search")
assert.strictEqual(parsed.flags.query, "from:jane invoice")

parsed = ok(["list", "--query=in:inbox"])
assert.strictEqual(parsed.flags.query, "in:inbox")

parsed = ok(["archive", "one", "two"])
deepEqual(parsed.flags.ids, ["one", "two"])
assert.strictEqual(Cli.actionFor(parsed.verb), "archive")

parsed = ok(["seen", "id1"])
assert.strictEqual(Cli.actionFor(parsed.verb), "markRead")

parsed = ok(["mark-unread", "id1"])
assert.strictEqual(parsed.verb, "unseen")

parsed = ok(["reply", "id1", "--all", "--quote", "--body", "thanks"])
assert.strictEqual(parsed.flags.all, true)
assert.strictEqual(parsed.flags.quote, true)

parsed = parse(["list"], { OMAMAIL_ACCOUNT: "hey:me@hey.com", OMAMAIL_FORMAT: "json" })
assert.strictEqual(parsed.ok, true)
assert.strictEqual(parsed.flags.account, "hey:me@hey.com")
assert.strictEqual(parsed.flags.json, true)

parsed = parse(["--"])
assert.strictEqual(parsed.ok, false)
assert.strictEqual(parsed.exit, Cli.EXIT_USAGE)

parsed = parse(["wat"])
assert.strictEqual(parsed.ok, false)
assert.ok(/Unknown command/.test(parsed.error))

parsed = parse(["--wat"])
assert.strictEqual(parsed.ok, false)
assert.ok(/Unknown option/.test(parsed.error))

parsed = Cli.validateCommand(parse(["read"]))
assert.strictEqual(parsed.ok, false)
assert.ok(/message ids/.test(parsed.error))

parsed = Cli.validateCommand(parse(["send", "--body", "hi"]))
assert.strictEqual(parsed.ok, false)
assert.ok(/--to/.test(parsed.error))

parsed = Cli.validateCommand(parse(["send", "--to", "a@b.com", "--body", "x", "--body-file", "y"]))
assert.strictEqual(parsed.ok, false)
assert.ok(/not both/.test(parsed.error))

parsed = parse(["--limit", "0", "list"])
assert.strictEqual(parsed.ok, false)

parsed = ok(["list", "--limit", "999"])
assert.strictEqual(parsed.flags.limit, 100)

parsed = parse(["--json", "bogus"])
assert.strictEqual(parsed.ok, false)
assert.strictEqual(parsed.flags.json, true)

// ----------------------------------------------------------------- help

const help = Cli.rootHelp()
assert.ok(help.indexOf("omamail [options]") >= 0)
assert.ok(help.indexOf("message list") >= 0)
assert.ok(help.indexOf("message send") >= 0)
assert.ok(help.indexOf("--json") >= 0)
assert.ok(help.indexOf("OMAMAIL_ACCOUNT") >= 0)
assert.ok(Cli.commandHelp("send").indexOf("--to") >= 0)
assert.ok(Cli.commandHelp("").indexOf("Commands:") >= 0)
assert.strictEqual(Cli.versionText("0.7.0"), "omamail 0.7.0")
assert.strictEqual(Cli.exitCodeName(Cli.EXIT_AUTH), "auth")
assert.strictEqual(Cli.exitCodeName(Cli.EXIT_NOT_FOUND), "not_found")

// ----------------------------------------------------------------- accounts

const list = Accounts.add(Accounts.emptyList(), {
  email: "one@gmail.com", provider: "gmail", label: "Work"
})
const withHey = Accounts.add(list, {
  email: "two@hey.com", provider: "hey"
})

let picked = Cli.selectAccount(withHey, "")
assert.strictEqual(picked.ok, true)
assert.strictEqual(picked.account.email, "one@gmail.com")

picked = Cli.selectAccount(withHey, "two@hey.com")
assert.strictEqual(picked.account.id, "hey:two@hey.com")

picked = Cli.selectAccount(withHey, "hey:")
assert.strictEqual(picked.account.provider, "hey")

picked = Cli.selectAccount(withHey, "Work")
assert.strictEqual(picked.account.email, "one@gmail.com")

picked = Cli.selectAccount(withHey, "nobody@example.com")
assert.strictEqual(picked.ok, false)
assert.strictEqual(picked.exit, Cli.EXIT_NOT_FOUND)

picked = Cli.selectAccount(Accounts.emptyList(), "")
assert.strictEqual(picked.ok, false)
assert.strictEqual(picked.exit, Cli.EXIT_AUTH)

picked = Cli.selectAccount(withHey, "one@")
assert.strictEqual(picked.ok, true, "a unique prefix of one address still matches")
assert.strictEqual(picked.account.email, "one@gmail.com")

const twice = Accounts.add(withHey, {
  email: "one@fastmail.com", provider: "imap"
})
picked = Cli.selectAccount(twice, "one@")
assert.strictEqual(picked.ok, false)
assert.strictEqual(picked.exit, Cli.EXIT_USAGE)

// ----------------------------------------------------------------- body / send fields

let body = Cli.chooseBody({ body: "hello", bodyFile: "", stdin: false }, "piped", null)
assert.strictEqual(body.source, "flag")
assert.strictEqual(body.body, "hello")

body = Cli.chooseBody({ body: "", bodyFile: "note.txt", stdin: false }, "", "from file")
assert.strictEqual(body.source, "file")
assert.strictEqual(body.body, "from file")

body = Cli.chooseBody({ body: "", bodyFile: "", stdin: true }, "from stdin", null)
assert.strictEqual(body.source, "stdin")

const fields = Cli.sendFields({
  to: ["a@b.com", "c@d.com"],
  cc: ["e@f.com"],
  bcc: [],
  from: "me@x.com",
  subject: "Hi",
  body: ""
}, "Hello")
assert.strictEqual(fields.to, "a@b.com, c@d.com")
assert.strictEqual(fields.cc, "e@f.com")
assert.strictEqual(fields.body, "Hello")

const reply = Cli.replyAddresses({
  from: { email: "jane@x.com", name: "Jane" },
  replyTo: { email: "" },
  to: [{ email: "me@x.com" }, { email: "bob@x.com" }],
  cc: [{ email: "copy@x.com" }]
}, "me@x.com", true)
assert.strictEqual(reply.to, "jane@x.com")
assert.ok(reply.cc.indexOf("bob@x.com") >= 0)
assert.ok(reply.cc.indexOf("copy@x.com") >= 0)
assert.ok(reply.cc.indexOf("me@x.com") < 0)
assert.ok(reply.cc.indexOf("jane@x.com") < 0)

assert.strictEqual(Cli.forwardSubject("Hello"), "Fwd: Hello")
assert.strictEqual(Cli.forwardSubject("Fwd: Hello"), "Fwd: Hello")
assert.strictEqual(Cli.forwardSubject("FW: Hello"), "FW: Hello")

assert.strictEqual(Cli.needsIds("message", "read"), true)
assert.strictEqual(Cli.needsIds("message", "list"), false)
assert.strictEqual(Cli.needsBody("message", "send"), true)

// ----------------------------------------------------------------- view

const row = {
  id: "abc",
  threadId: "t1",
  from: { name: "Jane", email: "jane@x.com", display: "Jane" },
  to: [{ name: "Me", email: "me@x.com", display: "Me" }],
  subject: "Hello",
  snippet: "Hi there",
  date: new Date("2026-01-02T03:04:05.000Z"),
  unread: true,
  starred: false,
  time: "03:04"
}

const json = JSON.parse(View.formatList([row], { mailbox: "inbox", estimate: 1, nextPageToken: "" }, true, false, {
  id: "me@x.com", email: "me@x.com", provider: "gmail"
}))
assert.strictEqual(json.messages[0].id, "abc")
assert.strictEqual(json.messages[0].unread, true)
assert.strictEqual(json.messages[0].from.email, "jane@x.com")
assert.strictEqual(json.account.email, "me@x.com")
assert.ok(json.messages[0].date.indexOf("2026-01-02") === 0)

const table = View.formatList([row], { mailbox: "inbox" }, false, false, null)
assert.ok(table.indexOf("Hello") >= 0)
assert.ok(table.indexOf("Jane") >= 0)
assert.ok(table.indexOf("abc") >= 0)

const read = View.formatRead(row, "Hi there", false, false, null)
assert.ok(read.indexOf("From: Jane") >= 0)
assert.ok(read.indexOf("Hi there") >= 0)

const err = JSON.parse(View.formatError("Nope", true, false, "auth"))
assert.strictEqual(err.ok, false)
assert.strictEqual(err.code, "auth")

console.log("test_cli.js ok")
