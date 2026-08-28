import QtQuick 2.15
import QtTest 1.3
import "../../providers" as Providers
import "../../message/Message.js" as Mail

Item {
  width: 100
  height: 100

  QtObject {
    id: auth

    property string pluginDir: "/plugin"
    property var settings: ({
      imapHost: "imap.example.org",
      imapPort: 993,
      smtpHost: "smtp.example.org",
      smtpPort: 465,
      username: "me@example.org",
      insecure: false
    })

    signal verifyRequested(var settings, string credentials)

    function withCredentials(callback) { callback("me@example.org:secret", "") }
    function completeSignIn(_ok, _error) {}
  }

  Providers.ImapClient {
    id: client
    auth: auth
    email: "me@example.org"
    foldersLoaded: true
    special: ({ "\\sent": "Sent Items" })
  }

  TestCase {
    name: "ImapSend"
    when: windowShown

    property bool callbackDone: false
    property var callbackPayload: null
    property string callbackError: ""

    function processFor(prefix) {
      var children = client.children || []
      for (var i = children.length - 1; i >= 0; i--) {
        var request = String(children[i].requestLine || "")
        if (request.indexOf(prefix) === 0) return children[i]
      }
      return null
    }

    function sendMessage() {
      callbackDone = false
      callbackPayload = null
      callbackError = ""
      client.sendMessage(Mail.buildSendPayload({
        from: "me@example.org",
        to: "friend@example.net",
        subject: "Saved in Sent",
        body: "message body"
      }), function(payload, error) {
        callbackDone = true
        callbackPayload = payload
        callbackError = String(error || "")
      })
    }

    function test_smtp_success_appends_a_seen_copy_to_sent() {
      sendMessage()
      var smtp = processFor("smtp ")
      verify(smtp, "sending must start with SMTP")
      smtp.finished(0, "", "")

      compare(callbackDone, false,
        "delivery is not complete until the Sent copy has been attempted")
      var append = processFor("imap-append ")
      verify(append, "SMTP success must append a Sent copy")
      var fields = String(append.requestLine).split(" ")
      compare(Mail.decodeBase64Url(fields[1]), "imaps://imap.example.org:993/Sent%20Items")
      compare(Mail.decodeBase64Url(fields[3]), "seen")

      append.finished(0, "", "")
      compare(callbackDone, true)
      compare(callbackError, "")
      compare(String(callbackPayload.warning || ""), "")
    }

    function test_a_failed_sent_copy_does_not_claim_delivery_failed() {
      sendMessage()
      var smtp = processFor("smtp ")
      verify(smtp)
      smtp.finished(0, "", "")
      var append = processFor("imap-append ")
      verify(append)
      append.finished(7, "", Mail.encodeBase64("append refused"))

      compare(callbackDone, true)
      compare(callbackError, "",
        "SMTP already accepted the message, so retrying would send a duplicate")
      verify(String(callbackPayload.warning || "").indexOf("Sent") >= 0)
    }
  }
}
