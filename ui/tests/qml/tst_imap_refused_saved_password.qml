import QtQuick
import QtTest
import qs.Commons as Commons
import "transports.js" as Transports
import "../../components" as Mail
import "../../providers" as Providers

// A mailbox whose saved password the server has started refusing. Every
// request sent with it fails at LOGIN, and until now the mailbox still counted
// as signed in: its setup page offered Save changes instead of Connect the
// mailbox, and every background check sent the refused password again.
Item {
  id: root

  QtObject {
    id: backend
    property bool ready: true
  }

  QtObject {
    id: credentials
    property bool backendCanStoreCredentials: true
    property var heldRead: null
    property bool holdReads: false
    property bool holdWrites: false
    property var heldWrite: null
    property var writes: []
    property int reads: 0
    property int deletes: 0
    function credentialGet(kind, accountId, clientId, callback) {
      reads++
      if (holdReads) heldRead = callback
      else callback("old-password", "")
      return true
    }
    function credentialPut(kind, accountId, clientId, secret, callback) {
      writes = writes.concat([{kind: kind, accountId: accountId, secret: secret}])
      if (holdWrites) heldWrite = callback
      else callback(true, "")
      return true
    }
    function credentialDelete(kind, accountId, clientId, callback) {
      deletes++
      callback(true, "")
      return true
    }
  }

  Component {
    id: imapFactory
    Providers.ImapAuth {
      pluginDir: "/synthetic"
      platform: credentials
      accountId: "imap:one@example.org"
      settings: ({imapHost: "imap.example.org", imapPort: 993, smtpHost: "smtp.example.org",
        smtpPort: 465, username: "one@example.org", aliases: [], insecure: false})
    }
  }

  Component {
    id: clientFactory
    Providers.ImapClient { email: "one@example.org" }
  }

  // An OAuth mailbox reaches the same client with an auth that has no saved
  // password to refuse.
  QtObject {
    id: oauthAuth
    property string accountId: "outlook:one@example.org"
    property string authMode: "oauth2"
    property bool loggedIn: true
    property var settings: ({imapHost: "outlook.office365.com", imapPort: 993, username: "one@example.org"})
  }

  Component {
    id: pageFactory
    Mail.ImapSetupPage {
      width: 600
      textColor: Commons.Color.foreground
      dimColor: Commons.Color.foreground
      dangerColor: Commons.Color.accent
      accentColor: Commons.Color.accent
      panelFontFamily: "monospace"
    }
  }

  Component {
    id: serviceFactory
    QtObject {
      property var auth: null
      property string accountAddress: "one@example.org"
      property string accountName: ""
      property string accountSenderName: ""
      property bool backendCanNameSender: false
    }
  }

  TestCase {
    name: "ImapRefusedSavedPassword"
    when: windowShown

    function init() {
      backend.ready = true
      credentials.holdReads = false
      credentials.heldRead = null
      credentials.holdWrites = false
      credentials.heldWrite = null
      credentials.writes = []
      credentials.reads = 0
      credentials.deletes = 0
    }

    // Signed in the way a restart signs in: the keyring's password, loaded.
    function restored() {
      var auth = createTemporaryObject(imapFactory, root)
      auth.restoreSession()
      verify(auth.loggedIn)
      credentials.reads = 0
      return auth
    }

    function clientFor(auth) {
      var client = createTemporaryObject(clientFactory, root, {auth: auth})
      Transports.install(client)
      return client
    }

    function refuse(request, code) {
      Transports.reply(request, null, {code: -32000, message: code || "mail_auth_failed"})
    }

    function test_a_refused_saved_password_signs_the_mailbox_out() {
      var auth = restored()
      var unavailable = []
      auth.sessionUnavailable.connect(function(reason) { unavailable = unavailable.concat([reason]) })
      verify(auth.refuseSavedPassword(auth.passwordRevision))
      verify(!auth.loggedIn, "so its setup page offers Connect the mailbox")
      compare(auth.lastError, "The server refused the saved password. Enter it again")
      compare(unavailable, [auth.lastError])
      compare(credentials.deletes, 0, "the keyring item stays for the next start")
      var answer = null
      auth.withCredentials(function(value, error) { answer = {value: value, error: error} })
      compare(answer.value, "")
      verify(answer.error !== "")
      compare(credentials.reads, 0, "and the refused password is not read back in behind the user's back")
      verify(!auth.loggedIn)
    }

    // A backend that restarts restores its mailboxes. The refused password
    // stays where the refusal left it.
    function test_a_backend_reconnect_does_not_restore_the_refused_password() {
      var auth = restored()
      auth.backend = backend
      verify(auth.refuseSavedPassword(auth.passwordRevision))
      backend.ready = false
      backend.ready = true
      compare(credentials.reads, 0)
      verify(!auth.loggedIn)
      verify(auth.savedPasswordRefused)
      compare(auth.lastError, "The server refused the saved password. Enter it again")
    }

    function test_a_keyring_read_under_way_does_not_restore_the_refused_password() {
      var auth = restored()
      credentials.holdReads = true
      auth.restoreSession()
      verify(credentials.heldRead !== null)
      verify(auth.refuseSavedPassword(auth.passwordRevision))
      credentials.heldRead("old-password", "")
      verify(!auth.loggedIn)
      verify(auth.savedPasswordRefused)
      compare(auth.lastError, "The server refused the saved password. Enter it again")
      verify(auth.signIn("new-app-password"))
      verify(auth.loginBusy, "and the next sign-in is still a first one")
    }

    function test_the_next_sign_in_is_a_first_one_and_overwrites_the_saved_password() {
      var auth = restored()
      verify(auth.refuseSavedPassword(auth.passwordRevision))
      verify(auth.signIn("new-app-password"))
      verify(auth.loginBusy, "Connect the mailbox, not a replacement")
      verify(!auth.replacementBusy)
      auth.completeSignIn(true, "")
      verify(auth.loggedIn)
      compare(auth.password, "new-app-password")
      compare(auth.lastError, "")
      compare(credentials.writes.length, 1)
      compare(credentials.writes[0].secret, "new-app-password")
    }

    function test_a_refusal_of_an_older_password_signs_nobody_out_data() {
      return [
        {tag: "replaced", change: function(auth) {
          verify(auth.signIn("new-app-password")); auth.completeSignIn(true, "") }},
        {tag: "signed out and in again", change: function(auth) {
          auth.logout(); verify(auth.signIn("new-app-password")); auth.completeSignIn(true, "") }},
        {tag: "already refused", change: function(auth) {
          verify(auth.refuseSavedPassword(auth.passwordRevision))
          verify(auth.signIn("new-app-password")); auth.completeSignIn(true, "") }}
      ]
    }

    function test_a_refusal_of_an_older_password_signs_nobody_out(data) {
      var auth = restored()
      var revision = auth.passwordRevision
      data.change(auth)
      verify(auth.loggedIn)
      verify(!auth.refuseSavedPassword(revision))
      verify(auth.loggedIn)
      compare(auth.password, "new-app-password")
    }

    function test_a_replacement_in_flight_decides_instead() {
      var auth = restored()
      verify(auth.signIn("new-app-password"))
      verify(auth.replacementBusy)
      verify(!auth.refuseSavedPassword(auth.passwordRevision))
      verify(auth.loggedIn, "the setup page that is checking stays")
      auth.completeSignIn(true, "")
      compare(auth.password, "new-app-password")
    }

    // While the verified replacement is written, the backend can still read
    // the previous one from the keyring and be refused with it.
    function test_a_refusal_while_the_keyring_is_written_signs_nobody_out() {
      var auth = restored()
      credentials.holdWrites = true
      verify(auth.signIn("new-app-password"))
      auth.completeSignIn(true, "")
      verify(auth.credentialWriteBusy)
      var duringWrite = auth.passwordRevision
      verify(!auth.refuseSavedPassword(duringWrite), "answered while it is written")
      credentials.heldWrite(true, "")
      verify(!auth.refuseSavedPassword(duringWrite), "sent while it was written, answered after")
      verify(auth.loggedIn)
      verify(auth.refuseSavedPassword(auth.passwordRevision), "a request sent after it can")
    }

    function test_a_request_refused_at_login_signs_the_mailbox_out_data() {
      return [
        {tag: "folders", run: function(client, done) { client.ensureFolders(done) }},
        {tag: "list", run: function(client, done) { client.listMessages("", 10, "", done) }},
        {tag: "count", run: function(client, done) { client.getLabelCounts("INBOX", done) }},
        {tag: "modify", run: function(client, done) { client.batchModify(["1"], [], ["UNREAD"], done) }},
        {tag: "draft", run: function(client, done) { client.saveDraft({raw: "x"}, done) }}
      ]
    }

    function test_a_request_refused_at_login_signs_the_mailbox_out(data) {
      var auth = restored()
      var client = clientFor(auth)
      var errors = []
      data.run(client, function() { errors = errors.concat([arguments[arguments.length - 1]]) })
      var sent = Transports.transports(client)
      compare(sent.length, 1)
      compare(sent[0].params.accountId, "imap:one@example.org")
      refuse(sent[0])
      verify(!auth.loggedIn)
      compare(auth.lastError, "The server refused the saved password. Enter it again")
      compare(errors, [auth.lastError], "and the request says so too")
    }

    // RFC 5530 codes on the refused LOGIN. The ones that say the password no
    // longer gets in sign out and keep what the server said; the others leave
    // the mailbox signed in.
    function test_a_coded_login_refusal_data() {
      return [
        {tag: "expired", code: "mail_auth_expired", signsOut: true,
          text: "The server says this password has expired. Create a new password or app password, then sign in again."},
        {tag: "contact admin", code: "mail_auth_contact_admin", signsOut: true,
          text: "The server refused the sign-in and asks you to contact your mail administrator."},
        {tag: "unavailable", code: "mail_auth_unavailable", signsOut: false,
          text: "The server could not check the sign-in right now. Wait a few minutes, then sign in again."},
        {tag: "unauthorized", code: "mail_auth_unauthorized", signsOut: false,
          text: "The server accepted the password but does not let this account use the mailbox."},
        {tag: "privacy required", code: "mail_auth_privacy_required", signsOut: false,
          text: "The server requires an encrypted connection before it accepts a sign-in."}
      ]
    }

    function test_a_coded_login_refusal(data) {
      var auth = restored()
      var client = clientFor(auth)
      var error = ""
      client.ensureFolders(function(failure) { error = failure })
      refuse(Transports.transports(client)[0], data.code)
      compare(error, data.text)
      compare(auth.loggedIn, !data.signsOut)
      compare(auth.savedPasswordRefused, data.signsOut)
      compare(auth.lastError, data.signsOut ? data.text : "")
      client.recheckSavedPassword(data.code)
      compare(Transports.transports(client).length, 1,
        "a signed-out mailbox, or a refusal that is not the password's, asks nothing more")
      if (!data.signsOut) return
      var service = createTemporaryObject(serviceFactory, root, {auth: auth})
      var page = createTemporaryObject(pageFactory, root, {service: service})
      compare(findChild(page, "imap-error").text, data.text, "the setup page opens on what the server said")
      verify(findChild(page, "imap-connect-button").visible)
    }

    // A keyring answer that arrives while a typed password is checked is
    // ignored, so the mailbox is not signed in and has nothing to refuse.
    function test_a_check_in_flight_decides_instead() {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth.signIn("typed-password"))
      verify(auth.loginBusy)
      auth.restoreSession()
      verify(!auth.refuseSavedPassword(auth.passwordRevision))
      verify(!auth.savedPasswordRefused)
      auth.completeSignIn(true, "")
      verify(auth.loggedIn)
      compare(auth.password, "typed-password")
      compare(auth.lastError, "")
    }

    function test_an_oauth_mailbox_refused_at_login_is_left_to_its_own_sign_in() {
      var client = createTemporaryObject(clientFactory, root, {auth: oauthAuth})
      Transports.install(client)
      var error = ""
      client.ensureFolders(function(failure) { error = failure })
      refuse(Transports.transports(client)[0])
      compare(error, "The server rejected the sign-in. Sign in again.")
      verify(oauthAuth.loggedIn)
      client.recheckSavedPassword("mail_auth_failed")
      compare(Transports.transports(client).length, 1, "and the poller's refusal asks nothing more")
    }

    // The poller in the backend reads the keyring for itself, so its refusal
    // is checked once more by a request that knows its password.
    function test_a_refusal_in_the_background_is_checked_by_one_request_data() {
      return [
        {tag: "refused again", code: "mail_auth_failed", refused: true},
        {tag: "expired again", code: "mail_auth_expired", refused: true},
        {tag: "accepted", code: "mail_auth_failed", refused: false}
      ]
    }

    function test_a_refusal_in_the_background_is_checked_by_one_request(data) {
      var auth = restored()
      var client = clientFor(auth)
      client.recheckSavedPassword(data.code)
      var sent = Transports.transports(client)
      compare(sent.length, 1)
      compare(sent[0].method, "imap.folders")
      compare(sent[0].params.accountId, "imap:one@example.org")
      compare(sent[0].params.credential, undefined)
      if (data.refused) refuse(sent[0], data.code)
      else Transports.reply(sent[0], {folders: [], special: {}, capabilities: [], labels: []})
      compare(auth.loggedIn, !data.refused)
      client.recheckSavedPassword(data.code)
      compare(Transports.transports(client).length, data.refused ? 1 : 2,
        "a signed-out mailbox is not asked again")
    }

    function test_background_refusals_share_one_recheck() {
      var auth = restored()
      var client = clientFor(auth)
      client.recheckSavedPassword("mail_auth_failed")
      client.recheckSavedPassword("mail_auth_failed")
      compare(Transports.transports(client).length, 1, "each one is a LOGIN with the refused password")
      Transports.reply(Transports.transports(client)[0], null, {code: -32000, message: "request_timed_out"})
      verify(auth.loggedIn)
      client.recheckSavedPassword("mail_auth_failed")
      compare(Transports.transports(client).length, 2, "an answered one frees the next")
    }

    function test_no_recheck_while_its_answer_would_be_ignored_data() {
      return [
        {tag: "replacement checked", start: function(auth) { verify(auth.signIn("new-app-password")) }},
        {tag: "replacement written", start: function(auth) {
          credentials.holdWrites = true
          verify(auth.signIn("new-app-password"))
          auth.completeSignIn(true, "")
          verify(auth.credentialWriteBusy) }}
      ]
    }

    function test_no_recheck_while_its_answer_would_be_ignored(data) {
      var auth = restored()
      var client = clientFor(auth)
      data.start(auth)
      var before = Transports.transports(client).length
      client.recheckSavedPassword("mail_auth_failed")
      compare(Transports.transports(client).length, before)
    }

    function test_the_setup_page_opens_on_the_refusal_and_not_on_an_older_error_data() {
      return [
        {tag: "refused", refuse: true, expected: "The server refused the saved password. Enter it again"},
        {tag: "a failed connect, left", refuse: false, expected: ""}
      ]
    }

    function test_the_setup_page_opens_on_the_refusal_and_not_on_an_older_error(data) {
      var auth = data.refuse ? restored() : createTemporaryObject(imapFactory, root)
      if (data.refuse) verify(auth.refuseSavedPassword(auth.passwordRevision))
      else {
        verify(auth.signIn("wrong-password"))
        auth.completeSignIn(false, "")
        auth.cancelLogin()
        verify(auth.lastError !== "")
      }
      var service = createTemporaryObject(serviceFactory, root, {auth: auth})
      var page = createTemporaryObject(pageFactory, root, {service: service})
      compare(findChild(page, "imap-error").text, data.expected)
      verify(findChild(page, "imap-connect-button").visible)
    }

    function test_a_send_refused_by_smtp_leaves_the_mailbox_signed_in() {
      var auth = restored()
      var client = clientFor(auth)
      var error = ""
      client.sendMessage({raw: "x"}, function(result, failure) { error = failure })
      var sent = Transports.transports(client)
      compare(sent[0].method, "imap.send")
      refuse(sent[0])
      verify(error !== "", "the send still fails")
      verify(auth.loggedIn, "SMTP's password check is not the mailbox's")
    }

    function test_other_failures_leave_the_mailbox_signed_in_data() {
      return [
        {tag: "timeout", code: "request_timed_out"},
        {tag: "tls", code: "mail_tls_failed"},
        {tag: "keyring item missing", code: "auth_signed_out"},
        {tag: "folder", code: "imap_folder_unavailable"}
      ]
    }

    function test_other_failures_leave_the_mailbox_signed_in(data) {
      var auth = restored()
      var client = clientFor(auth)
      client.ensureFolders(function() {})
      Transports.reply(Transports.transports(client)[0], null, {code: -32000, message: data.code})
      verify(auth.loggedIn)
    }

    function test_a_request_sent_before_a_replacement_cannot_sign_it_out() {
      var auth = restored()
      var client = clientFor(auth)
      client.ensureFolders(function() {})
      var early = Transports.transports(client)[0]
      verify(auth.signIn("new-app-password"))
      auth.completeSignIn(true, "")
      refuse(early)
      verify(auth.loggedIn)
      compare(auth.password, "new-app-password")
    }

    function test_a_typed_password_refused_is_reported_to_the_page_and_signs_nobody_out() {
      var auth = restored()
      var client = clientFor(auth)
      var error = ""
      client.verifyCredentials(auth.settings, "one@example.org:wrong-password",
        function(ok, failure) { error = failure })
      var sent = Transports.transports(client)
      compare(sent.length, 1)
      verify(sent[0].params.credential !== undefined)
      refuse(sent[0])
      verify(auth.loggedIn, "a typed password's refusal is reported to the page that typed it")
    }
  }
}
