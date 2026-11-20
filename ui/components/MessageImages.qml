import QtQuick
import "../message/Images.js" as Images

// Where the image viewer's pictures come from, and where Save and Open send
// them, for the message open in the reader.
//
// Attachment bytes are never drawn as the provider returned them: the backend
// sniffs, shrinks and refuses them (`attachment.image`, API 10) the way it does
// a fetched picture. It reads them from the message it already downloaded when
// it can, so nothing is fetched twice; otherwise the viewer, which somebody
// asked for, falls back to the provider's own fetch. An older backend has no
// such method, and attachments then open in another application as before.
QtObject {
  id: root

  property var service: null

  readonly property var backend: service ? service.backend : null
  readonly property bool available: !!backend && backend.ready === true
    && Number(backend.apiVersion) >= 10
  // The message the cache and every answer below belong to. A reply for a
  // message no longer open is dropped rather than drawn over the next one.
  readonly property string messageKey: service ? String(service.selectedId || "") : ""
  property var cache: ({})
  onMessageKeyChanged: { cache = ({}); pendingSave = null }

  function current(key) { return key === messageKey && key !== "" }

  function remember(attachment, data) {
    var next = ({})
    for (var k in cache) next[k] = cache[k]
    next[String(attachment.attachmentId)] = data
    cache = next
  }

  // The prepared picture for one attachment, "" when it is not one this can
  // show. `network` allows the provider fetch when the downloaded message
  // does not carry the bytes.
  function attachmentImage(attachment, network, done) {
    var finish = typeof done === "function" ? done : function() {}
    if (!available || !Images.viewable(attachment)) { finish(""); return }
    var id = String(attachment.attachmentId)
    if (Object.prototype.hasOwnProperty.call(cache, id)) { finish(cache[id]); return }
    var key = messageKey
    var reading = service.reading
    if (!reading) { finish(""); return }
    backend.call("attachment.image", {
      accountId: String(reading.accountId || ""),
      id: String(reading.selectedId || ""),
      attachmentId: id
    }, function(result, error) {
      if (!root.current(key)) return
      if (!error && result && result.data) {
        root.remember(attachment, String(result.data))
        finish(String(result.data))
        return
      }
      var reason = error ? String(error.message || "") : ""
      if (reason !== "attachment_image_unavailable" || network !== true) {
        if (reason === "public_image_refused") root.remember(attachment, "")
        finish("")
        return
      }
      root.fetchAndPrepare(attachment, key, finish)
    })
  }

  // The backend prepares at most 16 MiB of bytes; a larger attachment is not
  // downloaded only to be refused.
  readonly property real maxPictureBytes: 16 * 1024 * 1024
  function fetchAndPrepare(attachment, key, finish) {
    if ((Number(attachment.size) || 0) > maxPictureBytes) { finish("", "large"); return }
    service.loadAttachments(key, [attachment], function(loaded, failure) {
      if (!root.current(key)) return
      var data = !failure && loaded && loaded.length > 0 ? String(loaded[0].data || "") : ""
      // Not remembered: the next look, or Try again, asks the provider again.
      if (data === "") { finish("", "download"); return }
      // A part whose size was not declared can still turn out too large;
      // base64 is four characters for every three bytes.
      if (data.length * 3 / 4 > root.maxPictureBytes) { finish("", "large"); return }
      root.backend.call("attachment.image", { data: data }, function(result, error) {
        if (!root.current(key)) return
        var prepared = !error && result ? String(result.data || "") : ""
        root.remember(attachment, prepared)
        finish(prepared)
      })
    })
  }

  // Keeping the picture. An attachment takes the existing save, which numbers
  // a taken name rather than overwrite it and says where the file went; a
  // body picture is the bytes already on screen, stored the same way.
  function save(entry, report) {
    store(entry, false, report)
  }

  // Opening it elsewhere, through the same checked path an attachment takes:
  // the backend writes a private file only for a type it agrees to open.
  function openExternally(entry, report) {
    store(entry, true, report)
  }

  function store(entry, opening, report) {
    var say = typeof report === "function" ? report : function() {}
    if (!entry || !service) return
    var key = messageKey
    if (entry.kind === "attachment") {
      if (opening) service.openAttachment(key, entry.attachment)
      else service.saveAttachment(key, entry.attachment)
      say(opening ? "Opening " + entry.name : "Saving " + entry.name)
      // The account reports how the save ended in its status line; the viewer
      // repeats it, so "Saving" does not stay on screen after the file is down.
      if (!opening) pendingSave = { key: key, report: say }
      return
    }
    var payload = Images.payloadOf(entry.source)
    if (payload === "" || !backend || !backend.ready) { say("That image could not be saved"); return }
    var name = Images.filenameFor(entry)
    backend.call("attachment.store", { filename: name, data: payload, open: opening },
      function(result, error) {
        if (!root.current(key)) return
        var path = !error && result ? String(result.path || "") : ""
        if (path === "") {
          say(opening ? "That image could not be opened" : "That image could not be saved")
          return
        }
        if (opening) {
          root.service.openExternal(path)
          say("Opening " + name)
          return
        }
        root.reportSaved(path, say)
      })
  }

  // "Saved name" fits beside the zoom at any window size; where it went is
  // the detail, shown on hover.
  function reportSaved(path, say) {
    var at = path.lastIndexOf("/")
    if (at > 0) say("Saved " + path.substring(at + 1), "Saved " + path.substring(at + 1) + " to " + path.substring(0, at))
    else say("Saved", "")
  }

  property var pendingSave: null
  property Connections saveWatcher: Connections {
    target: root.service
    ignoreUnknownSignals: true
    function onActionStatusChanged() {
      var waiting = root.pendingSave
      var text = String(root.service.actionStatus || "")
      if (!waiting || !root.current(waiting.key) || text.indexOf("Saved ") !== 0) return
      root.pendingSave = null
      var split = text.lastIndexOf(" to ")
      if (split > 0) waiting.report(text.substring(0, split), text)
      else waiting.report(text, "")
    }
    function onLastErrorChanged() {
      var waiting = root.pendingSave
      var text = String(root.service.lastError || "")
      if (!waiting || !root.current(waiting.key) || text === "") return
      root.pendingSave = null
      waiting.report(text, "")
    }
  }
}
