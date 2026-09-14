import QtQuick
import QtQuick.Controls as QQC
import qs.Commons

Item {
  id: root

  property string label: ""
  property string value: ""
  property var options: []
  property color foreground: Color.foreground
  property color background: Color.background
  property color popupBorder: Color.popups.border
  property color accent: Color.accent
  property string fontFamily: Style.font.family
  property int rowHeight: Style.spacing.controlHeight
  property int popupRowHeight: Style.spacing.popupRowHeight
  property bool showLabel: true
  property bool hasCursor: false
  readonly property bool popupOpen: combo.popup.visible
  signal changed(string value)
  signal hovered(bool isHovered)

  function syncIndex() {
    var next = indexForValue(value)
    if (combo.currentIndex !== next) combo.currentIndex = next
  }
  onValueChanged: syncIndex()
  onOptionsChanged: {
    syncIndex()
    Qt.callLater(syncIndex)
  }

  implicitWidth: Style.space(240)
  implicitHeight: Math.max(rowHeight, labelText.visible ? labelText.implicitHeight : 0)

  function indexForValue(wanted) {
    for (var i = 0; i < options.length; i++)
      if (String(options[i].value) === String(wanted)) return i
    return -1
  }

  Text {
    id: labelText
    visible: root.showLabel && root.label !== ""
    anchors.left: parent.left
    anchors.verticalCenter: parent.verticalCenter
    text: root.label
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  QQC.ComboBox {
    id: combo
    objectName: "dropdown-input"
    anchors.left: labelText.visible ? labelText.right : parent.left
    anchors.leftMargin: labelText.visible ? Style.spacing.controlGap : 0
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    height: root.rowHeight
    model: root.options
    textRole: "label"
    valueRole: "value"
    currentIndex: -1
    palette.buttonText: root.foreground
    palette.button: root.background
    palette.highlight: root.accent
    palette.window: root.background
    delegate: QQC.ItemDelegate {
      required property var modelData
      width: combo.width
      height: root.popupRowHeight
      text: String(modelData.label || "")
      font.family: root.fontFamily
      palette.text: root.foreground
      palette.highlight: root.accent
    }
    onActivated: function(index) {
      if (index < 0 || index >= root.options.length) return
      root.changed(String(root.options[index].value))
      root.syncIndex()
    }
    onHoveredChanged: root.hovered(hovered)
  }

  Component.onCompleted: syncIndex()
}
