import QtQuick
import Quickshell
import Quickshell.Io

import "Cache.js" as Cache

// Message bodies on disk, one file per message.
//
// A body never changes once fetched, so a hit is always correct — which makes
// this the cache worth keeping deep. It is deliberately not held in memory: a
// thousand bodies is tens of megabytes, and keeping them in the account's store
// meant re-serialising all of it on the GUI thread whenever anything else in
// the store moved.
//
// Reads are therefore asynchronous, and the caller has to cope with the answer
// arriving after the network's. That is the right trade: the alternative is
// reading a file synchronously on the thread that paints.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property string pluginDir

  readonly property string cacheHome: Quickshell.env("XDG_CACHE_HOME")
    || (Quickshell.env("HOME") + "/.cache")

  // One directory per account, named the way the account's store file is, so
  // the two can be matched by eye and neither can leave the cache directory.
  property string accountId: ""
  readonly property string directory: cacheHome + "/omamail/bodies/"
    + Cache.bodyDirName(accountId)

  readonly property string script: pluginDir + "/scripts/body-cache.sh"

  // ------------------------------------------------------------------ read

  property var pendingCallback: null

  function read(id, callback) {
    var name = Cache.bodyFileName(id)
    if (name === "") {
      if (typeof callback === "function") callback(null)
      return
    }
    pendingCallback = callback
    var wanted = directory + "/" + name
    // Setting the same path again does not reload on its own, and reopening the
    // message you just closed has to hit the file rather than the last answer.
    if (reader.path === wanted) reader.reload()
    else reader.path = wanted
  }

  function deliver(body) {
    var callback = pendingCallback
    pendingCallback = null
    if (typeof callback === "function") callback(body)
  }

  // A hit is a use, and mtime is what eviction sorts on, so the file has to be
  // stamped. Detached because nothing waits on the result.
  function touch(id) {
    var name = Cache.bodyFileName(id)
    if (name === "") return
    Quickshell.execDetached([script, "touch", directory, name])
  }

  FileView {
    id: reader
    printErrors: false
    onLoaded: root.deliver(Cache.parseBody(text()))
    // Never cached, or cached under an account that has since been removed.
    onLoadFailed: root.deliver(null)
  }

  // ----------------------------------------------------------------- write

  // At most one write runs at a time, and only the newest queued body is kept:
  // they are independent files, but a burst would otherwise start a process per
  // message. Opening messages faster than the disk can keep up should cost a
  // cache miss, never a pile of processes.
  property var writeQueue: []

  // Named "put" rather than "write" so it cannot be confused — by a reader or
  // by QML's scope resolution — with the Process.write() below.
  function put(id, body) {
    var name = Cache.bodyFileName(id)
    if (name === "") return
    var next = writeQueue.slice()
    next.push(({ name: name, payload: Cache.serializeBody(body) }))
    writeQueue = next
    drain()
  }

  function drain() {
    if (writer.running || writeQueue.length === 0) return
    var job = writeQueue[0]
    writeQueue = writeQueue.slice(1)
    writer.payload = job.payload
    writer.command = [script, "put", directory, job.name, String(Cache.MAX_BODIES)]
    writer.running = true
  }

  function clear() {
    writeQueue = []
    Quickshell.execDetached([script, "clear", directory])
  }

  Process {
    id: writer
    property string payload: ""
    stdinEnabled: true
    onStarted: {
      write(payload + "\n")
      payload = ""
    }
    onExited: {
      payload = ""
      root.drain()
    }
  }
}
