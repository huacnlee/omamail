.pragma library
.import "Html.js" as Html

// The pictures of one message, as the image viewer pages through them: the
// ones drawn in its body, in the order the reader numbers their links, then
// the picture attachments.
//
// Pictures are sender data. Only prepared raster `data:` URIs are drawn, and
// an attachment is shown only after the backend has checked and shrunk its
// bytes (`attachment.image`); everything here decides which pictures there
// are and how to step between them, never what bytes are safe.

// Above this declared size an attachment's thumbnail is a type tile: a strip
// of miniatures is not a reason to decode a camera original on every open.
var THUMBNAIL_MAX_BYTES = 4 * 1024 * 1024
var MAX_THUMBNAILS = 12
var MIN_ZOOM = 0.1
var MAX_ZOOM = 8
var ZOOM_STEP = 1.25

// What the backend's sniff accepts and Qt draws. HEIC, TIFF and SVG call
// themselves image/* as well; they open in another application instead.
var VIEWABLE_TYPES = {
  "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/pjpeg": "jpg",
  "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp"
}
var VIEWABLE_EXTENSIONS = { png: true, jpg: true, jpeg: true, gif: true, webp: true, bmp: true }

function mimeOf(attachment) {
  var value = attachment ? String(attachment.mimeType || "") : ""
  return value.split(";")[0].trim().toLowerCase()
}

function extensionOf(attachment) {
  var name = attachment ? String(attachment.filename || "") : ""
  var dot = name.lastIndexOf(".")
  return dot > 0 && dot < name.length - 1 ? name.substring(dot + 1).toLowerCase() : ""
}

// A picture attachment of any kind, viewable here or not.
function isImage(attachment) {
  return mimeOf(attachment).indexOf("image/") === 0
    || VIEWABLE_EXTENSIONS[extensionOf(attachment)] === true
}

// One this window can draw. Mail clients label a photo application/octet-stream
// often enough that a known extension counts; the backend still decides from
// the bytes, and a refusal falls back to opening the file elsewhere.
function viewable(attachment) {
  if (!attachment || String(attachment.attachmentId || "") === "") return false
  var mime = mimeOf(attachment)
  if (VIEWABLE_TYPES[mime] !== undefined) return true
  return (mime === "" || mime === "application/octet-stream")
    && VIEWABLE_EXTENSIONS[extensionOf(attachment)] === true
}

function thumbnailable(attachment) {
  var size = Math.floor(Number(attachment ? attachment.size : 0) || 0)
  return viewable(attachment) && size > 0 && size <= THUMBNAIL_MAX_BYTES
}

// What a type tile says: the extension, else the subtype.
function typeLabel(attachment) {
  var extension = extensionOf(attachment)
  if (extension !== "") return extension.substring(0, 5).toUpperCase()
  var mime = mimeOf(attachment)
  var slash = mime.indexOf("/")
  return slash >= 0 ? mime.substring(slash + 1, slash + 6).toUpperCase() : "FILE"
}

// The attachments the viewer pages through, in the order they are listed.
function viewableAttachments(attachments) {
  var out = []
  var list = attachments || []
  for (var i = 0; i < list.length; i++) if (viewable(list[i])) out.push(list[i])
  return out
}

// The body's pictures, in the same walk and with the same test the reader
// uses to number its `omarchy-image:` links (`Html.serialize` with links).
// A list that disagreed with the numbers would open somebody else's picture.
function documentImages(source) {
  var tree = source ? Html.documentTree(source) : null
  var out = []
  function walk(node) {
    if (!node || node.type === "text") return
    if (node.type === "element" && node.name === "img") {
      var src = Html.attributeValue(node, "src")
      if (Html.isDataImageSource(src)) out.push(src)
    }
    var children = node.children || []
    for (var i = 0; i < children.length; i++) walk(children[i])
  }
  walk(tree)
  return out
}

// One entry per picture. `source` is what the viewer draws once known: body
// pictures arrive prepared; a plain-text marker may name a remote picture
// still to be fetched; an attachment's bytes are asked for when it is shown.
function gallery(bodySources, attachments, marker) {
  var out = []
  var sources = bodySources || []
  for (var i = 0; i < sources.length; i++) {
    var src = String(sources[i] || "")
    var ready = Html.isRasterDataImage(src)
    out.push({ kind: marker === true ? "marker" : "body", requested: src,
      source: ready ? src : "", name: "Image " + (i + 1), number: i + 1 })
  }
  var files = viewableAttachments(attachments)
  for (var j = 0; j < files.length; j++)
    out.push({ kind: "attachment", attachment: files[j], requested: "", source: "",
      name: String(files[j].filename || "attachment"), number: sources.length + j + 1 })
  return out
}

// Where an attachment's picture sits in `gallery`, or -1.
function attachmentIndex(entries, attachment) {
  var wanted = attachment ? String(attachment.attachmentId || "") : ""
  for (var i = 0; i < (entries || []).length; i++)
    if (entries[i].kind === "attachment"
        && String(entries[i].attachment.attachmentId || "") === wanted) return i
  return -1
}

// Previous and next wrap, the way a photo viewer's arrows do.
function step(index, count, delta) {
  if (count <= 0) return -1
  return ((Math.floor(index) + Math.floor(delta)) % count + count) % count
}

function counter(index, count) {
  return count > 0 ? (index + 1) + " / " + count : ""
}

function clampZoom(value) {
  var zoom = Number(value)
  if (!isFinite(zoom) || zoom <= 0) return 1
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom))
}

function zoomBy(value, steps) {
  return clampZoom(clampZoom(value) * Math.pow(ZOOM_STEP, Number(steps) || 0))
}

// The scale that shows the whole picture in the box, never enlarging it: a
// small picture is shown at its own size, not blown up to fill a frame it was
// never meant to fill.
function fitScale(width, height, boxWidth, boxHeight) {
  if (!(width > 0) || !(height > 0) || !(boxWidth > 0) || !(boxHeight > 0)) return 1
  return clampZoom(Math.min(1, boxWidth / width, boxHeight / height))
}

// The base64 text of a prepared `data:` URI, or "" for anything else.
function payloadOf(source) {
  var text = String(source || "")
  if (!Html.isRasterDataImage(text)) return ""
  return text.substring(text.indexOf(",") + 1)
}

// A file name for a body picture that has none of its own.
function filenameFor(entry) {
  if (!entry) return "image"
  if (entry.kind === "attachment") return String(entry.attachment.filename || "attachment")
  var match = /^data:image\/([a-z0-9.+-]+);base64,/i.exec(String(entry.source || ""))
  var type = match ? match[1].toLowerCase() : ""
  var extension = VIEWABLE_TYPES["image/" + type] || "png"
  return "image-" + Math.max(1, Math.floor(Number(entry.number) || 1)) + "." + extension
}
