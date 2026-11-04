import QtQuick
import QtTest
import qs.Commons as Commons
import "../../components" as Mail
import "../../providers" as Providers

// A mailbox whose saved password the server has started refusing still counts
// as signed in, so its setup page offers Save changes rather than Connect the
// mailbox. A replacement password typed there has to be verified and stored,
// not dropped while only the servers are saved; and until it is verified, the
// saved one stays.
Item {
  id: root
  width: 700
  height: 900

  QtObject {
    id: credentials
    property bool backendCanStoreCredentials: true
    property bool failWrites: false
    property var writes: []
    property int deletes: 0
    function credentialGet(kind, accountId, clientId, callback) { return true }
    function credentialPut(kind, accountId, clientId, secret, callback) {
      writes = writes.concat([{kind: kind, accountId: accountId, secret: secret}])
      callback(!failWrites, failWrites ? "credential_store_failed" : "")
      return true
    }
    function credentialDelete(kind, accountId, clientId, callback) {
      deletes++
      callback(true, "")
      return true
    }
  }

  // The mailbox on screen: signed in with a password the server now refuses.
  Providers.ImapAuth {
    id: savedAuth
    pluginDir: "/synthetic"
    platform: credentials
    accountId: "imap:one@example.org"
    settings: ({imapHost: "imap.example.org", imapPort: 993, smtpHost: "smtp.example.org",
      smtpPort: 465, username: "one@example.org", aliases: [], insecure: false})
  }

  // What `Service.configureCurrentAccountAndSignIn` and
  // `MailAccount.signInWithPassword` do, without the account list.
  QtObject {
    id: service
    property var auth: savedAuth
    property string accountAddress: "one@example.org"
    property string accountName: ""
    property string accountSenderName: ""
    property bool backendCanNameSender: false
    property var saved: null
    function configureCurrentAccount(values) { saved = values }
    function configureCurrentAccountAndSignIn(values, typed) { savedAuth.signIn(typed) }
  }

  Mail.ImapSetupPage {
    id: page
    width: 600
    service: service
    textColor: Commons.Color.foreground
    dimColor: Commons.Color.foreground
    dangerColor: Commons.Color.accent
    accentColor: Commons.Color.accent
    panelFontFamily: "monospace"
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

  TestCase {
    name: "ImapPasswordReplacement"
    when: windowShown

    property var verified: []

    function initTestCase() {
      savedAuth.verifyRequested.connect(function(settings, value) {
        verified = verified.concat([value])
      })
    }

    function init() {
      savedAuth.loginBusy = false
      savedAuth.replacementBusy = false
      savedAuth.pendingPassword = ""
      savedAuth.lastError = ""
      savedAuth.password = "old-password"
      savedAuth.passwordChecked = true
      credentials.failWrites = false
      credentials.writes = []
      credentials.deletes = 0
      service.saved = null
      verified = []
      findChild(page, "imap-password-field").text = ""
    }

    function signedIn(auth) {
      auth.password = "old-password"
      auth.passwordChecked = true
      return auth
    }

    function test_save_changes_verifies_a_typed_replacement_before_storing_it() {
      var save = findChild(page, "imap-save-button")
      var password = findChild(page, "imap-password-field")
      verify(save.visible, "a signed-in mailbox offers Save changes")
      password.text = "new-app-password"
      save.clicked()
      compare(verified, ["one@example.org:new-app-password"], "the replacement is what gets verified")
      compare(credentials.writes.length, 0, "and nothing is stored before the server answers")
      compare(service.saved, null, "not a settings-only save that drops it")
      savedAuth.completeSignIn(true, "")
      compare(credentials.writes.length, 1)
      compare(credentials.writes[0].kind, "imap-password")
      compare(credentials.writes[0].accountId, "imap:one@example.org")
      compare(credentials.writes[0].secret, "new-app-password")
      compare(savedAuth.password, "new-app-password")
      compare(password.text, "", "a stored password is not verified again by the next save")
    }

    function test_a_refused_replacement_stays_in_the_field_and_the_saved_password_stays() {
      var password = findChild(page, "imap-password-field")
      password.text = "wrong-password"
      findChild(page, "imap-save-button").clicked()
      compare(verified, ["one@example.org:wrong-password"])
      savedAuth.completeSignIn(false, "The server rejected the sign-in. Sign in again.")
      compare(password.text, "wrong-password", "kept, to be corrected")
      compare(findChild(page, "imap-error").text, "The server rejected the sign-in. Sign in again.")
      compare(savedAuth.password, "old-password")
      compare(credentials.writes.length, 0)
    }

    function test_save_changes_without_a_password_only_saves_the_settings() {
      findChild(page, "imap-save-button").clicked()
      verify(service.saved !== null)
      compare(verified.length, 0, "nothing to verify")
    }

    function test_save_changes_and_enter_wait_while_the_password_is_checked() {
      var save = findChild(page, "imap-save-button")
      var password = findChild(page, "imap-password-field")
      password.text = "new-app-password"
      save.clicked()
      compare(save.text, "Checking")
      verify(!save.enabled)
      password.text = "typed-while-checking"
      password.accepted()
      page.save()
      compare(verified, ["one@example.org:new-app-password"], "no second attempt overlaps the first")
      savedAuth.completeSignIn(true, "")
      compare(save.text, "Save changes")
      verify(save.enabled)
      compare(credentials.writes.length, 1)
      compare(credentials.writes[0].secret, "new-app-password", "the verified one, not the last typed")
    }

    function test_a_password_the_keyring_could_not_store_stays_in_the_field() {
      var password = findChild(page, "imap-password-field")
      credentials.failWrites = true
      password.text = "new-app-password"
      findChild(page, "imap-save-button").clicked()
      savedAuth.completeSignIn(true, "")
      compare(password.text, "new-app-password", "so the next Save changes can store it")
      verify(savedAuth.lastError.indexOf("could not be saved") >= 0)
    }

    // The auth half: a mailbox already holding a password keeps it until the
    // replacement has been verified, and one attempt cannot answer for another.
    function test_a_refused_replacement_keeps_the_saved_password_and_stores_nothing() {
      var auth = signedIn(createTemporaryObject(imapFactory, root))
      verify(auth.signIn("wrong-password"))
      auth.completeSignIn(false, "mail_auth_failed")
      compare(auth.password, "old-password")
      compare(auth.pendingPassword, "")
      compare(credentials.writes.length, 0)
      verify(auth.lastError !== "")
    }

    function test_a_verified_replacement_overwrites_the_saved_password() {
      var auth = signedIn(createTemporaryObject(imapFactory, root))
      var saved = 0
      auth.credentialsSaved.connect(function() { saved++ })
      verify(auth.signIn("new-app-password"))
      auth.completeSignIn(true, "")
      compare(auth.password, "new-app-password")
      compare(credentials.writes.length, 1)
      compare(credentials.writes[0].secret, "new-app-password")
      compare(saved, 1)
    }

    function test_a_second_attempt_is_refused_while_the_first_is_checked_data() {
      return [
        {tag: "first accepted", first: "right-password", second: "wrong-password", ok: true},
        {tag: "first refused", first: "wrong-password", second: "right-password", ok: false}
      ]
    }

    function test_a_second_attempt_is_refused_while_the_first_is_checked(data) {
      var auth = signedIn(createTemporaryObject(imapFactory, root))
      var sent = []
      auth.verifyRequested.connect(function(settings, value) { sent = sent.concat([value]) })
      verify(auth.signIn(data.first))
      verify(!auth.signIn(data.second))
      compare(sent, ["one@example.org:" + data.first])
      auth.completeSignIn(data.ok, data.ok ? "" : "mail_auth_failed")
      if (data.ok) {
        compare(credentials.writes.length, 1)
        compare(credentials.writes[0].secret, data.first)
        compare(auth.password, data.first)
      } else {
        compare(credentials.writes.length, 0)
        compare(auth.password, "old-password", "the saved password is not lost to the refusal")
      }
    }

    // A replacement keeps the mailbox in service while it is checked; a first
    // sign-in has nothing to keep and is what `loginBusy` means.
    function test_a_replacement_is_checked_without_taking_the_mailbox_out_of_service() {
      var auth = signedIn(createTemporaryObject(imapFactory, root))
      verify(auth.signIn("new-app-password"))
      verify(auth.replacementBusy)
      verify(!auth.loginBusy, "loginBusy would make the mailbox signing_in")
      var fresh = createTemporaryObject(imapFactory, root)
      verify(fresh.signIn("first-password"))
      verify(fresh.loginBusy)
      verify(!fresh.replacementBusy)
    }

    function test_an_abandoned_check_frees_sign_in_and_its_late_answer_is_dropped_data() {
      return [
        {tag: "sign out", abandon: function(auth) { auth.logout() }},
        {tag: "cancel", abandon: function(auth) { auth.cancelLogin() }},
        {tag: "another mailbox", abandon: function(auth) { auth.accountId = "imap:two@example.org" }}
      ]
    }

    function test_an_abandoned_check_frees_sign_in_and_its_late_answer_is_dropped(data) {
      var auth = signedIn(createTemporaryObject(imapFactory, root))
      var generations = []
      auth.verifyRequested.connect(function() { generations = generations.concat([auth.sessionGeneration]) })
      var succeeded = 0
      auth.loginSucceeded.connect(function() { succeeded++ })
      verify(auth.signIn("new-app-password"))
      data.abandon(auth)
      verify(!auth.loginBusy && !auth.replacementBusy, "nothing is left checking")
      auth.completeSignIn(true, "", generations[0])
      compare(credentials.writes.length, 0, "a late answer does not bring a password back")
      compare(succeeded, 0, "or report a sign-in nobody is waiting for")
      verify(auth.signIn("next-password"), "and the next attempt is not refused")
      auth.completeSignIn(true, "", generations[0])
      compare(credentials.writes.length, 0, "the old answer cannot finish the new attempt either")
      auth.completeSignIn(true, "", generations[1])
      compare(credentials.writes.length, 1)
      compare(credentials.writes[0].secret, "next-password")
    }
  }
}
