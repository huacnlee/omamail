import QtQuick

// The popout a bar widget opens. The real one is a PanelWindow — a Wayland
// layer surface — which cannot be created offscreen, so this is an Item that
// accepts the same properties and holds the same children.
Item {
  property Item anchorItem: null
  property var owner: null
  property QtObject bar: null
  property bool open: false
  property int contentWidth: 280
  property int contentHeight: 200
  property int margin: 8
  property int padding: 8
  property bool centerOnBar: false
  property int gap: 8
  property bool popoutSwitching: false
  property bool popoutSwitchClosing: false
  property bool focusPrimed: false
  property Item focusTarget: null
  visible: false
}
