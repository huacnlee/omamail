import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Commons as Commons

QQC.ToolTip {
  property string fontFamily: Style.font.family
  // The shell's PanelToolTip paints a background, a text colour and a border
  // colour of its own; the standalone host uses the platform tooltip's palette.
  // They exist here so a caller may pass them either way.
  property color panelForeground: Commons.Color.tooltip.text
  property color panelBackground: Commons.Color.tooltip.background
  property color panelBorder: Commons.Color.tooltip.border
  delay: Style.tooltipDelay
  font.family: fontFamily
  font.pixelSize: Style.font.caption
  palette.window: Commons.Color.popups.background
  palette.windowText: Commons.Color.popups.text
}
