import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import "../../components" as Omamail

// What Settings says about read state has to match what the app does with it.
// With automatic marking off nothing marks a message read on its own, so the
// preview row must not promise a dwell that reads one, and the dwell row has
// nothing left to configure.
Item {
  width: 600
  height: 1600

  QtObject {
    id: mailService

    property bool unifiedCalendarView: false
    property bool alwaysShowImages: false
    property bool alwaysRenderHeavyMessages: false
    property int undoSendSeconds: 10
    property var accountSummaries: []
    property var auth: null
    property bool previewOnCursor: true
    property bool markReadAutomatically: true
    property int markReadDelaySec: 2

    function setMarkReadAutomatically(value) { markReadAutomatically = value === true }
    function setPreviewOnCursor(value) { previewOnCursor = value === true }
  }

  QtObject {
    id: calendarController

    property var sourceList: ({ version: 1, sources: [] })
    property bool savingSource: false
    signal calendarSaved(bool ok, string error)

    function addCalDavCalendar(_source, _password) {}
    function removeCalendar(_sourceId) {}
    function updateCalendarPassword(_source, _password) {}
  }

  Omamail.SettingsPage {
    id: settings
    width: parent.width
    service: mailService
    calendarController: calendarController
    textColor: Color.foreground
    dimColor: Color.foreground
    accentColor: Color.accent
    urgentColor: Color.accent
    panelFontFamily: "monospace"
  }

  TestCase {
    name: "SettingsReadMarking"
    when: windowShown

    function init() {
      mailService.previewOnCursor = true
      mailService.markReadAutomatically = true
    }

    function test_the_switch_turns_automatic_marking_off() {
      var toggle = findChild(settings, "markReadAutomaticallySwitch")
      verify(toggle !== null)
      compare(toggle.checked, true)

      toggle.toggled()
      compare(mailService.markReadAutomatically, false)
      compare(toggle.checked, false)
    }

    // The preview row used to say a previewed message is read once the cursor
    // stays on it, which stops being true the moment marking is manual.
    function test_the_preview_caption_follows_the_setting() {
      var caption = findChild(settings, "previewOnCursorCaption")
      verify(caption !== null)
      verify(caption.text.indexOf("marked read only once") >= 0)

      mailService.markReadAutomatically = false
      compare(caption.text.indexOf("marked read only once"), -1,
        "no dwell reads anything, so the caption does not promise one")
      verify(caption.text.indexOf("stays unread") >= 0)
    }

    function test_the_dwell_row_is_hidden_when_nothing_would_use_it() {
      var field = findChild(settings, "markReadDelayField")
      verify(field !== null)
      compare(field.parent.visible, true)

      mailService.markReadAutomatically = false
      compare(field.parent.visible, false)
    }
  }
}
