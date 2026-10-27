import QtQuick
import QtTest
import "../../account" as Account

Item {
  QtObject {
    id: service
    property bool backendCanSuggestGoogleContacts: true
    property var accountList: ({ accounts: [
      { id: "ada@example.org", provider: "gmail" },
      { id: "", provider: "gmail" },
      { id: "imap:bob@example.org", provider: "imap" }
    ] })
    property var backend: QtObject {
      property bool ready: true
      property var calls: []
      function call(method, params, done) {
        calls = calls.concat([{ method: method, params: params, done: done }])
      }
    }
  }

  Account.ContactBook { id: book; service: service }

  TestCase {
    name: "ContactBook"

    function sent(method) {
      return service.backend.calls.filter(function(call) { return call.method === method })
    }

    function test_merge_retry_and_removed_accounts() {
      book.refresh()
      var google = sent("contacts.google")
      compare(google.length, 1, "only a registered Gmail account is asked")
      compare(google[0].params.accountId, "ada@example.org")
      sent("contacts.suggest")[0].done([
        { name: "", email: "ada@work.example" },
        { name: "Local Bob", email: "bob@example.org" }
      ], null)
      google[0].done({ granted: true, contacts: [
        { name: "Ada Lovelace", email: "Ada@Work.example" },
        { name: "Google Bob", email: "bob@example.org" },
        { name: "Grace", email: "grace@example.org" }
      ] }, null)
      compare(book.contacts.length, 3, "one row per address")
      compare(book.contacts[0].name, "Ada Lovelace", "a name beats no name")
      compare(book.contacts[1].name, "Local Bob", "the local name comes first")

      book.loading = false
      book.fetched = ({})
      book.refresh()
      google = sent("contacts.google")
      compare(google.length, 2)
      google[1].done(null, { message: "request_timed_out" })
      book.loading = false
      book.refresh()
      compare(sent("contacts.google").length, 2, "a failure waits maxAge too")

      service.accountList = ({ accounts: [] })
      book.loading = false
      book.refresh()
      sent("contacts.suggest")[2].done([], null)
      compare(book.contacts.length, 0, "a removed account's contacts are no longer suggested")
    }
  }
}
