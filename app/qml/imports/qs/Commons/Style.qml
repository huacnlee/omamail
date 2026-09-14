pragma Singleton
import QtQuick

QtObject {
  id: root

  readonly property FontMetrics metrics: FontMetrics { font: Qt.application.font }
  readonly property real baseFontSize: Math.max(10,
    metrics.font.pixelSize > 0 ? metrics.font.pixelSize : metrics.height * 0.8)
  property real spacingScale: Math.max(0.75, baseFontSize / 14)
  readonly property real cornerRadius: space(4)
  readonly property real normalBorderWidth: 1
  readonly property color normalBorderColor: normalBorderFor(Color.foreground, Color.accent)
  readonly property color selectedAccentFill: selectedFillFor(Color.foreground, Color.accent)
  readonly property var font: ({
    family: metrics.font.family,
    title: Math.round(baseFontSize * 1.55),
    heading: Math.round(baseFontSize * 1.28),
    subtitle: Math.round(baseFontSize * 1.1),
    body: Math.round(baseFontSize),
    bodySmall: Math.round(baseFontSize * 0.93),
    caption: Math.round(baseFontSize * 0.79),
    iconLarge: Math.round(baseFontSize * 1.55),
    icon: Math.round(baseFontSize * 1.14),
    iconSmall: Math.round(baseFontSize)
  })
  readonly property var spacing: ({
    controlPaddingX: space(8), controlPaddingY: space(5), inputPaddingY: space(5),
    controlHeight: space(30), controlGap: space(6), sm: space(3), md: space(6),
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
  function hoverFillFor(foreground, _accent) { return withAlpha(foreground, 0.09) }
  function selectedFillFor(_foreground, accent) { return withAlpha(accent, 0.24) }
  function selectedStateColor(foreground, accent) { return mix(foreground, accent, 0.42) }
  function selectionFillFor(_foreground, accent) { return withAlpha(accent, 0.32) }
  function pressedFillFor(foreground, accent) { return withAlpha(mix(foreground, accent, 0.55), 0.3) }
  function normalFillFor(foreground, _accent) { return withAlpha(foreground, 0.045) }
  function normalBorderFor(foreground, _accent) { return withAlpha(foreground, 0.2) }
  function hoverBorderFor(_foreground, accent) { return withAlpha(accent, 0.72) }
}
