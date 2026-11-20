import QtQuick
import qs.Commons

// The window's identity in its header: the mark, then the name.
//
// The mark sits on the name's baseline the way a capital letter does, at a
// whole-pixel position. Centred on the name's line box instead, it rode a
// pixel or two below the letters (the box includes the descender), and half
// a pixel off the grid blurred every edge of it.
Item {
  id: root

  required property color foreground
  required property color accent
  required property string fontFamily
  property bool showsTitle: true

  implicitWidth: showsTitle ? title.x + title.implicitWidth : mark.width
  implicitHeight: Math.max(mark.height, title.implicitHeight)

  ActionIcon {
    id: mark
    objectName: "appMark"
    y: root.showsTitle
      ? Math.round(title.y + title.baselineOffset - baselineOffset)
      : Math.round((root.height - height) / 2)
    name: "gmail"
    iconSize: Style.font.iconLarge
    color: root.foreground
    markColor: root.accent
    brand: true
  }

  Text {
    id: title
    objectName: "appTitle"
    x: mark.width + Style.space(8)
    y: Math.round((root.height - height) / 2)
    visible: root.showsTitle
    text: "Omamail"
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.title
  }
}
