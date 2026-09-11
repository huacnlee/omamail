import QtQuick
import qs.Commons
import "Icons.js" as Icons

// One of the app's icons, by name.
//
// Every functional icon is a Nerd Font glyph from the Material Design Icons
// range, the range the Omarchy shell draws its own bar and panel icons from,
// so the window's verbs look like the desktop's. `Icons.js` is the map from
// a name to a glyph; this only draws the one it is given, the way the
// shell's `OpticalGlyph` does — centred on the ink rather than on the cell.
//
// The one drawing left is the brand mark: an envelope whose M carries the
// theme accent. A glyph is one colour, so the two-colour mark stays a Canvas.
Item {
  id: root

  property string name: ""
  property color color: Color.foreground
  // Omamail keeps the envelope in the foreground and gives its M the active
  // theme accent. Provider artwork uses ProviderLogo instead of this mark.
  property color markColor: color
  property bool brand: false
  property bool filled: false
  property real iconSize: Style.font.icon
  // Bound to the shell's family rather than fixed, so the icons follow
  // `omarchy font set` with everything else; the tests pass a Nerd Font in.
  property string fontFamily: Style.font.family
  // Stroke weight of the drawn mark only, relative to its 16-unit grid.
  property real strokeScale: 1.4

  readonly property bool drawsMark: brand && name === "gmail"
  readonly property string glyphText: drawsMark ? "" : Icons.glyph(name, filled)

  width: iconSize
  height: iconSize
  implicitWidth: iconSize
  implicitHeight: iconSize

  TextMetrics {
    id: metrics
    font.family: root.fontFamily
    font.pixelSize: Math.max(1, Math.round(root.iconSize))
    text: root.glyphText
  }

  Text {
    id: glyph
    visible: root.glyphText !== ""
    textFormat: Text.PlainText
    text: root.glyphText
    color: root.color
    font.family: root.fontFamily
    font.pixelSize: metrics.font.pixelSize
    // A Nerd Font glyph sits in a cell wider than its ink, and its ink sits
    // at its own height in the line. Centring the cell leaves a column of
    // icons visibly uneven — an envelope low, a tray high — so both axes
    // centre the painted bounds instead. The shell's bar corrects only
    // horizontally, to keep one baseline with the text beside its glyphs;
    // here every icon has its own row, and its row is what it centres in.
    // The tight rect is measured from the baseline, which is where the
    // Text's `baselineOffset` puts it.
    x: (root.width - metrics.tightBoundingRect.width) / 2 - metrics.tightBoundingRect.x
    y: (root.height - metrics.tightBoundingRect.height) / 2
      - (glyph.baselineOffset + metrics.tightBoundingRect.y)
  }

  Canvas {
    id: mark
    visible: root.drawsMark
    anchors.fill: parent
    antialiasing: true

    onVisibleChanged: requestPaint()
    Connections {
      target: root
      function onColorChanged() { mark.requestPaint() }
      function onMarkColorChanged() { mark.requestPaint() }
      function onIconSizeChanged() { mark.requestPaint() }
      function onStrokeScaleChanged() { mark.requestPaint() }
    }

    onPaint: {
      var ctx = getContext("2d")
      ctx.reset()
      var s = width / 16
      if (s <= 0) return
      ctx.lineWidth = Math.max(1, root.strokeScale * s)
      ctx.lineCap = "round"
      ctx.lineJoin = "round"

      // The Gmail mark: the envelope body, with the M fold inset inside it. A
      // plain envelope with a V fold is the generic mail glyph — the M is the
      // whole difference. The two are stroked separately so the M can carry
      // the theme accent while the envelope stays in the foreground colour.
      ctx.strokeStyle = root.color
      ctx.beginPath()
      ctx.rect(1 * s, 3 * s, 14 * s, 10 * s)
      ctx.stroke()
      ctx.strokeStyle = root.markColor
      ctx.beginPath()
      ctx.moveTo(3.6 * s, 13 * s); ctx.lineTo(3.6 * s, 5.6 * s); ctx.lineTo(8 * s, 9.3 * s)
      ctx.lineTo(12.4 * s, 5.6 * s); ctx.lineTo(12.4 * s, 13 * s)
      ctx.stroke()
    }
  }
}
