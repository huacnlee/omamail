import QtQuick
import qs.Commons
import qs.Ui

// "Going?" and the three answers to an invitation, in the words the mail card has always used. The
// mail card and the calendar's detail draw the same row, so an invitation is answered in one way
// wherever it is opened; what an answer does is the owner of this row's business, not this row's.
Row {
  id: root

  // What has been answered, as one of "accepted", "tentative" and "declined", or empty for a guest who
  // has not answered rather than one who said no.
  property string response: ""
  property bool sending: false
  // What "No" reads: the mail card answers at once; the calendar asks first, so it says "No...".
  property string declineLabel: "No"

  required property color textColor
  required property color accentColor
  required property color dimColor
  required property string panelFontFamily

  signal answered(string answer)

  spacing: Style.space(6)

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
      { answer: "declined", label: root.declineLabel }
    ]

    IconTextButton {
      required property var modelData
      anchors.verticalCenter: parent.verticalCenter
      objectName: "rsvp-" + modelData.answer
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
      onClicked: root.answered(modelData.answer)
    }
  }
}
