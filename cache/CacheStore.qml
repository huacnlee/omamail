import QtQuick
import Quickshell
import Quickshell.Io

import "Cache.js" as Cache

// The cache's file. Cache.js decides what the cache contains; this decides
// when it touches the disk.
//
// Writes are debounced and atomic: the whole store is one document, so a save
// during a burst of loads would otherwise rewrite it a dozen times, and a
// half-written file would read back as a corrupt cache on the next start.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  readonly property string cacheHome: Quickshell.env("XDG_CACHE_HOME")
    || (Quickshell.env("HOME") + "/.cache")
  readonly property string directory: cacheHome + "/omamail"

  // One file per account. A shared file would mean every switch discarded the
  // cache of the account being switched to, which is the whole point of having
  // one. The name is derived from the address and can never leave the
  // directory — see Cache.fileName.
  property string accountId: ""
  readonly property string path: directory + "/" + Cache.fileName(accountId)

  property var store: Cache.emptyStore()
  property bool loaded: false

  signal restored()

  function get(key) { return Cache.getQuery(store, key) }

  function putQuery(key, page) {
    store = Cache.putQuery(store, key, page, Date.now())
    scheduleSave()
  }

  function putLabels(labels) {
    store = Cache.putLabels(store, labels, Date.now())
    scheduleSave()
  }

  function putProfile(profile) {
    store = Cache.putProfile(store, profile, Date.now())
    scheduleSave()
  }

  // Called once the mailbox address is known. A cache belongs to one mailbox,
  // so a different address starts from nothing rather than showing one
  // account's mail under another's name.
  function bindAccount(email) {
    var next = Cache.forAccount(store, email)
    if (next === store) return
    if (next.account !== store.account) {
      store = next
      scheduleSave()
    }
  }

  function clear() {
    store = Cache.emptyStore()
    scheduleSave()
  }

  function scheduleSave() {
    if (loaded) saveTimer.restart()
  }

  Component.onCompleted: directoryMaker.running = true

  // Switching accounts swaps the file underneath, so what is in memory belongs
  // to the account that just left.
  onAccountIdChanged: {
    loaded = false
    store = Cache.emptyStore()
    if (directoryMaker.running) return
    file.reload()
  }

  // The store holds the subject, sender and snippet of every message that has
  // been listed — the same mail the body files beside it are kept 0600 for. So
  // the directory is closed to everyone else: FileView writes with whatever
  // umask the shell process happens to have, and the directory is the only
  // place this can set the mode itself.
  Process {
    id: directoryMaker
    // The path arrives as an argument rather than inside the script, so nothing
    // in it can be read as shell.
    command: ["sh", "-c", "umask 077; mkdir -p \"$1\" && chmod 700 \"$1\"", "sh", root.directory]
    onExited: file.reload()
  }

  FileView {
    id: file
    path: root.path
    atomicWrites: true
    printErrors: false

    onLoaded: {
      root.store = Cache.load(text())
      root.loaded = true
      root.restored()
    }
    // No cache yet is the ordinary first-run state, not an error.
    onLoadFailed: {
      root.store = Cache.emptyStore()
      root.loaded = true
      root.restored()
    }
  }

  Timer {
    id: saveTimer
    interval: 800
    onTriggered: {
      root.store = Cache.prune(root.store)
      file.setText(Cache.serialize(root.store))
    }
  }
}
