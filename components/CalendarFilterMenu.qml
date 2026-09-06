import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui
import "Menu.js" as Menu

// Which calendars the grid is drawing, asked where the grid is.
//
// `CalendarController.setSourceEnabled` has been able to hide a calendar's
// events for as long as it has existed, and nothing has ever called it. This
// is that call: a calendar is shown or hidden over the grid it changes,
// because it is the question asked several times a day — this week's work
// calendar off, next week's on — and the settings page is where you go to
// give a calendar a password, not to answer that.
//
// Rows read from `controller.sourceGroups`, which is the current scope rather
// than every account — the unified view lists them all, a per-mailbox view
// lists that mailbox's. A calendar the grid could not draw is not one this
// menu can hide.
Item {
  id: root

  required property var controller
  required property color textColor
  required property color dimColor
  required property color accentColor
  required property color urgentColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily

  readonly property var groups: controller && Array.isArray(controller.sourceGroups)
    ? controller.sourceGroups : []
  readonly property var sources: {
    var out = []
    for (var i = 0; i < groups.length; i++) {
      var calendars = groups[i] && Array.isArray(groups[i].calendars) ? groups[i].calendars : []
      for (var c = 0; c < calendars.length; c++) out.push(calendars[c])
    }
    return out
  }
  readonly property int shownCount: {
    var count = 0
    for (var i = 0; i < sources.length; i++) if (sources[i] && sources[i].enabled !== false) count++
    return count
  }
  readonly property bool filtered: shownCount < sources.length
  // A write is refused while another is in flight, so the rows say so rather
  // than dropping a tap on the floor.
  readonly property bool busy: !!controller && controller.savingSource === true
  readonly property bool opened: menu.opened

  // A popup that closes on a press outside itself is already closed by the
  // press that reaches the trigger, so by the time the release becomes a
  // click `opened` reads false and a plain toggle opens it straight back up:
  // the button can never put its own menu away. The moment it closed is what
  // tells "the user wants this open" apart from "this just closed under the
  // same press". `ComposeView` carries the same guard for the same reason.
  property double closedAt: 0

  // Where the keyboard is standing, as an index into `sources` — or the
  // length of it, which is the Show all row. -1 is nowhere, which is where it
  // starts: opening with a row lit reads as "this is the one you are on".
  property int cursorIndex: -1
  readonly property int rowCount: root.sources.length + (root.filtered ? 1 : 0)

  // The label carries the count, not just the colour of a dot: a theme can put
  // a calendar's colour close to the foreground, and "some of your calendars
  // are hidden" is exactly the state you forget you left the app in.
  //
  // The word goes before the count does. This sits in a header row that is
  // already tight at the mini size, and of the two halves the count is the
  // one saying something the icon beside it does not.
  readonly property real windowWidth: root.Window.window ? root.Window.window.width : 0
  readonly property bool roomForTheWord: root.windowWidth === 0 || root.windowWidth >= Style.space(700)
  readonly property string countLabel: root.shownCount + "/" + root.sources.length
  readonly property string summary: root.roomForTheWord
    ? (root.filtered ? "Calendars " + root.countLabel : "Calendars")
    : (root.filtered ? root.countLabel : "")

  implicitWidth: trigger.implicitWidth
  implicitHeight: trigger.implicitHeight

  function toggle() {
    if (menu.opened) { menu.close(); return }
    if (Date.now() - root.closedAt < 250) return
    menu.open()
    root.place()
  }

  function indexOfSource(sourceId) {
    for (var i = 0; i < root.sources.length; i++) {
      if (root.sources[i] && String(root.sources[i].id) === String(sourceId)) return i
    }
    return -1
  }

  function moveCursor(step) {
    if (root.rowCount === 0) { root.cursorIndex = -1; return }
    var at = root.cursorIndex
    if (at < 0 || at >= root.rowCount) at = Number(step) < 0 ? root.rowCount : -1
    root.cursorIndex = (at + Number(step) + root.rowCount) % root.rowCount
  }

  function activateCursor() {
    if (root.busy || root.cursorIndex < 0 || root.cursorIndex >= root.rowCount) return
    if (root.cursorIndex === root.sources.length) { root.showAll(); return }
    var source = root.sources[root.cursorIndex]
    if (source) root.setEnabled(source.id, source.enabled === false)
  }

  function setEnabled(sourceId, enabled) {
    if (!controller || typeof controller.setSourceEnabled !== "function") return
    controller.setSourceEnabled(String(sourceId), enabled === true)
  }

  function showAll() {
    if (!controller || typeof controller.showAllSources !== "function") return
    controller.showAllSources()
  }

  IconTextButton {
    id: trigger
    objectName: "calendarFilterTrigger"
    anchors.fill: parent
    iconName: "calendar"
    text: root.summary
    tooltipText: "Choose which calendars are drawn"
    foreground: root.filtered ? root.textColor : root.dimColor
    hoverColor: root.textColor
    accent: root.accentColor
    ghost: true
    fontFamily: root.panelFontFamily
    fontSize: Style.font.caption
    selected: menu.opened
    onClicked: root.toggle()
  }

  // Under the trigger, right edges aligned, and above it when there is no
  // room below. The flip is around the trigger rather than around the point
  // below it: reflecting around the lower point lands the menu back on top of
  // the trigger and the heading beside it, which is what a short window did.
  //
  // A Popup has no height until it has been opened once, so placing again on
  // every height change is what puts the first open where the later ones go.
  function place() {
    if (!menu.visible) return
    var window = root.Window.window
    var windowWidth = window ? window.width : root.width
    var windowHeight = window ? window.height : root.height
    var gap = Style.space(4)
    var tall = menu.height > 0 ? menu.height : menu.implicitHeight
    var top = root.mapToItem(null, 0, 0)

    var y = top.y + root.height + gap
    if (y + tall > windowHeight) y = top.y - gap - tall
    y = Math.max(0, Math.min(y, Math.max(0, windowHeight - tall)))

    var x = top.x + root.width - menu.width
    x = Math.max(0, Math.min(x, Math.max(0, windowWidth - menu.width)))

    var origin = root.mapFromItem(null, x, y)
    menu.x = origin.x
    menu.y = origin.y
  }

  QQC.Popup {
    id: menu
    // Never wider than the window: at the mini size a fixed width runs off
    // the edge with nothing to scroll it back.
    width: Math.min(Style.space(280),
      Math.max(Style.space(180), (root.Window.window ? root.Window.window.width : Style.space(280))
        - Style.space(24)))
    implicitHeight: rows.implicitHeight + Style.space(8)
    padding: Style.space(4)
    modal: false
    focus: true
    closePolicy: QQC.Popup.CloseOnEscape | QQC.Popup.CloseOnPressOutside
    onHeightChanged: root.place()
    onOpened: {
      root.cursorIndex = -1
      root.place()
    }
    onClosed: root.closedAt = Date.now()

    background: Rectangle {
      radius: Style.cornerRadius
      color: root.popupBackgroundColor
      border.width: 1
      border.color: root.popupBorderColor
    }

    contentItem: Column {
      id: rows
      spacing: Style.space(2)

      // An open popup takes every key before the window's shortcut map, so a
      // menu that answers none of them silently disables the whole calendar
      // keymap until it is dismissed. `tests/qml/tst_popup_keys.qml` is why
      // this is a rule rather than a nicety.
      focus: true
      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_J || event.key === Qt.Key_Down) {
          root.moveCursor(1); event.accepted = true
        } else if (event.key === Qt.Key_K || event.key === Qt.Key_Up) {
          root.moveCursor(-1); event.accepted = true
        } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
            || event.key === Qt.Key_Space) {
          root.activateCursor(); event.accepted = true
        }
      }

      Repeater {
        model: root.groups

        Column {
          id: group
          required property var modelData
          width: menu.width - menu.leftPadding - menu.rightPadding
          spacing: Style.space(2)

          // The account only needs naming when there is more than one to
          // tell apart; one mailbox's calendars are already its own.
          Text {
            visible: root.groups.length > 1
            width: parent.width
            height: visible ? implicitHeight + Style.space(6) : 0
            verticalAlignment: Text.AlignBottom
            leftPadding: Style.space(9)
            text: group.modelData.accountLabel
            color: root.dimColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideMiddle
            textFormat: Text.PlainText
          }

          Repeater {
            model: group.modelData.calendars

            Rectangle {
              id: calendarRow
              required property var modelData
              readonly property string sourceId: String(modelData.id || "")
              readonly property bool shown: modelData.enabled !== false
              readonly property int rowIndex: root.indexOfSource(calendarRow.sourceId)
              readonly property color sourceColor: calendarPalette.colorFor(modelData.colorKey)

              objectName: "calendarFilter:" + calendarRow.sourceId
              width: parent.width
              implicitHeight: Style.spacing.popupRowHeight
              radius: Style.cornerRadius
              // A write already in flight is refused by the controller, so a
              // row that still took the tap would swallow it and say nothing.
              enabled: !root.busy
              opacity: enabled ? 1 : 0.4
              color: rowHover.hovered || root.cursorIndex === calendarRow.rowIndex
                ? Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.08)
                : "transparent"

              function toggle() { root.setEnabled(calendarRow.sourceId, !calendarRow.shown) }

              // A filled dot for shown, a ring for hidden. The check beside the
              // name says the same thing again in a second way, because a
              // calendar's colour is chosen from a palette that a theme can put
              // close to the ground it sits on.
              Rectangle {
                id: rowDot
                anchors.left: parent.left
                anchors.leftMargin: Style.space(9)
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(10)
                height: width
                radius: width / 2
                color: calendarRow.shown ? calendarRow.sourceColor : "transparent"
                border.width: calendarRow.shown ? 0 : Math.max(1, Style.normalBorderWidth)
                border.color: calendarRow.sourceColor
              }

              Text {
                anchors.left: rowDot.right
                anchors.leftMargin: Style.space(8)
                anchors.right: rowCheck.left
                anchors.rightMargin: Style.space(6)
                anchors.verticalCenter: parent.verticalCenter
                text: String(calendarRow.modelData.name || calendarRow.modelData.id || "Calendar")
                color: calendarRow.shown ? root.textColor : root.dimColor
                font.family: root.panelFontFamily
                font.pixelSize: Style.font.bodySmall
                elide: Text.ElideRight
                textFormat: Text.PlainText
              }

              ActionIcon {
                id: rowCheck
                anchors.right: parent.right
                anchors.rightMargin: Style.space(9)
                anchors.verticalCenter: parent.verticalCenter
                visible: calendarRow.shown
                name: "check"
                iconSize: Style.font.iconSmall
                color: root.accentColor
              }

              HoverHandler { id: rowHover }
              TapHandler { onTapped: calendarRow.toggle() }
            }
          }
        }
      }

      MenuSeparatorLine {
        visible: root.filtered
        width: menu.width - menu.leftPadding - menu.rightPadding
        lineColor: root.textColor
      }

      // The row names its own collection, and is not in it. A MenuActionRow
      // left with the default empty one answers `indexOf(this) === cursorIndex`
      // with `-1 === -1` and draws itself lit from the moment it appears.
      MenuActionRow {
        id: showAllRow
        objectName: "calendarFilterShowAll"
        visible: root.filtered
        width: menu.width - menu.leftPadding - menu.rightPadding
        text: "Show all"
        textColor: root.textColor
        panelFontFamily: root.panelFontFamily
        collection: [showAllRow]
        cursorIndex: root.cursorIndex === root.sources.length ? 0 : -1
        enabled: !root.busy
        onActivated: root.showAll()
      }

      Text {
        visible: root.sources.length === 0
        width: menu.width - menu.leftPadding - menu.rightPadding
        padding: Style.space(9)
        text: "No calendars yet. Add one in Settings."
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
        textFormat: Text.PlainText
      }
    }
  }

  CalendarPalette {
    id: calendarPalette
    textColor: root.textColor
    accentColor: root.accentColor
    urgentColor: root.urgentColor
    dimColor: root.dimColor
  }
}
