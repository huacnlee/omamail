#!/usr/bin/env node
"use strict"

// Node entry for the Omamail CLI. Argument parsing and output shape live in
// the pragma libraries next door; this file is the process: files, the
// keyring, curl, the IMAP transport, and `hey`. Credentials cross on stdin,
// never on a command line.

const fs = require("fs")
const os = require("os")
const path = require("path")
const vm = require("vm")
const { spawnSync } = require("child_process")

const ROOT = process.env.OMAMAIL_ROOT
  ? path.resolve(process.env.OMAMAIL_ROOT)
  : path.resolve(__dirname, "..")

const IMPORT_SOURCE = '^\\s*\\.import\\s+"([^"]+)"\\s+as\\s+(\\w+)\\s*$'

function load(relativePath) {
  const file = path.join(ROOT, relativePath)
  const raw = fs.readFileSync(file, "utf8")
  const context = {}
  vm.createContext(context)
  const imports = [...raw.matchAll(new RegExp(IMPORT_SOURCE, "gm"))]
  for (const [, target, qualifier] of imports) {
    context[qualifier] = load(path.relative(ROOT, path.resolve(path.dirname(file), target)))
  }
  const source = raw
    .replace(/^\.pragma library\s*$/m, "")
    .replace(new RegExp(IMPORT_SOURCE, "gm"), "")
  vm.runInContext(source, context)
  return context
}

const Cli = load("cli/Cli.js")
const View = load("cli/View.js")
const Accounts = load("account/Accounts.js")
const Aliases = load("account/Aliases.js")
const Credentials = load("providers/Credentials.js")
const Secrets = load("providers/Secrets.js")
const OAuth = load("providers/OAuth.js")
const Api = load("providers/GmailApi.js")
const Registry = load("providers/Registry.js")
const Mail = load("message/Message.js")
const Model = load("account/Model.js")
const Imap = load("providers/ImapProtocol.js")
const Hey = load("providers/HeyCli.js")

const REQUEST_TIMEOUT_SEC = 30

function configHome() {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
}

function accountsPath() {
  return path.join(configHome(), "omamail", "accounts.json")
}

function credentialsPath() {
  return path.join(configHome(), "omamail", "credentials.json")
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8")
  } catch (e) {
    if (e && e.code === "ENOENT") return ""
    throw e
  }
}

function pluginVersion() {
  try {
    const manifest = JSON.parse(readText(path.join(ROOT, "manifest.json")))
    return String(manifest.version || Cli.VERSION_FALLBACK)
  } catch (e) {
    return Cli.VERSION_FALLBACK
  }
}

function which(name) {
  const result = spawnSync("sh", ["-c", 'command -v "$1"', "sh", String(name || "")], {
    encoding: "utf8"
  })
  return result.status === 0 ? String(result.stdout || "").trim() : ""
}

function heyPath() {
  const found = which("hey")
  if (found) return found
  const local = path.join(os.homedir(), ".local", "bin", "hey")
  try {
    fs.accessSync(local, fs.constants.X_OK)
    return local
  } catch (e) {
    return ""
  }
}

function fail(parsed, error, exit) {
  const flags = parsed && parsed.flags ? parsed.flags : Cli.emptyFlags()
  const text = View.formatError(error, flags.json, flags.pretty, Cli.exitCodeName(exit))
  if (flags.json) process.stdout.write(text + "\n")
  else process.stderr.write(text + "\n")
  process.exit(exit)
}

function succeed(text) {
  if (text !== "") process.stdout.write(text.charAt(text.length - 1) === "\n" ? text : text + "\n")
  process.exit(Cli.EXIT_OK)
}

function resultExit(result, fallback) {
  if (result && Number(result.exit) > 0) return Math.floor(Number(result.exit))
  const error = String(result && result.error || "")
  if (/not signed in|sign in again|not authenticated|authentication failed|invalid credentials|unauthorized/i.test(error))
    return Cli.EXIT_AUTH
  return fallback || Cli.EXIT_ERROR
}

function helpFor(parsed) {
  const topic = parsed.group === "help" ? parsed.verb : parsed.group
  if (parsed.group === "message" && parsed.verb && parsed.verb !== "message")
    return Cli.commandHelp(parsed.verb)
  return Cli.commandHelp(topic)
}

function secretLookup(attributes) {
  if (!Array.isArray(attributes) || attributes.length === 0) return ""
  if (!which("secret-tool")) return ""
  const result = spawnSync("secret-tool", ["lookup"].concat(attributes), {
    encoding: "utf8"
  })
  if (result.status !== 0) return ""
  return Secrets.fromKeyring(result.stdout || "")
}

function gmailRefreshToken(clientId, accountId) {
  const stages = [0, 1, 3]
  for (let i = 0; i < stages.length; i++) {
    const token = secretLookup(Credentials.refreshTokenAttributes(clientId, accountId, stages[i]))
    if (token) return token
  }
  return ""
}

