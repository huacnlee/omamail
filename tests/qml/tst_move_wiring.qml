import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail

// The move route through the real objects. Unit tests own each rule; this one
// catches a forwarding argument or property dropped between App, Service and
// MailAccount before the rule can see it.
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
    manifest: ({ id: "omamail", __sourceDir: "" })
  }

  Omamail.App {
    id: app
    service: mailService
    shell: fakeShell
  }

  TestCase {
    name: "MoveWiring"
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

    function installAccount(provider, id, email) {
      mailService.accountsLoaded = true
      mailService.accountList = ({
        version: 1,
        accounts: [{ id: id, email: email, provider: provider }],
        activeId: id
      })
      tryCompare(mailService, "accountCount", 1)
      tryVerify(function() { return mailService.current !== null }, 1000,
        "the real Service creates its MailAccount")
      wait(0)
      return mailService.current
    }

    function labelSlot(labelId) {
      var slots = app.sidebarSlots
      for (var i = 0; i < slots.length; i++) {
        if (slots[i].kind === "label" && slots[i].id === labelId) return i
      }
      return -1
    }

    function ids(labels) {
      var result = []
      for (var i = 0; i < labels.length; i++) result.push(labels[i].id)
      return result.join(",")
    }

    function init() {
      app.opened = true
      app.cursorId = ""
      mailService.accountList = ({ version: 1, accounts: [], activeId: "" })
      wait(0)
    }

    function cleanup() {
      mailService.accountList = ({ version: 1, accounts: [], activeId: "" })
      wait(0)
    }

    function test_gmail_label_identity_reaches_the_picker_and_move_model() {
      var account = installAccount("gmail", "me@example.com", "me@example.com")
      account.mailboxKey = "starred"
      account.labels = [
        { id: "Label_3", name: "Work", rawName: "Work", system: false, unread: 0 },
        { id: "Label_7", name: "Receipts", rawName: "Receipts", system: false, unread: 0 }
      ]

      var slot = labelSlot("Label_3")
      verify(slot >= 0)
      app.goSlot(slot)

      compare(account.rawLabelId, "Label_3")
      compare(mailService.rawLabelId, "Label_3")
      compare(mailService.rawQuery, "label:Work")
      compare(ids(named(app, "label-picker").matchingLabels), "Label_7",
        "the current label cannot trigger an optimistic removal that leaves it attached")

      account.auth.credentials = ({
        clientId: "123-test.apps.googleusercontent.com",
        clientSecret: "test",
        projectId: "test"
      })
      account.auth.toolsChecked = true
      account.auth.missingTools = []
      account.auth.loggedIn = true
      // Hold the transport below the real action pipeline: the test needs the
      // optimistic result, not a request to Google.
      account.auth.refreshBusy = true
      tryCompare(account, "ready", true)
      account.messages = [
        { id: "one", labelIds: ["INBOX", "Label_3"], unread: false, starred: true,
          inInbox: true, subject: "One", time: "now", from: { display: "Sender" }, snippet: "First" },
        { id: "two", labelIds: ["INBOX", "Label_3"], unread: false, starred: true,
          inInbox: true, subject: "Two", time: "now", from: { display: "Sender" }, snippet: "Second" }
      ]
      app.cursorId = "one"
      app.openMessage("one")
      compare(app.currentView, "reader")
      compare(mailService.selectedId, "one")

      verify(app.actOnCursor("label:Label_7"))

      compare(mailService.selectedId, "two",
        "the reader follows the action to the same next message as the cursor")
      compare(app.cursorId, "two",
        "App uses the raw query even though the old mailbox key is Starred")
      compare(account.messages.length, 1,
        "MailAccount uses the raw query to remove the row from the label view")
      compare(account.messages[0].id, "two")
    }

    function test_hey_refusal_crosses_the_real_service_before_the_picker() {
      installAccount("hey", "hey:me@hey.com", "me@hey.com")
      app.cursorId = "message-1"

      compare(app.openLabelPicker(), false)

      compare(named(app, "label-picker").opened, false)
      compare(mailService.actionStatus, "HEY has no destination you can name")
    }

    function test_imap_current_folder_is_not_a_uid_move_destination() {
      var account = installAccount("imap", "imap:me@example.com", "me@example.com")
      account.labels = [
        { id: "Receipts", name: "Receipts", rawName: "Receipts", system: false, unread: 0 },
        { id: "Archive", name: "Archive", rawName: "Archive", system: false, unread: 0 }
      ]

      var slot = labelSlot("Receipts")
      verify(slot >= 0)
      app.goSlot(slot)

      compare(account.rawLabelId, "Receipts")
      compare(ids(named(app, "label-picker").matchingLabels), "Archive",
        "the current folder cannot become a same-folder UID MOVE")
    }
  }
}
