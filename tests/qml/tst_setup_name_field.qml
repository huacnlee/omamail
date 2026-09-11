import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import "../../components" as Mail
import "../.." as Omamail
import "../../account/Accounts.js" as Accounts

// A mailbox can be named where it is set up: the name goes to the store
// with the rest of the form, comes back into the field on the next visit,
// and an empty field is no name.
Item {
  width: 700
  height: 900

  QtObject {
    id: fakeAuth
    property bool loggedIn: false
    property bool loginBusy: false
    property bool toolsChecked: true
    property var missingTools: []
    property string lastError: ""
    property var settings: ({ username: "", aliases: [], imapHost: "", imapPort: 993, smtpHost: "", smtpPort: 465 })
  }

  QtObject {
    id: fakeService
    property var auth: fakeAuth
    property string accountAddress: ""
    property string accountName: "Work"
    property var saved: null
    property var signedIn: null
    function configureCurrentAccount(values) { saved = values }
    function configureCurrentAccountAndSignIn(values, secret) { signedIn = values }
  }

  QtObject {
    id: gmailAuth
    property bool credentialsPresent: true
    property bool loggedIn: false
    property bool loginBusy: false
    property bool toolsChecked: true
    property bool toolsPresent: true
    property var missingTools: []
    property string lastError: ""
    property string clientId: "000000-abc.apps.googleusercontent.com"
    property var credentials: null
    property int credentialSaves: 0
    signal credentialsSaved()
    function saveCredentials(_text) { credentialSaves++ }
  }

  QtObject {
    id: gmailService
    property var auth: gmailAuth
    property string accountEmail: ""
    property string accountAddress: ""
    property string accountName: ""
    property var saved: null
    property int signIns: 0
    function configureCurrentAccount(values) { saved = values }
    function signIn() { signIns++ }
    function openCloudConsole() {}
    function openGmailApiPage() {}
    function openProviderWebsite(_id) {}
  }

  // A second Gmail mailbox: the client exists, so its step is folded away.
  Mail.SetupPage {
    id: gmailPage
    width: 600
    service: gmailService
    textColor: Color.foreground
    dimColor: Color.foreground
    dangerColor: Color.accent
    accentColor: Color.accent
    panelFontFamily: "monospace"
  }

  Omamail.Service {
    id: realService
    shell: shellStore
    manifest: ({ id: "omamail", __sourceDir: "/tmp/omamail-test" })
  }
  QtObject {
    id: shellStore
    function updateEntryInline(_id, _entry) {}
    function hide(_id) {}
  }

  Mail.ImapSetupPage {
    id: page
    width: 600
    service: fakeService
    textColor: Color.foreground
    dimColor: Color.foreground
    dangerColor: Color.accent
    accentColor: Color.accent
    panelFontFamily: "monospace"
  }

  TestCase {
    name: "SetupNameField"
    when: windowShown

    function field(name) {
      function find(item) {
        if (item.objectName === name) return item
        var kids = item.children || []
        for (var i = 0; i < kids.length; i++) { var f = find(kids[i]); if (f) return f }
        return null
      }
      return find(page)
    }

    function gmailField(name) {
      function find(item) {
        if (item.objectName === name) return item
        var kids = item.children || []
        for (var i = 0; i < kids.length; i++) { var f = find(kids[i]); if (f) return f }
        return null
      }
      return find(gmailPage)
    }

    // Gmail: the field stands above the steps, so a second mailbox — whose
    // client step is folded away — still gets one; the name goes with a
    // sign-in as well as with saving the client.
    function test_a_second_gmail_mailbox_can_be_named_and_the_name_goes_with_the_sign_in() {
      compare(gmailPage.configured, true)
      var name = gmailField("account-name-field")
      verify(name !== null)
      verify(name.visible, "the field is on the page even with the client step folded")
      name.text = "Work"
      gmailPage.signInNamed()
      verify(gmailService.saved !== null)
      compare(gmailService.saved.label, "Work")
      compare(gmailService.signIns, 1, "and the sign-in follows")
      gmailService.saved = null
      gmailService.accountName = "Work"
      gmailPage.signInNamed()
      compare(gmailService.saved, null, "an unchanged name is not written again")
      name.text = "Work mail"
      gmailPage.save()
      compare(gmailService.saved.label, "Work mail", "saving the client saves the name too")
      compare(gmailAuth.credentialSaves, 1)
    }

    // A draft mailbox is addressed by its position until it has an id: a
    // name written to it before the address must not turn the setup page
    // into the previous mailbox's.
    function test_naming_a_draft_keeps_it_current() {
      var list = Accounts.emptyList()
      list = Accounts.add(list, { email: "ada@example.com", provider: "imap", clientId: "", clientSecret: "",
        imap: { imapHost: "imap.example.com", imapPort: 993, smtpHost: "smtp.example.com", smtpPort: 465,
          username: "ada@example.com", aliases: [], insecure: false }, label: "", signature: "" })
      list = Accounts.setActive(list, "imap:ada@example.com")
      realService.activeIndex = -1
      realService.accountList = list
      realService.accountsLoaded = true
      wait(0)
      realService.refreshCurrent()
      tryCompare(realService, "activeAccountId", "imap:ada@example.com")
      realService.addAccount("gmail")
      compare(realService.activeIndex, 1, "the draft is the current mailbox, by position")
      var draft = realService.accountAt(1)
      verify(draft !== null)
      compare(realService.current, draft)
      realService.configureCurrentAccount({ label: "Work" })
      compare(realService.activeIndex, 1, "and still is once named")
      compare(realService.current, realService.accountAt(1))
      compare(String(realService.accountList.accounts[1].label || ""), "Work")
      compare(realService.accountName, "Work", "which is what the field reads back")
    }

    function test_the_name_comes_from_the_store_and_goes_back_with_the_form() {
      var name = field("account-name-field")
      verify(name !== null)
      compare(name.text, "Work", "the name the entry has is what the field shows")
      field("imap-address-field").text = "ada@icloud.com"
      name.text = "  Ada at home  "
      page.save()
      verify(fakeService.saved !== null)
      compare(fakeService.saved.label, "Ada at home", "trimmed, with the rest of the form")
      compare(fakeService.saved.email, "ada@icloud.com")
      page.signIn()
      verify(fakeService.signedIn !== null)
      compare(fakeService.signedIn.label, "Ada at home", "and on the way to a sign-in")
      name.text = ""
      page.save()
      compare(fakeService.saved.label, "", "empty is no name, which puts the address back")
    }
  }
}