function curlConfig(lines) {
  if (!which("curl")) {
    return { error: "curl is not on PATH", status: 0, body: "" }
  }
  const result = spawnSync("curl", ["--fail-early", "--config", "-", "--silent", "--show-error", "-m", String(REQUEST_TIMEOUT_SEC)], {
    input: lines.join("\n") + "\n",
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  })
  const stderr = String(result.stderr || "")
  if (result.error && result.status === null)
    return { error: "Could not start curl", status: 0, body: "" }
  return {
    error: result.status === 0 ? "" : (stderr.trim() || "curl failed"),
    status: result.status,
    body: String(result.stdout || ""),
    stderr: stderr
  }
}

function escapeCurl(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"")
}

function gmailHttp(method, url, token, body, retried) {
  const lines = [
    'url = "' + escapeCurl(url) + '"',
    'noproxy = "*"',
    "request = " + String(method || "GET"),
    'header = "Authorization: Bearer ' + escapeCurl(token) + '"',
    'header = "Accept: application/json"',
    "write-out = \"\\n%{http_code}\""
  ]
  if (body !== undefined && body !== null) {
    lines.push('header = "Content-Type: application/json"')
    lines.push("data = \"" + escapeCurl(JSON.stringify(body)) + "\"")
  }
  const answer = curlConfig(lines)
  if (answer.error && !answer.body)
    return { ok: false, status: 0, payload: null, error: "Could not reach Gmail. Check the network connection" }
  const raw = answer.body
  const split = raw.lastIndexOf("\n")
  const text = split < 0 ? raw : raw.substring(0, split)
  const status = Math.floor(Number(split < 0 ? 0 : raw.substring(split + 1)))
  const payload = Api.parseJson(text, null)
  if (status === 401 && retried !== true)
    return { ok: false, status: 401, payload: payload, error: "unauthorized" }
  const ok = status >= 200 && status < 300
  const error = ok ? "" : Api.responseError(status, payload, "Gmail could not complete this request")
  return { ok: ok, status: status, payload: payload, error: error }
}

function refreshAccessToken(credentials, refreshToken) {
  const body = OAuth.formBody({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken
  })
  const lines = [
    'url = "' + escapeCurl(OAuth.TOKEN_URL) + '"',
    'noproxy = "*"',
    "request = POST",
    'header = "Content-Type: application/x-www-form-urlencoded"',
    "data = \"" + escapeCurl(body) + "\"",
    "write-out = \"\\n%{http_code}\""
  ]
  const answer = curlConfig(lines)
  const raw = answer.body || ""
  const split = raw.lastIndexOf("\n")
  const text = split < 0 ? raw : raw.substring(0, split)
  const status = Math.floor(Number(split < 0 ? 0 : raw.substring(split + 1)))
  const parsed = OAuth.parseTokenResponse(status, text, refreshToken)
  if (!parsed.ok) return { ok: false, error: parsed.error || "Google rejected the saved session. Sign in again" }
  return { ok: true, accessToken: parsed.accessToken }
}

function loadAccounts() {
  return Accounts.load(readText(accountsPath()))
}

function loadAccount(parsed) {
  const selected = Cli.selectAccount(loadAccounts(), parsed.flags.account)
  if (!selected.ok) fail(parsed, selected.error, selected.exit)
  return selected.account
}

function gmailSession(account) {
  const credentials = Credentials.effective(readText(credentialsPath()), account.id)
  if (!Credentials.isConfigured(credentials)) {
    return { ok: false, error: "This Gmail mailbox has no OAuth client. Open Omamail and finish setup" }
  }
  const refresh = gmailRefreshToken(credentials.clientId, account.id)
  if (!refresh) {
    return { ok: false, exit: Cli.EXIT_AUTH,
      error: "Not signed in. Open Omamail and sign in to this mailbox" }
  }
  const token = refreshAccessToken(credentials, refresh)
  if (!token.ok) return token
  return { ok: true, accessToken: token.accessToken, credentials: credentials }
}

function gmailCall(session, method, apiPath, query, body) {
  let url = Api.safeApiUrl(apiPath)
  if (!url) return { ok: false, error: "Something went wrong while contacting Gmail" }
  url = Api.appendQuery(url, query)
  let answer = gmailHttp(method, url, session.accessToken, body, false)
  if (answer.status === 401) {
    const refreshed = refreshAccessToken(session.credentials,
      gmailRefreshToken(session.credentials.clientId, session.accountId || ""))
    if (!refreshed.ok) return refreshed
    session.accessToken = refreshed.accessToken
    answer = gmailHttp(method, url, session.accessToken, body, true)
  }
  if (!answer.ok) return { ok: false, status: answer.status, error: answer.error }
  return { ok: true, payload: answer.payload }
}

function summarizeAll(messages) {
  const now = Date.now()
  const rows = []
  const list = Array.isArray(messages) ? messages : []
  for (let i = 0; i < list.length; i++) {
    if (list[i]) rows.push(Mail.summarize(list[i], now))
  }
  return rows
}

function gmailGetMessages(session, ids, full) {
  const list = Array.isArray(ids) ? ids : []
  const results = new Array(list.length)
  let firstError = ""
  let firstStatus = 0
  const query = full ? Api.fullQuery() : Api.metadataQuery()
  for (let i = 0; i < list.length; i++) {
    const answer = gmailCall(session, "GET", Api.messagePath(list[i]), query, null)
    if (!answer.ok) {
      if (!firstError) firstError = answer.error
      if (!firstStatus) firstStatus = answer.status
      continue
    }
    results[i] = answer.payload
  }
  const ordered = []
  for (let j = 0; j < results.length; j++) {
    if (results[j]) ordered.push(results[j])
  }
  if (firstError) return { ok: false, error: firstError, messages: ordered,
    exit: firstStatus === 404 ? Cli.EXIT_NOT_FOUND : Cli.EXIT_ERROR }
  return { ok: true, messages: ordered }
}

