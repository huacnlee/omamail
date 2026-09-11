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

function parse(raw, call, connected, callback) {
  transfer(raw, call, connected, function(upload, done) {
    call("message.parseUpload", { upload: upload }, done)
  }, callback)
}

function request(method, params, call, connected, callback) {
  var raw
  try { raw = Message.bytesToLatin1(Message.utf8Bytes(JSON.stringify(params))) }
  catch (error) { callback(null, {code:-32602,message:"Invalid upload params"}); return }
  transfer(raw, call, connected, function(upload, done) {
    call("request.upload", {method:method, upload:upload}, done)
  }, callback, MAX_REQUEST)
}

function putBody(accountId, id, body, call, connected, callback) {
  var raw = Message.bytesToLatin1(Message.utf8Bytes(JSON.stringify(body)))
  transfer(raw, call, connected, function(upload, done) {
    call("cache.bodyPutUpload", { accountId: accountId, id: id, upload: upload }, done)
  }, callback)
}

function transfer(raw, call, connected, complete, callback, maximum) {
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
  if (typeof raw !== "string" || raw.length > (maximum || MAX_MESSAGE)) {
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
        complete(upload, function(payload, failure) {
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
