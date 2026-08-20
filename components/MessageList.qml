import QtQuick
import qs.Commons
import qs.Ui
import "../Model.js" as Model

// The message list. A Repeater in a Column rather than a ListView because the
// panel already owns one Flickable and nesting a second scroller inside it
// gives every wheel event two plausible targets.
Column {
  id: root

  required property var service
  required property color textColor
  required property color accentColor
  required property color dimColor
  required property string panelFontFamily
  property string cursorId: ""

  signal messageActivated(string id)
  signal rowHovered(string id, bool isHovered)
  signal menuRequested(string id, real sceneX, real sceneY)

  width: parent ? parent.width : 0
  spacing: Style.space(2)

  Repeater {
    model: root.service.messages

    MessageRow {
      required property var modelData

      summary: modelData
      textColor: root.textColor
      accentColor: root.accentColor
      dimColor: root.dimColor
      panelFontFamily: root.panelFontFamily
      hasCursor: root.cursorId === modelData.id
      selected: root.service.selectedId === modelData.id
      canArchive: root.service.canArchive
      onActivated: root.messageActivated(modelData.id)
      onStarToggled: root.service.toggleStar(modelData.id)
      onArchiveRequested: root.service.act(modelData.id, "archive")
      onTrashRequested: root.service.act(modelData.id, "trash")
      onHovered: function(isHovered) { root.rowHovered(modelData.id, isHovered) }
      onMenuRequested: function(sceneX, sceneY) {
        root.menuRequested(modelData.id, sceneX, sceneY)
      }
    }
  }

  // Three states share this slot, and only one of them is an error: still
  // loading, loaded and empty, or nothing loaded yet.
  Item {
    width: parent.width
    visible: root.service.messages.length === 0
    implicitHeight: Style.space(70)

    Text {
      anchors.centerIn: parent
      width: parent.width - Style.space(20)
      horizontalAlignment: Text.AlignHCenter
      text: root.service.listLoading
        ? "Loading…"
        : (root.service.listLoaded
          ? (root.service.searchQuery !== "" ? "Nothing matches that search" : "Nothing here")
          : "")
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      wrapMode: Text.WordWrap
    }
  }

  Item {
    width: parent.width
    visible: root.service.hasMore || root.service.messages.length > 0
    implicitHeight: Style.space(30)

    Text {
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      text: root.service.resultSummary
      color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.42)
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
    }

    Button {
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      visible: root.service.hasMore
      text: root.service.listLoading ? "Loading…" : "Load more"
      foreground: root.textColor
      bordered: false
      fontSize: Style.font.caption
      enabled: !root.service.listLoading
      onClicked: root.service.loadMore()
    }
  }
}
