import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "../account/Model.js" as Model
import "../providers/Registry.js" as Provider

// The left column: the mailboxes this account's provider has, then whatever
// labels or folders the server reported.
//
// Icon-first, and narrow enough to leave open: the longest mailbox name is
// "All mail". Collapsing it to a strip of icons is one click away, and the
// tooltips carry the names either way, so the collapsed rail stays usable.
Item {
  id: root

  required property var service
  required property color textColor
  required property color accentColor
  required property color dimColor
  required property string panelFontFamily
  property bool collapsed: false
  property bool calendarSelected: false

  signal mailboxSelected(string key)
  signal labelSelected(string labelId, string name)
  signal calendarRequested()

  // The numbered list App.qml also gives the keys, so a badge and the key that
  // opens the row it sits on cannot disagree.
  property var slots: []
  property bool numbersVisible: false

  // Forwarded to the user bar, which is the control those popups hang off.
  property bool switcherOpen: false
  signal switcherRequested(real sceneX, real sceneY)

  readonly property var userLabels: {
    var all = root.service ? root.service.labels : []
    var out = []
    for (var i = 0; i < all.length; i++) {
      if (!all[i].system) out.push(all[i])
    }
    return out
  }

  // The rail's own edge. The list already draws one on its far side, so
  // without this the icons sit on the same surface as the messages.
  PanelSeparator {
    id: edge
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    width: 1
    foreground: root.textColor
  }

  Flickable {
    id: flick
    anchors.left: parent.left
    anchors.right: edge.left
    anchors.top: parent.top
    anchors.bottom: footer.top
    contentWidth: width
    contentHeight: column.implicitHeight + Style.space(12)
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

    Column {
      id: column
      x: Style.space(6)
      y: Style.space(6)
      width: flick.width - Style.space(12)
      spacing: Style.space(1)

      Repeater {
        // The account's own list. A provider with no All mail must not be
        // offered one, and an IMAP account's Flagged is not Gmail's Starred.
        model: root.service ? root.service.mailboxes : []

        Entry {
          required property var modelData
          label: modelData.label
          icon: modelData.icon
          // No count on the mailboxes. An inbox that is thousands of messages
          // deep reports "999+" forever, which is a number that never changes
          // and therefore says nothing. The bar's dot carries whether anything
          // is waiting; the labels below still count, because those are lists
          // the user built and their sizes mean something.
          count: 0
          selected: !root.calendarSelected && !!root.service
            && root.service.mailboxKey === modelData.key
            && root.service.searchQuery === "" && root.service.rawQuery === ""
          slotNumber: Model.slotNumberOf(root.slots, "mailbox", modelData.key)
          onActivated: root.mailboxSelected(modelData.key)
        }
      }

      Item {
        width: parent.width
        implicitHeight: Style.space(12)
        visible: root.userLabels.length > 0

        PanelSeparator {
          anchors.verticalCenter: parent.verticalCenter
          width: parent.width
          foreground: root.textColor
        }
      }

      PanelSectionHeader {
        visible: root.userLabels.length > 0 && !root.collapsed
        leftPadding: Style.space(8)
        bottomPadding: Style.space(3)
        text: "LABELS"
        foreground: root.textColor
        fontFamily: root.panelFontFamily
      }

      Repeater {
        model: root.userLabels

        Entry {
          required property var modelData
          label: modelData.name
          // One tag for every user label. An initial letter fails the moment a
          // label is not written in the Latin alphabet — a Chinese label would
          // put a single hanzi in a 16px slot, which is neither an icon nor a
          // readable name. The tooltip carries the name instead.
          icon: "label"
          slotNumber: Model.slotNumberOf(root.slots, "label", modelData.id)
          count: modelData.unread
          selected: !root.calendarSelected && !!root.service && root.service.rawQuery !== ""
            && root.service.rawQuery
              === Provider.labelQuery(root.service.providerId, modelData.rawName)
          onActivated: root.labelSelected(modelData.id, modelData.rawName)
        }
      }
    }
  }

  // The account lives at the foot of the rail, which is where a desktop app
  // keeps it. The control that shows and hides the rail is in the header
  // instead — a button that can disappear with the thing it toggles is a
  // button you cannot press to get it back.
  Column {
    id: footer
    anchors.left: parent.left
    anchors.right: edge.left
    anchors.bottom: parent.bottom

    Entry {
      x: Style.space(6)
      label: "Calendar"
      icon: "calendar"
      selected: root.calendarSelected
      onActivated: root.calendarRequested()
    }

    Item {
      width: parent.width
      height: Style.space(6)
    }

    PanelSeparator {
      width: parent.width
      foreground: root.textColor
    }

    UserBar {
      width: parent.width
      textColor: root.textColor
      accentColor: root.accentColor
      dimColor: root.dimColor
      panelFontFamily: root.panelFontFamily
      email: root.service ? root.service.accountEmail : ""
      accountCount: root.service ? root.service.accountCount : 1
      collapsed: root.collapsed
      switcherOpen: root.switcherOpen
      onSwitcherRequested: function(sceneX, sceneY) { root.switcherRequested(sceneX, sceneY) }
    }

  }

  // One row: an icon that is always there, a name that appears when there is
  // room, and a count that survives the collapse as a dot.
  component Entry: Rectangle {
    id: entry
    required property string label
    property string icon: ""
    property int count: 0
    property bool selected: false
    property int slotNumber: 0
    signal activated()

    // The badge names the key, not the position: the tenth row is opened by
    // Alt+0, so it says 0. A row past the tenth has no key and no badge.
    readonly property bool showsNumber: root.numbersVisible && slotNumber > 0
    readonly property string numberText: slotNumber === 10 ? "0" : String(slotNumber)

    width: column.width
    implicitHeight: Style.space(28)
    radius: Style.cornerRadius
    color: entry.selected
      ? Style.selectedFillFor(root.textColor, root.accentColor)
      : (hover.hovered ? Style.hoverFillFor(root.textColor, root.accentColor) : "transparent")

    ActionIcon {
      id: glyph
      anchors.left: parent.left
      anchors.leftMargin: root.collapsed
        ? (parent.width - width) / 2 : Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      name: entry.icon
      iconSize: Style.font.icon
      color: entry.selected ? root.textColor : root.dimColor
      visible: !(entry.showsNumber && root.collapsed)
    }

    // Held Alt names every row. Collapsed there is no room beside the glyph, so
    // it stands where the glyph was; open it takes the count's place, because a
    // 148px rail cannot hold both and the count is the one you can get back by
    // letting go.
    Rectangle {
      id: slotChip
      visible: entry.showsNumber
      anchors.verticalCenter: parent.verticalCenter
      anchors.horizontalCenter: root.collapsed ? parent.horizontalCenter : undefined
      anchors.right: root.collapsed ? undefined : parent.right
      anchors.rightMargin: root.collapsed ? 0 : Style.space(6)
      width: Style.space(16)
      height: width
      radius: Style.cornerRadius
      color: Style.selectedFillFor(root.textColor, root.accentColor)

      Text {
        anchors.centerIn: parent
        text: entry.numberText
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        font.bold: true
      }
    }

    Text {
      visible: !root.collapsed
      anchors.left: glyph.right
      anchors.leftMargin: Style.space(9)
      anchors.right: slotChip.visible ? slotChip.left
        : (badge.visible ? badge.left : parent.right)
      anchors.rightMargin: Style.space(6)
      anchors.verticalCenter: parent.verticalCenter
      text: entry.label
      color: entry.selected ? root.textColor : root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: entry.selected
      elide: Text.ElideRight
    }

    Text {
      id: badge
      visible: entry.count > 0 && !root.collapsed && !entry.showsNumber
      anchors.right: parent.right
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      text: Model.badgeText(entry.count, 999)
      color: root.accentColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      font.bold: true
    }

    Rectangle {
      visible: entry.count > 0 && root.collapsed && !entry.showsNumber
      anchors.right: parent.right
      anchors.rightMargin: Style.space(3)
      anchors.top: parent.top
      anchors.topMargin: Style.space(4)
      width: Style.space(5)
      height: width
      radius: width / 2
      color: root.accentColor
    }

    HoverHandler { id: hover }
    TapHandler { onTapped: entry.activated() }

    // The tooltip is how the rail stays usable while collapsed, and it carries
    // the count too, which the dot can only hint at.
    PanelToolTip {
      visible: hover.hovered
      text: entry.count > 0 ? entry.label + " · " + entry.count : entry.label
      fontFamily: root.panelFontFamily
    }
  }
}
