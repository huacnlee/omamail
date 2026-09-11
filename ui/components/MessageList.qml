import QtQuick
import qs.Commons
import qs.Ui
import "../account/Model.js" as Model
import "../account/Unified.js" as Unified
import "../agent/Agent.js" as Agent

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
  required property color urgentColor
  required property string panelFontFamily
  property string cursorId: ""
  // The rows ticked for a bulk action, by id. Held above the list, like the
  // cursor, because a reload rebuilds every row.
  property var checkedIds: []
  property bool ctrlHeld: false

  signal messageActivated(string id)
  signal checkToggled(string id)
  signal checkRangeRequested(string id)
  signal agentRequested(string id, real sceneX, real sceneY)
  // A row's own star, archive and trash buttons. Routed up rather than
  // straight to the service so a ticked row's button means the selection.
  signal rowActionRequested(string id, string action)
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
      urgentColor: root.urgentColor
      panelFontFamily: root.panelFontFamily
      agentState: Agent.glyphState(root.service.agentJobs[modelData.id])
      agentProgress: Agent.progressText(root.service.agentJobs[modelData.id])
      agentAttention: root.service.agentAttentionByMessage[modelData.id] === true
      hasCursor: root.cursorId === modelData.id
      selected: root.service.selectedId === modelData.id
      checked: root.checkedIds.indexOf(modelData.id) >= 0
      selectionActive: root.checkedIds.length > 0
      ctrlHeld: root.ctrlHeld
      canArchive: root.service.canArchive
      conversations: Unified.rowIsConversation(modelData)
      contentDirection: root.service.contentDirection
      onActivated: root.messageActivated(modelData.id)
      onCheckToggled: root.checkToggled(modelData.id)
      onCheckRangeRequested: root.checkRangeRequested(modelData.id)
      onAgentRequested: function(sceneX, sceneY) { root.agentRequested(modelData.id, sceneX, sceneY) }
      onStarToggled: root.rowActionRequested(modelData.id, "star")
      onArchiveRequested: root.rowActionRequested(modelData.id, "archive")
      onTrashRequested: root.rowActionRequested(modelData.id, "trash")
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
  //
  // The next page is asked for as the list is scrolled to its foot, so the
  // button is for the page that did not come — a refusal, a slow server —
  // rather than the way every page is reached.
  Item {
    width: parent.width
    visible: root.service.hasMore
    implicitHeight: Style.space(40)

    Button {
      objectName: "load-more"
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

  // The scroller this list sits in, handed over by the panel that owns it:
  // when its foot comes into view and there is more, the next page is asked
  // for without a press, and never while a page is on its way, which is
  // what keeps a slow server from being asked twice. A page that lands and
  // still leaves the foot in view — a short mailbox, a merged list held
  // back by a mailbox that has not caught up — is followed by the next
  // once the list settles, until the foot is out of view or there is no
  // more. Asked a moment later rather than in the signal itself: a cached
  // page painted on the way into a live load can put the foot in view
  // before that load has said it is running, and a page asked for from
  // inside the load would race it.
  property var scroller: null
  property int loadStartCount: -1

  function loadMoreIfAtFoot() {
    if (!root.scroller || !root.service) return false
    if (!root.scroller.atYEnd || !root.service.hasMore || root.service.listLoading) return false
    root.service.loadMore()
    return true
  }

  function loadMoreSoon() { Qt.callLater(root.loadMoreIfAtFoot) }

  function continueAfterLoad(startCount) {
    // MailAccount ends the loading state before it applies the summaries.
    // Judge growth after that callback has finished, when the page is visible.
    Qt.callLater(function() {
      if (!root.service || root.service.messages.length <= startCount) return
      root.loadMoreIfAtFoot()
    })
  }

  Connections {
    target: root.scroller
    function onAtYEndChanged() { root.loadMoreSoon() }
  }

  Connections {
    target: root.service
    function onListLoadingChanged() {
      if (root.service.listLoading) {
        root.loadStartCount = root.service.messages.length
        return
      }
      var startCount = root.loadStartCount
      root.loadStartCount = -1
      if (startCount >= 0) root.continueAfterLoad(startCount)
    }
  }
}
