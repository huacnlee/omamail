import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "../../account/Unified.js" as Unified

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

    function test_unified_mailboxes_setting_defaults_off_and_persists_changes() {
      mailService.applySettings({})
      compare(mailService.unifiedMailboxes, false)

      mailService.setUnifiedMailboxes(true)
      compare(mailService.unifiedMailboxes, true)
      compare(shellStore.updatedId, "omamail")
      verify(shellStore.updatedEntry !== null)
      compare(shellStore.updatedEntry.unifiedMailboxes, true)
    }

    // The setting is what the user asked for; `unified` is whether it means
    // anything. One mailbox combined with nothing is the mailbox, and merging
    // would spend a copy of every row to arrive at the same list.
    function test_one_mailbox_is_never_combined_whatever_the_setting_says() {
      mailService.applySettings({ unifiedMailboxes: true })
      compare(mailService.unifiedMailboxes, true)
      compare(mailService.accountCount, 0)
      compare(mailService.unified, false)
    }

    // With nothing to merge the façade still answers, and answers as the
    // single-mailbox view it is: an empty list rather than a broken binding.
    function test_the_combined_answers_hold_up_with_no_mailboxes() {
      mailService.applySettings({ unifiedMailboxes: true })
      compare(mailService.messages.length, 0)
      compare(mailService.inboxUnread, 0)
      compare(mailService.lastError, "")
      compare(mailService.selectedId, "")
      compare(mailService.mailboxKey, "inbox")
      verify(mailService.mailboxes.length > 0,
        "the rail still has rows to draw before a mailbox is added")
    }

    // Composed ids are the service's own vocabulary, so an action naming one
    // reaches no mailbox rather than the wrong one, and reaching none is a
    // refusal rather than a throw.
    //
    // That a *bare* id is not mistaken for a composed one is the separator's
    // own property and is measured in tests/test_unified.js, against the id
    // shapes the three providers actually issue — there is no account here for
    // a wrong split to land on, so this file could not tell the difference.
    function test_an_action_for_a_mailbox_that_is_not_here_reaches_nothing() {
      mailService.applySettings({ unifiedMailboxes: true })
      var absent = Unified.unifiedId("gone@example.org", "42")
      compare(mailService.act(absent, "archive"), false)
      compare(mailService.hostForId(absent), null)
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
