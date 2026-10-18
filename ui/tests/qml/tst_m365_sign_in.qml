import QtQuick 2.15
import QtTest 1.3
import "../../" as Omamail
import "BackendFixture.js" as BackendFixture
import "NativeIntentFixture.js" as NativeIntentFixture
import "../../account/Accounts.js" as Accounts
import "../../message/Message.js" as Message

// A Microsoft 365 mailbox from the first run to a window with mail in it, through
// the real objects on purpose: the setup page, the service's account list, the
// account, its auth object and its client. Each can be right while the value goes
// nowhere. The backend is the fixture of `BackendFixture.js`: the requests the
// mailbox makes are written to its pipe and answered here by hand, so the code, its
// waits, its refusals and the first reads are the test's to give and nothing
// touches Microsoft, the keyring or the disk.
Item {
  width: 900
  height: 600

  QtObject {
    id: fakeShell
    function hide(_id) {}
  }

  Omamail.Service {
    id: mailService
    shell: fakeShell
    manifest: ({ id: "omamail", __sourceDir: "/tmp/omamail-test" })
  }

  Omamail.App {
    id: app
    service: mailService
    shell: fakeShell
  }

  TestCase {
    name: "M365SignIn"
    when: windowShown

    property var fixture: null
    // How many requests the shell had written when the test began, so a test
    // reads its own and not those of the tests before it.
    property int mark: 0
    property var opened: []

    readonly property var plainAnswers: ({
      "credentials.get": { found: false },
      "credentials.put": { stored: true },
      "credentials.delete": { deleted: true }
    })

    readonly property string accountId: "m365:jane@corp.example.test"
    readonly property string address: "jane@corp.example.test"
    readonly property string client: "11111111-2222-3333-4444-555555555555"
    readonly property string page: "https://microsoft.com/devicelogin"

    // What the check says for a mailbox with every folder but a Junk one.
    readonly property var checked: ({
      ok: true, email: "jane@corp.example.test", displayName: "", scheme: "oauth", serverVersion: "",
      roles: { inbox: { total: 4, unread: 2 }, sent: { total: 1, unread: 0 }, drafts: { total: 0, unread: 0 },
        trash: { total: 0, unread: 0 }, junk: null, archive: { total: 9, unread: 0 } },
      refusals: {}, learned: {}
    })

    function initTestCase() {
      fixture = BackendFixture.markReady(mailService, 8)
      fixture.answers = plainAnswers
      NativeIntentFixture.install(mailService)
      mailService.platform = { openExternal: function(url) { opened = opened.concat([url]); return true } }
    }

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

    // Every item of the name, in the order they are drawn.
    function namedAll(item, objectName, found) {
      found = found || []
      if (!item) return found
      if (item.objectName === objectName) found.push(item)
      var values = item.children || []
      for (var i = 0; i < values.length; i++) namedAll(values[i], objectName, found)
      return found
    }

    function init() {
      mark = fixture.requests.length
      opened = []
      app.opened = true
      mailService.accountList = ({ version: 1, accounts: [], activeId: "" })
      wait(0)
    }

    function cleanup() {
      mailService.accountList = ({ version: 1, accounts: [], activeId: "" })
      wait(0)
      mailService.recount()
      BackendFixture.markReady(mailService, 8)
      fixture.answers = plainAnswers
      mailService.backend.pending = ({})
    }

    // ---------------------------------------------------- the scripted backend

    function asked(method) {
      return fixture.requests.slice(mark).filter(function(item) { return item.method === method })
    }

    function waiting(method, query) {
      return asked(method).filter(function(item) { return !item.answeredHere
        && (query === undefined || item.params.query === query) })
    }

    function reply(request, result) { BackendFixture.respond(mailService, request, result) }

    function refuse(request, code) {
      BackendFixture.respond(mailService, request, null, { code: -32000, message: code })
    }

    // The restore every account is owed when it is built, answered "nothing saved".
    function answerRestore() {
      tryVerify(function() { return waiting("m365.verify").length >= 1 }, 2000, "the restore is asked")
      waiting("m365.verify").forEach(function(item) { item.answeredHere = true; refuse(item, "m365_signed_out") })
    }

    function answerList(request, ids, estimate) {
      request.answeredHere = true
      reply(request, { page: { ids: ids, threadIds: [], nextPageToken: "", estimate: estimate }, rows: [], warning: null })
    }

    // Every listing the mailbox asks for is answered with an empty page, until it
    // asks for no more: the first read leads to a second as the counts come in.
    function settleLists() {
      for (var round = 0; round < 12; round++) {
        wait(60)
        var pending = waiting("m365.list")
        if (pending.length === 0) return
        pending.forEach(function(item) { answerList(item, [], 0) })
      }
      fail("the mailbox keeps asking for lists")
    }

    // A keyring that keeps what it is given, and a mailbox the backend polls for.
    function useBackend() {
      fixture.answers = Object.assign({}, plainAnswers, {
        "mail.unwatch": {},
        "mail.watch": function(params) {
          return { accountId: params.accountId, sequence: 1, estimate: 0, messages: [], error: "synthetic" }
        }
      })
    }

    // --------------------------------------------------------------- the window

    // First run, the way a person meets it: the chooser, then the Microsoft 365
    // page. The sign-in is not yet pressed; `typed` says what was filled in.
    function showChooser() {
      mailService.accountsLoaded = true
      mailService.accountList = ({ version: 1, accounts: [{ id: "", email: "", provider: "gmail", clientId: "",
        clientSecret: "", pending: true }], activeId: "" })
      tryCompare(mailService, "accountCount", 1)
      tryVerify(function() { return mailService.current !== null }, 1000)
      wait(0)
      tryCompare(app, "anyReady", false)
      app.resetNavigation()
      waitForRendering(app)
      var loader = named(app, "setup-page")
      verify(!!loader.item && typeof loader.item.chosen === "function", "first run opens on the chooser")
      return loader
    }

    function openForm(typed) {
      var loader = showChooser()
      loader.item.chosen("m365")
      waitForRendering(app)
      compare(loader.kind, "m365", "choosing Microsoft 365 opens its page")
      var account = mailService.current
      tryCompare(account, "providerId", "m365")
      tryVerify(function() { return !!account.auth && !!account.api }, 1000)
      if (typed !== false) {
        named(app, "m365-address-field").text = address
        named(app, "m365-client-id-field").text = client
      }
      return account
    }

    function pressSignIn(account) {
      named(app, "setup-page").item.signIn()
      tryCompare(account, "accountId", accountId)
      tryVerify(function() { return asked("m365.signInBegin").length === 1 }, 2000, "sign-in asks for a code")
      return asked("m365.signInBegin")[0]
    }

    function begin(overrides) {
      return Object.assign({ requestId: "req-1", userCode: "ABCD1234E", verificationUri: page,
        expiresIn: 900, interval: 5 }, overrides || {})
    }

    function polled(count) {
      tryVerify(function() { return asked("m365.signInPoll").length >= count }, 2000, "poll number " + count)
    }

    // One sign-in, answered, and the mailbox begun on: what the tests below start from.
    function signedInMailbox(verdict) {
      useBackend()
      var account = openForm()
      var begun = pressSignIn(account)
      account.auth.timeScale = 0.01
      answerRestore()
      reply(begun, begin())
      polled(1)
      reply(asked("m365.signInPoll")[0], { state: "signedIn" })
      tryVerify(function() { return asked("m365.verify").length === 2 }, 2000, "the mailbox is checked")
      reply(asked("m365.verify")[1], verdict || checked)
      tryVerify(function() { return account.ready }, 2000, "the mailbox is ready")
      tryVerify(function() { return asked("m365.list").length >= 2 }, 2000, "the mailbox is read")
      return account
    }

    // A mailbox saved before, as a restart finds it.
    function savedMailbox() {
      var list = Accounts.add(Accounts.emptyList(), { email: address, provider: "m365", clientId: client })
      mailService.activeIndex = -1
      mailService.accountList = Accounts.setActive(list, accountId)
      mailService.accountsLoaded = true
      mailService.refreshCurrent()
      tryVerify(function() { return mailService.current !== null && !!mailService.current.auth && !!mailService.current.api }, 2000)
      tryVerify(function() { return asked("m365.verify").length === 1 }, 2000, "the saved sign-in is checked")
      compare(asked("m365.verify")[0].params, { accountId: accountId })
      return mailService.current
    }

    // ------------------------------------------------------------- the sign-in

    function test_the_page_asks_for_an_address_and_an_application_id_and_says_what_it_does() {
      openForm(false)
      verify(named(app, "m365-address-field").visible)
      verify(named(app, "m365-client-id-field").visible, "there is no built-in registration, so it is asked for")
      verify(named(app, "m365-sign-in").visible)
      compare(named(app, "m365-secret-field"), null, "and no password anywhere")
      compare(named(app, "m365-sign-in").enabled, false, "nothing to press before both are filled")
      var asks = named(app, "m365-asks").text
      verify(asks.indexOf("read and write mail, send mail, read and write your calendar") >= 0, asks)
      verify(asks.indexOf("one sign-in") >= 0 && asks.indexOf("no second code") >= 0, asks)
      compare(named(app, "m365-code-card").visible, false, "no hint about the browser's account before a code is out")
      var steps = namedAll(app, "m365-step").map(function(item) { return item.text })
      compare(steps.length, 4, "the registration is a list of four steps")
      for (var n = 0; n < steps.length; n++) verify(steps[n].indexOf((n + 1) + ". ") === 0, steps[n])
      var help = steps.join(" ")
      for (var word of ["your organization's directory", "no redirect URI", "Allow public client flows", "Mail.ReadWrite",
        "Mail.Send", "Calendars.ReadWrite", "openid", "profile", "email", "offline_access", "Application (client) ID",
        "Overview page into the field above"])
        verify(help.indexOf(word) >= 0, "the registration steps name " + word + ": " + help)
      verify(asks.indexOf("nothing else") < 0, "the sign-in asks for more than mail and calendar: " + asks)
      verify(named(app, "m365-admin-note").text.indexOf("administrator has to approve") >= 0)
      named(app, "m365-address-field").text = address
      named(app, "m365-client-id-field").text = client
      compare(named(app, "m365-sign-in").enabled, true)
    }

    function test_the_chooser_says_in_one_line_when_this_is_the_mailbox_to_choose() {
      var found = []
      function walk(item) {
        if (!item) return
        if (typeof item.text === "string" && item.text.indexOf("no IMAP needed") >= 0) found.push(item)
        var values = item.children || []
        for (var i = 0; i < values.length; i++) walk(values[i])
      }
      walk(showChooser().item)
      compare(found.length, 1, "the Microsoft 365 card says it needs no IMAP")
      compare(found[0].lineCount, 1, "in one line: " + found[0].text)
    }

    function test_an_application_id_typed_in_capitals_is_saved_and_sent_in_lower_case() {
      useBackend()
      var account = openForm(false)
      named(app, "m365-address-field").text = address
      named(app, "m365-client-id-field").text = "ABCDEF11-2222-3333-4444-55555555555F"
      var begun = pressSignIn(account)
      compare(begun.params.clientId, "abcdef11-2222-3333-4444-55555555555f")
      compare(mailService.accountList.accounts[0].clientId, "abcdef11-2222-3333-4444-55555555555f")
    }

    function test_what_cannot_be_an_address_or_an_id_is_refused_before_anything_is_saved() {
      var account = openForm(false)
      var cases = [["", client, "Add your work email address"], ["jane", client, "That is not a full email address"],
        [address, "", "Add the Application (client) ID from Microsoft Entra"],
        [address, "not-a-guid", "That is not a Microsoft Application (client) ID"]]
      for (var i = 0; i < cases.length; i++) {
        named(app, "m365-address-field").text = cases[i][0]
        named(app, "m365-client-id-field").text = cases[i][1]
        named(app, "setup-page").item.signIn()
        compare(named(app, "m365-error").text, cases[i][2])
        compare(mailService.accountList.accounts[0].email, "", "nothing was written")
        compare(asked("m365.signInBegin").length, 0)
      }
    }

    function test_the_whole_route_from_the_chooser_to_a_window_with_mail_in_it() {
      useBackend()
      var account = openForm()
      var begun = pressSignIn(account)
      compare(begun.params, { accountId: accountId, address: address, clientId: client }, "no tenant, no secret")
      var entry = mailService.accountList.accounts[0]
      compare(entry.provider, "m365")
      compare(entry.id, accountId, "the row is the mailbox, not a new one")
      compare(entry.email, address)
      compare(entry.clientId, client, "the application's name, which is no secret")
      compare(entry.clientSecret, "")
      var text = JSON.stringify(mailService.accountList)
      verify(text.indexOf("token") < 0 && text.indexOf("ABCD1234E") < 0, "nothing that could sign anyone in is saved: " + text)
      compare(named(app, "m365-progress").text, "Asking Microsoft for a code")
      account.auth.timeScale = 0.01
      answerRestore()
      compare(account.auth.lastError, "", "the restore owed at the moment the address was saved is quiet")

      reply(begun, begin())
      tryVerify(function() { return named(app, "m365-code-card").visible }, 2000, "the code card appears")
      compare(named(app, "m365-code").text, "ABCD1234E")
      compare(named(app, "m365-link").text, page, "and the address, to be copied into a private window")
      compare(opened, [page], "the page is opened once")
      compare(named(app, "m365-progress").text, "Waiting for you to finish on the Microsoft page")
      polled(1)
      reply(asked("m365.signInPoll")[0], { state: "pending" })
      polled(2)
      compare(asked("m365.verify").length, 1, "only the restore so far: a code not entered proves nothing")
      reply(asked("m365.signInPoll")[1], { state: "signedIn" })
      tryVerify(function() { return asked("m365.verify").length === 2 }, 2000)
      compare(named(app, "m365-code-card").visible, false, "the used code is gone")
      compare(named(app, "m365-progress").text, "Signed in on Microsoft's side. Checking the mailbox")
      compare(account.ready, false, "not signed in until the mailbox has answered")
      compare(asked("m365.list").length, 0, "and nothing is read before")
      reply(asked("m365.verify")[1], checked)

      tryVerify(function() { return account.ready }, 2000, "the mailbox is ready without a restart")
      tryCompare(app, "anyReady", true)
      verify(app.page !== "setup" && app.page !== "picker", "the window leaves setup for the mailbox")
      // The first read: the inbox and the unread count, by role, after the check.
      tryVerify(function() { return asked("m365.list").length >= 2 }, 2000, "reading the mailbox begins")
      var queries = asked("m365.list").map(function(item) { return item.params.query })
      for (var wanted of ["role:inbox", "role:inbox unseen"])
        verify(queries.indexOf(wanted) >= 0, wanted + " is asked for: " + queries)
      verify(fixture.requests.indexOf(asked("m365.list")[0]) > fixture.requests.indexOf(asked("m365.verify")[1]),
        "the first read comes after the check that proves the mailbox")
      for (var listed of asked("m365.list")) compare(listed.params.accountId, accountId)
      var keys = account.mailboxes.map(function(box) { return box.key })
      verify(keys.indexOf("archive") >= 0, "Archive is a row: the mailbox has one")
      compare(keys.indexOf("spam"), -1, "a missing Junk folder leaves no row with nothing behind it")
      compare(account.canArchive && account.canStar && account.canSend, true)
    }

    function test_the_signed_in_page_says_who_and_offers_sign_out() {
      signedInMailbox()
      mailService.activeIndex = 0
      app.openSettings()
      app.editAccount(0)
      waitForRendering(app)
      compare(app.page, "setup")
      compare(named(app, "m365-signed-in").text, "Signed in · " + address)
      compare(named(app, "m365-sign-in").visible, false)
      compare(named(app, "m365-address-field").visible, false)
      compare(named(app, "m365-client-id-field").visible, false)
      verify(named(app, "m365-sign-out").visible)
    }

    // -------------------------------------------------------------------- failures

    function test_a_sign_in_that_ends_says_so_in_the_errors_place_and_can_be_tried_again() {
      useBackend()
      var cases = [[{ state: "declined" }, "The sign-in was declined on the Microsoft page. Press Sign in to try again"],
        [{ state: "failed", error: "m365_consent_required" }, "administrator has to approve this app"],
        [{ state: "failed", error: "m365_wrong_account", signedInAs: "ada@other.example.org" }, "ada@other.example.org"]]
      for (var i = 0; i < cases.length; i++) {
        init()
        var account = openForm()
        var begun = pressSignIn(account)
        account.auth.timeScale = 0.01
        answerRestore()
        reply(begun, begin())
        polled(1)
        reply(asked("m365.signInPoll")[0], cases[i][0])
        tryVerify(function() { return !account.auth.loginBusy }, 2000)
        verify(named(app, "m365-error").visible)
        verify(named(app, "m365-error").text.indexOf(cases[i][1]) >= 0, named(app, "m365-error").text)
        compare(named(app, "m365-code-card").visible, false)
        compare(account.ready, false)
        compare(named(app, "m365-sign-in").enabled, true, "the way to try again is there")
        compare(asked("m365.verify").length + asked("m365.signOut").length, 1, "only the restore: nothing checked, nothing removed")
        if (i === 0) {
          named(app, "m365-sign-in").clicked()
          tryVerify(function() { return asked("m365.signInBegin").length === 2 }, 2000)
          compare(named(app, "m365-error").text, "", "and the old sentence is gone")
        }
        cleanup()
      }
    }

    function test_cancel_stops_the_poll_and_the_page_goes_back_to_the_form() {
      useBackend()
      var account = openForm()
      var begun = pressSignIn(account)
      account.auth.timeScale = 0.01
      answerRestore()
      reply(begun, begin())
      polled(1)
      named(app, "m365-cancel-sign-in").clicked()
      tryVerify(function() { return !account.auth.loginBusy }, 2000)
      compare(named(app, "m365-code-card").visible, false)
      compare(named(app, "m365-error").text, "", "a cancel is not a failure")
      compare(named(app, "m365-sign-in").enabled, true)
      reply(asked("m365.signInPoll")[0], { state: "signedIn" })
      wait(150)
      compare(asked("m365.verify").length, 1, "the code that was cancelled is not proved")
      compare(asked("m365.signInPoll").length, 1, "and nothing asks again")
    }

    function test_a_backend_not_up_yet_keeps_sign_in_off_and_says_why() {
      openForm()
      mailService.backend.protocolInfo = null
      waitForRendering(app)
      verify(named(app, "m365-backend-note").visible)
      compare(named(app, "m365-backend-note").text, "Waiting for the mail backend to start. Sign in is available once it has.")
      compare(named(app, "m365-sign-in").enabled, false)
      compare(asked("m365.signInBegin").length, 0)
    }

    function test_an_old_backend_is_told_so_and_sent_nothing() {
      mailService.backend.protocolInfo = { apiVersion: 7, protocol: 1, version: "0.0.0" }
      openForm()
      verify(named(app, "m365-backend-note").visible)
      compare(named(app, "m365-backend-note").text, "Update the mail backend first: this version cannot talk to Microsoft 365.")
      compare(named(app, "m365-sign-in").enabled, false)
      compare(asked("m365.signInBegin").length + asked("m365.verify").length, 0)
    }

    // --------------------------------------------------------------------- restart

    function test_a_saved_mailbox_restores_with_one_check_and_no_code() {
      useBackend()
      var account = savedMailbox()
      compare(account.setupState, "reconnecting", "and the window says so rather than 'signed out'")
      compare(account.ready, false)
      reply(asked("m365.verify")[0], checked)
      tryVerify(function() { return account.ready }, 2000)
      compare(opened.length + asked("m365.signInBegin").length, 0, "no browser and no code for a restore")
      tryVerify(function() { return asked("m365.list").length >= 1 }, 2000, "and the mailbox is read")
    }

    function test_a_saved_mailbox_with_no_sign_in_left_asks_for_one_and_says_nothing_wrong() {
      var account = savedMailbox()
      refuse(asked("m365.verify")[0], "m365_signed_out")
      tryCompare(account, "setupState", "signed_out")
      compare(account.lastError, "", "a mailbox that was signed out is not an error to report")
      compare(asked("m365.signInBegin").length, 0, "no code until it is pressed")
      compare(account.setupHeadline, "Sign in to Microsoft 365")
      compare(account.setupActionLabel, "Sign in to Microsoft 365...")
    }

    // ----------------------------------------------------------- sign out, remove

    function test_signing_out_removes_the_saved_sign_in_and_the_window_shows_it_signed_out() {
      var account = signedInMailbox()
      mailService.signOut()
      tryVerify(function() { return asked("m365.signOut").length === 1 }, 2000)
      compare(asked("m365.signOut")[0].params, { accountId: accountId, clientId: client })
      compare(account.auth.loggedIn, false)
      compare(account.ready, false)
      compare(account.messages.length, 0, "no mail of a signed-out mailbox stays on screen")
      tryVerify(function() { return asked("m365.invalidate").length === 1 }, 2000, "the backend forgets what it held")
      compare(asked("m365.invalidate")[0].params, { accountId: accountId })
    }

    function test_removing_the_mailbox_deletes_its_sign_in_only_once_the_removal_is_confirmed() {
      signedInMailbox()
      settleLists()
      mailService.accountList = Accounts.add(mailService.accountList, { email: "bob@example.test", provider: "gmail" })
      tryCompare(mailService, "accountCount", 2)
      // The list was rebuilt around the new row, and the mailbox restores its sign-in.
      tryVerify(function() { return asked("m365.verify").length === 3 }, 2000)
      reply(asked("m365.verify")[2], checked)
      tryCompare(mailService.findAccount(accountId).auth, "loggedIn", true)
      mailService.activeIndex = 0
      app.openSettings()
      app.editAccount(0)
      waitForRendering(app)
      var remove = named(app, "m365-remove")
      tryCompare(remove, "visible", true, 1000, "offered beside another mailbox")
      remove.clicked()
      var dialog = removalDialog(app)
      verify(dialog && dialog.request !== null, "the window's removal dialog is asked")
      compare(dialog.request.id, accountId, "for this mailbox, not the one beside it")
      // Cancelled: nothing is sent and the mailbox stays as it was.
      dialog.close()
      tryVerify(function() { return dialog.request === null }, 1000)
      wait(50)
      compare(asked("m365.signOut").length, 0, "a removal that was not confirmed removes no sign-in")
      compare(mailService.findAccount(accountId).auth.loggedIn, true, "and the mailbox stays signed in")
      compare(mailService.accountList.accounts.filter(function(entry) { return entry.id === accountId }).length, 1)
      // Confirmed: the saved sign-in goes with the entry.
      remove.clicked()
      dialog = removalDialog(app)
      app.confirmAccountRemoval(dialog.request)
      tryVerify(function() { return asked("m365.signOut").length === 1 }, 2000, "its sign-in is deleted")
      compare(asked("m365.signOut")[0].params, { accountId: accountId, clientId: client })
      compare(mailService.accountList.accounts.filter(function(entry) { return entry.id === accountId }).length, 1,
        "the account stays until its saved sign-in was removed")
      reply(asked("m365.signOut")[0], { signedOut: true })
      tryVerify(function() { return mailService.accountList.accounts.filter(function(entry) { return entry.id === accountId }).length === 0 }, 2000)
    }

    function mailboxForRemoval(ready) {
      mailService.backend.connected = ready
      var list = Accounts.add(Accounts.emptyList(), { email: address, provider: "m365", clientId: client })
      list = Accounts.add(list, { email: "bob@example.test", provider: "gmail" })
      mailService.accountList = Accounts.setActive(list, accountId)
      mailService.accountsLoaded = true
      mailService.refreshCurrent()
      tryVerify(function() { return mailService.findAccount(accountId) !== null && !!mailService.findAccount(accountId).auth }, 2000)
      var request = Accounts.removalRequest({ accounts: mailService.accountSummaries }, 0)
      compare(request.id, accountId)
      return request
    }

    function test_removal_before_backend_start_keeps_the_account_until_cleanup_can_be_retried() {
      var request = mailboxForRemoval(false)
      compare(mailService.backend.ready, false)
      app.confirmAccountRemoval(request)
      wait(50)
      verify(mailService.findAccount(accountId) !== null, "no destroyed delegate with owed credential deletion")
      verify(mailService.findAccount(accountId).auth.lastError.indexOf("not removed") >= 0)
      compare(asked("m365.signOut").length, 0)
      BackendFixture.markReady(mailService, 8)
      app.confirmAccountRemoval(request)
      tryVerify(function() { return asked("m365.signOut").length === 1 }, 2000)
      verify(mailService.findAccount(accountId) !== null, "still present while keyring cleanup is pending")
      reply(asked("m365.signOut")[0], { signedOut: true })
      tryVerify(function() { return mailService.findAccount(accountId) === null }, 2000)
    }

    function test_failed_removal_keeps_the_account_and_reports_the_keyring_error() {
      var request = mailboxForRemoval(true)
      app.confirmAccountRemoval(request)
      tryVerify(function() { return asked("m365.signOut").length === 1 }, 2000)
      refuse(asked("m365.signOut")[0], "auth_keyring_failed")
      tryVerify(function() { return mailService.findAccount(accountId).auth.lastError.indexOf("not removed") >= 0 }, 2000)
      verify(mailService.findAccount(accountId).auth.lastError.indexOf("keyring") >= 0)
      compare(mailService.accountCount, 2)
      app.confirmAccountRemoval(request)
      tryVerify(function() { return asked("m365.signOut").length === 2 }, 2000)
      reply(asked("m365.signOut")[1], { signedOut: true })
      tryVerify(function() { return mailService.findAccount(accountId) === null }, 2000)
    }

    function test_late_removal_success_cannot_delete_an_account_replaced_while_waiting() {
      var request = mailboxForRemoval(true)
      app.confirmAccountRemoval(request)
      tryVerify(function() { return asked("m365.signOut").length === 1 }, 2000)
      var replacement = JSON.parse(JSON.stringify(mailService.accountList))
      replacement.accounts[0].clientId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
      mailService.accountList = replacement
      tryCompare(mailService.findAccount(accountId).auth, "clientId", replacement.accounts[0].clientId)
      reply(asked("m365.signOut")[0], { signedOut: true })
      wait(50)
      compare(mailService.accountCount, 2)
      verify(mailService.findAccount(accountId) !== null, "a stale completion cannot remove the replacement")
    }

    function test_late_removal_keeps_newer_navigation_and_its_overlay() {
      var request = mailboxForRemoval(true)
      app.confirmAccountRemoval(request)
      tryVerify(function() { return asked("m365.signOut").length === 1 }, 2000)
      app.openHelp()
      var newerNav = app.nav
      reply(asked("m365.signOut")[0], { signedOut: true })
      tryVerify(function() { return mailService.findAccount(accountId) === null }, 2000)
      compare(app.nav, newerNav, "a delayed removal cannot replace a newer page or overlay")
      compare(app.overlay, "help")
    }

    function test_removal_error_is_visible_after_returning_and_clears_for_retry() {
      var request = mailboxForRemoval(true)
      app.openSettings()
      app.editAccount(0)
      waitForRendering(app)
      app.confirmAccountRemoval(request)
      tryVerify(function() { return asked("m365.signOut").length === 1 }, 2000)
      compare(named(app, "m365-remove").enabled, false)
      compare(named(app, "m365-sign-in").enabled, false)
      compare(named(app, "m365-cancel-sign-in").visible, false)
      verify(named(app, "m365-progress").text.indexOf("Removing") >= 0)
      refuse(asked("m365.signOut")[0], "auth_store_unavailable")
      tryVerify(function() { return named(app, "m365-error").visible }, 2000)
      verify(named(app, "m365-error").text.indexOf("not removed") >= 0)
      verify(named(app, "m365-remove").enabled)
      app.back()
      app.editAccount(0)
      waitForRendering(app)
      verify(named(app, "m365-error").visible, "a recreated form still explains the failed removal")
      verify(named(app, "m365-error").text.indexOf("not removed") >= 0)
      app.confirmAccountRemoval(request)
      tryVerify(function() { return asked("m365.signOut").length === 2 }, 2000)
      compare(named(app, "m365-error").text, "", "a retry clears the previous failure")
      compare(named(app, "m365-remove").enabled, false)
      reply(asked("m365.signOut")[1], { signedOut: true })
      tryVerify(function() { return mailService.findAccount(accountId) === null }, 2000)
    }

    // The one removal dialog that was asked: the window has a few dialogs of this shape.
    function removalDialog(item) {
      var found = []
      function walk(node) {
        if (!node) return
        if (typeof node.openFor === "function" && node.request !== undefined && node.request !== null) found.push(node)
        var values = node.children || []
        for (var i = 0; i < values.length; i++) walk(values[i])
      }
      walk(item)
      return found.length === 1 ? found[0] : null
    }

    function test_a_request_that_finds_the_sign_in_gone_signs_the_window_out() {
      var account = signedInMailbox()
      settleLists()
      tryCompare(account, "countLoading", false)
      account.refreshCounts()
      tryVerify(function() { return waiting("m365.list").length >= 1 }, 2000)
      refuse(waiting("m365.list")[0], "m365_signed_out")
      tryCompare(account.auth, "loggedIn", false)
      compare(account.auth.lastError, "Sign in to Microsoft 365 again")
      tryCompare(account, "setupState", "signed_out")
    }

    // ------------------------------------------------------------- the mailbox's own work

    function inboxRow(id, starred, unread) {
      return ({ id: id, threadId: "", from: { email: "x@corp.example.test", display: "X" }, subject: id,
        snippet: "", time: "", date: "", unread: unread === true, starred: starred, inInbox: true,
        labelIds: ["INBOX"].concat(starred ? ["STARRED"] : []).concat(unread === true ? ["UNREAD"] : []) })
    }

    function withRows(account, rows) {
      settleLists()
      account.messages = rows
      account.listLoaded = true
    }

    // The mailbox's answer to the change asked for, and the account done with it.
    function done(account, method, count, result) {
      reply(asked(method)[count - 1], result)
      tryCompare(account, "pendingAction", "")
    }

    function test_marking_flagging_archiving_and_trashing_ask_for_the_labels_the_mailbox_takes() {
      var account = signedInMailbox()
      withRows(account, [inboxRow("one", false, true), inboxRow("two", true), inboxRow("three", false), inboxRow("four", false)])
      verify(account.act("one", "markRead", false, false))
      tryVerify(function() { return asked("m365.modify").length === 1 }, 2000)
      compare(asked("m365.modify")[0].params, { accountId: accountId, ids: ["one"], addLabelIds: [], removeLabelIds: ["UNREAD"] })
      done(account, "m365.modify", 1, { succeededIds: ["one"], failedIds: [], error: null })
      verify(account.act("three", "star", false, false))
      tryVerify(function() { return asked("m365.modify").length === 2 }, 2000)
      compare(asked("m365.modify")[1].params.addLabelIds, ["STARRED"])
      done(account, "m365.modify", 2, { succeededIds: ["three"], failedIds: [], error: null })
      verify(account.act("four", "archive", false, false))
      tryVerify(function() { return asked("m365.modify").length === 3 }, 2000)
      compare(asked("m365.modify")[2].params, { accountId: accountId, ids: ["four"], addLabelIds: [], removeLabelIds: ["INBOX"] },
        "archive is taking the Inbox label off, which the backend files in Archive")
      verify(account.messages.every(function(row) { return row.id !== "four" }), "and the row leaves the Inbox at once")
      done(account, "m365.modify", 3, { succeededIds: ["four"], failedIds: [], error: null })
      verify(account.act("two", "trash", false, false))
      tryVerify(function() { return asked("m365.trash").length === 1 }, 2000)
      compare(asked("m365.trash")[0].params, { accountId: accountId, ids: ["two"] })
      done(account, "m365.trash", 1, { succeededIds: ["two"], failedIds: [], error: null })
    }

    function test_a_change_the_mailbox_refused_puts_the_row_back_and_says_why() {
      var account = signedInMailbox()
      withRows(account, [inboxRow("one", false), inboxRow("two", false)])
      verify(account.act("one", "archive", false, false))
      tryVerify(function() { return asked("m365.modify").length === 1 }, 2000)
      reply(asked("m365.modify")[0], { succeededIds: [], failedIds: ["one"], error: "m365_throttled" })
      tryCompare(account, "pendingAction", "")
      verify(account.messages.some(function(row) { return row.id === "one" }), "the row is back")
      compare(account.lastError, "Microsoft asked Omamail to slow down. Try again in a moment")
    }

    function test_the_archive_is_read_by_its_role_a_search_by_its_text_and_moving_back_adds_the_inbox() {
      var account = signedInMailbox()
      settleLists()
      account.selectMailbox("archive")
      tryVerify(function() { return waiting("m365.list", "role:archive").length >= 1 }, 2000, "the Archive row opens the folder by its role")
      var row = inboxRow("filed", false)
      row.inInbox = false
      row.labelIds = []
      account.messages = [row]
      account.listLoaded = true
      verify(account.act("filed", "unarchive", false, false))
      tryVerify(function() { return asked("m365.modify").length === 1 }, 2000)
      compare(asked("m365.modify")[0].params.addLabelIds, ["INBOX"], "moving back to the Inbox puts its label on")
      compare(asked("m365.modify")[0].params.removeLabelIds, [])
      account.search("invoice")
      tryVerify(function() { return waiting("m365.list", "text:invoice").length >= 1 }, 2000, "a typed search is the text filter of the mailbox")
    }

    // -------------------------------------------------------------------------- send

    function test_a_message_is_queued_for_the_backend_from_this_mailbox_and_a_draft_is_saved_on_it() {
      var account = signedInMailbox()
      var queued = fixture.requests.filter(function(item) { return item.method === "outbox.enqueue" }).length
      var id = account.send({ to: "friend@example.test", body: "Hello", subject: "Hi" })
      verify(id !== false && id !== "", "a send id, not a refusal: " + id)
      tryVerify(function() { return fixture.requests.filter(function(item) { return item.method === "outbox.enqueue" }).length > queued }, 2000)
      var request = fixture.requests.filter(function(item) { return item.method === "outbox.enqueue" })[queued]
      compare(request.params.provider, "m365", "the backend's outbox delivers it through m365.send")
      compare(request.params.accountId, accountId)
      verify(/(^|\r\n)To: friend@example\.test\r\n/.test(Message.decodeBase64Url(request.params.payload.raw)))
      tryVerify(function() { return account.availableSendAsAliases.length > 0 }, 2000)
      compare(account.availableSendAsAliases.map(function(alias) { return alias.email }), [address], "the sender is the mailbox address")
      compare(asked("m365.sendAs").length, 0, "with no request for it")
      var said = null
      account.saveDraft({ to: "friend@example.test", body: "x" }, function(saved, error) { said = [saved, error] })
      tryVerify(function() { return asked("m365.saveDraft").length === 1 }, 2000, "Save asks the mailbox to keep it")
      var save = asked("m365.saveDraft")[0]
      compare(save.params.accountId, accountId)
      compare(save.params.draftId, "")
      verify(/(^|\r\n)To: friend@example\.test\r\n/.test(Message.decodeBase64Url(save.params.raw)))
      reply(save, { saved: true, warning: "", id: "draft-1" })
      tryVerify(function() { return said !== null }, 2000)
      compare(said[1], "")
      compare(said[0].saved, true)
    }
  }
}
