import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui

// One name, asked for: a new label's, or a label's new one. A small modal
// popup rather than a page, because the answer is a word and the place it
// applies to is still on screen behind it.
Item {
  id: root

  required property color textColor
  required property color dimColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property color accentColor
  required property string panelFontFamily

  // What the answer is for, handed back with it so one prompt serves every
  // caller: `kind` names the operation, `subject` the label it is about.
  property string kind: ""
  property string subject: ""
  property string title: ""
  property string hint: ""
  readonly property bool opened: dialog.opened

  signal submitted(string kind, string subject, string text)

  anchors.fill: parent
  z: 55

  function openFor(kindValue, subjectValue, titleText, initialText, hintText) {
    kind = String(kindValue || "")
    subject = String(subjectValue || "")
    title = String(titleText || "")
    hint = String(hintText || "")
    field.text = String(initialText || "")
    dialog.open()
  }

  function close() { dialog.close() }

  function submit() {
    var text = String(field.text || "").trim()
    if (text === "") return
    dialog.close()
    root.submitted(kind, subject, text)
  }

  QQC.Popup {
    id: dialog
    anchors.centerIn: parent
    width: Math.min(Style.space(360), parent.width - Style.space(32))
    padding: Style.space(18)
    modal: true
    focus: true
    closePolicy: QQC.Popup.CloseOnEscape | QQC.Popup.CloseOnPressOutside
    onOpened: {
      field.selectAll()
      field.forceActiveFocus()
    }
    background: Rectangle {
      radius: Style.cornerRadius
      color: root.popupBackgroundColor
      border.width: 1
      border.color: root.popupBorderColor
    }

    contentItem: Column {
      spacing: Style.space(10)

      Text {
        width: parent.width
        textFormat: Text.PlainText
        text: root.title
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        font.bold: true
        wrapMode: Text.WordWrap
      }

      TextField {
        id: field
        objectName: "name-prompt-field"
        width: parent.width
        foreground: root.textColor
        accent: root.accentColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        onAccepted: root.submit()
      }

      Text {
        width: parent.width
        visible: root.hint !== ""
        textFormat: Text.PlainText
        text: root.hint
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }

      Row {
        anchors.right: parent.right
        spacing: Style.space(8)

        Button {
          text: "Cancel"
          foreground: root.dimColor
          bordered: false
          fontFamily: root.panelFontFamily
          fontSize: Style.font.caption
          onClicked: dialog.close()
        }

        Button {
          objectName: "name-prompt-ok"
          text: "OK"
          foreground: root.textColor
          bordered: true
          accent: root.accentColor
          fontFamily: root.panelFontFamily
          fontSize: Style.font.caption
          enabled: String(field.text || "").trim() !== ""
          onClicked: root.submit()
        }
      }
    }
  }
}
