import QtQuick
import QtTest
import Quickshell
import qs.Commons
import qs.Commons as Commons
import "../.." as Omamail
import "../../account" as Account
import "BackendFixture.js" as BackendFixture
import "../../account/Accounts.js" as Accounts

Item {
  width: 900
  height: 600

  QtObject {
    id: host
    property QtObject bar: QtObject {
      property int barSize: 30
    }
    property int opens: 0
    property var savedEntry: null
    function updateEntryInline(id, entry) { savedEntry = entry }
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

  Component {
    id: nativeNotificationFactory
    Account.NewMailNotification {
      pluginDir: "/tmp/omamail-test"
      accountId: "imap:plain@example.org"
      notificationForeground: "#112233"
      notificationAccent: "#445566"
      nativeNotifications: true
    }
  }

  Component {
    id: pluginNotificationFactory
    Account.NewMailNotification {
      pluginDir: service.pluginDir
      accountId: "imap:plain@example.org"
      notificationForeground: "#112233"
      notificationAccent: "#445566"
    }
  }

  Component {
    id: unavailableNotificationFactory
    Account.NewMailNotification {
      pluginDir: "/tmp/omamail-test"
      accountId: "imap:plain@example.org"
      notificationForeground: "#112233"
      notificationAccent: "#445566"
      nativeNotifications: false
      pluginNotifications: false
    }
  }

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
      Quickshell.notifications = []
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

    function test_new_notifications_follow_theme_without_bar_foreground() {
      var account = service.findAccount(second)
      var firstNotice = notification(account, [{ id: "one" }])
      compare(firstNotice.command[2], String(Commons.Color.foreground))
      compare(firstNotice.command[3], String(Commons.Color.accent))
      var previous = Commons.Color.foreground
      try {
        Commons.Color.foreground = Qt.rgba(0.1, 0.2, 0.3, 1)
        var nextNotice = notification(account, [{ id: "two" }])
        compare(nextNotice.command[2], String(Commons.Color.foreground))
        verify(firstNotice.command[2] !== nextNotice.command[2])
        finish(firstNotice, "")
        finish(nextNotice, "")
      } finally {
        Commons.Color.foreground = previous
      }
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
      compare(process.command[separator + 1], "--urgency=critical")
      verify(process.command[separator + 2].indexOf("<img") >= 0)
      finish(process, "unknown\n")
      compare(host.opens, 0)
    }

    function test_native_boundary_gets_canonical_text_once() {
      var notifier = createTemporaryObject(nativeNotificationFactory, parent)
      verify(notifier)
      notifier.notify([{
        id: "opaque;$(touch /tmp/never-notification)",
        from: { display: "<img> & sender" },
        subject: "A < B & C", snippet: "line > next"
      }])
      compare(Quickshell.notifications.length, 1)
      compare(Quickshell.notifications[0].title, "<img> & sender")
      compare(Quickshell.notifications[0].body, "A < B & C\nline > next")
      compare(Quickshell.notifications[0].accountId, "imap:plain@example.org")
      compare(Quickshell.notifications[0].messageId,
        "opaque;$(touch /tmp/never-notification)")
      compare(latestNotification(notifier), null,
        "native delivery does not launch the plugin notification helper")
    }

    function test_standalone_without_native_notifications_runs_no_plugin_helper() {
      var notifier = createTemporaryObject(unavailableNotificationFactory, parent)
      verify(notifier)
      notifier.notify([{id:"7",from:{display:"Sender"},subject:"Subject",snippet:"Body"}])
      compare(Quickshell.notifications.length, 0)
      compare(latestNotification(notifier), null)
    }

    function soundCommands() {
      return Quickshell.detachedCommands.filter(function(command) {
        return String(command[1]).endsWith("/scripts/notify-sound.sh")
      })
    }

    function test_a_batch_plays_one_sound_only_when_enabled() {
      Quickshell.detachedCommands = []
      var arrivals = [{id:"1",from:{display:"A"}}, {id:"2",from:{display:"B"}}]
      var silent = createTemporaryObject(pluginNotificationFactory, parent)
      silent.notify(arrivals)
      verify(latestNotification(silent), "the notification itself was still sent")
      compare(soundCommands().length, 0)
      var audible = createTemporaryObject(pluginNotificationFactory, parent, { playSound: true })
      audible.notify(arrivals)
      compare(soundCommands().length, 1)
    }

    function test_the_saved_setting_decides_whether_an_account_plays_a_sound() {
      Quickshell.detachedCommands = []
      var account = service.findAccount(second)
      service.persistSetting("notifyNewMailSound", "On")
      compare(host.savedEntry.notifyNewMailSound, "On")
      finish(notification(account, [{ id: "audible" }]), "")
      compare(soundCommands().length, 1)
      service.persistSetting("notifyNewMailSound", "Off")
      compare(host.savedEntry.notifyNewMailSound, "Off")
      finish(notification(account, [{ id: "silent" }]), "")
      compare(soundCommands().length, 1)
    }

    function test_standalone_notifications_never_run_the_sound_helper() {
      Quickshell.detachedCommands = []
      var native = createTemporaryObject(nativeNotificationFactory, parent, { playSound: true })
      native.notify([{id:"1",from:{display:"A"}}])
      compare(Quickshell.notifications.length, 1)
      compare(soundCommands().length, 0)
      var unavailable = createTemporaryObject(unavailableNotificationFactory, parent, { playSound: true })
      unavailable.notify([{id:"1",from:{display:"A"}}])
      compare(soundCommands().length, 0)
    }
  }
}
