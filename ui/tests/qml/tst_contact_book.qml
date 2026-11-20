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
      property int apiVersion: 9
      property var calls: []
      function call(method, params, done) {
        calls = calls.concat([{ method: method, params: params, done: done }])
      }
    }
  }

  Account.ContactBook { id: book; service: service }

  TestCase {
    name: "ContactBook"

    function init() {
      service.backend.calls = []
      service.backendCanSuggestGoogleContacts = true
      service.backend.apiVersion = 9
      service.accountList = ({ accounts: [
        { id: "ada@example.org", provider: "gmail" },
        { id: "", provider: "gmail" },
        { id: "imap:bob@example.org", provider: "imap" }
      ] })
      book.loading = false
      book.fetched = ({})
      book.mailbox = ({})
      book.google = ({})
      book.local = []
      book.owedForgets = []
    }

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

    // A mailbox's address books: the saved copy is read without the network,
    // the server is asked only for a mailbox already using its books and an
    // old copy, an iCloud mailbox is never asked, and a failed refresh keeps
    // suggesting the last copy.
    function test_mailbox_books_snapshot_refresh_and_forget() {
      service.backend.calls = []
      service.backendCanSuggestGoogleContacts = false
      service.backend.apiVersion = 10
      service.accountList = ({ accounts: [
        { id: "imap:me@example.org", provider: "imap", email: "me@example.org",
          imap: { imapHost: "mail.example.org" } },
        { id: "imap:me@icloud.com", provider: "imap", email: "me@icloud.com" },
        { id: "imap:new@example.org", provider: "imap", email: "new@example.org",
          imap: { imapHost: "imap.example.org" } },
        // A local bridge has no server of its own to hold address books.
        { id: "imap:me@proton.me", provider: "imap", email: "me@proton.me",
          imap: { imapHost: "127.0.0.1" } }
      ] })
      book.loading = false
      book.fetched = ({})
      book.mailbox = ({})
      book.local = []
      book.refresh()
      var dav = sent("contacts.dav")
      compare(dav.length, 2, "only non-iCloud IMAP mailboxes are asked")
      compare(dav[0].params.operation, "read")
      dav[1].done({ enabled: false }, null)
      compare(sent("contacts.dav").length, 2, "a mailbox without books is not refreshed")
      dav[0].done({ enabled: true, cached: true, fetchedAt: 1, books: [{ name: "Directory", contacts: 1 }],
        contacts: [{ name: "Grace", email: "grace@example.org" }] }, null)
      compare(book.contacts.length, 1, "the saved copy is suggested at once")
      dav = sent("contacts.dav")
      compare(dav.length, 3, "an old copy is refreshed")
      compare(dav[2].params.operation, "refresh")
      compare(dav[2].params.server, undefined, "the background refresh names no server of its own")
      dav[2].done({ enabled: true, cached: true, error: "contacts_network_failed", fetchedAt: 1,
        books: [{ name: "Directory", contacts: 1 }], contacts: [{ name: "Grace", email: "grace@example.org" }] }, null)
      compare(book.contacts.length, 1, "offline keeps the last copy")
      var sources = book.sources
      compare(sources.length, 3)
      compare(sources[1].state, "on")
      compare(sources[1].error, "contacts_network_failed")
      compare(sources[2].state, "off")

      verify(book.findBooks("imap:new@example.org"))
      dav = sent("contacts.dav")
      compare(dav[3].params.operation, "refresh")
      compare(dav[3].params.server, "imap.example.org", "Find asks for the server its button named")
      compare(book.sources[2].state, "loading")
      dav[3].done(null, { message: "contacts_not_found" })
      compare(book.sources[2].state, "off")
      compare(book.sources[2].error, "contacts_not_found")

      verify(book.forgetBooks("imap:me@example.org"))
      dav = sent("contacts.dav")
      compare(dav[4].params.operation, "forget")
      dav[4].done({ enabled: false }, null)
      compare(book.contacts.length, 0, "forgotten books are no longer suggested")
    }

    // "Stop using" while a refresh is out: when the refresh answers, its
    // books are not shown again, and the mailbox stays off.
    function test_a_refresh_answering_after_stop_using_is_dropped() {
      var me = "imap:me@example.org"
      service.backendCanSuggestGoogleContacts = false
      service.backend.apiVersion = 10
      service.accountList = ({ accounts: [{ id: me, provider: "imap", email: "me@example.org",
        imap: { imapHost: "mail.example.org" } }] })
      book.refresh()
      sent("contacts.dav")[0].done({ enabled: true, cached: true, fetchedAt: Date.now(),
        books: [{ name: "Directory", contacts: 1 }],
        contacts: [{ name: "Grace", email: "grace@example.org" }] }, null)
      verify(book.findBooks(me))
      verify(book.sources[1].refreshing, "a refresh is out")
      verify(!book.findBooks(me), "and a second one is not started")
      var refresh = sent("contacts.dav")[1]
      compare(refresh.params.operation, "refresh")
      verify(book.forgetBooks(me))
      var forget = sent("contacts.dav")[2]
      compare(forget.params.operation, "forget")
      forget.done({ enabled: false }, null)
      compare(book.sources[1].state, "off")
      refresh.done({ enabled: true, cached: false, fetchedAt: Date.now(),
        books: [{ name: "Directory", contacts: 2 }],
        contacts: [{ name: "Grace", email: "grace@example.org" }, { name: "Ada", email: "ada@example.org" }] }, null)
      compare(book.sources[1].state, "off", "the late answer does not turn the books back on")
      compare(book.contacts.length, 0, "and nothing from it is suggested")
    }

    // The saved copy is read at startup; "Stop using" while that read is out
    // must win too: its answer neither turns the books on nor starts a
    // background refresh, and the buttons wait while it is out.
    function test_a_snapshot_read_answering_after_stop_using_is_dropped() {
      var me = "imap:me@example.org"
      service.backendCanSuggestGoogleContacts = false
      service.backend.apiVersion = 10
      service.accountList = ({ accounts: [{ id: me, provider: "imap", email: "me@example.org",
        imap: { imapHost: "mail.example.org" } }] })
      book.refresh()
      var read = sent("contacts.dav")[0]
      compare(read.params.operation, "read")
      verify(book.sources[1].refreshing, "the buttons wait while the saved copy is read")
      verify(book.forgetBooks(me))
      var forget = sent("contacts.dav")[1]
      forget.done({ enabled: false }, null)
      // An old copy: had it been used, it would also start a background refresh.
      read.done({ enabled: true, cached: true, fetchedAt: 1, books: [{ name: "Directory", contacts: 1 }],
        contacts: [{ name: "Grace", email: "grace@example.org" }] }, null)
      compare(book.sources[1].state, "off", "the late read does not turn the books back on")
      compare(book.contacts.length, 0)
      compare(sent("contacts.dav").length, 2, "and no background refresh is started")
    }

    // Removing a mailbox deletes its snapshot and the choice to read it: the
    // same address added again starts with its books off and asks first.
    function test_a_removed_mailbox_takes_its_books_and_the_choice_with_it() {
      var me = "imap:me@example.org"
      var mailboxes = ({ accounts: [{ id: me, provider: "imap", email: "me@example.org",
        imap: { imapHost: " Mail.Example.org " } }] })
      service.backendCanSuggestGoogleContacts = false
      service.backend.apiVersion = 10
      service.accountList = mailboxes
      book.refresh()
      compare(book.sources[1].host, "mail.example.org", "the host the password would go to")
      sent("contacts.dav")[0].done({ enabled: true, cached: true, fetchedAt: Date.now(),
        books: [{ name: "Directory", contacts: 1 }],
        contacts: [{ name: "Grace", email: "grace@example.org" }] }, null)
      compare(book.contacts.length, 1)

      service.accountList = ({ accounts: [] })
      book.mailboxRemoved(me)
      var dav = sent("contacts.dav")
      compare(dav.length, 2)
      compare(dav[1].params.accountId, me)
      compare(dav[1].params.operation, "forget")
      compare(book.mailbox[me], undefined)
      compare(book.contacts.length, 0)
      dav[1].done({ enabled: false }, null)
      compare(book.owedForgets.length, 0)

      // Added again within maxAge: the snapshot is read again rather than
      // the old state reused, and the row is off until the answer says so.
      service.accountList = mailboxes
      book.loading = false
      book.refresh()
      dav = sent("contacts.dav")
      compare(dav.length, 3)
      compare(dav[2].params.operation, "read")
      compare(book.sources[1].state, "off")

      // A Gmail account or a draft has no snapshot to remove.
      book.mailboxRemoved("ada@example.org")
      book.mailboxRemoved("")
      compare(sent("contacts.dav").length, 3)
    }

    // A backend that cannot be asked yet is asked once it can be.
    function test_a_removal_before_the_backend_can_forget_is_owed() {
      var me = "imap:me@example.org"
      service.backendCanSuggestGoogleContacts = false
      service.accountList = ({ accounts: [] })
      service.backend.apiVersion = 9
      book.mailboxRemoved(me)
      compare(sent("contacts.dav").length, 0)
      compare(book.owedForgets, [me])
      service.backend.apiVersion = 10
      var dav = sent("contacts.dav")
      compare(dav.length, 1)
      compare(dav[0].params.operation, "forget")
      dav[0].done(null, { message: "contacts_cache_unavailable" })
      compare(book.owedForgets, [me], "a failed delete stays owed")
      book.loading = false
      book.refresh()
      dav = sent("contacts.dav")
      compare(dav[dav.length - 1].params.operation, "forget")
      dav[dav.length - 1].done({ enabled: false }, null)
      compare(book.owedForgets.length, 0)
    }

    // A refresh in flight when the mailbox is removed saves a snapshot after
    // the delete; its answer deletes it again instead of showing it.
    function test_a_refresh_that_outlives_its_mailbox_is_deleted() {
      var me = "imap:me@example.org"
      service.backendCanSuggestGoogleContacts = false
      service.backend.apiVersion = 10
      service.accountList = ({ accounts: [{ id: me, provider: "imap", email: "me@example.org",
        imap: { imapHost: "mail.example.org" } }] })
      verify(book.findBooks(me))
      var refresh = sent("contacts.dav")[0]
      compare(refresh.params.operation, "refresh")
      service.accountList = ({ accounts: [] })
      book.mailboxRemoved(me)
      sent("contacts.dav")[1].done({ enabled: false }, null)
      refresh.done({ enabled: true, cached: false, fetchedAt: Date.now(),
        books: [{ name: "Directory", contacts: 1 }],
        contacts: [{ name: "Grace", email: "grace@example.org" }] }, null)
      var dav = sent("contacts.dav")
      compare(dav.length, 3)
      compare(dav[2].params.operation, "forget")
      compare(book.mailbox[me], undefined)
      compare(book.contacts.length, 0)
    }
  }
}
