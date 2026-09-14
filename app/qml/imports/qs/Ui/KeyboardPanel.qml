import QtQuick
import QtQuick.Controls as QQC
import qs.Commons

Item {
  id: root

  property Item anchorItem: null
  property var owner: null
  property QtObject bar: null
  property bool open: false
  property int contentWidth: Style.space(280)
  property int contentHeight: Style.space(200)
  property int margin: Style.space(8)
  property int padding: Style.space(8)
  property bool centerOnBar: false
  property int gap: Style.space(8)
  property bool popoutSwitching: false
  property bool popoutSwitchClosing: false
  property bool focusPrimed: false
  property Item focusTarget: null
  visible: false

  QQC.Popup {
    parent: root.anchorItem || root
    visible: root.open
    width: root.contentWidth
    height: root.contentHeight
    padding: root.padding
  }
}
