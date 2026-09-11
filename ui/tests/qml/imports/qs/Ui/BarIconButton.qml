import QtQuick

// The clickable slot a bar widget draws into. The icon itself is a Component
// the caller supplies, which a test never has to render.
Item {
  property QtObject bar: null
  property Component iconComponent: null
  property string tooltipText: ""
  property real slotSize: 24
  property real opticalSize: 20
  implicitWidth: slotSize
  implicitHeight: slotSize
  // The real one inherits WidgetButton, whose press carries which mouse
  // button it was: the widget opens the window on the primary and the preview
  // on the secondary, so a stub with a bare `clicked()` cannot stand in.
  property bool active: false
  property color foreground: Qt.rgba(1, 1, 1, 1)
  signal pressed(int button)
  signal wheelMoved(int delta)
}
