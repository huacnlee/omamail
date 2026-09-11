import QtQuick
import QtTest
import "../../account" as Account
import "../../providers/Registry.js" as Provider

Item {
  Component {
    id: backendFactory
    QtObject {
      signal notification(string method, var params)
      property bool ready: true
      property var protocolInfo: ({ methods: [] })
      property var requests: []
      function call(method, params, done) {
        if (method === "providers.resolve") requests = requests.concat([{ params: params, done: done }])
      }
    }
  }
  Component {
    id: accountFactory
    Account.MailAccount {
      pluginDir: "/synthetic/provider-domain"
      accountId: "imap:synthetic@example.org"
      providerId: "imap"
      property int loads: 0
      function loadMessages() { loads++ }
      function loadProfile() {}
      function loadSendAs() {}
      function refreshCounts() {}
    }
  }
  TestCase {
    name: "NativeProviderDomain"
    function test_native_descriptor_preserves_ceiling_and_mailbox_queries() {
      verify(!Provider.can("hey", "archive"))
      verify(!Provider.can("hey", "star"))
      verify(!Provider.can("jmap", "archive", { archive: "No Archive mailbox" }))
      compare(Provider.mailboxFor("imap", "unread").query, "folder:INBOX UNSEEN")
      compare(Provider.mailboxes("jmap", ["archive"]).length, 7)
    }
    function test_search_preparation_preserves_query_identity_and_cancels_on_navigation() {
      var backend = createTemporaryObject(backendFactory, parent)
      var account = createTemporaryObject(accountFactory, parent, { backend: backend, providerId: "gmail" })
      account.rawQuery = "label:A"
      account.rawLabelId = "Label_A"
      account.search("label:A")
      compare(account.effectiveQuery, "label:A")
      compare(account.rawLabelId, "Label_A")
      compare(backend.requests[0].params.operation, "query")
      backend.requests[0].done({ value: "label:A" }, null)
      compare(account.effectiveQuery, "label:A")
      compare(account.searchRaw, "label:A")
      account.search("stale")
      account.selectMailbox("trash")
      backend.requests[1].done({ value: "stale" }, null)
      compare(account.effectiveQuery, "in:trash")
      compare(account.searchQuery, "")
    }
    function test_label_query_is_native_and_late_navigation_reply_is_ignored() {
      var backend = createTemporaryObject(backendFactory, parent)
      var account = createTemporaryObject(accountFactory, parent, { backend: backend })
      verify(account !== null)
      account.selectLabel("Old Mail", "folder-id")
      compare(backend.requests.length, 1)
      compare(backend.requests[0].params.operation, "labelQuery")
      compare(backend.requests[0].params.value, "Old Mail")
      compare(account.rawQuery, "")
      backend.requests[0].done({ value: "folder:\"Old Mail\"" }, null)
      compare(account.rawQuery, "folder:\"Old Mail\"")
      compare(account.rawLabelId, "folder-id")
      account.selectLabel("Stale", "stale")
      account.selectMailbox("trash")
      backend.requests[1].done({ value: "folder:\"Stale\"" }, null)
      compare(account.rawQuery, "")
      compare(account.mailboxKey, "trash")
    }
  }
}
