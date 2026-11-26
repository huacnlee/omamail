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
  signal saveRequested(var attachment)

  // This attachment's own save is in flight. Not the panel's: two attachments
  // on one message save independently, and one of them working is no reason
  // for the other's button to say it is.
  property bool saving: false

  readonly property string filename: root.attachment
    ? String(root.attachment.filename || "attachment") : "attachment"

  // The button too, and that is not a detail: it is a 24px control beside
  // 15px of caption text, so a height taken from the text alone leaves it
  // hanging four pixels out of the row at both ends — clipped by the reader's
  // own scroller, which left the filename as the only thing that could be
  // clicked and opening as the only thing that could happen.
  implicitHeight: Math.max(icon.implicitHeight, filenameLink.implicitHeight,
    sizeLabel.implicitHeight, saveButton.implicitHeight)

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
    anchors.right: saveButton.left
    anchors.rightMargin: Style.space(4)
    anchors.verticalCenter: parent.verticalCenter
    textFormat: Text.PlainText
    text: Mail.formatSize(root.attachment ? root.attachment.size : 0)
    color: root.dimmerColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
  }

  // Keeping the file, next to opening it. The name opens — which is what a
  // filename does everywhere else — and this is the other verb, which needs
  // its own target rather than a second meaning for the same click.
  //
  // No ellipsis: it asks nothing. The file goes to the desktop's download
  // folder and the notice says where.
  IconButton {
    id: saveButton
    objectName: "attachment-save-button"
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    iconName: "download"
    iconSize: Style.font.iconSmall
    tooltipText: root.saving ? "Saving\u2026" : "Save to Downloads"
    foreground: root.dimColor
    hoverColor: root.textColor
    busy: root.saving
    // Refused rather than queued. The second click of a double-click asked for
    // the same file again, and the save script — which will not overwrite —
    // numbered it, so the folder quietly gained a second identical copy.
    onClicked: if (!root.saving) root.saveRequested(root.attachment)
  }
}
