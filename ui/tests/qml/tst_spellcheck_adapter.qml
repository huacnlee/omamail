import QtQuick
import QtTest

// The optional spelling adapter's contract.
// The adapter is loaded through a Loader so this file has no mandatory
// org.kde.sonnet import and skips where Sonnet or en_US is unavailable.
Item {
  id: root
  width: 800
  height: 200

  readonly property string sample: "ok \uD83D\uDCE8 wrod and mispelled; don't TEH. A correct sentence follows here."

  TextEdit {
    id: edit
    anchors.fill: parent
    textFormat: TextEdit.PlainText
    font.pixelSize: 18
    wrapMode: TextEdit.Wrap
    text: root.sample
  }

  Loader {
    id: loader
    source: "../../compose/SpellcheckAdapter.qml"
    onLoaded: {
      item.document = edit.textDocument
      item.enabled = true
      item.language = "en_US"
    }
  }

  TestCase {
    name: "SpellcheckAdapter"
    when: windowShown

    function init() { edit.text = root.sample }

    function adapter() {
      if (loader.status === Loader.Error || !loader.item) {
        skip("org.kde.sonnet QML module unavailable (loader status " + loader.status + ")")
        return null
      }
      var a = loader.item
      if (!a.available) {
        skip("en_US dictionary unavailable (status " + a.status + ")")
        return null
      }
      return a
    }

    function test_ready_and_status() {
      var a = adapter()
      if (!a) return
      compare(a.available, true)
      compare(a.status, "ready")
    }

    function test_inspect_word_misspelling_and_suggestions() {
      var a = adapter()
      if (!a) return
      var at = edit.text.indexOf("wrod")
      compare(at, 6)
      var info = a.inspect(at)
      compare(info.word, "wrod")
      compare(info.misspelled, true)
      verify(info.suggestions.length > 0)
      compare(String(info.suggestions[0]), "word")
      // A correct word is not reported as misspelled.
      var ok = a.inspect(edit.text.indexOf("sentence"))
      compare(ok.misspelled, false)
    }

    function test_correction_is_undo_safe_and_does_not_touch_other_words() {
      var a = adapter()
      if (!a) return
      var before = edit.text
      verify(a.applyCorrection(6, "word"))
      verify(edit.text !== before)
      compare(edit.text.indexOf("word and"), 6)
      edit.undo()
      compare(edit.text, before)
    }

    function test_disable_does_not_mutate_text() {
      var a = adapter()
      if (!a) return
      a.enabled = false
      compare(a.status, "disabled")
      a.enabled = true
      compare(a.status, "ready")
      compare(edit.text, root.sample)
    }

    function test_misspelled_ranges_are_only_finished_words() {
      var a = adapter()
      if (!a) return
      // Nothing follows the word: still being typed, so not marked yet.
      compare(a.misspelledRanges("wrod").length, 0)
      // A delimiter finished it.
      compare(a.misspelledRanges("wrod ").length, 1)
      // The trailing word is skipped; the finished one before it is not.
      var one = a.misspelledRanges("a wrod and mispelled")
      compare(one.length, 1)
      compare(one[0].start, 2)
      compare(one[0].end, 6)
      compare(a.misspelledRanges("a wrod and mispelled ").length, 2)
    }

    function test_misspelled_ranges_use_utf16_offsets() {
      var a = adapter()
      if (!a) return
      // "the " is four units, the emoji is two more, so wrod starts at 7.
      var ranges = a.misspelledRanges("the \uD83D\uDCE8 wrod ")
      compare(ranges.length, 1)
      compare(ranges[0].start, 7)
      compare(ranges[0].end, 11)
    }

    function test_personal_words_are_treated_as_correct() {
      var a = adapter()
      if (!a) return
      // A word unique to this test: ignore is process-global and irreversible,
      // so ignoring a word another test uses would make that test depend on
      // order.
      edit.text = "zqxjw zqxjw"
      compare(a.inspect(0).misspelled, true)
      a.personalWords = ["zqxjw"]
      compare(a.inspect(0).misspelled, false)
      // Applying personal words never disables the checker for other words.
      compare(a.available, true)
      edit.text = root.sample
      compare(a.inspect(edit.text.indexOf("wrod")).misspelled, true)
    }
  }
}
