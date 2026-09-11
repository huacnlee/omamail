import QtQuick 2.15
import QtTest 1.3
import "../../account" as Account

Item {
  QtObject {
    id: backend
    property bool ready: true
    property var requests: []
    function call(method, params, callback) {
      if (method === "reader.render" || method === "public.image") requests.push({method: method, params: params, callback: callback})
    }
    function complete(index, text, error) {
      var document = {type: "root", children: [{type: "text", text: text}]}
      requests[index].callback(error ? null : {nativeRender:{document: document,
        reader: {document: document, tooHeavy: false, empty: false, blockedImages: 0},
        blockedImages: 0, remoteImages: 0, remoteImageSources: [], tooHeavy: false}}, error)
    }
  }
  Account.MailAccount {
    id: account
    backend: backend
    pluginDir: "/tmp/omamail-render-cache-test"
    active: false
    windowOpen: false
    bodyMode: "original"
  }

  TestCase {
    name: "RenderCache"
    when: windowShown

    function init() {
      account.clearSelection()
      account.accountId = "account-one"
      backend.requests = []
      account.bodyMode = "original"
      account.remoteImagesAllowed = false
      account.remoteImageData = ({})
    }

    function test_html_is_only_drawn_after_native_sanitization() {
      account.selectedId = "message-one"
      account.renderSource("opaque-native-key", true)
      compare(account.selectedDocument, null)
      compare(backend.requests.length, 1)
      compare(backend.requests[0].method, "reader.render")
      compare(backend.requests[0].params.readerKey, "opaque-native-key")
      compare(backend.requests[0].params.html, undefined, "sender HTML remains in Rust")
      compare(backend.requests[0].params.options.withReader, true)
      backend.complete(0, "safe native result", null)
      compare(account.selectedDocument.children[0].text, "safe native result")
      verify(account.selectedReaderDocument !== null)
    }

    function test_a_stale_render_cannot_replace_the_new_selection() {
      account.selectedId = "message-one"
      account.renderSource("old", false)
      account.detailSerial++
      account.selectedId = "message-two"
      account.renderSource("current", false, true)
      backend.complete(1, "current", null)
      backend.complete(0, "old", null)
      compare(account.selectedDocument.children[0].text, "current")
    }

    function test_changing_account_identity_rejects_late_render() {
      account.selectedId = "message-one"
      account.renderSource("private account one", false, true)
      account.accountId = "account-two"
      backend.complete(0, "private account one", null)
      compare(account.selectedDocument, null)
    }

    function test_failure_never_falls_back_to_sender_html() {
      account.selectedId = "message-one"
      account.renderSource("opaque-key-with-blocked-images", false, true)
      backend.complete(0, "", {code: "failed"})
      compare(account.selectedDocument, null)
      verify(account.lastError !== "")
    }
    function test_late_cached_source_cannot_overwrite_a_live_projection() {
      account.selectedId = "message-one"
      account.renderSource("cached-key")
      account.readerSourceKey = "live-key"
      account.selectedDocument = {type: "root", children: [{type: "text", text: "new native projection"}]}
      backend.complete(0, "old cached projection", null)
      compare(account.selectedDocument.children[0].text, "new native projection")
    }

    function test_equal_native_revision_keeps_document_identity() {
      var painted = {type: "root", children: [{type: "text", text: "same body"}]}
      account.selectedDocument = painted
      account.selectedRenderRevision = "native-source-and-policy-revision"
      account.applyRendered({revision: "native-source-and-policy-revision", document: {type: "root", children: []}})
      compare(account.selectedDocument, painted)
      var changed = {type: "root", children: [{type: "text", text: "new body"}]}
      account.applyRendered({revision: "changed-source-or-policy", document: changed,
        reader: null, blockedImages: 0, remoteImages: 0, remoteImageSources: [], tooHeavy: false})
      compare(account.selectedDocument, changed)
      compare(account.selectedRenderRevision, "changed-source-or-policy")
    }

    function test_account_change_discards_pending_images_and_paint_timer() {
      account.selectedId = "message-one"
      account.readerSourceKey = "old-account-key"
      account.remoteImagesAllowed = true
      account.selectedRemoteImageSources = ["https://example.org/one", "https://example.org/pending"]
      var png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLa0AAAAASUVORK5CYII="
      account.prepareRemoteImages()
      backend.requests[0].callback({data: png}, null)
      compare(backend.requests.length, 2)
      account.accountId = "account-two"
      backend.requests[1].callback({data: png}, null)
      wait(150)
      compare(Object.keys(account.remoteImageData).length, 0, "old account bytes must be discarded")
      compare(account.readerSourceKey, "")
      compare(account.selectedDocument, null)
      compare(backend.requests.length, 2, "old image callback or timer must not dispatch a render for the new account")
    }

    function test_account_change_discards_individual_display_image() {
      account.selectedId = "message-one"
      var completed = false
      account.fetchDisplayImage("https://example.org/one", function(data) { completed = true })
      account.accountId = "account-two"
      backend.requests[0].callback({data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLa0AAAAASUVORK5CYII="}, null)
      compare(completed, false, "old account image callback must not reach the new reader")
    }

    function test_slow_next_image_does_not_hold_completed_image() {
      account.selectedId = "message-one"
      account.readerSourceKey = "native-key"
      account.remoteImagesAllowed = true
      account.selectedRemoteImageSources = ["https://example.org/one", "https://example.org/slow"]
      var png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLa0AAAAASUVORK5CYII="
      account.prepareRemoteImages()
      backend.requests[0].callback({data: png}, null)
      compare(backend.requests.length, 2)
      tryVerify(function() { return backend.requests.length === 3 }, 1000)
      compare(backend.requests[2].method, "reader.render")
      account.clearSelection()
      backend.requests[1].callback({data: png}, null)
      compare(Object.keys(account.remoteImageData).length, 0, "cancelled fetch cannot restore old images")
    }

    function test_live_projection_keeps_approved_images_visible() {
      account.selectedId = "message-one"
      account.selectedHasHtml = true
      account.remoteImagesAllowed = true
      account.remoteImageData = ({"https://example.org/one": "approved raster data"})
      var painted = {type: "root", children: [{type: "text", text: "painted image"}]}
      account.selectedDocument = painted
      account.readerSourceKey = "live-key"
      account.adoptRendered({document: {type: "root", children: []}})
      compare(account.selectedDocument, painted, "live image-free projection must not clear the image")
      compare(backend.requests.length, 1)
      compare(backend.requests[0].params.readerKey, "live-key")
      compare(backend.requests[0].params.options.remoteImageData["https://example.org/one"], "approved raster data")
      backend.complete(0, "live with image", null)
      compare(account.selectedDocument.children[0].text, "live with image")
    }

    function test_images_paint_once_and_old_selection_cannot_commit() {
      account.selectedId = "message-one"
      account.readerSourceKey = "native-key"
      account.remoteImagesAllowed = true
      account.selectedRemoteImageSources = ["https://example.org/one", "https://example.org/two"]
      var png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLa0AAAAASUVORK5CYII="
      account.prepareRemoteImages()
      compare(backend.requests[0].method, "public.image")
      backend.requests[0].callback({data: png}, null)
      compare(backend.requests.length, 2)
      compare(backend.requests[1].method, "public.image", "no intermediate document rebuild")
      backend.requests[1].callback({data: png}, null)
      compare(backend.requests.length, 3)
      compare(backend.requests[2].method, "reader.render")
      account.prepareRemoteImages()
      compare(backend.requests.length, 3, "no duplicate fetch")
      account.clearSelection()
      backend.complete(2, "stale images", null)
      compare(account.selectedDocument, null)
      compare(Object.keys(account.remoteImageData).length, 0)
    }

    function test_image_policy_change_only_rerenders_the_opaque_native_source() {
      account.selectedId = "message-one"
      account.renderSource("native-key")
      account.showRemoteImages()
      compare(backend.requests.length, 2)
      compare(backend.requests[0].params.options.allowRemoteImages, false)
      compare(backend.requests[1].params.options.allowRemoteImages, true)
      compare(backend.requests[1].params.readerKey, "native-key")
      compare(backend.requests[1].params.html, undefined)
      backend.complete(1, "current image policy", null)
      backend.complete(0, "obsolete image policy", null)
      compare(account.selectedDocument.children[0].text, "current image policy")
    }

  }
}