function imapPassword(accountId) {
  return secretLookup(Credentials.imapKeyringAttributes(accountId))
}

function imapCredentials(account) {
  const password = imapPassword(account.id)
  if (!password) return { ok: false, exit: Cli.EXIT_AUTH,
    error: "Not signed in. Open Omamail and add this IMAP mailbox again" }
  const settings = Imap.normalizeSettings(account.imap)
  const username = settings.username || account.email
  if (!username) return { ok: false, error: "This mailbox has no username" }
  return { ok: true, settings: settings, credentials: username + ":" + password }
}

function encodeField(value) {
  return Mail.encodeBase64(String(value || ""))
}

function runImap(settings, credentials, folder, commands) {
  const transport = path.join(ROOT, "scripts", "mail-transport.sh")
  const url = Imap.imapUrl(settings, folder)
  if (url === "") return { ok: false, error: "This mailbox has no usable server address" }
  const list = Array.isArray(commands) ? commands : [commands]
  const wanted = []
  for (let i = 0; i < list.length; i++) {
    if (String(list[i] || "") !== "") wanted.push(String(list[i]))
  }
  if (wanted.length === 0) return { ok: true, text: "" }
  const fields = [encodeField(url), encodeField(credentials)]
  for (let j = 0; j < wanted.length; j++) fields.push(encodeField(wanted[j]))
  const result = spawnSync("sh", [transport], {
    input: "imap " + fields.join(" ") + "\n",
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  })
  const lines = String(result.stdout || "").split("\n")
  if (result.status === null || result.status !== 0 || lines.length < 3
      || !/^\d+$/.test(lines[0]))
    return { ok: false, error: "Could not start the mail transport" }
  const status = Math.floor(Number(lines[0]))
  const out = lines.length > 1 ? lines[1] : ""
  const err = lines.length > 2 ? lines[2] : ""
  const text = Imap.decodeResponse(out, Mail.base64ToBytes, Mail.bytesToLatin1)
  const detail = Imap.decodeResponse(err, Mail.base64ToBytes, Mail.bytesToLatin1)
  if (!isFinite(status) || status !== 0)
    return { ok: false, error: Imap.responseError(status, detail, "") }
  if (Imap.isFailure(text))
    return { ok: false, error: Imap.responseError(0, Imap.failureDetail(text), "") }
  return { ok: true, text: text }
}

function runSmtp(settings, credentials, from, message, recipients) {
  const transport = path.join(ROOT, "scripts", "mail-transport.sh")
  const smtp = Imap.smtpUrl(settings)
  if (smtp === "")
    return { ok: false, error: "This mailbox has no SMTP server set, so it cannot send" }
  const fields = [encodeField(smtp), encodeField(credentials), encodeField(from), encodeField(message)]
  for (let i = 0; i < recipients.length; i++) fields.push(encodeField(recipients[i]))
  const result = spawnSync("sh", [transport], {
    input: "smtp " + fields.join(" ") + "\n",
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  })
  const lines = String(result.stdout || "").split("\n")
  if (result.status === null || result.status !== 0 || lines.length < 3
      || !/^\d+$/.test(lines[0]))
    return { ok: false, error: "Could not start the mail transport" }
  const status = Math.floor(Number(lines[0]))
  const err = lines.length > 2 ? lines[2] : ""
  const detail = Imap.decodeResponse(err, Mail.base64ToBytes, Mail.bytesToLatin1)
  if (!isFinite(status) || status !== 0)
    return { ok: false, error: Imap.responseError(status, detail, "Could not send") }
  return { ok: true }
}

function imapServer(account) {
  const creds = imapCredentials(account)
  if (!creds.ok) return creds
  const listed = runImap(creds.settings, creds.credentials, "",
    [Imap.capabilityCommand(), Imap.listCommand()])
  if (!listed.ok) return listed
  return {
    ok: true,
    settings: creds.settings,
    credentials: creds.credentials,
    folders: Imap.parseList(listed.text),
    special: Imap.specialFolders(Imap.parseList(listed.text)),
    capabilities: Imap.parseCapabilities(listed.text)
  }
}

function imapToMessage(entry, folder, special, full) {
  const payload = Mail.parseRfc822(entry.raw)
  return {
    id: Imap.messageId(entry.uid, folder),
    threadId: Imap.messageId(entry.uid, folder),
    labelIds: Imap.labelIdsFor(entry.flags, folder, special),
    internalDate: entry.internalDate,
    sizeEstimate: entry.size,
    payload: payload,
    snippet: full ? Mail.buildSnippet(Mail.extractBody(payload).text) : ""
  }
}

