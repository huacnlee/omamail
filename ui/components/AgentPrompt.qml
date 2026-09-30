import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui
import "../agent/Agent.js" as Agent
import "../agent" as AI
import "../agent/ChatText.js" as ChatText

// A contextual conversation. The system AI streams public output in the
// background; applying a suggestion remains an explicit owner action.
FocusScope {
  id: root
  required property color textColor
  required property color accentColor
  required property color urgentColor
  required property color dimColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily
  property var service: null
  property var composer: null
  property var proposalComposer: composer
  property string messageId: ""
  property var messageIds: []
  property string subject: ""
  property string accountId: ""
  property var returnFocus: null
  property string localError: ""
  property var sentProposals: ({})
  readonly property var proposals: service && service.backendCanAgentProposals && service.agentShownId === (job ? String(job.id) : "")
    ? (service.agentShownProposals || []) : []
  onProposalsChanged: syncConversation()
  function proposalFor(id) {
    for (var i = 0; i < proposals.length; i++) if (String(proposals[i].id) === id) return proposals[i]
    return ({subject:"",body:"",applicable:false})
  }
  signal applyProposalRequested(var envelope, string parentId)
  readonly property string routingChangedText: "Recipients or sender changed. Use this version, then send from the composer."
  function proposalRoutingChanged(envelope) {
    return !!proposalComposer && typeof proposalComposer.proposalRoutingChanged === "function"
      && proposalComposer.proposalRoutingChanged(envelope)
  }
  function useProposal(proposal, send) {
    var envelope = proposal.envelope ? Agent.proposalEnvelope(Object.assign({}, proposal.envelope,
      {subject: String(proposal.subject), body: String(proposal.body)})) : null
    if (!envelope || !proposal.applicable || (send && sentProposals[proposal.id])) return false
    if (send) {
      if (proposalRoutingChanged(envelope)) { localError = routingChangedText; return false }
      var accepted = proposalComposer && proposalComposer.sendProposal(envelope, proposal.id, job ? String(job.id) : "")
      if (!accepted) { localError = "Could not queue this email. Check its recipients and mailbox."; return false }
      var sent = Object.assign({}, sentProposals); sent[proposal.id] = true; sentProposals = sent
      return true
    }
    if (composer) return composer.applyProposal(envelope)
    else applyProposalRequested(envelope, job ? String(job.id) : "")
    return true
  }
  property string submittedPrompt: ""
  property string submittedInput: ""
  property string submittedJobId: ""
  property string submittedScope: ""
  readonly property string queueScope: JSON.stringify(composer
    ? ["draft", fields.accountId || accountId, fields.draftKey]
    : ["mail", accountId, (overSelection ? messageIds.slice() : [messageId]).sort()])
  AI.PendingMessages {
    id: pending
    objectName: "agent-pending-queue"
    service: root.service
    currentScope: root.queueScope
    currentJob: root.job
    draftFields: root.composer ? root.fields : null
  }
  readonly property var fields: composer ? composer.currentFields() : ({})
  readonly property bool overSelection: messageIds.length > 1
  property bool opened: false
  visible: opened
  property string ignoredJobId: ""
  readonly property var defaultJob: {
    if (!service || !service.hasAgent) return null
    if (composer) {
      var drafts = service.agentJobsForDraft(fields)
      if (drafts.length > 0) return drafts[0]
      if (composer.agentParentJobId) {
        var all = service.agentAllJobs || []
        for (var i = 0; i < all.length; i++) if (String(all[i].id) === composer.agentParentJobId && Agent.canUseDraftChat(all[i], fields)) return all[i]
      }
      var reader = fields.replyMessageId ? service.agentJobFor(fields.replyMessageId, fields.accountId) : null
      return Agent.canUseDraftChat(reader, fields) ? reader : null
    }
    if (overSelection) return service.agentSelectionJob(messageIds, accountId)
    var id = messageId
    return id !== "" ? service.agentJobFor(id, accountId) : null
  }
  property bool historyMode: false
  function selectionOwns(candidate) {
    return !service || typeof service.canContinueAgentJob !== "function" || service.canContinueAgentJob(candidate)
  }
  readonly property bool canContinue: !!job && !!job.canContinue && selectionOwns(job)
  property string viewedJobId: ""
  property string viewedConversationId: ""
  readonly property var historyJobs: service && typeof service.agentHistoryFor === "function"
    ? service.agentHistoryFor(composer ? fields : null, overSelection ? messageIds : [messageId], accountId)
    : (defaultJob ? [defaultJob] : [])
  readonly property var job: {
    if (viewedJobId !== "") {
      for (var i=0; i<historyJobs.length; i++) if (String(historyJobs[i].id) === viewedJobId || (viewedConversationId !== "" && String(historyJobs[i].conversationId || historyJobs[i].id) === viewedConversationId)) return historyJobs[i]
    }
    return defaultJob && selectionOwns(defaultJob) && String(defaultJob.id) !== ignoredJobId ? defaultJob : null
  }
  function showHistory() { historyMode = true; historyList.currentIndex = historyJobs.length ? 0 : -1; historyList.forceActiveFocus() }
  function selectHistory(id) {
    viewedJobId = String(id)
    viewedConversationId = ""
    for (var i = 0; i < historyJobs.length; i++) {
      if (String(historyJobs[i].id) === viewedJobId) viewedConversationId = String(historyJobs[i].conversationId || historyJobs[i].id)
    }
    ignoredJobId = ""
    historyMode = false
    watchJob()
    takeFocus()
  }
  readonly property var conversation: {
    if (!service || !job || service.agentShownId !== String(job.id)) return []
    var rows = Agent.chatEntries(service.agentShownTranscript)
    return rows.length ? rows : (output ? [{role: "assistant", text: output}] : [])
  }
  readonly property bool working: Agent.isActive(job) || (!!service && !!service.agentStarting)
    || (submittedScope === queueScope && submittedPrompt !== "" && errorText === "")
    || (pending.visibleHere && pending.dispatching)
  property double statusNow: Date.now()
  property double preparationStarted: Date.now()
  onWorkingChanged: { statusNow = Date.now(); if (working) preparationStarted = statusNow }
  Timer {
    interval: 1000
    repeat: true
    running: root.opened && root.working
    onTriggered: root.statusNow = Date.now()
  }
  function interrupt() {
    if (!service || !Agent.isActive(job)) return false
    pending.pause()
    service.cancelAgentJob(String(job.id))
    return true
  }
  readonly property string output: service && job && service.agentShownId === String(job.id)
    ? service.agentShownOutput : ""
  readonly property string answer: composer ? Agent.draftAnswer(job, output, conversation) : output
  readonly property string errorText: localError || (service ? service.agentError || "" : "")
  onErrorTextChanged: {
    if (errorText !== "" && submittedPrompt !== "" && submittedScope === queueScope && !Agent.isActive(job) && !(service && service.agentStarting)) {
      if (field.text === "") {
        field.text = submittedInput
      }
      submittedPrompt = ""
    }
  }
  signal keyPressed(var event)
  signal dismissed()
  signal focusRequested()
  signal editingChanged(bool editing)
  onActiveFocusChanged: if (opened) editingChanged(activeFocus)
  anchors.fill: parent
  z: 60

  ListModel { id: chatModel }
  function syncConversation() {
    if (!chatModel) return
    var rows = Agent.conversationWithProposals(conversation, proposals)
    if (chatModel.count > rows.length) chatModel.remove(rows.length, chatModel.count - rows.length)
    for (var i = 0; i < rows.length; i++) {
      if (i >= chatModel.count) chatModel.append({entryRole: rows[i].role, entryText: rows[i].text})
      else {
        if (chatModel.get(i).entryRole !== rows[i].role) chatModel.setProperty(i, "entryRole", rows[i].role)
        if (chatModel.get(i).entryText !== rows[i].text) chatModel.setProperty(i, "entryText", rows[i].text)
      }
    }
  }
  onConversationChanged: syncConversation()
  property bool restoringEarlier: false
  property real earlierHeight: 0
  property real earlierY: 0
  property string earlierJobId: ""
  function loadEarlier() {
    if (!service || !service.agentHasEarlier || service.agentLoadingEarlier || restoringEarlier) return false
    earlierHeight = answerFlick.contentHeight
    earlierY = answerFlick.contentY
    earlierJobId = job ? String(job.id) : ""
    restoringEarlier = true
    answerFlick.followEnd = false
    if (service.loadEarlierAgentMessages() === false) { restoringEarlier = false; return false }
    return true
  }
  Connections {
    target: root.service
    ignoreUnknownSignals: true
    function onAgentSelectionRevisionChanged() {
      pending.messages = []
      pending.paused = true
      pending.dispatching = false
      pending.waitingForTurn = false
      root.submittedPrompt = ""
      root.viewedJobId = ""
      root.viewedConversationId = ""
      root.historyMode = false
      root.localError = ""
      if (root.composer) root.composer.agentParentJobId = ""
    }
    function onAgentLoadingEarlierChanged() {
      if (!root.restoringEarlier || root.service.agentLoadingEarlier) return
      Qt.callLater(function() {
        if (root.opened && root.job && String(root.job.id) === root.earlierJobId) {
          chat.forceLayout()
          answerFlick.contentY = root.earlierY + Math.max(0, answerFlick.contentHeight - root.earlierHeight)
        }
        root.restoringEarlier = false
      })
    }
  }
  Component.onCompleted: syncConversation()

  function watchJob() {
    if (!opened || !service || !job) return
    if (submittedPrompt !== "" && submittedScope === queueScope && String(job.id) !== submittedJobId) {
      if (field.text === submittedPrompt) field.text = ""
      submittedPrompt = ""
    }
    service.showAgentJob(String(job.id))
    if (job.resultReady || !Agent.isActive(job)) service.acknowledgeAgentJob(String(job.id))
  }
  onJobChanged: watchJob()
  onFieldsChanged: if (composer && opened && fields.draftKey !== openedDraftKey) close()
  property string openedDraftKey: ""

  property string dismissedCommandText: ""
  readonly property var commandMatches: ["/clear", "/history", "/diagnose"].filter(function(command) {
    var input = field.text.trim()
    return input.charAt(0) === "/" && command.indexOf(input) === 0
  })
  property int commandIndex: 0
  onCommandMatchesChanged: commandIndex = 0
  readonly property bool commandsOpen: opened && !historyMode && activeFocus
    && field.text !== dismissedCommandText && commandMatches.length > 0
  readonly property int clearCommandStart: field.text.trim() === "/clear" ? field.text.indexOf("/") : -1
  function moveCommand(delta) {
    commandIndex = (commandIndex + delta + commandMatches.length) % commandMatches.length
    return true
  }
  function chooseCommand(index) {
    if (!commandsOpen) return false
    var command = commandMatches[typeof index === "number" ? index : commandIndex]
    if (field.text.trim() === command) return submitCurrent()
    field.text = command + " "
    dismissedCommandText = field.text
    field.cursorPosition = field.length
    takeFocus()
    return true
  }
  function dismissCommands() { dismissedCommandText = field.text }

  function submitCurrent() {
    if (historyMode) {
      if (historyList.currentIndex < 0 || historyList.currentIndex >= historyJobs.length) return false
      selectHistory(historyJobs[historyList.currentIndex].id)
      return true
    }
    var command = field.text.trim()
    if (command === "/history") { field.text = ""; showHistory(); return true }
    if (command === "/diagnose") {
      if (!service || typeof service.diagnoseError !== "function" || service.diagnosing) return false
      field.text = ""
      service.diagnoseError()
      return true
    }
    if (command === "/clear") {
      if (working || pending.busy) {
        localError = working ? "Stop the current request before starting a new chat."
          : "Remove queued messages before starting a new chat."
        return false
      }
      newChat()
      return true
    }
    return submit(field.text, true)
  }
  function newChat(preserveInput) {
    if (working || pending.busy) return
    ignoredJobId = defaultJob ? String(defaultJob.id) : ""
    viewedJobId = ""
    viewedConversationId = ""
    historyMode = false
    if (!preserveInput) field.text = ""
    localError = ""
    if (service && typeof service.clearAgentError === "function") service.clearAgentError()
    takeFocus()
  }
  function takeFocus() { if (historyMode) historyList.forceActiveFocus(); else field.forceActiveFocus() }
  function openAt(sceneX, sceneY) { open() }
  function open() {
    localError = ""
    openedDraftKey = String(fields.draftKey || "")
    if (!opened) returnFocus = root.Window.activeFocusItem
    opened = true
    root.focusRequested()
    watchJob()
  }
  function openFor(id, subjectText, sceneX, sceneY) {
    var next = String(id || "")
    if (next !== messageId || accountId !== String(service ? service.activeAccountId : "")) {
      field.text = ""; viewedJobId = ""; viewedConversationId = ""; ignoredJobId = ""; historyMode = false
    }
    messageId = next
    messageIds = []
    subject = String(subjectText || "")
    accountId = service ? String(service.activeAccountId || "") : ""
    openAt(sceneX, sceneY)
  }
  function openForSelection(ids, sceneX, sceneY) {
    viewedJobId = ""; viewedConversationId = ""; ignoredJobId = ""; historyMode = false
    field.text = ""
    messageIds = Array.isArray(ids) ? ids.slice() : []
    messageId = messageIds.length === 1 ? String(messageIds[0]) : ""
    subject = Agent.pluralizeMessages(messageIds.length)
    accountId = service ? String(service.activeAccountId || "") : ""
    openAt(sceneX, sceneY)
  }
  function openCenteredFor(id, subjectText) { openFor(id, subjectText, 0, 0) }
  function close() {
    if (!opened) return
    opened = false
    root.dismissed()
    var previous = returnFocus
    returnFocus = null
    Qt.callLater(function() {
      if (previous && previous.visible) previous.forceActiveFocus()
    })
  }
  function submit(promptText, fromInput) {
    if (!service) return false
    if (service.agentAvailable === false) { localError = service.agentUnavailableReason; return false }
    var prompt = String(promptText || "").trim()
    if (prompt === "") return false
    if (working || pending.busy) {
      if (!job && submittedScope !== queueScope && !pending.busy) {
        localError = "AI is starting another request. Try again shortly."
        return false
      }
      var queued = pending.add(prompt, submittedScope === queueScope && submittedPrompt !== "")
      if (queued) {
        field.text = ""; localError = ""; answerFlick.followEnd = true
        if (job) { viewedJobId = String(job.id); viewedConversationId = String(job.conversationId || job.id) }
      }
      else localError = pending.error
      return queued
    }
    if (!fromInput) field.text = prompt
    var inputText = field.text
    localError = ""
    if (job && !canContinue) {
      localError = "Start a new chat to ask again."
      return false
    }
    var accepted = job ? service.answerAgent(String(job.id), prompt, composer ? composer.currentFields() : null)
      : (composer ? service.askAgentDraft(fields, prompt)
        : (overSelection ? service.askAgentMany(messageIds, prompt, accountId)
          : service.askAgent(messageId, prompt, accountId)))
    if (!accepted) localError = service.agentError || "AI could not start. Check the message and try again."
    else {
      field.text = ""
      submittedScope = queueScope
      submittedPrompt = prompt
      submittedInput = inputText
      submittedJobId = job ? String(job.id) : ""
      answerFlick.followEnd = true
    }
    return accepted
  }
  function applyAnswer(replace) {
    if (!composer || !job || answer === "") return false
    // Re-resolve ownership immediately before editing, even if a From menu
    // or a restored draft changed under the response.
    var matches = service.agentJobsForDraft(composer.currentFields())
    if (!matches.some(function(candidate) { return String(candidate.id) === String(root.job.id) })) return false
    if (replace) composer.replaceBody(answer)
    else composer.insertAtCursor(answer)
    return true
  }

  Rectangle {
    id: dock
    anchors.fill: parent
    color: root.popupBackgroundColor
    PanelSeparator {
      anchors.left: parent.left
      anchors.top: parent.top
      anchors.bottom: parent.bottom
      width: 1
      foreground: root.textColor
    }
    Column {
      id: content
      anchors.fill: parent
      anchors.margins: Style.space(12)
      spacing: Style.space(8)
      Row {
        width: parent.width
        spacing: Style.space(8)
        Text {
          width: parent.width
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: root.composer ? "AI · " + (root.fields.subject || "Draft")
            : "AI · " + (root.subject || "Message")
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          font.bold: true
          elide: Text.ElideRight
        }
      }
      Flickable {
        id: answerFlick
        objectName: "agent-transcript-scroll"
        visible: !root.historyMode
        width: parent.width
        height: Math.max(Style.space(32), content.height - y - controls.implicitHeight - pendingRows.implicitHeight - (pendingRows.visible ? Style.space(8) : 0) - requestRow.implicitHeight - statusText.implicitHeight - Style.space(8) * (controls.implicitHeight > 0 ? 3 : 2))
        contentWidth: width
        contentHeight: Math.max(height, chat.implicitHeight)
        property bool followEnd: true
        property real lastContentY: 0
        onContentYChanged: {
          var upward = contentY < lastContentY
          if (contentY < lastContentY) followEnd = false
          if (atYEnd) followEnd = true
          lastContentY = contentY
          if (upward && contentY <= Style.space(24) && !root.restoringEarlier) root.loadEarlier()
        }
        onMovementStarted: followEnd = atYEnd
        onMovementEnded: followEnd = atYEnd
        onContentHeightChanged: if (followEnd) Qt.callLater(function() {
          answerFlick.contentY = Math.max(0, answerFlick.contentHeight - answerFlick.height)
        })
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        WheelScroller { view: answerFlick }
        QQC.ScrollBar.vertical: QQC.ScrollBar { policy: QQC.ScrollBar.AsNeeded }
        Column {
          id: chat
          y: Math.max(0, answerFlick.height - implicitHeight)
          width: answerFlick.width
          spacing: Style.space(12)
          Button {
            objectName: "agent-earlier-messages"
            text: "Earlier messages"
            visible: !!root.service && root.service.agentHasEarlier === true
            enabled: !!root.service && root.service.agentLoadingEarlier !== true
            foreground: root.textColor; accent: root.accentColor
            fontFamily: root.panelFontFamily
            onClicked: root.loadEarlier()
          }
          Repeater {
            model: chatModel
            Item {
              required property string entryRole
              required property string entryText
              required property int index
              readonly property bool userMessage: entryRole === "user"
              width: chat.width
               height: entryRole === "proposal" ? draftLoader.height : entry.implicitHeight + (userMessage ? Style.space(16) : 0)
              Loader {
                id: draftLoader
                width: parent.width
                active: entryRole === "proposal"
                property var proposal: root.proposalFor(entryText)
                sourceComponent: proposalTemplate
              }
              Rectangle {
                anchors.fill: parent
                visible: parent.userMessage
                color: Style.normalFillFor(root.textColor, root.accentColor)
                Rectangle {
                  anchors.fill: parent
                  color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.06)
                }
              }
              Text {
                visible: parent.userMessage
                x: Style.space(8)
                y: Style.space(8)
                text: "›"
                textFormat: Text.PlainText
                color: root.dimColor
                font.family: root.panelFontFamily
                font.pixelSize: Style.font.bodySmall
              }
              TextEdit {
                id: entry
                visible: entryRole !== "proposal"
                objectName: entryRole === "assistant" ? "agent-result" : "agent-chat-entry"
                x: parent.userMessage ? Style.space(22) : 0
                y: parent.userMessage ? Style.space(8) : 0
                width: parent.width - x - (parent.userMessage ? Style.space(8) : 0)
                textFormat: entryRole === "assistant" ? TextEdit.RichText : TextEdit.PlainText
                text: entryRole === "assistant" ? ChatText.render(entryText) : entryText
                readOnly: true
                selectByMouse: true
                activeFocusOnTab: true
                color: entryRole === "status" ? root.dimColor : root.textColor
                selectionColor: root.accentColor
                selectedTextColor: root.popupBackgroundColor
                font.family: root.panelFontFamily
                font.pixelSize: entryRole === "status" ? Style.font.caption : Style.font.bodySmall
                wrapMode: TextEdit.Wrap
                Accessible.name: entryRole === "assistant" ? "AI reply" : entryRole
              }
            }
          }
          Component {
            id: proposalTemplate
            Rectangle {
              id: proposalCard
              objectName: "agent-draft-proposal"
              readonly property var modelData: parent.proposal
              readonly property var envelope: modelData.envelope || null
              readonly property bool routingChanged: root.proposalRoutingChanged(envelope)
              readonly property var queue: root.service && typeof root.service.agentProposalQueue === "function" && envelope
                ? root.service.agentProposalQueue(envelope.accountId) : null
              readonly property string sendId: "agent-" + modelData.id
              readonly property string delivery: queue ? String(queue.deliveryStates[sendId] || "") : ""
              readonly property bool submitted: delivery !== "" || !!root.sentProposals[modelData.id]
              Component.onCompleted: if (queue) queue.watchDelivery(sendId)
              width: parent.width
              height: proposalContent.implicitHeight + Style.space(24)
              color: Style.normalFillFor(root.textColor, root.accentColor)
              border.color: root.popupBorderColor
              radius: Style.space(6)
              Column {
                id: proposalContent
                x: Style.space(12); y: Style.space(12)
                width: parent.width - Style.space(24)
                spacing: Style.space(8)
                Text {
                  objectName: "agent-proposal-recipients"
                  width: parent.width
                  text: proposalCard.envelope ? "From: " + String(proposalCard.envelope.from || "")
                    + "\nTo: " + String(proposalCard.envelope.to || "")
                    + (proposalCard.envelope.cc ? "\nCc: " + proposalCard.envelope.cc : "")
                    + (proposalCard.envelope.bcc ? "\nBcc: " + proposalCard.envelope.bcc : "")
                    + (proposalCard.envelope.replyTo ? "\nReply-To: " + proposalCard.envelope.replyTo : "")
                    : "This proposal has no saved recipients or attachment snapshot. Ask again from its message or draft."
                  textFormat: Text.PlainText
                  wrapMode: Text.Wrap
                  color: root.dimColor
                  font.family: root.panelFontFamily
                  font.pixelSize: Style.font.caption
                }
                Text {
                  width: parent.width
                  text: "Subject: " + proposalCard.modelData.subject
                  textFormat: Text.PlainText
                  wrapMode: Text.Wrap
                  color: root.textColor
                  font.family: root.panelFontFamily
                  font.bold: true
                }
                TextEdit {
                  objectName: "agent-proposal-body"
                  width: parent.width
                  text: Agent.replyOnly(proposalCard.modelData.body, proposalCard.envelope ? proposalCard.envelope.replyQuote : "")
                  textFormat: TextEdit.PlainText
                  readOnly: true; selectByMouse: true; wrapMode: TextEdit.Wrap
                  color: root.textColor
                  font.family: root.panelFontFamily
                  font.pixelSize: Style.font.bodySmall
                }
                Text {
                  width: parent.width
                  visible: !!proposalCard.envelope && proposalCard.envelope.attachments.length > 0
                  text: proposalCard.envelope ? "Attachments: " + Agent.attachmentLabels(proposalCard.envelope.attachments) : ""
                  textFormat: Text.PlainText
                  wrapMode: Text.Wrap
                  color: root.dimColor
                  font.family: root.panelFontFamily
                  font.pixelSize: Style.font.caption
                }
                Flow {
                  width: parent.width
                  spacing: Style.space(8)
                  Button {
                    objectName: "agent-apply-draft"
                    text: root.composer ? "Use this version" : "Edit draft..."
                    foreground: root.textColor; accent: root.accentColor
                    fontFamily: root.panelFontFamily; bordered: true
                    enabled: !!proposalCard.envelope && proposalCard.modelData.applicable && (!proposalCard.submitted || ["failed", "cancelled", "unknown"].indexOf(proposalCard.delivery) >= 0)
                    onClicked: root.useProposal(proposalCard.modelData, false)
                  }
                  Button {
                    objectName: "agent-send-email"
                    text: ({queued:"Queued for sending", sending:"Sending...", sent:"Sent", failed:"Send failed", cancelled:"Send undone", unknown:"Check Sent — delivery unknown"})[proposalCard.delivery]
                      || (proposalCard.submitted ? "Checking send status..." : "Send email")
                    foreground: root.textColor; accent: root.accentColor
                    fontFamily: root.panelFontFamily; bordered: true
                    enabled: !!proposalCard.envelope && proposalCard.modelData.applicable && !proposalCard.submitted && !proposalCard.routingChanged
                    onClicked: root.useProposal(proposalCard.modelData, true)
                  }
                }
                Text {
                  objectName: "agent-proposal-routing-changed"
                  width: parent.width
                  visible: proposalCard.routingChanged && !proposalCard.submitted
                  text: root.routingChangedText
                  textFormat: Text.PlainText
                  wrapMode: Text.Wrap
                  color: root.dimColor
                  font.family: root.panelFontFamily
                  font.pixelSize: Style.font.caption
                }
              }
            }
          }
          Text {
            width: parent.width
            visible: !!root.job && Agent.detailText(root.job) !== ""
            text: Agent.detailText(root.job)
            textFormat: Text.PlainText
            color: root.dimColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }
        }
      }
      Flow {
        id: controls
        visible: !root.historyMode
        width: parent.width
        spacing: Style.space(6)
        Button {
          objectName: "agent-restart-chat"
          text: "New chat"
          visible: !!root.job && !root.canContinue && !root.working
          enabled: !pending.busy
          foreground: root.textColor; accent: root.accentColor
          fontFamily: root.panelFontFamily
          onClicked: root.newChat(true)
        }
        Button {
          objectName: "agent-insert"
          text: "Insert at cursor"
          visible: !!root.composer && root.answer !== "" && !(root.service && root.service.backendCanAgentProposals)
          foreground: root.textColor
          accent: root.accentColor
          bordered: true
          fontFamily: root.panelFontFamily
          fontSize: Style.font.caption
          focusable: true
          onClicked: root.applyAnswer(false)
        }
        Button {
          objectName: "agent-replace"
          text: "Replace body"
          visible: !!root.composer && root.answer !== "" && !(root.service && root.service.backendCanAgentProposals)
          foreground: root.textColor
          accent: root.accentColor
          bordered: true
          fontFamily: root.panelFontFamily
          fontSize: Style.font.caption
          focusable: true
          onClicked: root.applyAnswer(true)
        }
      }
      Flickable {
        id: pendingRows
        objectName: "agent-pending-messages"
        visible: pending.busy && pending.visibleHere && !root.historyMode
        width: parent.width
        implicitHeight: visible ? Math.min(Style.space(100), pendingContent.implicitHeight) : 0
        contentHeight: pendingContent.implicitHeight
        contentWidth: width
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        WheelScroller { view: pendingRows }
        QQC.ScrollBar.vertical: QQC.ScrollBar {}
        Column {
          id: pendingContent
          width: pendingRows.width
          spacing: Style.space(4)
        Repeater {
          model: pending.visibleHere ? pending.messages : []
          Row {
            required property string modelData
            required property int index
            width: pendingRows.width
            spacing: Style.space(4)
            QQC.AbstractButton {
              id: pendingMessageButton
              text: (pending.dispatching && parent.index === 0 ? "Sending · " : (pending.paused ? "Paused · " : "Pending · ")) + parent.modelData
              width: parent.width - removePending.width - parent.spacing
              height: Style.spacing.popupRowHeight
              padding: Style.space(6)
              hoverEnabled: true
              focusPolicy: Qt.StrongFocus
              enabled: !(pending.dispatching && parent.index === 0)
              contentItem: Text {
                text: pendingMessageButton.text
                textFormat: Text.PlainText
                color: pendingMessageButton.hovered || pendingMessageButton.activeFocus ? root.textColor : root.dimColor
                font.family: root.panelFontFamily
                font.pixelSize: Style.font.caption
                verticalAlignment: Text.AlignVCenter
                elide: Text.ElideRight
              }
              background: Rectangle { color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.04) }
              PanelToolTip { visible: pendingMessageButton.hovered; text: "Edit pending message"; fontFamily: root.panelFontFamily }
              onClicked: {
                if (field.text !== "") { root.localError = "Finish the current input before editing a pending message."; return }
                field.text = pending.remove(parent.index)
                root.takeFocus()
              }
            }
            Button {
              id: removePending
              text: "×"
              width: Style.space(20)
              foreground: root.dimColor
              accent: root.accentColor
              fontFamily: root.panelFontFamily
              fontSize: Style.font.caption
              enabled: !(pending.dispatching && parent.index === 0)
              tooltipText: "Remove pending message"
              onClicked: pending.remove(parent.index)
            }
          }
        }
      }
      }
      Text {
        id: statusText
        visible: !root.historyMode
        objectName: "agent-chat-status"
        width: parent.width
        textFormat: Text.PlainText
        text: root.errorText || (pending.visibleHere ? pending.error : "") || (root.working ? Agent.workingText(root.job, root.statusNow, root.preparationStarted)
          + (Agent.progressText(root.job) ? "\n" + Agent.progressText(root.job) : "")
          : (root.job && !root.selectionOwns(root.job) ? "Read-only chat from a previous AI selection. Start a new chat to continue."
            : (root.job ? Agent.stateLabel(root.job) : "Ask your system AI about this mail.")))
        color: root.errorText !== "" ? root.urgentColor : root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
      Item {
        id: requestRow
        visible: !root.historyMode
        implicitHeight: inputScroll.height
        width: parent.width
        QQC.ScrollView {
          id: inputScroll
          width: parent.width
          height: Math.min(Style.space(140), Math.max(Style.space(28), field.contentHeight + field.topPadding + field.bottomPadding))
          contentWidth: availableWidth
          clip: true
          QQC.TextArea {
            id: field
            objectName: "agent-prompt-field"
            textFormat: TextEdit.PlainText
            Keys.onPressed: function(event) { root.keyPressed(event) }
            width: inputScroll.availableWidth
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.bodySmall
            color: root.textColor
            placeholderText: root.job ? "Message AI · / for commands" : "Ask about this mail · / for commands"
            placeholderTextColor: root.dimColor
            selectionColor: root.accentColor
            selectedTextColor: root.popupBackgroundColor
            selectByMouse: true
            wrapMode: TextEdit.Wrap
            padding: Style.space(8)
            leftPadding: Style.space(22)
            rightPadding: root.working ? Style.space(36) : Style.space(8)
            Accessible.name: "Message AI"
            background: Rectangle {
              color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.06)
            }
            Repeater {
              model: root.clearCommandStart >= 0 ? 6 : 0
              delegate: Rectangle {
                required property int index
                readonly property int position: root.clearCommandStart + index
                readonly property rect first: { field.text; field.width; field.font; return field.positionToRectangle(position) }
                readonly property rect next: { field.text; field.width; field.font; return field.positionToRectangle(position + 1) }
                x: first.x
                y: first.y
                width: next.y === first.y ? Math.abs(next.x - first.x) : commandMetrics.advanceWidth(field.getText(position, position + 1))
                height: first.height
                color: Qt.rgba(root.accentColor.r, root.accentColor.g, root.accentColor.b, 0.24)
              }
            }
            FontMetrics { id: commandMetrics; font: field.font }
          }
        }
        Text {
          x: Style.space(8)
          y: Style.space(8)
          text: "›"
          textFormat: Text.PlainText
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
        }
        Button {
          objectName: "agent-stop-button"
          anchors.right: parent.right
          anchors.bottom: parent.bottom
          anchors.margins: Style.space(4)
          width: Style.space(24)
          height: Style.space(24)
          visible: root.working && !!root.job
          foreground: root.dimColor
          accent: root.accentColor
          bordered: false
          focusable: true
          tooltipText: "Stop request"
          Accessible.name: "Stop request"
          fontFamily: root.panelFontFamily
          ActionIcon { anchors.centerIn: parent; name: "stop"; color: root.dimColor; iconSize: Style.font.iconSmall; fontFamily: root.panelFontFamily }
          onClicked: root.interrupt()
        }
      }
    }
    ListView {
      id: historyList
      objectName: "agent-history"
      visible: root.historyMode
      anchors.fill: content
      anchors.topMargin: Style.space(28)
      clip: true
      model: root.historyJobs
      keyNavigationEnabled: true
      spacing: Style.space(4)
      QQC.ScrollBar.vertical: QQC.ScrollBar {}
      footer: Flow {
        width: historyList.width
        spacing: Style.space(8)
        Button {
          text: "Newer chats"
          visible: !!root.service && root.service.agentHasNewerChats === true
          foreground: root.textColor; accent: root.accentColor
          fontFamily: root.panelFontFamily
          onClicked: root.service.pageAgentChats(false)
        }
        Button {
          text: "Older chats"
          visible: !!root.service && root.service.agentHasOlderChats === true
          foreground: root.textColor; accent: root.accentColor
          fontFamily: root.panelFontFamily
          onClicked: root.service.pageAgentChats(true)
        }
      }
      delegate: QQC.ItemDelegate {
        required property var modelData
        required property int index
        width: historyList.width
        contentItem: Text {
          text: Agent.historyLabel(modelData)
          textFormat: Text.PlainText
          wrapMode: Text.WordWrap
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
        }
        background: Rectangle { color: parent.hovered || (historyList.activeFocus && parent.index === historyList.currentIndex) ? Style.hoverFillFor(root.textColor, root.accentColor) : Style.normalFillFor(root.textColor, root.accentColor) }
        onClicked: root.selectHistory(modelData.id)
      }
      Text {
        visible: root.historyJobs.length === 0
        text: "No conversations for this mail yet."
        textFormat: Text.PlainText
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
      }
    }
    Rectangle {
      objectName: "agent-commands"
      visible: root.commandsOpen
      z: 80
      x: content.x
      y: Math.max(content.y, content.y + requestRow.y - height - Style.space(8))
      width: inputScroll.width
      height: commandRows.implicitHeight + Style.space(8)
      color: root.popupBackgroundColor
      border.color: root.popupBorderColor
      Column {
        id: commandRows
        x: Style.space(4); y: Style.space(4)
        width: parent.width - Style.space(8)
        Repeater {
          model: root.commandMatches
          QQC.ItemDelegate {
            required property string modelData
            required property int index
            objectName: "agent-" + modelData.slice(1) + "-command"
            width: commandRows.width
            height: Style.spacing.popupRowHeight
            focusPolicy: Qt.NoFocus
            contentItem: Text {
              text: modelData + " · " + ({"/clear":"New chat", "/history":"History...", "/diagnose":"Diagnose..."})[modelData]
              textFormat: Text.PlainText
              color: root.textColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.bodySmall
              elide: Text.ElideRight
            }
            background: Rectangle { color: index === root.commandIndex ? Style.selectedFillFor(root.textColor, root.accentColor) : Style.normalFillFor(root.textColor, root.accentColor) }
            onClicked: { field.text = modelData; root.submitCurrent() }
          }
        }
      }
    }
  }
}
