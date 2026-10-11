import QtQuick
import QtTest
import "../../components" as Mail

Item {
  width: 640
  height: 480
  Component {
    id: serviceFactory
    QtObject {
      property bool backendCanChooseAgent: true
      property string aiAgent: "System default"
      property string aiModel: ""
      property var writes: []
      function setAiAgent(value) { aiAgent = value; writes = writes.concat(["agent"]) }
      function setAiModel(value) { aiModel = value; writes = writes.concat(["model"]) }
    }
  }
  Component {
    id: panelFactory
    Mail.AiSettings {
      width: 480
      textColor: palette.windowText
      dimColor: palette.placeholderText
      accentColor: palette.highlight
      panelFontFamily: "sans-serif"
      SystemPalette { id: palette }
    }
  }
  TestCase {
    name: "AiSettings"
    when: windowShown
    property var service
    property var panel
    function init() {
      service = createTemporaryObject(serviceFactory, parent)
      panel = createTemporaryObject(panelFactory, parent, {service: service})
      verify(panel)
    }
    function test_defaults_do_not_write_settings_and_changes_save_once() {
      var picker = findChild(panel, "settings-ai-agent")
      var model = findChild(panel, "settings-ai-model")
      compare(picker.value, "System default")
      compare(model.text, "")
      compare(service.writes.length, 0)
      picker.changed("OpenCode")
      compare(service.aiAgent, "OpenCode")
      model.text = "fixture/model#variant"
      model.accepted()
      panel.saveModel()
      compare(service.aiModel, "fixture/model#variant")
      compare(service.writes, ["agent", "model"])
      model.text = ""
      model.accepted()
      compare(service.aiModel, "")
    }
    function test_invalid_model_and_old_backend_do_not_persist() {
      var model = findChild(panel, "settings-ai-model")
      model.text = "--auto"
      model.accepted()
      verify(panel.error !== "")
      compare(service.writes.length, 0)
      service.backendCanChooseAgent = false
      verify(!model.enabled)
      model.text = "valid-model"
      panel.saveModel()
      findChild(panel, "settings-ai-agent").changed("Codex")
      compare(service.writes.length, 0)
    }
  }
}
