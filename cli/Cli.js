.pragma library

// The command line: what a flag means, which words are a command, and how an
// account is named. No process, no mailbox, no formatting of a message — those
// live next door. This file is the contract `omamail --help` prints, so a
// change here is a change to what every agent and every shell reads.

var EXIT_OK = 0
var EXIT_ERROR = 1
var EXIT_USAGE = 2
var EXIT_AUTH = 3
var EXIT_NOT_FOUND = 4
var EXIT_UNAVAILABLE = 5

var VERSION_FALLBACK = "0.0.0"

var ALIASES = {
  ls: "list",
  view: "read",
  get: "read",
  show: "read",
  write: "send",
  compose: "send",
  rm: "trash",
  delete: "trash",
  flag: "star",
  "mark-read": "seen",
  "mark-unread": "unseen",
  readmark: "seen"
}

// Top-level verbs that are the same operation as `message <verb>`. Kept as a
// list rather than inferred from MESSAGE_VERBS so `help` can name them as
// shortcuts without claiming that `account` is one.
var MESSAGE_SHORTCUTS = [
  "list", "read", "send", "reply", "forward",
  "archive", "trash", "star", "unstar", "seen", "unseen", "spam"
]

var MESSAGE_VERBS = MESSAGE_SHORTCUTS.slice()

var ROOT_COMMANDS = ["account", "mailbox", "message", "search", "status", "help"]

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

function isFlag(arg) {
  var text = String(arg || "")
  return text.charAt(0) === "-" && text !== "-"
}

function flagName(arg) {
  var text = String(arg || "")
  if (text.indexOf("--") === 0) return text.substring(2)
  if (text.charAt(0) === "-" && text.length === 2) return text.substring(1)
  return ""
}

function envAccount(env) {
  var source = env || {}
  return trimmed(source.OMAMAIL_ACCOUNT || source.omamail_account)
}

function envJson(env) {
  var source = env || {}
  var format = trimmed(source.OMAMAIL_FORMAT || source.omamail_format).toLowerCase()
  return format === "json"
}

function emptyFlags() {
  return {
    account: "",
    json: false,
    pretty: false,
    quiet: false,
    help: false,
    version: false,
    mailbox: "",
    query: "",
    limit: 0,
    pageToken: "",
    to: [],
    cc: [],
    bcc: [],
    from: "",
    subject: "",
    body: "",
    bodyFile: "",
    stdin: false,
    quote: false,
    all: false,
    ids: []
  }
}

function usageError(message, flags) {
  return { ok: false, exit: EXIT_USAGE, error: message, flags: flags || emptyFlags() }
}

function takeValue(argv, index, flag) {
  if (index + 1 >= argv.length) return { error: flag + " needs a value" }
  var next = String(argv[index + 1] || "")
  if (next === "" || (isFlag(next) && next !== "-"))
    return { error: flag + " needs a value" }
  return { value: next, next: index + 1 }
}

function splitAddresses(value) {
  var raw = String(value || "")
  var parts = raw.split(",")
  var out = []
  for (var i = 0; i < parts.length; i++) {
    var address = trimmed(parts[i])
    if (address !== "") out.push(address)
  }
  return out
}

function pushAddresses(list, value) {
  var added = splitAddresses(value)
  for (var i = 0; i < added.length; i++) list.push(added[i])
  return list
}

function positiveInt(value, flag) {
  var number = Math.floor(Number(value))
  if (!isFinite(number) || number < 1)
    return { error: flag + " must be a positive integer" }
  return { value: number }
}

function boundedLimit(value) {
  var number = Math.floor(Number(value))
  if (!isFinite(number) || number < 1) return 25
  if (number > 100) return 100
  return number
}

