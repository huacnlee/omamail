import QtQuick
import QtTest
import "transports.js" as Transports
import "../../providers" as Providers

Item {
  QtObject {
    id: credentials
    property string accountId: "imap:synthetic@example.com"
    property string authMode: ""
    property string pluginDir: "/tmp/omamail-test"
    property var settings: ({ imapHost: "imap.example.com", imapPort: 993, username: "synthetic", insecure: false })
    property int reads: 0
    function withCredentials(callback) { reads++; callback("synthetic:secret", "") }
  }
  Providers.ImapClient { id: client; auth: credentials; email: "synthetic@example.com" }

  TestCase {
    name: "FolderMutations"
    when: windowShown

    function test_invalid_identity_is_passed_exactly_to_native_validation_data() {
      var rows = []
      var names = ["x\r", "x\n", "x\r\n", "x\0", "x\t", "x\x7f", "x\ud800", "x\udc00"]
      for (var mode = 0; mode < 2; mode++)
        for (var n = 0; n < names.length; n++)
          rows.push({ tag: mode + "-" + n, authMode: mode ? "oauth2" : "", name: names[n] })
      return rows
    }

    function test_invalid_identity_is_passed_exactly_to_native_validation(data) {
      credentials.authMode = data.authMode
      credentials.reads = 0
      var answered = 0
      function refused(_value, error) { verify(error !== ""); answered++ }
      Transports.install(client)
      var before=Transports.transports(client)
      client.createLabel(data.name, refused)
      client.renameLabel(data.name, "Valid", refused)
      client.renameLabel("Valid", data.name, refused)
      client.deleteLabel(data.name, refused)
      var requests=Transports.newSince(client,before)
      compare(requests.length,4)
      compare(requests[0].method,"imap.createFolder")
      compare(requests[0].params.name,data.name)
      compare(requests[1].method,"imap.renameFolder")
      compare(requests[1].params.id,data.name)
      compare(requests[2].params.name,data.name)
      compare(requests[3].method,"imap.deleteFolder")
      compare(requests[3].params.id,data.name)
      for (var i=0;i<requests.length;i++) {
        compare(requests[i].params.accountId,"imap:synthetic@example.com")
        compare(requests[i].params.credential,undefined)
        Transports.reply(requests[i],null,{code:"imap_invalid_input"})
      }
      compare(answered,4)
      compare(credentials.reads,0,"Only Rust validates and resolves credentials")
      compare(client.inFlight,0)

    }
  }
}
