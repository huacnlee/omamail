import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui
import "../providers/OAuth.js" as OAuth

Column {
  id: root
  required property string pluginDir
  required property color textColor
  required property color dimColor
  required property color dangerColor
  required property color accentColor
  required property string panelFontFamily
  property string initialEmail: ""
  property string browser: "edge"
  property bool browserChosen: false
  property bool profileDetails: false
  property bool toolsChecked: false
  property var missingTools: []
  property string progress: ""
  property string error: ""
  property string pendingAccount: ""
  property bool completed: false
  property bool active: true
  property bool blocked: false
  property bool stopping: false
  readonly property bool busy: operation.running || installer.running || stopping
  readonly property bool installing: installer.running
  readonly property bool canEdit: !busy && !blocked
  readonly property bool validEmail: /^[^\s@]+@[^\s@]+$/.test(emailField.text.trim())
  readonly property bool canConnect: canEdit && !completed && toolsChecked
    && missingTools.length === 0 && pluginDir !== "" && validEmail
  signal ready(string account)
  signal setupStarting()
  spacing: Style.space(10)

  function start() {
    if (!canConnect) return
    var address = emailField.text.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) {
      error = "Enter the Google account email address first"
      emailField.forceActiveFocus()
      return
    }
    pendingAccount = address
    setupStarting()
    error = ""
    progress = "Starting personal setup"
    completed = false
    operation.command = ["python3", pluginDir + "/scripts/google-personal-setup.py",
      "--account", address, "--browser", browser]
    if (profileField.text.trim() !== "")
      operation.command = operation.command.concat(["--profile", profileField.text.trim()])
    operation.running = true
    deadline.restart()
  }

  function checkTools(clearError) {
    if (check.running || busy || blocked || pluginDir === "") return
    if (clearError !== false) error = ""
    toolsChecked = false
    check.command = ["python3", pluginDir + "/scripts/google-personal-setup.py", "--check"]
    check.running = true
    checkDeadline.restart()
  }

  function cancel() {
    if (installer.running) return false
    if (!operation.running) return true
    deadline.stop()
    completed = false
    stopping = true
    progress = "Stopping setup"
    error = ""
    operation.running = false
    return true
  }

  Component.onDestruction: { operation.running = false }
  Component.onCompleted: if (active) checkTools()
  onActiveChanged: if (active && !toolsChecked) checkTools()

  function installTools() {
    if (!canEdit || check.running || missingTools.length === 0) return
    error = ""
    progress = "Complete installation in the terminal. Setup will continue here automatically."
    installer.command = ["python3", pluginDir + "/scripts/google-personal-setup.py", "--install-tools-ui"]
    installer.running = true
  }

  Text {
    width: parent.width
    textFormat: Text.PlainText
    text: root.pluginDir === ""
      ? "Automatic setup is available in the Linux Omarchy plugin. Use an existing client below."
      : "Enter your Google address and approve access to Gmail and Calendar. Omamail handles the app setup for you."
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }
  TextField {
    id: emailField
    objectName: "google-setup-email"
    width: parent.width
    text: root.initialEmail
    placeholderText: "Google account email address"
    foreground: root.textColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.bodySmall
    enabled: root.canEdit && !root.completed
    onAccepted: root.start()
  }
  Dropdown {
    objectName: "google-setup-browser"
    width: parent.width
    label: "Browser for Google sign-in"
    value: root.browser
    options: [
      { value: "edge", label: "Microsoft Edge" },
      { value: "chrome", label: "Google Chrome" },
      { value: "chromium", label: "Chromium" },
      { value: "brave", label: "Brave" },
      { value: "firefox", label: "Firefox" }
    ]
    foreground: root.textColor
    accent: root.accentColor
    fontFamily: root.panelFontFamily
    enabled: root.canEdit && !root.completed
    onChanged: function(value) { root.browser = value; root.browserChosen = true }
  }
  Button {
    objectName: "google-setup-profile-toggle"
    text: root.profileDetails ? "Hide browser profile options" : "Use another browser profile..."
    foreground: root.dimColor
    bordered: false
    fontSize: Style.font.caption
    enabled: root.canEdit && !root.completed
    onClicked: root.profileDetails = !root.profileDetails
  }
  TextField {
    id: profileField
    objectName: "google-setup-profile"
    visible: root.profileDetails
    width: parent.width
    placeholderText: "Cookie database path — optional, for another browser profile"
    foreground: root.textColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.bodySmall
    enabled: root.canEdit && !root.completed
  }
  Text {
    width: parent.width
    textFormat: Text.PlainText
    text: "Already signed in? Setup continues automatically. Otherwise Google sign-in opens in this browser. Your Google session is used locally to create an app owned by you; cookies stay in memory and go only to Google. Experimental; each account needs its own setup."
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }
  Text {
    width: parent.width
    visible: !root.toolsChecked || root.missingTools.length > 0
    textFormat: Text.PlainText
    text: !root.toolsChecked ? "Checking setup tools"
      : "Install the setup tools once: " + root.missingTools.join(", ") + ". A terminal will open for installation."
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }
  Row {
    visible: (root.toolsChecked && root.missingTools.length > 0) || (!root.toolsChecked && root.error !== "")
    spacing: Style.space(8)
    Button {
      objectName: "google-setup-install"
      text: "Install setup tools..."
      visible: root.missingTools.length > 0
      foreground: root.textColor
      bordered: true
      fontSize: Style.font.bodySmall
      enabled: root.canEdit && !check.running
      onClicked: root.installTools()
    }
    Button {
      objectName: "google-setup-check"
      text: "Check again"
      foreground: root.dimColor
      bordered: false
      fontSize: Style.font.bodySmall
      enabled: root.canEdit && !check.running
      onClicked: root.checkTools()
    }
  }
  Row {
    spacing: Style.space(8)
    Button {
      objectName: "google-setup-start"
      text: root.stopping ? "Stopping" : operation.running ? "Connecting"
        : installer.running ? "Installing setup tools" : root.completed ? "App ready"
        : root.error !== "" ? "Retry connecting Gmail..." : "Connect Gmail..."
      foreground: root.textColor
      bordered: true
      fontSize: Style.font.bodySmall
      enabled: root.canConnect
      onClicked: root.start()
    }
    Button {
      objectName: "google-setup-cancel"
      visible: operation.running || root.stopping
      text: "Cancel"
      foreground: root.dimColor
      bordered: false
      fontSize: Style.font.bodySmall
      enabled: !root.stopping
      onClicked: root.cancel()
    }
  }
  Text {
    objectName: "google-setup-progress"
    width: parent.width
    visible: root.progress !== "" || root.error !== ""
    textFormat: Text.PlainText
    text: root.error !== "" ? root.error : root.progress
    color: root.error !== "" ? root.dangerColor : root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }
  Timer {
    id: checkDeadline
    interval: 10000
    onTriggered: {
      check.running = false
      root.error = "Could not check setup tools. Retry or use manual setup."
    }
  }
  Process {
    id: installer
    objectName: "google-tools-process"
    stdout: SplitParser {
      onRead: function(data) {
        if (data.length > 4096) return
        var result
        try { result = JSON.parse(data) } catch (e) { return }
        if (result.event === "error") root.error = OAuth.redact(String(result.message || "Installation failed."))
      }
    }
    stderr: SplitParser { onRead: function(data) {} }
    onExited: function(exitCode) {
      root.progress = ""
      if (exitCode !== 0 && root.error === "") root.error = "Installation did not finish. Retry the installer or use manual setup."
      Qt.callLater(function() { root.checkTools(false) })
    }
  }
  Process {
    id: check
    objectName: "google-check-process"
    stdout: SplitParser {
      onRead: function(data) {
        if (data.length > 4096) return
        var result
        try { result = JSON.parse(data) } catch (e) { return }
        if (result.event !== "preflight" || !Array.isArray(result.missingTools)) return
        var missing = []
        for (var i = 0; i < result.missingTools.length; i++) {
          if (result.missingTools[i] !== "uv" && result.missingTools[i] !== "Google Cloud CLI") return
          missing.push(result.missingTools[i])
        }
        root.missingTools = missing
        root.toolsChecked = true
        if (!root.browserChosen && ["edge", "chrome", "chromium", "brave", "firefox"].indexOf(result.browser) >= 0)
          root.browser = result.browser
      }
    }
    stderr: SplitParser { onRead: function(data) {} }
    onExited: function(exitCode) {
      checkDeadline.stop()
      if (exitCode !== 0 || !root.toolsChecked)
        root.error = "Could not check setup tools. Retry or use manual setup."
    }
  }
  Timer {
    id: deadline
    interval: 900000
    onTriggered: root.cancel()
  }
  Process {
    id: operation
    objectName: "google-setup-process"
    stdout: SplitParser {
      onRead: function(data) {
        if (data.length > 4096) return
        var result
        try { result = JSON.parse(data) } catch (e) { return }
        if (result.event === "progress") root.progress = OAuth.redact(String(result.message || ""))
        else if (result.event === "error") root.error = OAuth.redact(String(result.message || ""))
        else if (result.event === "done") root.completed = true
      }
    }
    // Dependency/keyring diagnostics never become shell logs or UI labels.
    stderr: SplitParser { onRead: function(data) {} }
    onExited: function(exitCode) {
      deadline.stop()
      if (root.stopping) {
        root.stopping = false
        root.completed = false
        root.progress = "Setup cancelled. Retry to resume; any project already created stays in your Google account."
        return
      }
      if (exitCode === 0 && root.completed) {
        root.progress = "Opening Google sign-in"
        root.ready(root.pendingAccount)
      } else {
        root.completed = false
        root.progress = ""
        if (root.error === "") root.error = "Automatic setup did not finish. Retry or choose manual setup."
      }
    }
  }
}
