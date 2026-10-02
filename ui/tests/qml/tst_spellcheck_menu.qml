import QtQuick
import QtTest
import "../../components" as Omamail

// The right-click / Ctrl+. spelling menu on the composer body — the word
// it targets, the correction/ignore/dictionary actions it offers, and the
// guards that keep a stale or destroyed draft from being rewritten. The
// underlines and the adapter contract are covered by tst_spellcheck_adapter
// and tst_spellcheck_composer; here the point is the menu wiring.
Item {
  width: 900
  height: 600

  QtObject {
    id: mailService
    property bool sendPending: false
    property bool sending: false
    property int sendSecondsRemaining: 10
    property var lastSent: null
    property var recipientContacts: []
    property var sendAsAliases: []
    property var sendIdentities: [
      ({ email: "me@example.com", accountId: "me@example.com", label: "me" })
    ]
    property string accountEmail: "me@example.com"
    property string activeAccountId: "me@example.com"
    property var spellingPersonalWords: []
    function preferredSendAs(_r) { return null }
    function switchTo(_id) { return true }
    function refreshRecipientContacts() {}
    function send(_f) { return true }
    function copyText(_t) { return true }
    function clipboardAttachment(_dir, callback) { callback({ ok: false, error: "no-image" }); return true }
    function addPersonalWord(word) {
      if (word && spellingPersonalWords.indexOf(word) < 0) {
        var words = spellingPersonalWords.slice(); words.push(word); spellingPersonalWords = words
      }
    }
  }

  Omamail.KeyRouter {
    id: keyRouter
    context: "compose"
    onTriggered: function(id, sequence) {
      if (id === "spellingSuggestions") compose.openSpellingAtCaret()
    }
  }

  Omamail.ComposeView {
    id: compose
    onKeyPressed: function(event) { keyRouter.routeKeyEvent(event) }
    anchors.fill: parent
    service: mailService
    spellingPersonalWords: mailService.spellingPersonalWords
    textColor: Qt.rgba(1, 1, 1, 1)
    errorColor: Qt.rgba(1, 1, 1, 1)
    backgroundColor: Qt.rgba(0.06, 0.06, 0.06, 1)
    accentColor: Qt.rgba(1, 0.5, 0, 1)
    dimColor: Qt.rgba(0.67, 0.67, 0.67, 1)
    dimmerColor: Qt.rgba(0.47, 0.47, 0.47, 1)
    popupBackgroundColor: Qt.rgba(0.13, 0.13, 0.13, 1)
    popupBorderColor: Qt.rgba(0.3, 0.3, 0.3, 1)
    panelFontFamily: "sans"
  }

  TestCase {
    name: "ComposeSpellingMenu"
    when: windowShown

    function named(item, objectName) {
      if (!item) return null
      if (item.objectName === objectName) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var found = named(values[i], objectName)
        if (found) return found
      }
      return null
    }

    function body() { return named(compose, "compose-body-editor") }
    function menu() { return named(compose, "compose-text-menu") }

    function init() {
      compose.parent.forceActiveFocus()
      compose.begin("new", null, "", [])
      tryVerify(function() { return compose.spellingAdapter !== null || compose.spellingStatus === "no-module" }, 3000)
      if (!compose.spellingAvailable) skip("spelling unavailable (" + compose.spellingStatus + ")")
    }

    // Right-click the middle of a word and wait for the menu to open. The word
    // may already be present earlier in the text, so fromIndex selects which.
    function clickWord(editor, word, fromIndex) {
      var idx = editor.text.indexOf(word, fromIndex || 0)
      verify(idx >= 0, "the word is present: " + word)
      var startRect = editor.positionToRectangle(idx)
      var endRect = editor.positionToRectangle(idx + word.length)
      var cx = (startRect.x + endRect.x) / 2
      var cy = startRect.y + startRect.height / 2
      mouseClick(editor, cx, cy, Qt.RightButton)
      wait(20)
      return idx
    }

    function test_click_targets_the_word_not_the_caret() {
      var editor = body()
      editor.text = "a wrod here"
      editor.cursorPosition = editor.text.length // the caret sits in "here"
      clickWord(editor, "wrod")
      var m = menu()
      verify(m.opened, "the menu opened")
      compare(m.spellingWord, "wrod")
      compare(m.spellingMisspelled, true)
      var suggestion = m.spellingSuggestions[0]
      m.chooseSuggestion(0)
      wait(20)
      compare(editor.text, "a " + suggestion + " here")
    }

    function test_two_identical_words_correct_only_the_clicked_one() {
      var editor = body()
      editor.text = "a wrod and wrod here"
      clickWord(editor, "wrod", editor.text.indexOf("wrod") + 1) // the second one
      var m = menu()
      compare(m.spellingWord, "wrod")
      var suggestion = m.spellingSuggestions[0]
      m.chooseSuggestion(0)
      wait(20)
      compare(editor.text.indexOf("wrod"), 2) // the first is untouched
      compare(editor.text, "a wrod and " + suggestion + " here")
    }

    function test_emoji_prefix_still_targets_the_word() {
      var editor = body()
      editor.text = "the \uD83D\uDCE8 wrod here"
      clickWord(editor, "wrod")
      var m = menu()
      compare(m.spellingWord, "wrod")
      var suggestion = m.spellingSuggestions[0]
      m.chooseSuggestion(0)
      wait(20)
      compare(editor.text, "the \uD83D\uDCE8 " + suggestion + " here")
    }

    function test_a_selection_does_not_redirect_spelling() {
      var editor = body()
      editor.text = "a wrod here"
      editor.select(editor.text.indexOf("here"), editor.text.length)
      clickWord(editor, "wrod")
      var m = menu()
      // The spelling section targets the clicked word, never the selection.
      compare(m.spellingWord, "wrod")
      // But the selection is still present, so Cut and Copy stay available.
      verify(m.hasSelection, "the selection is still reported")
      m.chooseSuggestion(0)
      wait(20)
      verify(editor.text.indexOf("wrod") === -1)
    }

    function test_punctuation_and_newline_are_not_part_of_the_word() {
      var editor = body()
      editor.text = "a wrod, and mispelled.\nnext"
      clickWord(editor, "wrod")
      compare(menu().spellingWord, "wrod")
      menu().close()
      clickWord(editor, "mispelled")
      compare(menu().spellingWord, "mispelled")
    }

    function test_stale_document_aborts_the_correction() {
      var editor = body()
      editor.text = "a wrod here"
      clickWord(editor, "wrod")
      var m = menu()
      compare(m.spellingWord, "wrod")
      // The body is replaced while the menu is still open — the saved position
      // now points at a *different* misspelled word, so applying must not fire.
      editor.text = "a mispelled here"
      var before = editor.text
      m.chooseSuggestion(0)
      wait(20)
      compare(editor.text, before)
    }

    // A revision guard, not a word-string guard. Two occurrences of the same
    // misspelling make the string at the old position still spell `wrod`, so
    // comparing only the word would let an edit at the front of the draft
    // redirect the correction to the first occurrence.
    function test_stale_same_word_aborts_the_correction() {
      var editor = body()
      editor.text = "a wrod and wrod here"
      clickWord(editor, "wrod", editor.text.indexOf("wrod") + 1) // the second one
      var m = menu()
      compare(m.spellingWord, "wrod")
      // Insert text ahead of both words while the menu is open: positions shift
      // but the word string at the saved position is unchanged.
      editor.insert(0, "12345678 ")
      var before = editor.text
      m.chooseSuggestion(0)
      wait(20)
      compare(editor.text, before,
        "a changed document must refuse the correction even when the word repeats")
      compare(editor.text.indexOf("wrod"), before.indexOf("wrod"))
    }

    function test_no_suggestions_offers_ignore_and_add_but_no_rows() {
      var editor = body()
      editor.text = "a zxqjklv here "
      wait(250)
      compare(compose.spellingRanges.length, 1)
      clickWord(editor, "zxqjklv")
      var m = menu()
      compare(m.spellingMisspelled, true)
      compare(m.spellingSuggestions.length, 0)
      verify(m.ignoreWordRow.visible, "Ignore is offered without suggestions")
      verify(m.addToDictionaryRow.visible, "Add to dictionary is offered without suggestions")
      m.ignoreWordRow.activated()
      wait(250)
      compare(compose.spellingRanges.length, 0)
    }

    function test_keyboard_accepts_the_first_suggestion() {
      var editor = body()
      editor.text = "a wrod here"
      clickWord(editor, "wrod")
      var m = menu()
      // The cursor starts on the first usable row, which is the first
      // suggestion; Enter/O runs it without touching the mouse.
      compare(m.cursorIndex, 0)
      var suggestion = m.spellingSuggestions[0]
      m.runCursor()
      wait(20)
      compare(editor.text, "a " + suggestion + " here")
    }

    function test_keyboard_opens_ignore_and_add_without_suggestions() {
      var editor = body()
      editor.text = "the zxqjklv here "
      editor.cursorPosition = 8
      compare(compose.spellingAdapter.inspect(8).suggestions.length, 0)
      editor.forceActiveFocus()
      keyClick(Qt.Key_Period, Qt.ControlModifier)
      tryCompare(menu(), "opened", true)
      compare(menu().spellingMisspelled, true)
      verify(menu().ignoreWordRow.visible)
      verify(menu().addToDictionaryRow.visible)
      menu().close()
    }

    function test_menu_ignore_preserves_clean_draft_and_revision() {
      var editor = body()
      editor.text = "the zqxjmenureviewhere here "
      editor.forceActiveFocus()
      compose.userModified = false
      compose.bodyWasEdited = false
      var before = editor.text
      var revision = compose.bodyRevision
      clickWord(editor, "zqxjmenureviewhere")
      menu().ignoreWordRow.activated()
      wait(250)
      compare(editor.text, before)
      compare(compose.userModified, false)
      compare(compose.bodyWasEdited, false)
      compare(compose.bodyRevision, revision)
      compare(compose.spellingRanges.length, 0)
    }

    function test_opening_and_closing_never_edits_or_dirties() {
      var editor = body()
      editor.text = "a wrod here"
      var before = editor.text
      clickWord(editor, "wrod")
      var m = menu()
      verify(m.opened, "the menu opened")
      m.close()
      compare(editor.text, before)
      compare(compose.userModified, false)
      compare(compose.bodyWasEdited, false)
    }

    function test_a_menu_correction_is_one_undo_away() {
      var editor = body()
      editor.text = "a wrod here"
      clickWord(editor, "wrod")
      var m = menu()
      var before = editor.text
      m.chooseSuggestion(0)
      wait(20)
      verify(editor.text !== before)
      editor.undo()
      compare(editor.text, before)
    }

    function test_a_correction_marks_the_draft_dirty() {
      var editor = body()
      editor.text = "a wrod here"
      clickWord(editor, "wrod")
      var m = menu()
      m.chooseSuggestion(0)
      wait(20)
      compare(compose.bodyWasEdited, true)
      compare(compose.userModified, true)
    }
  }
}
