import QtQuick
import qs.Commons
import qs.Ui
import "../backend/Plain.js" as Plain

// Where recipient and guest suggestions come from. The local book is always
// read; an IMAP mailbox's address books on its own server are found here on
// request, because looking for them signs in to the server's web address
// with the mailbox password. Read only: nothing here changes a contact.
Column {
  id: root

  required property var service
  required property color textColor
  required property color dimColor
  required property color accentColor
  required property color urgentColor
  required property string panelFontFamily

  // A delegate's modelData is a reference object, not a JavaScript record;
  // the rows are judged on a plain copy.
  readonly property var book: service ? service.contactBook : null
  readonly property var sources: {
    var values = book ? Plain.plain(book.sources) : []
    return Array.isArray(values) ? values : []
  }
  readonly property var localSource: sources.length > 0 && sources[0].id === "local" ? sources[0] : null
  readonly property var mailboxSources: sources.filter(function(source) { return source.id !== "local" })
  readonly property bool available: !!book && book.canReadMailboxBooks === true

  spacing: Style.space(16)

  function count(value, one, many) {
    var number = Number(value) || 0
    return number + " " + (number === 1 ? one : many)
  }

  // Known reasons only; a server's own text never reaches the page.
  function failure(code) {
    if (code === "contacts_auth_refused") return "The server refused the mailbox password"
    if (code === "contacts_not_found") return "No address books were found on this mailbox's server"
    if (code === "contacts_timeout") return "The server took too long to answer"
    if (code === "contacts_network_failed") return "The server could not be reached"
    if (code === "contacts_response_too_large") return "The address books are too large to read"
    if (code === "contacts_server_changed") return "This mailbox's server changed; find its address books again"
    if (code === "" || code === undefined) return ""
    return "The address books could not be read"
  }

  function booksText(source) {
    var books = Array.isArray(source.books) ? source.books : []
    if (books.length === 0) return "No address books on this server"
    var parts = []
    for (var i = 0; i < books.length; i++)
      parts.push(String(books[i].name || "Address book") + " (" + (Number(books[i].contacts) || 0) + ")")
    return parts.join(", ")
  }

  function detail(source) {
    if (source.state === "loading") return "Looking for address books..."
    if (source.state !== "on") {
      // Finding them signs in to the mail host with the mailbox password, so
      // the host is named before the button is pressed, whatever went wrong
      // last time: a reason is said first, never instead of the consent.
      var problem = failure(source.error)
      var consent = source.host
        ? "Find address books on " + source.host + " to suggest their people too. "
          + "This sends the mailbox password to that server over HTTPS, now and when "
          + "the books are read again in the background, at most every 30 minutes."
        : "Find the address books on this mailbox's server to suggest their people too"
      return problem !== "" ? problem + ". " + consent : consent
    }
    var text = booksText(source) + " · " + count(source.count, "address", "addresses")
    if (source.error !== "")
      text += " · " + failure(source.error) + "; showing the last copy"
    return text
  }

  component SettingRow: Rectangle {
    id: settingRow
    property string title: ""
    property string detail: ""
    property color detailColor: root.dimColor
    default property alias controls: rowControls.data
    width: parent ? parent.width : 0
    implicitHeight: Math.max(settingText.implicitHeight, rowControls.implicitHeight) + Style.space(16)
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.textColor, root.accentColor)
    Column {
      id: settingText
      anchors.left: parent.left
      anchors.leftMargin: Style.space(12)
      anchors.right: rowControls.left
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)
      Text {
        width: parent.width
        text: settingRow.title
        textFormat: Text.PlainText
        elide: Text.ElideMiddle
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
      }
      Text {
        objectName: "contact-source-detail"
        width: parent.width
        visible: text !== ""
        text: settingRow.detail
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: settingRow.detailColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }
    }
    Row {
      id: rowControls
      anchors.right: parent.right
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(6)
    }
  }

  Column {
    width: parent.width
    spacing: Style.space(4)
    Text {
      text: "CONTACTS"
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      font.letterSpacing: 1
    }
    Text {
      width: parent.width
      text: "People suggested when you address a message or invite guests. Address books are only read, never changed."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
      textFormat: Text.PlainText
    }
  }

  Column {
    width: parent.width
    spacing: Style.space(2)

    SettingRow {
      objectName: "contact-source-local"
      title: "On this computer"
      detail: "Thunderbird, contacts files and people in mail you have read · "
        + root.count(root.localSource ? root.localSource.count : 0, "address", "addresses")
    }

    Repeater {
      model: root.available ? root.mailboxSources : []

      SettingRow {
        id: mailboxRow
        required property var modelData
        objectName: "contact-source-mailbox"
        title: String(modelData.email || modelData.id)
        detail: root.detail(Plain.plain(modelData))
        detailColor: modelData.error !== "" ? root.urgentColor : root.dimColor

        Button {
          objectName: "contact-source-find"
          focusable: true
          bordered: true
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          fontSize: Style.font.caption
          enabled: mailboxRow.modelData.state !== "loading" && !mailboxRow.modelData.refreshing
          text: mailboxRow.modelData.state === "loading" ? "Finding..."
            : mailboxRow.modelData.refreshing ? "Refreshing..."
            : mailboxRow.modelData.state === "on" ? "Refresh" : "Find address books"
          onClicked: root.book.findBooks(mailboxRow.modelData.id)
        }
        Button {
          objectName: "contact-source-forget"
          visible: mailboxRow.modelData.state === "on"
          focusable: true
          bordered: true
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          fontSize: Style.font.caption
          text: "Stop using"
          // Not while a read is out: its answer would arrive after the stop.
          enabled: !mailboxRow.modelData.refreshing
          onClicked: root.book.forgetBooks(mailboxRow.modelData.id)
        }
      }
    }
  }
}
