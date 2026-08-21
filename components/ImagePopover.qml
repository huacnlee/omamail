import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui
import "../message/Html.js" as Html

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
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily

  property string source: ""
  // What the marker pointed at, shown whether or not it was fetched, so a
  // refusal names the thing it refused.
  property string requested: ""
  // A sender's src is not a picture until something has decided it is safe to
  // fetch. Loopback and private addresses are the network behind the user's
  // front door, and file: is their disk; neither is a picture, and opening one
  // is the request itself.
  property bool refused: false

  anchors.fill: parent
  z: 60

  function show(url) {
    var wanted = String(url || "")
    if (wanted === "") return
    requested = wanted
    refused = !Html.isDisplayableImageUrl(wanted)
    source = refused ? "" : wanted
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

    onClosed: {
      root.source = ""
      root.requested = ""
      root.refused = false
    }

    background: Rectangle {
      radius: Style.cornerRadius
      color: root.popupBackgroundColor
      border.width: 1
      border.color: root.popupBorderColor
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
          width: picture.width - Style.space(20)
          horizontalAlignment: Text.AlignHCenter
          wrapMode: Text.WordWrap
          visible: root.refused || picture.status !== Image.Ready
          text: root.refused
            ? "That image is not on the public internet, so it was not fetched"
            : (picture.status === Image.Error ? "That image could not be loaded" : "Loading")
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
        }
      }

      Text {
        width: picture.width
        text: root.requested
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        // The sender wrote this. Left as AutoText, a src with a tag in it is
        // markup Qt would lay out — and an <img> in it a fetch it would make.
        textFormat: Text.PlainText
        elide: Text.ElideMiddle
      }
    }
  }
}
