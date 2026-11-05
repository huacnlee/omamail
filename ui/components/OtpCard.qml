import QtQuick
import qs.Commons
import qs.Ui

// The one-time code in a sign-in message, drawn large above the message so it
// can be read across a room and typed without hunting for it, with the copy
// one press away. The code came out of a stranger's mail, so it is drawn as
// text and only text, and only after `Otp.detect` has reduced it to letters
// and digits.
Rectangle {
  id: root

  // `{code, display}` from Otp.detect, or null for no card.
  property var otp: null
  // Whether this code was copied from this message since it was opened, which
  // the reader decides: it is the one that copied it.
  property bool copied: false

  required property color textColor
  required property color accentColor
  required property color dimColor
  required property string panelFontFamily

  signal copyRequested()

  readonly property string display: otp ? String(otp.display || otp.code || "") : ""

  visible: root.display !== ""
  implicitHeight: visible ? column.implicitHeight + Style.space(24) : 0
  height: implicitHeight
  radius: Style.cornerRadius
  color: Style.normalFillFor(root.textColor, root.accentColor)
  border.width: 1
  border.color: Style.normalBorderFor(root.textColor, root.accentColor)

  Column {
    id: column
    x: Style.space(14)
    y: Style.space(12)
    width: parent.width - Style.space(28)
    spacing: Style.space(6)

    Text {
      objectName: "otpHeading"
      width: parent.width
      text: "Verification code"
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      textFormat: Text.PlainText
      elide: Text.ElideRight
    }

    Text {
      objectName: "otpCode"
      width: parent.width
      text: root.display
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Math.round(Style.font.body * 2.6)
      font.bold: true
      font.letterSpacing: Style.space(3)
      textFormat: Text.PlainText
      elide: Text.ElideRight
      Accessible.role: Accessible.StaticText
      Accessible.name: "Verification code " + root.display
    }

    Row {
      spacing: Style.space(10)

      Button {
        id: copyButton
        objectName: "otpCopy"
        anchors.verticalCenter: parent.verticalCenter
        width: implicitWidth
        height: implicitHeight
        text: "Copy code"
        tooltipText: "Copy code · y"
        foreground: root.textColor
        accent: root.accentColor
        bordered: true
        fontFamily: root.panelFontFamily
        fontSize: Style.font.caption
        horizontalPadding: Style.space(10)
        verticalPadding: Style.space(3)
        focusable: true
        Accessible.name: "Copy verification code"
        onClicked: root.copyRequested()
      }

      // Words, not a colour, say the copy happened. The window's status line
      // says it too, because an automatic copy happens without a press.
      Row {
        objectName: "otpCopied"
        visible: root.copied
        spacing: Style.space(4)
        anchors.verticalCenter: parent.verticalCenter
        ActionIcon {
          name: "check"
          iconSize: Style.font.iconSmall
          color: root.accentColor
          anchors.verticalCenter: parent.verticalCenter
        }
        Text {
          text: "Copied to clipboard"
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          textFormat: Text.PlainText
          anchors.verticalCenter: parent.verticalCenter
          Accessible.role: Accessible.StaticText
          Accessible.name: text
        }
      }
    }
  }
}
