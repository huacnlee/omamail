import QtQuick
import QtTest
import "../../components" as Omamail

// The real composer attaches the optional spelling adapter to its body
// document, does not change the draft while checking, and unloads cleanly when
// disabled. Underlines are proven by the adapter contract test and the Sonnet
// probe; here the point is the wiring, not the highlighter.
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
    name: "ComposeSpelling"
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

    function init() {
      compose.begin("new", null, "", [])
      // Reset the layout and the requested language: an earlier case may have
      // narrowed the composer or pointed at a dictionary that is not here.
      compose.parent.width = 900
      compose.contentDirection = ""
      compose.spellingEnabled = true
      compose.spellingLanguage = "en_US"
    }

    function test_body_adapter_attaches_and_checking_does_not_mutate() {
      var body = named(compose, "compose-body-editor")
      verify(body, "the composer owns a body editor")
      tryVerify(function() { return compose.spellingAdapter !== null || compose.spellingStatus === "no-module" }, 3000)
      if (!compose.spellingAvailable) {
        skip("spelling unavailable (" + compose.spellingStatus + ")")
        return
      }
      body.text = "This sentance has a mispelled wrod."
      var before = body.text
      var info = compose.spellingAdapter.inspect(body.text.indexOf("mispelled"))
      compare(info.misspelled, true)
      compare(info.word, "mispelled")
      // Merely inspecting must not change the draft.
      compare(body.text, before)
    }

    function test_session_ignore_refreshes_a_separate_composer_document() {
      var body = named(compose, "compose-body-editor")
      tryVerify(function() { return compose.spellingAdapter !== null || compose.spellingStatus === "no-module" }, 3000)
      if (!compose.spellingAvailable) { skip("spelling unavailable (" + compose.spellingStatus + ")"); return }
      body.text = "the zqxjremotereviewhere here "
      tryCompare(compose, "spellingRanges", [{ start: 4, end: 24 }])
      var component = Qt.createComponent("../../compose/SpellcheckAdapter.qml")
      compare(component.status, Component.Ready)
      var secondDoc = Qt.createQmlObject('import QtQuick; TextEdit { text: "zqxjremotereviewhere " }', compose)
      var second = component.createObject(compose, { document: secondDoc.textDocument })
      try {
        verify(second.available)
        second.ignoreForSession("zqxjremotereviewhere")
        tryVerify(function() { return compose.spellingRanges.length === 0 })
        compare(compose.spellingAdapter.inspect(6).misspelled, false)
      } finally {
        second.destroy()
        secondDoc.destroy()
      }
    }

    function test_personal_words_preserve_focused_draft_selection_and_undo() {
      var body = named(compose, "compose-body-editor")
      tryVerify(function() { return compose.spellingAdapter !== null || compose.spellingStatus === "no-module" }, 3000)
      if (!compose.spellingAvailable) { skip("spelling unavailable (" + compose.spellingStatus + ")"); return }
      body.text = "the zqxjpersonalreviewhere here "
      body.forceActiveFocus()
      body.select(4, 9)
      compose.userModified = false
      compose.bodyWasEdited = false
      var before = body.text
      var selected = body.selectedText
      var revision = compose.bodyRevision
      var undoAvailable = body.canUndo
      mailService.addPersonalWord("zqxjpersonalreviewhere")
      wait(250)
      compare(body.text, before)
      compare(body.selectedText, selected)
      compare(body.canUndo, undoAvailable)
      compare(compose.userModified, false)
      compare(compose.bodyWasEdited, false)
      compare(compose.bodyRevision, revision)
      compare(compose.spellingRanges.length, 0)
    }

    function test_a_correction_changes_the_body_and_undo_restores_it() {
      var body = named(compose, "compose-body-editor")
      verify(body)
      tryVerify(function() { return compose.spellingAdapter !== null || compose.spellingStatus === "no-module" }, 3000)
      if (!compose.spellingAvailable) { skip("spelling unavailable"); return }
      body.text = "a mispelled wrod here"
      var before = body.text
      var at = body.text.indexOf("mispelled")
      var info = compose.spellingAdapter.inspect(at)
      compose.spellingAdapter.applyCorrection(at, info.suggestions[0])
      verify(body.text !== before)
      body.undo()
      compare(body.text, before)
    }

    function test_underline_ranges_require_a_finished_word() {
      var body = named(compose, "compose-body-editor")
      verify(body)
      tryVerify(function() { return compose.spellingAdapter !== null || compose.spellingStatus === "no-module" }, 3000)
      if (!compose.spellingAvailable) { skip("spelling unavailable"); return }
      body.text = "a wrod"
      wait(250) // past the debounce
      compare(compose.spellingRanges.length, 0)
      body.text = "a wrod "
      wait(250)
      compare(compose.spellingRanges.length, 1)
      compare(compose.spellingRanges[0].start, 2)
      compare(compose.spellingRanges[0].end, 6)
    }

    function test_right_click_offers_suggestions_for_the_clicked_word() {
      var body = named(compose, "compose-body-editor")
      tryVerify(function() { return compose.spellingAdapter !== null || compose.spellingStatus === "no-module" }, 3000)
      if (!compose.spellingAvailable) { skip("spelling unavailable"); return }
      body.text = "a mispelled wrod "
      wait(250)
      var box = body.positionToRectangle(body.text.indexOf("mispelled"))
      mouseClick(body, box.x + 2, box.y + box.height / 2, Qt.RightButton)
      wait(20)
      var menu = named(compose, "compose-text-menu")
      verify(menu.opened, "the text menu opened")
      compare(menu.spellingMisspelled, true)
      compare(menu.spellingWord, "mispelled")
      verify(menu.spellingSuggestions.length > 0)
      // Choosing the first suggestion replaces the clicked word.
      menu.chooseSuggestion(0)
      wait(20)
      verify(body.text.indexOf("mispelled") === -1)
    }

    function test_ignore_for_session_stops_marking_the_word() {
      var body = named(compose, "compose-body-editor")
      tryVerify(function() { return compose.spellingAdapter !== null || compose.spellingStatus === "no-module" }, 3000)
      if (!compose.spellingAvailable) { skip("spelling unavailable"); return }
      body.text = "the floobert here "
      wait(250)
      compare(compose.spellingRanges.length, 1)
      var box = body.positionToRectangle(body.text.indexOf("floobert"))
      mouseClick(body, box.x + 2, box.y + box.height / 2, Qt.RightButton)
      wait(20)
      var menu = named(compose, "compose-text-menu")
      compare(menu.spellingWord, "floobert")
      menu.ignoreWordRow.activated()
      wait(250)
      compare(compose.spellingRanges.length, 0)
    }

    function test_add_to_dictionary_stops_marking_the_word() {
      var body = named(compose, "compose-body-editor")
      tryVerify(function() { return compose.spellingAdapter !== null || compose.spellingStatus === "no-module" }, 3000)
      if (!compose.spellingAvailable) { skip("spelling unavailable"); return }
      body.text = "the blorptar here "
      wait(250)
      compare(compose.spellingRanges.length, 1)
      var box = body.positionToRectangle(body.text.indexOf("blorptar"))
      mouseClick(body, box.x + 2, box.y + box.height / 2, Qt.RightButton)
      wait(20)
      var menu = named(compose, "compose-text-menu")
      compare(menu.spellingWord, "blorptar")
      menu.addToDictionaryRow.activated()
      wait(250)
      compare(compose.spellingRanges.length, 0)
    }

    function test_ctrl_period_opens_suggestions_at_the_caret_word() {
      var body = named(compose, "compose-body-editor")
      tryVerify(function() { return compose.spellingAdapter !== null || compose.spellingStatus === "no-module" }, 3000)
      if (!compose.spellingAvailable) { skip("spelling unavailable"); return }
      body.text = "the mispelled here "
      wait(250)
      body.cursorPosition = body.text.indexOf("mispelled") + 2
      body.forceActiveFocus()
      keyClick(Qt.Key_Period, Qt.ControlModifier)
      wait(20)
      var menu = named(compose, "compose-text-menu")
      verify(menu.opened, "the caret shortcut opened the menu")
      compare(menu.spellingWord, "mispelled")
      verify(menu.spellingSuggestions.length > 0)
    }

    // The adapter's language follows the setting after load, and availability
    // is about the requested dictionary: a missing one reads no-dictionary and
    // switching back recovers, with no silent fallback to English.
    function test_language_follows_the_setting_and_reports_a_missing_dictionary() {
      tryVerify(function() { return compose.spellingAdapter !== null || compose.spellingStatus === "no-module" }, 3000)
      if (!compose.spellingAvailable) { skip("spelling unavailable (" + compose.spellingStatus + ")"); return }
      compose.spellingLanguage = "en_US"
      tryVerify(function() { return compose.spellingStatus === "ready" }, 3000)
      compose.spellingLanguage = "zz_ZZ"
      tryVerify(function() { return compose.spellingStatus === "no-dictionary" }, 3000)
      compare(compose.spellingAvailable, false)
      compose.spellingLanguage = "en_US"
      tryVerify(function() { return compose.spellingStatus === "ready" }, 3000)
      compare(compose.spellingAvailable, true)
    }

    // The underline is positioned from positionToRectangle(), which reads the
    // editor's width, wrap and font in C++. The binding has to name those
    // inputs, or a wrapped word keeps an underline where the word used to be.
    function test_underline_follows_the_editor_when_it_resizes() {
      var body = named(compose, "compose-body-editor")
      verify(body)
      tryVerify(function() { return compose.spellingAdapter !== null || compose.spellingStatus === "no-module" }, 3000)
      if (!compose.spellingAvailable) { skip("spelling unavailable (" + compose.spellingStatus + ")"); return }
      body.text = "hello hello hello hello hello hello hello hello hello hello hello hello wrod here "
      wait(250)
      compare(compose.spellingRanges.length, 1)
      var start = compose.spellingRanges[0].start
      var underline = named(compose, "spelling-underline")
      verify(underline, "a misspelled word draws an underline")
      var wide = body.positionToRectangle(start)
      fuzzyCompare(underline.x, wide.x, 1.0)
      compose.parent.width = 300
      wait(100)
      var narrow = body.positionToRectangle(start)
      verify(narrow.x !== wide.x || narrow.y !== wide.y,
        "the narrower editor re-wraps the word")
      underline = named(compose, "spelling-underline")
      verify(underline, "the reflow rebuilt the underline")
      fuzzyCompare(underline.x, narrow.x, 1.0)
      fuzzyCompare(underline.y, narrow.y + narrow.height - underline.height, 1.0)
    }

    function test_underline_follows_changed_content_alignment() {
      var body = named(compose, "compose-body-editor")
      tryVerify(function() { return compose.spellingAdapter !== null || compose.spellingStatus === "no-module" }, 3000)
      if (!compose.spellingAvailable) { skip("spelling unavailable"); return }
      body.text = "wrod "
      tryVerify(function() { return named(compose, "spelling-underline") !== null })
      var beforeX = body.positionToRectangle(0).x
      compose.contentDirection = "Right to left"
      wait(100)
      var underline = named(compose, "spelling-underline")
      verify(underline)
      var at = body.positionToRectangle(0)
      verify(at.x !== beforeX, "the content alignment moved the word")
      fuzzyCompare(underline.x, at.x, 1.0)
      compose.contentDirection = ""
    }

    function countUnderlines(item) {
      var count = item.objectName === "spelling-underline" ? 1 : 0
      var children = item.children || []
      for (var i = 0; i < children.length; i++) count += countUnderlines(children[i])
      return count
    }

    function test_underline_covers_a_word_split_across_lines() {
      var body = named(compose, "compose-body-editor")
      tryVerify(function() { return compose.spellingAdapter !== null || compose.spellingStatus === "no-module" }, 3000)
      if (!compose.spellingAvailable) { skip("spelling unavailable"); return }
      compose.parent.width = 300
      body.text = "zqxjverylongmisspellingcontinuedacrossmultiplelineswithoutspaces "
      tryCompare(compose, "spellingRanges", [{ start: 0, end: body.text.length - 1 }])
      verify(body.positionToRectangle(0).y !== body.positionToRectangle(body.text.length - 1).y)
      tryVerify(function() { return countUnderlines(body) > 1 })
    }

    function test_disabling_unloads_the_adapter_and_re_enabling_restores_it() {
      tryVerify(function() { return compose.spellingAdapter !== null || compose.spellingStatus === "no-module" }, 3000)
      if (!compose.spellingAvailable) { skip("spelling unavailable (" + compose.spellingStatus + ")"); return }
      compose.spellingEnabled = false
      tryVerify(function() { return compose.spellingAdapter === null }, 3000)
      compare(compose.spellingStatus, "disabled")
      compose.spellingEnabled = true
      tryVerify(function() { return compose.spellingAdapter !== null || compose.spellingStatus === "no-module" }, 3000)
      compare(compose.spellingAvailable, true)
    }

    // Switching between two *available* dictionaries must re-run the underline
    // ranges: availability stays true, so only a language-change refresh keeps
    // the old dictionary's underlines from lingering.
    function test_a_valid_to_valid_language_switch_rechecks_ranges() {
      var body = named(compose, "compose-body-editor")
      tryVerify(function() { return compose.spellingAdapter !== null || compose.spellingStatus === "no-module" }, 3000)
      if (!compose.spellingAvailable) { skip("spelling unavailable (" + compose.spellingStatus + ")"); return }

      compose.spellingLanguage = "en_GB"
      tryVerify(function() {
        return compose.spellingStatus === "ready" || compose.spellingStatus === "no-dictionary"
      }, 3000)
      if (compose.spellingStatus !== "ready") {
        compose.spellingLanguage = "en_US"
        skip("en_GB dictionary unavailable"); return
      }

      // British spellings are misspelled in en_US and correct in en_GB.
      var sample = "colour favourite cancelled organise centre metre neighbour travelling"
      compose.spellingLanguage = "en_US"
      body.text = sample + " "
      wait(250)
      var usRanges = compose.spellingRanges.length
      verify(usRanges > 0, "en_US marks the British spellings")

      compose.spellingLanguage = "en_GB"
      wait(250)
      var live = JSON.stringify(compose.spellingRanges)
      var actual = JSON.stringify(compose.spellingAdapter.misspelledRanges(body.text))
      compare(live, actual, "ranges recheck after a valid-to-valid switch")
      verify(compose.spellingRanges.length < usRanges, "en_GB accepts the British spellings")
    }
  }
}
