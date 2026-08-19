import QtQuick
import qs.Commons
import qs.Ui
import "../Model.js" as Model

// The mailboxes, as one row of chips. They are searches rather than labels —
// see Model.MAILBOXES — so "Unread" and "All mail" sit next to "Inbox" without
// needing a different mechanism.
Flickable {
  id: root

  required property color textColor
  required property string panelFontFamily
  property string current: "inbox"
  property int unread: 0
  property int cursorIndex: -1

  signal selected(string key)
  signal chipHovered(int index, bool isHovered)

  width: parent ? parent.width : 0
  implicitHeight: chips.implicitHeight
  contentWidth: chips.implicitWidth
  contentHeight: chips.implicitHeight
  clip: true
  boundsBehavior: Flickable.StopAtBounds
  flickableDirection: Flickable.HorizontalFlick
  interactive: contentWidth > width

  Row {
    id: chips
    spacing: Style.space(4)

    Repeater {
      model: Model.MAILBOXES

      Button {
        required property var modelData
        required property int index

        // Only the unread mailbox carries a count: repeating it on Inbox says
        // the same number twice, and the bar badge already says it once.
        text: modelData.key === "unread" && root.unread > 0
          ? modelData.label + " " + root.unread
          : modelData.label
        foreground: root.textColor
        bordered: false
        selected: root.current === modelData.key
        hasCursor: root.cursorIndex === index
        fontSize: Style.font.bodySmall
        onClicked: root.selected(modelData.key)
        onHovered: function(isHovered) { root.chipHovered(index, isHovered) }
      }
    }
  }
}
