import QtQuick
import qs.Commons
import qs.Ui
import "../account/Model.js" as Model

// The message list. A Repeater in a Column rather than a ListView because the
// panel already owns one Flickable and nesting a second scroller inside it
// gives every wheel event two plausible targets.
//
// Hovering a row does not move the keyboard's cursor. A row reports its own
// hover appearance (MessageRow.hot), and letting hover write `cursorId` as well
// put the mouse and the keyboard in a fight the mouse won: pressing j scrolls
// the list to follow the cursor, and Qt re-reports hover when content moves
// under a pointer that has not moved — so the cursor was pulled straight back
// to whatever the mouse happened to be resting on, and j went nowhere.
Column {
  id: root

  required property var service
  required property color textColor
  required property color accentColor
  required property color dimColor
  required property string panelFontFamily
  property string cursorId: ""

  signal messageActivated(string id)
  signal menuRequested(string id, real sceneX, real sceneY)

  width: parent ? parent.width : 0
  spacing: Style.space(2)

  // Where a row sits in this column's own coordinates, so the panel's scroller
  // can bring it into view. Found by index rather than by asking the rows which
  // one holds the cursor: the answer must not wait on a binding to propagate.
  function boundsFor(id) {
    if (!root.service) return null
    var index = Model.indexById(root.service.messages, id)
    if (index < 0) return null
    var item = rows.itemAt(index)
    if (!item) return null
    return ({ y: item.y, height: item.height })
  }

  Repeater {
    id: rows
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
      contentDirection: root.service.contentDirection
      onActivated: root.messageActivated(modelData.id)
      onStarToggled: root.service.toggleStar(modelData.id)
      onArchiveRequested: root.service.act(modelData.id, "archive")
      onTrashRequested: root.service.act(modelData.id, "trash")
      onMenuRequested: function(sceneX, sceneY) {
        root.menuRequested(modelData.id, sceneX, sceneY)
      }
    }
  }

  ListSkeleton {
    width: parent.width
    visible: Model.showInitialListSkeleton(root.service.listLoading,
      root.service.messages.length)
    textColor: root.textColor
  }

  // Three states share this slot, and only one of them is an error: still
  // loading, loaded and empty, or nothing loaded yet.
  Item {
    width: parent.width
    visible: root.service.messages.length === 0
      && !Model.showInitialListSkeleton(root.service.listLoading, 0)
    implicitHeight: Style.space(70)

    Text {
      anchors.centerIn: parent
      width: parent.width - Style.space(20)
      horizontalAlignment: Text.AlignHCenter
      text: root.service.listLoaded
          ? (root.service.searchQuery !== "" ? "Nothing matches that search" : "Nothing here")
          : ""
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      wrapMode: Text.WordWrap
    }
  }

  // Pagination is the only thing this footer needs to say. A result estimate
  // promoted an unreliable server number into interface hierarchy it did not
  // deserve, and repeated it again in the window status line.
  Item {
    width: parent.width
    visible: root.service.hasMore
    implicitHeight: Style.space(40)

    Button {
      anchors.right: parent.right
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      visible: root.service.hasMore
      text: root.service.listLoading ? "Loading" : "Load more"
      foreground: root.textColor
      bordered: false
      fontSize: Style.font.caption
      enabled: !root.service.listLoading
      onClicked: root.service.loadMore()
    }
  }
}