function heyToMessage(id, row, body) {
  const known = row || {}
  const headers = []
  const from = known.from || { name: "", email: "" }
  if (from.name !== "" || from.email !== "")
    headers.push({ name: "From", value: Mail.addressHeader(from.email, from.name) })
  const recipientHeaders = [{ name: "To", values: known.to },
    { name: "Cc", values: known.cc }, { name: "Bcc", values: known.bcc }]
  for (let i = 0; i < recipientHeaders.length; i++) {
    const recipients = Array.isArray(recipientHeaders[i].values) ? recipientHeaders[i].values : []
    const addressed = []
    for (let j = 0; j < recipients.length; j++)
      addressed.push(Mail.addressHeader(recipients[j].email, recipients[j].name))
    if (addressed.length > 0)
      headers.push({ name: recipientHeaders[i].name, value: addressed.join(", ") })
  }
  if (String(known.subject || "") !== "")
    headers.push({ name: "Subject", value: String(known.subject) })
  if (String(known.date || "") !== "")
    headers.push({ name: "Date", value: String(known.date) })
  const html = body ? String(body.html || "") : ""
  const text = body ? String(body.text || "") : ""
  const payload = {
    mimeType: html !== "" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
    headers: headers,
    body: {
      size: html !== "" ? html.length : text.length,
      data: Mail.encodeBase64Url(html !== "" ? html : text)
    },
    parts: []
  }
  const labels = []
  if (!known.seen) labels.push("UNREAD")
  if (String(known.box || "") === "imbox") labels.push("INBOX")
  if (known.isDraft === true) labels.push("DRAFT")
  const date = String(known.date || "")
  const stamp = date === "" ? 0 : Date.parse(date)
  return {
    id: String(id || ""),
    threadId: known.isDraft === true ? "" : Hey.topicIdOf(id),
    labelIds: labels,
    internalDate: isFinite(stamp) && stamp > 0 ? String(stamp) : "",
    sizeEstimate: payload.body.size,
    payload: payload,
    snippet: String(known.snippet || "")
  }
}

function runHey(args, stdin) {
  const program = heyPath()
  if (program === "")
    return { ok: false, error: "Install the HEY CLI. omarchy-mise-install github:basecamp/hey-cli hey" }
  const result = spawnSync(program, args, {
    input: stdin === undefined || stdin === null ? "" : String(stdin),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  })
  const text = String(result.stdout || "")
  const flag = Hey.unknownFlag(String(result.stderr || "") + text)
  if (flag && Hey.isDroppableFlag(flag))
    return runHey(Hey.withoutFlag(args, flag), stdin)
  const answer = Hey.payload(text)
  if (result.status !== 0 && !answer.ok)
    return { ok: false, error: Hey.commandError(result.status, text, result.stderr, "HEY could not complete this request") }
  if (!answer.ok) return { ok: false, error: answer.error || "HEY could not complete this request" }
  return { ok: true, text: text, data: answer.data, payload: answer }
}

function providerQuery(account, flags, verb) {
  const mailbox = flags.mailbox || Cli.defaultMailbox(account.provider)
  if (verb === "search" || flags.query)
    return { mailbox: mailbox, query: Registry.query(account.provider, mailbox, flags.query, "") }
  return { mailbox: mailbox, query: Registry.query(account.provider, mailbox, "", "") }
}

function refuseAction(parsed, account, verb) {
  const action = Cli.actionFor(verb)
  const needs = Model.actionCapability(action)
  if (needs !== "" && !Registry.can(account.provider, needs)) {
    fail(parsed, Model.actionUnavailable(action, Registry.badge(account.provider)), Cli.EXIT_UNAVAILABLE)
  }
  if (action === "" && verb !== "list" && verb !== "read" && verb !== "send"
      && verb !== "reply" && verb !== "forward") {
    fail(parsed, "Unknown action", Cli.EXIT_USAGE)
  }
}

function readBody(parsed) {
  const flags = parsed.flags
  let fileText
  if (flags.bodyFile) {
    try {
      fileText = fs.readFileSync(flags.bodyFile, "utf8")
    } catch (e) {
      fail(parsed, "Could not read " + flags.bodyFile, Cli.EXIT_ERROR)
    }
  }
  let stdinText = ""
  const shouldReadStdin = flags.stdin || (!process.stdin.isTTY
    && flags.body === "" && !flags.bodyFile
    && Cli.needsBody(parsed.group, parsed.verb))
  if (shouldReadStdin) {
    try {
      stdinText = fs.readFileSync(0, "utf8")
    } catch (e) {
      stdinText = ""
    }
  }
  const chosen = Cli.chooseBody(flags, shouldReadStdin ? stdinText : "", fileText)
  if (!chosen.ok) fail(parsed, chosen.error, Cli.EXIT_ERROR)
  return chosen.body
}

function listGmail(session, query, flags) {
  const listed = gmailCall(session, "GET", Api.messagesPath(),
    Api.listQuery(query, flags.limit, flags.pageToken), null)
  if (!listed.ok) return listed
  const page = Api.parseMessageList(listed.payload)
  const fetched = gmailGetMessages(session, page.ids, false)
  if (!fetched.ok) return fetched
  return {
    ok: true,
    messages: summarizeAll(fetched.messages),
    nextPageToken: page.nextPageToken,
    estimate: page.estimate
  }
}

