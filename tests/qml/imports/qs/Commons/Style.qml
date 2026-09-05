pragma Singleton
import QtQuick

QtObject {
  readonly property real cornerRadius: 2
  readonly property real normalBorderWidth: 1
  readonly property var font: ({
    family: "monospace", title: 22, heading: 18, body: 14, bodySmall: 13, caption: 11,
    icon: 16, iconSmall: 14
  })
  readonly property var spacing: ({
    controlPaddingX: 8, controlPaddingY: 5, inputPaddingY: 5,
    controlHeight: 30, controlGap: 6, sm: 3, md: 6
  })

  // The shell's own `space` is `round(px * scale)`, and the rounding is the
  // point rather than an implementation detail: a theme whose spacing follows
  // the font — `base-size 14` gives 7/6 — makes `space(4)` 5 while `space(8)`
  // is 9, so a box that pads by one and measures itself by the other comes out
  // a pixel short. A stub that multiplied nothing could not see that, and did
  // not. Tests that care set `spacingScale`; the rest run at 1, where this
  // rounds integers to themselves.
  property real spacingScale: 1
  function space(value) {
    var n = Number(value) * spacingScale
    return n <= 0 ? 0 : Math.max(1, Math.round(n))
  }
  function hoverFillFor(_foreground, accent) { return accent }
  function selectedFillFor(_foreground, accent) { return accent }
  function selectionFillFor(_foreground, accent) { return accent }
  function pressedFillFor(_foreground, accent) { return accent }
  function normalFillFor(_foreground, _accent) { return "transparent" }
  function normalBorderFor(foreground, _accent) { return foreground }
  function hoverBorderFor(_foreground, accent) { return accent }
}
