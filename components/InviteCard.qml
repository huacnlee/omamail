import QtQuick
import qs.Commons
import qs.Ui
import "../message/Calendar.js" as Calendar

// The meeting inside the message, drawn as the thing it is.
//
// A Google Calendar invitation reads badly as mail: the HTML part is a table
// of the same facts laid out for a browser, and the times in it are the
// organiser's, in the organiser's words. This is those facts read out of the
// `text/calendar` part instead — one clock, the reader's own — with the three
// buttons that answer it.
//
// It scrolls with the body rather than sitting above it. A recurring meeting
// with a dozen guests is taller than the panel, and pinning it would leave the
// message with nowhere to be.
Rectangle {
  id: root

  // The parsed invitation, or null. Everything here is derived from it, so a
  // message with none draws nothing and takes no height.
  property var invite: null
  // What this account has answered, as one of "accepted", "tentative" and
  // "declined" — or empty, which is a guest who has not answered rather than
  // one who said no.
  property string response: ""
  property bool canRespond: false
  property bool sending: false

  required property color textColor
  required property color accentColor
  required property color dimColor
  required property color dimmerColor
  required property string panelFontFamily

  signal respondRequested(string answer)
  signal openRequested(string url)

  readonly property bool cancelled: !!invite
    && (invite.method === "CANCEL" || String(invite.status || "") === "CANCELLED")

  visible: !!invite
  implicitHeight: visible ? column.implicitHeight + Style.space(24) : 0
  radius: Style.cornerRadius
  color: Style.normalFillFor(root.textColor, root.accentColor)
  border.width: 1
  border.color: Style.normalBorderFor(root.textColor, root.accentColor)

  Column {
    id: column
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.margins: Style.space(12)
    spacing: Style.space(6)

    // ------------------------------------------------------------ heading

    Row {
      spacing: Style.space(6)

      ActionIcon {
        anchors.verticalCenter: parent.verticalCenter
        name: "calendar"
        iconSize: Style.font.iconSmall
        color: root.dimColor
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: root.invite ? Calendar.headline(root.invite) : ""
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }
    }

    // The organiser wrote this. Qt's AutoText would promote a summary with a
    // tag in it to rich text, and rich text with an <img> in it is a fetch.
    Text {
      width: parent.width
      textFormat: Text.PlainText
      text: root.invite ? String(root.invite.summary || "(no title)") : ""
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.body
      font.bold: true
      // A cancelled meeting keeps its name legible rather than striking it
      // through: the heading above already says what happened, and struck text
      // at this size is hard to read on half the themes.
      wrapMode: Text.WordWrap
    }

    Text {
      width: parent.width
      textFormat: Text.PlainText
      text: {
        if (!root.invite) return ""
        var when = Calendar.formatWhen(root.invite)
        var span = Calendar.formatDuration(root.invite)
        return span === "" ? when : when + " · " + span
      }
      visible: text !== ""
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      wrapMode: Text.WordWrap
    }

    Text {
      width: parent.width
      textFormat: Text.PlainText
      text: root.invite ? String(root.invite.recurrence || "") : ""
      visible: text !== ""
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }

    // --------------------------------------------------------------- where

    Item { width: 1; height: Style.space(2); visible: whereRow.visible }

    Row {
      id: whereRow
      width: parent.width
      spacing: Style.space(6)
      visible: !!root.invite && String(root.invite.location || "") !== ""

      ActionIcon {
        anchors.verticalCenter: parent.verticalCenter
        name: "pin"
        iconSize: Style.font.iconSmall
        color: root.dimmerColor
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        width: parent.width - Style.font.iconSmall - Style.space(6)
        textFormat: Text.PlainText
        text: root.invite ? String(root.invite.location || "") : ""
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
      }
    }

    // -------------------------------------------------------------- people

    Row {
      width: parent.width
      spacing: Style.space(6)
      visible: !!root.invite && !!root.invite.organizer
        && String(root.invite.organizer.email || "") !== ""

      ActionIcon {
        anchors.verticalCenter: parent.verticalCenter
        name: "people"
        iconSize: Style.font.iconSmall
        color: root.dimmerColor
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        width: parent.width - Style.font.iconSmall - Style.space(6)
        textFormat: Text.PlainText
        text: {
          if (!root.invite || !root.invite.organizer) return ""
          var host = String(root.invite.organizer.name || root.invite.organizer.email)
          var guests = Calendar.attendeeSummary(root.invite)
          return guests === "" ? host : host + " · " + guests
        }
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
      }
    }

    // Six of them, and then a count. A meeting with forty guests would
    // otherwise be a card longer than the message it came in.
    Column {
      width: parent.width
      spacing: Style.space(2)
      visible: guests.count > 0

      Repeater {
        id: guests
        model: {
          if (!root.invite) return []
          var list = root.invite.attendees || []
          return list.length > 6 ? list.slice(0, 6) : list
        }

        Text {
          required property var modelData
          width: parent.width
          leftPadding: Style.font.iconSmall + Style.space(6)
          textFormat: Text.PlainText
          text: String(modelData.name || modelData.email) + " — "
            + Calendar.partstatLabel(modelData.partstat)
            + (modelData.optional ? " (optional)" : "")
          color: root.dimmerColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }
    }

    Text {
      width: parent.width
      leftPadding: Style.font.iconSmall + Style.space(6)
      visible: !!root.invite && (root.invite.attendees || []).length > 6
      text: root.invite
        ? "and " + ((root.invite.attendees || []).length - 6) + " more"
        : ""
      color: root.dimmerColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
    }

    // --------------------------------------------------------------- join

    Item { width: 1; height: Style.space(4); visible: joinButton.visible || rsvpRow.visible }

    IconTextButton {
      id: joinButton
      visible: !!root.invite && String(root.invite.meetLink || "") !== "" && !root.cancelled
      iconName: "video"
      // A browser opens, so the label says so before it is pressed.
      text: root.invite && String(root.invite.meetLink || "").indexOf("meet.google.com") > 0
        ? "Join with Google Meet..."
        : "Join the call..."
      foreground: root.textColor
      accent: root.accentColor
      fontFamily: root.panelFontFamily
      fontSize: Style.font.caption
      onClicked: if (root.invite) root.openRequested(String(root.invite.meetLink || ""))
    }

    // --------------------------------------------------------------- RSVP

    Row {
      id: rsvpRow
      spacing: Style.space(6)
      visible: root.canRespond

      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: "Going?"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      Repeater {
        model: [
          { answer: "accepted", label: "Yes" },
          { answer: "tentative", label: "Maybe" },
          { answer: "declined", label: "No" }
        ]

        IconTextButton {
          required property var modelData
          anchors.verticalCenter: parent.verticalCenter
          enabled: !root.sending
          selected: root.response === modelData.answer
          // The fill alone must never carry this: a theme can put the selected
          // colour close enough to the normal one to say nothing at all.
          iconName: root.response === modelData.answer ? "check" : ""
          text: modelData.label
          foreground: root.textColor
          accent: root.accentColor
          fontFamily: root.panelFontFamily
          fontSize: Style.font.caption
          onClicked: root.respondRequested(modelData.answer)
        }
      }
    }

    // What was answered, where there is no answering to be done — somebody
    // else's reply, a cancelled meeting, an invitation this account is the
    // organiser of.
    Text {
      width: parent.width
      visible: !root.canRespond && root.response !== ""
      textFormat: Text.PlainText
      text: root.response === "accepted" ? "You are going"
        : (root.response === "declined" ? "You are not going" : "You might be going")
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
    }
  }
}
