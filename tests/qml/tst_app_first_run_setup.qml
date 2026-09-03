import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail

// First run has no mailbox to fall back to, so a setup form is the whole
// window. The one place behind it is the question it answered — which kind of
// mailbox — and that has to stay reachable: a sole account that was saved but
// never signed in (a Gmail address on the IMAP form, say) used to trap the
// user on its page with no Back and no Remove, across reinstalls, because the
// saved row outlives the plugin.
Item {
  width: 900
  height: 600

  QtObject {
    id: fakeAuth

    property bool credentialsPresent: true
    property bool loggedIn: false
    property bool loginBusy: false
    property bool toolsChecked: true
    property bool toolsPresent: true
    property bool credentialsWriteBusy: false
    property var missingTools: []
    property string lastError: ""
    property string clientId: ""
    property string clientDescription: ""
    property string credentialsPath: ""
    property var credentials: null
    property var settings: ({
      imapHost: "imap.gmail.com", imapPort: 993,
      smtpHost: "smtp.gmail.com", smtpPort: 465,
      username: "", aliases: [], insecure: false
    })

    function recheck() {}
    function saveCredentials() {}
  }

  QtObject {
    id: mailService

    property bool ready: false
    property bool anyAccountReady: false
    property bool hasSavedAccounts: true
    property bool sendPending: false
    property bool sending: false
    property bool windowOpen: false
    property bool sidebarCollapsed: false
    property bool alwaysShowImages: false
    property bool unifiedCalendarView: false
    property bool selectedReaderEmpty: false
    property bool selectedReaderTooHeavy: false
    property bool selectedTooHeavy: false
    property bool detailLoading: false
    property bool detailPainted: false
    property bool canOpenOnWeb: false
    property bool canRespondToInvite: false
    property bool rsvpSending: false
    property bool canArchive: false
    property bool canStar: false
    property bool canSpam: false
    property bool canTrash: false
    property bool canMarkRead: false
    property bool canMarkUnread: false
    property bool accountDraftOpen: false
    property bool signInProgress: false
    property int sendSecondsRemaining: 10
    property int accountCount: 1
    property int inboxUnread: 0
    property real bodyZoom: 1
    property string bodyMode: "reader"
    property string providerId: "imap"
    property string pluginDir: ""
    property string accountEmail: "someone@gmail.com"
    property string accountAddress: "someone@gmail.com"
    property string activeAccountId: "imap:someone@gmail.com"
    property string mailboxKey: "inbox"
    property string searchQuery: ""
    property string rawQuery: ""
    property string selectedId: ""
    property string lastError: ""
    property string actionStatus: ""
    property string syncedLabel: ""
    property string recipientContactStatus: ""
    property var accountSummaries: [{ provider: "imap", email: "someone@gmail.com" }]
    property var mailboxes: []
    property var labels: []
    property var messages: []
    property var selectedAttachments: []
    property var selectedInvite: null
    property var selectedResponse: ""
    property var recipientContacts: []
    property var sendAsAliases: []
    property var sendIdentities: []
    property var calendarController: null
    property var auth: fakeAuth
    property var selectedBody: null
    property var selectedMessage: null

    // What the window asked of the account list, in order.
    property var log: []
    property string lastAddedProvider: ""
    property var lastConfigured: null

    signal accountAdded()
    signal replySent()

    function record(text) {
      var next = log.slice()
      next.push(text)
      log = next
    }
    function editingIndex() { return 0 }
    function addAccount(provider) {
      lastAddedProvider = String(provider || "")
      record("add:" + lastAddedProvider)
      accountCount += 1
      accountAdded()
    }
    function configureCurrentAccount(values) {
      lastConfigured = values
      record("configure:" + String(values.provider || ""))
      if (values.provider !== undefined) providerId = String(values.provider)
    }
    function discardCurrentDraft() {
      record("discard")
      if (accountCount > 1) accountCount -= 1
    }
    function preferredSendAs(_recipients) { return null }
    function refreshRecipientContacts() {}
    function cursorOffset(_id, _delta) { return "" }
    function clearSelection() {}
    function select(_id) {}
    function refresh() {}
    function search(_query) { searchQuery = String(_query || "") }
    function fail(text) { lastError = String(text || "") }
    function note(text) { actionStatus = String(text || "") }
  }

  Omamail.App {
    id: app
    service: mailService
  }

  TestCase {
    name: "AppFirstRunSetup"
    when: windowShown

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

    // The Back control a page draws, wherever it sits in the page.
    function backBar(item) {
      if (!item) return null
      if (item.label === "Back" && typeof item.activated === "function") return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var found = backBar(values[i])
        if (found) return found
      }
      return null
    }

    function page() {
      var loader = named(app, "setup-page")
      verify(loader, "the setup loader is on the page")
      return loader.item
    }

    function isPicker(item) {
      return !!item && typeof item.chosen === "function"
    }

    function isImapForm(item) {
      return !!item && typeof item.currentSettings === "function"
    }

    function init() {
      app.opened = true
      mailService.log = []
      mailService.lastAddedProvider = ""
      mailService.lastConfigured = null
      mailService.accountCount = 1
      mailService.providerId = "imap"
      mailService.hasSavedAccounts = true
      fakeAuth.credentialsPresent = true
      app.resetNavigation()
      waitForRendering(app)
    }

    function test_saved_but_unsigned_sole_account_can_go_back_to_the_chooser() {
      // A saved IMAP row with a valid server is "setup underway": its form
      // opens directly, not the chooser.
      verify(isImapForm(page()), "the IMAP form opens for the saved row")

      var back = named(app, "page-back")
      verify(back, "the window has a Back control for its pages")
      verify(back.visible, "Back is shown even though no mailbox is ready")

      back.activated()
      waitForRendering(app)
      verify(isPicker(page()), "Back leads to the provider chooser")
      verify(page().visible, "and it is drawn, not hidden behind the form's page")

      page().chosen("gmail")
      waitForRendering(app)
      compare(mailService.lastAddedProvider, "gmail",
        "the saved row is kept and a Gmail row is added beside it")
      var loader = named(app, "setup-page")
      compare(loader.kind, "gmail")
      verify(!isPicker(page()) && !isImapForm(page()), "the Gmail walkthrough opens")
    }

    function test_escape_on_a_first_run_form_returns_to_the_chooser() {
      verify(isImapForm(page()))
      app.goBack()
      waitForRendering(app)
      verify(isPicker(page()), "Escape is the same way out as Back")
    }

    function test_back_from_an_added_draft_discards_it_and_asks_again() {
      named(app, "page-back").activated()
      page().chosen("gmail")
      waitForRendering(app)
      compare(mailService.accountCount, 2)

      named(app, "page-back").activated()
      waitForRendering(app)
      compare(mailService.log[mailService.log.length - 1], "discard",
        "an abandoned draft row is not left behind")
      verify(isPicker(page()), "and the question is asked again, not the IMAP form")
    }

    // The address that got the user here in the first place. Google refuses
    // the account password over IMAP, so the form has to say so as soon as a
    // Gmail address is typed, and hand over the page that explains what to
    // make instead.
    function test_gmail_address_on_the_imap_form_points_at_the_app_password_guide() {
      verify(isImapForm(page()))
      var guide = named(app, "imap-password-guide")
      verify(guide, "the form carries a guide link")
      var address = named(app, "imap-address-field")
      verify(address, "and an address field")

      address.text = "jane@example.org"
      waitForRendering(app)
      verify(!guide.visible, "an unknown server has no guide to point at")

      address.text = "jane@gmail.com"
      waitForRendering(app)
      verify(guide.visible, "a Gmail address shows the way to an app password")
      verify(/app password/i.test(guide.text), "and says so")
      verify(/^https:\/\/support\.google\.com\//.test(guide.tooltipText), "opening Google's own page")
    }

    function test_first_run_draft_switches_kind_in_place() {
      // Nothing saved yet: the first-run row only needs its kind.
      mailService.hasSavedAccounts = false
      fakeAuth.credentialsPresent = false
      mailService.providerId = "gmail"
      waitForRendering(app)
      verify(isPicker(page()), "first run opens on the chooser")
      // `visible` reads effective visibility, so this fails if the page
      // holding the chooser is hidden — a chooser that exists but is not
      // drawn is a blank window.
      verify(page().visible, "and the chooser is actually drawn")

      page().chosen("imap")
      waitForRendering(app)
      compare(mailService.lastConfigured.provider, "imap")
      verify(isImapForm(page()))

      named(app, "page-back").activated()
      waitForRendering(app)
      verify(isPicker(page()))

      page().chosen("gmail")
      waitForRendering(app)
      compare(mailService.lastConfigured.provider, "gmail",
        "the same row changes kind rather than a second row appearing")
      compare(mailService.lastAddedProvider, "")
    }
  }
}
