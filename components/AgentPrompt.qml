import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui
import "../agent/Agent.js" as Agent
import "../agent" as AI
import "../agent/ChatText.js" as ChatText
import "Menu.js" as Menu

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
  property string messageId: ""
  property var messageIds: []
  property string subject: ""
  property string accountId: ""
  property var returnFocus: null
  property string localError: ""
  property string submittedPrompt: ""
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
      return drafts.length > 0 ? drafts[0] : null
    }
    if (overSelection) return service.agentSelectionJob(messageIds, accountId)
    var id = messageId
    return id !== "" ? service.agentJobFor(id, accountId) : null
  }
  property bool historyMode: false
  property string viewedJobId: ""
  property string viewedConversationId: ""
  readonly property var historyJobs: service && typeof service.agentHistoryFor === "function"
    ? service.agentHistoryFor(composer ? fields : null, overSelection ? messageIds : [messageId], accountId)
    : (defaultJob ? [defaultJob] : [])
  readonly property var job: {
    if (viewedJobId !== "") {
      for (var i=0; i<historyJobs.length; i++) if (String(historyJobs[i].id) === viewedJobId || (viewedConversationId !== "" && String(historyJobs[i].conversationId || historyJobs[i].id) === viewedConversationId)) return historyJobs[i]
    }
    return defaultJob && String(defaultJob.id) !== ignoredJobId ? defaultJob : null
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
  readonly property bool draftChanged: !!composer && !!job && !!job.draftFingerprint
    && job.draftFingerprint !== Agent.draftFingerprint(fields)
  readonly property string errorText: localError || (service ? service.agentError || "" : "")
  onErrorTextChanged: {
    if (errorText !== "" && submittedPrompt !== "" && submittedScope === queueScope && !Agent.isActive(job) && !(service && service.agentStarting)) {
      if (field.text === "") field.text = submittedPrompt
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

  TextEdit { id: clipboardText; visible: false; textFormat: TextEdit.PlainText }
  function copyReply(raw) {
    clipboardText.text = raw
    clipboardText.selectAll()
    clipboardText.copy()
    clipboardText.deselect()
    clipboardText.text = ""
  }
  ListModel { id: chatModel }
  function syncConversation() {
    if (!chatModel) return
    var rows = conversation
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
  property int commandIndex: 0
  readonly property var commandMatches: Agent.commandSuggestions(field.text,
    composer ? Agent.draftAsks() : Agent.mailAsks(overSelection))
  readonly property bool commandsOpen: opened && !historyMode && activeFocus && field.text !== dismissedCommandText
    && commandMatches.items.length > 0
  onCommandMatchesChanged: commandIndex = 0
  function moveCommand(delta) {
    var count = commandMatches.items.length
    if (count) commandIndex = (commandIndex + delta + count) % count
    commandList.positionViewAtIndex(commandIndex, ListView.Contain)
  }
  function chooseCommand(index) {
    var selected = index === undefined ? commandIndex : index
    if (selected < 0 || selected >= commandMatches.items.length) return false
    field.text = field.text.slice(0, commandMatches.start) + commandMatches.items[selected].prompt
    field.cursorPosition = field.text.length
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
    return submit(field.text)
  }
  function newChat() {
    if (working || pending.busy) return
    ignoredJobId = defaultJob ? String(defaultJob.id) : ""
    viewedJobId = ""
    viewedConversationId = ""
    historyMode = false
    field.text = ""
    localError = ""
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
  function submit(promptText) {
    if (!service) return false
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
    field.text = prompt
    localError = ""
    if (job && !job.canContinue) {
      localError = "Start a new chat to ask again."
      return false
    }
    var accepted = job ? service.answerAgent(String(job.id), prompt)
      : (composer ? service.askAgentDraft(fields, prompt)
        : (overSelection ? service.askAgentMany(messageIds, prompt, accountId)
          : service.askAgent(messageId, prompt, accountId)))
    if (!accepted) localError = service.agentError || "AI could not start. Check the message and try again."
    else {
      field.text = ""
      submittedScope = queueScope
      submittedPrompt = prompt
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

  QQC.Popup {
    id: moreMenu
    objectName: "agent-more-menu"
    width: Math.min(Style.space(200), root.width - Style.space(24))
    padding: Style.space(4)
    focus: true
    property int cursorIndex: -1
    readonly property var rows: [newChatRow, historyRow]
    closePolicy: QQC.Popup.CloseOnEscape | QQC.Popup.CloseOnPressOutside
    function place() {
      var anchor = closeButton.mapToItem(root, 0, 0)
      x = Math.max(0, Math.min(anchor.x + closeButton.width - width, root.width - width))
      var next = anchor.y + closeButton.height + Style.space(4)
      if (next + height > root.height) next = anchor.y - height
      y = Math.max(0, Math.min(next, root.height - height))
    }
    onOpened: { cursorIndex = Menu.firstSelectable(rows); place() }
    onHeightChanged: if (visible) place()
    background: Rectangle { color: root.popupBackgroundColor; border.color: root.popupBorderColor }
    contentItem: Column {
      spacing: Style.space(2)
      focus: true
      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Up || event.key === Qt.Key_Down) {
          moreMenu.cursorIndex = Menu.nextSelectable(moreMenu.rows, moreMenu.cursorIndex, event.key === Qt.Key_Up ? -1 : 1)
          event.accepted = true
        } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
          var row = moreMenu.rows[moreMenu.cursorIndex]
          if (row && row.enabled) row.activated()
          event.accepted = true
        }
      }
      MenuActionRow {
        id: newChatRow
        objectName: "agent-new-chat-menu-row"
        width: moreMenu.availableWidth
        text: "New chat"
        textColor: root.textColor
        panelFontFamily: root.panelFontFamily
        collection: moreMenu.rows
        cursorIndex: moreMenu.cursorIndex
        enabled: !root.working && !pending.busy
        onActivated: { moreMenu.close(); root.newChat() }
      }
      MenuActionRow {
        id: historyRow
        width: moreMenu.availableWidth
        text: "History..."
        textColor: root.textColor
        panelFontFamily: root.panelFontFamily
        collection: moreMenu.rows
        cursorIndex: moreMenu.cursorIndex
        onActivated: { moreMenu.close(); root.showHistory() }
      }
    }
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
          width: parent.width - closeButton.width - parent.spacing
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
        Button {
          id: closeButton
          objectName: "agent-more-button"
          width: Style.space(20)
          height: Style.space(20)
          bordered: true
          focusable: true
          horizontalPadding: 0
          verticalPadding: 0
          foreground: root.dimColor
          accent: root.accentColor
          fontFamily: root.panelFontFamily
          tooltipText: "More..."
          selected: moreMenu.visible
          Accessible.name: "More AI actions"
          ActionIcon {
            anchors.centerIn: parent
            name: "more"
            iconSize: Style.font.iconSmall
            color: root.dimColor
            fontFamily: root.panelFontFamily
          }
          onClicked: moreMenu.open()
        }
      }
      Flickable {
        id: answerFlick
        visible: !root.historyMode
        width: parent.width
        height: Math.max(Style.space(32), content.height - y - controls.implicitHeight - pendingRows.implicitHeight - (pendingRows.visible ? Style.space(8) : 0) - requestRow.implicitHeight - statusText.implicitHeight - Style.space(8) * (controls.implicitHeight > 0 ? 3 : 2)
          - (changedNotice.visible ? changedNotice.implicitHeight + Style.space(8) : 0))
        contentWidth: width
        contentHeight: Math.max(height, chat.implicitHeight)
        property bool followEnd: true
        property real lastContentY: 0
        onContentYChanged: {
          if (contentY < lastContentY) followEnd = false
          if (atYEnd) followEnd = true
          lastContentY = contentY
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
          Repeater {
            model: chatModel
            Item {
              required property string entryRole
              required property string entryText
              required property int index
              readonly property bool userMessage: entryRole === "user"
              width: chat.width
              height: entry.implicitHeight + (userMessage ? Style.space(16) : (replyCopy.visible ? replyCopy.height + Style.space(4) : 0))
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
              QQC.AbstractButton {
                id: replyCopy
                objectName: "agent-copy-reply"
                property bool copied: false
                Timer { id: copyFeedback; interval: 1600; onTriggered: replyCopy.copied = false }
                visible: entryRole === "assistant" && !root.working
                anchors.left: parent.left
                anchors.bottom: parent.bottom
                width: Style.font.iconSmall
                height: Style.font.iconSmall
                padding: 0
                hoverEnabled: true
                focusPolicy: Qt.StrongFocus
                background: null
                Accessible.name: copied ? "Copied" : "Copy reply"
                contentItem: ActionIcon {
                  name: replyCopy.copied ? "check" : "copy"
                  iconSize: Style.font.iconSmall
                  color: replyCopy.hovered || replyCopy.activeFocus ? root.textColor : root.dimColor
                  fontFamily: root.panelFontFamily
                }
                PanelToolTip {
                  visible: replyCopy.hovered
                  text: replyCopy.copied ? "Copied" : "Copy reply"
                  fontFamily: root.panelFontFamily
                }
                onClicked: { root.copyReply(entryText); copied = true; copyFeedback.restart() }
              }
              TextEdit {
                id: entry
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
      Text {
        id: changedNotice
        textFormat: Text.PlainText
        width: parent.width
        visible: !root.historyMode && root.draftChanged
        text: "This draft changed. Follow-ups use the original draft; start a new chat to include your edits."
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
      Flow {
        id: controls
        visible: !root.historyMode
        width: parent.width
        spacing: Style.space(6)
        Button {
          objectName: "agent-insert"
          text: "Insert at cursor"
          visible: !!root.composer && root.answer !== ""
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
          visible: !!root.composer && root.answer !== ""
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
          : (root.job ? Agent.stateLabel(root.job) : "Ask your system AI about this mail."))
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
      anchors.topMargin: closeButton.height + Style.space(8)
      clip: true
      model: root.historyJobs
      keyNavigationEnabled: true
      spacing: Style.space(4)
      QQC.ScrollBar.vertical: QQC.ScrollBar {}
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
      id: commandMenu
      objectName: "agent-commands"
      visible: root.commandsOpen
      z: 80
      x: content.x
      y: Math.max(content.y, content.y + requestRow.y - height - Style.space(8))
      width: inputScroll.width
      height: Math.min(commandList.contentHeight + Style.space(8), Math.max(Style.space(28), requestRow.y - Style.space(8)))
      color: root.popupBackgroundColor
      border.color: root.popupBorderColor
      ListView {
        id: commandList
        anchors.fill: parent
        anchors.margins: Style.space(4)
        clip: true
        model: root.commandMatches.items
        currentIndex: root.commandIndex
        QQC.ScrollBar.vertical: QQC.ScrollBar {}
        delegate: QQC.ItemDelegate {
          required property var modelData
          required property int index
          width: commandList.width
          height: Style.spacing.popupRowHeight
          highlighted: index === root.commandIndex
          focusPolicy: Qt.NoFocus
          contentItem: Text {
            text: "/" + modelData.command + " · " + modelData.label
            textFormat: Text.PlainText
            color: root.textColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.bodySmall
            elide: Text.ElideRight
          }
          background: Rectangle {
            color: parent.highlighted || parent.hovered
              ? Style.selectedFillFor(root.textColor, root.accentColor)
              : Style.normalFillFor(root.textColor, root.accentColor)
          }
          onClicked: root.chooseCommand(index)
        }
      }
    }
  }
}
