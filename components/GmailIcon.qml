import QtQuick
import qs.Commons
import qs.Ui

// An envelope, drawn rather than rasterised from an SVG: the bar slot is about
// 16px and Qt's SVG renderer smears strokes at that size.
//
// The flap direction carries the state. A closed envelope with the flap folded
// down is the resting look; unread mail lifts the flap open, which reads at bar
// size where a colour change alone does not.
Item {
  id: root

  property real iconSize: Style.font.icon
  property color color: Color.foreground
  property color badgeColor: Color.urgent
  property color badgeTextColor: Color.background
  property string badgeText: ""
  property bool open: false
  property bool crossed: false

  width: iconSize
  height: iconSize
  implicitWidth: iconSize
  implicitHeight: iconSize

  onColorChanged: envelope.requestPaint()
  onOpenChanged: envelope.requestPaint()
  onIconSizeChanged: envelope.requestPaint()

  Canvas {
    id: envelope
    anchors.fill: parent
    antialiasing: true

    onPaint: {
      var ctx = getContext("2d")
      ctx.reset()
      var w = width
      var h = height
      if (w <= 0 || h <= 0) return

      // The body is inset vertically so a wide-but-short envelope keeps the
      // 3:2 proportion a letter actually has.
      var left = w * 0.06
      var right = w * 0.94
      var top = h * 0.20
      var bottom = h * 0.80
      var stroke = Math.max(1, w * 0.085)

      ctx.strokeStyle = root.color
      ctx.lineWidth = stroke
      ctx.lineJoin = "round"
      ctx.lineCap = "round"

      ctx.beginPath()
      ctx.rect(left, top, right - left, bottom - top)
      ctx.stroke()

      ctx.beginPath()
      if (root.open) {
        // Flap standing up: the two diagonals meet above the top edge.
        ctx.moveTo(left, top)
        ctx.lineTo((left + right) / 2, top - (bottom - top) * 0.42)
        ctx.lineTo(right, top)
      } else {
        ctx.moveTo(left, top)
        ctx.lineTo((left + right) / 2, top + (bottom - top) * 0.55)
        ctx.lineTo(right, top)
      }
      ctx.stroke()
    }
  }

  Rectangle {
    visible: root.crossed
    anchors.centerIn: parent
    width: parent.width * 1.22
    height: Math.max(2, parent.height * 0.13)
    radius: height / 2
    color: root.color
    rotation: -45
  }

  // The count sits on the corner rather than beside the icon so the bar slot
  // stays one square whatever the number is.
  BorderSurface {
    id: badge
    visible: root.badgeText !== ""
    height: Math.max(Style.space(9), parent.height * 0.56)
    width: Math.max(height, label.implicitWidth + Style.space(4))
    radius: height / 2
    color: root.badgeColor
    anchors.right: parent.right
    anchors.rightMargin: -parent.width * 0.12
    anchors.top: parent.top
    anchors.topMargin: -parent.height * 0.10
    borderSpec: Border.flat(Color.popups.background, 1)

    Text {
      id: label
      anchors.centerIn: parent
      text: root.badgeText
      color: root.badgeTextColor
      font.family: Style.font.family
      font.pixelSize: Math.max(Style.space(7), parent.height * 0.66)
      font.bold: true
    }
  }
}
