import QtQuick
import qs.Commons
import qs.Ui

// The mark, drawn rather than rasterised from an SVG: the bar slot is about
// 16px and Qt's SVG renderer smears strokes at that size.
//
// The fold is an M, not the V of a generic mail glyph — that is the whole
// difference between this application's mark and every other envelope in the
// bar. The frame follows the bar foreground. The M follows the theme accent.
Item {
  id: root

  property real iconSize: Style.font.icon
  property color color: Color.foreground
  property color markColor: color
  property color badgeColor: Color.urgent
  // A dot, not a count: the bar says "something arrived", the tooltip says
  // how much, and the window says what.
  property bool dot: false
  property bool crossed: false

  width: iconSize
  height: iconSize
  implicitWidth: iconSize
  implicitHeight: iconSize

  onColorChanged: envelope.requestPaint()
  onMarkColorChanged: envelope.requestPaint()
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

      // The M, inset inside the body: down the left stem, into the valley, back
      // up, and down the right stem.
      //
      // Smaller and lighter than the frame around it. At bar size the two
      // strokes at equal weight put more ink in a 12px square than it can hold,
      // and the mark turns into a solid block; letting the M sit clear of the
      // envelope on all four sides, at about two thirds the stroke, keeps both
      // shapes readable.
      var innerW = right - left
      var innerH = bottom - top
      ctx.strokeStyle = root.markColor
      ctx.lineWidth = Math.max(1, stroke * 0.54)
      ctx.beginPath()
      ctx.moveTo(left + innerW * 0.30, bottom - innerH * 0.18)
      ctx.lineTo(left + innerW * 0.30, top + innerH * 0.36)
      ctx.lineTo(left + innerW * 0.50, top + innerH * 0.60)
      ctx.lineTo(left + innerW * 0.70, top + innerH * 0.36)
      ctx.lineTo(left + innerW * 0.70, bottom - innerH * 0.18)
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

  // On the corner rather than beside the icon, so the bar slot stays one
  // square whether or not anything is waiting.
  BorderSurface {
    visible: root.dot
    width: Math.max(Style.space(5), parent.width * 0.34)
    height: width
    radius: width / 2
    color: root.badgeColor
    anchors.right: parent.right
    anchors.rightMargin: -parent.width * 0.06
    anchors.top: parent.top
    anchors.topMargin: -parent.height * 0.04
    borderSpec: Border.flat(Color.popups.background, 1)
  }
}
