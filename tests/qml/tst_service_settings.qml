import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail

Item {
  width: 400
  height: 300

  QtObject {
    id: shellStore

    property string updatedId: ""
    property var updatedEntry: null

    function updateEntryInline(id, entry) {
      updatedId = String(id)
      updatedEntry = entry
    }
  }

  Omamail.Service {
    id: mailService
    shell: shellStore
    manifest: ({ id: "omamail", __sourceDir: "/tmp/omamail-test" })
  }

  TestCase {
    name: "ServiceSettings"

    // On unless a stored `false` says otherwise. Settings written before this
    // existed name no key at all and so keep their icon, and a value of some
    // other shape — a hand-edited `shell.json`, say — is not an answer
    // anybody gave in the interface.
    function test_the_bar_icon_is_shown_unless_it_was_turned_off() {
      mailService.applySettings({})
      compare(mailService.showBarIcon, true)

      mailService.applySettings({ showBarIcon: false })
      compare(mailService.showBarIcon, false)

      mailService.applySettings({ showBarIcon: true })
      compare(mailService.showBarIcon, true)

      // A stored value of some other shape is not a decision to hide it.
      mailService.applySettings({ showBarIcon: "no" })
      compare(mailService.showBarIcon, true,
        "only a stored false hides the icon")
    }

    function test_hiding_the_bar_icon_persists() {
      mailService.applySettings({})
      mailService.setShowBarIcon(false)
      compare(mailService.showBarIcon, false)
      compare(shellStore.updatedId, "omamail")
      verify(shellStore.updatedEntry !== null)
      compare(shellStore.updatedEntry.showBarIcon, false)
    }

    function test_unified_calendar_setting_defaults_off_and_persists_changes() {
      mailService.applySettings({})
      compare(mailService.unifiedCalendarView, false)

      mailService.setUnifiedCalendarView(true)
      compare(mailService.unifiedCalendarView, true)
      compare(shellStore.updatedId, "omamail")
      verify(shellStore.updatedEntry !== null)
      compare(shellStore.updatedEntry.unifiedCalendarView, true)
    }
  }
}
