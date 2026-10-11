import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "../account/MessageActions.js" as MessageActions

// Says that a Save as .eml finished, and where the file went. The status line
// says it too, but a caption at the window's edge was easy to miss for a file
// written somewhere on disk; this card names the file and the folder, and
// offers to open that folder. It listens to the service itself, so the window
// only places it.
Rectangle {
  id: root

  // The window, for its service and theme colours. One property rather than
  // seven, because App.qml sits against the repository's file-size ceiling.
  required property var app
  readonly property var service: app ? app.service : null
  readonly property color textColor: app ? app.foreground : Color.foreground
  readonly property color dimColor: app ? app.dim : textColor
  readonly property color accentColor: app ? app.accent : Color.accent
  readonly property color popupBackgroundColor: app ? app.popupBackground : Qt.rgba(0, 0, 0, 1)
  readonly property color popupBorderColor: app ? app.popupBorder : textColor
  readonly property string panelFontFamily: app ? app.fontFamily : Style.font.family
  // The widest the card may grow; the name and folder elide inside it.
  property real maximumWidth: Style.space(440)
  // Long enough to read a path and reach the button, short enough not to
  // linger over the next message.
  property int timeout: 8000

  // The file the backend wrote, which can carry a " (2)" the subject did not.
  property string filename: ""
  // The folder as shown, home shortened to ~, and the real one to open.
  property string folderLabel: ""
  property string folder: ""
  readonly property bool shown: filename !== ""

  function show(result) {
    var saved = MessageActions.exportSavedFile(result, Quickshell.env("HOME"))
    filename = saved.name
    folder = saved.folder
    folderLabel = saved.shownFolder
    if (shown) hideTimer.restart()
  }
  function dismiss() {
    hideTimer.stop()
    filename = ""
    folder = ""
    folderLabel = ""
  }
  function openFolder() {
    var target = folder
    dismiss()
    if (target !== "" && root.service && typeof root.service.openExternal === "function")
      root.service.openExternal(target)
  }

  Connections {
    target: root.service
    ignoreUnknownSignals: true
    function onEmlSaved(result) { root.show(result) }
  }

  Timer {
    id: hideTimer
    interval: root.timeout
    onTriggered: root.dismiss()
  }

  readonly property real chromeWidth: mark.width + openButton.width + closeButton.width
    + content.spacing * 3 + Style.space(18)

  // How much of the window's foot is taken above the status line: the
  // reader's toolbar while a message is open. The card is raised past it,
  // because that toolbar's right end holds the very save button that brought
  // the card up, and a notice must not cover the control it reports on.
  property real clearance: 0

  // Placed by itself, at the right end where the draft and send toasts sit,
  // because the window file has no room left to spare.
  anchors.right: parent ? parent.right : undefined
  anchors.rightMargin: Style.space(16)
  anchors.bottom: parent ? parent.bottom : undefined
  anchors.bottomMargin: Style.space(28) + Math.max(0, clearance) + Style.space(12)
  z: 80
  visible: shown
  implicitWidth: Math.min(maximumWidth,
    Math.max(nameText.implicitWidth, folderText.implicitWidth) + chromeWidth)
  implicitHeight: Math.max(content.implicitHeight + Style.space(14), Style.space(48))
  width: implicitWidth
  height: implicitHeight
  radius: Style.cornerRadius
  color: Qt.rgba(popupBackgroundColor.r, popupBackgroundColor.g,
    popupBackgroundColor.b, 1)
  border.width: Style.normalBorderWidth
  border.color: popupBorderColor

  Accessible.role: Accessible.AlertMessage
  Accessible.name: "Saved " + root.filename + " in " + root.folderLabel

  // Hovering holds the card, so it does not leave from under the pointer.
  HoverHandler {
    onHoveredChanged: if (hovered) hideTimer.stop(); else if (root.shown) hideTimer.restart()
  }

  Row {
    id: content
    anchors.left: parent.left
    anchors.leftMargin: Style.space(12)
    anchors.right: parent.right
    anchors.rightMargin: Style.space(6)
    anchors.verticalCenter: parent.verticalCenter
    spacing: Style.space(10)

    ActionIcon {
      id: mark
      anchors.verticalCenter: parent.verticalCenter
      name: "check"
      color: root.accentColor
      iconSize: Style.font.icon
      width: Style.font.icon
      height: Style.font.icon
    }

    Column {
      anchors.verticalCenter: parent.verticalCenter
      width: Math.max(0, content.width - mark.width - openButton.width
        - closeButton.width - content.spacing * 3)
      spacing: Style.space(2)

      Text {
        id: nameText
        objectName: "eml-saved-name"
        width: parent.width
        text: "Saved " + root.filename
        textFormat: Text.PlainText
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        elide: Text.ElideMiddle
      }
      Text {
        id: folderText
        objectName: "eml-saved-folder"
        width: parent.width
        visible: root.folderLabel !== ""
        text: "in " + root.folderLabel
        textFormat: Text.PlainText
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        // The end of a path is the part that tells folders apart.
        elide: Text.ElideLeft
      }
    }

    Button {
      id: openButton
      objectName: "eml-saved-open-folder"
      anchors.verticalCenter: parent.verticalCenter
      visible: root.folder !== ""
      text: "Open folder..."
      foreground: root.accentColor
      accent: root.accentColor
      bordered: true
      fontFamily: root.panelFontFamily
      fontSize: Style.font.caption
      onClicked: root.openFolder()
    }

    IconButton {
      id: closeButton
      objectName: "eml-saved-close"
      anchors.verticalCenter: parent.verticalCenter
      iconName: "close"
      iconSize: Style.font.iconSmall
      size: Style.space(22)
      tooltipText: "Dismiss"
      foreground: root.dimColor
      hoverColor: root.textColor
      fontFamily: root.panelFontFamily
      onClicked: root.dismiss()
    }
  }
}
