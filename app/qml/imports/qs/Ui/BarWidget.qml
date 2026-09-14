import QtQuick
import qs.Commons

Item {
  property QtObject bar: null
  property string moduleName: ""
  property var settings: ({})
  readonly property bool vertical: bar ? bar.vertical : false
  readonly property int barSize: Style.spacing.controlHeight
}
