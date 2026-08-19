import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui

// One image, floated over the reader.
//
// Plain text has nowhere to put a picture, so the body carries a marker where
// each image was and this is what the marker opens. It deliberately does not
// scale the image up: an image smaller than the window is shown at its own size
// rather than blown up to fill a frame it was never meant to fill.
Item {
  id: root

  required property color textColor
  required property color dimColor
  required property string panelFontFamily

  property string source: ""

  anchors.fill: parent
  z: 60

  function show(url) {
    var wanted = String(url || "")
    if (wanted === "") return
    source = wanted
    sheet.open()
  }

  function close() { sheet.close() }

  QQC.Popup {
    id: sheet
    parent: root
    modal: true
    focus: true
    closePolicy: QQC.Popup.CloseOnEscape | QQC.Popup.CloseOnPressOutside
    padding: Style.space(8)
    x: Math.round((root.width - width) / 2)
    y: Math.round((root.height - height) / 2)
    width: frame.implicitWidth + padding * 2
    height: frame.implicitHeight + padding * 2

    onClosed: root.source = ""

    background: Rectangle {
      radius: Style.cornerRadius
      color: Color.popups.background
      border.width: 1
      border.color: Color.popups.border
    }

    Column {
      id: frame
      spacing: Style.space(6)

      // Sized from the image's own dimensions, bounded by the window. Bounding
      // it against the popup instead would be a loop: the popup is sized from
      // this.
      Image {
        id: picture
        source: root.source
        asynchronous: true
        cache: false
        fillMode: Image.PreserveAspectFit
        width: Math.max(Style.space(120),
          Math.min(implicitWidth, root.width - Style.space(80)))
        height: status === Image.Ready
          ? Math.min(implicitHeight, root.height - Style.space(120))
          : Style.space(120)

        Text {
          anchors.centerIn: parent
          visible: picture.status !== Image.Ready
          text: picture.status === Image.Error
            ? "That image could not be loaded"
            : "Loading…"
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
        }
      }

      Text {
        width: picture.width
        text: root.source
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideMiddle
      }
    }
  }
}
