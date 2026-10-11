import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui

// Asks before "Mark all read..." runs. It can reach thousands of messages
// that are not loaded, and read state cannot be put back as a group, so the
// dialog names each mailbox and its count. The request comes whole from
// `Model.clearUnreadConfirmation`; this only draws it and answers.
Item {
  id: root

  required property color textColor
  required property color dimColor
  required property color accentColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily
  property var request: null
  readonly property bool opened: dialog.opened

  signal confirmed()

  anchors.fill: parent
  z: 80

  function openFor(value) {
    request = value
    if (request) dialog.open()
  }

  function close() { dialog.close() }
  function confirm() {
    var wasOpen = dialog.opened
    dialog.close()
    if (wasOpen) confirmed()
  }

  // Cancel, then the action: the order Tab walks.
  function moveFocus() {
    if (cancelButton.activeFocus) actionButton.forceActiveFocus()
    else cancelButton.forceActiveFocus()
  }

  QQC.Popup {
    id: dialog
    anchors.centerIn: parent
    width: Math.min(Style.space(420), parent.width - Style.space(32))
    padding: Style.space(18)
    modal: true
    focus: true
    closePolicy: QQC.Popup.CloseOnEscape
    onOpened: actionButton.forceActiveFocus()
    onClosed: root.request = null
    background: Rectangle {
      radius: Style.cornerRadius
      color: root.popupBackgroundColor
      border.width: 1
      border.color: root.popupBorderColor
    }
    contentItem: Column {
      spacing: Style.space(14)
      // Popups consume keys before the window shortcut map.
      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab) {
          event.accepted = true
          root.moveFocus()
          return
        }
        if (event.key !== Qt.Key_Return && event.key !== Qt.Key_Enter) return
        event.accepted = true
        if (cancelButton.activeFocus) root.close()
        else if (actionButton.activeFocus) root.confirm()
      }

      Text {
        objectName: "clear-unread-title"
        width: parent.width
        textFormat: Text.PlainText
        text: String(root.request && root.request.title || "")
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.heading
        font.bold: true
        wrapMode: Text.Wrap
      }
      Column {
        width: parent.width
        spacing: Style.space(6)
        Repeater {
          model: root.request && Array.isArray(root.request.lines) ? root.request.lines : []
          Item {
            required property var modelData
            required property int index
            width: parent.width
            implicitHeight: Math.max(lineLabel.implicitHeight, lineCount.implicitHeight)
            Text {
              id: lineLabel
              objectName: "clear-unread-label-" + index
              anchors.left: parent.left
              anchors.right: lineCount.left
              anchors.rightMargin: Style.space(12)
              textFormat: Text.PlainText
              text: String(modelData.label)
              color: root.textColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.bodySmall
              elide: Text.ElideRight
            }
            Text {
              id: lineCount
              objectName: "clear-unread-count-" + index
              anchors.right: parent.right
              textFormat: Text.PlainText
              text: String(modelData.count)
              color: root.textColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.bodySmall
            }
          }
        }
      }
      Text {
        width: parent.width
        textFormat: Text.PlainText
        text: String(root.request && root.request.message || "")
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        wrapMode: Text.Wrap
      }
      Flow {
        width: parent.width
        spacing: Style.space(8)
        Button {
          id: cancelButton
          objectName: "clear-unread-cancel"
          text: "Cancel"
          bordered: true
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          focusable: true
          onClicked: dialog.close()
        }
        Button {
          id: actionButton
          objectName: "clear-unread-confirm"
          text: String(root.request && root.request.action || "")
          bordered: true
          foreground: root.accentColor
          fontFamily: root.panelFontFamily
          focusable: true
          onClicked: root.confirm()
        }
      }
    }
  }
}
