import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons
import qs.Ui
import "../calendar/Calendar.js" as Calendar
import "../calendar/ExchangeEvents.js" as ExchangeEvents
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
      // An Exchange event says what deleting it is: an appointment, or an invitation declined (and so left).
      : root.source.kind === "exchange" ? ExchangeEvents.deleteKind(event) !== ""
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
  // What only an Exchange event brings: its organizer and reminder (read with the detail), and whether the owner
  // may answer it, with the three answers the mail card offers.
  readonly property bool isExchange: !!root.source && root.source.kind === "exchange"
  readonly property string organizerText: isExchange && ExchangeEvents.organizerShown(event, root.source.accountId)
    ? String(event.organizer.displayName || event.organizer.email || "") : ""
  readonly property string reminderText: isExchange && event ? ExchangeEvents.reminderText(event.reminderMinutes) : ""
  readonly property bool canAnswer: isExchange && !!event && event.canRespond === true
  // An answer, a decline or any other change on its way: the controller sends no answer beside one.
  readonly property bool answering: !!root.controller && (root.controller.responding === true
    || root.controller.eventWriting === true || root.controller.creatingEvent === true)
  // Said only when it is certain; a doubt is said as one (`ExchangeEvents.withDetail`).
  readonly property string cancelledText: !isExchange || !event ? ""
    : event.cancelledByOrganizer === true ? "The organizer cancelled this meeting."
    : event.cancellationUnplaced === true ? "An event of this meeting was cancelled; answer it in Outlook." : ""
  readonly property bool answerSent: isExchange && !!event && !!root.controller
    && String(root.controller.answeredKey || "") !== ""
    && root.controller.answeredKey === ExchangeEvents.stableKey(event)
  readonly property string deleteLabel: isExchange && ExchangeEvents.deleteKind(event) === "decline"
    ? (event.exchangeKind === "single" ? "Decline and remove..." : "Decline...") : "Delete..."

  color: root.backgroundColor

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

  Flickable {
    id: detailFlick

    WheelScroller { view: detailFlick }

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

      CalendarReminderPanel {
        width: parent.width
        service: root.controller ? root.controller.service : null
        eventKey: root.event ? String(root.event.sourceId || "") + "\n" + String(root.event.googleId || root.event.exchangeId || root.event.uid || "") : ""
        textColor: root.textColor
        dimColor: root.dimColor
        accentColor: root.accentColor
        urgentColor: root.urgentColor
        panelFontFamily: root.panelFontFamily
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

      Flow {
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
        IconTextButton {
          visible: root.canWrite
          text: "Edit..."
          iconName: "edit"
          foreground: root.textColor
          accent: root.eventColor
          fontFamily: root.panelFontFamily
          onClicked: root.editRequested(String(root.event.sourceId || ""), root.event)
        }
      }

      RsvpRow {
        objectName: "event-rsvp"
        visible: root.canAnswer
        response: root.canAnswer ? ExchangeEvents.answerOf(root.event.myResponse) : ""
        sending: root.answering
        declineLabel: "No..."
        textColor: root.textColor
        accentColor: root.accentColor
        dimColor: root.dimColor
        panelFontFamily: root.panelFontFamily
        onAnswered: function(answer) {
          if (!root.controller) return
          // No also takes the meeting off the calendar and tells the organizer: it asks first.
          if (answer === "declined") root.deleteRequested(String(root.event.sourceId || ""), root.event)
          else root.controller.respondToInvitation(String(root.event.sourceId || ""), root.event, answer)
        }
      }

      Text {
        objectName: "event-cancelled"
        width: parent.width
        visible: root.cancelledText !== ""
        text: root.cancelledText
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.body
      }

      Text {
        objectName: "event-answer-sent"
        width: parent.width
        visible: root.answerSent
        text: "Your answer was sent to the organizer"
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
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

      Row {
        objectName: "event-organizer"
        visible: root.organizerText !== ""
        width: parent.width
        spacing: Style.space(8)

        ActionIcon {
          anchors.verticalCenter: parent.verticalCenter
          name: "people"
          iconSize: Style.font.icon
          color: root.dimColor
        }

        Text {
          width: parent.width - Style.space(28)
          text: "Organizer · " + root.organizerText
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WrapAnywhere
          textFormat: Text.PlainText
        }
      }

      Text {
        objectName: "event-reminder"
        width: parent.width
        visible: root.reminderText !== ""
        text: "Reminder · " + root.reminderText
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
      }

      Text {
        width: parent.width
        visible: root.refreshing || root.refreshError !== ""
        text: root.refreshing ? "Refreshing event details..." : root.refreshError
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: root.refreshError !== "" ? root.urgentColor : root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      Column {
        width: parent.width
        spacing: Style.space(6)
        visible: root.meetingLink !== ""
        Text {
          text: "Meeting link"
          textFormat: Text.PlainText
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

      Text {
        objectName: "event-lock-reason"
        width: parent.width
        visible: !!root.event && String(root.event.lockReason || "") !== ""
        text: String(root.event && root.event.lockReason || "")
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.body
      }

      Text {
        width: parent.width
        visible: !!root.event && root.event.eventType === "fromGmail"
        text: "Created automatically from Gmail. Google does not allow apps to change its time or event details."
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.body
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

      Text {
        objectName: "event-notes-cut"
        width: parent.width
        visible: !!root.event && root.event.notesCut === true
        text: "Only the start of the notes is shown"
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      Column {
        width: parent.width
        spacing: Style.space(8)
        visible: attendeeList.count > 0
        Text {
          text: "Guests · " + attendeeList.count
          textFormat: Text.PlainText
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
                Text {
                  width: parent.width
                  text: modelData.name + (modelData.self ? " (you)" : "")
                  textFormat: Text.PlainText
                  wrapMode: Text.Wrap
                  color: root.textColor
                  font.family: root.panelFontFamily
                  font.pixelSize: Style.font.bodySmall
                }
                Text {
                  width: parent.width
                  text: modelData.label + (modelData.optional ? " · Optional" : "")
                    + (modelData.resource ? " · Resource" : "")
                    + (modelData.email && modelData.email !== modelData.name ? " · " + modelData.email : "")
                  textFormat: Text.PlainText
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

      Text {
        width: parent.width
        visible: root.conferenceStatus === "pending" || root.conferenceStatus === "failure"
        text: root.conferenceStatus === "pending" ? "Google Meet is being created. Refresh to check its status."
          : "The event was saved, but Google Meet could not be created."
        textFormat: Text.PlainText
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
          text: root.deleteLabel
          // A decline is an answer: not while another is on its way.
          enabled: !(root.answering && ExchangeEvents.deleteKind(root.event) === "decline")
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
