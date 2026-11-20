import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "../message/Images.js" as Images

// A strip of small pictures for the message's picture attachments, above the
// attachment list. A click opens the picture in the viewer (or, for one this
// window cannot draw, in another application, as the list does).
//
// A miniature is drawn only from bytes the backend prepared out of the message
// it already downloaded: opening a message never fetches its attachments for
// the sake of a thumbnail. A large file, a format Qt cannot draw (HEIC) and a
// message whose download carries only the attachment's locator get a tile with
// the file type instead.
Item {
  id: root

  property var attachments: []
  // Where the reader's content starts, measured from this strip's own left
  // edge: the pictures line up with the message text above them, not with
  // the control frames around them.
  property real leadingInset: 0
  // The reader's `MessageImages`: where prepared bytes come from.
  property var images: null
  required property color textColor
  required property color dimColor
  required property color accentColor
  required property string panelFontFamily

  signal openRequested(var attachment)

  readonly property var pictures: {
    var out = []
    var list = root.attachments || []
    for (var i = 0; i < list.length && out.length < Images.MAX_THUMBNAILS; i++)
      if (Images.isImage(list[i])) out.push(list[i])
    return out
  }
  readonly property real tileSize: Style.space(64)

  visible: pictures.length > 0 && !!images && images.available
  implicitHeight: visible ? tileSize : 0

  Flickable {
    id: strip
    anchors.fill: parent
    anchors.leftMargin: root.leadingInset
    contentWidth: tiles.implicitWidth
    contentHeight: height
    flickableDirection: Flickable.HorizontalFlick
    boundsBehavior: Flickable.StopAtBounds
    clip: true

    Row {
      id: tiles
      spacing: Style.space(6)

      Repeater {
        model: root.pictures

        Rectangle {
          id: tile
          required property var modelData
          required property int index
          objectName: "attachment-thumbnail-" + index
          // Prepared bytes, "" until they arrive or when there are none.
          property string picture: ""
          readonly property bool drawn: preview.status === Image.Ready

          width: root.tileSize
          height: root.tileSize
          radius: Style.cornerRadius
          color: Style.normalFillFor(root.textColor, root.accentColor)
          border.width: 1
          border.color: hover.hovered ? root.textColor
            : Style.normalBorderFor(root.textColor, root.accentColor)
          // Mouse only, like the attachment list itself: attachments have no
          // keyboard path today, and this row does not add one.
          clip: true

          Component.onCompleted: {
            if (!root.images || !Images.thumbnailable(modelData)) return
            root.images.thumbnail(modelData, function(data) {
              try { tile.picture = data } catch (gone) {}
            })
          }

          Image {
            id: preview
            anchors.fill: parent
            anchors.margins: 1
            source: tile.picture
            asynchronous: true
            cache: false
            fillMode: Image.PreserveAspectCrop
            // Decoded at tile size, not at the picture's own.
            sourceSize.width: Math.ceil(root.tileSize * 2)
            sourceSize.height: Math.ceil(root.tileSize * 2)
            visible: tile.drawn
          }

          Column {
            anchors.centerIn: parent
            spacing: Style.space(2)
            visible: !tile.drawn

            ActionIcon {
              anchors.horizontalCenter: parent.horizontalCenter
              name: "image"
              iconSize: Style.font.icon
              color: root.dimColor
            }
            Text {
              anchors.horizontalCenter: parent.horizontalCenter
              text: Images.typeLabel(tile.modelData)
              color: root.dimColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.caption
              textFormat: Text.PlainText
            }
          }

          HoverHandler {
            id: hover
            cursorShape: Qt.PointingHandCursor
          }
          TapHandler {
            onTapped: root.openRequested(tile.modelData)
          }
          PanelToolTip {
            text: String(tile.modelData.filename || "attachment")
            visible: hover.hovered
          }
          Accessible.role: Accessible.Button
          Accessible.name: String(tile.modelData.filename || "attachment")
        }
      }
    }
  }
}
