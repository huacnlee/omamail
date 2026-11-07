import QtQuick
import qs.Commons
import "../account/Model.js" as Model
import "../account/Drop.js" as Drop
import "../providers/Registry.js" as Provider

// Emails dragged from the list onto the sidebar. The ticked rows go when the
// dragged row is one of them, else just that row. The tag follows the pointer;
// a drop lands on any DropArea keyed "omamail-message" under it, and the
// sidebar asks `wouldAct` to decide which rows take one.
Item {
  id: root

  property var service: null
  property var checkedIds: []
  property bool enabled: true
  required property color textColor
  required property color accentColor
  required property color popupBackgroundColor
  required property string panelFontFamily
  property var ids: []
  property string rowId: ""
  // The account the drag began in; a drop is refused once the shell has moved off it.
  property string accountId: ""
  readonly property bool active: ids.length > 0
  readonly property bool stale: active && !!service && String(service.activeAccountId || "") !== accountId

  // Runs a verb on the dragged row, or on the ticked rows it belongs to.
  property var act: function(id, action) {}

  function start(id, sceneX, sceneY) {
    if (!service || service.unified || !enabled) return
    if (!Provider.can(service.providerId, "labels") && !Provider.can(service.providerId, "move")) return
    rowId = id
    accountId = String(service.activeAccountId || "")
    ids = checkedIds.indexOf(id) >= 0 ? checkedIds.slice() : [id]
    move(sceneX, sceneY)
  }

  function move(sceneX, sceneY) {
    if (!active) return
    var at = tag.parent.mapFromItem(null, sceneX, sceneY)
    tag.x = at.x - tag.width / 2
    tag.y = at.y - tag.height / 2
  }

  function cancel() {
    ids = []
    rowId = ""
    accountId = ""
  }

  function end() {
    if (!active) return
    if (!stale) tag.Drag.drop()
    cancel()
  }

  Connections {
    target: root.service
    ignoreUnknownSignals: true
    function onActiveAccountIdChanged() {
      if (root.active && String(root.service.activeAccountId || "") !== root.accountId) root.cancel()
    }
  }

  // False where a drop would change nothing, so the rail does not offer it.
  function wouldAct(kind, key) {
    if (!service || !active || stale) return false
    return Drop.wouldAct(kind, key, service, Model.summariesById(service.messages, ids))
  }

  function dropOnMailbox(key) {
    var verb = service ? Drop.verbFor(key, service) : ""
    if (rowId !== "" && verb !== "" && wouldAct("mailbox", key)) act(rowId, verb)
  }

  function dropOnLabel(labelId) {
    if (rowId === "" || !wouldAct("label", labelId)) return
    if (service.refuseUnavailableAction("label:destination", rowId)) return
    act(rowId, "label:" + labelId)
  }

  Rectangle {
    id: tag
    objectName: "message-drag-ghost"
    visible: root.active
    z: 1000
    width: label.implicitWidth + Style.space(20)
    height: label.implicitHeight + Style.space(12)
    radius: Style.cornerRadius
    color: root.popupBackgroundColor
    border.width: 1
    border.color: root.accentColor
    Drag.active: root.active
    Drag.keys: ["omamail-message"]
    Drag.dragType: Drag.Internal
    Drag.hotSpot.x: width / 2
    Drag.hotSpot.y: height / 2

    Text {
      id: label
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: root.ids.length === 1 ? "Move 1 message" : "Move " + root.ids.length + " messages"
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
    }
  }
}
