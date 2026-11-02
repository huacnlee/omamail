pragma Singleton
import QtQuick

// A stand-in for the shell's border factory. A spec is `color` plus
// `widths.top/right/bottom/left`, and the code that draws with it reads both —
// so a stub that returned a plain `width` would let a kit component pass here
// and fail in the shell.
QtObject {
  function parseWidthSpec(width) {
    var size = width === undefined ? 0 : width
    return { top: size, right: size, bottom: size, left: size }
  }

  function flat(color, width) {
    return {
      color: color || "transparent",
      widths: parseWidthSpec(width),
      gradient: { colors: [], angle: 0, enabled: false },
    }
  }

  function none() { return flat("transparent", 0) }

  function controlWidths(state) {
    if (state === "none") return parseWidthSpec(0)
    if (state === "focus") return parseWidthSpec(Style.focusBorderWidth)
    if (state === "hover" || state === "hot") return parseWidthSpec(Style.hoverBorderWidth)
    if (state === "selected") return parseWidthSpec(Style.selectedBorderWidth)
    return parseWidthSpec(Style.normalBorderWidth)
  }

  function controlSpec(state, foreground, _accent, _urgent) {
    return {
      color: foreground,
      widths: controlWidths(state),
      gradient: { colors: [], angle: 0, enabled: false },
    }
  }

  function controlHasWidth(state) { return controlWidths(state).top > 0 }

  function localOrSurfaceSpec(_section, _token, localColor, defaultColor, fallbackWidth) {
    return flat(localColor === undefined ? defaultColor : localColor, fallbackWidth)
  }

  function withWidth(spec, width) {
    if (!spec) return none()
    return { color: spec.color, gradient: spec.gradient, widths: parseWidthSpec(width) }
  }

  function isNone(spec) { return !spec || !spec.widths || spec.widths.top <= 0 }
  function top(spec) { return spec && spec.widths ? spec.widths.top : 0 }
  function right(spec) { return spec && spec.widths ? spec.widths.right : 0 }
  function bottom(spec) { return spec && spec.widths ? spec.widths.bottom : 0 }
  function left(spec) { return spec && spec.widths ? spec.widths.left : 0 }
  function uniformWidth(spec) { return spec && spec.widths ? spec.widths.top : 0 }
  function color(spec) { return spec ? spec.color : "transparent" }
}
