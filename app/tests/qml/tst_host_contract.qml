import QtQuick
import QtTest
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "../../../ui" as Omamail

TestCase {
  id: testCase
  name: "StandaloneHostContract"
  when: windowShown
  width: 640
  height: 480

  HostFixture { id: host }

  Component {
    id: nativeProcessComponent
    QtObject {
      property var command: []
      property bool running: false
      property bool stdinEnabled: false
      property string stderrText: ""
      property string written: ""
      signal started()
      signal exited(int exitCode)
      signal stdoutLine(string line)
      signal stderrLine(string line)
      function write(value) { written += String(value) }
      function terminate() { running = false }
    }
  }

  Component { id: parserComponent; SplitParser { splitMarker: "|" } }
  Component { id: fileComponent; FileView { path: "/fixture/existing"; watchChanges: true } }
  Component { id: processComponent; Process {} }
  Component {
    id: controlledNumberComponent
    Item {
      property int modelValue: 2
      property int proposedValue: -1
      property alias control: controlledNumber
      NumberField {
        id: controlledNumber
        value: parent.modelValue
        onModified: function(value) { parent.proposedValue = value }
      }
    }
  }
  Component {
    id: controlledToggleComponent
    Item {
      property bool modelValue: false
      property var proposedValue: null
      property alias control: controlledToggle
      ToggleSwitch {
        id: controlledToggle
        checked: parent.modelValue
        onToggled: parent.proposedValue = !parent.modelValue
      }
    }
  }
  Component {
    id: controlledDropdownComponent
    Item {
      property string modelValue: "one"
      property string proposedValue: ""
      property alias control: controlledDropdown
      Dropdown {
        id: controlledDropdown
        options: [{ label: "One", value: "one" }, { label: "Two", value: "two" }]
        value: parent.modelValue
        onChanged: function(value) { parent.proposedValue = value }
      }
    }
  }
  Component {
    id: notificationProcessComponent
    Process {
      property string targetAccountId: "account-1"
      property string messageId: "message-9"
      command: ["python3", "/bundle/scripts/notify-mail.py", "foreground",
        "accent", "--", "A sender", "A subject"]
    }
  }
  Component { id: windowComponent; FloatingWindow { visible: false; minimumSize: Qt.size(320, 240) } }
  Component { id: sharedAppComponent; Omamail.App { opened: false } }

  Item {
    id: controls
    visible: false
    Button { id: button; text: "Save" }
    TextField { id: textField; password: true }
    BorderSurface { id: surface; borderSpec: Border.controlSpec("normal", Color.foreground, Color.accent) }
    NumberField { id: numberField; label: "Count"; from: 1; to: 10; value: 4 }
    PanelActionButton { id: actionButton; iconText: "+" }
    PanelSeparator { id: separator }
    PanelSectionHeader { id: sectionHeader; text: "Section" }
    PanelToolTip { id: toolTip; text: "Help" }
    ToggleSwitch { id: toggle }
    Dropdown { id: dropdown; options: [{ label: "One", value: "one" }]; value: "one" }
  }

  function init() {
    host.reset()
    Quickshell.nativeHost = host
    Quickshell.fileStore = host
  }

  function test_environment_and_detached_operations_use_native_host() {
    compare(Quickshell.env("HOME"), "/fixture/home")
    Quickshell.execDetached(["xdg-open", "https://example.test/path"])
    Quickshell.execDetached(["wl-copy", "copy me"])
    compare(host.opened, ["https://example.test/path"])
    compare(host.copied, ["copy me"])
    verify(!Quickshell.execDetached(["sh", "anything"]));
    compare(host.opened.length, 1)
    compare(host.copied.length, 1)
  }

  function test_notification_process_routes_to_native_host() {
    var process = createTemporaryObject(notificationProcessComponent, testCase)
    verify(process)
    process.running = true
    tryCompare(process, "running", false)
    compare(host.notifications.length, 1)
    compare(host.notifications[0], {
      id: "account-1:message-9", title: "A sender", body: "A subject",
      accountId: "account-1", messageId: "message-9"
    })
  }

  function test_semantic_theme_comes_from_a_valid_system_palette() {
    verify(Color.foreground.valid)
    verify(Color.background.valid)
    verify(Color.accent.valid)
    verify(Color.urgent.valid)
    verify(Color.popups.background.valid)
    verify(Color.popups.border.valid)
    verify(Style.normalBorderColor.valid)
    verify(Style.selectedAccentFill.valid)
    verify(Style.space(8) > 0)
    verify(Style.mutedColorFor(Color.foreground, Color.background).valid)
  }

  function test_split_parser_buffers_incomplete_frames() {
    var parser = createTemporaryObject(parserComponent, testCase)
    verify(parser)
    var reads = []
    parser.read.connect(function(value) { reads.push(value) })
    parser.accept("one|tw")
    compare(reads, ["one"])
    compare(parser.pending, "tw")
    parser.accept("o|")
    compare(reads, ["one", "two"])
    compare(parser.pending, "")
  }

  function test_file_view_translates_store_results_and_matching_events() {
    var file = createTemporaryObject(fileComponent, testCase, { store: host })
    verify(file)
    compare(file.text(), "saved")
    compare(host.watched["/fixture/existing"], true)
    file.setText("new value")
    compare(host.files["/fixture/existing"], "new value")

    var changes = 0
    file.fileChanged.connect(function() { changes++ })
    host.changed("/fixture/other")
    compare(changes, 0)
    host.changed("/fixture/existing")
    compare(changes, 1)
  }

  function test_process_adapts_native_lines_and_lifecycle() {
    var nativeProcess = nativeProcessComponent.createObject(testCase)
    var process = createTemporaryObject(processComponent, testCase, {
      nativeProcess: nativeProcess,
      command: ["omamail", "serve"],
      stdinEnabled: true
    })
    verify(process)
    var lines = []
    process.stdout = parserComponent.createObject(process, { splitMarker: "\n" })
    process.stdout.read.connect(function(value) { lines.push(value) })
    process.running = true
    compare(nativeProcess.command, ["omamail", "serve"])
    compare(nativeProcess.stdinEnabled, true)
    compare(nativeProcess.running, true)
    nativeProcess.stdoutLine("ready")
    compare(lines, ["ready"])
    process.write("request\n")
    compare(nativeProcess.written, "request\n")
  }

  function test_process_clears_collected_output_before_each_run() {
    var nativeProcess = nativeProcessComponent.createObject(testCase)
    var process = createTemporaryObject(processComponent, testCase, {
      nativeProcess: nativeProcess,
      command: ["credential-helper"]
    })
    verify(process)
    process.running = true
    nativeProcess.stdoutLine("old-credential")
    nativeProcess.running = false
    nativeProcess.exited(0)
    compare(process.stdout.text, "old-credential\n")

    process.running = true
    compare(process.stdout.text, "")
    nativeProcess.running = false
    nativeProcess.exited(0)
    compare(process.stdout.text, "")
  }

  function test_process_clears_partial_parser_state_before_each_run() {
    var nativeProcess = nativeProcessComponent.createObject(testCase)
    var parser = parserComponent.createObject(testCase)
    var process = createTemporaryObject(processComponent, testCase, {
      nativeProcess: nativeProcess,
      stdout: parser,
      command: ["line-helper"]
    })
    verify(process)
    parser.accept("partial")
    compare(parser.pending, "partial")
    process.running = true
    compare(parser.pending, "")
  }

  function test_number_field_emits_without_replacing_external_value() {
    var wrapper = createTemporaryObject(controlledNumberComponent, testCase)
    verify(wrapper)
    var input = findChild(wrapper.control, "number-field-input")
    verify(input)
    input.value = 6
    input.valueModified()
    compare(wrapper.proposedValue, 6)
    compare(wrapper.control.value, 2)
    compare(input.value, 2)
    wrapper.modelValue = 8
    compare(wrapper.control.value, 8)
    compare(input.value, 8)
  }

  function test_toggle_emits_without_replacing_external_value() {
    var wrapper = createTemporaryObject(controlledToggleComponent, testCase)
    verify(wrapper)
    var input = findChild(wrapper.control, "toggle-switch-input")
    verify(input)
    input.checked = true
    input.toggled()
    compare(wrapper.proposedValue, true)
    compare(wrapper.control.checked, false)
    compare(input.checked, false)
    wrapper.modelValue = true
    compare(wrapper.control.checked, true)
    compare(input.checked, true)
  }

  function test_dropdown_emits_without_replacing_external_value() {
    var wrapper = createTemporaryObject(controlledDropdownComponent, testCase)
    verify(wrapper)
    var input = findChild(wrapper.control, "dropdown-input")
    verify(input)
    input.activated(1)
    compare(wrapper.proposedValue, "two")
    compare(wrapper.control.value, "one")
    compare(input.currentIndex, 0)
    wrapper.modelValue = "two"
    compare(wrapper.control.value, "two")
    compare(input.currentIndex, 1)
  }

  function test_shared_non_bar_controls_construct_with_the_contract() {
    compare(button.text, "Save")
    compare(textField.echoMode, TextInput.Password)
    compare(surface.border.width, surface.borderSpec.width)
    compare(numberField.value, 4)
    compare(actionButton.iconText, "+")
    verify(separator.implicitHeight > 0)
    compare(sectionHeader.text, "Section")
    compare(toolTip.text, "Help")
    compare(toggle.checked, false)
    compare(dropdown.value, "one")
  }

  function test_shared_application_constructs_with_production_imports() {
    compare(sharedAppComponent.status, Component.Ready)
  }

  function test_floating_window_is_a_real_window() {
    var floating = createTemporaryObject(windowComponent, testCase)
    verify(floating)
    compare(floating.minimumWidth, 320)
    compare(floating.minimumHeight, 240)
    floating.close()
  }
}
