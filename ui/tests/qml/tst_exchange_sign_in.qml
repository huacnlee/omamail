import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "../../account/Accounts.js" as Accounts
import "BackendFixture.js" as BackendFixture

// Signing in to an Exchange mailbox, through the real window, service, account,
// auth object and client. The password has to reach the server check and the
// keyring and nothing else, and the mailbox is read only once the keyring has it:
// the backend reads the password from there for every request, so a read that
// began first was told there was none and froze the mailbox on a password that
// was right.
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

  ExchangeCase {
    id: t
    name: "ExchangeSignIn"
    service: mailService
    app: app

    function test_a_sign_in_saves_the_settings_and_the_password_goes_only_where_it_must() {
      var account = openForm()
      pressSignIn(account)
      var check = sent("exchange.verify")[0].params
      compare(check.address, "jane@corp.example.test")
      compare(check.secret, secret)
      compare(check.settings, { ewsUrl: ewsUrl, username: "CORP\\jane", authScheme: "auto" })
      tryVerify(function() { return account.ready }, 2000)
      compare(account.auth.loggedIn, true)
      compare(keyring.puts, [{ kind: "exchange-password", accountId: accountId, secret: secret }])

      var entry = mailService.accountList.accounts[0]
      compare(entry.id, accountId)
      compare(entry.provider, "exchange")
      // The method the server signed in with replaces `auto`, so a later
      // connection offered only Basic is refused rather than sent the password.
      tryCompare(mailService.accountList.accounts[0].exchange, "authScheme", "ntlm", 2000)
      compare(mailService.accountList.accounts[0].exchange, { ewsUrl: ewsUrl, username: "CORP\\jane", authScheme: "ntlm" })
      compare(keyring.entries[accountId], secret, "keeping it does not cost the password")
      compare(account.auth.loggedIn, true)
      // accounts.json is world-readable: nothing that could sign anyone in is in the entry.
      verify(JSON.stringify(mailService.accountList).indexOf(secret) < 0)
      tryCompare(app, "anyReady", true)
      verify(app.page !== "setup", "the window leaves the form")
      tryVerify(function() { return sent("exchange.list").length > 0 }, 2000)
      for (var i = 0; i < server.calls.length; i++)
        if (server.calls[i] !== sent("exchange.verify")[0])
          verify(JSON.stringify(server.calls[i].params).indexOf(secret) < 0, server.calls[i].method + " carried the password")
      compare(account.lastError, "")
    }

    // The trigger a real run met: the keyring item was made in the same second as
    // the first listing, and the listing was told there was no password.
    function test_nothing_is_asked_of_the_mailbox_until_the_keyring_has_the_password() {
      keyring.hold = true
      var account = openForm()
      pressSignIn(account)
      tryVerify(function() { return keyring.pending.length === 1 }, 2000, "the password goes to the keyring")
      wait(150)
      compare(sent("exchange.list").length, 0, "no read while the keyring has no password")
      compare(account.auth.loggedIn, false)
      compare(account.ready, false)
      compare(account.auth.loginBusy, true, "the sign-in is still being finished")
      compare(named(app, "exchange-submit").text, "Checking")
      verify(!named(app, "exchange-submit").enabled, "so a second press is not offered")
      page().submit()
      wait(50)
      compare(keyring.puts.length, 1, "and would not write it twice")

      release()
      tryVerify(function() { return account.ready }, 2000)
      tryCompare(account, "listLoaded", true, 2000)
      compare(account.credentialsRejected, false, "nothing read as a refusal")
      compare(account.lastError, "")
      compare(sent("exchange.verify").filter(function(r) { return r.params.settings !== undefined }).length, 1,
        "the server was asked about the password once")
    }

    // The write is a request in the air like any other: a mailbox signed out while
    // it lands must not be left with the password it was asked to forget.
    function test_a_mailbox_signed_out_while_its_password_is_being_saved_keeps_nothing() {
      keyring.hold = true
      var account = openForm()
      pressSignIn(account)
      tryVerify(function() { return keyring.pending.length === 1 }, 2000)
      account.signOut()
      release()
      tryVerify(function() { return keyring.deletes.length >= 2 && keyring.entries[accountId] === undefined }, 2000,
        "what the write made is taken out again")
      compare(account.auth.loggedIn, false)
      compare(account.auth.loginBusy, false)
      wait(100)
      compare(sent("exchange.list").length, 0)
    }

    // Enter in the password field while the keyring is writing the password: the
    // button is off, and the key must not do what the button would not, which
    // here was to take the password being saved away and leave "Checking" up.
    function test_enter_while_the_password_is_being_saved_does_nothing() {
      keyring.hold = true
      var account = openForm()
      pressSignIn(account)
      tryVerify(function() { return keyring.pending.length === 1 }, 2000)
      keyring.deletes = []
      named(app, "exchange-server-field").text = "https://other.example.test/EWS/Exchange.asmx"
      var field = named(app, "exchange-secret-field")
      field.forceActiveFocus()
      tryVerify(function() { return field.activeFocus }, 1000)
      keyClick(Qt.Key_Return)
      wait(50)
      compare(keyring.deletes, [], "the password being saved is not taken away")
      release()
      tryVerify(function() { return account.ready }, 2000)
      compare(account.auth.loginBusy, false)
      compare(keyring.entries[accountId], secret)
    }

    // A sign-in whose password is let go while the keyring writes it keeps
    // nothing, and is over: "Checking" does not stay on the button for ever.
    function test_a_sign_in_whose_password_is_let_go_while_it_is_saved_is_over() {
      keyring.hold = true
      var account = openForm()
      pressSignIn(account)
      tryVerify(function() { return keyring.pending.length === 1 }, 2000)
      account.auth.releaseStored()
      release()
      tryCompare(account.auth, "loginBusy", false, 2000)
      tryVerify(function() { return keyring.entries[accountId] === undefined }, 2000, "what the write made goes again")
      compare(account.auth.loggedIn, false)
      verify(named(app, "exchange-submit").text !== "Checking")
    }

    // A check abandoned because the settings changed under it has no answer to
    // wait for: the sign-in stops, rather than saying "Checking" for ever.
    function test_a_check_abandoned_for_another_server_does_not_leave_the_sign_in_waiting() {
      server.script["exchange.verify"] = function(request) {
        if (request.params.settings === undefined) return undefined
        request.answered = true
        return { result: {} }
      }
      var account = openForm()
      pressSignIn(account)
      compare(account.auth.loginBusy, true)
      mailService.configureAccount(0, { exchange: { ewsUrl: "https://other.example.test/EWS/Exchange.asmx",
        username: "CORP\\jane", authScheme: "auto" } })
      tryCompare(account.auth, "loginBusy", false, 2000)
      compare(account.auth.loggedIn, false)
      compare(keyring.puts.length, 0, "the password went nowhere")
      verify(named(app, "exchange-submit").text !== "Checking")
    }

    function test_a_keyring_that_cannot_be_written_is_not_a_sign_in() {
      keyring.failWrites = true
      var account = openForm()
      pressSignIn(account)
      tryCompare(account.auth, "loginBusy", false, 2000)
      compare(account.auth.loggedIn, false)
      verify(named(app, "exchange-error").text.indexOf("could not be saved to the system keyring") >= 0)
      verify(!named(app, "exchange-signed-in").visible, "and the page does not claim a sign-in")
      wait(100)
      compare(sent("exchange.list").length, 0, "nothing is asked of a mailbox with no password behind it")
      keyring.failWrites = false
      pressSignIn(account)
      tryVerify(function() { return account.ready }, 2000, "once the keyring works the same form signs in")
    }

    function test_a_wrong_password_stores_nothing_and_leaves_the_form_to_correct() {
      server.script["exchange.verify"] = function(request) {
        return request.params.settings !== undefined ? { error: "exchange_unauthorized" } : undefined
      }
      var account = openForm()
      pressSignIn(account)
      tryCompare(account.auth, "loginBusy", false, 2000)
      compare(named(app, "exchange-error").text, "The server rejected that username or password")
      compare(keyring.puts.length, 0)
      compare(account.auth.loggedIn, false)
      compare(account.credentialsRejected, false, "the mailbox is not frozen: nothing was ever accepted")
      compare(named(app, "exchange-address-field").text, "jane@corp.example.test", "the form keeps what was typed")
      verify(mailService.accountList.accounts[0].exchange.ewsUrl === ewsUrl, "and the server is saved to correct")
    }

    // A password pasted with its line breaks signs in without them: the server
    // is asked about, and the keyring keeps, the password and nothing after it.
    function test_a_pasted_password_signs_in_without_its_line_break() {
      var account = openForm()
      named(app, "exchange-secret-field").text = secret + "\r\n\n"
      pressSignIn(account)
      compare(sent("exchange.verify")[0].params.secret, secret)
      tryVerify(function() { return account.ready }, 2000)
      compare(keyring.puts, [{ kind: "exchange-password", accountId: accountId, secret: secret }])
    }

    // Any other control character is refused on the page, before the settings
    // are saved, the keyring is touched or the server is asked anything.
    function test_a_password_with_a_control_character_is_refused_before_anything_is_saved() {
      var account = openForm()
      var before = fixture.requests.length
      var values = ["Zx9\tsynthetic", "Zx9\u0000synthetic", "Zx9\r\nsynthetic", secret + "\u007f\n", secret + "\u0085"]
      for (var i = 0; i < values.length; i++) {
        named(app, "exchange-secret-field").text = values[i]
        page().submit()
        wait(50)
        compare(named(app, "exchange-error").text, "The password contains a control character. Enter it again", JSON.stringify(values[i]))
      }
      compare(sent("exchange.verify").length, 0, "nothing was sent")
      compare(keyring.puts.length, 0)
      compare(fixture.requests.length, before, "nothing was saved or asked of the keyring")
      compare(account.auth.loginBusy, false)
    }

    // Every code the backend can answer a sign-in with has a sentence of its own,
    // and none repeats a server's words: they are Rust's static codes.
    function test_each_failure_of_a_sign_in_is_told_in_its_own_sentence() {
      var cases = {
        exchange_tls_failed: "The server's secure connection could not be verified",
        exchange_network_failed: "The mail server could not be reached",
        exchange_dns_failed: "The server name could not be looked up. Check the address and your network connection",
        exchange_timeout: "The mail server took too long to answer",
        exchange_url_invalid: "The server address is not valid. It should look like https://mail.example.org/EWS/Exchange.asmx",
        exchange_redirect_refused: "The server sent the request somewhere else, which Omamail does not follow. Enter the address it points to",
        exchange_auth_scheme_unsupported: "This server offers no sign-in method that Omamail supports (NTLM or Basic)",
        exchange_auth_failed: "The server's sign-in reply could not be used. A proxy that inspects secure connections can cause this",
        exchange_access_denied: "The server refused access to this mailbox or message. Ask your administrator if it keeps happening",
        exchange_folder_unavailable: "A folder this needs was not found on the server",
        backend_needs_update: "Update the mail backend to use this mailbox",
        something_new: "The mail server could not complete this request"
      }
      var account = openForm()
      for (var code in cases) {
        server.script["exchange.verify"] = function(request) {
          return request.params.settings !== undefined ? { error: code } : undefined
        }
        pressSignIn(account)
        tryCompare(account.auth, "loginBusy", false, 2000)
        compare(named(app, "exchange-error").text, cases[code], code)
        compare(keyring.puts.length, 0)
      }
    }

    function test_the_page_refuses_what_the_backend_would_before_anything_is_saved() {
      var account = openForm()
      var field = named(app, "exchange-server-field")
      var cases = [
        ["http://corp.example.test/EWS/Exchange.asmx", "The server address must start with https://"],
        ["https://corp.example.test/owa", "The server address must end in /EWS/Exchange.asmx"],
        ["https://good@evil.example/EWS/Exchange.asmx", "That is not a valid server address. It should look like https://mail.example.org/EWS/Exchange.asmx"]
      ]
      for (var i = 0; i < cases.length; i++) {
        field.text = cases[i][0]
        page().submit()
        compare(named(app, "exchange-error").text, cases[i][1])
      }
      field.text = ewsUrl
      named(app, "exchange-address-field").text = "not an address"
      page().submit()
      compare(named(app, "exchange-error").text, "That is not a full email address")
      compare(sent("exchange.verify").length, 0, "nothing was sent")
      compare(keyring.puts.length, 0)
    }

    // Whatever answers at a guessed address would be sent an NTLM response, so
    // the server is typed and the field only shows an example.
    function test_the_server_is_typed_and_never_filled_in_from_the_address() {
      openForm()
      var field = named(app, "exchange-server-field")
      field.text = ""
      named(app, "exchange-address-field").text = "jane@elsewhere.example.test"
      compare(field.text, "", "nothing is guessed from the address's domain")
      verify(field.placeholderText.indexOf("https://mail.example.org/EWS/Exchange.asmx") >= 0)
    }

    // A backend from before the Exchange methods is sent nothing: the page says
    // to update it, and Sign in waits. So does a backend not started yet.
    function test_a_backend_without_exchange_is_told_to_update_and_sent_nothing() {
      BackendFixture.markReady(mailService, 7)
      var account = openForm()
      var note = named(app, "exchange-backend")
      verify(note.visible)
      compare(note.text, "Update the mail backend to sign in: the one installed has no Exchange support")
      verify(!named(app, "exchange-submit").enabled)
      var before = fixture.requests.length
      page().submit()
      wait(100)
      compare(sent("exchange.verify").length, 0)
      compare(fixture.requests.length, before, "nothing was saved or asked of the keyring")

      mailService.backend.connected = false
      compare(note.text, "Waiting for the mail backend to start")
      verify(!named(app, "exchange-submit").enabled)

      BackendFixture.markReady(mailService, 8)
      verify(!note.visible)
      verify(named(app, "exchange-submit").enabled)
    }

    function test_the_page_is_honest_about_what_it_does_with_the_password() {
      openForm()
      var words = []
      function collect(item) {
        if (item.text !== undefined) words.push(String(item.text))
        for (var i = 0; i < (item.children || []).length; i++) collect(item.children[i])
      }
      collect(page())
      var all = words.join("\n")
      verify(all.indexOf("NTLM") >= 0 && all.indexOf("Basic") >= 0 && all.indexOf("HTTPS") >= 0)
      verify(all.indexOf("system keyring") >= 0 && all.indexOf("never in a file") >= 0)
      verify(all.indexOf("sending and drafts work") >= 0)
      verify(named(app, "exchange-secret-field").password, "the password is masked")
    }
  }
}
