import QtQuick
import QtTest
import qs.Commons
import "../.." as Omamail
import "BackendFixture.js" as BackendFixture
import "../../account/Accounts.js" as Accounts

Item {
  width: 900
  height: 600

  QtObject {
    id: host
    property QtObject bar: QtObject {
      property color barForeground: Qt.rgba(0.9, 0.8, 0.7, 1)
    }
    property int opens: 0
    function updateEntryInline(id, entry) {}
    function summon(id, payload) {
      if (id !== "omamail") throw new Error("Wrong application")
      opens++
      app.open(payload)
    }
  }
  Omamail.Service {
    id: service
    shell: host
    manifest: ({ id: "omamail", __sourceDir: "/tmp/omamail-test" })
  }
  Omamail.App { id: app; service: service }

  TestCase {
    name: "NotificationOpen"
    when: windowShown

    function initTestCase() { BackendFixture.markReady(service) }
    readonly property string first: "ada@example.org"
    readonly property string second: "bob@example.org"

    function init() {
      app.close()
      var list = Accounts.emptyList()
      list = Accounts.add(list, { email: first, provider: "gmail" })
      list = Accounts.add(list, { email: second, provider: "gmail" })
      service.accountList = Accounts.setActive(list, first)
      service.accountsLoaded = true
      service.activeIndex = -1
      service.refreshCurrent()
      host.opens = 0
    }

    function notification(account, arrivals) {
      account.notify(arrivals)
      var process = latestNotification(account)
      verify(!!process, "Notification must listen for a click instead of being detached")
      return process
    }

    function latestNotification(item) {
      if (item.command && item.command[1] === service.pluginDir + "/scripts/notify-mail.py") return item
      var children = item.data || []
      for (var i = children.length - 1; i >= 0; i--) {
        var process = latestNotification(children[i])
        if (process) return process
      }
      return null
    }

    function finish(process, output) {
      process.stdout.text = output
      process.stdout.streamFinished()
      process.exited(0)
    }

    function test_click_opens_account_and_reader() {
      var process = notification(service.findAccount(second), [
        { id: "message-2", subject: "Hello" }
      ])
      finish(process, "default\n")
      tryCompare(app, "page", "reader")
      compare(app.opened, true)
      compare(service.activeAccountId, second)
      compare(service.selectedId, "message-2")
      compare(host.opens, 1)
    }

    function test_concurrent_and_batch_notifications_keep_their_targets() {
      var account = service.findAccount(second)
      var earlier = notification(account, [{ id: "earlier" }])
      var batch = notification(account, [{ id: "newest" }, { id: "older" }])
      finish(batch, "default\n")
      tryCompare(service, "selectedId", "newest")
      app.openSettings()
      finish(earlier, "default\n")
      tryCompare(service, "selectedId", "earlier")
      compare(app.page, "reader")
      compare(host.opens, 2)
    }

    function test_new_notifications_follow_bar_colors() {
      var account = service.findAccount(second)
      var firstNotice = notification(account, [{ id: "one" }])
      compare(firstNotice.command[2], String(host.bar.barForeground))
      compare(firstNotice.command[3], String(Color.accent))
      host.bar.barForeground = Qt.rgba(0.1, 0.2, 0.3, 1)
      var nextNotice = notification(account, [{ id: "two" }])
      compare(nextNotice.command[2], String(host.bar.barForeground))
      verify(firstNotice.command[2] !== nextNotice.command[2])
      finish(firstNotice, "")
      finish(nextNotice, "")
    }

    function test_removed_account_is_ignored() {
      service.openNotification("gone@example.org", "message")
      compare(host.opens, 0)
      compare(service.activeAccountId, first)
    }

    function test_dismissal_does_not_open_mail() {
      var process = notification(service.findAccount(second), [{ id: "dismissed" }])
      finish(process, "")
      wait(0)
      compare(host.opens, 0)
      compare(app.opened, false)
      compare(service.activeAccountId, first)
    }

    function test_sender_text_is_inert() {
      var process = notification(service.findAccount(second), [{
        id: "opaque\";$(touch /tmp/never-notification)",
        from: { display: "--urgency=critical" },
        subject: "<img src='https://example.org/track'>", snippet: "你好"
      }])
      var separator = process.command.indexOf("--")
      verify(separator > 0)
      compare(process.command.length, separator + 3)
      verify(process.command[separator + 1].indexOf("--urgency") < 0)
      verify(process.command[separator + 2].indexOf("<img") < 0)
      finish(process, "unknown\n")
      compare(host.opens, 0)
    }
  }
}
