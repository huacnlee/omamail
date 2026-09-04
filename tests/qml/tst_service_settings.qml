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

    // Off, and a settings file written before it existed is not an opt-in.
    function test_preview_on_cursor_is_off_until_it_is_asked_for() {
      mailService.applySettings({})
      compare(mailService.previewOnCursor, false)
      mailService.applySettings({ previewOnCursor: "yes" })
      compare(mailService.previewOnCursor, false, "only true is true")

      mailService.setPreviewOnCursor(true)
      compare(mailService.previewOnCursor, true)
      compare(shellStore.updatedEntry.previewOnCursor, true)
    }

    // Zero is a real answer here — read it the instant it is previewed — so
    // nothing that merely coerces to zero may be read as somebody asking for
    // it. A file that lost the key, or holds a word, gets the default dwell.
    function test_a_dwell_that_is_not_a_number_is_the_default() {
      mailService.applySettings({})
      compare(mailService.markReadDelaySec, 2, "a missing key is the default")

      mailService.applySettings({ markReadDelaySec: null })
      compare(mailService.markReadDelaySec, 2, "and so is null")

      mailService.applySettings({ markReadDelaySec: "" })
      compare(mailService.markReadDelaySec, 2, "and an empty string")

      mailService.applySettings({ markReadDelaySec: "soon" })
      compare(mailService.markReadDelaySec, 2, "and a word")

      mailService.applySettings({ markReadDelaySec: -5 })
      compare(mailService.markReadDelaySec, 2,
        "a negative interval never fires at all")

      mailService.applySettings({ markReadDelaySec: 0 })
      compare(mailService.markReadDelaySec, 0, "but a typed zero is kept")

      mailService.applySettings({ markReadDelaySec: 900 })
      compare(mailService.markReadDelaySec, 30, "and a long one is clamped")
    }
  }
}
