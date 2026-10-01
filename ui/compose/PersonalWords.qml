import QtQuick
import Quickshell.Io
import "Spelling.js" as Spelling

// App-owned personal spelling words, persisted as spelling.json beside the
// window state and applied by the composer. Never written to a global
// dictionary.
//
// The write is a queue rather than a one-shot. A second word added while the
// first write is still in flight must reach disk too, and an add that lands
// before the initial file read finishes must survive the read.
Item {
  id: store
  visible: false

  // The service owns both file boundaries: configPath() and writeConfig().
  required property var service

  property var words: []
  property bool loaded: false
  property bool writing: false
  property bool pending: false
  property string error: ""

  // Replace the list. The file load uses `merge` below; this is the explicit
  // reset form and what the tests drive.
  function apply(raw) {
    words = Spelling.normalizePersonalWords(raw)
    loaded = true
    if (pending) save()
  }

  // A load that arrives after the user has already added a word must union,
  // not replace: the in-memory additions are this session's intent and the
  // disk copy is yesterday's.
  function merge(raw) {
    words = Spelling.mergePersonalWords(words, raw)
    loaded = true
    if (pending) save()
  }

  function save() {
    // Before the load completes, remember that there is something to write so
    // the load can flush it rather than dropping it.
    if (!loaded || writing) { pending = true; return }
    writing = true
    pending = false
    service.writeConfig("spelling.json", JSON.stringify({ words: words }), function(ok, failure) {
      store.writing = false
      // The write boundaries can refuse the file (a host allowlist that has
      // not been told about it, a full disk): keep the failure where the
      // Settings page can say so instead of pretending the word saved.
      store.error = ok ? "" : String(failure || "Could not save personal words")
      if (store.pending) store.save()
    })
  }

  function add(word) {
    var value = String(word || "")
    if (value === "" || words.indexOf(value) >= 0) return
    var next = words.slice()
    next.push(value)
    words = next
    save()
  }

  function remove(word) {
    var value = String(word || "")
    var at = words.indexOf(value)
    if (at < 0) return
    var next = words.slice()
    next.splice(at, 1)
    words = next
    save()
  }

  FileView {
    path: store.service.configPath("spelling.json")
    printErrors: false
    // Merge rather than replace: a word added before the read returned is this
    // session's and must not be undone by yesterday's file.
    onLoaded: store.merge(text())
    onLoadFailed: store.merge("")
  }
}