function applyFlag(flags, name, argv, index) {
  var taken
  if (name === "account" || name === "a") {
    taken = takeValue(argv, index, "--account")
    if (taken.error) return taken
    flags.account = trimmed(taken.value)
    return { next: taken.next }
  }
  if (name === "json" || name === "j") {
    flags.json = true
    return { next: index }
  }
  if (name === "pretty") {
    flags.json = true
    flags.pretty = true
    return { next: index }
  }
  if (name === "quiet" || name === "q") {
    flags.quiet = true
    return { next: index }
  }
  if (name === "help" || name === "h") {
    flags.help = true
    return { next: index }
  }
  if (name === "version" || name === "V") {
    flags.version = true
    return { next: index }
  }
  if (name === "mailbox" || name === "m") {
    taken = takeValue(argv, index, "--mailbox")
    if (taken.error) return taken
    flags.mailbox = trimmed(taken.value).toLowerCase()
    return { next: taken.next }
  }
  if (name === "query") {
    taken = takeValue(argv, index, "--query")
    if (taken.error) return taken
    flags.query = String(taken.value)
    return { next: taken.next }
  }
  if (name === "limit") {
    taken = takeValue(argv, index, "--limit")
    if (taken.error) return taken
    var limit = positiveInt(taken.value, "--limit")
    if (limit.error) return limit
    flags.limit = boundedLimit(limit.value)
    return { next: taken.next }
  }
  if (name === "page-token" || name === "page_token") {
    taken = takeValue(argv, index, "--page-token")
    if (taken.error) return taken
    flags.pageToken = String(taken.value)
    return { next: taken.next }
  }
  if (name === "to") {
    taken = takeValue(argv, index, "--to")
    if (taken.error) return taken
    pushAddresses(flags.to, taken.value)
    return { next: taken.next }
  }
  if (name === "cc") {
    taken = takeValue(argv, index, "--cc")
    if (taken.error) return taken
    pushAddresses(flags.cc, taken.value)
    return { next: taken.next }
  }
  if (name === "bcc") {
    taken = takeValue(argv, index, "--bcc")
    if (taken.error) return taken
    pushAddresses(flags.bcc, taken.value)
    return { next: taken.next }
  }
  if (name === "from") {
    taken = takeValue(argv, index, "--from")
    if (taken.error) return taken
    flags.from = trimmed(taken.value)
    return { next: taken.next }
  }
  if (name === "subject" || name === "s") {
    taken = takeValue(argv, index, "--subject")
    if (taken.error) return taken
    flags.subject = String(taken.value)
    return { next: taken.next }
  }
  if (name === "body" || name === "b") {
    taken = takeValue(argv, index, "--body")
    if (taken.error) return taken
    flags.body = String(taken.value)
    return { next: taken.next }
  }
  if (name === "body-file" || name === "body_file" || name === "F") {
    taken = takeValue(argv, index, "--body-file")
    if (taken.error) return taken
    flags.bodyFile = String(taken.value)
    return { next: taken.next }
  }
  if (name === "stdin") {
    flags.stdin = true
    return { next: index }
  }
  if (name === "quote") {
    flags.quote = true
    return { next: index }
  }
  if (name === "all") {
    flags.all = true
    return { next: index }
  }
  return { error: "Unknown option --" + name }
}

function canonicalVerb(name) {
  var wanted = trimmed(name).toLowerCase()
  if (ALIASES[wanted]) return ALIASES[wanted]
  return wanted
}

function isRootCommand(name) {
  var wanted = canonicalVerb(name)
  var i
  for (i = 0; i < ROOT_COMMANDS.length; i++) {
    if (ROOT_COMMANDS[i] === wanted) return true
  }
  for (i = 0; i < MESSAGE_SHORTCUTS.length; i++) {
    if (MESSAGE_SHORTCUTS[i] === wanted) return true
  }
  return false
}

function isMessageVerb(name) {
  var wanted = canonicalVerb(name)
  for (var i = 0; i < MESSAGE_VERBS.length; i++) {
    if (MESSAGE_VERBS[i] === wanted) return true
  }
  return false
}

