import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "../calendar/Calendar.js" as Calendar

Rectangle {
  id: root

  required property var controller
  required property var event
  required property color textColor
  required property color backgroundColor
  required property color accentColor
  required property color urgentColor
  required property color dimColor
  required property string panelFontFamily

  signal closed()
  signal editRequested(string sourceId, var event)
  signal deleteRequested(string sourceId, var event)

  readonly property var source: {
    var sources = controller && controller.availableSources
      ? controller.availableSources.sources : []
    var sourceId = String(event && event.sourceId || "")
    for (var i = 0; i < sources.length; i++) {
      if (String(sources[i].id || "") === sourceId) return sources[i]
    }
    return null
  }
  // The button rule: an operation that cannot really run is not drawn. A
  // read-only calendar draws neither button. Google writes against the item
  // id; CalDAV against the event's href, a recurring one is one ICS with
  // state this panel does not re-serialize — and a modified occurrence
  // carries only a RECURRENCE-ID, but its href is the series' shared file —
  // and an href that resolves outside the source's own origin is refused by
  // the same rule the controller applies before any credential is read.
  readonly property bool canWrite: !!root.source && !!event
    && root.source.readOnly !== true
    && (root.source.kind === "google"
      ? String(event.googleId || "") !== ""
      : String(event.href || "") !== "" && String(event.recurrenceRule || "") === ""
        && Number(event.recurrenceIdMs || 0) <= 0
        && String(event.source && event.source.recurrenceId || "") === ""
        && Calendar.caldavEventUrl(root.source.url, event) !== "")
  readonly property color eventColor: calendarPalette.colorFor(
    source ? source.colorKey : "accent")
  readonly property string meetingLink: httpLink(event ? event.meetLink : "")
  readonly property string locationLink: httpLink(event ? event.location : "")
  readonly property string providerLink: httpLink(event ? event.href : "")

  color: root.backgroundColor

  function httpLink(value) {
    var candidate = String(value || "").trim()
    return /^https?:\/\//i.test(candidate) ? candidate : ""
  }

  function dateSummary() {
    if (!event || !event.start) return ""
    var start = new Date(Number(event.start.ms || 0))
    var end = event.end ? new Date(Number(event.end.ms || event.start.ms || 0)) : start
    if (event.start.allDay) {
      var inclusiveEnd = new Date(Math.max(start.getTime(), end.getTime() - 1))
      if (start.toDateString() === inclusiveEnd.toDateString())
        return Qt.formatDate(start, "dddd, d MMMM yyyy") + " · All day"
      return Qt.formatDate(start, "d MMMM yyyy") + " – "
        + Qt.formatDate(inclusiveEnd, "d MMMM yyyy") + " · All day"
    }
    var startDay = Qt.formatDate(start, "dddd, d MMMM yyyy")
    if (start.toDateString() === end.toDateString())
      return startDay + " · " + Qt.formatTime(start, "HH:mm") + "–"
        + Qt.formatTime(end, "HH:mm")
    return startDay + " · " + Qt.formatTime(start, "HH:mm") + " – "
      + Qt.formatDate(end, "dddd, d MMMM yyyy") + " · " + Qt.formatTime(end, "HH:mm")
  }

  CalendarPalette {
    id: calendarPalette
    textColor: root.textColor
    accentColor: root.accentColor
    urgentColor: root.urgentColor
    dimColor: root.dimColor
  }

  Flickable {
    anchors.fill: parent
    anchors.margins: Style.space(18)
    contentWidth: width
    contentHeight: content.implicitHeight + Style.space(18)
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

    Column {
      id: content
      anchors.horizontalCenter: parent.horizontalCenter
      width: Math.min(parent.width, Style.space(720))
      spacing: Style.space(14)

      BackBar {
        label: "Calendar"
        textColor: root.textColor
        dimColor: root.dimColor
        panelFontFamily: root.panelFontFamily
        onActivated: root.closed()
      }

      Rectangle {
        width: parent.width
        height: Style.space(4)
        radius: height / 2
        color: root.eventColor
      }

      Text {
        width: parent.width
        text: String(root.event && root.event.summary || "Untitled event")
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.title
        font.bold: true
        wrapMode: Text.WordWrap
        textFormat: Text.PlainText
      }

      Text {
        width: parent.width
        text: root.dateSummary()
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.body
        wrapMode: Text.WordWrap
        textFormat: Text.PlainText
      }

      Row {
        width: parent.width
        spacing: Style.space(8)

        Rectangle {
          anchors.verticalCenter: parent.verticalCenter
          width: Style.space(10)
          height: width
          radius: width / 2
          color: root.eventColor
        }

        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: root.source
            ? String(root.source.name || root.source.id || "Calendar") : "Calendar"
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          textFormat: Text.PlainText
        }
      }

      Row {
        visible: String(root.event && root.event.location || "") !== ""
        width: parent.width
        spacing: Style.space(8)

        ActionIcon {
          anchors.verticalCenter: parent.verticalCenter
          name: "pin"
          iconSize: Style.font.icon
          color: root.dimColor
        }

        Text {
          width: parent.width - Style.space(28)
          text: String(root.event && root.event.location || "")
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WrapAnywhere
          textFormat: Text.PlainText
        }
      }

      Flow {
        visible: root.meetingLink !== "" || root.locationLink !== ""
          || root.providerLink !== "" || root.canWrite
        width: parent.width
        spacing: Style.space(7)

        IconTextButton {
          visible: root.canWrite
          text: "Edit..."
          iconName: "compose"
          foreground: root.textColor
          accent: root.eventColor
          fontFamily: root.panelFontFamily
          onClicked: root.editRequested(String(root.event.sourceId || ""), root.event)
        }

        IconTextButton {
          visible: root.canWrite
          text: "Delete..."
          iconName: "trash"
          foreground: root.urgentColor
          accent: root.urgentColor
          fontFamily: root.panelFontFamily
          onClicked: root.deleteRequested(String(root.event.sourceId || ""), root.event)
        }

        IconTextButton {
          visible: root.meetingLink !== ""
          text: "Join call"
          iconName: "video"
          foreground: root.textColor
          accent: root.eventColor
          fontFamily: root.panelFontFamily
          onClicked: Qt.openUrlExternally(root.meetingLink)
        }

        IconTextButton {
          visible: root.locationLink !== "" && root.locationLink !== root.meetingLink
          text: "Open location"
          iconName: "pin"
          foreground: root.textColor
          accent: root.eventColor
          fontFamily: root.panelFontFamily
          onClicked: Qt.openUrlExternally(root.locationLink)
        }

        IconTextButton {
          visible: root.providerLink !== "" && root.providerLink !== root.meetingLink
            && root.providerLink !== root.locationLink
          text: "Open in provider"
          iconName: "browser"
          foreground: root.textColor
          accent: root.eventColor
          fontFamily: root.panelFontFamily
          onClicked: Qt.openUrlExternally(root.providerLink)
        }
      }

      PanelSeparator {
        visible: String(root.event && root.event.description || "") !== ""
        width: parent.width
        foreground: root.textColor
      }

      Text {
        visible: String(root.event && root.event.description || "") !== ""
        width: parent.width
        text: String(root.event && root.event.description || "")
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.body
        lineHeight: 1.35
        wrapMode: Text.Wrap
        textFormat: Text.PlainText
      }
    }
  }
}
