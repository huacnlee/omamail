import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import "../../components" as Omamail

Item {
  width: 600
  height: 600

  QtObject {
    id: mailService
    property var contactBook: QtObject {
      property bool canReadMailboxBooks: true
      property var sources: []
      property var found: []
      property var forgotten: []
      function findBooks(id) { found = found.concat([id]); return true }
      function forgetBooks(id) { forgotten = forgotten.concat([id]); return true }
    }
  }

  Omamail.ContactsSettings {
    id: settings
    width: parent.width
    service: mailService
    textColor: Qt.rgba(1, 1, 1, 1)
    dimColor: Qt.rgba(0.6, 0.6, 0.6, 1)
    accentColor: Qt.rgba(1, 0.5, 0, 1)
    urgentColor: Qt.rgba(1, 0.27, 0.27, 1)
    panelFontFamily: "sans-serif"
  }

  TestCase {
    name: "ContactsSettings"
    when: windowShown

    function all(name) {
      var found = []
      function walk(item) {
        if (!item) return
        if (item.objectName === name && item.visible) found.push(item)
        for (var i = 0; i < item.children.length; i++) walk(item.children[i])
      }
      walk(settings)
      return found
    }

    function init() {
      mailService.contactBook.canReadMailboxBooks = true
      mailService.contactBook.found = []
      mailService.contactBook.forgotten = []
    }

    function test_sources_say_what_they_hold_and_offer_their_actions() {
      mailService.contactBook.sources = [
        { id: "local", count: 12 },
        { id: "imap:me@example.org", email: "me@example.org", state: "on", count: 118, error: "",
          books: [{ name: "Personal", contacts: 1 }, { name: "Directory", contacts: 117 }] },
        { id: "imap:new@example.org", email: "new@example.org", state: "off", count: 0, error: "",
          books: [], host: "mail.example.org" }
      ]
      wait(1)
      var details = all("contact-source-detail").map(function(item) { return item.text })
      verify(details[0].indexOf("12 addresses") >= 0, details[0])
      compare(details[1], "Personal (1), Directory (117) · 118 addresses")
      // Finding them sends the mailbox password to the mail host, which is
      // named before the button is pressed.
      compare(details[2], "Find address books on mail.example.org to suggest their people too. "
        + "This sends the mailbox password to that server over HTTPS, now and when "
        + "the books are read again in the background, at most every 30 minutes.")
      var finds = all("contact-source-find")
      compare(finds.length, 2)
      compare(finds[0].text, "Refresh")
      compare(finds[1].text, "Find address books")
      compare(all("contact-source-forget").length, 1, "only a mailbox using its books can stop")
      verify(finds[1].activeFocusOnTab, "the action is reachable with Tab")
      finds[1].forceActiveFocus()
      keyClick(Qt.Key_Return)
      compare(mailService.contactBook.found.join(), "imap:new@example.org")
      all("contact-source-forget")[0].clicked()
      compare(mailService.contactBook.forgotten.join(), "imap:me@example.org")
    }

    // A failure is named in words, not only colour, and a mailbox still
    // using its books says it is showing the last copy.
    function test_failures_are_named_and_known_reasons_only() {
      mailService.contactBook.sources = [
        { id: "local", count: 0 },
        { id: "imap:me@example.org", email: "me@example.org", state: "on", count: 2,
          error: "contacts_network_failed", books: [{ name: "Directory", contacts: 2 }] },
        { id: "imap:x@example.org", email: "x@example.org", state: "off", count: 0,
          error: "server said <b>boom</b>", books: [] },
        { id: "imap:y@example.org", email: "y@example.org", state: "loading", count: 0,
          error: "", books: [] }
      ]
      wait(1)
      var details = all("contact-source-detail").map(function(item) { return item.text })
      verify(details[1].indexOf("could not be reached; showing the last copy") > 0, details[1])
      compare(details[2], "The address books could not be read. "
        + "Find the address books on this mailbox's server to suggest their people too")
      compare(details[3], "Looking for address books...")
      var finds = all("contact-source-find")
      compare(finds[2].text, "Finding...")
      compare(finds[2].enabled, false)
    }

    // While a mailbox's books are being read again, neither Refresh nor Stop
    // using can be pressed: an answer must not land after a stop.
    function test_refresh_and_stop_wait_for_a_read_in_progress() {
      mailService.contactBook.sources = [
        { id: "local", count: 0 },
        { id: "imap:me@example.org", email: "me@example.org", state: "on", refreshing: true, count: 2,
          error: "", books: [{ name: "Directory", contacts: 2 }] }
      ]
      wait(1)
      var find = all("contact-source-find")[0]
      var stop = all("contact-source-forget")[0]
      compare(find.text, "Refreshing...")
      compare(find.enabled, false)
      compare(stop.enabled, false)
      mailService.contactBook.sources = [
        { id: "local", count: 0 },
        { id: "imap:me@example.org", email: "me@example.org", state: "off", count: 0,
          error: "contacts_server_changed", books: [], host: "new.example.org" }
      ]
      wait(1)
      // The reason, and still the consent: the new server is named, and so
      // is what pressing Find sends it.
      compare(all("contact-source-detail")[1].text, "This mailbox's server changed; find its address books again. "
        + "Find address books on new.example.org to suggest their people too. "
        + "This sends the mailbox password to that server over HTTPS, now and when "
        + "the books are read again in the background, at most every 30 minutes.")
    }

    function test_an_old_backend_lists_only_the_local_book() {
      mailService.contactBook.canReadMailboxBooks = false
      mailService.contactBook.sources = [
        { id: "local", count: 3 },
        { id: "imap:me@example.org", email: "me@example.org", state: "off", count: 0, error: "", books: [] }
      ]
      wait(1)
      compare(all("contact-source-find").length, 0)
      compare(all("contact-source-detail").length, 1)
    }
  }
}
