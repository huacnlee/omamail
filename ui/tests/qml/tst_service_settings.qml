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

  // The personal dictionary write is asynchronous and may fail. This stands in
  // for the host writer so a test can hold the reply and complete it later.
  QtObject {
    id: configPlatform
    property var writes: []
    property var callbacks: []
    function writeConfig(name, text, callback) {
      writes = writes.concat([{ name: String(name), text: String(text) }])
      callbacks = callbacks.concat([callback])
      return true
    }
    function confirm(index, ok, error) {
      var cb = callbacks[index]
      if (typeof cb !== "function") return false
      var next = callbacks.slice()
      next[index] = null
      callbacks = next
      cb(ok, error)
      return true
    }
  }

  Omamail.Service {
    id: mailService
    shell: shellStore
    platform: configPlatform
    manifest: ({ id: "omamail", __sourceDir: "/tmp/omamail-test" })
  }

  Omamail.Service {
    id: scopedMailService
    shell: shellStore
    manifest: ({ id: "omamail" })
  }

  TestCase {
    name: "ServiceSettings"

    function init() {
      configPlatform.writes = []
      configPlatform.callbacks = []
      mailService.spellingWordStore.writing = false
      mailService.spellingWordStore.pending = false
      mailService.spellingWordStore.error = ""
    }

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
      compare(mailService.spellingLanguage, "en_US")

      mailService.setSpellingEnabled(false)
      compare(mailService.spellingEnabled, false)
      compare(shellStore.updatedEntry.spellingEnabled, false)

      // A stored value of another shape is not a decision to turn it off.
      mailService.applySettings({ spellingEnabled: "no" })
      compare(mailService.spellingEnabled, true)

      mailService.setSpellingLanguage("en_GB")
      compare(mailService.spellingLanguage, "en_GB")
      compare(shellStore.updatedEntry.spellingLanguage, "en_GB")
    }

    function test_spelling_personal_words_add_remove_and_dedupe() {
      mailService.spellingWordStore.apply("")
      compare(mailService.spellingPersonalWords.length, 0)
      mailService.addPersonalWord("blorptar")
      mailService.addPersonalWord("blorptar")
      mailService.addPersonalWord("floobert")
      compare(mailService.spellingPersonalWords.length, 2)
      compare(mailService.spellingPersonalWords[0], "blorptar")
      mailService.removePersonalWord("blorptar")
      compare(mailService.spellingPersonalWords.length, 1)
      compare(mailService.spellingPersonalWords[0], "floobert")
    }

    function test_spelling_personal_words_parse_dedupe_and_ignore_junk() {
      mailService.spellingWordStore.apply('{"words":["a","b","a","","c",42,null]}')
      compare(mailService.spellingPersonalWords.length, 3)
      compare(mailService.spellingPersonalWords[0], "a")
      compare(mailService.spellingPersonalWords[1], "b")
      compare(mailService.spellingPersonalWords[2], "c")
    }

    // Two words added while the first write is still in flight: the second is
    // queued and written after the first completes, so disk ends with both.
    function test_spelling_personal_words_queue_changes_during_a_write() {
      mailService.spellingWordStore.apply("")
      configPlatform.writes = []
      configPlatform.callbacks = []
      mailService.addPersonalWord("alpha")
      compare(configPlatform.writes.length, 1)
      compare(JSON.parse(configPlatform.writes[0].text).words.length, 1)
      mailService.addPersonalWord("beta")
      compare(configPlatform.writes.length, 1, "the second add waits for the in-flight write")
      compare(configPlatform.confirm(0, true, ""), true)
      compare(configPlatform.writes.length, 2, "the queued snapshot is written once the first completes")
      compare(JSON.parse(configPlatform.writes[1].text).words.length, 2)
      compare(configPlatform.confirm(1, true, ""), true)
      compare(mailService.spellingPersonalWordsError, "")
    }

    // A refused write is recorded rather than swallowed, and the next change
    // asks the host again.
    function test_spelling_personal_words_retry_after_a_failed_write() {
      mailService.spellingWordStore.apply("")
      configPlatform.writes = []
      configPlatform.callbacks = []
      mailService.addPersonalWord("alpha")
      compare(configPlatform.confirm(0, false, "disk full"), true)
      compare(mailService.spellingPersonalWordsError, "disk full")
      mailService.addPersonalWord("beta")
      compare(configPlatform.writes.length, 2, "a later change retries the failed write")
      compare(configPlatform.confirm(1, true, ""), true)
      compare(mailService.spellingPersonalWordsError, "")
    }

    // Write then read: what a completed write put in the file is what a later
    // read restores, which is the restart guarantee the old path never had.
    function test_spelling_personal_words_round_trip_through_a_restart() {
      mailService.spellingWordStore.apply("")
      configPlatform.writes = []
      configPlatform.callbacks = []
      mailService.addPersonalWord("blorptar")
      compare(configPlatform.confirm(0, true, ""), true)
      var saved = configPlatform.writes[0].text
      // A restart reads the file back with no words in memory.
      mailService.spellingWordStore.apply(saved)
      compare(mailService.spellingPersonalWords.length, 1)
      compare(mailService.spellingPersonalWords[0], "blorptar")
    }

    // A word added before the initial read returns is the session's, not the
    // file's: the later load unions the two instead of replacing memory.
    function test_spelling_personal_words_merge_a_late_load() {
      mailService.spellingWordStore.apply("")
      configPlatform.writes = []
      configPlatform.callbacks = []
      mailService.spellingWordStore.loaded = false
      mailService.addPersonalWord("alpha")
      compare(configPlatform.writes.length, 0, "nothing is written before the load completes")
      mailService.spellingWordStore.merge('{"words":["beta","alpha"]}')
      compare(mailService.spellingPersonalWords.length, 2)
      verify(mailService.spellingPersonalWords.indexOf("alpha") >= 0)
      verify(mailService.spellingPersonalWords.indexOf("beta") >= 0)
      compare(configPlatform.writes.length, 1, "the deferred add is flushed after the load")
      compare(configPlatform.confirm(0, true, ""), true)
    }

    // The probe loads Sonnet through the same adapter the composer uses; it
    // settles into one concrete status on any machine rather than hanging.
    function test_spelling_availability_settles_to_a_known_status() {
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
      mailService.setSpellingLanguage("en_US")
      tryVerify(function() {
        return mailService.spellingStatus === "ready" || mailService.spellingStatus === "no-dictionary"
      }, 3000)
      if (!mailService.spellingAvailable) { skip("en_US dictionary is not installed"); return }
      mailService.setSpellingLanguage("zz_ZZ")
      tryVerify(function() { return mailService.spellingStatus === "no-dictionary" }, 3000)
      compare(mailService.spellingAvailable, false)
      mailService.setSpellingLanguage("en_US")
      tryVerify(function() { return mailService.spellingStatus === "ready" }, 3000)
    }
  }
}
