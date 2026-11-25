import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail
import "../../message/Html.js" as Html

// The image viewer over a real reader: which picture a click opens, how the
// arrows page through the message's pictures, where attachment bytes come
// from, and what never reaches it (HEIC, an older backend, a late answer).
Item {
  width: 800
  height: 600

  readonly property string png: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGM8kWLEwMDAxMDAwMDAAAARKAFipiAqoAAAAABJRU5ErkJggg=="
  // 400 x 300, larger than the viewer's picture area once zoomed in.
  readonly property string large: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAZAAAAEsCAIAAABi1XKVAAADJ0lEQVR42u3Z0QmAIBRA0Qzn8KuB+nYIh2kCR3Agh2mBgj6CNM6Z4KFweWJIuS4AM1gdASBYAIIFCBaAYAEIFiBYAIIFIFiAYAEIFoBgAYIFIFgAggUIFoBgAQgWIFgAggUgWIBgAQgWgGABggUgWACCBQgWgGABggUgWACCBQgWgGABCBYgWACCBSBYgGABCBaAYAGCBSBYAIIFCBaAYAEIFiBYAIIFcCeOOVYvzd3At7Zjt2EBCBYgWACCBSBYwE/FWQYd8MMC/mSKr3kbFuBJCCBYgGABCBaAYAGCBSBYAIIFCBaAYAEIFiBYAIIFIFiAYAEIFoBgAYIFIFgAggUIFoBgAQgWIFgAggUgWIBgAQgWIFiOABAsAMECBAtAsAAECxAsAMECECxAsAAEC0CwAMECECwAwQIEC0CwAAQLECwAwQIQLECwAAQLQLAAwQIQLADBAgQLQLAAwQIQLADBAgQLQLAABAsQLADBAhAsQLAABAtAsADBAhAsAMECBAtAsAAECxAsAMECECxAsAAEC0CwAMECECwAwQIEC0CwAMECECwAwQIEC0CwAAQLECwAwQIQLECwAAQLQLAAwQIQLADBAgQLQLAABAsQLADBAhAsQLAABAtAsADBAhAsAMECBAtAsADBAhAsAMECBAtAsAAECxAsAMECECxAsAAEC0CwAMECECwAwQIEC0CwAAQLECwAwQIQLECwAAQLQLAAwQIQLADBAgQLQLAAwQIQLADBAgQLQLAABAsQLADBAhAsQLAABAtAsADBAhAsAMECBAtAsAAECxAsAMECECxAsAAEC0CwAMECECwAwQIEC0CwAMECECwAwQIEC0CwAAQLECwAwQIQLECwAAQLQLAAwQIQLIBn4iyD9tLcFtiwAAQLQLAAwQIQLIA3hJSrUwBsWACCBQgWgGABCBYgWACCBSBYgGABCBaAYAGCBSBYAIIFCBaAYAEIFiBYAIIFIFiAYAEIFoBgAYIFIFgAggUIFoBgAYIFIFgAggUIFoBgAQgWIFgAggUgWIBgAQgWgGABggUgWACCBQgWgGABCBYgWACCBXDpBJm9DIcIbLD1AAAAAElFTkSuQmCC"
  readonly property string gif: "data:image/gif;base64,R0lGODdhAgACAIEAAMhkMgAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7"
  readonly property var rendered: Html.sanitize("<p>One</p><p><img src=\"" + png + "\"></p>"
    + "<p><a href=\"https://example.org/\"><img src=\"" + gif + "\"></a></p>", ({ withReader: true }))

  QtObject {
    id: backend
    property bool ready: true
    property int apiVersion: 10
    property var requests: []
    property var held: []
    property bool hold: false
    function call(method, params, callback) {
      requests.push({ method: method, params: JSON.parse(JSON.stringify(params)) })
      if (hold) { held.push(callback); return }
      if (method === "attachment.image" && params.data !== undefined)
        // The provider's bytes, checked: the fixture's are a real PNG.
        callback({ data: "data:image/png;base64," + params.data }, null)
      else if (method === "attachment.image")
        callback(params.attachmentId === "att-photo" ? { data: png } : null,
          params.attachmentId === "att-photo" ? null
            : { message: params.attachmentId === "att-remote" ? "attachment_image_unavailable" : "public_image_refused" })
      else if (method === "attachment.store")
        callback({ path: (params.open ? "/run/omamail/" : "/home/user/Downloads/") + params.filename }, null)
    }
  }

  QtObject {
    id: mailService
    property var backend: backend
    property var reading: ({ accountId: "imap:reader@example.org", selectedId: "7:INBOX" })
    property string selectedId: "7:INBOX"
    property var selectedMessage: ({ id: "7:INBOX", subject: "Pictures",
      from: ({ display: "Sender", email: "sender@example.org" }),
      to: [({ display: "Reader", email: "reader@example.org" })], fullTime: "20 November 2026", starred: false })
    property bool detailLoading: false
    property bool detailPainted: true
    property bool selectedHasHtml: true
    property var selectedDocument: rendered.document
    property var selectedReaderDocument: rendered.reader.document
    property bool selectedReaderTooHeavy: false
    property bool selectedReaderEmpty: false
    property int selectedReaderRemoteImages: 0
    property int selectedRemoteImages: 0
    property bool remoteImagesAllowed: false
    property bool selectedTooHeavy: false
    property string unsubscribeLabel: ""
    property string unsubscribeDetail: ""
    property bool unsubscribing: false
    property var selectedBody: ({ text: "One", source: "html" })
    property var selectedImages: []
    property var selectedInvite: null
    property string selectedResponse: ""
    property bool canRespondToInvite: false
    property bool rsvpSending: false
    property bool canArchive: true
    property bool canOpenOnWeb: false
    property var selectedAttachments: [
      ({ filename: "photo.jpg", mimeType: "image/jpeg", size: 2048, attachmentId: "att-photo" }),
      ({ filename: "IMG_0001.HEIC", mimeType: "image/heic", size: 2048, attachmentId: "att-heic" }),
      ({ filename: "notes.pdf", mimeType: "application/pdf", size: 2048, attachmentId: "att-pdf" })
    ]
    property var externalOpens: []
    property var externalUrls: []
    property var fetched: []
    property var saved: []
    property string actionStatus: ""
    property string lastError: ""
    // What the provider answers for an attachment download; "" is offline.
    property string download: ""
    property int downloads: 0
    function attachmentIsSaving() { return false }
    function showRemoteImages() {}
    function fetchDisplayImage(source, callback) { fetched.push(source); callback(source.indexOf("https://two.") === 0 ? png : "") }
    function openAttachment(id, attachment) { externalOpens.push(attachment.attachmentId) }
    function saveAttachment(id, attachment) { saved.push(attachment.attachmentId) }
    function openExternal(path) { externalUrls.push(path) }
    function loadAttachments(id, list, callback) {
      downloads++
      if (download === "") callback([], "offline")
      else callback([({ attachmentId: list[0].attachmentId, data: download })], "")
    }
  }

  Omamail.MessageReader {
    id: reader
    anchors.fill: parent
    service: mailService
    textColor: Qt.rgba(1, 1, 1, 1)
    backgroundColor: Qt.rgba(0.06, 0.06, 0.06, 1)
    accentColor: Qt.rgba(1, 0.5, 0, 1)
    linkColor: Qt.rgba(0.3, 0.7, 1, 1)
    dimColor: Qt.rgba(0.67, 0.67, 0.67, 1)
    popupBackgroundColor: Qt.rgba(0.13, 0.13, 0.13, 1)
    popupBorderColor: Qt.rgba(0.47, 0.47, 0.47, 1)
    leadingBoundaryOverlap: 0
    dimmerColor: Qt.rgba(0.47, 0.47, 0.47, 1)
    panelFontFamily: "monospace"
    bodyMode: "reader"
  }

  TestCase {
    name: "ImageViewer"
    when: windowShown

    function found(item, type) {
      if (!item) return null
      if (item.toString().indexOf(type) === 0) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var hit = found(values[i], type)
        if (hit) return hit
      }
      return null
    }
    function named(item, name) {
      if (!item) return null
      if (item.objectName === name) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var hit = named(values[i], name)
        if (hit) return hit
      }
      return null
    }
    function viewer() { return named(reader, "imageViewer") }

    function init() {
      backend.requests = []
      backend.held = []
      backend.hold = false
      backend.apiVersion = 10
      mailService.externalOpens = []
      mailService.externalUrls = []
      mailService.fetched = []
      mailService.saved = []
      mailService.download = ""
      mailService.downloads = 0
      mailService.actionStatus = ""
      mailService.lastError = ""
      // A message change empties the reader's prepared pictures.
      mailService.selectedId = ""
      mailService.selectedId = "7:INBOX"
      reader.bodyMode = "reader"
    }
    function cleanup() { viewer().close() }

    function test_a_body_picture_opens_at_itself_and_pages_through_the_message() {
      var body = found(reader, "QQuickTextEdit")
      verify(body.text.indexOf("omarchy-image:1") >= 0, "a picture is a viewer link")
      verify(body.text.indexOf("omarchy-image:2") < 0,
        "one inside the sender's link keeps that link: anchors do not nest")
      body.linkActivated("omarchy-image:1")
      var sheet = viewer()
      verify(sheet.opened)
      compare(sheet.index, 0)
      compare(sheet.source, png)
      sheet.step(1)
      compare(sheet.index, 1)
      compare(sheet.source, gif, "the linked picture is still a page of the viewer")
      compare(sheet.entries.length, 3, "two body pictures and the one viewable attachment")
      compare(sheet.entries[2].name, "photo.jpg")
      sheet.step(1)
      compare(sheet.index, 2)
      compare(sheet.source, png, "an attachment is drawn once the backend prepared it")
      compare(backend.requests[0].method, "attachment.image")
      compare(backend.requests[0].params.accountId, "imap:reader@example.org")
      compare(backend.requests[0].params.id, "7:INBOX")
      compare(backend.requests[0].params.attachmentId, "att-photo")
      compare(backend.requests[0].params.data, undefined, "the downloaded message is read first")
      sheet.step(1)
      compare(sheet.index, 0, "the arrows wrap")
    }

    function test_keys_page_and_zoom_inside_the_viewer() {
      reader.openImageMarker(1)
      var sheet = viewer()
      tryCompare(sheet, "opened", true)
      keyClick(Qt.Key_Right)
      compare(sheet.index, 1)
      keyClick(Qt.Key_Left)
      keyClick(Qt.Key_Left)
      compare(sheet.index, 2)
      var fitted = sheet.zoom
      keyClick(Qt.Key_Plus)
      compare(sheet.fitted, false)
      verify(sheet.zoom > fitted)
      keyClick(Qt.Key_0)
      compare(sheet.fitted, true)
      keyClick(Qt.Key_Escape)
      verify(!sheet.opened)
    }

    // The wheel zooms the picture rather than scrolling the view, and a
    // picture larger than the view can be dragged.
    function test_the_wheel_zooms_and_a_zoomed_picture_drags() {
      var sheet = viewer()
      sheet.openGallery([{ kind: "body", requested: large, source: large, name: "Large", number: 1 }], 0)
      var view = findChild(sheet, "imageViewerView")
      verify(view, "the picture area")
      var picture = findChild(view, "imageViewerPicture")
      tryCompare(picture, "status", Image.Ready)
      var fitted = sheet.zoom
      mouseWheel(view, view.width / 2, view.height / 2, 0, 120)
      verify(sheet.zoom > fitted, "wheel up zooms in: " + fitted + " -> " + sheet.zoom)
      compare(sheet.fitted, false)
      sheet.zoomBy(8)
      verify(picture.width > view.width && view.interactive, "a zoomed picture outgrows the view")
      view.contentX = 0
      view.contentY = 0
      mouseDrag(view, view.width / 2, view.height / 2, -120, -80)
      tryVerify(function() { return view.contentX > 0 && view.contentY > 0 }, 1000,
        "dragging moves the picture: " + view.contentX + "," + view.contentY)
      var zoomed = sheet.zoom
      mouseWheel(view, view.width / 2, view.height / 2, 0, -120)
      verify(sheet.zoom < zoomed, "wheel down zooms out")
    }

    function test_heic_and_files_this_cannot_draw_open_elsewhere() {
      var files = mailService.selectedAttachments
      reader.openAttachment(files[1])
      verify(!viewer().opened)
      reader.openAttachment(files[2])
      verify(!viewer().opened)
      compare(mailService.externalOpens, ["att-heic", "att-pdf"])
    }

    function test_an_older_backend_opens_picture_attachments_elsewhere() {
      backend.apiVersion = 9
      reader.openAttachment(mailService.selectedAttachments[0])
      verify(!viewer().opened)
      compare(mailService.externalOpens, ["att-photo"])
      compare(backend.requests.length, 0)
    }

    function test_an_answer_for_a_message_no_longer_open_is_dropped() {
      backend.hold = true
      reader.openAttachment(mailService.selectedAttachments[0])
      var sheet = viewer()
      verify(sheet.loading)
      mailService.selectedId = "8:INBOX"
      verify(!sheet.opened, "another message closes the viewer")
      backend.held[0]({ data: png }, null)
      compare(sheet.source, "", "nothing is drawn for the message that was left")
    }

    function test_a_body_picture_saves_and_opens_through_the_backend() {
      reader.openImageMarker(1)
      var sheet = viewer()
      sheet.saveRequested(sheet.entry)
      var store = backend.requests[backend.requests.length - 1]
      compare(store.method, "attachment.store")
      compare(store.params.filename, "image-1.png")
      compare(store.params.open, false)
      compare(store.params.data, png.substring(png.indexOf(",") + 1))
      compare(sheet.status, "Saved image-1.png", "the name fits beside the zoom")
      compare(sheet.statusDetail, "Saved image-1.png to /home/user/Downloads", "where it went is on hover")
      sheet.openRequested(sheet.entry)
      compare(backend.requests[backend.requests.length - 1].params.open, true)
      compare(mailService.externalUrls, ["/run/omamail/image-1.png"])
    }
  
    // Plain shows a sender's remote picture as a marker. Clicking one fetches
    // that one; paging to another does not fetch it until asked to.
    function test_paging_fetches_no_remote_picture_the_reader_did_not_ask_for() {
      reader.bodyMode = "plain"
      mailService.selectedImages = ["https://one.example.org/a.png", "https://two.example.org/b.png"]
      reader.openImageMarker(1)
      var sheet = viewer()
      verify(sheet.opened)
      compare(mailService.fetched, ["https://one.example.org/a.png"], "the clicked marker is fetched")
      keyClick(Qt.Key_Right)
      compare(sheet.index, 1)
      compare(mailService.fetched.length, 1, "paging to the second fetches nothing")
      verify(sheet.awaitingConsent)
      var load = findChild(sheet, "imageViewerLoad")
      verify(load && load.visible)
      compare(load.text, "Load picture")
      load.clicked()
      compare(mailService.fetched, ["https://one.example.org/a.png", "https://two.example.org/b.png"])
      compare(sheet.source, png)
      mailService.selectedImages = []
    }

    // An attachment the downloaded message does not carry is fetched from the
    // provider and then prepared; a failed download says so and can be tried
    // again without closing the viewer.
    function test_a_fetched_attachment_is_prepared_and_a_failed_download_retried() {
      var files = mailService.selectedAttachments
      // Its bytes are not in the downloaded message: the viewer fetches them.
      var remote = ({ filename: "scan.png", mimeType: "image/png", size: 2048, attachmentId: "att-remote" })
      mailService.selectedAttachments = [remote]
      reader.openAttachment(remote)
      var sheet = viewer()
      verify(sheet.opened)
      compare(mailService.downloads, 1)
      verify(sheet.failed, "offline is a failed download")
      compare(findChild(sheet, "imageViewerNotice").text, "That image could not be downloaded")
      var retry = findChild(sheet, "imageViewerLoad")
      verify(retry && retry.visible)
      compare(retry.text, "Try again")
      mailService.download = png.substring(png.indexOf(",") + 1)
      retry.clicked()
      compare(mailService.downloads, 2, "Try again asks the provider again")
      verify(sheet.opened, "without closing the viewer")
      compare(sheet.source, png, "the provider's bytes, prepared by attachment.image")
      var prepared = backend.requests.filter(function(r) { return r.method === "attachment.image" && r.params.data !== undefined })
      compare(prepared.length, 1, "the downloaded bytes go through the backend once")
      verify(!sheet.failed && !sheet.refused)
      mailService.selectedAttachments = files
    }

    // Saving an attachment from the viewer reports how it ended, not only
    // that it started.
    function test_an_attachment_save_reports_its_result() {
      reader.openAttachment(mailService.selectedAttachments[0])
      var sheet = viewer()
      tryCompare(sheet, "source", png)
      sheet.saveRequested(sheet.entry)
      compare(mailService.saved, ["att-photo"])
      compare(sheet.status, "Saving photo.jpg")
      mailService.actionStatus = "Saved photo.jpg to /home/user/Downloads"
      compare(sheet.status, "Saved photo.jpg")
      compare(sheet.statusDetail, "Saved photo.jpg to /home/user/Downloads")
    }

    // A prepared picture shows without a "Loading" flash, and Fit is not
    // drawn as chosen while there is no picture to fit.
    function test_no_loading_flash_and_fit_only_selected_with_a_picture() {
      reader.openImageMarker(1)
      var sheet = viewer()
      verify(!findChild(sheet, "imageViewerNotice").visible, "no Loading over a prepared picture")
      var fit = findChild(sheet, "imageViewerFit")
      tryVerify(function() { return fit.selected })
      reader.openAttachment(mailService.selectedAttachments[1])
      sheet.openGallery([{ kind: "attachment", attachment: mailService.selectedAttachments[2], name: "broken", settled: true }], 0)
      verify(sheet.refused)
      verify(!fit.selected, "nothing to fit")
    }

    // A marker that is not a public address is not a picture to fetch: an
    // unresolved cid:, a private host. It is refused at once, with no Load
    // picture or Try again that could never succeed, and nothing is fetched.
    function test_markers_that_are_not_public_addresses_are_refused_without_a_fetch() {
      reader.bodyMode = "plain"
      mailService.selectedImages = ["cid:missing@example.org", "http://10.0.0.5/logo.png"]
      reader.openImageMarker(1)
      var sheet = viewer()
      verify(sheet.opened)
      verify(sheet.refused, "an unresolved cid: is refused")
      verify(!findChild(sheet, "imageViewerLoad").visible)
      keyClick(Qt.Key_Right)
      compare(sheet.index, 1)
      verify(sheet.refused, "a private host is refused")
      verify(!sheet.awaitingConsent && !sheet.failed)
      verify(!findChild(sheet, "imageViewerLoad").visible)
      compare(mailService.fetched.length, 0, "nothing is fetched for either")
      mailService.selectedImages = []
    }

    // An attachment over what the backend prepares is not downloaded only to
    // be refused; the page says it is too large.
    function test_a_too_large_attachment_is_not_downloaded() {
      var files = mailService.selectedAttachments
      var big = ({ filename: "scan.png", mimeType: "image/png", size: 20 * 1024 * 1024, attachmentId: "att-remote" })
      mailService.selectedAttachments = [big]
      reader.openAttachment(big)
      var sheet = viewer()
      verify(sheet.opened)
      compare(mailService.downloads, 0, "no provider download")
      verify(sheet.tooLarge && !sheet.refused && !sheet.failed)
      compare(findChild(sheet, "imageViewerNotice").text, "That picture is too large to show here: open it in another app")
      sheet.close()
      // No size declared: downloaded, found too large, and not handed on.
      var unsized = ({ filename: "scan.png", mimeType: "image/png", size: 0, attachmentId: "att-remote" })
      mailService.selectedAttachments = [unsized]
      mailService.download = Array(22 * 1024 * 1024 / 4 + 2).join("AAAA")
      reader.openAttachment(unsized)
      verify(viewer().opened)
      compare(mailService.downloads, 1)
      verify(viewer().tooLarge && !viewer().refused, "too large, not unreadable")
      compare(backend.requests.filter(function(r) { return r.method === "attachment.image" && r.params.data !== undefined }).length, 0,
        "the oversized bytes never reach the backend")
      mailService.selectedAttachments = files
    }

    // Where a save went is in the plain-text tooltip component, not a Qt one.
    function test_the_save_detail_uses_the_panel_tooltip() {
      reader.openImageMarker(1)
      var sheet = viewer()
      sheet.saveRequested(sheet.entry)
      var detail = findChild(sheet, "imageViewerStatusDetail")
      verify(detail, "a PanelToolTip carries the detail")
      compare(detail.text, "Saved image-1.png to /home/user/Downloads")
    }
}
}
