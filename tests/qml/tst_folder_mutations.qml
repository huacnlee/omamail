import QtQuick
import QtTest
import "../../providers" as Providers

Item {
  QtObject {
    id: credentials
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

    function test_invalid_identity_starts_nothing_data() {
      var rows = []
      var names = ["x\r", "x\n", "x\r\n", "x\0", "x\t", "x\x7f", "x\ud800", "x\udc00"]
      for (var mode = 0; mode < 2; mode++)
        for (var n = 0; n < names.length; n++)
          rows.push({ tag: mode + "-" + n, authMode: mode ? "oauth2" : "", name: names[n] })
      return rows
    }

    function test_invalid_identity_starts_nothing(data) {
      credentials.authMode = data.authMode
      credentials.reads = 0
      var answered = 0
      function refused(_value, error) { verify(error !== ""); answered++ }
      client.createLabel(data.name, refused)
      client.renameLabel(data.name, "Valid", refused)
      client.renameLabel("Valid", data.name, refused)
      client.deleteLabel(data.name, refused)
      // A rejected later command must stop the entire batch, not just itself.
      client.changeFolders(['CREATE "Valid"', ""], refused)
      compare(answered, 5)
      compare(credentials.reads, 0, "No keyring/token read for a refused mutation")
      compare(client.inFlight, 0)
      for (var i = 0; i < client.children.length; i++)
        verify(client.children[i].running !== true, "No transport process was started")
    }
  }
}
