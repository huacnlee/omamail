import QtQuick
import QtQuick.Controls
import QtQuick.Window
import qs.Commons
import qs.Ui
import "../calendar/Sources.js" as Sources

Flickable {
  id: root

  required property var controller
  required property color textColor
  required property color backgroundColor
  required property color accentColor
  required property color urgentColor
  required property color dimColor
  required property string panelFontFamily
  property bool collapsed: false

  readonly property var groups: Sources.groupByAccount(
    controller ? controller.availableSources : null,
    controller && controller.service ? controller.service.accountSummaries : [])

  CalendarPalette {
    id: calendarPalette
    textColor: root.textColor
    accentColor: root.accentColor
    urgentColor: root.urgentColor
    dimColor: root.dimColor
  }

  contentWidth: width
  contentHeight: calendars.implicitHeight
  clip: true
  boundsBehavior: Flickable.StopAtBounds
  ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

  Column {
    id: calendars
    width: root.width
    spacing: root.collapsed ? Style.space(1) : Style.space(14)

    Item {
      width: parent.width
      height: Style.space(28)

      Text {
        visible: !root.collapsed
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        text: "CALENDARS"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        font.letterSpacing: 1
        textFormat: Text.PlainText
      }

      ActionIcon {
        visible: root.collapsed
        anchors.centerIn: parent
        name: "calendar"
        iconSize: Style.font.icon
        color: root.dimColor
      }
    }

    Repeater {
      model: root.groups

      delegate: Column {
        id: accountGroup
        required property var modelData
        width: calendars.width
        spacing: root.collapsed ? Style.space(1) : Style.space(4)

        Text {
          visible: !root.collapsed
          width: parent.width
          text: accountGroup.modelData.providerLabel
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          font.bold: true
          elide: Text.ElideRight
          textFormat: Text.PlainText
        }

        Text {
          visible: !root.collapsed
          width: parent.width
          text: accountGroup.modelData.accountLabel
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideMiddle
          textFormat: Text.PlainText
        }

        Repeater {
          model: accountGroup.modelData.calendars

          delegate: Column {
            id: calendarEntry
            required property var modelData
            readonly property color entryColor: calendarPalette.colorFor(modelData.colorKey)
            width: accountGroup.width
            spacing: root.collapsed ? 0 : Style.space(4)

            Rectangle {
              id: calendarRow
              width: parent.width
              height: Style.space(28)
              radius: Style.cornerRadius
              color: rowHover.hovered
                ? Style.hoverFillFor(root.textColor, root.accentColor) : "transparent"

              Rectangle {
                id: checkBox
                x: root.collapsed ? Math.round((parent.width - width) / 2) : 0
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(14)
                height: width
                radius: Style.cornerRadius
                color: calendarEntry.modelData.enabled
                  ? Style.selectedFillFor(root.textColor, calendarEntry.entryColor) : "transparent"
                border.width: 1
                border.color: calendarEntry.entryColor

                ActionIcon {
                  anchors.centerIn: parent
                  visible: calendarEntry.modelData.enabled
                  name: "check"
                  iconSize: Style.space(9)
                  strokeScale: 1.1
                  color: calendarEntry.entryColor
                }
              }

              Text {
                visible: !root.collapsed
                anchors.left: checkBox.right
                anchors.leftMargin: Style.space(7)
                anchors.right: colorButton.left
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                text: String(calendarEntry.modelData.name || calendarEntry.modelData.id || "Calendar")
                color: calendarEntry.modelData.enabled ? root.textColor : root.dimColor
                font.family: root.panelFontFamily
                font.pixelSize: Style.font.caption
                elide: Text.ElideRight
                textFormat: Text.PlainText
              }

              Item {
                id: colorButton
                visible: !root.collapsed
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(28)
                height: width

                Rectangle {
                  anchors.centerIn: parent
                  width: Style.space(14)
                  height: width
                  radius: width / 2
                  color: calendarEntry.entryColor
                  border.width: colorPicker.opened ? 2 : 1
                  border.color: colorPicker.opened
                    ? root.textColor : root.backgroundColor
                }

                MouseArea {
                  anchors.fill: parent
                  cursorShape: Qt.PointingHandCursor
                  onClicked: colorPicker.opened ? colorPicker.close() : colorPicker.open()
                }
              }

              Popup {
                id: colorPicker
                parent: colorButton.Window.window
                  ? colorButton.Window.window.contentItem : calendarRow
                property real anchorX: 0
                property real anchorY: 0
                x: anchorX
                y: anchorY
                padding: Style.space(8)
                implicitWidth: paletteChoices.implicitWidth + leftPadding + rightPadding
                implicitHeight: paletteChoices.implicitHeight + topPadding + bottomPadding
                closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside
                focus: true

                function reposition() {
                  if (!parent) return
                  var point = colorButton.mapToItem(parent, colorButton.width - implicitWidth,
                    colorButton.height + Style.space(5))
                  anchorX = Math.max(Style.space(8), Math.min(point.x,
                    parent.width - implicitWidth - Style.space(8)))
                  anchorY = Math.max(Style.space(8), Math.min(point.y,
                    parent.height - implicitHeight - Style.space(8)))
                }

                onOpened: reposition()

                background: Rectangle {
                  color: root.backgroundColor
                  radius: Style.cornerRadius
                  border.width: 1
                  border.color: Style.normalBorderFor(root.textColor, root.accentColor)
                }

                contentItem: Row {
                  id: paletteChoices
                  spacing: Style.space(7)

                  Repeater {
                    model: calendarPalette.slots

                    delegate: Rectangle {
                      id: popupColorChoice
                      required property string modelData
                      width: Style.space(20)
                      height: width
                      radius: width / 2
                      color: calendarPalette.colorFor(modelData)
                      border.width: calendarEntry.modelData.colorKey === modelData ? 2 : 1
                      border.color: calendarEntry.modelData.colorKey === modelData
                        ? root.textColor : root.backgroundColor

                      ActionIcon {
                        anchors.centerIn: parent
                        visible: calendarEntry.modelData.colorKey === popupColorChoice.modelData
                        name: "check"
                        iconSize: Style.space(10)
                        strokeScale: 1.2
                        color: root.backgroundColor
                      }

                      MouseArea {
                        anchors.fill: parent
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
                          if (root.controller) root.controller.setSourceColor(
                            String(calendarEntry.modelData.id), popupColorChoice.modelData)
                          colorPicker.close()
                        }
                      }
                    }
                  }
                }
              }

              HoverHandler { id: rowHover }
              MouseArea {
                anchors.left: parent.left
                anchors.top: parent.top
                anchors.bottom: parent.bottom
                anchors.right: colorButton.visible ? colorButton.left : parent.right
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                  if (root.controller) root.controller.setSourceEnabled(
                    String(calendarEntry.modelData.id), !calendarEntry.modelData.enabled)
                }
              }

              PanelToolTip {
                visible: root.collapsed && rowHover.hovered
                text: String(calendarEntry.modelData.name
                  || calendarEntry.modelData.id || "Calendar")
                fontFamily: root.panelFontFamily
              }
            }

          }
        }
      }
    }

    Text {
      visible: root.groups.length === 0
      width: parent.width
      text: "Add a calendar in Settings"
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
      textFormat: Text.PlainText
    }
  }
}
