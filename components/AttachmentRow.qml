import QtQuick
import qs.Commons
import qs.Ui
import "../message/Message.js" as Mail

Item {
  id: root

  property var attachment: null
  required property color textColor
  required property color dimColor
  required property color dimmerColor
  required property string panelFontFamily

  signal openRequested(var attachment)

  readonly property string filename: root.attachment
    ? String(root.attachment.filename || "attachment") : "attachment"

  implicitHeight: Math.max(icon.implicitHeight, filenameLink.implicitHeight,
    sizeLabel.implicitHeight)

  ActionIcon {
    id: icon
    anchors.left: parent.left
    anchors.verticalCenter: parent.verticalCenter
    name: "attachment"
    iconSize: Style.font.iconSmall
    color: root.dimColor
  }

  LinkLabel {
    id: filenameLink
    objectName: "attachment-open-link"
    anchors.left: icon.right
    anchors.right: sizeLabel.left
    anchors.leftMargin: Style.space(6)
    anchors.rightMargin: Style.space(6)
    anchors.verticalCenter: parent.verticalCenter
    textFormat: Text.PlainText
    text: root.filename
    color: root.textColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    elide: Text.ElideRight
    tooltipText: "Open attachment"
    onActivated: root.openRequested(root.attachment)
  }

  Text {
    id: sizeLabel
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    textFormat: Text.PlainText
    text: Mail.formatSize(root.attachment ? root.attachment.size : 0)
    color: root.dimmerColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
  }
}
