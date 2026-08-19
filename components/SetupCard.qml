import QtQuick
import qs.Commons
import qs.Ui
import "../Model.js" as Model

// The one thing to do next, shown until the panel has a signed-in mailbox to
// display. The wording and the button label come from Model so the states stay
// in one place and can be tested.
Rectangle {
  id: root

  required property color textColor
  required property string panelFontFamily
  property string stateKey: "no_credentials"
  property var missingTools: []
  property bool busy: false
  property bool hasCursor: false

  signal activated()

  width: parent ? parent.width : 0
  implicitHeight: body.implicitHeight + Style.space(26)
  radius: Style.cornerRadius
  color: Qt.rgba(textColor.r, textColor.g, textColor.b, 0.04)
  border.width: 1
  border.color: Qt.rgba(textColor.r, textColor.g, textColor.b, 0.12)

  Column {
    id: body
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    anchors.leftMargin: Style.space(14)
    anchors.rightMargin: Style.space(14)
    spacing: Style.space(8)

    Text {
      width: parent.width
      text: Model.setupHeadline(root.stateKey)
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.body
      font.bold: true
      wrapMode: Text.WordWrap
    }

    Text {
      width: parent.width
      text: Model.setupDetail(root.stateKey, root.missingTools)
      color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.58)
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      wrapMode: Text.WordWrap
    }

    Button {
      text: Model.setupActionLabel(root.stateKey)
      foreground: root.textColor
      bordered: true
      fontSize: Style.font.bodySmall
      // Cancelling a sign-in is the one action that stays live while busy.
      enabled: !root.busy || root.stateKey === "signing_in"
      hasCursor: root.hasCursor
      onClicked: root.activated()
    }
  }
}
