import QtQuick
import qs.Commons
import qs.Ui
import "../agent/Options.js" as Options

Column {
  id: root
  required property var service
  required property color textColor
  required property color dimColor
  required property color accentColor
  required property string panelFontFamily
  property string error: ""
  spacing: Style.space(6)
  readonly property bool available: !!service && service.backendCanChooseAgent === true

  function saveModel() {
    if (!available) return
    var model = modelEdit.text.trim()
    if (!Options.validModel(model)) {
      error = "Use a model ID without spaces or control characters (up to 200 characters)."
      return
    }
    error = ""
    if (model !== String(service.aiModel || "")) service.setAiModel(model)
  }
  Text {
    width: parent.width
    text: "AI"
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    font.letterSpacing: 1
  }
  Text {
    text: "Agent"
    color: root.textColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.bodySmall
  }
  Dropdown {
    objectName: "settings-ai-agent"
    width: parent.width
    showLabel: false
    value: Options.agent(root.service ? root.service.aiAgent : "")
    options: Options.agents().map(function(label) { return {label: label, value: label} })
    enabled: root.available
    foreground: root.textColor
    accent: root.accentColor
    fontFamily: root.panelFontFamily
    onChanged: function(next) { if (root.available) root.service.setAiAgent(next) }
  }
  Text {
    text: "Model (optional)"
    color: root.textColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.bodySmall
  }
  TextField {
    id: modelEdit
    objectName: "settings-ai-model"
    width: parent.width
    text: root.service ? String(root.service.aiModel || "") : ""
    placeholderText: "Agent default"
    enabled: root.available
    foreground: root.textColor
    accent: root.accentColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.bodySmall
    onActiveFocusChanged: if (!activeFocus) root.saveModel()
    onAccepted: root.saveModel()
  }
  Text {
    width: parent.width
    textFormat: Text.PlainText
    text: !root.available ? "Update the mail backend to choose an AI agent or model (API 6 required)."
      : root.error || (root.service.agentAvailable === false ? root.service.agentUnavailableReason + "\n" : "") + "System default follows Omarchy. Leave the model blank to use the agent's default. "
        + "OpenCode takes provider/model or provider/model#variant; Codex and Claude take model names. "
        + "Changing the agent or model starts fresh chats. Previous chats remain read-only in History."
    color: !root.available || root.error !== "" ? root.accentColor : root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }
}
