pragma Singleton
import QtQuick

QtObject {
  id: root

  readonly property FontLoader iconFont: FontLoader {
    source: "../../../../assets/fonts/SymbolsNerdFontMono-Regular.ttf"
  }

  readonly property FontLoader textFont: FontLoader {
    source: "../../../../assets/fonts/JetBrainsMonoNerdFontMono-Regular.ttf"
  }

  readonly property FontMetrics metrics: FontMetrics { font: Qt.application.font }
  // Omarchy shell baseline at the inspected revision. Bundle its default
  // Nerd Font so every standalone platform gets the same text metrics and
  // glyph coverage without depending on the host's font configuration.
  readonly property real baseFontSize: 12
  property real spacingScale: 1
  readonly property real cornerRadius: 0
  readonly property real normalBorderWidth: 1
  readonly property color normalBorderColor: normalBorderFor(Color.foreground, Color.accent)
  readonly property color selectedAccentFill: selectedFillFor(Color.foreground, Color.accent)
  readonly property var font: ({
    family: textFont.status === FontLoader.Ready ? textFont.name : "monospace",
    iconFamily: iconFont.status === FontLoader.Ready ? iconFont.name : metrics.font.family,
    title: Math.round(baseFontSize * 1.167),
    heading: Math.round(baseFontSize * 1.333),
    subtitle: Math.round(baseFontSize * 1.083),
    body: Math.round(baseFontSize),
    bodySmall: Math.round(baseFontSize * 0.917),
    caption: Math.round(baseFontSize * 0.833),
    iconLarge: Math.round(baseFontSize * 1.5),
    icon: Math.round(baseFontSize * 1.167),
    iconSmall: Math.round(baseFontSize * 0.917)
  })
  readonly property var spacing: ({
    controlPaddingX: space(10), controlPaddingY: space(6), inputPaddingY: space(7),
    controlHeight: space(28), controlGap: space(8), sm: space(4), md: space(6),
    popupRowHeight: space(28)
  })

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
  function hoverFillFor(foreground, _accent) { return withAlpha(foreground, 0.08) }
  function selectedFillFor(foreground, _accent) { return withAlpha(foreground, 0.18) }
  function selectedStateColor(foreground, _accent) { return foreground }
  function selectionFillFor(foreground, _accent) { return withAlpha(foreground, 0.35) }
  function pressedFillFor(foreground, _accent) { return withAlpha(foreground, 0.22) }
  function normalFillFor(foreground, _accent) { return withAlpha(foreground, 0.04) }
  function normalBorderFor(foreground, _accent) { return withAlpha(foreground, 0.4) }
  function hoverBorderFor(foreground, _accent) { return withAlpha(foreground, 0.25) }
}
