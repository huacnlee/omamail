import QtQuick
import qs.Commons

Rectangle {
  property var borderSpec: Border.flat(Style.normalBorderColor, Style.normalBorderWidth)
  color: Style.withAlpha(Color.background, 0)
  border.color: borderSpec && borderSpec.color !== undefined
    ? borderSpec.color : Style.normalBorderColor
  border.width: borderSpec && borderSpec.width !== undefined
    ? borderSpec.width : Style.normalBorderWidth
}
