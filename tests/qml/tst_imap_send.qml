import QtQuick 2.15
import QtTest 1.3
import "../../providers" as Providers
import "../../message/Message.js" as Mail

Item {
  id: harness
  width: 100
  height: 100

  property string observedSentCopyWarning: ""

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
    Connections {
      target: client
      function onSentCopyWarning(warning) {
        harness.observedSentCopyWarning = String(warning || "")
      }
    }

    function processFor(prefix) {
      var children = client.children || []
      for (var i = children.length - 1; i >= 0; i--) {
        var request = String(children[i].requestLine || "")
        if (request.indexOf(prefix) === 0) return children[i]
      }
      return null
    }

    function processCount(prefix) {
      var count = 0
      var children = client.children || []
      for (var i = 0; i < children.length; i++)
        if (String(children[i].requestLine || "").indexOf(prefix) === 0) count++
      return count
    }

    function sendMessage() {
      callbackDone = false
      callbackPayload = null
      callbackError = ""
      harness.observedSentCopyWarning = ""
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

    function init() {
      auth.settings = {
        imapHost: "imap.example.org", imapPort: 993,
        smtpHost: "smtp.example.org", smtpPort: 465,
        username: "me@example.org", insecure: false
      }
      client.foldersLoaded = true
      client.foldersLoading = false
      client.serverCapabilities = []
      client.special = ({ "\\sent": "Sent Items" })
    }

    function test_smtp_success_finishes_before_the_seen_copy() {
      sendMessage()
      var smtp = processFor("smtp ")
      verify(smtp, "sending must start with SMTP")
      var sentMessage = Mail.decodeBase64Url(String(smtp.requestLine).split(" ")[4])
      smtp.finished(0, "", "")

      compare(callbackDone, true,
        "SMTP acceptance is the irreversible delivery boundary")
      compare(callbackError, "")
      var append = processFor("imap-append ")
      verify(append, "SMTP success must append a Sent copy")
      var fields = String(append.requestLine).split(" ")
      compare(Mail.decodeBase64Url(fields[1]), "imaps://imap.example.org:993/Sent%20Items")
      compare(Mail.decodeBase64Url(fields[3]), "seen")
      compare(Mail.decodeBase64Url(fields[4]), sentMessage,
        "the saved copy must be the exact message accepted by SMTP")

      append.finished(0, "", "")
      compare(harness.observedSentCopyWarning, "")
    }

    function test_a_failed_sent_copy_warns_without_reopening_delivery() {
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
      verify(harness.observedSentCopyWarning.indexOf("Sent, but") === 0)
    }

    function test_servers_that_file_sent_mail_do_not_receive_an_append() {
      var hosts = ["smtp.gmail.com", "smtp-mail.outlook.com", "smtp.office365.com"]
      for (var i = 0; i < hosts.length; i++) {
        var appendsBefore = processCount("imap-append ")
        auth.settings.smtpHost = hosts[i]
        sendMessage()
        var smtp = processFor("smtp ")
        verify(smtp)
        smtp.finished(0, "", "")
        compare(callbackDone, true)
        compare(processCount("imap-append "), appendsBefore,
          hosts[i] + " must keep its own Sent copy")
        wait(0)
      }
    }

    function test_sent_copy_waits_for_special_use_folder_discovery() {
      client.foldersLoaded = false
      client.special = ({})
      sendMessage()
      var smtp = processFor("smtp ")
      verify(smtp)
      smtp.finished(0, "", "")
      compare(callbackDone, true)

      var listing = processFor("imap ")
      verify(listing, "folder discovery must begin before APPEND")
      verify(String(listing.requestLine).indexOf(Mail.encodeBase64('LIST "" "*"')) >= 0)
      listing.finished(0, Mail.encodeBase64(
        "* CAPABILITY IMAP4rev1 SPECIAL-USE\r\n" +
        '* LIST (\\HasNoChildren) "/" "Inbox"\r\nA1 OK done\r\n'), "")

      var specialListing = processFor("imap ")
      verify(specialListing)
      verify(String(specialListing.requestLine).indexOf(
        Mail.encodeBase64('LIST "" "*" RETURN (SPECIAL-USE)')) >= 0)
      compare(processFor("imap-append "), null,
        "APPEND must wait until the authoritative Sent folder is known")
      specialListing.finished(0, Mail.encodeBase64(
        '* LIST (\\Sent \\HasNoChildren) "/" "Filed Sent"\r\nA1 OK done\r\n'), "")

      var append = processFor("imap-append ")
      verify(append)
      compare(Mail.decodeBase64Url(String(append.requestLine).split(" ")[1]),
        "imaps://imap.example.org:993/Filed%20Sent")
    }
  }
}