function readGmail(session, id) {
  const fetched = gmailGetMessages(session, [id], true)
  if (!fetched.ok) return fetched
  if (fetched.messages.length === 0)
    return { ok: false, exit: Cli.EXIT_NOT_FOUND,
      error: "That message is no longer in the mailbox" }
  return { ok: true, message: fetched.messages[0] }
}

function sendGmail(session, fields) {
  const payload = Mail.buildSendPayload(fields)
  const sent = gmailCall(session, "POST", Api.sendPath(), null, Api.sendBody(payload))
  if (!sent.ok) return sent
  return { ok: true, id: String(sent.payload && sent.payload.id || ""), threadId: String(sent.payload && sent.payload.threadId || "") }
}

function actGmail(session, ids, verb) {
  const action = Cli.actionFor(verb)
  for (let i = 0; i < ids.length; i++) {
    let answer
    if (action === "trash")
      answer = gmailCall(session, "POST", Api.trashPath(ids[i]), null, null)
    else {
      const change = Model.labelChangesFor(action)
      if (!change) return { ok: false, error: "Unknown action" }
      answer = gmailCall(session, "POST", Api.modifyPath(ids[i]), null, {
        addLabelIds: change.add,
        removeLabelIds: change.remove
      })
    }
    if (!answer.ok) return answer
  }
  return { ok: true }
}

function listImap(server, query, flags) {
  const parsed = Imap.parseQuery(query)
  const folder = Imap.resolveFolder(parsed.folder, server.special)
  const criteria = Imap.normalizeCriteria(parsed.criteria)
  const offset = Math.max(0, Math.floor(Number(flags.pageToken) || 0))
  const snapshot = runImap(server.settings, server.credentials, folder, [Imap.uidListCommand()])
  if (!snapshot.ok) return snapshot
  const uids = Imap.parseUidList(snapshot.text)
  let matched = uids
  if (criteria !== "") {
    const commands = Imap.searchCommands(criteria, uids)
    if (commands.length === 0) matched = []
    else {
      const searched = runImap(server.settings, server.credentials, folder, commands)
      if (!searched.ok) return searched
      matched = Imap.parseSearch(searched.text)
    }
  }
  const page = Imap.searchPage(matched, offset, flags.limit, false)
  const ids = []
  for (let i = 0; i < page.uids.length; i++) ids.push(Imap.messageId(page.uids[i], folder))
  if (ids.length === 0)
    return { ok: true, messages: [], nextPageToken: page.nextOffset, estimate: page.estimate }
  const groups = Imap.groupByFolder(ids)
  const fetched = []
  for (let g = 0; g < groups.length; g++) {
    const command = Imap.summaryFetchCommand(groups[g].uids)
    const answer = runImap(server.settings, server.credentials, groups[g].folder, [command])
    if (!answer.ok) return answer
    const entries = Imap.parseFetch(answer.text)
    for (let e = 0; e < entries.length; e++)
      fetched.push(imapToMessage(entries[e], groups[g].folder, server.special, false))
  }
  const byId = {}
  for (let f = 0; f < fetched.length; f++) byId[fetched[f].id] = fetched[f]
  const ordered = []
  for (let n = 0; n < ids.length; n++) {
    if (byId[ids[n]]) ordered.push(byId[ids[n]])
  }
  return {
    ok: true,
    messages: summarizeAll(ordered),
    nextPageToken: page.nextOffset,
    estimate: page.estimate
  }
}

function readImap(server, id) {
  const parsed = Imap.parseMessageId(id)
  if (parsed.uid < 1 || String(parsed.folder || "").trim() === "")
    return { ok: false, exit: Cli.EXIT_NOT_FOUND, error: "That is not an IMAP message id" }
  const command = Imap.fullFetchCommand([parsed.uid])
  const answer = runImap(server.settings, server.credentials, parsed.folder, [command])
  if (!answer.ok) return answer
  const entries = Imap.parseFetch(answer.text)
  if (entries.length === 0)
    return { ok: false, exit: Cli.EXIT_NOT_FOUND,
      error: "That message is no longer in the mailbox" }
  return { ok: true, message: imapToMessage(entries[0], parsed.folder, server.special, true) }
}

function sendImap(server, fields, accountEmail) {
  const payload = Mail.buildSendPayload(fields)
  const message = Mail.decodeBase64Url(payload.raw)
  const parsed = Mail.parseRfc822(message)
  const recipients = []
  const headerNames = ["To", "Cc", "Bcc"]
  for (let i = 0; i < headerNames.length; i++) {
    const addresses = Mail.parseAddressList(Mail.headerFrom(parsed.headers, headerNames[i]))
    for (let j = 0; j < addresses.length; j++) {
      if (addresses[j].email !== "" && recipients.indexOf(addresses[j].email) < 0)
        recipients.push(addresses[j].email)
    }
  }
  if (recipients.length === 0) return { ok: false, error: "Add a recipient first" }
  const fromAddresses = Mail.parseAddressList(Mail.headerFrom(parsed.headers, "From"))
  const sender = (fromAddresses.length > 0 && fromAddresses[0].email)
    ? fromAddresses[0].email
    : (server.settings.username || accountEmail)
  const sent = runSmtp(server.settings, server.credentials, sender, message, recipients)
  if (!sent.ok) return sent
  return { ok: true, id: "", threadId: "" }
}