function resolveCommand(words) {
  var parts = Array.isArray(words) ? words : []
  if (parts.length === 0) return { group: "", verb: "", rest: [] }
  var first = canonicalVerb(parts[0])
  if (first === "help")
    return { group: "help", verb: canonicalVerb(parts[1] || ""), rest: parts.slice(2) }
  if (first === "account")
    return { group: "account", verb: canonicalVerb(parts[1] || "list"), rest: parts.slice(2) }
  if (first === "mailbox" || first === "folder")
    return { group: "mailbox", verb: canonicalVerb(parts[1] || "list"), rest: parts.slice(2) }
  if (first === "message" || first === "msg") {
    var verb = canonicalVerb(parts[1] || "")
    if (verb === "") return { group: "message", verb: "", rest: [] }
    return { group: "message", verb: verb, rest: parts.slice(2) }
  }
  if (first === "search")
    return { group: "search", verb: "search", rest: parts.slice(1) }
  if (first === "status")
    return { group: "status", verb: "status", rest: parts.slice(1) }
  if (isMessageVerb(first))
    return { group: "message", verb: first, rest: parts.slice(1) }
  return { group: "", verb: first, rest: parts.slice(1) }
}

function parseArgv(argv, env) {
  var args = Array.isArray(argv) ? argv : []
  var flags = emptyFlags()
  flags.account = envAccount(env)
  flags.json = envJson(env)
  var words = []
  var i = 0
  while (i < args.length) {
    var arg = String(args[i] || "")
    if (arg === "--") {
      for (var j = i + 1; j < args.length; j++) words.push(String(args[j] || ""))
      break
    }
    if (isFlag(arg)) {
      var long = arg.indexOf("--") === 0
      var name = flagName(arg)
      if (!long && arg.length > 2) {
        // GNU clustered short options: -jq, -hV. A flag that takes a value
        // may only sit last, so `-ja me@x.com` is `--json --account me@x.com`.
        var cluster = arg.substring(1)
        var consumed = i
        for (var c = 0; c < cluster.length; c++) {
          var applied = applyFlag(flags, cluster.charAt(c), args, consumed)
          if (applied.error) return usageError(applied.error, flags)
          if (applied.next !== consumed) {
            if (c !== cluster.length - 1)
              return usageError("Option -" + cluster.charAt(c) + " cannot be clustered", flags)
            consumed = applied.next
          }
        }
        i = consumed + 1
        continue
      }
      if (name === "") return usageError("Unknown option " + arg, flags)
      var equals = name.indexOf("=")
      if (equals >= 0) {
        var key = name.substring(0, equals)
        var inline = name.substring(equals + 1)
        var fake = args.slice()
        fake.splice(i, 1, "--" + key, inline)
        var inlined = applyFlag(flags, key, fake, i)
        if (inlined.error) return usageError(inlined.error, flags)
        i++
        continue
      }
      var result = applyFlag(flags, name, args, i)
      if (result.error) return usageError(result.error, flags)
      i = result.next + 1
      continue
    }
    words.push(arg)
    i++
  }

  if (flags.help && words.length === 0)
    return { ok: true, group: "help", verb: "", rest: [], flags: flags }
  if (flags.version && words.length === 0)
    return { ok: true, group: "version", verb: "version", rest: [], flags: flags }

  var command = resolveCommand(words)
  if (flags.help) {
    return {
      ok: true,
      group: "help",
      verb: command.group === "help" ? command.verb : (command.group || command.verb),
      rest: [],
      flags: flags
    }
  }
  if (command.group === "") {
    if (command.verb === "")
      return usageError("Pass a command, or --help", flags)
    return usageError("Unknown command '" + command.verb + "'. See omamail --help", flags)
  }
  if (command.group === "message" && command.verb === "")
    return usageError("Pass a message command: list, read, send, reply, archive, trash", flags)
  if (command.group === "message" && !isMessageVerb(command.verb))
    return usageError("Unknown message command '" + command.verb + "'. See omamail message --help", flags)
  if (command.group === "account" && command.verb !== "list")
    return usageError("Unknown account command '" + command.verb + "'. Try omamail account list", flags)
  if (command.group === "mailbox" && command.verb !== "list")
    return usageError("Unknown mailbox command '" + command.verb + "'. Try omamail mailbox list", flags)

  flags.ids = command.rest.slice()
  if (command.group === "search" && flags.query === "" && command.rest.length > 0)
    flags.query = command.rest.join(" ")
  if (flags.limit < 1) flags.limit = 25

  return {
    ok: true,
    group: command.group,
    verb: command.verb,
    rest: command.rest,
    flags: flags
  }
}

