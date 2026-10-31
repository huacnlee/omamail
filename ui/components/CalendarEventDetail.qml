import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons
import qs.Ui
import "../calendar/Calendar.js" as Calendar
import "../message/Html.js" as Html

Rectangle {
  id: root
  readonly property string timeFormat: Qt.locale().timeFormat(Locale.ShortFormat)

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
  property bool refreshing: false
  property string refreshError: ""
  property bool meetingLinkCopied: false
  onMeetingLinkChanged: { meetingLinkCopied = false; copiedFeedback.stop() }
  Timer {
    id: copiedFeedback
    interval: 2000
    onTriggered: root.meetingLinkCopied = false
  }
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
  readonly property bool canDelete: !!root.source && !!event
    && root.source.readOnly !== true
    && (root.source.kind === "google" ? String(event.googleId || "") !== ""
      : root.source.kind === "microsoft" ? String(event.graphId || "") !== ""
      : String(event.href || "") !== "" && String(event.recurrenceRule || "") === ""
        && Number(event.recurrenceIdMs || 0) <= 0
        && String(event.source && event.source.recurrenceId || "") === ""
        && Calendar.caldavEventUrl(root.source.url, event) !== "")
  readonly property bool canWrite: canDelete && Calendar.writeRefusal(source, event) === ""
  readonly property color eventColor: calendarPalette.colorFor(
    source ? source.colorKey : "accent")
  readonly property string meetingLink: httpLink(event ? event.meetLink : "")
  readonly property string conferenceStatus: String(event && event.conferenceData
    && event.conferenceData.createRequest && event.conferenceData.createRequest.status
    ? event.conferenceData.createRequest.status.statusCode || "" : "")
  readonly property string locationLink: httpLink(event ? event.location : "")
  // The location as written. One that is not a link is a place, and a place
  // is something to copy into a message or to look up on a map.
  readonly property string locationText: String(event && event.location || "").trim()
  readonly property bool locationIsPlace: locationText !== "" && locationLink === ""
  readonly property string mapLink: locationIsPlace
    ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(locationText) : ""
  readonly property string providerLink: httpLink(event ? event.href : "")

  color: root.backgroundColor

  // A preview is read-only, but its text must still be available to copy,
  // including on calendars where the owner cannot open the event editor.
  component DetailText: TextEdit {
    readOnly: true
    selectByMouse: true
    textFormat: TextEdit.PlainText
    selectionColor: Style.selectionFillFor(root.textColor, root.accentColor)
    selectedTextColor: color
  }

  function httpLink(value) {
    return Html.externallyOpenableHttpUrl(value)
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
      return startDay + " · " + Calendar.timeRangeLabel(start.getTime(), end.getTime(), root.timeFormat)
    return startDay + " · " + Calendar.timeLabel(start.getTime(), root.timeFormat) + " – "
      + Calendar.dateTimeLabel(end.getTime(), "dddd, d MMMM yyyy", root.timeFormat, " · ")
  }

  CalendarPalette {
    id: calendarPalette
    palettePath: root.controller && root.controller.service
      ? String(root.controller.service.calendarPalettePath || "") : ""
    textColor: root.textColor
    accentColor: root.accentColor
    urgentColor: root.urgentColor
    dimColor: root.dimColor
  }

  Item {
    id: detailHeader
    objectName: "event-detail-header"
    anchors.top: parent.top
    anchors.topMargin: Style.space(18)
    anchors.horizontalCenter: parent.horizontalCenter
    width: Math.min(parent.width - Style.space(36), Style.space(720))
    height: Math.max(backBar.implicitHeight, editButton.visible ? editButton.implicitHeight : 0)

    BackBar {
      id: backBar
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      label: "Calendar"
      textColor: root.textColor
      dimColor: root.dimColor
      panelFontFamily: root.panelFontFamily
      onActivated: root.closed()
    }

    IconTextButton {
      id: editButton
      objectName: "event-edit-button"
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      visible: root.canWrite
      text: "Edit..."
      iconName: "edit"
      foreground: root.textColor
      accent: root.eventColor
      fontFamily: root.panelFontFamily
      onClicked: root.editRequested(String(root.event.sourceId || ""), root.event)
    }
  }

  Flickable {
    id: detailFlick
    objectName: "event-detail-scroll"

    WheelScroller { view: detailFlick }

    anchors.top: detailHeader.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: parent.bottom
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

      CalendarReminderPanel {
        width: parent.width
        service: root.controller ? root.controller.service : null
        eventKey: root.event ? String(root.event.sourceId || "") + "\n" + String(root.event.googleId || root.event.uid || "") : ""
        textColor: root.textColor
        dimColor: root.dimColor
        accentColor: root.accentColor
        urgentColor: root.urgentColor
        panelFontFamily: root.panelFontFamily
      }

      DetailText {
        objectName: "event-title-text"
        width: parent.width
        text: String(root.event && root.event.summary || "Untitled event")
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.title
        font.bold: true
        wrapMode: Text.WordWrap
      }

      DetailText {
        objectName: "event-date-text"
        width: parent.width
        text: root.dateSummary()
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.body
        wrapMode: Text.WordWrap
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

        DetailText {
          objectName: "event-calendar-text"
          anchors.verticalCenter: parent.verticalCenter
          width: parent.width - Style.space(18)
          text: root.source
            ? String(root.source.name || root.source.id || "Calendar") : "Calendar"
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.Wrap
        }
      }

      Flow {
        visible: root.meetingLink !== ""
        width: parent.width
        spacing: Style.space(8)
        IconTextButton {
          visible: root.meetingLink !== ""
          text: "Join meeting..."
          iconName: "video"
          foreground: root.textColor
          accent: root.eventColor
          fontFamily: root.panelFontFamily
          onClicked: if (root.controller) root.controller.openExternal(root.meetingLink)
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

        DetailText {
          objectName: "event-location-text"
          width: parent.width - Style.space(28)
          text: String(root.event && root.event.location || "")
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WrapAnywhere
        }
      }

      DetailText {
        width: parent.width
        visible: root.refreshing || root.refreshError !== ""
        text: root.refreshing ? "Refreshing event details..." : root.refreshError
        wrapMode: Text.Wrap
        color: root.refreshError !== "" ? root.urgentColor : root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      Column {
        width: parent.width
        spacing: Style.space(6)
        visible: root.meetingLink !== ""
        DetailText {
          text: "Meeting link"
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
        }
        Row {
          width: parent.width
          spacing: Style.space(10)
          AbstractButton {
            objectName: "event-meeting-link"
            width: Math.max(0, Math.min(contentItem.implicitWidth,
              parent.width - copyMeetingLink.width - copiedLabel.width - parent.spacing * 2))
            implicitHeight: Math.max(contentItem.implicitHeight, copyMeetingLink.height)
            text: root.meetingLink
            Accessible.role: Accessible.Link
            Accessible.name: root.meetingLink
            contentItem: Text {
              text: root.meetingLink
              textFormat: Text.PlainText
              wrapMode: Text.WrapAnywhere
              verticalAlignment: Text.AlignVCenter
              color: root.accentColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.body
              font.underline: true
            }
            onClicked: if (root.controller) root.controller.openExternal(root.meetingLink)
            HoverHandler { cursorShape: Qt.PointingHandCursor }
          }
          IconButton {
            id: copyMeetingLink
            objectName: "event-copy-meeting-link"
            iconName: root.meetingLinkCopied ? "check" : "copy"
            tooltipText: root.meetingLinkCopied ? "Copied" : "Copy meeting link"
            foreground: root.meetingLinkCopied ? root.accentColor : root.dimColor
            hoverColor: root.textColor
            fontFamily: root.panelFontFamily
            onClicked: {
              if (root.controller && root.controller.copyText(root.meetingLink)) {
                root.meetingLinkCopied = true
                copiedFeedback.restart()
              }
            }
          }
          Text {
            id: copiedLabel
            anchors.verticalCenter: parent.verticalCenter
            text: "Copied"
            opacity: root.meetingLinkCopied ? 1 : 0
            textFormat: Text.PlainText
            color: root.accentColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
          }
        }
      }

      DetailText {
        width: parent.width
        visible: !!root.event && root.event.eventType === "fromGmail"
        text: "Created automatically from Gmail. Google does not allow apps to change its time or event details."
        wrapMode: Text.Wrap
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.body
      }

      DetailText {
        objectName: "event-description-text"
        visible: String(root.event && root.event.description || "") !== ""
        width: parent.width
        text: String(root.event && root.event.description || "")
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.body
        wrapMode: Text.Wrap
      }

      Column {
        width: parent.width
        spacing: Style.space(8)
        visible: attendeeList.count > 0
        DetailText {
          text: "Guests · " + attendeeList.count
          color: root.textColor
          font.family: root.panelFontFamily
          font.bold: true
          font.pixelSize: Style.font.body
        }
        Repeater {
          id: attendeeList
          model: Calendar.attendeeRows(root.event)
          delegate: Rectangle {
            required property var modelData
            width: parent.width
            height: guestInfo.implicitHeight + Style.space(16)
            radius: Style.cornerRadius
            color: Qt.alpha(root.textColor, 0.04)
            Row {
              id: guestInfo
              x: Style.space(10)
              y: Style.space(8)
              width: parent.width - Style.space(20)
              spacing: Style.space(10)
              Text {
                width: Style.space(20)
                text: modelData.symbol
                textFormat: Text.PlainText
                color: root.textColor
                font.family: root.panelFontFamily
                font.pixelSize: Style.font.body
              }
              Column {
                width: parent.width - Style.space(30)
                spacing: Style.space(3)
                DetailText {
                  width: parent.width
                  text: modelData.name + (modelData.self ? " (you)" : "")
                  wrapMode: Text.Wrap
                  color: root.textColor
                  font.family: root.panelFontFamily
                  font.pixelSize: Style.font.bodySmall
                }
                DetailText {
                  width: parent.width
                  text: modelData.label + (modelData.optional ? " · Optional" : "")
                    + (modelData.email && modelData.email !== modelData.name ? " · " + modelData.email : "")
                  wrapMode: Text.Wrap
                  color: root.dimColor
                  font.family: root.panelFontFamily
                  font.pixelSize: Style.font.caption
                }
              }
            }
          }
        }
      }

      DetailText {
        width: parent.width
        visible: root.conferenceStatus === "pending" || root.conferenceStatus === "failure"
        text: root.conferenceStatus === "pending" ? "Google Meet is being created. Refresh to check its status."
          : "The event was saved, but Google Meet could not be created."
        wrapMode: Text.Wrap
        color: root.dimColor
        font.family: root.panelFontFamily
      }

      Flow {
        visible: root.meetingLink !== "" || root.locationLink !== ""
           || root.providerLink !== "" || root.canDelete || root.locationText !== ""
        width: parent.width
        spacing: Style.space(7)

        IconTextButton {
          visible: root.locationLink !== "" && root.locationLink !== root.meetingLink
          text: "Open location"
          iconName: "pin"
          foreground: root.textColor
          accent: root.eventColor
          fontFamily: root.panelFontFamily
          onClicked: if (root.controller) root.controller.openExternal(root.locationLink)
        }

        IconTextButton {
          objectName: "event-open-map"
          visible: root.locationIsPlace
          text: "Open in Google Maps"
          iconName: "pin"
          foreground: root.textColor
          accent: root.eventColor
          fontFamily: root.panelFontFamily
          onClicked: if (root.controller) root.controller.openExternal(root.mapLink)
        }

        IconTextButton {
          objectName: "event-copy-location"
          visible: root.locationText !== ""
          text: "Copy location"
          iconName: "copy"
          foreground: root.textColor
          accent: root.eventColor
          fontFamily: root.panelFontFamily
          onClicked: if (root.controller) root.controller.copyText(root.locationText)
        }

        IconTextButton {
          visible: root.providerLink !== "" && root.providerLink !== root.meetingLink
            && root.providerLink !== root.locationLink
          text: "Open in provider"
          iconName: "browser"
          foreground: root.textColor
          accent: root.eventColor
          fontFamily: root.panelFontFamily
          onClicked: if (root.controller) root.controller.openExternal(root.providerLink)
        }

        // One quiet trigger; which delete — telling guests or not, one
        // occurrence or the series — is chosen in the confirmation, where the
        // event is named.
        IconTextButton {
          visible: root.canDelete
          objectName: "event-delete"
          text: "Delete..."
          iconName: "trash"
          foreground: root.textColor
          accent: root.urgentColor
          fontFamily: root.panelFontFamily
          onClicked: root.deleteRequested(String(root.event.sourceId || ""), root.event)
        }
      }
    }
  }
}
