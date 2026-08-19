import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "../Model.js" as Model

// The left column: the six built-in mailboxes, then whatever labels the user
// has made. Collapsed to a strip of initials on medium windows, gone entirely
// on narrow ones, where MailboxTabs takes over.
Item {
  id: root

  required property var service
  required property color textColor
  required property color accentColor
  required property color dimColor
  required property string panelFontFamily
  property bool collapsed: false

  signal mailboxSelected(string key)
  signal labelSelected(string labelId, string name)

  readonly property var userLabels: {
    var all = root.service ? root.service.labels : []
    var out = []
    for (var i = 0; i < all.length; i++) {
      if (!all[i].system) out.push(all[i])
    }
    return out
  }

  Flickable {
    id: flick
    anchors.fill: parent
    anchors.margins: Style.space(8)
    contentWidth: width
    contentHeight: column.implicitHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

    Column {
      id: column
      width: flick.width
      spacing: Style.space(1)

      Repeater {
        model: Model.MAILBOXES

        Entry {
          required property var modelData
          label: modelData.label
          count: modelData.key === "inbox" && root.service ? root.service.inboxUnread : 0
          selected: !!root.service && root.service.mailboxKey === modelData.key
            && root.service.searchQuery === ""
          onActivated: root.mailboxSelected(modelData.key)
        }
      }

      Item {
        width: parent.width
        implicitHeight: Style.space(14)
        visible: root.userLabels.length > 0

        PanelSeparator {
          anchors.verticalCenter: parent.verticalCenter
          width: parent.width
          foreground: root.textColor
        }
      }

      PanelSectionHeader {
        visible: root.userLabels.length > 0 && !root.collapsed
        leftPadding: Style.space(10)
        text: "LABELS"
        foreground: root.textColor
        fontFamily: root.panelFontFamily
      }

      Item {
        width: parent.width
        implicitHeight: Style.space(4)
        visible: root.userLabels.length > 0 && !root.collapsed
      }

      Repeater {
        model: root.userLabels

        Entry {
          required property var modelData
          label: modelData.name
          count: modelData.unread
          selected: !!root.service
            && root.service.searchQuery === "label:" + modelData.rawName
          onActivated: root.labelSelected(modelData.id, modelData.rawName)
        }
      }
    }
  }

  // A row that shows its full name when there is room and its first character
  // when there is not. The count survives the collapse as a dot: it is the
  // reason to look at this column at all.
  component Entry: Rectangle {
    id: entry
    required property string label
    property int count: 0
    property bool selected: false
    signal activated()

    width: column.width
    implicitHeight: Style.space(30)
    radius: Style.cornerRadius
    color: entry.selected
      ? Style.selectedFillFor(root.textColor, root.accentColor)
      : (hover.hovered ? Style.hoverFillFor(root.textColor, root.accentColor) : "transparent")

    Text {
      anchors.left: parent.left
      anchors.leftMargin: Style.space(10)
      anchors.right: badge.visible ? badge.left : parent.right
      anchors.rightMargin: Style.space(6)
      anchors.verticalCenter: parent.verticalCenter
      horizontalAlignment: root.collapsed ? Text.AlignHCenter : Text.AlignLeft
      text: root.collapsed ? entry.label.substring(0, 1) : entry.label
      color: entry.selected ? root.textColor : root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: entry.selected
      elide: Text.ElideRight
    }

    Text {
      id: badge
      anchors.right: parent.right
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      visible: entry.count > 0 && !root.collapsed
      text: Model.badgeText(entry.count, 999)
      color: root.accentColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      font.bold: true
    }

    Rectangle {
      visible: entry.count > 0 && root.collapsed
      anchors.right: parent.right
      anchors.rightMargin: Style.space(4)
      anchors.top: parent.top
      anchors.topMargin: Style.space(5)
      width: Style.space(4)
      height: width
      radius: width / 2
      color: root.accentColor
    }

    HoverHandler { id: hover }
    TapHandler { onTapped: entry.activated() }

    PanelToolTip {
      visible: root.collapsed && hover.hovered
      text: entry.label
      fontFamily: root.panelFontFamily
    }
  }
}
