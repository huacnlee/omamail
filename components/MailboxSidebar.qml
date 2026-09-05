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
  property bool agentSelected: false

  signal mailboxSelected(string key)
  signal labelSelected(string labelId, string name)
  signal folderToggled(string path)
  // A right-click on a label row: the label's id ("" for an ancestor no label
  // names), its path, and where the menu goes.
  signal labelMenuRequested(string labelId, string path, real sceneX, real sceneY)
  signal calendarRequested()
  signal agentRequested()

  // The numbered list App.qml also gives the keys, so a badge and the key that
  // opens the row it sits on cannot disagree.
  property var slots: []
  property bool numbersVisible: false

  // The labels as a tree: a child indented under its parent, a parent that
  // folds. Model.labelTree decides the shape; this draws it.
  readonly property var userLabels: root.service
    ? Model.labelTree(root.service.labels, root.service.collapsedFolders) : []

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

    WheelScroller { view: flick }
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
          icon: modelData.selectable && !!root.service
            && root.service.monitoredLabelIds.indexOf(modelData.id) >= 0 ? "eye" : "label"
          depth: modelData.depth
          foldable: modelData.hasChildren
          expanded: modelData.expanded
          selectable: modelData.selectable
          fullPath: modelData.path
          monitored: modelData.selectable && !!root.service
            && root.service.monitoredLabelIds.indexOf(modelData.id) >= 0
          onMenuRequested: function(sceneX, sceneY) {
            root.labelMenuRequested(modelData.selectable ? modelData.id : "", modelData.path, sceneX, sceneY)
          }
          slotNumber: modelData.selectable ? Model.slotNumberOf(root.slots, "label", modelData.id) : 0
          count: modelData.unread
          selected: modelData.selectable && !root.calendarSelected && !!root.service
            && root.service.rawQuery !== ""
            && root.service.rawQuery
              === Provider.labelQuery(root.service.providerId, modelData.rawName)
          onActivated: {
            if (modelData.selectable) root.labelSelected(modelData.id, modelData.rawName)
            else root.folderToggled(modelData.path)
          }
          onFoldRequested: root.folderToggled(modelData.path)
        }
      }
    }
  }

  // Calendar stays fixed at the foot of the rail while mailbox labels scroll.
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

    // Only where an agent is set: the pane with no agent is a page saying so.
    Entry {
      x: Style.space(6)
      visible: !!root.service && root.service.hasAgent
      label: "Agent"
      icon: "agent"
      selected: root.agentSelected
      onActivated: root.agentRequested()
    }

    Item {
      width: parent.width
      height: Style.space(6)
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
    // A label under another is stepped in one indent per level; a parent
    // carries a chevron that folds its children. An ancestor no label names
    // is drawn dim and opens nothing — tapping it folds instead.
    property int depth: 0
    property bool foldable: false
    property bool expanded: true
    property bool selectable: true
    property string fullPath: ""
    signal activated()
    signal foldRequested()
    signal menuRequested(real sceneX, real sceneY)
    // Watched for new mail: the row keeps its count in the accent even while
    // it is not the one open, and the glyph says so.
    property bool monitored: false

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
        ? (parent.width - width) / 2 : Style.space(8) + entry.depth * Style.space(12)
      anchors.verticalCenter: parent.verticalCenter
      name: entry.icon
      iconSize: Style.font.icon
      color: entry.selected ? root.textColor
        : (entry.selectable ? root.dimColor
          : Qt.rgba(root.dimColor.r, root.dimColor.g, root.dimColor.b, root.dimColor.a * 0.6))
      visible: !(entry.showsNumber && root.collapsed)
    }

    // The fold, at the end of the row so the name keeps its column. Its own
    // tap target, so folding a parent does not also open it.
    Item {
      id: fold
      visible: entry.foldable && !root.collapsed && !entry.showsNumber
      anchors.right: parent.right
      anchors.rightMargin: Style.space(4)
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(18)
      height: Style.space(22)

      ActionIcon {
        anchors.centerIn: parent
        name: entry.expanded ? "chevronDown" : "chevronRight"
        iconSize: Style.font.iconSmall
        color: foldHover.hovered ? root.textColor : root.dimColor
      }

      HoverHandler { id: foldHover }
      TapHandler { onTapped: entry.foldRequested() }
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
        : (badge.visible ? badge.left : (fold.visible ? fold.left : parent.right))
      anchors.rightMargin: Style.space(6)
      anchors.verticalCenter: parent.verticalCenter
      text: entry.label
      color: entry.selected ? root.textColor
        : (entry.selectable ? root.dimColor
          : Qt.rgba(root.dimColor.r, root.dimColor.g, root.dimColor.b, root.dimColor.a * 0.6))
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: entry.selected
      elide: Text.ElideRight
    }

    Text {
      id: badge
      visible: entry.count > 0 && !root.collapsed && !entry.showsNumber
      anchors.right: fold.visible ? fold.left : parent.right
      anchors.rightMargin: fold.visible ? Style.space(2) : Style.space(8)
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
    TapHandler {
      acceptedButtons: Qt.RightButton
      onTapped: {
        var scene = entry.mapToGlobal(0, entry.height)
        entry.menuRequested(scene.x, scene.y)
      }
    }

    // The tooltip is how the rail stays usable while collapsed, and it carries
    // the count too, which the dot can only hint at.
    PanelToolTip {
      visible: hover.hovered
      text: (entry.fullPath !== "" ? entry.fullPath : entry.label)
        + (entry.count > 0 ? " · " + entry.count : "")
      fontFamily: root.panelFontFamily
    }
  }
}
