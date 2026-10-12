import QtQuick 2.15
import QtTest 1.3
import "transports.js" as Transports
import "BackendFixture.js" as BackendFixture
import "NativeIntentFixture.js" as NativeIntentFixture
import "ModelFixture.js" as NativeModel
import "../../providers/ExchangeCredentials.js" as ExchangeCredentials

// The stand-in the Exchange tests share: the real service, window, account,
// auth object and client, with a keyring and an Exchange server that are
// scripted here so that nothing touches a network, a keyring or the disk.
//
// The keyring is the backend's `credentials.*` answers, kept in `entries`; a
// write waits for `release()` while `hold` is set, a `locked` one cannot be read
// and `failDeletes` refuses to remove anything. The server is what the
// account's client sends its `exchange.*` requests to, and it behaves as the
// backend does: a request made while the keyring has no item is answered
// `auth_signed_out`. `script[method]` overrides an answer with a function of the
// request returning `{ result }` or `{ error: code }`.
TestCase {
  id: root
  when: windowShown

  required property var service
  required property var app
  property var fixture: null
  property var keyring: null
  property var server: null
  property int saves: 0

  readonly property string accountId: "exchange:jane@corp.example.test"
  readonly property string ewsUrl: "https://corp.example.test/EWS/Exchange.asmx"
  readonly property string secret: "Zx9-synthetic-passw0rd"
  readonly property var checked: ({
    ok: true, email: "jane@corp.example.test", scheme: "ntlm", serverVersion: "15.0.1497.2",
    roles: { inbox: { total: 4, unread: 2 }, sent: { total: 1, unread: 0 },
      drafts: { total: 0, unread: 0 }, trash: { total: 0, unread: 0 }, junk: null },
    refusals: {}
  })

  function named(item, objectName) {
    if (!item) return null
    if (item.objectName === objectName) return item
    var values = item.children || []
    for (var i = 0; i < values.length; i++) {
      var found = named(values[i], objectName)
      if (found) return found
    }
    return null
  }

  function initTestCase() {
    // The native ledger and the merged list answer as they do in the real window.
    NativeIntentFixture.install(service)
    NativeModel.install(service)
    fixture = BackendFixture.markReady(service, 9)
  }

  function init() {
    app.opened = true
    service.accountList = ({ version: 1, accounts: [], activeId: "" })
    wait(0)
    keyring = ({ entries: ({}), hold: false, pending: [], puts: [], deletes: [], failWrites: false,
      locked: false, failDeletes: false })
    server = ({ calls: [], script: ({}), flagged: 0 })
    fixture.requests = []
    fixture.answers = {
      "credentials.get": function(params, request) {
        if (keyring.locked) return refuse(request)
        var value = keyring.entries[params.accountId]
        return value === undefined ? { found: false } : { found: true, secret: value }
      },
      "credentials.put": function(params, request) {
        keyring.puts.push(params)
        if (keyring.hold) { keyring.pending.push(request); return undefined }
        settle(request)
        return undefined
      },
      "credentials.delete": function(params, request) {
        keyring.deletes.push(params.accountId)
        if (keyring.failDeletes) return refuse(request)
        delete keyring.entries[params.accountId]
        return { deleted: true }
      },
      "exchange.invalidate": { invalidated: true },
      "accounts.save": function() { return { revision: String(++saves) } },
      "mail.unwatch": {}
    }
  }

  function cleanup() {
    server.closed = true
    service.accountList = ({ version: 1, accounts: [], activeId: "" })
    // A removal writes the shorter list, and the write guard remembers it; the
    // next test sets its list directly, which the guard would read as a drop.
    service.lastPersistedIds = []
    service.accountsReleasedIds = []
    // The keyring state that outlives hosts outlives a test too.
    ExchangeCredentials.reset()
    wait(0)
    service.recount()
    BackendFixture.markReady(service, 9)
    service.backend.pending = ({})
  }

  // The keyring's answer when it cannot do what was asked.
  function refuse(request) {
    BackendFixture.respond(service, request, undefined, { code: -32000, message: "credential_store_unavailable" })
    return undefined
  }

  function settle(request) {
    if (keyring.failWrites) {
      BackendFixture.respond(service, request, undefined, { code: -32000, message: "credential_store_unavailable" })
      return
    }
    keyring.entries[request.params.accountId] = request.params.secret
    BackendFixture.respond(service, request, { stored: true })
  }

  // The oldest write that is waiting is answered, and the keyring has it.
  function release() {
    var request = keyring.pending.shift()
    verify(request, "a write is waiting to be answered")
    settle(request)
  }

  // What the Exchange server says to a request the account's client sends.
  function serve(request) {
    var method = request.method
    var asked = request.params
    if (server.script[method]) {
      var said = server.script[method](request)
      if (said) return said
    }
    if (method === "exchange.verify" && asked.settings !== undefined) return { result: checked }
    if (method === "exchange.invalidate" || method === "exchange.cancel") return { result: {} }
    if (keyring.entries[asked.accountId] === undefined) return { error: "auth_signed_out" }
    if (method === "exchange.verify") return { result: checked }
    if (method === "exchange.list") {
      var flagged = asked.query === "role:inbox flagged"
      return { result: { page: { ids: [], threadIds: [], nextPageToken: "",
        estimate: flagged ? server.flagged : 0 }, rows: [], warning: null } }
    }
    if (method === "exchange.messages") return { result: { messages: [], warning: null, continuation: null } }
    if (method === "exchange.send") return { result: { sent: true, warning: "" } }
    return { result: { succeededIds: asked.ids || [], failedIds: [], error: null } }
  }

  // The recorder the account's client sends to, answering by `serve`.
  function install(account) {
    account.api.backend = {
      ready: true,
      testCalls: server.calls,
      call: function(method, params, callback) {
        var request = { method: method, params: params, callback: callback, answered: false }
        server.calls.push(request)
        Qt.callLater(function() {
          // A mailbox the test has torn down is answered by nobody.
          if (server.closed) return
          var answer = root.serve(request)
          if (request.answered) return
          Transports.reply(request, answer.error ? null : answer.result,
            answer.error ? { code: -32000, message: answer.error } : "")
        })
        return server.calls.length
      }
    }
  }

  // The requests of a kind the account's client sent, newest last.
  function sent(method) {
    return server.calls.filter(function(request) { return request.method === method })
  }

  // First run, the way a person meets it: the chooser, then the Exchange page,
  // then the form filled in. Hands back the account, the sign-in not pressed.
  function openForm() {
    service.accountsLoaded = true
    service.accountList = ({ version: 1, accounts: [{ id: "", email: "", provider: "gmail",
      clientId: "", clientSecret: "", pending: true }], activeId: "" })
    tryCompare(service, "accountCount", 1)
    tryVerify(function() { return service.current !== null }, 1000)
    wait(0)
    tryCompare(app, "anyReady", false)
    app.resetNavigation()
    waitForRendering(app)
    var loader = named(app, "setup-page")
    verify(loader && !!loader.item && typeof loader.item.chosen === "function", "first run opens the chooser")
    loader.item.chosen("exchange")
    waitForRendering(app)
    var account = service.current
    tryCompare(account, "providerId", "exchange")
    tryVerify(function() { return !!account.auth && !!account.api }, 1000)
    install(account)
    named(app, "exchange-address-field").text = "jane@corp.example.test"
    named(app, "exchange-server-field").text = ewsUrl
    named(app, "exchange-username-field").text = "CORP\\jane"
    named(app, "exchange-secret-field").text = secret
    return account
  }

  function page() { return named(app, "setup-page").item }

  // Presses the button and waits for the sign-in check.
  function pressSignIn(account) {
    var checks = sent("exchange.verify").length
    page().submit()
    tryVerify(function() { return sent("exchange.verify").length === checks + 1 }, 1000, "the check is sent")
  }

  // A mailbox the way a restart finds it: in the list with its server, and
  // nothing known yet of its password. `others` are more rows before it.
  function entryFor(address, patch) {
    return Object.assign({ id: "exchange:" + address, email: address, provider: "exchange", clientId: "",
      clientSecret: "", exchange: { ewsUrl: ewsUrl, username: "CORP\\" + address.split("@")[0], authScheme: "auto" },
      label: "", signature: "" }, patch || {})
  }

  function seed(patch, others) {
    var rows = (others || []).concat([entryFor("jane@corp.example.test", patch)])
    service.accountsLoaded = true
    service.accountList = ({ version: 1, activeId: rows[rows.length - 1].id, accounts: rows })
    service.refreshCurrent()
    tryVerify(function() { return service.current !== null && !!service.current.auth && !!service.current.api }, 2000)
    install(service.current)
    return service.current
  }

  // The mailbox signed in through the form, its keyring answering at once.
  function signedIn() {
    var account = openForm()
    pressSignIn(account)
    tryVerify(function() { return account.ready }, 2000)
    tryVerify(function() { return sent("exchange.list").length > 0 }, 2000, "the mailbox is read")
    return account
  }

  // The mailbox's setup page, the way settings opens it.
  function openEditor(index) {
    var row = index === undefined ? 0 : index
    service.activeIndex = row
    app.openSettings()
    app.editAccount(row)
    waitForRendering(app)
    compare(app.page, "setup")
    return page()
  }

  // The confirmation the window asks before it removes a mailbox: the one holding a request, since the window
  // has other questions of the same shape (the calendar editor's, before it sends to guests).
  function removalDialog() {
    function walk(item) {
      if (!item) return null
      if (typeof item.openFor === "function" && !!item.request && item.opened !== undefined) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var found = walk(values[i])
        if (found) return found
      }
      return null
    }
    return walk(app)
  }
}
