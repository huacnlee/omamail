import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

// A named mailbox in the switcher.
//
// The address was the only thing here, deliberately: the only name available
// was the local part, and two mailboxes easily share one across different
// domains. A name somebody typed is the opposite case — it exists precisely to
// tell them apart — so it leads, and the address moves below rather than being
// lost.
Item {
  width: 600
  height: 400

  readonly property var mailboxes: [
    { id: "a@example.org", email: "a@example.org", label: "Private", name: "Private",
      unread: 2, active: true, signedIn: true, busy: false, error: "" },
    { id: "b@example.net", email: "b@example.net", label: "b", name: "",
      unread: 0, active: false, signedIn: true, busy: false, error: "" },
    { id: "c@example.com", email: "c@example.com", label: "Away", name: "Away",
      unread: 0, active: false, signedIn: false, busy: false, error: "" },
    { id: "d@example.com", email: "d@example.com", label: "Broken", name: "Broken",
      unread: 0, active: false, signedIn: true, busy: false, error: "the server refused that" }
  ]

  Omamail.AccountSwitcher {
    id: switcher
    anchors.fill: parent
    textColor: Qt.rgba(1, 1, 1, 1)
    accentColor: Qt.rgba(1, 0.5, 0, 1)
    urgentColor: Qt.rgba(1, 0.2, 0.2, 1)
    dimColor: Qt.rgba(0.67, 0.67, 0.67, 1)
    popupBackgroundColor: Qt.rgba(0.13, 0.13, 0.13, 1)
    popupBorderColor: Qt.rgba(0.47, 0.47, 0.47, 1)
    panelFontFamily: "monospace"
    accounts: mailboxes
  }

  TestCase {
    name: "AccountNames"
    when: windowShown

    function rows(item) {
      var found = []
      var node = item === undefined ? switcher.menuRows : item
      if (!node) return found
      if (node.objectName === "account-row") found.push(node)
      var children = node.children || []
      for (var i = 0; i < children.length; i++)
        found = found.concat(rows(children[i]))
      return found
    }

    function init() {
      switcher.close()
      switcher.openCentered()
      wait(20)
    }

    function cleanup() { switcher.close() }

    function test_a_named_mailbox_leads_with_its_name() {
      var all = rows()
      compare(all.length, 4)
      compare(all[0].named, true)
      compare(all[0].primaryText, "Private")
      compare(all[0].secondaryText, "a@example.org",
        "the address moves down rather than being lost")
    }

    // An empty name is not a name, so nothing changes for that mailbox.
    function test_an_unnamed_mailbox_is_unchanged() {
      var all = rows()
      compare(all[1].named, false)
      compare(all[1].primaryText, "b@example.net")
      compare(all[1].secondaryText, "",
        "it has already said everything its address says")
    }

    // A name never hides a reason the mailbox cannot be used: the second line
    // is that reason first and the address only when there is nothing wrong.
    function test_a_reason_it_cannot_be_used_beats_the_address() {
      var all = rows()
      compare(all[2].named, true)
      compare(all[2].primaryText, "Away")
      compare(all[2].secondaryText, "Signed out")

      compare(all[3].primaryText, "Broken")
      compare(all[3].secondaryText, "the server refused that")
    }

    // The avatar follows the name, because an initial taken from the address
    // would not match the word above it.
    function test_the_initial_follows_the_name() {
      var all = rows()
      var initial = null
      var found = []
      function walk(node) {
        if (!node) return
        if (node.text !== undefined && String(node.text).length === 1) found.push(node)
        var children = node.children || []
        for (var i = 0; i < children.length; i++) walk(children[i])
      }
      walk(all[0])
      verify(found.length > 0, "the row draws an initial")
      compare(String(found[0].text), "P", "from Private, not from a@example.org")
    }
  }
}
