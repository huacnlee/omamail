import QtQuick
import qs.Commons

// The app's icon set, drawn rather than rasterised from SVG assets: these
// render at 13–16px, where Qt's SVG renderer smears strokes. The shell's own
// bar icons are Canvas paths for the same reason.
//
// One 16-unit grid and one stroke weight for every glyph, so a row of them
// reads as a set. Coordinates are the same ones the design sheet uses.
Canvas {
  id: root

  property string name: ""
  property color color: Color.foreground

  // Omamail keeps the envelope in the foreground and gives its M the active
  // theme accent. Provider artwork uses ProviderLogo instead of this mark.
  property color markColor: color
  property bool brand: false
  property real iconSize: Style.font.icon
  property real strokeScale: 1.4

  width: iconSize
  height: iconSize
  implicitWidth: iconSize
  implicitHeight: iconSize
  antialiasing: true

  onNameChanged: requestPaint()
  onColorChanged: requestPaint()
  onIconSizeChanged: requestPaint()
  onBrandChanged: requestPaint()
  onMarkColorChanged: requestPaint()

  onPaint: {
    var ctx = getContext("2d")
    ctx.reset()
    var s = width / 16
    if (s <= 0) return

    ctx.strokeStyle = root.color
    ctx.lineWidth = Math.max(1, root.strokeScale * s)
    ctx.lineCap = "round"
    ctx.lineJoin = "round"

    function move(x, y) { ctx.moveTo(x * s, y * s) }
    function line(x, y) { ctx.lineTo(x * s, y * s) }
    function arc(cx, cy, r, from, to) { ctx.arc(cx * s, cy * s, r * s, from, to) }

    ctx.beginPath()

    if (root.name === "reply") {
      move(6, 3.5); line(2, 7.5); line(6, 11.5)
      move(2, 7.5); line(9, 7.5)
      arc(9, 12, 4.5, -Math.PI / 2, 0)
      line(13.5, 13)
    } else if (root.name === "replyAll") {
      move(6, 3.5); line(2, 7.5); line(6, 11.5)
      move(9.5, 3.5); line(5.5, 7.5); line(9.5, 11.5)
      move(5.5, 7.5); line(10.5, 7.5)
      arc(10.5, 12, 4.5, -Math.PI / 2, 0)
      line(15, 13)
    } else if (root.name === "forward") {
      move(10, 3.5); line(14, 7.5); line(10, 11.5)
      move(14, 7.5); line(7, 7.5)
      arc(7, 12, 4.5, Math.PI, Math.PI + Math.PI / 2, true)
      line(2.5, 13)
    } else if (root.name === "archive") {
      // A lidded box. The previous drawing was an arrow pointing into a line,
      // which is the universal download icon — wrong verb entirely.
      ctx.rect(1.5 * s, 2.5 * s, 13 * s, 3.2 * s)
      move(2.8, 5.7); line(2.8, 13.5); line(13.2, 13.5); line(13.2, 5.7)
      move(6.4, 8.8); line(9.6, 8.8)
    } else if (root.name === "trash") {
      move(2.5, 4); line(13.5, 4)
      move(6, 4); line(6, 2.5); line(10, 2.5); line(10, 4)
      move(4, 4); line(4.7, 13.5); line(11.3, 13.5); line(12, 4)
    } else if (root.name === "spam") {
      move(8, 1.5); line(14, 4.5); line(14, 8.5)
      arc(8, 8.5, 6, 0, Math.PI / 2)
      move(2, 8.5); line(2, 4.5); line(8, 1.5)
      move(8, 5); line(8, 8.5)
      move(8, 10.8); line(8, 11)
    } else if (root.name === "unread") {
      ctx.rect(1 * s, 3.5 * s, 14 * s, 9 * s)
      move(1, 3.5); line(8, 8.5); line(15, 3.5)
    } else if (root.name === "star") {
      move(8, 1.8); line(9.9, 5.7); line(14.2, 6.3); line(11.1, 9.3)
      line(11.8, 13.6); line(8, 11.6); line(4.2, 13.6); line(4.9, 9.3)
      line(1.8, 6.3); line(6.1, 5.7); ctx.closePath()
    } else if (root.name === "browser") {
      move(9, 2); line(14, 2); line(14, 7)
      move(14, 2); line(7.5, 8.5)
      move(12, 9.5); line(12, 13.5); line(2, 13.5); line(2, 3.5); line(6, 3.5)
    } else if (root.name === "refresh") {
      // One circular arrow with the gap at the top right. Two arrows chasing
      // each other were more faithful to "go and ask", but at sixteen pixels
      // they read as a ring with two nicks taken out of it rather than as
      // anything with direction.
      move(13.2, 8)
      arc(8, 8, 5.2, 0, Math.PI * 1.5)
      move(6.5, 1.6); line(8.9, 2.8); line(6.5, 4.0)
    } else if (root.name === "send") {
      move(14.5, 1.5); line(7, 9)
      move(14.5, 1.5); line(10, 14.5); line(7, 9); line(1.5, 6); ctx.closePath()
    } else if (root.name === "undo") {
      move(5.5, 3); line(1.8, 6.8); line(5.5, 10.5)
      move(1.8, 6.8); line(9, 6.8)
      arc(9, 11.2, 4.4, -Math.PI / 2, 0)
    } else if (root.name === "menu") {
      move(2.5, 4.5); line(13.5, 4.5)
      move(2.5, 8); line(13.5, 8)
      move(2.5, 11.5); line(13.5, 11.5)
    } else if (root.name === "plus") {
      move(8, 3.5); line(8, 12.5)
      move(3.5, 8); line(12.5, 8)
    } else if (root.name === "close") {
      move(3.5, 3.5); line(12.5, 12.5)
      move(12.5, 3.5); line(3.5, 12.5)
    } else if (root.name === "back") {
      move(9, 3); line(4, 8); line(9, 13)
      move(4, 8); line(14, 8)
    } else if (root.name === "chevronLeft") {
      move(10.5, 3); line(5.5, 8); line(10.5, 13)
    } else if (root.name === "chevronRight") {
      move(5.5, 3); line(10.5, 8); line(5.5, 13)
    } else if (root.name === "chevronDown") {
      move(3, 5.5); line(8, 10.5); line(13, 5.5)
    } else if (root.name === "eye" || root.name === "eyeOff") {
      // Almond outline, then the pupil as its own subpath so the two do not
      // join, and a slash for the hidden state.
      move(1.5, 8)
      ctx.bezierCurveTo(4 * s, 3.5 * s, 12 * s, 3.5 * s, 14.5 * s, 8 * s)
      ctx.bezierCurveTo(12 * s, 12.5 * s, 4 * s, 12.5 * s, 1.5 * s, 8 * s)
      move(10.2, 8)
      arc(8, 8, 2.2, 0, Math.PI * 2)
      if (root.name === "eyeOff") {
        move(3, 13.2); line(13, 2.8)
      }
    } else if (root.name === "inbox") {
      move(1.5, 9.5); line(4.5, 9.5); line(6, 11.5); line(10, 11.5); line(11.5, 9.5); line(14.5, 9.5)
      move(1.5, 9.5); line(3.5, 3); line(12.5, 3); line(14.5, 9.5); line(14.5, 13.5)
      line(1.5, 13.5); ctx.closePath()
    } else if (root.name === "compose") {
      move(2.5, 13.5); line(3.4, 10.4); line(11.2, 2.6); line(13.4, 4.8)
      line(5.6, 12.6); ctx.closePath()
      move(9.6, 4.2); line(11.8, 6.4)
    } else if (root.name === "label") {
      move(1.5, 1.5); line(7.6, 1.5); line(14.5, 8.4); line(8.4, 14.5)
      line(1.5, 7.6); ctx.closePath()
      move(5.7, 4.5); arc(4.5, 4.5, 1.2, 0, Math.PI * 2)
    } else if (root.name === "gmail" || root.name === "mail") {
      // The Gmail mark: the envelope body, with the M fold inset inside it. A
      // plain envelope with a V fold is the generic mail glyph — the M is the
      // whole difference. The two are stroked separately so the M can carry
      // the theme accent while the envelope stays in the foreground colour.
      ctx.rect(1 * s, 3 * s, 14 * s, 10 * s)
      ctx.stroke()
      ctx.beginPath()
      if (root.name === "gmail" && root.brand) ctx.strokeStyle = root.markColor
      move(3.6, 13); line(3.6, 5.6); line(8, 9.3); line(12.4, 5.6); line(12.4, 13)
    } else if (root.name === "sidebar") {
      ctx.rect(1.5 * s, 2.5 * s, 13 * s, 11 * s)
      move(6, 2.5); line(6, 13.5)
    } else if (root.name === "check") {
      move(2.5, 8.5); line(6.5, 12.5); line(13.5, 4)
    } else if (root.name === "attachment") {
      move(13, 7); line(7.5, 12.5)
      arc(5, 10, 3.5, Math.PI / 4, Math.PI * 1.25)
      move(8, 2); line(11.5, 5.5)
    } else if (root.name === "calendar") {
      // The rule under the header is what tells this apart from "inbox" at
      // 13px, where the two hangers alone are a couple of pixels each.
      ctx.rect(1.5 * s, 3 * s, 13 * s, 11.5 * s)
      move(1.5, 7); line(14.5, 7)
      move(5, 1.5); line(5, 4.5)
      move(11, 1.5); line(11, 4.5)
    } else if (root.name === "video") {
      ctx.rect(1.5 * s, 4 * s, 9 * s, 8 * s)
      move(10.5, 7.2); line(14.5, 4.8); line(14.5, 11.2); ctx.closePath()
    } else if (root.name === "pin") {
      move(5.45, 8.55)
      arc(8, 6, 3.6, Math.PI * 0.75, Math.PI * 2.25)
      line(8, 13.8); ctx.closePath()
      move(9.3, 6); arc(8, 6, 1.3, 0, Math.PI * 2)
    } else if (root.name === "people") {
      move(8.4, 5.2); arc(6, 5.2, 2.4, 0, Math.PI * 2)
      move(1.8, 13); arc(6, 13, 4.2, Math.PI, Math.PI * 2)
      move(13.4, 5.8); arc(11.5, 5.8, 1.9, 0, Math.PI * 2)
      move(12.4, 13); arc(11.5, 12.8, 3.4, Math.PI * 1.75, Math.PI * 2)
    }

    // Star is the only filled glyph, and only when it is set — a filled star
    // says "on" at a glance where a stroked one does not.
    if (root.name === "star" && root.filled) {
      ctx.fillStyle = root.color
      ctx.fill()
    }
    ctx.stroke()
  }

  property bool filled: false
  onFilledChanged: requestPaint()
}
