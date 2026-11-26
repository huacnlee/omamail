import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui
import "../account/Model.js" as Model

// The mailboxes, as one row of chips. What they are depends on the provider —
// Gmail's are searches, so "Unread" and "All mail" sit next to "Inbox" without
// needing a different mechanism; an IMAP account's are folders. The account
// hands the list down already resolved, so this only draws it.
Flickable {
  id: root

  required property color textColor
  required property color accentColor
  required property string panelFontFamily
  property string current: "inbox"
  // Provider-specific, and handed down rather than looked up: this row must
  // never offer a mailbox the account on screen does not have.
  property var allMailboxes: []
  property int unread: 0
  property int cursorIndex: -1

  signal selected(string key)
  signal chipHovered(int index, bool isHovered)

  // Keep every destination reachable, including folders excluded from search.
  // Narrow windows scroll the row instead of hiding Archive, Junk and Trash.
  readonly property var mailboxes: Array.isArray(root.allMailboxes) ? root.allMailboxes : []

  width: parent ? parent.width : 0
  implicitHeight: track.height + (interactive ? scrollBar.height : 0)
  contentWidth: track.width
  contentHeight: track.height
  clip: true
  boundsBehavior: Flickable.StopAtBounds
  flickableDirection: Flickable.HorizontalFlick
  interactive: contentWidth > width

  QQC.ScrollBar.horizontal: QQC.ScrollBar {
    id: scrollBar
    policy: root.interactive ? QQC.ScrollBar.AlwaysOn : QQC.ScrollBar.AlwaysOff
    background: Item {}
    contentItem: Rectangle {
      implicitWidth: 6
      implicitHeight: 6
      radius: 3
      color: Qt.alpha(root.textColor, scrollBar.pressed ? 0.7 : 0.3)
    }
  }

  function revealCurrent() {
    for (var i = 0; i < mailboxes.length; i++) {
      if (mailboxes[i].key !== current) continue
      var chip = segments.itemAt(i)
      if (!chip) return
      var left = track.x + chip.x
      var right = left + chip.width
      if (left < contentX) contentX = left
      else if (right > contentX + width) contentX = Math.max(0, right - width)
      return
    }
  }
  onCurrentChanged: Qt.callLater(revealCurrent)
  onWidthChanged: Qt.callLater(revealCurrent)

  // One segmented control rather than loose chips. Separate chips left the
  // selected one's fill floating at a different left edge from the logo above
  // and the message text below; a single track has one edge, and that edge is
  // the one everything else lines up on.
  Rectangle {
    id: track
    // Centre when there is room; overflowing rows start at the left edge.
    x: Math.max(0, (root.width - width) / 2)
    width: chips.implicitWidth
    height: chips.implicitHeight
    radius: Style.cornerRadius
    color: "transparent"
    border.width: 1
    border.color: Style.normalBorderFor(root.textColor, root.accentColor)

    Row {
      id: chips
      spacing: 0

      Repeater {
        id: segments
        model: root.mailboxes
        onItemAdded: Qt.callLater(root.revealCurrent)

        Item {
          id: segment
          required property var modelData
          required property int index

          implicitWidth: chip.implicitWidth
          implicitHeight: chip.implicitHeight

          // Segments share an edge instead of standing apart, so the row reads
          // as one control with a current position.
          Rectangle {
            visible: segment.index > 0
            width: 1
            height: parent.height
            color: track.border.color
          }

          Button {
            id: chip
            anchors.fill: parent
            // Only the unread mailbox carries a count: repeating it on Inbox
            // says the same number twice, and the bar already says it once.
            text: segment.modelData.key === "unread" && root.unread > 0
              ? segment.modelData.label + " " + root.unread
              : segment.modelData.label
            foreground: root.textColor
            bordered: false
            selected: root.current === segment.modelData.key
            hasCursor: root.cursorIndex === segment.index
            fontSize: Style.font.bodySmall
            onClicked: root.selected(segment.modelData.key)
            onHovered: function(isHovered) { root.chipHovered(segment.index, isHovered) }
          }
        }
      }
    }
  }
}
