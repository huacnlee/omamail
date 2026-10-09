import QtQuick
import org.kde.sonnet as Sonnet

// Probe component: the only file under tests/ that imports org.kde.sonnet.
// It is loaded through a Loader so a machine without the module reports a
// loader error to the probe instead of failing the whole test file to import.
//
// This isolates the Sonnet runtime behavior used by the production adapter.
Item {
  id: probe

  // The TextEdit whose text document is checked. Set by the caller after the
  // Loader has created the item.
  property var editor: null

  readonly property bool available: highlighter.spellCheckerFound
  readonly property string language: highlighter.currentLanguage

  // Whether underlines are drawn. Independent of the query functions.
  property alias active: highlighter.active
  property alias automatic: highlighter.automatic

  //Suggestions for the word at a UTF-16 character position in the document.
  function suggestionsAt(position, max) { return highlighter.suggestions(position, max) }
  function isMisspelled(word) { return highlighter.isWordMisspelled(word) }
  function replaceWord(word, at) { highlighter.replaceWord(word, at) }
  // Session-only: process-wide, never written to disk by Sonnet.
  function ignore(word) { highlighter.ignoreWord(word) }
  function setLanguage(language) { highlighter.setCurrentLanguage(language) }

  onEditorChanged: if (editor !== null) highlighter.document = editor.textDocument

  Sonnet.SpellcheckHighlighter {
    id: highlighter
    active: true
    automatic: false
    // misspelledColor is not set: it has no effect on the rendered underline
    // (always Qt's fixed red spell-check underline), and this repository
    // forbids literal colours in QML anyway.
  }
}
