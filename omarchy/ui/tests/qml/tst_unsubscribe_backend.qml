import QtQuick
import QtTest
import "../../account" as Account

Item {
  QtObject {
    id: transport
    property bool ready: true
    property var calls: []
    property var done: null
    function call(method, params, callback) {
      calls = calls.concat([{method: method, params: params}])
      done = callback
    }
  }
  QtObject {
    id: mailbox
    property var backend: transport
    property bool unsubscribing: false
    property string unsubscribeDone: ""
    property string error: ""
    property bool ready: true
    property bool canSend: true
    property var selectedUnsubscribe: null
    property string receivedAsAddress: "me@example.org"
    property string receivedAsName: ""
    property string ownAddress: "me@example.org"
    property var sent: []
    property var api: ({sendMessage: function(payload, callback) {
      mailbox.sent = mailbox.sent.concat([payload])
      callback({}, null)
    }})
    function clearNotice() {}
    function fail(message) { error = message }
  }
  Account.Unsubscribe { id: action; account: mailbox }
  TestCase {
    name: "UnsubscribeBackend"
    when: windowShown
    function init() {
      transport.ready = true
      transport.calls = []
      transport.done = null
      mailbox.unsubscribing = false
      mailbox.unsubscribeDone = ""
      mailbox.error = ""
      mailbox.sent = []
    }
    // The list's mailto address is a stranger's; one that cannot be written
    // into a header is refused before anything is sent.
    function test_mail_to_an_unwritable_address_is_refused() {
      mailbox.selectedUnsubscribe = {oneClick: false, postUrl: "", url: "",
        mail: {to: "x<a\u0000@list.example.org>", subject: "Unsubscribe", body: "Unsubscribe"}}
      action.run()
      compare(mailbox.sent.length, 0)
      compare(mailbox.unsubscribing, false)
      verify(mailbox.error !== "")
      mailbox.error = ""
      mailbox.selectedUnsubscribe = {oneClick: false, postUrl: "", url: "",
        mail: {to: "list@example.org", subject: "Unsubscribe", body: "Unsubscribe"}}
      action.run()
      compare(mailbox.sent.length, 1)
      compare(mailbox.unsubscribeDone, "Unsubscribe request sent to list@example.org")
    }
    function test_native_request_and_success() {
      action.postUnsubscribe("https://sender.example/unsubscribe?token=synthetic")
      compare(transport.calls.length, 1)
      compare(transport.calls[0].method, "public.unsubscribe")
      compare(transport.calls[0].params.url, "https://sender.example/unsubscribe?token=synthetic")
      compare(mailbox.unsubscribing, true)
      transport.done({status: 204}, null)
      compare(mailbox.unsubscribing, false)
      compare(mailbox.unsubscribeDone, "Unsubscribed from this list")
    }
    function test_redirect_is_not_success() {
      action.postUnsubscribe("https://sender.example/unsubscribe")
      transport.done({status: 302}, null)
      compare(mailbox.unsubscribeDone, "")
      verify(mailbox.error.indexOf("redirect") >= 0)
    }
    function test_raw_errors_are_not_displayed() {
      action.postUnsubscribe("https://sender.example/unsubscribe")
      transport.done(null, {message: "secret subscriber token"})
      compare(mailbox.error, "The unsubscribe request could not be sent")
      compare(mailbox.unsubscribing, false)
    }
    function test_private_url_and_unavailable_backend_do_not_dispatch() {
      action.postUnsubscribe("https://127.0.0.1/unsubscribe")
      compare(transport.calls.length, 0)
      transport.ready = false
      action.postUnsubscribe("https://sender.example/unsubscribe")
      compare(transport.calls.length, 0)
      compare(mailbox.unsubscribing, false)
    }
  }
}
