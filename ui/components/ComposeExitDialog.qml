import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui

Item {
  id: root
  required property color textColor
  required property color dimColor
  required property color dangerColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily
  required property string currentDraftKey
  readonly property bool opened: dialog.opened
  property string requestedDraftKey: ""

  signal saveRequested(string draftKey)
  signal discardRequested(string draftKey)

  // A failed send can replace the composer while this modal owns the focus.
  // Its choice belongs to the draft that opened it, not the next visible one.
  onCurrentDraftKeyChanged: {
    if (requestedDraftKey !== "" && requestedDraftKey !== currentDraftKey) close()
  }

  anchors.fill: parent
  z: 80

  function open() {
    if (currentDraftKey === "") return
    requestedDraftKey = currentDraftKey
    dialog.open()
  }
  function close() {
    requestedDraftKey = ""
    dialog.close()
  }
  function cancel() { close() }
  function takeDraftKey() {
    var key = dialog.opened && requestedDraftKey === currentDraftKey
      ? requestedDraftKey : ""
    close()
    return key
  }
  function discard() {
    var key = takeDraftKey()
    if (key !== "") discardRequested(key)
  }
  function save() {
    var key = takeDraftKey()
    if (key !== "") saveRequested(key)
  }

  QQC.Popup {
    id: dialog
    anchors.centerIn: parent
    width: Math.min(Style.space(400), parent.width - Style.space(32))
    padding: Style.space(18)
    modal: true
    focus: true
    closePolicy: QQC.Popup.CloseOnEscape
    onOpened: saveButton.forceActiveFocus()
    onClosed: root.requestedDraftKey = ""
    background: Rectangle {
      radius: Style.cornerRadius
      color: root.popupBackgroundColor
      border.width: 1
      border.color: root.popupBorderColor
    }
    contentItem: Column {
      spacing: Style.space(14)
      // A popup consumes keys before the window shortcuts. Keep its button
      // activation here, with the focus cycle contained by KeyNavigation.
      Keys.onPressed: function(event) {
        if (event.key !== Qt.Key_Return && event.key !== Qt.Key_Enter) return
        event.accepted = true
        if (cancelButton.activeFocus) root.cancel()
        else if (discardButton.activeFocus) root.discard()
        else if (saveButton.activeFocus) root.save()
      }
      Text {
        width: parent.width
        textFormat: Text.PlainText
        text: "Save this draft?"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.heading
        font.bold: true
        wrapMode: Text.Wrap
      }
      Text {
        width: parent.width
        textFormat: Text.PlainText
        text: "You changed this message. Save your changes before leaving?"
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
          text: "Cancel"
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          focusable: true
          activeFocusOnTab: true
          KeyNavigation.tab: discardButton
          KeyNavigation.backtab: saveButton
          onClicked: root.cancel()
        }
        Button {
          id: discardButton
          text: "Discard"
          foreground: root.dangerColor
          fontFamily: root.panelFontFamily
          focusable: true
          activeFocusOnTab: true
          KeyNavigation.tab: saveButton
          KeyNavigation.backtab: cancelButton
          onClicked: root.discard()
        }
        Button {
          id: saveButton
          text: "Save draft"
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          focusable: true
          activeFocusOnTab: true
          KeyNavigation.tab: cancelButton
          KeyNavigation.backtab: discardButton
          onClicked: root.save()
        }
      }
    }
  }
}
