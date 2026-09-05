import QtQuick 2.15
import QtTest 1.3
import "../../account" as Account
import "../../account/RenderCache.js" as RenderCache

Item {
  Account.MailAccount {
    id: account
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
      account.renderCache = RenderCache.create(12)
      account.bodyMode = "original"
    }

    function test_reader_rebuild_is_deferred_then_cached() {
      account.selectedId = "message-one"
      var first = account.renderSource("<p>First message</p>", true)

      compare(first.reader, null, "original mode does not rebuild reading mode on its paint path")
      compare(account.selectedReaderDocument, null)

      wait(0)
      verify(account.selectedReaderDocument !== null,
        "the next event-loop turn completes the reading document")

      var cached = RenderCache.get(account.renderCache, "message-one",
        "<p>First message</p>", true)
      verify(cached !== null)
      compare(account.renderSource("<p>First message</p>", true), cached,
        "reopening returns the cached render result")
    }

    function test_a_stale_deferred_render_cannot_replace_the_new_selection() {
      account.selectedId = "message-one"
      account.renderSource("<p>Old message</p>", false)
      account.detailSerial++
      account.selectedId = "message-two"
      // Complete the current message immediately. If the older callback is
      // not guarded it runs afterwards and becomes the final visible state.
      account.renderSource("<p>Current message</p>", false, true)

      wait(0)
      verify(account.selectedHtml.indexOf("Current message") >= 0)
      verify(account.selectedHtml.indexOf("Old message") < 0)
      verify(account.selectedReaderDocument !== null)
    }

    function test_changing_account_identity_drops_render_entries() {
      account.selectedId = "message-one"
      account.renderSource("<p>First message</p>", false, true)
      verify(RenderCache.get(account.renderCache, "message-one",
        "<p>First message</p>", false) !== null)

      account.accountId = "account-two"
      compare(RenderCache.get(account.renderCache, "message-one",
        "<p>First message</p>", false), null)
    }
  }
}
