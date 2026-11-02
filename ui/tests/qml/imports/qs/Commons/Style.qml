pragma Singleton
import QtQuick

QtObject {
  readonly property real cornerRadius: 2
  readonly property real normalBorderWidth: 1
  readonly property real hoverBorderWidth: 1
  readonly property real selectedBorderWidth: 0
  readonly property real focusBorderWidth: 1

  // The alphas and widths the window keeps from the live shell style even when
  // it draws in a theme of its own.
  readonly property real normalFillAlpha: 0.04
  readonly property real hoverFillAlpha: 0.08
  readonly property real selectedFillAlpha: 0.18
  readonly property real pressedFillAlpha: 0.22
  readonly property real focusFillAlpha: 0.08
  readonly property real selectionFillAlpha: 0.35
  property real normalBorderAlpha: 0.4
  property real hoverBorderAlpha: 0.25
  property real selectedBorderAlpha: 1.0
  property real focusBorderAlpha: 0.25

  readonly property var font: ({
    family: "monospace", title: 22, heading: 18, body: 14, bodySmall: 13, caption: 11,
    icon: 16, iconSmall: 14, iconLarge: 18, subtitle: 15, display: 24, displayLarge: 28
  })
  // `popupRowHeight` is the shell's 28. A stub without it gave every plain
  // menu row a height of zero, so a click on "Manage accounts..." fell through
  // the popup to whatever the window had underneath.
  readonly property var spacing: ({
    controlPaddingX: 8, controlPaddingY: 5, inputPaddingY: 5,
    controlHeight: 30, hairline: 1, panelGap: 14, controlGap: 6, sm: 3, md: 6, popupRowHeight: 28,
    huge: 18, xxs: 2, xs: 2, lg: 8, xl: 10, xxl: 12, xxxl: 14,
    labelGap: 4, dropdownWidth: 240, popupPadding: 14, panelPadding: 18,
    rowGap: 8, rowPaddingX: 12, numberFieldWidth: 120,
    searchableDropdownWidth: 260, searchablePopupMinHeight: 220
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

  // The real shell renders shell.toml with the desktop theme's hex baked into
  // [controls], so every state helper ignores the colours it is handed and
  // answers with the desktop's. A test that has to detect that defect turns it
  // on here; with it off — as it is for every other test — the helpers answer
  // with what they were given.
  property bool bakedStateColors: false
  property color bakedForeground: Qt.rgba(1, 1, 1, 1)

  function baked(alpha) {
    return Qt.rgba(bakedForeground.r, bakedForeground.g, bakedForeground.b, alpha)
  }

  function normalFillFor(_foreground, _accent) { return bakedStateColors ? baked(normalFillAlpha) : "transparent" }
  function hoverFillFor(_foreground, accent) { return bakedStateColors ? baked(hoverFillAlpha) : accent }
  function selectedFillFor(_foreground, accent) { return bakedStateColors ? baked(selectedFillAlpha) : accent }
  function pressedFillFor(_foreground, accent) { return bakedStateColors ? baked(pressedFillAlpha) : accent }
  function focusFillFor(_foreground, accent) { return bakedStateColors ? baked(focusFillAlpha) : accent }
  function selectionFillFor(_foreground, accent) { return bakedStateColors ? baked(selectionFillAlpha) : accent }
  function normalBorderFor(foreground, _accent) { return bakedStateColors ? baked(normalBorderAlpha) : foreground }
  function hoverBorderFor(_foreground, accent) { return bakedStateColors ? baked(hoverBorderAlpha) : accent }
  function selectedBorderFor(foreground, _accent) { return bakedStateColors ? baked(selectedBorderAlpha) : foreground }
  function focusBorderFor(_foreground, accent) { return bakedStateColors ? baked(focusBorderAlpha) : accent }

  function normalStateColor(foreground, _accent) { return bakedStateColors ? bakedForeground : foreground }
  function hoverStateColor(foreground, accent) { return bakedStateColors ? bakedForeground : (accent || foreground) }
  function focusStateColor(foreground, accent) { return bakedStateColors ? bakedForeground : (accent || foreground) }
  function pressedStateColor(foreground, accent) { return bakedStateColors ? bakedForeground : (accent || foreground) }
  function selectedStateColor(foreground, _accent) { return bakedStateColors ? bakedForeground : foreground }
  function selectionStateColor(foreground, _accent) { return bakedStateColors ? bakedForeground : foreground }

  function controlFill(focused, hot, foreground, accent) {
    if (focused) return focusFillFor(foreground, accent)
    if (hot) return hoverFillFor(foreground, accent)
    return normalFillFor(foreground, accent)
  }
  function controlBorder(focused, hot, foreground, accent) {
    if (focused) return focusBorderFor(foreground, accent)
    if (hot) return hoverBorderFor(foreground, accent)
    return normalBorderFor(foreground, accent)
  }
  function controlBorderWidth(focused, hot) {
    if (focused) return focusBorderWidth
    if (hot) return hoverBorderWidth
    return normalBorderWidth
  }
  function controlHasWidth(state) {
    if (state === "selected") return selectedBorderWidth > 0
    if (state === "hover" || state === "hover-cursor") return hoverBorderWidth > 0
    if (state === "focus") return focusBorderWidth > 0
    return normalBorderWidth > 0
  }
}
