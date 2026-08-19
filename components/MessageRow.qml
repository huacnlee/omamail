import QtQuick
import qs.Commons
import qs.Ui

// One message in the list. Unread is carried by weight and by the dot on the
// left, never by colour alone — the accent colour is a theme value that some
// themes make nearly identical to the foreground.
Rectangle {
  id: root

  required property var summary
  required property color textColor
  required property color accentColor
  required property string panelFontFamily
  property bool hasCursor: false
  property bool selected: false

  signal activated()
  signal starToggled()
  signal archiveRequested()
  signal trashRequested()
  signal hovered(bool isHovered)

  readonly property bool hot: mouse.containsMouse || hasCursor
  readonly property color dim: Qt.rgba(textColor.r, textColor.g, textColor.b, 0.55)

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
    acceptedButtons: Qt.LeftButton | Qt.MiddleButton
    onEntered: root.hovered(true)
    onExited: root.hovered(false)
    onClicked: function(event) {
      // Middle-click archives, which is the one triage action worth having
      // without moving the pointer to a button.
      if (event.button === Qt.MiddleButton) root.archiveRequested()
      else root.activated()
    }
  }

  Rectangle {
    id: unreadDot
    anchors.left: parent.left
    anchors.leftMargin: Style.space(6)
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
    anchors.leftMargin: Style.space(16)
    anchors.rightMargin: Style.space(8)
    anchors.verticalCenter: parent.verticalCenter
    spacing: Style.space(2)

    Item {
      width: parent.width
      implicitHeight: Math.max(sender.implicitHeight, time.implicitHeight)

      Text {
        id: sender
        anchors.left: parent.left
        anchors.right: time.left
        anchors.rightMargin: Style.space(8)
        text: root.summary.from.display
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        font.bold: root.summary.unread
        elide: Text.ElideRight
      }

      Text {
        id: time
        anchors.right: parent.right
        anchors.baseline: sender.baseline
        text: root.summary.time
        color: root.dim
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }
    }

    Text {
      width: parent.width
      text: root.summary.subject
      color: root.summary.unread ? root.textColor : root.dim
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: root.summary.unread
      elide: Text.ElideRight
    }

    Text {
      width: parent.width
      visible: root.summary.snippet !== ""
      text: root.summary.snippet
      color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.42)
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight
      maximumLineCount: 1
    }
  }

  // The row actions appear on hover or under the keyboard cursor. A starred
  // message keeps its star visible either way, because that is state rather
  // than an affordance.
  Row {
    id: actions
    anchors.right: parent.right
    anchors.rightMargin: Style.space(6)
    anchors.verticalCenter: parent.verticalCenter
    spacing: Style.space(2)
    visible: root.hot || root.summary.starred

    PanelActionButton {
      iconText: root.summary.starred ? "★" : "☆"
      tooltipText: root.summary.starred ? "Unstar" : "Star"
      foreground: root.summary.starred ? root.accentColor : root.dim
      fontSize: Style.font.bodySmall
      onClicked: root.starToggled()
    }

    PanelActionButton {
      visible: root.hot
      iconText: "↓"
      tooltipText: "Archive"
      foreground: root.dim
      fontSize: Style.font.bodySmall
      onClicked: root.archiveRequested()
    }

    PanelActionButton {
      visible: root.hot
      iconText: "🗑"
      tooltipText: "Move to trash"
      foreground: root.dim
      fontSize: Style.font.bodySmall
      onClicked: root.trashRequested()
    }
  }
}
