import QtQuick

// A reply waits for the body, not merely the summary supplied by the list.
QtObject {
  required property var app
  required property var composer
  required property var assistant
  required property var composeAssistant
  readonly property var service: app.service
  function detailReady() {
    return !!service && !!service.selectedMessage && !service.detailLoading && service.detailPainted
  }
  function start(mode) {
    if (!service) return
    app.pendingDraftId = ""
    var next = String(mode || "new")
    if (next !== "new" && !detailReady()) {
      app.pendingComposeMode = next
      return
    }
    app.pendingComposeMode = ""
    var keepAssistant = assistant.opened
    var conversation = keepAssistant ? assistant.job : null
    composer.begin(next, service.selectedMessage, service.selectedBody.text,
      service.selectedAttachments)
    if (keepAssistant) {
      if ((next === "reply" || next === "replyAll") && conversation
          && String(conversation.accountId) === composer.accountId
          && String(conversation.messageId) === composer.replyMessageId)
        composer.agentParentJobId = String(conversation.id)
      composeAssistant.open()
    }
  }

  function resume() {
    if (app.pendingComposeMode === "" || !detailReady()) return
    var mode = app.pendingComposeMode
    app.pendingComposeMode = ""
    start(mode)
  }
}
