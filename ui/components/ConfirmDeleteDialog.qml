import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui

// The one confirmation for destructive writes. A calendar event is gone for
// good once the server says so, so it asks first: the opener names the target
// in the request, and only the answer here reaches the controller.
Item {
  id: root

  required property color textColor
  required property color dimColor
  required property color dangerColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily
  property var request: null
  readonly property bool opened: dialog.opened

  signal confirmed(var request)

  anchors.fill: parent
  z: 80

  function openFor(value) {
    request = value
    if (request) dialog.open()
  }

  function close() { dialog.close() }
  function confirm() {
    var value = dialog.opened ? request : null
    dialog.close()
    if (value) confirmed(value)
  }

  QQC.Popup {
    id: dialog
    anchors.centerIn: parent
    width: Math.min(Style.space(360), parent.width - Style.space(32))
    padding: Style.space(18)
    modal: true
    focus: true
    closePolicy: QQC.Popup.CloseOnEscape
    onOpened: deleteButton.forceActiveFocus()
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
        if (event.key !== Qt.Key_Return && event.key !== Qt.Key_Enter) return
        event.accepted = true
        if (cancelButton.activeFocus) root.close()
        else if (deleteButton.activeFocus) root.confirm()
      }

      Text {
        width: parent.width
        textFormat: Text.PlainText
        text: "Delete \"" + String(root.request ? root.request.name : "") + "\"?"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.heading
        font.bold: true
        wrapMode: Text.Wrap
      }
      Text {
        width: parent.width
        textFormat: Text.PlainText
        text: String(root.request ? root.request.message : "")
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        wrapMode: Text.Wrap
      }
      Row {
        anchors.right: parent.right
        spacing: Style.space(8)
        Button {
          id: cancelButton
          objectName: "delete-cancel"
          text: "Cancel"
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          focusable: true
          activeFocusOnTab: true
          KeyNavigation.tab: deleteButton
          KeyNavigation.backtab: deleteButton
          onClicked: dialog.close()
        }
        Button {
          id: deleteButton
          objectName: "delete-confirm"
          text: "Delete"
          foreground: root.dangerColor
          fontFamily: root.panelFontFamily
          focusable: true
          activeFocusOnTab: true
          KeyNavigation.tab: cancelButton
          KeyNavigation.backtab: cancelButton
          onClicked: root.confirm()
        }
      }
    }
  }
}
