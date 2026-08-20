import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "../message/Message.js" as Mail

// Composing takes over the whole content area of the one window rather than
// opening a second one: Omarchy's panel mechanism would give an extra window
// its own region, which is not what a reply is. Two mail accounts would
// justify two windows; a reply does not.
//
// Compose, reply, reply-all and forward are the same form with different
// starting values, so `begin()` fills the fields and everything after that is
// one code path.
Item {
  id: root

  required property var service
  required property color textColor
  required property color backgroundColor
  required property color accentColor
  required property color dimColor
  required property color dimmerColor
  required property string panelFontFamily

  property bool opened: false
  property string mode: "new"
  property string threadId: ""
  property string inReplyTo: ""
  property bool ccVisible: false

  readonly property string title: {
    if (mode === "reply") return "REPLY"
    if (mode === "replyAll") return "REPLY ALL"
    if (mode === "forward") return "FORWARD"
    return "NEW MESSAGE"
  }
  readonly property string iconName: {
    if (mode === "reply") return "reply"
    if (mode === "replyAll") return "replyAll"
    if (mode === "forward") return "forward"
    return "unread"
  }

  function reset() {
    toField.text = ""
    ccField.text = ""
    subjectField.text = ""
    bodyEdit.text = ""
    mode = "new"
    threadId = ""
    inReplyTo = ""
    ccVisible = false
  }

  // Everyone on the original except this mailbox: replying to yourself is
  // never what reply-all was for.
  function otherRecipients(summary) {
    if (!summary) return ""
    var mine = String(root.service ? root.service.accountEmail : "").toLowerCase()
    var list = Array.isArray(summary.to) ? summary.to : []
    var kept = []
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].email || "").toLowerCase() === mine) continue
      kept.push(list[i].email)
    }
    return kept.join(", ")
  }

  function begin(nextMode, summary, bodyText) {
    reset()
    mode = String(nextMode || "new")
    opened = true

    if (summary && mode !== "new") {
      var replyTo = summary.replyTo && summary.replyTo.email
        ? summary.replyTo.email : summary.from.email
      threadId = summary.threadId
      inReplyTo = summary.messageId

      if (mode === "forward") {
        subjectField.text = "Fwd: " + summary.subject
      } else {
        toField.text = replyTo
        subjectField.text = Mail.replySubject(summary.subject)
        if (mode === "replyAll") {
          ccField.text = otherRecipients(summary)
          ccVisible = ccField.text !== ""
        }
      }
      bodyEdit.text = "\n\n" + Mail.quoteBody(summary, String(bodyText || ""))
    }

    // Focus is not placed here. Opening this changes the window's key context,
    // and the context is what moves the keyboard — one mechanism, so the two
    // cannot disagree about where the typing goes.
  }

  // Where the keyboard goes when composing becomes the context. A reply starts
  // in the body above the quote; a new message starts at the address.
  function takeFocus() {
    if (mode === "reply" || mode === "replyAll") {
      bodyEdit.forceActiveFocus()
      bodyEdit.cursorPosition = 0
    } else {
      toField.forceActiveFocus()
    }
  }

  function finish() {
    reset()
    opened = false
  }

  function submit() {
    if (!service) return
    service.send(({
      to: toField.text,
      cc: ccField.text,
      subject: subjectField.text,
      body: bodyEdit.text,
      // A forward starts a new conversation; a reply must stay in the old one.
      threadId: root.mode === "forward" ? "" : root.threadId,
      inReplyTo: root.mode === "forward" ? "" : root.inReplyTo
    }))
  }

  anchors.fill: parent
  // Only while it is actually in use. A component that declares `focus: true`
  // owns the window's focus even when invisible — Qt does not exclude hidden
  // items — and an owner that accepts keys is a sink. This swallowed every
  // Escape in the window, which is why Esc looked intermittent: whether it
  // worked depended on where the user had last clicked.
  focus: root.opened

  // ----------------------------------------------------------- header
  //
  // There is no client-side titlebar under Hyprland, so the window has to
  // say what it is itself.
  Item {
    id: head
    anchors.top: parent.top
    anchors.left: parent.left
    anchors.right: parent.right
    height: backBar.implicitHeight + Style.space(14) + titleRow.implicitHeight
      + Style.space(24)

    // Its own line, level with the reader's and the setup page's. Sharing a
    // line with the title made it read as part of the title on this page and
    // as a page control on the others.
    BackBar {
      id: backBar
      anchors.left: parent.left
      anchors.leftMargin: Style.space(14)
      anchors.top: parent.top
      anchors.topMargin: Style.space(12)
      textColor: root.textColor
      dimColor: root.dimColor
      panelFontFamily: root.panelFontFamily
      onActivated: root.finish()
    }

    Row {
      id: titleRow
      anchors.left: parent.left
      anchors.leftMargin: Style.space(14)
      anchors.right: parent.right
      anchors.rightMargin: Style.space(18)
      anchors.top: backBar.bottom
      anchors.topMargin: Style.space(14)
      spacing: Style.space(10)

      ActionIcon {
        anchors.verticalCenter: parent.verticalCenter
        name: root.iconName
        iconSize: Style.font.icon
        color: root.textColor
      }

      PanelSectionHeader {
        anchors.verticalCenter: parent.verticalCenter
        text: root.title
        foreground: root.textColor
        fontFamily: root.panelFontFamily
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: root.mode !== "new"
        textFormat: Text.PlainText
        text: subjectField.text
        color: root.dimmerColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
      }
    }

    PanelSeparator {
      anchors.bottom: parent.bottom
      width: parent.width
      foreground: root.textColor
    }
  }

  // ----------------------------------------------------------- fields
  //
  // A label column wide enough for the longest of To / Cc / Subject keeps
  // the three inputs aligned without a grid.

  Column {
    id: fields
    anchors.top: head.bottom
    anchors.left: parent.left
    anchors.right: parent.right

    Item {
      width: parent.width
      implicitHeight: Style.space(34)

      Text {
        id: toLabel
        anchors.left: parent.left
        anchors.leftMargin: Style.space(18)
        anchors.verticalCenter: parent.verticalCenter
        width: Style.space(52)
        horizontalAlignment: Text.AlignRight
        text: "To"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      Button {
        id: ccToggle
        anchors.right: parent.right
        anchors.rightMargin: Style.space(18)
        anchors.verticalCenter: parent.verticalCenter
        text: "Cc"
        foreground: root.ccVisible ? root.textColor : root.dimColor
        bordered: false
        fontSize: Style.font.caption
        onClicked: root.ccVisible = !root.ccVisible
      }

      TextField {
        id: toField
        anchors.left: toLabel.right
        anchors.leftMargin: Style.space(10)
        anchors.right: ccToggle.left
        anchors.rightMargin: Style.space(8)
        anchors.verticalCenter: parent.verticalCenter
        foreground: root.textColor
        accent: root.accentColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        placeholderText: "recipient@example.com"
        onAccepted: subjectField.forceActiveFocus()
      }

      PanelSeparator {
        anchors.bottom: parent.bottom
        width: parent.width
        foreground: root.textColor
      }
    }

    Item {
      visible: root.ccVisible
      width: parent.width
      implicitHeight: Style.space(34)

      Text {
        id: ccLabel
        anchors.left: parent.left
        anchors.leftMargin: Style.space(18)
        anchors.verticalCenter: parent.verticalCenter
        width: Style.space(52)
        horizontalAlignment: Text.AlignRight
        text: "Cc"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      TextField {
        id: ccField
        anchors.left: ccLabel.right
        anchors.leftMargin: Style.space(10)
        anchors.right: parent.right
        anchors.rightMargin: Style.space(18)
        anchors.verticalCenter: parent.verticalCenter
        foreground: root.textColor
        accent: root.accentColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        onAccepted: subjectField.forceActiveFocus()
      }

      PanelSeparator {
        anchors.bottom: parent.bottom
        width: parent.width
        foreground: root.textColor
      }
    }

    Item {
      width: parent.width
      implicitHeight: Style.space(34)

      Text {
        id: subjectLabel
        anchors.left: parent.left
        anchors.leftMargin: Style.space(18)
        anchors.verticalCenter: parent.verticalCenter
        width: Style.space(52)
        horizontalAlignment: Text.AlignRight
        text: "Subject"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      TextField {
        id: subjectField
        anchors.left: subjectLabel.right
        anchors.leftMargin: Style.space(10)
        anchors.right: parent.right
        anchors.rightMargin: Style.space(18)
        anchors.verticalCenter: parent.verticalCenter
        foreground: root.textColor
        accent: root.accentColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        placeholderText: "Subject"
        onAccepted: bodyEdit.forceActiveFocus()
      }

      PanelSeparator {
        anchors.bottom: parent.bottom
        width: parent.width
        foreground: root.textColor
      }
    }
  }

  // ------------------------------------------------------------- body
  //
  // The kit has no multi-line field, so this is a TextEdit on the plain
  // window ground; the rows above already carry the structure.
  Flickable {
    id: bodyFlick
    anchors.top: fields.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: actions.top
    anchors.leftMargin: Style.space(18)
    anchors.rightMargin: Style.space(18)
    anchors.topMargin: Style.space(12)
    contentWidth: width
    contentHeight: bodyEdit.height
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

    TextEdit {
      id: bodyEdit
      width: bodyFlick.width
      // Tall enough to fill the visible area even when the draft is short.
      // A TextEdit sized to its text leaves the space below it belonging to
      // the Flickable, so clicking into the empty part of a mostly-empty
      // message does nothing at all.
      height: Math.max(implicitHeight, bodyFlick.height)
      selectByMouse: true
      wrapMode: TextEdit.Wrap
      textFormat: TextEdit.PlainText
      color: root.textColor
      selectionColor: Style.selectionFillFor(root.textColor, root.accentColor)
      selectedTextColor: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
    }
  }

  // ---------------------------------------------------------- actions

  Item {
    id: actions
    anchors.bottom: parent.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    height: Style.space(52)

    PanelSeparator {
      anchors.top: parent.top
      width: parent.width
      foreground: root.textColor
    }

    Row {
      anchors.left: parent.left
      anchors.leftMargin: Style.space(18)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(10)

      IconTextButton {
        iconName: "send"
        tooltipText: "Send · Ctrl+Enter"
        text: root.service && root.service.sending ? "Sending…" : "Send"
        foreground: root.textColor
        fontFamily: root.panelFontFamily
        enabled: !!root.service && !root.service.sending
        onClicked: root.submit()
      }

      Button {
        text: "Discard"
        foreground: root.dimColor
        bordered: false
        fontSize: Style.font.bodySmall
        onClicked: root.finish()
      }
    }

    Text {
      anchors.right: parent.right
      anchors.rightMargin: Style.space(18)
      anchors.verticalCenter: parent.verticalCenter
      text: "Ctrl+Enter sends · Esc closes"
      color: root.dimmerColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
    }
  }

}
