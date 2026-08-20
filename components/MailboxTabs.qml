import QtQuick
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
  required property string panelFontFamily
  property string current: "inbox"
  // Provider-specific, and handed down rather than looked up: this row must
  // never offer a mailbox the account on screen does not have.
  property var allMailboxes: []
  property int unread: 0
  property int cursorIndex: -1

  signal selected(string key)
  signal chipHovered(int index, bool isHovered)

  // Scrolling a six-segment control in a narrow window is worse than not
  // offering two of the segments: All mail and Trash are places you go looking
  // for something, not places you work from, and search reaches both. The
  // mailbox in view is never dropped, however rarely it is used.
  readonly property bool crowded: measure.implicitWidth > width && width > 0
  readonly property var mailboxes: {
    var all = Array.isArray(root.allMailboxes) ? root.allMailboxes : []
    if (!crowded) return all
    var out = []
    for (var i = 0; i < all.length; i++) {
      if (!all[i].optional || all[i].key === root.current) out.push(all[i])
    }
    return out
  }

  width: parent ? parent.width : 0
  implicitHeight: track.height
  contentWidth: track.width
  contentHeight: track.height
  clip: true
  boundsBehavior: Flickable.StopAtBounds
  flickableDirection: Flickable.HorizontalFlick
  interactive: contentWidth > width

  // One segmented control rather than loose chips. Separate chips left the
  // selected one's fill floating at a different left edge from the logo above
  // and the message text below; a single track has one edge, and that edge is
  // the one everything else lines up on.
  // Measured, not guessed: the labels are theme-dependent and this has to know
  // the width of the full set before deciding whether to show it.
  Row {
    id: measure
    visible: false
    spacing: 0
    Repeater {
      model: root.allMailboxes
      Button {
        required property var modelData
        text: modelData.label
        bordered: false
        fontSize: Style.font.bodySmall
      }
    }
  }

  Rectangle {
    id: track
    // Centred whenever the row has slack — which is the case once segments have
    // stood down. Left-aligned the moment it fills the width, so at the sizes
    // where it does span, its edge is still the one the logo and the message
    // text line up on.
    x: Math.max(0, (root.width - width) / 2)
    width: chips.implicitWidth
    height: chips.implicitHeight
    radius: Style.cornerRadius
    color: "transparent"
    border.width: 1
    border.color: Style.normalBorderFor(root.textColor, Color.accent)

    Row {
      id: chips
      spacing: 0

      Repeater {
        model: root.mailboxes

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
