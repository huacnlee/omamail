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
    function test_unavailable_note_describes_the_feature_minimum() {
      var note = findChild(panel, "settings-ai-note")
      verify(note, "the panel explains its state in one place")
      verify(note.text.indexOf("API 6") < 0, "a ready backend needs no API note")
      service.backendCanChooseAgent = false
      verify(note.text.indexOf("API 6 or newer") >= 0, "the gate names its minimum revision")
      verify(note.text.indexOf("API 6 required") < 0, "the gate does not present API 6 as the current requirement")
    }
  }
}
