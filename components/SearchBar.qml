import QtQuick
import qs.Commons
import qs.Ui

// Gmail's own operator syntax goes straight through — `from:`, `has:attachment`,
// `older_than:7d`. Translating it would only take away what people already know.
Item {
  id: root

  required property color textColor
  required property color accentColor
  required property string panelFontFamily
  property bool serverSearching: false

  // Keep the words while the field has room for both them and the query. The
  // rotating refresh remains at narrow widths, where a status sentence would
  // leave almost no editable field behind.
  readonly property bool showServerLabel: width >= Style.space(260)

  signal submitted(string query)
  signal cleared()

  // The window's single-letter shortcuts stand down while this has focus.
  readonly property bool fieldFocused: field.activeFocus
  // What Escape has to decide between clearing and leaving alone. The window
  // owns that decision now: a window Shortcut beats a focused item's Keys
  // handler, so a local one here would look live and never run.
  readonly property string queryText: field.text

  implicitHeight: field.implicitHeight

  function focusField() {
    field.forceActiveFocus()
    field.selectAll()
  }

  function clear() {
    field.text = ""
    root.cleared()
  }

  TextField {
    id: field
    anchors.fill: parent
    foreground: root.textColor
    accent: root.accentColor
    // The operator examples earn their place: they are the whole reason the
    // field takes Gmail syntax straight through, and nowhere else says so at
    // the moment you would use it.
    placeholderText: "Search mail — from:jane has:attachment"
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.bodySmall
    rightPadding: horizontalPadding + Style.space(22)
      + (root.serverSearching ? serverState.width + Style.space(7) : 0)
    onAccepted: root.submitted(text.trim())

    // Quieter than the kit's own control surface, which outlines the field at
    // rest. Nothing in the header is used less often than search, and an
    // outlined box that wide was the loudest thing in a row of dim icons. It
    // draws itself when the pointer is on it and commits to a border only once
    // it has focus, which is the moment the outline is actually telling you
    // something. The padding is unchanged either way, so nothing shifts.
    background: Rectangle {
      radius: Style.cornerRadius
      color: field.activeFocus || field.hovered
        ? Style.hoverFillFor(root.textColor, root.accentColor)
        : Style.normalFillFor(root.textColor, root.accentColor)
      border.width: 1
      // A divider's weight, not a control's. The kit's control border is what
      // made this the loudest thing in a row of dim icons; the rail's edge is
      // drawn at 0.12 of the foreground and is present without announcing
      // itself, which is what a field nobody uses on most visits should be.
      // Focus still gets the real border, because then it is saying something.
      border.color: field.activeFocus
        ? Style.hoverBorderFor(root.textColor, root.accentColor)
        : Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.12)
    }
  }

  Item {
    id: serverState
    anchors.right: clearButton.left
    anchors.rightMargin: Style.space(3)
    anchors.verticalCenter: parent.verticalCenter
    visible: root.serverSearching
    width: visible ? serverStateRow.implicitWidth : 0
    height: Style.space(22)

    Row {
      id: serverStateRow
      anchors.centerIn: parent
      spacing: root.showServerLabel ? Style.space(5) : 0

      ActionIcon {
        anchors.verticalCenter: parent.verticalCenter
        name: "refresh"
        iconSize: Style.font.iconSmall
        color: root.accentColor

        RotationAnimator on rotation {
          from: 0
          to: 360
          duration: 900
          loops: Animation.Infinite
          running: root.serverSearching
        }
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: root.showServerLabel
        text: "Searching server"
        textFormat: Text.PlainText
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }

  PanelActionButton {
    id: clearButton
    anchors.right: parent.right
    anchors.rightMargin: Style.space(4)
    anchors.verticalCenter: parent.verticalCenter
    visible: field.text !== ""
    iconText: "×"
    tooltipText: "Clear search · Esc"
    foreground: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.55)
    hoverColor: root.textColor
    fontSize: Style.font.body
    onClicked: root.clear()
  }
}
