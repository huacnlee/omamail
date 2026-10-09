import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui
import "Menu.js" as Menu

// The menu a right-click opens on text. A reader gets Copy; an editor gets
// Cut, Paste and Select all around it; a click on a link adds Open and Copy
// URL to either. The text item is handed in at open time rather than bound,
// so one menu serves every field of a form.
//
// Copy goes out as a signal rather than through the item's own copy(),
// because the host owns the platform clipboard — the same reason
// AddressMenu hands an address up instead of setting it here.
Item {
  id: root

  required property color textColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily

  // Whether the text can be changed: shows Cut, Paste and Select all.
  property bool editable: false
  // The TextEdit or TextField the menu was opened on.
  property var target: null
  // The link under the pointer when it opened, or "" for none.
  property string link: ""
  property int cursorIndex: -1
  // Spelling, set by the owner before opening. An empty suggestion list with
  // spellingMisspelled false hides the whole section. spellingPosition is the
  // UTF-16 offset the suggestions were taken from, kept so a correction still
  // targets the clicked word if the caret has moved by the time one is picked.
  property int spellingPosition: -1
  // The document revision the suggestions were taken from. The owner refuses
  // a correction when its live revision has moved on, so editing elsewhere
  // cannot redirect the correction to the same word at a shifted position.
  property int spellingRevision: -1
  property string spellingWord: ""
  property bool spellingMisspelled: false
  property var spellingSuggestions: []
  readonly property bool spellingVisible: spellingSuggestions.length > 0 || spellingMisspelled
  readonly property bool spellingActionsVisible: spellingMisspelled && spellingWord !== ""
  readonly property bool opened: menu.opened
  readonly property bool hasSelection: !!target && String(target.selectedText || "") !== ""
  readonly property var menuRows: [
    suggestion0, suggestion1, suggestion2, suggestion3, suggestion4,
    ignoreRow, addRow, cutRow, copyRow, pasteRow, selectAllRow, openLinkRow, copyLinkRow
  ]

  readonly property alias cutRow: cutRow
  readonly property alias copyRow: copyRow
  readonly property alias pasteRow: pasteRow
  readonly property alias selectAllRow: selectAllRow
  readonly property alias openLinkRow: openLinkRow
  readonly property alias copyLinkRow: copyLinkRow
  readonly property alias ignoreWordRow: ignoreRow
  readonly property alias addToDictionaryRow: addRow

  signal copyRequested(string text)
  // Paste is the owner's: a compose form tries the clipboard for an image
  // before it pastes text, and only it knows how.
  signal pasteRequested(var target)
  signal openLinkRequested(string url)
  signal spellingCorrect(string replacement)
  signal spellingIgnore(string word)
  signal spellingAddToDictionary(string word)

  anchors.fill: parent
  z: 50

  property real anchorX: 0
  property real anchorY: 0

  function openAt(item, sceneX, sceneY, url) {
    if (!item) return
    target = item
    link = String(url || "")
    var local = root.mapFromGlobal(sceneX, sceneY)
    anchorX = local.x
    anchorY = local.y
    menu.open()
  }

  function place() {
    if (!menu.visible) return
    var tall = menu.height > 0 ? menu.height : menu.implicitHeight
    var placed = Menu.position(anchorX, anchorY, menu.width, tall, root.width, root.height)
    menu.x = placed.x
    menu.y = placed.y
  }

  function selectableRows() {
    var values = []
    for (var i = 0; i < menuRows.length; i++) values.push({
      selectable: true, visible: menuRows[i].visible, enabled: menuRows[i].enabled
    })
    return values
  }
  function moveCursor(step) { cursorIndex = Menu.nextSelectable(selectableRows(), cursorIndex, step) }
  function runCursor() { if (cursorIndex >= 0) menuRows[cursorIndex].activated() }
  function close() { menu.close() }

  function chooseSuggestion(index) {
    var replacement = String(root.spellingSuggestions[index] || "")
    menu.close()
    if (replacement !== "") root.spellingCorrect(replacement)
  }

  function copySelection() {
    var text = hasSelection ? String(target.selectedText) : ""
    menu.close()
    if (text !== "") root.copyRequested(text)
  }

  function cutSelection() {
    if (!hasSelection) { menu.close(); return }
    var item = target
    var text = String(item.selectedText)
    var from = item.selectionStart
    var to = item.selectionEnd
    menu.close()
    root.copyRequested(text)
    item.remove(from, to)
  }

  QQC.Popup {
    id: menu
    width: Style.space(180)
    implicitHeight: rows.implicitHeight + Style.space(8)
    padding: Style.space(4)
    modal: false
    focus: true
    closePolicy: QQC.Popup.CloseOnEscape | QQC.Popup.CloseOnPressOutside
    onHeightChanged: root.place()
    onOpened: {
      root.cursorIndex = Menu.firstSelectable(root.selectableRows())
      root.place()
    }
    background: Rectangle {
      radius: Style.cornerRadius
      color: root.popupBackgroundColor
      border.width: 1
      border.color: root.popupBorderColor
    }

    contentItem: Column {
      id: rows
      spacing: Style.space(2)

      focus: true
      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_J || event.key === Qt.Key_Down) {
          root.moveCursor(1); event.accepted = true
        } else if (event.key === Qt.Key_K || event.key === Qt.Key_Up) {
          root.moveCursor(-1); event.accepted = true
        } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
            || event.key === Qt.Key_O) {
          root.runCursor(); event.accepted = true
        }
      }

      MenuRow {
        id: suggestion0
        visible: root.spellingSuggestions.length > 0
        text: String(root.spellingSuggestions[0] || "")
        onActivated: root.chooseSuggestion(0)
      }
      MenuRow {
        id: suggestion1
        visible: root.spellingSuggestions.length > 1
        text: String(root.spellingSuggestions[1] || "")
        onActivated: root.chooseSuggestion(1)
      }
      MenuRow {
        id: suggestion2
        visible: root.spellingSuggestions.length > 2
        text: String(root.spellingSuggestions[2] || "")
        onActivated: root.chooseSuggestion(2)
      }
      MenuRow {
        id: suggestion3
        visible: root.spellingSuggestions.length > 3
        text: String(root.spellingSuggestions[3] || "")
        onActivated: root.chooseSuggestion(3)
      }
      MenuRow {
        id: suggestion4
        visible: root.spellingSuggestions.length > 4
        text: String(root.spellingSuggestions[4] || "")
        onActivated: root.chooseSuggestion(4)
      }
      MenuSeparatorLine {
        visible: root.spellingVisible
        width: menu.width - menu.leftPadding - menu.rightPadding
        lineColor: root.textColor
      }
      MenuRow {
        id: ignoreRow
        visible: root.spellingActionsVisible
        text: "Ignore for this session"
        onActivated: { var word = root.spellingWord; menu.close(); root.spellingIgnore(word) }
      }
      MenuRow {
        id: addRow
        visible: root.spellingActionsVisible
        text: "Add to dictionary"
        onActivated: { var word = root.spellingWord; menu.close(); root.spellingAddToDictionary(word) }
      }
      MenuSeparatorLine {
        visible: root.spellingVisible
        width: menu.width - menu.leftPadding - menu.rightPadding
        lineColor: root.textColor
      }
      MenuRow {
        id: cutRow
        visible: root.editable
        enabled: root.hasSelection
        text: "Cut"
        onActivated: root.cutSelection()
      }
      MenuRow {
        id: copyRow
        enabled: root.hasSelection
        text: "Copy"
        onActivated: root.copySelection()
      }
      MenuRow {
        id: pasteRow
        visible: root.editable
        text: "Paste"
        onActivated: { var item = root.target; menu.close(); root.pasteRequested(item) }
      }
      MenuRow {
        id: selectAllRow
        visible: root.editable
        text: "Select all"
        onActivated: { var item = root.target; menu.close(); if (item) item.selectAll() }
      }

      MenuSeparatorLine {
        visible: root.link !== ""
        width: menu.width - menu.leftPadding - menu.rightPadding
        lineColor: root.textColor
      }
      MenuRow {
        id: openLinkRow
        visible: root.link !== ""
        text: "Open link..."
        onActivated: { var url = root.link; menu.close(); root.openLinkRequested(url) }
      }
      MenuRow {
        id: copyLinkRow
        visible: root.link !== ""
        text: "Copy URL"
        onActivated: { var url = root.link; menu.close(); root.copyRequested(url) }
      }
    }
  }

  component MenuRow: MenuActionRow {
    width: menu.width - menu.leftPadding - menu.rightPadding
    textColor: root.textColor
    panelFontFamily: root.panelFontFamily
    collection: root.menuRows
    cursorIndex: root.cursorIndex
  }
}