function joinAddresses(list) {
  var values = Array.isArray(list) ? list : []
  var out = []
  for (var i = 0; i < values.length; i++) {
    var address = trimmed(values[i])
    if (address !== "") out.push(address)
  }
  return out.join(", ")
}

function chooseBody(flags, stdinText, fileText) {
  var values = flags || emptyFlags()
  if (trimmed(values.body) !== "") return { ok: true, body: String(values.body), source: "flag" }
  if (trimmed(values.bodyFile) !== "") {
    if (fileText === null || fileText === undefined)
      return { ok: false, error: "Could not read " + values.bodyFile }
    return { ok: true, body: String(fileText), source: "file" }
  }
  if (values.stdin === true || (stdinText !== null && stdinText !== undefined && String(stdinText) !== ""))
    return { ok: true, body: String(stdinText || ""), source: "stdin" }
  return { ok: true, body: "", source: "" }
}

function sendFields(flags, body) {
  var values = flags || emptyFlags()
  return {
    to: joinAddresses(values.to),
    cc: joinAddresses(values.cc),
    bcc: joinAddresses(values.bcc),
    from: trimmed(values.from),
    subject: String(values.subject || ""),
    body: String(body === undefined || body === null ? "" : body)
  }
}

function needsIds(group, verb) {
  if (group !== "message") return false
  return verb === "read" || verb === "reply" || verb === "forward"
    || verb === "archive" || verb === "trash" || verb === "star"
    || verb === "unstar" || verb === "seen" || verb === "unseen" || verb === "spam"
}

function needsBody(group, verb) {
  if (group !== "message") return false
  return verb === "send" || verb === "reply" || verb === "forward"
}

function validateCommand(parsed) {
  if (!parsed || parsed.ok === false) return parsed
  var flags = parsed.flags || emptyFlags()
  var group = parsed.group
  var verb = parsed.verb
  if (group === "help" || group === "version") return parsed
  if (needsIds(group, verb) && flags.ids.length === 0)
    return usageError("Pass one or more message ids", flags)
  if (verb === "send" && flags.to.length === 0)
    return usageError("Pass --to with at least one address", flags)
  if (verb === "forward" && flags.to.length === 0)
    return usageError("Pass --to with at least one address", flags)
  if (flags.body !== "" && flags.bodyFile !== "")
    return usageError("Pass --body or --body-file, not both", flags)
  if (flags.body !== "" && flags.stdin)
    return usageError("Pass --body or --stdin, not both", flags)
  if (flags.bodyFile !== "" && flags.stdin)
    return usageError("Pass --body-file or --stdin, not both", flags)
  return parsed
}

// ------------------------------------------------------------------ accounts

function accountMatches(account, wanted) {
  var needle = trimmed(wanted).toLowerCase()
  if (needle === "") return false
  var entry = account || {}
  var id = trimmed(entry.id).toLowerCase()
  var email = trimmed(entry.email).toLowerCase()
  var label = trimmed(entry.label).toLowerCase()
  if (id === needle || email === needle) return true
  if (label !== "" && label === needle) return true
  if (id.indexOf(needle) === 0) return true
  if (email.indexOf(needle) === 0) return true
  return false
}

function selectAccount(list, wanted) {
  var source = list || { accounts: [], activeId: "" }
  var accounts = Array.isArray(source.accounts) ? source.accounts : []
  var saved = []
  var i
  for (i = 0; i < accounts.length; i++) {
    if (accounts[i] && trimmed(accounts[i].id) !== "") saved.push(accounts[i])
  }
  if (saved.length === 0) {
    return { ok: false, exit: EXIT_AUTH, error: "No mailbox is signed in. Open Omamail and add one first" }
  }
  var needle = trimmed(wanted)
  if (needle === "") {
    var active = trimmed(source.activeId)
    for (i = 0; i < saved.length; i++) {
      if (saved[i].id === active) return { ok: true, account: saved[i], accounts: saved }
    }
    return { ok: true, account: saved[0], accounts: saved }
  }
  var matches = []
  for (i = 0; i < saved.length; i++) {
    if (accountMatches(saved[i], needle)) matches.push(saved[i])
  }
  if (matches.length === 1) return { ok: true, account: matches[0], accounts: saved }
  if (matches.length === 0) {
    return { ok: false, exit: EXIT_NOT_FOUND, error: "No mailbox matches '" + needle + "'" }
  }
  return {
    ok: false,
    exit: EXIT_USAGE,
    error: "Several mailboxes match '" + needle + "'. Pass the full address or account id"
  }
}

