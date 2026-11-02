import QtQuick

Item {
  property string text: ""
  property string fontFamily: "monospace"
  // The shell's PanelToolTip paints itself in these; a stub only has to accept
  // them so a caller can pass a colour either way.
  property color panelForeground: "transparent"
  property color panelBackground: "transparent"
  property color panelBorder: "transparent"
}
