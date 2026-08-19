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
    placeholderText: "Search mail — from:jane has:attachment"
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.bodySmall
    rightPadding: horizontalPadding + Style.space(22)
    onAccepted: root.submitted(text.trim())

    // Escape clears the query before it reaches the window, where the same key
    // would close the whole thing.
    Keys.onEscapePressed: function(event) {
      if (text === "") return
      root.clear()
      event.accepted = true
    }
  }

  PanelActionButton {
    anchors.right: parent.right
    anchors.rightMargin: Style.space(4)
    anchors.verticalCenter: parent.verticalCenter
    visible: field.text !== ""
    iconText: "×"
    tooltipText: "Clear search"
    foreground: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.55)
    hoverColor: root.textColor
    fontSize: Style.font.body
    onClicked: root.clear()
  }
}
