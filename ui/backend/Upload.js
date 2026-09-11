.pragma library
.import "../message/Message.js" as Message

var MAX_MESSAGE = 16 * 1024 * 1024
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

function parse(raw, call, connected, callback) {
  var upload = ""
  var finished = false
  function finish(result, error) {
    if (finished) return
    finished = true
    raw = ""
    if (error && upload && connected())
      call("upload.discard", { upload: upload }, function() {})
    callback(result, error)
  }
  function invalid() {
    finish(null, { code: -32602, message: "Invalid message upload" })
  }
  if (typeof raw !== "string" || raw.length > MAX_MESSAGE) {
    invalid()
    return
  }
  call("upload.begin", { size: raw.length }, function(result, error) {
    if (error) { finish(null, error); return }
    if (result && typeof result.upload === "string") upload = result.upload
    if (!upload || !result || typeof result.chunkSize !== "number"
        || !isFinite(result.chunkSize) || result.chunkSize < 1
        || Math.floor(result.chunkSize) !== result.chunkSize) {
      invalid()
      return
    }
    var size = Math.min(MAX_CHUNK, result.chunkSize)
    function append(offset) {
      if (offset === raw.length) {
        call("message.parseUpload", { upload: upload }, function(payload, failure) {
          finish(payload, failure)
        })
        return
      }
      var part = chunk(raw, offset, size)
      if (!part) { invalid(); return }
      call("upload.append", { upload: upload, offset: offset, data: part.data }, function(reply, failure) {
        if (failure) { finish(null, failure); return }
        if (!reply || reply.offset !== part.offset) { invalid(); return }
        append(part.offset)
      })
    }
    append(0)
  })
}
