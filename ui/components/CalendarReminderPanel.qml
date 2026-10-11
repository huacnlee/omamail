import QtQuick
import QtQuick.Controls
import qs.Commons

Column {
  id: root
  required property var service
  required property color textColor
  required property color dimColor
  required property color accentColor
  required property color urgentColor
  required property string panelFontFamily
  property string eventKey: ""
  readonly property var reminders: service && service.calendarReminderInbox
    ? service.calendarReminderInbox : null
  readonly property var records: reminders ? reminders.records.filter(function(record) {
    return root.eventKey === "" || record.sourceId + "\n" + record.eventId === root.eventKey
  }) : []
  visible: records.length > 0
  spacing: Style.space(6)

  Text {
    text: "Reminders"
    textFormat: Text.PlainText
    color: root.textColor
    font.family: root.panelFontFamily
    font.bold: true
    font.pixelSize: Style.font.bodySmall
  }
  Flickable {
    id: reminderScroll
    width: parent.width
    height: Math.min(entries.implicitHeight, Style.space(180))
    contentHeight: entries.implicitHeight
    contentWidth: width
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    ScrollBar.vertical: ScrollBar {}
    WheelScroller { view: reminderScroll }
    Column {
      id: entries
      width: parent.width
      spacing: Style.space(6)
      Repeater {
        model: root.records
        delegate: Rectangle {
          id: entry
          required property var modelData
          width: parent.width
          height: entryContent.implicitHeight + Style.space(16)
          color: Qt.alpha(root.accentColor, 0.08)
          readonly property bool pending: root.reminders.pendingKeys.indexOf(modelData.key) >= 0
          Column {
            id: entryContent
            x: Style.space(8)
            y: Style.space(8)
            width: parent.width - Style.space(16)
            spacing: Style.space(6)
            Text {
              width: parent.width
              text: String(entry.modelData.title || "Event") + " · "
                + Qt.formatDateTime(new Date(entry.modelData.start), "ddd HH:mm")
              textFormat: Text.PlainText
              wrapMode: Text.Wrap
              color: root.textColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.bodySmall
            }
            Flow {
              width: parent.width
              spacing: Style.space(6)
              IconTextButton {
                visible: root.eventKey === ""
                text: "Open event..."
                foreground: root.textColor
                accent: root.accentColor
                fontFamily: root.panelFontFamily
                onClicked: root.reminders.open(entry.modelData)
              }
              IconTextButton {
                objectName: "calendar-reminder-snooze"
                text: "Snooze " + root.service.calendarSnoozeMinutes + " min"
                foreground: root.textColor
                accent: root.accentColor
                fontFamily: root.panelFontFamily
                enabled: !entry.pending
                onClicked: root.reminders.action(entry.modelData.key, "snooze", entry.modelData.noticeId)
              }
              IconTextButton {
                objectName: "calendar-reminder-dismiss"
                text: "Dismiss"
                foreground: root.textColor
                accent: root.accentColor
                fontFamily: root.panelFontFamily
                enabled: !entry.pending
                onClicked: root.reminders.action(entry.modelData.key, "dismiss", entry.modelData.noticeId)
              }
            }
          }
        }
      }
    }
  }
  Text {
    width: parent.width
    visible: text !== ""
    text: root.reminders ? root.reminders.lastError : ""
    color: root.urgentColor
    textFormat: Text.PlainText
    wrapMode: Text.Wrap
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
  }
}
