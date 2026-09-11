import QtQuick 2.15
import QtTest 1.3
import "../../account" as Account

Item {
  QtObject {
    id: backend
    property bool ready: true
    property var requests: []
    function call(method, params, callback) {
      if (method === "reader.render") requests.push({method: method, params: params, callback: callback})
    }
    function complete(index, text, error) {
      var document = {type: "root", children: []}
      requests[index].callback(error ? null : {nativeRender:{html: text, document: document,
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
      compare(account.selectedHtml, "")
      compare(backend.requests.length, 1)
      compare(backend.requests[0].method, "reader.render")
      compare(backend.requests[0].params.readerKey, "opaque-native-key")
      compare(backend.requests[0].params.html, undefined, "sender HTML remains in Rust")
      compare(backend.requests[0].params.options.withReader, true)
      backend.complete(0, "safe native result", null)
      compare(account.selectedHtml, "safe native result")
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
      compare(account.selectedHtml, "current")
    }

    function test_changing_account_identity_rejects_late_render() {
      account.selectedId = "message-one"
      account.renderSource("private account one", false, true)
      account.accountId = "account-two"
      backend.complete(0, "private account one", null)
      compare(account.selectedHtml, "")
    }

    function test_failure_never_falls_back_to_sender_html() {
      account.selectedId = "message-one"
      account.renderSource("opaque-key-with-blocked-images", false, true)
      backend.complete(0, "", {code: "failed"})
      compare(account.selectedHtml, "")
      verify(account.lastError !== "")
    }
    function test_late_cached_source_cannot_overwrite_a_live_projection() {
      account.selectedId = "message-one"
      account.renderSource("cached-key")
      account.readerSourceKey = "live-key"
      account.selectedHtml = "new native projection"
      backend.complete(0, "old cached projection", null)
      compare(account.selectedHtml, "new native projection")
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
      compare(account.selectedHtml, "current image policy")
    }

  }
}
