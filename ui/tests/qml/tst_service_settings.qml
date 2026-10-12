import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "../../components" as Components
import "../../account/Unified.js" as Unified
import "../../compose/Spelling.js" as Spelling

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

  Omamail.Service {
    id: scopedMailService
    shell: shellStore
    manifest: ({ id: "omamail" })
  }

  Components.SettingsPage {
    id: page
    width: parent.width
    service: mailService
    calendarController: null
    textColor: Qt.rgba(1, 1, 1, 1)
    dimColor: Qt.rgba(0.6, 0.6, 0.6, 1)
    accentColor: Qt.rgba(1, 0.5, 0, 1)
    urgentColor: Qt.rgba(1, 0.5, 0, 1)
    panelFontFamily: "sans"
  }

  TestCase {
    name: "ServiceSettings"

    function test_scoped_manifest_resolves_bundled_helpers_without_private_metadata() {
      verify(scopedMailService.pluginDir !== "")
      verify(scopedMailService.pluginDir.indexOf("%") < 0,
        "the filesystem path must be decoded before it is used as a process command")
      var pluginRoot = decodeURIComponent(String(Qt.resolvedUrl("../../.."))
        .replace(/^file:\/\//, "")).replace(/\/$/, "")
      compare(scopedMailService.pluginDir, pluginRoot,
        "the helper directory comes from Service.qml itself")
    }

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

    function test_ai_settings_reach_the_native_runner_and_preserve_other_preferences() {
      mailService.applySettings({showBarIcon:false})
      compare(mailService.aiAgent, "System default")
      compare(mailService.aiModel, "")
      mailService.setAiAgent("OpenCode")
      mailService.setAiModel(" fixture/model#variant ")
      compare(shellStore.updatedEntry.aiAgent, "OpenCode")
      compare(shellStore.updatedEntry.aiModel, "fixture/model#variant")
      compare(shellStore.updatedEntry.showBarIcon, false)
      tryCompare(mailService.agentRunner, "selectedAgent", "OpenCode")
      compare(mailService.agentRunner.selectedModel, "fixture/model#variant")
      mailService.applySettings({})
      compare(mailService.agentRunner.selectedAgent, "System default")
      compare(mailService.agentRunner.selectedModel, "")
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

    function test_legacy_preview_preferences_are_tolerated_without_controls() {
      mailService.applySettings({previewOnCursor: true, markReadDelaySec: 30})
      compare(mailService.settings.previewOnCursor, true)
      compare(mailService.settings.markReadDelaySec, 30)
      mailService.setShowBarIcon(false)
      compare(mailService.showBarIcon, false)
      compare(shellStore.updatedEntry.previewOnCursor, true)
      compare(shellStore.updatedEntry.markReadDelaySec, 30)
    }

    // ------------------------------------------------------------ spelling

    function test_spelling_defaults_on_and_persists_changes() {
      mailService.applySettings({})
      compare(mailService.spellingEnabled, true)
      compare(mailService.spellingLanguage, Spelling.resolveLanguage("", Qt.locale().name))

      mailService.setSpellingEnabled(false)
      compare(mailService.spellingEnabled, false)
      compare(shellStore.updatedEntry.spellingEnabled, false)

      // A stored value of another shape is not a decision to turn it off.
      mailService.applySettings({ spellingEnabled: "no" })
      compare(mailService.spellingEnabled, true)

      mailService.persistSetting("spellingLanguage", "en_GB")
      compare(mailService.spellingLanguage, "en_GB")
      compare(shellStore.updatedEntry.spellingLanguage, "en_GB")
    }

    function test_hostile_spelling_language_is_resolved_before_the_adapter() {
      for (var i = 0; i < 5; i++) {
        var values = ["../x", "en_US\n", "en_US\u0000", "éé", "x".repeat(500)]
        mailService.applySettings({ spellingLanguage: values[i] })
        compare(mailService.spellingLanguage, Spelling.resolveLanguage("", Qt.locale().name))
      }
      mailService.persistSetting("spellingLanguage", "")
      compare(shellStore.updatedEntry.spellingLanguage, "")
      compare(mailService.spellingLanguage, Spelling.resolveLanguage("", Qt.locale().name))
    }

    function test_spelling_setup_guidance_data() {
      return [
        { tag: "plugin-module", standalone: false, status: "no-module", enabled: true, message: "install the Sonnet QML module" },
        { tag: "plugin-dictionary", standalone: false, status: "no-dictionary", enabled: true, message: "The en_US dictionary is not installed" },
        { tag: "standalone-module", standalone: true, status: "no-module", enabled: true, message: "Spell-checking is not available in this build." },
        { tag: "standalone-dictionary", standalone: true, status: "no-dictionary", enabled: true, message: "Spell-checking is not available in this build." },
        { tag: "off", standalone: false, status: "disabled", enabled: false, message: "" },
        { tag: "loading", standalone: false, status: "loading", enabled: true, message: "" }
      ]
    }
    function test_spelling_setup_guidance(data) {
      try {
        page.service = { standalone: data.standalone, spellingEnabled: data.enabled,
          spellingStatus: data.status, spellingAvailable: false, spellingLanguage: "en_US",
          settings: { spellingLanguage: "en_US" }, accountSummaries: [] }
        var notice = findChild(page, "spellingNeedsSetup")
        compare(notice.visible, data.message !== "")
        if (data.message !== "") verify(notice.text.indexOf(data.message) >= 0)
      } finally { page.service = mailService }
    }
    function test_unset_system_language_guidance() {
      if (Spelling.validLanguage(Qt.locale().name)) { skip("requires C/POSIX system locale"); return }
      mailService.applySettings({ spellingLanguage: "" })
      compare(mailService.spellingLanguage, "")
      compare(findChild(page, "spellingLanguagePolicy").text,
        "No system language is set; choose one with the spellingLanguage setting.")
      compare(findChild(page, "spellingNeedsSetup").text.indexOf("The C dictionary"), -1)
    }

    function test_spelling_off_unloads_the_probe_and_hides_setup_warning() {
      mailService.applySettings({ spellingEnabled: false })
      compare(mailService.spellingStatus, "disabled")
      compare(mailService.spellingAvailable, false)
      var state = null
      for (var i = 0; i < mailService.children.length; i++) {
        if (mailService.children[i].enabledRequest !== undefined) state = mailService.children[i]
      }
      verify(state)
      var probe = state.children[0]
      compare(probe.active, false)
      compare(probe.item, null)
      compare(probe.status, Loader.Null)
      compare(findChild(page, "spellingNeedsSetup").visible, false)
      mailService.applySettings({})
    }

    // The probe loads Sonnet through the same adapter the composer uses; it
    // settles into one concrete status on any machine rather than hanging.
    function test_spelling_availability_settles_to_a_known_status() {
      mailService.applySettings({})
      tryVerify(function() {
        var status = mailService.spellingStatus
        return status === "ready" || status === "no-dictionary" || status === "no-module"
      }, 3000)
    }

    // Availability is about the requested dictionary, not a default-English
    // fallback: a missing language reads no-dictionary and setting it back
    // recovers.
    function test_spelling_availability_follows_the_requested_language() {
      tryVerify(function() {
        var status = mailService.spellingStatus
        return status === "ready" || status === "no-dictionary" || status === "no-module"
      }, 3000)
      if (mailService.spellingStatus === "no-module") { skip("Sonnet is not installed"); return }
      mailService.persistSetting("spellingLanguage", "en_US")
      tryVerify(function() {
        return mailService.spellingStatus === "ready" || mailService.spellingStatus === "no-dictionary"
      }, 3000)
      if (!mailService.spellingAvailable) { skip("en_US dictionary is not installed"); return }
      mailService.persistSetting("spellingLanguage", "zz_ZZ")
      tryVerify(function() { return mailService.spellingStatus === "no-dictionary" }, 3000)
      compare(mailService.spellingAvailable, false)
      mailService.persistSetting("spellingLanguage", "en_US")
      tryVerify(function() { return mailService.spellingStatus === "ready" }, 3000)
    }
  }
}
