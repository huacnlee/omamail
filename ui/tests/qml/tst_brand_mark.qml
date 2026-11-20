import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import "../../components" as Omamail

// The window title's mark: an envelope with an accent M, drawn on a Canvas at
// a header size of 18–21px. Drawn off a 16-unit grid it put every edge
// between pixels (a two-tone blur) and painted the M's round-capped ends over
// the envelope's bottom line. These are the rules that keep it crisp.
Item {
  width: 120
  height: 60

  Omamail.ActionIcon {
    id: mark
    name: "gmail"
    brand: true
    color: Qt.rgba(0.76, 0.82, 0.82, 1)
    markColor: Qt.rgba(0.94, 0.57, 0.25, 1)
  }

  // Pure colours on black, so a pixel is plainly frame, M, empty or a blend.
  Rectangle {
    id: pureBackground
    x: 40
    width: 21
    height: 21
    color: Qt.rgba(0, 0, 0, 1)

    Omamail.ActionIcon {
      id: pure
      name: "gmail"
      brand: true
      iconSize: 21
      color: Qt.rgba(1, 1, 1, 1)
      markColor: Qt.rgba(1, 0, 0, 1)
    }
  }

  Omamail.AppTitle {
    id: header
    y: 20
    foreground: Qt.rgba(0.76, 0.82, 0.82, 1)
    accent: Qt.rgba(0.94, 0.57, 0.25, 1)
    fontFamily: "monospace"
  }

  TestCase {
    name: "BrandMark"
    when: windowShown

    function onPixelCentre(value, stroke) {
      var fraction = Math.abs(value - Math.floor(value))
      return stroke % 2 === 1 ? fraction === 0.5 : fraction === 0
    }

    function test_every_line_sits_on_a_pixel_and_the_ink_is_centred() {
      var sizes = [14, 16, 18, 21, 24, 32]
      for (var i = 0; i < sizes.length; i++) {
        mark.iconSize = sizes[i]
        var g = mark.markGeometry
        var n = sizes[i]
        verify(g, "a brand mark has geometry at " + n)
        var where = " at " + n + "px"
        verify(Number.isInteger(g.stroke) && g.stroke >= 1, "whole-pixel stroke" + where)
        var lines = [g.left, g.right, g.top, g.bottom, g.stemLeft, g.stemRight]
        for (var j = 0; j < lines.length; j++)
          verify(onPixelCentre(lines[j], g.stroke), "line " + j + " = " + lines[j] + where)
        compare(g.left + g.right, n, "mirrored left and right" + where)
        compare(g.top + g.bottom, n, "mirrored top and bottom" + where)
        compare(g.stemLeft + g.stemRight, n, "the M is centred" + where)
        // The M stays inside the frame: clear of both sides and the top, and
        // its stems end on the inside of the bottom edge rather than on it.
        verify(g.stemLeft - g.stroke / 2 > g.left + g.stroke / 2, "clear of the left side" + where)
        verify(g.peak - g.stroke / 2 > g.top + g.stroke / 2, "clear of the top" + where)
        compare(g.floor, g.bottom - g.stroke / 2, "stems stand on the inner bottom edge" + where)
        compare(mark.baselineOffset, g.bottom + g.stroke / 2, "baseline is the bottom of the ink" + where)
      }
    }

    function child(item, name) {
      for (var i = 0; i < item.children.length; i++)
        if (item.children[i].objectName === name) return item.children[i]
      return null
    }

    // In the header the mark stands on the title's baseline, on a whole pixel.
    function test_the_header_mark_sits_on_the_title_baseline() {
      var mark = child(header, "appMark")
      var title = child(header, "appTitle")
      verify(mark && title)
      verify(Number.isInteger(mark.y), "whole-pixel position, got " + mark.y)
      verify(Math.abs(mark.y + mark.baselineOffset - (title.y + title.baselineOffset)) < 1,
        "ink bottom " + (mark.y + mark.baselineOffset) + " vs baseline " + (title.y + title.baselineOffset))
      header.showsTitle = false
      compare(header.implicitWidth, mark.width, "without the name only the mark takes room")
      verify(Number.isInteger(mark.y))
      header.showsTitle = true
    }

    // What the header shows at a 14px theme font size (a 21px icon). Off
    // the pixel grid, about 140 of its pixels were blends of white, red and
    // black, and the M's round ends lay red across the frame's bottom line.
    function test_the_header_size_mark_draws_crisp_edges_and_no_accent_on_the_frame() {
      function kind(p) {
        if (p.r < 0.05 && p.g < 0.05 && p.b < 0.05) return "empty"
        if (p.r > 0.95 && p.g > 0.95 && p.b > 0.95) return "frame"
        if (p.r > 0.95 && p.g < 0.05 && p.b < 0.05) return "mark"
        return "blend"
      }
      var image = null
      tryVerify(function() {
        image = grabImage(pureBackground)
        for (var y = 0; y < 21; y++)
          for (var x = 0; x < 21; x++) if (kind(image.pixel(x, y)) === "frame") return true
        return false
      }, 2000, "the mark was painted")
      var blended = 0
      var lowest = -1
      for (var y = 0; y < 21; y++) {
        for (var x = 0; x < 21; x++) {
          var k = kind(image.pixel(x, y))
          if (k === "blend") blended++
          if (k !== "empty") lowest = y
        }
      }
      verify(blended <= 40, blended + " blended pixels")
      // The frame's bottom line, its 2px stroke the last two rows of ink, shows
      // no red from the M.
      for (var row = lowest - 1; row <= lowest; row++) {
        for (var col = 0; col < 21; col++) {
          var p = image.pixel(col, row)
          verify(kind(p) === "empty" || p.r - p.g < 0.2, "accent at " + col + "," + row)
        }
      }
    }

    function test_an_ordinary_icon_draws_no_mark() {
      mark.brand = false
      compare(mark.markGeometry, null)
      mark.brand = true
    }
  }
}
