import QtQuick
import qs.Commons

Rectangle {
  id: root

  required property var contacts
  required property color textColor
  required property color dimColor
  required property color accentColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily

  property int currentIndex: -1

  signal chosen(var contact)

  onContactsChanged: currentIndex = -1
  onVisibleChanged: if (!visible) currentIndex = -1

  function moveSelection(delta) {
    var count = contacts ? contacts.length : 0
    if (count === 0) { currentIndex = -1; return }
    if (currentIndex < 0)
      currentIndex = Number(delta) < 0 ? count - 1 : 0
    else
      currentIndex = Math.max(0, Math.min(count - 1, currentIndex + Number(delta)))
    suggestions.positionViewAtIndex(currentIndex, ListView.Contain)
  }

  function acceptSelection() {
    var count = contacts ? contacts.length : 0
    if (count === 0) return false
    var index = currentIndex >= 0 && currentIndex < count ? currentIndex : 0
    chosen(contacts[index])
    return true
  }

  visible: contacts.length > 0
  implicitHeight: Math.min(suggestions.contentHeight, Style.space(210)) + Style.space(4)
  height: implicitHeight
  radius: Style.cornerRadius
  // Theme popup colors may carry transparency for floating shell panels.
  // This menu sits over form rows, so preserve its hue but make it opaque.
  color: Qt.rgba(popupBackgroundColor.r, popupBackgroundColor.g, popupBackgroundColor.b, 1)
  border.width: 1
  border.color: popupBorderColor

  ListView {
    id: suggestions
    anchors.fill: parent
    anchors.margins: Style.space(2)
    clip: true
    model: root.contacts

    delegate: Rectangle {
      id: suggestion
      required property var modelData
      required property int index

      width: suggestions.width
      height: Style.space(40)
      radius: Style.cornerRadius
      color: root.currentIndex === suggestion.index
        ? Style.selectedFillFor(root.textColor, root.accentColor)
        : (suggestionHover.hovered
          ? Style.hoverFillFor(root.textColor, root.accentColor) : "transparent")

      Column {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.leftMargin: Style.space(9)
        anchors.rightMargin: Style.space(9)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(1)

        Text {
          width: parent.width
          textFormat: Text.PlainText
          text: String(suggestion.modelData.name || suggestion.modelData.email || "")
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          elide: Text.ElideRight
        }

        Text {
          visible: String(suggestion.modelData.name || "") !== ""
          width: parent.width
          textFormat: Text.PlainText
          text: String(suggestion.modelData.email || "")
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideMiddle
        }
      }

      HoverHandler { id: suggestionHover }
      TapHandler { onTapped: root.chosen(suggestion.modelData) }
    }
  }
}
