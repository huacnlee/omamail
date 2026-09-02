import QtQuick
import qs.Commons
import qs.Ui

// The rail beside the settings page: its section names, one highlighted.
//
// It is for getting about a page that is long, not for splitting it into
// pages that are short. A click scrolls the page to the section; the
// highlight follows wherever the page is scrolled to, by whatever means. The
// page owns the scroll and the rules (`Model.activeSettingsSection`) decide
// the highlight, so this draws what it is given: the names, and which one.
//
// The rows look like the mailbox rail's, on purpose. A second kind of
// sidebar in the same window would be a second thing to learn.
Column {
  id: root

  // [{ key, title, y }], in the order the page shows them.
  property var sections: []
  property string activeKey: ""
  required property color textColor
  required property color dimColor
  required property color accentColor
  required property string panelFontFamily

  signal sectionRequested(string key)

  spacing: Style.space(2)

  Repeater {
    model: root.sections

    Rectangle {
      id: entry
      required property var modelData

      readonly property string key: String(modelData.key || "")
      readonly property bool selected: entry.key !== "" && entry.key === root.activeKey

      objectName: "settings-section-" + entry.key
      width: root.width
      implicitHeight: Style.space(28)
      radius: Style.cornerRadius
      color: entry.selected
        ? Style.selectedFillFor(root.textColor, root.accentColor)
        : (hover.hovered ? Style.hoverFillFor(root.textColor, root.accentColor) : "transparent")

      Text {
        anchors.left: parent.left
        anchors.leftMargin: Style.space(10)
        anchors.right: parent.right
        anchors.rightMargin: Style.space(6)
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: String(entry.modelData.title || "")
        color: entry.selected ? root.textColor : root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        // Weight as well as fill, so a theme whose selected fill is close to
        // the rail's ground still shows which row is current.
        font.bold: entry.selected
        elide: Text.ElideRight
      }

      HoverHandler { id: hover }
      TapHandler { onTapped: root.sectionRequested(entry.key) }
    }
  }
}
