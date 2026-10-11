import QtQuick
import "Model.js" as Model

// Rollback may reach the merged list after the account's completion callback.
QtObject {
  id: root
  required property var app
  required property var service
  property var pending: []
  property int epoch: 0
  readonly property string viewKey: service
    ? JSON.stringify([service.unified, service.activeAccountId, service.mailboxKey, service.rawQuery]) : ""
  readonly property string scope: service
    ? JSON.stringify([viewKey, epoch]) : ""
  onViewKeyChanged: { epoch++; pending = [] }

  function restore(ids, originalScope) {
    if (!service || !service.unified || scope !== originalScope) return
    pending = Array.isArray(ids) ? ids.slice() : []
    apply()
  }

  function apply() {
    if (!service || pending.length === 0) return
    var checks = app.checkedIds.slice()
    var waiting = []
    for (var i = 0; i < pending.length; i++) {
      var id = pending[i]
      if (Model.indexById(service.messages, id) < 0) waiting.push(id)
      else if (checks.indexOf(id) < 0) checks.push(id)
    }
    app.checkedIds = checks
    pending = waiting
  }

  property Connections changes: Connections {
    target: root.service
    function onMessagesChanged() { Qt.callLater(root.apply) }
  }
}
