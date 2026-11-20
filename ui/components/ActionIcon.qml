import QtQuick
import qs.Commons
import qs.Commons as Commons
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
  property color color: Commons.Color.foreground
  // Omamail keeps the envelope in the foreground and gives its M the active
  // theme accent. Provider artwork uses ProviderLogo instead of this mark.
  property color markColor: color
  property bool brand: false
  property bool filled: false
  property real iconSize: Style.font.icon
  // Bound to the shell's family rather than fixed, so the icons follow
  // `omarchy font set` with everything else; the tests pass a Nerd Font in.
  // The shell uses one configured Nerd Font for text and icons. Standalone
  // keeps native text metrics, but supplies the same Nerd Font symbol range
  // through Style.font.iconFamily so these private-use codepoints never fall
  // through to a platform-dependent fallback face.
  property string fontFamily: Style.font["iconFamily"] || Style.font.family
  // Stroke weight of the drawn mark only, relative to its 16-unit grid.
  property real strokeScale: 1.4

  readonly property bool drawsMark: brand && name === "gmail"
  // The mark's geometry in whole pixels. It keeps the lines of the 16-unit
  // grid it was drawn on — frame at 1–15 across and 3–13 down, stems at 3.6
  // and 12.4, peak at 5.6, valley at 9.3 — but scaled to an 18–21px header,
  // a 1.4-unit stroke on those lines lands between pixels and every edge comes
  // out a two-tone blur. Each line is moved to the nearest pixel centre (a
  // whole coordinate for an even stroke, a half one for an odd stroke), with
  // right and bottom mirrored from left and top so the ink stays centred.
  readonly property var markGeometry: {
    var n = Math.round(root.iconSize)
    if (!drawsMark || n <= 0) return null
    var s = n / 16
    var stroke = Math.max(1, Math.round(root.strokeScale * s))
    var half = stroke / 2
    function onPixel(v) { return stroke % 2 === 1 ? Math.floor(v) + 0.5 : Math.round(v) }
    var left = onPixel(1 * s)
    var top = onPixel(3 * s)
    var bottom = n - top
    var stemLeft = onPixel(3.6 * s)
    // The stems end on the inside of the bottom edge rather than on it.
    return {
      stroke: stroke, left: left, right: n - left, top: top, bottom: bottom,
      stemLeft: stemLeft, stemRight: n - stemLeft, middle: n / 2,
      peak: onPixel(5.6 * s), floor: bottom - half, valley: 9.3 * s,
      // Where the envelope's ink ends, for lining it up with a line of text.
      inkBottom: bottom + half
    }
  }
  // A baseline at the bottom of the envelope's ink, so a caller can sit the
  // mark on a line of text the way a capital letter sits on it.
  baselineOffset: markGeometry ? markGeometry.inkBottom : height
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
      function onMarkGeometryChanged() { mark.requestPaint() }
    }

    onPaint: {
      var ctx = getContext("2d")
      ctx.reset()
      var g = root.markGeometry
      if (!g) return
      ctx.lineWidth = g.stroke
      ctx.lineJoin = "round"

      // The Gmail mark: the envelope body, with the M fold inset inside it. A
      // plain envelope with a V fold is the generic mail glyph — the M is the
      // whole difference. The two are stroked separately so the M can carry
      // the theme accent while the envelope stays in the foreground colour.
      ctx.strokeStyle = root.color
      ctx.beginPath()
      ctx.rect(g.left, g.top, g.right - g.left, g.bottom - g.top)
      ctx.stroke()
      // Square ends that stop at the inside of the bottom edge: the stems
      // stand on the envelope rather than being painted over it, which is
      // what a round cap at the edge itself did — an accent smear across the
      // frame's bottom line.
      ctx.lineCap = "butt"
      ctx.strokeStyle = root.markColor
      ctx.beginPath()
      ctx.moveTo(g.stemLeft, g.floor); ctx.lineTo(g.stemLeft, g.peak)
      ctx.lineTo(g.middle, g.valley)
      ctx.lineTo(g.stemRight, g.peak); ctx.lineTo(g.stemRight, g.floor)
      ctx.stroke()
    }
  }
}
