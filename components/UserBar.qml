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
  // The short name for the row; the address is the tooltip and the status
  // line. An address here was elided from the middle in every rail width
  // that mattered, which is the one way to make an address unreadable.
  property string label: ""
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
    // The rail's rows sit in a column inset by 6, and their glyphs 8 further
    // in; the avatar is the top of that same column of marks, so it takes
    // both, or it stands a step to the left of every icon under it.
    anchors.leftMargin: root.collapsed ? (parent.width - width) / 2 : Style.space(6) + Style.space(8)
    anchors.verticalCenter: parent.verticalCenter
    // The size of the rail's icons below it, so the column of marks down the
    // left edge is one column.
    width: Style.font.icon
    height: width
    radius: width / 2
    color: Style.selectedFillFor(root.textColor, root.accentColor)

    // Centred on the letter's ink, not its line box: a capital sits high in
    // the box, and centring the box puts it visibly above the middle of a
    // circle this small. Same correction ActionIcon makes for its glyphs.
    TextMetrics {
      id: initialMetrics
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      font.bold: true
      text: root.initial
    }

    Text {
      id: initialText
      text: root.initial
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      font.bold: true
      x: (avatar.width - initialMetrics.tightBoundingRect.width) / 2 - initialMetrics.tightBoundingRect.x
      y: (avatar.height - initialMetrics.tightBoundingRect.height) / 2
        - (initialText.baselineOffset + initialMetrics.tightBoundingRect.y)
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
    text: root.label !== "" ? root.label : (root.email === "" ? "Not connected" : root.email)
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.bodySmall
    elide: Text.ElideRight
  }

  HoverHandler { id: hover }

  TapHandler {
    onTapped: {
      var scene = root.mapToGlobal(0, 0)
      root.switcherRequested(scene.x, scene.y)
    }
  }

  PanelToolTip {
    visible: hover.hovered && (root.collapsed || root.label !== "")
    text: root.email === "" ? "Not connected" : root.email
    fontFamily: root.panelFontFamily
  }
}
