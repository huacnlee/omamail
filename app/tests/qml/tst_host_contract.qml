import QtQuick
import QtTest
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "../../../ui" as Omamail
import "../../../ui/components" as Components

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
      property var modelOptions: [
        { label: "One", value: "one" },
        { label: "Two", value: "two" },
        { label: "Three", value: "three" }
      ]
      property string proposedValue: ""
      property alias control: controlledDropdown
      Dropdown {
        id: controlledDropdown
        options: parent.modelOptions
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
  Component { id: actionIconComponent; Components.ActionIcon { name: "archive" } }

  Item {
    id: controls
    visible: false
    Button { id: button; text: "Save"; tooltipText: "Save help" }
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
    Color.reload()
  }

  function test_panel_tooltip_uses_shared_hover_delay() {
    compare(toolTip.delay, Style.tooltipDelay)
    compare(String(toolTip.palette.window), String(Color.popups.background))
    compare(String(toolTip.palette.windowText), String(Color.popups.text))
  }

  function test_tooltip_draws_an_opaque_nonzero_surface_behind_its_text() {
    Color.applySystemAppearance("light")
    toolTip.visible = true
    tryCompare(toolTip, "opened", true, Style.tooltipDelay + 1000)
    verify(toolTip.width > toolTip.contentItem.implicitWidth)
    verify(toolTip.height > toolTip.contentItem.implicitHeight)
    compare(toolTip.background.width, toolTip.width)
    compare(toolTip.background.height, toolTip.height)
    verify(toolTip.background.visible)
    compare(toolTip.background.opacity, 1)
    compare(toolTip.background.color.a, 1)
    verify(toolTip.background.z < toolTip.contentItem.z)
    compare(String(toolTip.background.color), String(Color.popups.background))
    compare(String(toolTip.background.color), String(Color.background))
    toolTip.visible = false
    tryCompare(toolTip, "opened", false)
  }

  function test_button_tooltip_uses_the_shared_styled_surface() {
    verify(findChild(button, "omamail-tooltip-background"))
    verify(findChild(button, "omamail-tooltip-label"))
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
    compare(String(Color.popups.background), String(Color.background))
    verify(Color.popups.border.valid)
    verify(Style.normalBorderColor.valid)
    verify(Style.selectedAccentFill.valid)
    verify(Style.space(8) > 0)
    verify(Style.mutedColorFor(Color.foreground, Color.background).valid)
    compare(Style.cornerRadius, 0)
    compare(Style.font.body, 12)
    compare(Style.font.caption, 10)
    compare(Style.font.iconSmall, 11)
    compare(Style.font.icon, 14)
    compare(Style.font.iconLarge, 18)
    compare(Style.spacing.controlHeight, 28)
    compare(Style.spacing.controlPaddingX, 10)
    compare(Style.spacing.controlPaddingY, 6)
    compare(Style.spacing.inputPaddingY, 7)
    compare(Style.spacing.controlGap, 8)
  }

  function test_standalone_uses_native_text_and_bundles_the_nerd_icon_range() {
    tryCompare(Style.iconFont, "status", FontLoader.Ready)
    compare(Style.font.family, Style.metrics.font.family)
    verify(Style.font.family.length > 0)
    compare(Style.font.iconFamily, "Symbols Nerd Font Mono")
    var icon = createTemporaryObject(actionIconComponent, testCase)
    verify(icon)
    compare(icon.fontFamily, Style.font.iconFamily)
    compare(icon.glyphText.codePointAt(0), 0xF120E)
  }

  function test_current_omarchy_theme_wins_over_stale_legacy_theme() {
    host.files = ({
      "/fixture/home/.local/state/omarchy/current/theme/colors.toml":
        "background='#111111'\nforeground='#eeeeee'\naccent='#123456'\nred='#cc3333'\nyellow='#cccc33'\ngreen='#33cc33'",
      "/fixture/home/.config/omarchy/current/theme/colors.toml":
        "background='#ffffff'\nforeground='#000000'\naccent='#abcdef'\nred='#990000'\nyellow='#996600'\ngreen='#006600'"
    })
    verify(Color.reload())
    compare(String(Color.background), "#111111")
    compare(String(Color.accent), "#123456")
  }

  function test_legacy_theme_is_used_only_without_state_current() {
    host.files = ({
      "/fixture/home/.config/omarchy/current/theme/colors.toml":
        "background='#ffffff'\nforeground='#000000'\naccent='#205ea6'\nred='#af3029'\nyellow='#855b00'\ngreen='#526600'"
    })
    verify(Color.reload())
    compare(String(Color.background), "#ffffff")
    compare(String(Color.accent), "#205ea6")
  }

  function test_invalid_current_theme_falls_back_atomically() {
    host.files = ({
      "/fixture/home/.local/state/omarchy/current/theme/colors.toml":
        "background='#010203'\nforeground='#ffffff'\naccent='bad'",
      "/fixture/home/.config/omarchy/current/theme/colors.toml":
        "background='#ffffff'\nforeground='#000000'\naccent='#abcdef'\nred='#990000'\nyellow='#996600'\ngreen='#006600'"
    })
    Color.applySystemAppearance("dark")
    verify(!Color.reload())
    compare(String(Color.background), "#1a1b26")
    compare(String(Color.foreground), "#a9b1d6")
    compare(String(Color.accent), "#7aa2f7")
    compare(String(Color.urgent), "#f7768e")
  }


  function test_system_scheme_switches_complete_fallback_but_not_omarchy_theme() {
    host.files = ({})
    Color.reload()
    verify(!Color.hasOmarchyTheme)
    verify(Color.applySystemAppearance("light"))
    compare(Color.dark, false)
    compare(String(Color.background), "#fffcf0")
    compare(String(Color.foreground), "#100f0f")
    compare(String(Color.accent), "#205ea6")
    compare(String(Color.surface), "#f2f0e5")
    compare(String(Color.inset), "#e6e4d9")
    compare(String(Color.border), "#b7b5ac")

    verify(Color.applySystemAppearance("dark"))
    compare(Color.dark, true)
    compare(String(Color.background), "#1a1b26")

    var path = "/fixture/home/.local/state/omarchy/current/theme/colors.toml"
    host.files[path] =
      "mode='light'\nbackground='#ffffff'\nforeground='#111111'\naccent='#123456'\nred='#990000'\nyellow='#996600'\ngreen='#006600'"
    verify(Color.reload())
    verify(Color.hasOmarchyTheme)
    compare(String(Color.accent), "#123456")
    verify(!Color.applySystemAppearance("dark"))
    compare(String(Color.accent), "#123456")
    compare(Color.dark, false)
  }

  function test_preferred_appearance_overrides_the_desktop_but_not_omarchy() {
    host.files = ({})
    Color.preferredAppearance = ""
    Color.reload()
    verify(!Color.hasOmarchyTheme)
    Color.preferredAppearance = "dark"
    compare(Color.dark, true)
    compare(String(Color.background), "#1a1b26")
    Color.preferredAppearance = "light"
    compare(Color.dark, false)
    compare(String(Color.background), "#fffcf0")
    // The desktop's scheme only decides when nothing is preferred.
    verify(Color.applySystemAppearance("dark"))
    compare(Color.dark, true)
    compare(Color.fallbackAppearance(), "light")
    Color.reload()
    compare(Color.dark, false)

    var path = "/fixture/home/.local/state/omarchy/current/theme/colors.toml"
    host.files[path] =
      "mode='dark'\nbackground='#010203'\nforeground='#fefefe'\naccent='#123456'\nred='#990000'\nyellow='#996600'\ngreen='#006600'"
    verify(Color.reload())
    verify(Color.hasOmarchyTheme)
    Color.preferredAppearance = "light"
    compare(Color.dark, true)
    compare(String(Color.background), "#010203")
    Color.preferredAppearance = ""
  }

  function test_theme_change_reloads_the_active_palette() {
    var path = "/fixture/home/.local/state/omarchy/current/theme/colors.toml"
    host.files = ({})
    host.files[path] =
      "background='#111111'\nforeground='#eeeeee'\naccent='#123456'\nred='#cc3333'\nyellow='#cccc33'\ngreen='#33cc33'"
    verify(Color.reload())
    verify(host.watched[path])

    host.files[path] =
      "background='#222222'\nforeground='#ffffff'\naccent='#654321'\nred='#dd4444'\nyellow='#dddd44'\ngreen='#44dd44'"
    host.changed(path)
    compare(String(Color.background), "#222222")
    compare(String(Color.accent), "#654321")
  }

  function test_shell_theme_and_user_override_apply_atomically() {
    var themeRoot = "/fixture/home/.local/state/omarchy/current/theme"
    var userShell = "/fixture/home/.config/omarchy/shell.toml"
    host.files = ({})
    host.files[themeRoot + "/colors.toml"] =
      "background='#101010'\nforeground='#eeeeee'\naccent='#336699'\nred='#cc3333'\nyellow='#cccc33'\ngreen='#33cc33'"
    host.files[themeRoot + "/shell.toml"] =
      "[font]\nbase-size=14\nbody=17\n"
      + "[spacing]\nscale=1.5\nscale-with-font=false\ncontrol-height=31\n"
      + "[controls]\nnormal-fill-alpha=0.12\nselected-color=accent\n"
      + "[popups]\nbackground=background\nbackground-alpha=0.8\ntext=accent\nborder=foreground\nborder-alpha=0.3"
    host.files[userShell] =
      "[font]\nbase-size=16\n[spacing]\ncontrol-height=38\n"
      + "[controls]\nnormal-fill-alpha=0.2"

    verify(Color.reload())
    compare(Style.font.body, 17)
    compare(Style.font.caption, 13)
    compare(Style.spacing.controlHeight, 38)
    compare(Style.space(10), 15)
    fuzzyCompare(Style.normalFillFor(Color.foreground, Color.accent).a, 0.2, 0.001)
    compare(String(Style.selectedStateColor(Color.foreground, Color.accent)), "#336699")
    compare(String(Color.popups.text), "#336699")
    fuzzyCompare(Color.popups.background.a, 0.8, 0.001)
    fuzzyCompare(Color.popups.border.a, 0.3, 0.001)
    verify(host.watched[themeRoot + "/shell.toml"])
    verify(host.watched[userShell])
  }

  function test_shell_theme_watch_removes_stale_user_overrides() {
    var themeRoot = "/fixture/home/.local/state/omarchy/current/theme"
    var userShell = "/fixture/home/.config/omarchy/shell.toml"
    host.files = ({})
    host.files[themeRoot + "/colors.toml"] =
      "background='#101010'\nforeground='#eeeeee'\naccent='#336699'\nred='#cc3333'\nyellow='#cccc33'\ngreen='#33cc33'"
    host.files[themeRoot + "/shell.toml"] = "[font]\nbase-size=14\n[spacing]\ncontrol-height=30"
    host.files[userShell] = "[font]\nbase-size=18\n[spacing]\ncontrol-height=44"
    verify(Color.reload())
    compare(Style.font.body, 18)
    compare(Style.spacing.controlHeight, 44)

    var replacement = ({})
    replacement[themeRoot + "/colors.toml"] = host.files[themeRoot + "/colors.toml"]
    replacement[themeRoot + "/shell.toml"] = host.files[themeRoot + "/shell.toml"]
    host.files = replacement
    host.changed(userShell)
    compare(Style.font.body, 14)
    compare(Style.spacing.controlHeight, 30)
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

  function test_file_view_reports_a_failed_read_once() {
    var file = createTemporaryObject(fileComponent, testCase, { store: host, path: "/fixture/missing" })
    verify(file)
    var failures = 0
    file.loadFailed.connect(function() { failures++ })
    file.reload()
    compare(failures, 1)
    host.failed("/fixture/missing", "external")
    compare(failures, 2)
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
    input.currentIndex = 1
    input.activated(1)
    compare(wrapper.proposedValue, "two")
    compare(wrapper.control.value, "one")
    compare(input.currentIndex, 0)
    wrapper.modelValue = "two"
    compare(wrapper.control.value, "two")
    compare(input.currentIndex, 1)
    wrapper.modelOptions = [
      { label: "Three renamed", value: "three" },
      { label: "One renamed", value: "one" },
      { label: "Two renamed", value: "two" }
    ]
    tryCompare(input, "currentIndex", 2)
    compare(wrapper.control.value, "two")
    compare(input.currentValue, "two")
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

  function test_floating_window_hosts_shared_content() {
    var floating = createTemporaryObject(windowComponent, testCase)
    verify(floating)
    compare(floating.minimumSize.width, 320)
    compare(floating.minimumSize.height, 240)
  }
}
