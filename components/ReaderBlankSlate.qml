import QtQuick
import qs.Commons
import qs.Ui
import "../account/Model.js" as Model
import "../providers/Registry.js" as Provider

// What the reader shows before a message is picked.
//
// An empty pane is a chance to teach, not to decorate: this says which mailbox
// is open and how much is in it, then lists the keys that do something right
// now. Everything here is either state the user wanted to know or a shortcut
// they can use without moving the pointer.
Item {
  id: root

  required property var service
  required property color textColor
  required property color accentColor
  required property color dimColor
  required property color dimmerColor
  required property string panelFontFamily

  readonly property bool searching: !!service && service.searchQuery !== ""
  readonly property string mailboxName: searching
    ? "Search"
    : (service ? Provider.mailboxFor(service.providerId, service.mailboxKey).label : "Inbox")
  readonly property bool empty: !!service && service.listLoaded && service.messages.length === 0

  // The legend is the first thing to go when the pane gets tight: the heading
  // above it is the part that carries information.
  readonly property bool showLegend: height > Style.space(300) && width > Style.space(320)

  readonly property var keys: [
    { key: "j / k", action: "Move through the list" },
    { key: "Enter or o", action: "Open the selected message" },
    { key: "e", action: "Archive" },
    { key: "d", action: "Move to trash" },
    { key: "r", action: "Reply" },
    { key: "c", action: "Compose" }
  ]

  Column {
    anchors.centerIn: parent
    width: Math.min(parent.width - Style.space(48), Style.space(340))
    spacing: Style.space(10)

    ActionIcon {
      anchors.horizontalCenter: parent.horizontalCenter
      name: "gmail"
      brand: true
      iconSize: Style.space(44)
      strokeScale: 1.0
      color: Qt.rgba(root.dimColor.r, root.dimColor.g, root.dimColor.b, 0.5)
    }

    Item { width: 1; height: Style.space(4) }

    Text {
      width: parent.width
      horizontalAlignment: Text.AlignHCenter
      text: root.searching && root.service
        ? "\"" + Model.truncate(root.service.searchQuery, 36) + "\""
        : root.mailboxName
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.subtitle
      font.bold: true
      elide: Text.ElideRight
    }

    Text {
      width: parent.width
      horizontalAlignment: Text.AlignHCenter
      text: {
        if (!root.service) return ""
        if (root.service.listLoading && root.service.messages.length === 0) return "Fetching the mailbox…"
        if (root.empty) return root.searching ? "Nothing matches that search" : "Nothing here"
        return root.service.resultSummary + " · pick one to read it"
      }
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      wrapMode: Text.WordWrap
    }

    Item {
      width: parent.width
      height: Style.space(14)
      visible: root.showLegend && !root.empty

      PanelSeparator {
        anchors.verticalCenter: parent.verticalCenter
        anchors.horizontalCenter: parent.horizontalCenter
        width: Style.space(60)
        foreground: root.textColor
      }
    }

    Column {
      width: parent.width
      spacing: Style.space(3)
      visible: root.showLegend && !root.empty

      Repeater {
        model: root.keys

        Item {
          required property var modelData
          width: parent.width
          implicitHeight: Style.space(17)

          Text {
            anchors.right: parent.horizontalCenter
            anchors.rightMargin: Style.space(12)
            anchors.verticalCenter: parent.verticalCenter
            text: modelData.key
            color: root.dimColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
          }

          Text {
            anchors.left: parent.horizontalCenter
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: modelData.action
            color: root.dimmerColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }
      }

      Item { width: 1; height: Style.space(6) }

      Text {
        width: parent.width
        horizontalAlignment: Text.AlignHCenter
        text: "Ctrl+? for every shortcut"
        color: root.dimmerColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }
}
