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

  // A request may carry `choices`, each a delete that differs in consequence
  // — without telling guests, or the whole series. Every one is its own
  // button, the last is the default, and the answer travels back as
  // `request.choice`. A request without choices is a plain Delete.
  readonly property var choices: request && Array.isArray(request.choices) && request.choices.length > 0
    ? request.choices : [{ value: "", label: "Delete" }]

  anchors.fill: parent
  z: 80

  function openFor(value) {
    request = value
    if (request) dialog.open()
  }

  function close() { dialog.close() }
  function confirm(choice) {
    var value = dialog.opened ? request : null
    dialog.close()
    if (!value) return
    var answered = {}
    for (var key in value) answered[key] = value[key]
    answered.choice = choice === undefined ? String(root.choices[root.choices.length - 1].value) : String(choice)
    confirmed(answered)
  }

  // Cancel, then the choices left to right: the order Tab walks.
  function buttonsInOrder() {
    var ordered = [cancelButton]
    for (var i = 0; i < choiceButtons.count; i++) ordered.push(choiceButtons.itemAt(i))
    return ordered
  }
  function moveFocus(step) {
    var ordered = buttonsInOrder()
    var at = 0
    for (var i = 0; i < ordered.length; i++) if (ordered[i] && ordered[i].activeFocus) at = i
    var next = ordered[(at + step + ordered.length) % ordered.length]
    if (next) next.forceActiveFocus()
  }

  QQC.Popup {
    id: dialog
    anchors.centerIn: parent
    width: Math.min(Style.space(420), parent.width - Style.space(32))
    padding: Style.space(18)
    modal: true
    focus: true
    closePolicy: QQC.Popup.CloseOnEscape
    onOpened: {
      var ordered = root.buttonsInOrder()
      ordered[ordered.length - 1].forceActiveFocus()
    }
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
          root.moveFocus(event.key === Qt.Key_Backtab || (event.modifiers & Qt.ShiftModifier) ? -1 : 1)
          return
        }
        if (event.key !== Qt.Key_Return && event.key !== Qt.Key_Enter) return
        event.accepted = true
        if (cancelButton.activeFocus) { root.close(); return }
        for (var i = 0; i < choiceButtons.count; i++)
          if (choiceButtons.itemAt(i).activeFocus) root.confirm(root.choices[i].value)
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
        visible: text !== ""
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
          objectName: "delete-cancel"
          text: "Cancel"
          bordered: true
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          focusable: true
          onClicked: dialog.close()
        }
        Repeater {
          id: choiceButtons
          model: root.choices
          Button {
            required property var modelData
            required property int index
            objectName: index === root.choices.length - 1 ? "delete-confirm" : "delete-choice-" + String(modelData.value)
            text: String(modelData.label)
            bordered: true
            foreground: root.dangerColor
            fontFamily: root.panelFontFamily
            focusable: true
            onClicked: root.confirm(modelData.value)
          }
        }
      }
    }
  }
}
