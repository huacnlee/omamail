import QtQuick
import qs.Commons
import qs.Ui

// One message in the list. Unread is carried by weight and by the dot on the
// left, never by colour alone — the accent is a theme value that some themes
// put close to the foreground.
Rectangle {
  id: root

  required property var summary
  required property color textColor
  required property color accentColor
  required property color dimColor
  required property string panelFontFamily
  // Passed down rather than read off a service: a row draws one message and
  // has no other use for one.
  property bool canArchive: true
  property bool hasCursor: false
  property bool selected: false

  signal activated()
  signal starToggled()
  signal archiveRequested()
  signal trashRequested()
  signal menuRequested(real sceneX, real sceneY)

  readonly property bool hot: mouse.containsMouse || hasCursor

  width: parent ? parent.width : 0
  implicitHeight: body.implicitHeight + Style.space(14)
  radius: Style.cornerRadius
  color: selected
    ? Style.selectedFillFor(textColor, accentColor)
    : (hot ? Style.hoverFillFor(textColor, accentColor) : "transparent")

  MouseArea {
    id: mouse
    anchors.fill: parent
    hoverEnabled: true
    acceptedButtons: Qt.LeftButton | Qt.MiddleButton | Qt.RightButton
    onClicked: function(event) {
      if (event.button === Qt.RightButton) {
        var scene = mapToGlobal(event.x, event.y)
        root.menuRequested(scene.x, scene.y)
      } else if (event.button === Qt.MiddleButton) {
        // Middle-click archives: the one triage action worth having without
        // moving the pointer to a button.
        root.archiveRequested()
      } else {
        root.activated()
      }
    }
  }

  Rectangle {
    anchors.left: parent.left
    anchors.leftMargin: Style.space(4)
    anchors.top: parent.top
    anchors.topMargin: Style.space(12)
    width: Style.space(5)
    height: width
    radius: width / 2
    visible: root.summary.unread
    color: root.accentColor
  }

  Column {
    id: body
    anchors.left: parent.left
    anchors.right: actions.visible ? actions.left : parent.right
    // Matches the reader's content inset and the header's logo, so all three
    // columns start their text on one vertical line.
    anchors.leftMargin: Style.space(14)
    anchors.rightMargin: Style.space(8)
    anchors.verticalCenter: parent.verticalCenter
    spacing: Style.space(2)

    // The subject leads. It is what the message is, and it is what you scan a
    // list for; the sender had the top line and the weight, which put the
    // emphasis on who wrote rather than on what about.
    Item {
      width: parent.width
      implicitHeight: Math.max(subject.implicitHeight, time.implicitHeight)

      Text {
        id: subject
        anchors.left: parent.left
        anchors.right: time.left
        anchors.rightMargin: Style.space(8)
        // A stranger wrote this. Qt's default AutoText switches a string that
        // looks like markup into rich text, and rich text with an <img> in it is
        // a fetch — the same beacon the message body is stripped of.
        textFormat: Text.PlainText
        text: root.summary.subject
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.body
        font.bold: root.summary.unread
        elide: Text.ElideRight
      }

      Text {
        id: time
        anchors.right: parent.right
        anchors.baseline: subject.baseline
        textFormat: Text.PlainText
        text: root.summary.time
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }
    }

    Text {
      width: parent.width
      textFormat: Text.PlainText
      text: root.summary.from.display
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      elide: Text.ElideRight
    }

    Text {
      width: parent.width
      visible: root.summary.snippet !== ""
      textFormat: Text.PlainText
      text: root.summary.snippet
      color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.42)
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight
      maximumLineCount: 1
    }
  }

  // Row actions appear on hover or under the keyboard cursor. A starred
  // message keeps its star visible either way, because that is state rather
  // than an affordance.
  Row {
    id: actions
    anchors.right: parent.right
    anchors.rightMargin: Style.space(6)
    anchors.verticalCenter: parent.verticalCenter
    spacing: Style.space(1)
    visible: root.hot || root.summary.starred

    IconButton {
      iconName: "star"
      filled: root.summary.starred
      tooltipText: (root.summary.starred ? "Unstar" : "Star") + " · s"
      foreground: root.summary.starred ? root.accentColor : root.dimColor
      hoverColor: root.accentColor
      iconSize: Style.font.iconSmall
      size: Style.space(20)
      fontFamily: root.panelFontFamily
      onClicked: root.starToggled()
    }

    IconButton {
      // No archive button where the account has nowhere to archive to. On IMAP
      // that is a move to a folder, and a server without one would have this
      // quietly do nothing.
      visible: root.hot && root.canArchive
      iconName: "archive"
      tooltipText: "Archive · e"
      foreground: root.dimColor
      hoverColor: root.textColor
      iconSize: Style.font.iconSmall
      size: Style.space(20)
      fontFamily: root.panelFontFamily
      onClicked: root.archiveRequested()
    }

    IconButton {
      visible: root.hot
      iconName: "trash"
      tooltipText: "Move to trash · d"
      foreground: root.dimColor
      hoverColor: root.textColor
      iconSize: Style.font.iconSmall
      size: Style.space(20)
      fontFamily: root.panelFontFamily
      onClicked: root.trashRequested()
    }
  }
}
