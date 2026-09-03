import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui
import "../account/Model.js" as Model
import "Menu.js" as Menu

// The list of mailboxes, opened from the user bar.
//
// Switching is meant to be instant, which it is because every account keeps its
// own cache. It says which is being checked right now and keeps a mailbox that
// has not finished signing in visible, because otherwise a half-added mailbox
// becomes invisible and unfixable.
Item {
  id: root

  required property color textColor
  required property color accentColor
  required property color urgentColor
  required property color dimColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily

  // [{ id, email, label, unread, active, signedIn, busy, error }]
  property var accounts: []

  readonly property bool opened: menu.opened

  // A popup builds its contents outside this item's own children, so nothing
  // walking the tree from here finds a row. This is the handle that does —
  // the same reason `opened` is exposed rather than reached for.
  readonly property alias menuRows: rows

  // Where the keyboard is standing, which is not where the mouse is: hover is
  // drawn by the row itself and never written here. Qt re-reports hover when
  // content moves under a still pointer, and a hover that moved this would drag
  // the cursor back to whatever the pointer happened to rest on.
  property int cursorIndex: 0

  // Whether the mailbox on screen is the merge of all of them, drawn the way
  // an active account is drawn because it is the same kind of choice.
  property bool unifiedActive: false

  // One mailbox has nothing to combine, so the row is not offered: choosing it
  // would land on the same list under a different name.
  readonly property int accountRowCount: root.accounts ? root.accounts.length : 0
  readonly property bool unifiedOffered: accountRowCount > 1
  readonly property int rowOffset: unifiedOffered ? 1 : 0
  readonly property int rowCount: accountRowCount + rowOffset

  signal accountChosen(int index)
  signal unifiedChosen()
  signal addAccountRequested()
  signal manageRequested()

  anchors.fill: parent
  z: 45

  // Where the menu was asked to appear, kept because it cannot be placed yet.
  property real anchorX: 0
  property real anchorY: 0

  function openAt(sceneX, sceneY) {
    var local = root.mapFromGlobal(sceneX, sceneY)
    anchorX = local.x
    anchorY = local.y
    menu.open()
    place()
  }

  // A Popup does not build its contents until it is first opened, so on the
  // very first click its height is still zero — the "does it fit below?" test
  // passed trivially and the menu was placed at the click, then grew off the
  // bottom of the window. Placing again whenever the height changes is what
  // makes the first open behave like every one after it, and it also re-places
  // the menu when a row is added or removed.
  function place() {
    if (!menu.visible) return
    var tall = menu.height > 0 ? menu.height : menu.implicitHeight
    var placed = Menu.position(anchorX, anchorY, menu.width, tall, root.width, root.height)
    menu.x = placed.x
    menu.y = placed.y
  }

  // Opened from a menu rather than from a click on the rail, so there is no
  // pointer position to hang it off. Centring is the honest answer: anywhere
  // else would be pretending it belongs to something on screen.
  function openCentered() {
    anchorX = Math.max(0, (root.width - menu.width) / 2)
    anchorY = Math.max(0, (root.height - menu.implicitHeight) / 2)
    menu.open()
    place()
  }

  function close() { menu.close() }

  function moveCursor(delta) {
    if (root.rowCount === 0) return
    cursorIndex = Model.wrappedIndex(cursorIndex, delta, root.rowCount)
  }

  // The combined row is first, so the accounts sit one further down than their
  // own indices. Everything above this component still counts accounts.
  function chooseCursor() {
    if (cursorIndex < 0 || cursorIndex >= root.rowCount) return
    menu.close()
    if (root.unifiedOffered && cursorIndex === 0) {
      root.unifiedChosen()
      return
    }
    root.accountChosen(cursorIndex - root.rowOffset)
  }

  // Opening puts the keyboard on the mailbox you are already in, so the first
  // `j` is one step away from it rather than back at the top of the list.
  function restCursorOnActive() {
    if (root.unifiedActive && root.unifiedOffered) {
      cursorIndex = 0
      return
    }
    var accounts = root.accounts || []
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].active) { cursorIndex = i + root.rowOffset; return }
    }
    cursorIndex = 0
  }

  QQC.Popup {
    id: menu
    width: Style.space(250)
    implicitHeight: rows.implicitHeight + Style.space(8)
    padding: Style.space(4)
    modal: false
    focus: true
    closePolicy: QQC.Popup.CloseOnEscape | QQC.Popup.CloseOnPressOutside
    onHeightChanged: root.place()
    onOpened: {
      root.restCursorOnActive()
      root.place()
    }
    background: Rectangle {
      radius: Style.cornerRadius
      color: root.popupBackgroundColor
      border.width: 1
      border.color: root.popupBorderColor
    }

    // The one place in this window that answers keys itself, and the reason is
    // the opposite of the rule it breaks. `Keys` handlers are banned everywhere
    // else because a window `Shortcut` beats them, so a local one looks live
    // and never runs. Inside an open `QQC.Popup` it is the other way round: the
    // popup takes every key before the shortcut map sees it — with `focus` true
    // or false, bare or modified — so a `KeyRouter` binding is the thing that
    // would look live and never run. `tst_account_switcher.qml` holds both
    // halves of that, so the next person to reach for `survivesOverlay` finds
    // out from a test rather than from a menu that does not move.
    contentItem: Column {
      id: rows
      focus: true
      spacing: Style.space(2)

      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_J || event.key === Qt.Key_Down) {
          root.moveCursor(1)
          event.accepted = true
        } else if (event.key === Qt.Key_K || event.key === Qt.Key_Up) {
          root.moveCursor(-1)
          event.accepted = true
        } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
            || event.key === Qt.Key_O) {
          root.chooseCursor()
          event.accepted = true
        }
        // Escape is not here: the popup's own CloseOnEscape is already the one
        // mechanism that closes it, and a second would be one too many.
      }

      // Every mailbox at once, above the mailboxes it is made of: it is the
      // widest of the choices here, and a list is read from the top.
      Rectangle {
        id: unifiedRow
        visible: root.unifiedOffered

        readonly property bool hasCursor: root.cursorIndex === 0

        width: menu.width - menu.leftPadding - menu.rightPadding
        implicitHeight: visible ? Style.space(40) : 0
        radius: Style.cornerRadius
        color: root.unifiedActive
          ? Style.selectedFillFor(root.textColor, root.accentColor)
          : (unifiedHover.hovered || hasCursor
            ? Style.hoverFillFor(root.textColor, root.accentColor) : "transparent")
        border.width: hasCursor ? Style.normalBorderWidth : 0
        border.color: Style.hoverBorderFor(root.textColor, root.accentColor)

        Rectangle {
          id: unifiedAvatar
          anchors.left: parent.left
          anchors.leftMargin: Style.space(8)
          anchors.verticalCenter: parent.verticalCenter
          width: Style.space(22)
          height: width
          radius: width / 2
          color: Style.selectedFillFor(root.textColor, root.accentColor)

          // Not a letter: this row stands for no address, and an initial
          // taken from one of them would claim it belonged to that mailbox.
          ActionIcon {
            anchors.centerIn: parent
            name: "inbox"
            color: root.textColor
            iconSize: Style.font.caption
          }
        }

        Column {
          anchors.left: unifiedAvatar.right
          anchors.leftMargin: Style.space(9)
          anchors.right: parent.right
          anchors.rightMargin: Style.space(10)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(1)

          Text {
            width: parent.width
            textFormat: Text.PlainText
            // The same string the status line shows, from one place.
            text: Model.UNIFIED_LABEL
            color: root.textColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.bodySmall
            font.bold: root.unifiedActive
            elide: Text.ElideRight
          }

          Text {
            width: parent.width
            textFormat: Text.PlainText
            text: root.accountRowCount + " mailboxes in one list"
            color: root.dimColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }

        HoverHandler { id: unifiedHover }
        TapHandler {
          onTapped: {
            menu.close()
            root.unifiedChosen()
          }
        }
      }

      Repeater {
        model: root.accounts

        Rectangle {
          id: row
          objectName: "account-row"
          required property var modelData
          required property int index

          readonly property bool hasCursor: root.cursorIndex === row.index + root.rowOffset

          // Whether this mailbox was given a name, which decides what the two
          // lines hold. `label` cannot answer it: it falls through to the
          // local part, so it is never empty.
          readonly property bool named: modelData.name !== undefined
            && String(modelData.name) !== ""

          // What the two lines hold, decided here rather than inside the
          // bindings that draw them: it is one choice with two halves, and
          // splitting it across two `Text` elements hid that.
          readonly property string primaryText: {
            if (row.named) return String(modelData.name)
            return modelData.email !== "" ? modelData.email : "New account"
          }

          readonly property string secondaryText: {
            if (modelData.error !== undefined && modelData.error !== "")
              return String(modelData.error)
            if (!modelData.signedIn) return "Signed out"
            if (modelData.busy) return "Checking"
            // A named mailbox puts its address here, which keeps the name from
            // hiding which account it stands for. An unnamed one has already
            // said everything it has to say on the line above.
            return row.named ? String(modelData.email || "") : ""
          }

          width: menu.width - menu.leftPadding - menu.rightPadding
          implicitHeight: Style.space(40)
          radius: Style.cornerRadius
          color: modelData.active
            ? Style.selectedFillFor(root.textColor, root.accentColor)
            : (rowHover.hovered || hasCursor
              ? Style.hoverFillFor(root.textColor, root.accentColor) : "transparent")
          // A border rather than a third fill: the mailbox you are in already
          // owns the selected one, and the keyboard has to be visible standing
          // on that row too.
          border.width: hasCursor ? Style.normalBorderWidth : 0
          border.color: Style.hoverBorderFor(root.textColor, root.accentColor)

          Rectangle {
            id: rowAvatar
            anchors.left: parent.left
            anchors.leftMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            width: Style.space(22)
            height: width
            radius: width / 2
            color: Style.selectedFillFor(root.textColor, root.accentColor)

            Text {
              anchors.centerIn: parent
              textFormat: Text.PlainText
              text: {
                if (row.named) return String(row.modelData.name).charAt(0).toUpperCase()
                return row.modelData.email === ""
                  ? "+" : row.modelData.email.charAt(0).toUpperCase()
              }
              color: root.textColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
            }
          }

          Column {
            anchors.left: rowAvatar.right
            anchors.leftMargin: Style.space(9)
            anchors.right: parent.right
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(1)

            // A name if one was chosen, and the address otherwise.
            //
            // The address used to be the only thing here, because the only
            // name available was the local part and two mailboxes easily
            // share one across different domains. A name somebody typed is
            // the opposite: it exists precisely to tell them apart, and it
            // wins over an address that elides to `patryk.bartkow…` in a list
            // this narrow. The address is not lost — it moves below.
            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: row.primaryText
              color: root.textColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.bodySmall
              font.bold: row.modelData.active
              elide: Text.ElideMiddle
            }

            // Says why an account is not usable, rather than leaving it looking
            // identical to one that is.
            Text {
              width: parent.width
              visible: text !== ""
              textFormat: Text.PlainText
              text: row.secondaryText
              color: row.modelData.error !== undefined && row.modelData.error !== ""
                ? root.urgentColor : root.dimColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }
          }

          HoverHandler { id: rowHover }
          TapHandler {
            onTapped: {
              menu.close()
              root.accountChosen(row.index)
            }
          }
        }
      }

      Item {
        width: menu.width - menu.leftPadding - menu.rightPadding
        implicitHeight: Style.space(7)

        PanelSeparator {
          anchors.verticalCenter: parent.verticalCenter
          width: parent.width
          foreground: root.textColor
        }
      }

      MenuRow {
        text: "Add a mailbox..."
        onActivated: {
          menu.close()
          root.addAccountRequested()
        }
      }

      MenuRow {
        text: "Manage accounts..."
        onActivated: {
          menu.close()
          root.manageRequested()
        }
      }
    }
  }

  component MenuRow: Rectangle {
    id: plainRow
    required property string text
    signal activated()

    width: menu.width - menu.leftPadding - menu.rightPadding
    implicitHeight: Style.spacing.popupRowHeight
    radius: Style.cornerRadius
    color: plainHover.hovered
      ? Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.08)
      : "transparent"

    Text {
      anchors.left: parent.left
      anchors.leftMargin: Style.space(9)
      anchors.right: parent.right
      anchors.rightMargin: Style.space(9)
      anchors.verticalCenter: parent.verticalCenter
      text: plainRow.text
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      elide: Text.ElideRight
    }

    HoverHandler { id: plainHover }
    TapHandler { onTapped: plainRow.activated() }
  }
}
