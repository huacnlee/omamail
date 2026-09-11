import QtQuick
import qs.Commons

Item {
  id: root
  required property color foreground
  required property color accent
  property bool animated: true
  property real progress: 0
  property real entrance: 0
  property bool drawingReady: false
  implicitWidth: Style.space(64)
  implicitHeight: implicitWidth
  clip: true

  function enter() {
    drawing.stop()
    arrival.stop()
    drawingReady = false
    progress = 0
    entrance = animated ? 0 : 1
    if (visible && animated) arrival.restart()
  }
  Component.onCompleted: enter()
  onVisibleChanged: enter()
  onAnimatedChanged: enter()

  // Follow the existing SVG's M from its lower-left endpoint at constant speed.
  function tracePoints(amount) {
    var points = [[20, 43], [20, 24], [32, 37], [44, 24], [44, 43]]
    var remaining = Math.max(0, Math.min(1, amount)) * (38 + 2 * Math.sqrt(313))
    var path = [[20, 43]]
    for (var i = 1; i < points.length && remaining > 0; i++) {
      var a = points[i - 1]
      var b = points[i]
      var distance = Math.sqrt(Math.pow(b[0] - a[0], 2) + Math.pow(b[1] - a[1], 2))
      var fraction = Math.min(1, remaining / distance)
      path.push([a[0] + (b[0] - a[0]) * fraction,
        a[1] + (b[1] - a[1]) * fraction])
      remaining -= distance
    }
    return path
  }

  Item {
    width: root.width
    height: root.height
    y: root.height * 0.4 * (1 - root.entrance)
    opacity: root.entrance
    // A single rounded border avoids overlapping tessellated arc joins.
    Rectangle {
      x: root.width * 2.5 / 64
      y: root.height * 10.5 / 64
      width: root.width * 59 / 64
      height: root.height * 43 / 64
      radius: root.width * 7.5 / 64
      color: "transparent"
      border.color: root.foreground
      border.width: root.width * 5 / 64
      antialiasing: true
    }
    Canvas {
      id: letter
      anchors.fill: parent
      antialiasing: true
      onWidthChanged: requestPaint()
      onHeightChanged: requestPaint()
      onPaint: {
        var ctx = getContext("2d")
        ctx.reset()
        ctx.clearRect(0, 0, width, height)
        ctx.scale(width / 64, height / 64)
        ctx.lineWidth = 5
        ctx.lineCap = "round"
        ctx.lineJoin = "round"
        // Canvas strokes a joined path once, including its translucent base.
        // Shape's tessellated stroke overlapped at joins and left bright seams.
        for (var pass = 0; pass < 2; pass++) {
          var amount = pass === 0 ? 1 : root.progress
          if (amount <= 0) continue
          var points = root.tracePoints(amount)
          ctx.strokeStyle = pass === 0 ? Qt.alpha(root.accent, 0.2) : root.accent
          ctx.beginPath()
          ctx.moveTo(20, 43)
          for (var i = 1; i < points.length; i++)
            ctx.lineTo(points[i][0], points[i][1])
          ctx.stroke()
        }
      }
    }
  }

  onProgressChanged: letter.requestPaint()
  onAccentChanged: letter.requestPaint()

  SequentialAnimation {
    id: arrival
    NumberAnimation {
      target: root
      property: "entrance"
      from: 0
      to: 1
      duration: 650
      easing.type: Easing.OutCubic
    }
    PauseAnimation { duration: 500 }
    onFinished: root.drawingReady = true
  }

  SequentialAnimation {
    id: drawing
    running: root.visible && root.animated && root.drawingReady
    loops: Animation.Infinite
    NumberAnimation {
      target: root
      property: "progress"
      from: 0
      to: 19 / (38 + 2 * Math.sqrt(313))
      duration: 400
      easing.type: Easing.Linear
    }
    NumberAnimation {
      target: root
      property: "progress"
      to: 1
      duration: 900
      easing.type: Easing.Linear
    }
    PauseAnimation { duration: 2500 }
  }
}
