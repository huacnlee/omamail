import QtQuick
import qs.Commons
import qs.Ui

Column {
  id: root
  required property var runtime
  required property color textColor
  required property color dimColor
  required property color accentColor
  required property string panelFontFamily
  property string backendError: ""
  spacing: Style.space(12)
  Text {
    text: "Mail backend"
    color: root.textColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.heading
  }
  Text {
    width: parent.width
    wrapMode: Text.WordWrap
    text: !root.runtime ? "Checking the mail backend"
      : root.runtime.busy ? "Working"
      : root.runtime.state === "ready" ? "Backend " + root.runtime.installedVersion + " is installed."
      : "Omamail needs backend " + (root.runtime.requiredVersion || "matching this plugin")
        + (root.runtime.installedVersion ? ". Installed: " + root.runtime.installedVersion : ". It is not installed yet.")
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.body
  }
  Text {
    width: parent.width
    wrapMode: Text.WordWrap
    text: root.runtime && root.runtime.development
      ? "Development executable: " + root.runtime.developmentExecutable + ". Build the required version, then check again."
      : "Install downloads the exact release into this plugin. Your accounts and messages stay where they are."
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.body
  }
  Text {
    width: parent.width
    visible: text !== ""
    wrapMode: Text.WordWrap
    text: root.runtime && root.runtime.error ? root.runtime.error : root.backendError
    color: root.textColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.body
  }
  Flow {
    width: parent.width
    spacing: Style.space(8)
    Button {
      objectName: "backend-install"
      visible: !!root.runtime && !root.runtime.development && root.runtime.state !== "ready"
      enabled: !!root.runtime && root.runtime.canInstall
      text: root.runtime && root.runtime.installedVersion ? "Update backend" : "Install backend"
      foreground: root.accentColor
      onClicked: root.runtime.install()
    }
    Button {
      objectName: "backend-refresh"
      text: "Check again"
      enabled: !!root.runtime && !root.runtime.busy
      foreground: root.textColor
      onClicked: root.runtime.refresh()
    }
  }
  Flow {
    width: parent.width
    spacing: Style.space(8)
    visible: !!root.runtime && !root.runtime.development && root.runtime.state === "ready"
    Button {
      text: "Enable terminal command"
      enabled: !!root.runtime && !root.runtime.busy
      foreground: root.textColor
      onClicked: root.runtime.enableCli()
    }
    Button {
      text: "Remove terminal command"
      enabled: !!root.runtime && !root.runtime.busy
      foreground: root.textColor
      onClicked: root.runtime.disableCli()
    }
  }
}
