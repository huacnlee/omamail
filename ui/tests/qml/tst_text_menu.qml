import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

// The menu a right-click opens on text: what it offers a reader, what more
// it offers an editor, and the two rows a link adds to either.
Item {
  width: 500
  height: 500

  TextEdit {
    id: editor
    width: 300
    text: "hello world"
  }

  Omamail.TextMenu {
    id: menu
    anchors.fill: parent
    textColor: Qt.rgba(0.1, 0.1, 0.1, 1)
    popupBackgroundColor: Qt.rgba(0.95, 0.95, 0.95, 1)
    popupBorderColor: Qt.rgba(0.6, 0.6, 0.6, 1)
    panelFontFamily: "monospace"
  }

  SignalSpy { id: copySpy; target: menu; signalName: "copyRequested" }
  SignalSpy { id: pasteSpy; target: menu; signalName: "pasteRequested" }
  SignalSpy { id: openSpy; target: menu; signalName: "openLinkRequested" }

  TestCase {
    name: "TextMenu"
    when: windowShown

    function init() {
      editor.text = "hello world"
      editor.deselect()
      copySpy.clear()
      pasteSpy.clear()
      openSpy.clear()
    }

    function cleanup() { menu.close() }

    function show(editable, link) {
      menu.close()
      menu.editable = editable
      menu.openAt(editor, 100, 100, link === undefined ? "" : link)
      wait(20)
    }

    function shown(row) { return row.visible && row.enabled }

    // ------------------------------------------------------------- reader

    function test_a_reader_offers_only_copy() {
      show(false)
      compare(menu.opened, true)
      compare(menu.copyRow.visible, true)
      compare(menu.cutRow.visible, false)
      compare(menu.pasteRow.visible, false)
      compare(menu.selectAllRow.visible, false)
      compare(menu.openLinkRow.visible, false)
      compare(menu.copyLinkRow.visible, false)
    }

    function test_copy_is_disabled_without_a_selection() {
      show(false)
      compare(menu.copyRow.enabled, false)
    }

    function test_copy_hands_over_the_selection_and_closes() {
      editor.select(0, 5)
      show(false)
      compare(menu.copyRow.enabled, true)
      menu.copyRow.activated()
      compare(copySpy.count, 1)
      compare(copySpy.signalArguments[0][0], "hello")
      compare(menu.opened, false)
    }

    // ------------------------------------------------------------- editor

    function test_an_editor_offers_cut_paste_and_select_all() {
      show(true)
      compare(menu.cutRow.visible, true)
      compare(menu.copyRow.visible, true)
      compare(menu.pasteRow.visible, true)
      compare(menu.selectAllRow.visible, true)
      compare(shown(menu.pasteRow), true)
      compare(shown(menu.selectAllRow), true)
    }

    function test_cut_copies_the_selection_and_removes_it() {
      editor.select(0, 6)
      show(true)
      compare(menu.cutRow.enabled, true)
      menu.cutRow.activated()
      compare(copySpy.count, 1)
      compare(copySpy.signalArguments[0][0], "hello ")
      compare(editor.text, "world")
    }

    function test_cut_is_disabled_without_a_selection() {
      show(true)
      compare(menu.cutRow.enabled, false)
    }

    function test_paste_asks_the_owner() {
      show(true)
      menu.pasteRow.activated()
      compare(pasteSpy.count, 1)
      verify(pasteSpy.signalArguments[0][0] === editor)
    }

    function test_select_all_selects_the_whole_text() {
      show(true)
      menu.selectAllRow.activated()
      compare(editor.selectedText, "hello world")
    }

    // --------------------------------------------------------------- link

    function test_a_link_adds_open_and_copy_url() {
      show(false, "https://example.com/a")
      compare(menu.openLinkRow.visible, true)
      compare(menu.copyLinkRow.visible, true)
      compare(menu.copyRow.visible, true)
    }

    function test_open_link_hands_over_the_url() {
      show(false, "https://example.com/a")
      menu.openLinkRow.activated()
      compare(openSpy.count, 1)
      compare(openSpy.signalArguments[0][0], "https://example.com/a")
    }

    function test_copy_url_copies_the_url_not_the_selection() {
      editor.select(0, 5)
      show(true, "https://example.com/a")
      menu.copyLinkRow.activated()
      compare(copySpy.count, 1)
      compare(copySpy.signalArguments[0][0], "https://example.com/a")
    }

    function test_the_cursor_starts_on_the_first_usable_row() {
      editor.select(0, 5)
      show(true, "https://example.com/a")
      compare(menu.cursorIndex, 0)
      editor.deselect()
      show(true)
      // Nothing selected: Cut and Copy are out, Paste is the first row.
      compare(menu.cursorIndex, menu.menuRows.indexOf(menu.pasteRow))
    }
  }
}