function actionFor(verb) {
  var name = trimmed(verb)
  if (name === "archive") return "archive"
  if (name === "trash") return "trash"
  if (name === "star") return "star"
  if (name === "unstar") return "unstar"
  if (name === "seen") return "markRead"
  if (name === "unseen") return "markUnread"
  if (name === "spam") return "spam"
  return ""
}

function defaultMailbox(providerId) {
  return "inbox"
}

// ----------------------------------------------------------------- help

function usageLine() {
  return "Usage: omamail [options] <command> [args]"
}

function rootHelp() {
  return [
    usageLine(),
    "",
    "Talk to the mailboxes signed into Omamail. Same accounts, same keyring,",
    "same providers — Gmail, HEY and IMAP — as the window.",
    "",
    "Commands:",
    "  account list              Signed-in mailboxes",
    "  mailbox list              Mailboxes (Inbox, Sent, …) for one account",
    "  message list              Messages in a mailbox",
    "  message read <id>         One message, plain text",
    "  message send              Send a message",
    "  message reply <id>        Reply to a message",
    "  message forward <id>      Forward a message",
    "  message archive <id>…     Archive",
    "  message trash <id>…       Move to trash",
    "  message star <id>…        Star (not on HEY)",
    "  message unstar <id>…      Remove the star",
    "  message seen <id>…        Mark read",
    "  message unseen <id>…      Mark unread",
    "  message spam <id>…        Report spam (not on IMAP)",
    "  search <query>            Search the mailbox",
    "  status                    Unread count and the active account",
    "  help [command]            This help, or help for a command",
    "",
    "Shortcuts: list, read, send, reply, archive, trash, star, search",
    "",
    "Global options:",
    "  -a, --account ID          Mailbox (address, id, or unique prefix)",
    "  -j, --json                JSON on stdout",
    "      --pretty              Indent JSON (implies --json)",
    "  -q, --quiet               No progress on stderr",
    "  -h, --help                Help",
    "  -V, --version             Plugin version",
    "",
    "Environment:",
    "  OMAMAIL_ACCOUNT           Default --account",
    "  OMAMAIL_FORMAT=json       Default --json",
    "",
    "Exit status: 0 ok, 1 error, 2 usage, 3 not signed in, 4 not found, 5 unavailable",
    "",
    "Agents should pass --json. Ids are stable (Gmail's, <uid>:<folder> on IMAP,",
    "<posting>:<topic> on HEY) and never row numbers."
  ].join("\n")
}

