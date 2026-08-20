import QtQuick
import qs.Commons
import qs.Ui

// The account, at the foot of the sidebar. It is both the answer to "which
// mailbox am I looking at" and the way into the menu — which is where a
// desktop app puts its account controls, rather than behind an unlabelled
// glyph in the top corner.
Rectangle {
  id: root

  required property color textColor
  required property color accentColor
  required property color dimColor
  required property string panelFontFamily
  property string email: ""
  property bool collapsed: false

  // Two things live in this row: which mailbox you are in, and everything
  // else. The address switches accounts; the menu button opens app actions.
  signal switcherRequested(real sceneX, real sceneY)
  property int accountCount: 1

  readonly property string initial: email === "" ? "?" : email.charAt(0).toUpperCase()

  // Held while a popup this bar opened is on screen, so the popup reads as
  // belonging to it rather than as floating free.
  property bool switcherOpen: false

  implicitHeight: Style.space(38)
  radius: Style.cornerRadius
  color: root.switcherOpen
    ? Style.selectedFillFor(root.textColor, root.accentColor)
    : (hover.hovered ? Style.hoverFillFor(root.textColor, root.accentColor)
      : "transparent")

  // An initial rather than a picture: Gmail's own avatar is behind an API this
  // app does not ask permission for, and an address is always Latin script, so
  // one letter is safe here in a way a label name is not.
  Rectangle {
    id: avatar
    anchors.left: parent.left
    anchors.leftMargin: root.collapsed ? (parent.width - width) / 2 : Style.space(8)
    anchors.verticalCenter: parent.verticalCenter
    width: Style.space(22)
    height: width
    radius: width / 2
    color: Style.selectedFillFor(root.textColor, root.accentColor)

    Text {
      anchors.centerIn: parent
      text: root.initial
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      font.bold: true
    }
  }

  Text {
    visible: !root.collapsed
    anchors.left: avatar.right
    anchors.leftMargin: Style.space(8)
    anchors.right: parent.right
    anchors.rightMargin: Style.space(8)
    anchors.verticalCenter: parent.verticalCenter
    textFormat: Text.PlainText
    text: root.email === "" ? "Not connected" : root.email
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    elide: Text.ElideMiddle
  }

  HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }

  TapHandler {
    onTapped: function(point) {
      var scene = root.mapToGlobal(point.position.x, point.position.y)
      root.switcherRequested(scene.x, scene.y)
    }
  }

  PanelToolTip {
    visible: root.collapsed && hover.hovered
    text: root.email === "" ? "Not connected" : root.email
    fontFamily: root.panelFontFamily
  }
}
