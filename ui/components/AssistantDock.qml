import QtQuick
import qs.Commons

// The assistant column at the right of the window: the mailbox agent and the
// Compose agent share it, with a splitter on its left edge to resize it.
Item {
  id: dock

  required property var app
  required property var composer
  required property var router
  required property Item focusTarget

  readonly property var agentPrompt: agentPromptLoader.item
  readonly property var composeAgent: composeAgentLoader.item

  objectName: "assistant-dock"
  width: app.assistantWidth
  visible: app.assistantOpen

  MouseArea {
    objectName: "assistant-splitter"
    anchors.left: parent.left
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    width: Style.space(5)
    z: 100
    cursorShape: Qt.SplitHCursor
    property real grabbedAt: 0
    property real grabbedWidth: 0
    onPressed: function(mouse) {
      grabbedAt = mapToItem(dock.focusTarget, mouse.x, mouse.y).x
      grabbedWidth = dock.app.assistantWidth
    }
    onPositionChanged: function(mouse) {
      if (!pressed) return
      var moved = mapToItem(dock.focusTarget, mouse.x, mouse.y).x - grabbedAt
      dock.app.preferredAssistantWidth = Math.max(dock.app.assistantMinWidth,
        Math.min(dock.app.assistantMaxWidth, grabbedWidth - moved))
    }
    onDoubleClicked: dock.app.preferredAssistantWidth = 0
  }
  Loader {
    id: agentPromptLoader
    active: !!dock.app.service && dock.app.service.hasAgent !== false
    anchors.fill: parent
    sourceComponent: Component {
      AgentPrompt {
        proposalComposer: dock.composer
        onApplyProposalRequested: function(envelope, parentId) {
          dock.composer.beginProposal(envelope, parentId)
          // Keep the conversation alongside the draft, with typing in the editor.
          Qt.callLater(function() {
            dock.focusTarget.applyContextFocus()
            dock.app.composeAgent.open(false)
          })
        }
        onOpenedChanged: if (opened) dock.app.composeAgent.close()
        objectName: "agent-prompt"
        service: dock.app.service
        textColor: dock.app.foreground
        accentColor: dock.app.accent
        urgentColor: dock.app.urgent
        dimColor: dock.app.dim
        popupBackgroundColor: dock.app.popupBackground
        popupBorderColor: dock.app.popupBorder
        panelFontFamily: dock.app.fontFamily
        onFocusRequested: { dock.app.assistantEditing = true; Qt.callLater(dock.focusTarget.applyContextFocus) }
        onKeyPressed: function(event) { dock.router.routeKeyEvent(event) }
        onEditingChanged: function(editing) { dock.app.assistantEditing = editing }
        onDismissed: { dock.app.assistantEditing = false; Qt.callLater(dock.focusTarget.applyContextFocus) }
      }
    }
  }

  Loader {
    id: composeAgentLoader
    active: !!dock.app.service && dock.app.service.hasAgent !== false
    anchors.fill: parent
    sourceComponent: Component {
      ComposeAgent {
        onOpenedChanged: if (opened) dock.app.agentPrompt.close()
        objectName: "compose-agent"
        service: dock.app.service
        composer: dock.composer
        textColor: dock.app.foreground
        accentColor: dock.app.accent
        urgentColor: dock.app.urgent
        dimColor: dock.app.dim
        popupBackgroundColor: dock.app.popupBackground
        popupBorderColor: dock.app.popupBorder
        panelFontFamily: dock.app.fontFamily
        onFocusRequested: { dock.app.assistantEditing = true; Qt.callLater(dock.focusTarget.applyContextFocus) }
        onKeyPressed: function(event) { dock.router.routeKeyEvent(event) }
        onEditingChanged: function(editing) { dock.app.assistantEditing = editing }
        onDismissed: { dock.app.assistantEditing = false; Qt.callLater(dock.focusTarget.applyContextFocus) }
      }
    }
  }
}
