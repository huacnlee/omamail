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

  PanelActionButton {
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
