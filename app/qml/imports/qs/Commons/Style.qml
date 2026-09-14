pragma Singleton
import QtQuick

QtObject {
  id: root

  property var shellTheme: ({
    font: { baseSize: 12, overrides: {} },
    spacing: { scale: 1, scaleWithFont: true, overrides: {} },
    controls: {}, popups: {}
  })

  readonly property FontLoader iconFont: FontLoader {
    source: "../../../../assets/fonts/SymbolsNerdFontMono-Regular.ttf"
  }

  readonly property FontMetrics metrics: FontMetrics { font: Qt.application.font }
  // Text follows the platform UI font in the standalone app. Only the private
  // use icon range is bundled; regular labels retain native platform metrics.
  readonly property real baseFontSize: shellTheme.font.baseSize
  readonly property real fontScale: Math.max(1 / 12, baseFontSize / 12)
  readonly property real spacingScale: shellTheme.spacing.scale
    * (shellTheme.spacing.scaleWithFont ? fontScale : 1)
  readonly property real cornerRadius: 0
  readonly property real normalBorderWidth: controlNumber("normal-border-width", 1)
  readonly property real hoverBorderWidth: controlNumber("hover-cursor-border-width", normalBorderWidth)
  readonly property real selectedBorderWidth: controlNumber("selected-border-width", 0)
  readonly property real focusBorderWidth: controlNumber("focus-border-width", hoverBorderWidth)
  // Match the shell's hover intent threshold. Keeping this here gives every
  // standalone tooltip the same pause, including controls that use the
  // platform style directly.
  readonly property int tooltipDelay: 400
  readonly property color normalBorderColor: normalBorderFor(Color.foreground, Color.accent)
  readonly property color selectedAccentFill: selectedFillFor(Color.foreground, Color.accent)
  readonly property var font: ({
    family: metrics.font.family,
    iconFamily: iconFont.status === FontLoader.Ready ? iconFont.name : metrics.font.family,
    baseSize: baseFontSize,
    title: fontToken("title", 1.167),
    heading: fontToken("heading", 1.333),
    subtitle: fontToken("subtitle", 1.083),
    body: fontToken("body", 1),
    bodySmall: fontToken("body-small", 0.917),
    caption: fontToken("caption", 0.833),
    display: fontToken("display", 2),
    displayLarge: fontToken("display-large", 2.333),
    iconLarge: fontToken("icon-large", 1.5),
    icon: fontToken("icon", 1.167),
    iconSmall: fontToken("icon-small", 0.917)
  })
  readonly property var spacing: ({
    xxs: spacingToken("xxs", 2), xs: spacingToken("xs", 3),
    sm: spacingToken("sm", 4), md: spacingToken("md", 6),
    lg: spacingToken("lg", 8), xl: spacingToken("xl", 10),
    xxl: spacingToken("xxl", 12), xxxl: spacingToken("xxxl", 14),
    huge: spacingToken("huge", 18),
    controlPaddingX: spacingToken("control-padding-x", 10),
    controlPaddingY: spacingToken("control-padding-y", 6),
    inputPaddingY: spacingToken("input-padding-y", 7),
    controlHeight: spacingToken("control-height", 28),
    controlGap: spacingToken("control-gap", 8),
    popupRowHeight: spacingToken("popup-row-height", 28),
    dropdownWidth: spacingToken("dropdown-width", 240),
    searchableDropdownWidth: spacingToken("searchable-dropdown-width", 260),
    numberFieldWidth: spacingToken("number-field-width", 120),
    searchablePopupMinHeight: spacingToken("searchable-popup-min-height", 220),
    rowGap: spacingToken("row-gap", 8), rowPaddingX: spacingToken("row-padding-x", 12),
    labelGap: spacingToken("label-gap", 4), panelGap: spacingToken("panel-gap", 14),
    panelPadding: spacingToken("panel-padding", 18),
    popupPadding: spacingToken("popup-padding", 14)
  })

  function applyShellTheme(value) { shellTheme = value }
  function fontToken(key, multiplier) {
    var value = shellTheme.font.overrides[key]
    return value === undefined ? Math.max(1, Math.round(baseFontSize * multiplier)) : value
  }
  function spacingToken(key, fallback) {
    var value = shellTheme.spacing.overrides[key]
    return value === undefined ? space(fallback) : Math.round(value)
  }
  function controlNumber(key, fallback) {
    var value = shellTheme.controls[key]
    return value === undefined ? fallback : Number(value)
  }
  function controlColor(key, foreground, accent, fallback) {
    var token = String(shellTheme.controls[key] || "").replace(/^\s+|\s+$/g, "")
    var role = token.toLowerCase()
    if (role === "foreground" || role === "text") return foreground
    if (role === "accent") return accent
    if (role === "urgent") return Color.urgent
    if (role === "background") return Color.background
    if (role === "transparent") return Qt.rgba(0, 0, 0, 0)
    if (role === "hover" || role === "hover-cursor" || role === "inherit") return fallback
    return token.charAt(0) === "#" ? token : fallback
  }

  function space(value) {
    var n = Number(value) * spacingScale
    return n <= 0 ? 0 : Math.max(1, Math.round(n))
  }
  function withAlpha(color, alpha) { return Qt.rgba(color.r, color.g, color.b, alpha) }
  function mix(first, second, amount) {
    var n = Math.max(0, Math.min(1, Number(amount)))
    return Qt.rgba(first.r * (1 - n) + second.r * n,
      first.g * (1 - n) + second.g * n,
      first.b * (1 - n) + second.b * n,
      first.a * (1 - n) + second.a * n)
  }
  function mutedColorFor(foreground, background) { return mix(foreground, background, 0.46) }
  function stateColor(key, foreground, accent, fallback) {
    return controlColor(key + "-color", foreground, accent, fallback || foreground)
  }
  function hoverFillFor(foreground, accent) { return withAlpha(stateColor("hover-cursor", foreground, accent, foreground), controlNumber("hover-cursor-fill-alpha", 0.08)) }
  function selectedFillFor(foreground, accent) { return withAlpha(selectedStateColor(foreground, accent), controlNumber("selected-fill-alpha", 0.18)) }
  function selectedStateColor(foreground, accent) { return stateColor("selected", foreground, accent, foreground) }
  function selectionFillFor(foreground, accent) { return withAlpha(stateColor("selection", foreground, accent, foreground), controlNumber("selection-fill-alpha", 0.35)) }
  function pressedFillFor(foreground, accent) { return withAlpha(stateColor("pressed", foreground, accent, stateColor("hover-cursor", foreground, accent, foreground)), controlNumber("pressed-fill-alpha", 0.22)) }
  function normalFillFor(foreground, accent) { return withAlpha(stateColor("normal", foreground, accent, foreground), controlNumber("normal-fill-alpha", 0.04)) }
  function normalBorderFor(foreground, accent) { return withAlpha(stateColor("normal", foreground, accent, foreground), controlNumber("normal-border-alpha", 0.4)) }
  function hoverBorderFor(foreground, accent) { return withAlpha(stateColor("hover-cursor", foreground, accent, foreground), controlNumber("hover-cursor-border-alpha", 0.25)) }
  function selectedBorderFor(foreground, accent) { return withAlpha(stateColor("selected", foreground, accent, foreground), controlNumber("selected-border-alpha", 1)) }
  function focusFillFor(foreground, accent) { return withAlpha(stateColor("focus", foreground, accent, stateColor("hover-cursor", foreground, accent, foreground)), controlNumber("focus-fill-alpha", controlNumber("hover-cursor-fill-alpha", 0.08))) }
  function focusBorderFor(foreground, accent) { return withAlpha(stateColor("focus", foreground, accent, stateColor("hover-cursor", foreground, accent, foreground)), controlNumber("focus-border-alpha", controlNumber("hover-cursor-border-alpha", 0.25))) }
}