function actImap(server, ids, verb) {
  if (!Imap.validMessageIds(ids))
    return { ok: false, exit: Cli.EXIT_USAGE,
      error: "Every message must have an IMAP id such as 42:INBOX" }
  const action = Cli.actionFor(verb)
  let plan
  if (action === "trash") {
    const trash = server.special["\\trash"] || ""
    if (trash === "")
      return { ok: false, error: "This server has no Trash folder to move the message to" }
    plan = { add: [], remove: [], move: trash }
  } else {
    const change = Model.labelChangesFor(action)
    if (!change) {
      plan = Imap.actionPlan(action, server.special)
    } else {
      plan = Imap.flagPlanForLabels(change.add, change.remove, server.special)
    }
  }
  if (!plan) return { ok: false, error: "Unknown action" }
  if (action === "archive" && !plan.move)
    return { ok: false, error: "This server has no Archive folder to move the message to" }
  const groups = Imap.groupByFolder(ids)
  for (let g = 0; g < groups.length; g++) {
    let commands = Imap.storeCommand(groups[g].uids, plan.add, plan.remove)
    if (typeof commands === "string") commands = commands === "" ? [] : [commands]
    if (!Array.isArray(commands)) commands = []
    if (plan.move !== "" && plan.move !== groups[g].folder) {
      if (Imap.hasCapability(server.capabilities, "MOVE")) {
        commands = commands.concat([Imap.moveCommand(groups[g].uids, plan.move)])
      } else {
        commands = commands.concat([
          Imap.copyCommand(groups[g].uids, plan.move),
          "UID STORE " + Imap.sequenceSet(groups[g].uids) + " +FLAGS.SILENT (\\Deleted)",
          Imap.expungeCommand(groups[g].uids)
        ])
      }
    }
    if (commands.length === 0) continue
    const answer = runImap(server.settings, server.credentials, groups[g].folder, commands)
    if (!answer.ok) return answer
  }
  return { ok: true }
}

function listHey(query, flags) {
  const parsed = Hey.parseQuery(query)
  const command = Hey.listCommand(parsed, flags.limit, flags.pageToken)
  const answer = runHey(command, "")
  if (!answer.ok) return answer
  const found = parsed.kind === "drafts"
    ? Hey.parseDraftListing(answer.data)
    : Hey.filterRows(parsed, Hey.parseListing(answer.data))
  const pageData = parsed.kind === "drafts"
    ? { next_page: Hey.envelopeNextPage(answer.text) } : answer.data
  const page = Hey.pageOf(parsed, pageData, found, flags.limit, flags.pageToken)
  const messages = []
  for (let i = 0; i < page.rows.length; i++)
    messages.push(Mail.summarize(heyToMessage(page.rows[i].id, page.rows[i], null), Date.now()))
  return {
    ok: true,
    messages: messages,
    nextPageToken: page.nextPageToken,
    estimate: page.total
  }
}

function readHey(id) {
  const draftId = Hey.draftIdOf(id)
  const command = draftId !== "" ? Hey.draftShowCommand(id) : Hey.threadCommand(id)
  if (command.length === 0)
    return { ok: false, exit: Cli.EXIT_NOT_FOUND, error: "That is not a HEY message id" }
  const answer = runHey(command, "")
  if (!answer.ok) return answer
  if (draftId !== "") {
    const draft = Hey.parseDraft(answer.data)
    if (draft.id === "") return { ok: false, exit: Cli.EXIT_NOT_FOUND,
      error: "That draft is no longer in the mailbox" }
    return { ok: true, message: heyToMessage(id, draft, { text: draft.body, html: "" }) }
  }
  const body = Hey.parseThread(answer.text)
  if (body.error) return { ok: false, error: body.error }
  const row = { id: id, subject: "", from: { name: "", email: "" }, to: [], snippet: "", seen: true, box: "" }
  return { ok: true, message: heyToMessage(id, row, body) }
}

function sendHey(fields, threadId) {
  const command = Hey.composeCommand({
    threadId: threadId || "",
    to: fields.to,
    cc: fields.cc,
    bcc: fields.bcc,
    subject: fields.subject
  })
  if (command.length === 0) return { ok: false, error: "Add a recipient first" }
  const answer = runHey(command, fields.body)
  if (!answer.ok) return answer
  return { ok: true, id: "", threadId: String(threadId || "") }
}

function actHey(ids, verb) {
  const command = Hey.actionCommand(Cli.actionFor(verb), ids)
  if (command.length === 0)
    return { ok: false, error: "HEY cannot honour that action" }
  return runHey(command, "")
}

function listMessages(parsed, account) {
  const flags = parsed.flags
  const resolved = providerQuery(account, flags, parsed.verb)
  let result
  if (account.provider === "gmail") {
    const session = gmailSession(account)
    if (!session.ok) return session
    session.accountId = account.id
    result = listGmail(session, resolved.query, flags)
  } else if (account.provider === "imap") {
    const server = imapServer(account)
    if (!server.ok) return server
    result = listImap(server, resolved.query, flags)
  } else if (account.provider === "hey") {
    result = listHey(resolved.query, flags)
  } else {
    return { ok: false, error: "Unknown provider" }
  }
  if (!result.ok) return result
  result.mailbox = resolved.mailbox
  result.query = resolved.query
  return result
}

