import QtQuick
import QtTest

// Probe: proves the real Sonnet QML highlighter behaviour the spelling
// adapter depends on. It loads Sonnet through a Loader so this file has no
// mandatory org.kde.sonnet import, and skips (rather than fails) where Sonnet
// or the en_US dictionary is absent.
Item {
  id: root
  width: 800
  height: 220

  // The surrogate pair in the emoji is two UTF-16 units, which is what makes
  // the offset check below meaningful.
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
    source: "SpellcheckProbe.qml"
    onLoaded: item.editor = edit
  }

  TestCase {
    name: "SpellcheckProbe"
    when: windowShown

    function init() { edit.text = root.sample }

    // Returns the probe component, or null after asking to skip when Sonnet or
    // the dictionary is unavailable.
    function component() {
      if (loader.status === Loader.Error || !loader.item) {
        skip("org.kde.sonnet QML module unavailable (loader status " + loader.status + ")")
        return null
      }
      var probe = loader.item
      probe.setLanguage("en_US")
      if (!probe.available || probe.language !== "en_US") {
        skip("en_US dictionary unavailable (language " + probe.language + ", available " + probe.available + ")")
        return null
      }
      return probe
    }

    function test_availability_and_language() {
      var probe = component()
      if (!probe) return
      compare(probe.available, true)
      compare(probe.language, "en_US")
    }

    function test_suggestions_and_utf16_offsets() {
      var probe = component()
      if (!probe) return
      // "ok <emoji> wrod": emoji occupies two UTF-16 units, so wrod starts at 6.
      compare(edit.text.indexOf("wrod"), 6)
      var atWrod = probe.suggestionsAt(6, 5)
      verify(atWrod.length > 0)
      compare(String(atWrod[0]), "word")
      verify(probe.suggestionsAt(edit.text.indexOf("mispelled"), 5).length > 0)
      // A correct word yields no suggestions.
      compare(probe.suggestionsAt(edit.text.indexOf("sentence"), 5).length, 0)
    }

    function test_is_word_misspelled() {
      var probe = component()
      if (!probe) return
      compare(probe.isMisspelled("wrod"), true)
      compare(probe.isMisspelled("mispelled"), true)
      compare(probe.isMisspelled("sentence"), false)
      compare(probe.isMisspelled("don't"), false)
    }

    function test_correction_integrates_with_undo() {
      var probe = component()
      if (!probe) return
      var before = edit.text
      // replaceWord selects a length that only suggestions() has set, so the
      // correction must be primed by asking for suggestions at the same
      // position first. Without it Sonnet inserts instead of replacing.
      probe.suggestionsAt(6, 5)
      probe.replaceWord("word", 6)
      verify(edit.text !== before)
      compare(edit.text.indexOf("word and"), 6)
      edit.undo()
      compare(edit.text, before)
    }

    function test_ignore_is_session_only() {
      var probe = component()
      if (!probe) return
      compare(probe.isMisspelled("qqzzx"), true)
      probe.ignore("qqzzx")
      compare(probe.isMisspelled("qqzzx"), false)
    }

    function test_disabling_does_not_mutate_text() {
      var probe = component()
      if (!probe) return
      var before = edit.text
      probe.active = false
      compare(edit.text, before)
      probe.active = true
    }
  }
}