function commandHelp(topic) {
  var name = canonicalVerb(topic)
  if (name === "account") {
    return [
      "Usage: omamail account list",
      "",
      "Print the mailboxes signed into Omamail. No network."
    ].join("\n")
  }
  if (name === "mailbox" || name === "folder") {
    return [
      "Usage: omamail mailbox list [--account ID]",
      "",
      "Print the mailboxes one account can open. Gmail and HEY answer from the",
      "provider; IMAP asks the server which folders it actually has."
    ].join("\n")
  }
  if (name === "list") {
    return [
      "Usage: omamail message list [options]",
      "",
      "  -m, --mailbox KEY       inbox, unread, sent, … (default: inbox)",
      "      --query TEXT        Provider search string",
      "      --limit N           Page size, 1–100 (default: 25)",
      "      --page-token TOKEN  Continue from a previous page",
      "",
      "Shortcut: omamail list"
    ].join("\n")
  }
  if (name === "read" || name === "view" || name === "get" || name === "show") {
    return [
      "Usage: omamail message read <id>",
      "",
      "Print headers and the plain-text body. Shortcut: omamail read <id>"
    ].join("\n")
  }
  if (name === "send" || name === "write" || name === "compose") {
    return [
      "Usage: omamail message send --to ADDR [options]",
      "",
      "  --to ADDR               Recipient; repeatable or comma-separated",
      "  --cc, --bcc ADDR        Carbon copies",
      "  --from ADDR             Send-as address this mailbox owns",
      "  -s, --subject TEXT      Subject",
      "  -b, --body TEXT         Body",
      "  -F, --body-file PATH    Body from a file",
      "      --stdin             Body from stdin",
      "",
      "A piped stdin is the body when neither --body nor --body-file is set.",
      "Shortcut: omamail send"
    ].join("\n")
  }
  if (name === "reply") {
    return [
      "Usage: omamail message reply <id> [options]",
      "",
      "  --all                   Reply to every original recipient",
      "  --quote                 Quote the original below the body",
      "  -b, --body TEXT         Body (or --body-file / --stdin)",
      "",
      "HEY chooses reply recipients itself; --all is ignored there."
    ].join("\n")
  }
  if (name === "forward") {
    return [
      "Usage: omamail message forward <id> --to ADDR [options]",
      "",
      "  --to ADDR               Forward to; repeatable",
      "  -b, --body TEXT         Extra text above the quoted original"
    ].join("\n")
  }
  if (name === "search") {
    return [
      "Usage: omamail search <query>",
      "",
      "Search the mailbox. Gmail takes its own operators (from:, has:attachment).",
      "IMAP searches the inbox. HEY searches across boxes.",
      "",
      "The same as: omamail message list --query TEXT"
    ].join("\n")
  }
  if (name === "status") {
    return [
      "Usage: omamail status [--account ID]",
      "",
      "The active mailbox, its provider, and the unread count the badge uses."
    ].join("\n")
  }
  if (name === "archive" || name === "trash" || name === "star" || name === "unstar"
      || name === "seen" || name === "unseen" || name === "spam") {
    return [
      "Usage: omamail message " + name + " <id>…",
      "",
      "Act on one or more messages. A provider that cannot honour the verb",
      "refuses before anything is sent (HEY has no archive or star; IMAP has",
      "no junk verb)."
    ].join("\n")
  }
  if (name === "message" || name === "msg") return rootHelp()
  if (name === "" || name === "help") return rootHelp()
  return "No help for '" + topic + "'. See omamail --help"
}

function versionText(version) {
  return "omamail " + trimmed(version || VERSION_FALLBACK)
}

function exitCodeName(exit) {
  if (exit === EXIT_USAGE) return "usage"
  if (exit === EXIT_AUTH) return "auth"
  if (exit === EXIT_NOT_FOUND) return "not_found"
  if (exit === EXIT_UNAVAILABLE) return "unavailable"
  if (exit === EXIT_OK) return "ok"
  return "error"
}

function replyAddresses(summary, accountEmail, replyAll) {
  var mine = trimmed(accountEmail).toLowerCase()
  var from = summary && summary.replyTo && trimmed(summary.replyTo.email) !== ""
    ? summary.replyTo : (summary && summary.from)
  var to = trimmed(from && from.email)
  if (replyAll !== true) return { to: to, cc: "" }
  var seen = {}
  if (mine !== "") seen[mine] = true
  if (to !== "") seen[to.toLowerCase()] = true
  var copied = []
  function add(list) {
    var values = Array.isArray(list) ? list : []
    for (var i = 0; i < values.length; i++) {
      var email = trimmed(values[i] && values[i].email)
      var key = email.toLowerCase()
      if (email === "" || seen[key]) continue
      seen[key] = true
      copied.push(email)
    }
  }
  add(summary && summary.to)
  add(summary && summary.cc)
  return { to: to, cc: copied.join(", ") }
}

function forwardSubject(subject) {
  var text = trimmed(subject)
  if (/^(fwd|fw):/i.test(text)) return text
  return "Fwd: " + (text || "(no subject)")
}