function readMessage(parsed, account, id) {
  let result
  if (account.provider === "gmail") {
    const session = gmailSession(account)
    if (!session.ok) return session
    session.accountId = account.id
    result = readGmail(session, id)
  } else if (account.provider === "imap") {
    if (!Imap.validMessageIds([id]))
      return { ok: false, exit: Cli.EXIT_NOT_FOUND, error: "That is not an IMAP message id" }
    const server = imapServer(account)
    if (!server.ok) return server
    result = readImap(server, id)
  } else {
    result = readHey(id)
  }
  if (!result.ok) return result
  const summary = Mail.summarize(result.message, Date.now())
  const body = Mail.extractBody(result.message.payload)
  return { ok: true, summary: summary, body: body.text, message: result.message }
}

function sendMessage(parsed, account, fields) {
  if (account.provider === "gmail") {
    const session = gmailSession(account)
    if (!session.ok) return session
    session.accountId = account.id
    if (fields.from && fields.from !== account.email) {
      const aliases = gmailCall(session, "GET", Api.sendAsPath(), null, null)
      if (aliases.ok && !Api.isSendAsAllowed(Api.parseSendAs(aliases.payload), fields.from))
        return { ok: false, error: "Choose a valid From address" }
    }
    return sendGmail(session, Object.assign({ from: fields.from || account.email }, fields))
  }
  if (account.provider === "imap") {
    if (fields.from && !Api.isSendAsAllowed(
      Aliases.sendAsList(account.email, account.imap && account.imap.aliases), fields.from))
      return { ok: false, error: "Choose a valid From address" }
    const server = imapServer(account)
    if (!server.ok) return server
    return sendImap(server, Object.assign({ from: fields.from || account.email }, fields), account.email)
  }
  return sendHey(fields, fields.threadId || "")
}

function actMessages(parsed, account, verb, ids) {
  refuseAction(parsed, account, verb)
  if (account.provider === "imap" && !Imap.validMessageIds(ids))
    return { ok: false, exit: Cli.EXIT_USAGE,
      error: "Every message must have an IMAP id such as 42:INBOX" }
  if (account.provider === "gmail") {
    const session = gmailSession(account)
    if (!session.ok) return session
    session.accountId = account.id
    return actGmail(session, ids, verb)
  }
  if (account.provider === "imap") {
    const server = imapServer(account)
    if (!server.ok) return server
    return actImap(server, ids, verb)
  }
  return actHey(ids, verb)
}

function unreadCount(account) {
  if (account.provider === "gmail") {
    const session = gmailSession(account)
    if (!session.ok) return session
    session.accountId = account.id
    const listed = gmailCall(session, "GET", Api.messagesPath(),
      Api.listQuery(Registry.unreadQuery("gmail"), 1, ""), null)
    if (!listed.ok) return listed
    return { ok: true, unread: Api.parseMessageList(listed.payload).estimate }
  }
  if (account.provider === "imap") {
    const server = imapServer(account)
    if (!server.ok) return server
    const inbox = Imap.resolveFolder("INBOX", server.special)
    const answer = runImap(server.settings, server.credentials, "", [Imap.statusCommand(inbox)])
    if (!answer.ok) return answer
    return { ok: true, unread: Imap.parseStatus(answer.text).unseen }
  }
  const listed = listHey(Registry.unreadQuery("hey"), { limit: Hey.UNSEEN_SCAN || 100, pageToken: "" })
  if (!listed.ok) return listed
  let unread = 0
  for (let i = 0; i < listed.messages.length; i++) {
    if (listed.messages[i].unread) unread++
  }
  return { ok: true, unread: unread }
}

function listMailboxes(account) {
  if (account.provider !== "imap")
    return { ok: true, mailboxes: Registry.mailboxes(account.provider) }
  const server = imapServer(account)
  if (!server.ok) return server
  const boxes = Registry.mailboxes("imap").slice()
  const known = {}
  for (let i = 0; i < boxes.length; i++) known[boxes[i].key] = true
  const folders = Array.isArray(server.folders) ? server.folders : []
  for (let j = 0; j < folders.length; j++) {
    const folder = folders[j]
    if (!folder || folder.selectable === false) continue
    const key = String(folder.name || "")
    if (key === "" || known[key]) continue
    boxes.push({ key: key, label: key, query: Registry.labelQuery("imap", key) })
  }
  return { ok: true, mailboxes: boxes }
}

function composeAndSend(parsed, account, extra) {
  const body = readBody(parsed)
  const fields = Object.assign(Cli.sendFields(parsed.flags, body), extra || {})
  if (Cli.trimmed(fields.to) === "" && parsed.verb === "send")
    fail(parsed, "Pass --to with at least one address", Cli.EXIT_USAGE)
  if (Cli.trimmed(fields.body) === "" && parsed.verb === "send")
    fail(parsed, "Write something before sending", Cli.EXIT_USAGE)
  const sent = sendMessage(parsed, account, fields)
  if (!sent.ok) fail(parsed, sent.error, resultExit(sent, Cli.EXIT_ERROR))
  succeed(View.formatSend(sent, parsed.flags.json, parsed.flags.pretty, account))
}

