.pragma library
.import "../message/Message.js" as Message

var MAX_MESSAGE = 16 * 1024 * 1024
var MAX_REQUEST = 64 * 1024 * 1024
var MAX_CHUNK = 64 * 1024

// RFC 822 transports supply a byte-string, not Unicode text. Encoding it as
// UTF-8 would change attachment bytes and legacy charset bodies.
function chunk(raw, offset, size) {
  var bytes = []
  var end = Math.min(raw.length, offset + size)
  for (var i = offset; i < end; i++) {
    var byte = raw.charCodeAt(i)
    if (byte > 255) return null
    bytes.push(byte)
  }
  return { data: Message.bytesToBase64(bytes, true), offset: end }
}

function parse(raw, call, connected, callback, queue) {
  return transfer(raw, call, connected, function(upload, done) {
    return call("message.parseUpload", { upload: upload }, done)
  }, callback, MAX_MESSAGE, queue)
}

function request(method, params, call, connected, callback, queue) {
  var raw
  try { raw = Message.bytesToLatin1(Message.utf8Bytes(JSON.stringify(params))) }
  catch (error) { callback(null, {code:-32602,message:"Invalid upload params"}); return }
  return transfer(raw, call, connected, function(upload, done) {
    return call("request.upload", {method:method, upload:upload}, done)
  }, callback, MAX_REQUEST, queue)
}

function putBody(accountId, id, body, call, connected, callback, queue) {
  var raw = Message.bytesToLatin1(Message.utf8Bytes(JSON.stringify(body)))
  return transfer(raw, call, connected, function(upload, done) {
    return call("cache.bodyPutUpload", { accountId: accountId, id: id, upload: upload }, done)
  }, callback, MAX_MESSAGE, queue)
}

// The limits are those of the pinned backend. Reserve declared bytes as well
// as slots; eight valid 64 MiB requests still cannot fit its 128 MiB store.
// This state belongs to one Backend instance, never to the shared JS library.
function makeQueue(cleanupFailed) {
  var queue = { waiting: [], active: [], bytes: 0, pumping: false }
  queue.pump = function() {
    if (queue.pumping) return
    queue.pumping = true
    try {
      while (queue.waiting.length && queue.active.length < 8) {
        var task = queue.waiting[0]
        if (queue.bytes + task.size > 2 * MAX_REQUEST) break
        queue.waiting.shift()
        queue.active.push(task)
        queue.bytes += task.size
        task.start()
      }
    } finally { queue.pumping = false }
  }
  queue.add = function(task) { queue.waiting.push(task); queue.pump() }
  queue.remove = function(task) {
    var index = queue.waiting.indexOf(task)
    if (index >= 0) queue.waiting.splice(index, 1)
    index = queue.active.indexOf(task)
    if (index >= 0) {
      queue.active.splice(index, 1)
      queue.bytes -= task.size
    }
    queue.pump()
  }
  queue.fail = function(error) {
    var tasks = queue.waiting.concat(queue.active)
    queue.waiting = []
    queue.active = []
    queue.bytes = 0
    for (var i = 0; i < tasks.length; i++) {
      try { tasks[i].fail(error) }
      catch (failure) { console.warn("Backend upload callback failed") }
    }
  }
  queue.cleanupFailed = cleanupFailed
  return queue
}

function transfer(raw, call, connected, complete, callback, maximum, queue) {
  var upload = ""
  var finished = false
  var cancelled = false
  var started = false
  var current = null
  var task = { size: typeof raw === "string" ? raw.length : 0 }
  function finish(result, error) {
    if (finished) return
    finished = true
    raw = ""
    function settled() {
      if (queue) queue.remove(task)
      if (!cancelled && typeof callback === "function") callback(result, error)
    }
    if (error && upload && connected()) {
      // Keep the reservation until cleanup answers, even when the transport
      // queue is full. A refused discard must not open another upload slot.
      call("upload.discard", { upload: upload }, function(reply, failure) {
        if (failure && connected() && failure.message !== "upload_not_found" && queue
            && typeof queue.cleanupFailed === "function") queue.cleanupFailed()
        settled()
      })
    } else settled()
  }
  task.fail = function(error) {
    if (current && current.withdraw) current.withdraw()
    finish(null, error)
  }
  function stopped() {
    if (finished) return true
    if (!cancelled) return false
    finish(null, { code: -32010, message: "Request cancelled" })
    return true
  }
  function invalid() {
    finish(null, { code: -32602, message: "Invalid message upload" })
  }
  if (typeof raw !== "string" || raw.length > (maximum || MAX_MESSAGE)) {
    invalid()
    return
  }
  task.start = function() {
    started = true
    current = call("upload.begin", { size: raw.length }, function(result, error) {
      if (finished) return
      if (result && typeof result.upload === "string") upload = result.upload
      if (stopped()) return
      if (error) { finish(null, error); return }
      if (!upload || !result || typeof result.chunkSize !== "number"
          || !isFinite(result.chunkSize) || result.chunkSize < 1
          || Math.floor(result.chunkSize) !== result.chunkSize) {
        invalid()
        return
      }
      var size = Math.min(MAX_CHUNK, result.chunkSize)
      function append(offset) {
        if (stopped()) return
        if (offset === raw.length) {
          current = complete(upload, function(payload, failure) {
            if (finished) return
            finish(payload, failure)
          })
          return
        }
        var part = chunk(raw, offset, size)
        if (!part) { invalid(); return }
        current = call("upload.append", { upload: upload, offset: offset, data: part.data }, function(reply, failure) {
          if (stopped()) return
          if (failure) { finish(null, failure); return }
          if (!reply || reply.offset !== part.offset) { invalid(); return }
          append(part.offset)
        })
      }
      append(0)
    })
  }
  if (queue) queue.add(task)
  else task.start()
  return { cancel: function() {
    if (finished || cancelled) return
    cancelled = true
    if (!started || (current && current.withdraw && current.withdraw()))
      finish(null, { code: -32010, message: "Request cancelled" })
    // An in-flight begin may still return its ID. Its callback owns cleanup;
    // do not detach it or release a reservation the backend still holds.
  } }
}