function replyTo(parsed, account) {
  const id = parsed.flags.ids[0]
  const opened = readMessage(parsed, account, id)
  if (!opened.ok) fail(parsed, opened.error, resultExit(opened, Cli.EXIT_ERROR))
  const body = readBody(parsed)
  if (Cli.trimmed(body) === "")
    fail(parsed, "Write something before sending", Cli.EXIT_USAGE)
  const summary = opened.summary
  const addresses = Cli.replyAddresses(summary, account.email, parsed.flags.all)
  let text = body
  if (parsed.flags.quote)
    text = body + (body && !/\n$/.test(body) ? "\n" : "") + "\n" + Mail.quoteBody(summary, opened.body)
  const fields = {
    from: parsed.flags.from || account.email,
    to: addresses.to,
    cc: addresses.cc,
    subject: Mail.replySubject(summary.subject),
    body: text,
    threadId: summary.threadId,
    inReplyTo: summary.messageId,
    references: summary.messageId
  }
  if (account.provider === "hey")
    fields.threadId = Hey.topicIdOf(id) || summary.threadId
  const sent = sendMessage(parsed, account, fields)
  if (!sent.ok) fail(parsed, sent.error, resultExit(sent, Cli.EXIT_ERROR))
  succeed(View.formatSend(sent, parsed.flags.json, parsed.flags.pretty, account))
}

function forwardMessage(parsed, account) {
  const id = parsed.flags.ids[0]
  const opened = readMessage(parsed, account, id)
  if (!opened.ok) fail(parsed, opened.error, resultExit(opened, Cli.EXIT_ERROR))
  const extra = readBody(parsed)
  const quoted = Mail.quoteBody(opened.summary, opened.body)
  const fields = Cli.sendFields(parsed.flags, extra ? extra + "\n\n" + quoted : quoted)
  fields.from = parsed.flags.from || account.email
  fields.subject = fields.subject || Cli.forwardSubject(opened.summary.subject)
  const sent = sendMessage(parsed, account, fields)
  if (!sent.ok) fail(parsed, sent.error, resultExit(sent, Cli.EXIT_ERROR))
  succeed(View.formatSend(sent, parsed.flags.json, parsed.flags.pretty, account))
}

function main(argv) {
  const parsed = Cli.validateCommand(Cli.parseArgv(argv, process.env))
  if (!parsed.ok) fail(parsed, parsed.error, parsed.exit || Cli.EXIT_USAGE)

  if (parsed.group === "version")
    succeed(Cli.versionText(pluginVersion()))
  if (parsed.group === "help")
    succeed(helpFor(parsed))

  if (parsed.group === "account") {
    const list = loadAccounts()
    const selected = Cli.selectAccount(list, "")
    const accounts = selected.ok ? selected.accounts : []
    succeed(View.formatAccounts(accounts, list.activeId, parsed.flags.json, parsed.flags.pretty))
  }

  const account = loadAccount(parsed)

  if (parsed.group === "mailbox") {
    const boxes = listMailboxes(account)
    if (!boxes.ok) fail(parsed, boxes.error, resultExit(boxes, Cli.EXIT_ERROR))
    succeed(View.formatMailboxes(boxes.mailboxes, parsed.flags.json, parsed.flags.pretty, account))
  }

  if (parsed.group === "status") {
    const count = unreadCount(account)
    if (!count.ok) fail(parsed, count.error, resultExit(count, Cli.EXIT_ERROR))
    succeed(View.formatStatus({
      account: account,
      unread: count.unread,
      mailbox: "inbox"
    }, parsed.flags.json, parsed.flags.pretty))
  }

  if (parsed.group === "search" || (parsed.group === "message" && parsed.verb === "list")) {
    const listed = listMessages(parsed, account)
    if (!listed.ok) fail(parsed, listed.error, resultExit(listed, Cli.EXIT_ERROR))
    succeed(View.formatList(listed.messages, listed, parsed.flags.json, parsed.flags.pretty, account))
  }

  if (parsed.group === "message" && parsed.verb === "read") {
    const opened = readMessage(parsed, account, parsed.flags.ids[0])
    if (!opened.ok) fail(parsed, opened.error, resultExit(opened, Cli.EXIT_ERROR))
    succeed(View.formatRead(opened.summary, opened.body, parsed.flags.json, parsed.flags.pretty, account))
  }

  if (parsed.group === "message" && parsed.verb === "send")
    composeAndSend(parsed, account, { from: parsed.flags.from || account.email })
  if (parsed.group === "message" && parsed.verb === "reply")
    replyTo(parsed, account)
  if (parsed.group === "message" && parsed.verb === "forward")
    forwardMessage(parsed, account)

  if (parsed.group === "message") {
    const ids = parsed.flags.ids
    const acted = actMessages(parsed, account, parsed.verb, ids)
    if (!acted.ok) fail(parsed, acted.error, resultExit(acted, Cli.EXIT_ERROR))
    succeed(View.formatAction(parsed.verb, ids, parsed.flags.json, parsed.flags.pretty, account))
  }

  fail(parsed, "Unknown command", Cli.EXIT_USAGE)
}

module.exports = { main }

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    const message = e && e.message ? e.message : String(e)
    process.stderr.write("omamail: " + OAuth.redact(message) + "\n")
    process.exit(Cli.EXIT_ERROR)
  }
}
