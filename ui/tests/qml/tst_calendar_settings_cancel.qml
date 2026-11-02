import QtQuick 2.15
import QtTest 1.3
import qs.Commons as Commons
import "../../components" as Components
import "../../calendar" as Calendar

// Both CalDAV editors' Cancel while the backend holds the password check. The
// production section over the production controller, so what is asserted is
// the editor's own Cancel ending in no settings and no keyring write when the
// answer arrives later; tst_calendar_controller.qml covers the controller
// alone. The fixture stands in for Service.qml and holds every calendar.verify
// and calendars.json write until the test releases it.
Item {
  width: 600
  height: 800

  QtObject {
    id: mailService
    property bool unifiedCalendarView: false
    property bool alwaysShowImages: false
    property bool alwaysRenderHeavyMessages: false
    property int undoSendSeconds: 10
    property var accountSummaries: [
      { id: "imap:work@example.com", email: "work@example.com", provider: "imap", signedIn: true }
    ]
    property bool backendCanDiscoverCalendars: true
    property bool backendCanGoogleCalendars: true
    property bool backendCanSaveInvitations: true
    property var settings: ({})
    function persistSetting(name, value) { var next = {}; next[name] = value; mailService.settings = next }
    property bool calendarRemindersEnabled: true
    property int calendarSnoozeMinutes: 5
    property string calendarReminderError: ""
    property var auth: null
    function setUnifiedCalendarView(value) { unifiedCalendarView = value === true }

    property var verifyRequests: []
    property var verifyCallbacks: []
    property var configWrites: []
    property var configCallbacks: []
    property var credentialWrites: []
    property var backend: ({ ready: true, apiVersion: 10, call: function(method, params, callback) {
      if (method === "calendar.verify") {
        mailService.verifyRequests.push({ method: method, params: params })
        mailService.verifyCallbacks.push(callback)
        return
      }
      callback({ body: "{}", status: 200 }, null)
    } })
    function credentialPut(kind, accountId, clientId, secret, callback) {
      credentialWrites.push({ kind: kind, accountId: accountId, secret: secret })
      callback(true, "")
      return true
    }
    function writeConfig(name, payload, callback) {
      configWrites.push({ name: name, payload: payload })
      configCallbacks.push(callback)
    }
    function withGoogleAccessToken(_accountId, callback) { callback("", "not used") }
  }

  Calendar.CalendarController {
    id: controller
    service: mailService
    pluginDir: "/tmp/omamail-test"
    accountId: "imap:work@example.com"
  }

  Components.CalendarSettings {
    id: section
    width: parent.width
    service: mailService
    controller: controller
    textColor: Commons.Color.foreground
    dimColor: Commons.Color.foreground
    accentColor: Commons.Color.accent
    urgentColor: Commons.Color.accent
    panelFontFamily: "monospace"
  }

  TestCase {
    name: "CalendarSettingsCancel"
    when: windowShown
    SignalSpy { id: savedSpy; target: controller; signalName: "calendarSaved" }

    readonly property var teamCalendar: ({
      id: "caldav:team", kind: "caldav", name: "Team",
      url: "https://calendar.example/team/", username: "work@example.com",
      enabled: true, readOnly: false, colorKey: "accent" })

    // The Column and Row positioners place their children at polish time, so
    // a click after an editor opens or closes waits for the frame that does it.
    // A save a failed case left mid-check or mid-write is cancelled or finished
    // first, so one failure does not disable the editors for the cases after
    // it, and the result line is cleared because the row editor's Save does
    // not clear it.
    function init() {
      if (typeof controller.cancelSourceSave === "function") controller.cancelSourceSave()
      mailService.verifyCallbacks = []
      while (mailService.configCallbacks.length) mailService.configCallbacks.pop()(true, "")
      controller.sourceList = ({ version: 1, sources: [teamCalendar] })
      resultText().text = ""
      resultText().ok = false
      mailService.verifyRequests = []
      mailService.configWrites = []
      mailService.configCallbacks = []
      mailService.credentialWrites = []
      section.adding = false
      section.passwordEditingId = ""
      savedSpy.clear()
      waitForRendering(section)
    }

    // The visible one: each calendar row keeps a hidden replacement-password
    // field with the same placeholder as the add form's.
    function fieldWithPlaceholder(item, text) {
      if (!item) return null
      if (item.placeholderText === text && item.visible) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var found = fieldWithPlaceholder(values[i], text)
        if (found) return found
      }
      return null
    }
    function buttonWithText(item, text) {
      if (!item) return null
      if (item.text === text && item.visible && item.hasOwnProperty("iconName")) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var found = buttonWithText(values[i], text)
        if (found) return found
      }
      return null
    }
    function resultText() {
      var items = [section]
      while (items.length) {
        var item = items.shift()
        if (item.hasOwnProperty("ok") && item.hasOwnProperty("wrapMode")) return item
        var values = item.children || []
        for (var i = 0; i < values.length; i++) items.push(values[i])
      }
      return null
    }
    function answerLastCheck(result, error) {
      var callback = mailService.verifyCallbacks.pop()
      verify(typeof callback === "function", "a check was held")
      callback(result, error)
    }

    function test_cancelling_the_add_editor_during_the_check_writes_nothing() {
      mouseClick(buttonWithText(section, "Connect a CalDAV calendar..."))
      tryCompare(section, "adding", true)
      waitForRendering(section)
      fieldWithPlaceholder(section, "Calendar name").text = "Home"
      fieldWithPlaceholder(section, "CalDAV URL").text = "https://caldav.example.net/dav/home/"
      fieldWithPlaceholder(section, "Username").text = "me@example.net"
      fieldWithPlaceholder(section, "Password or app password").text = "withdrawn-secret"
      mouseClick(buttonWithText(section, "Add calendar"))
      tryCompare(controller, "savingSource", true)
      compare(mailService.verifyCallbacks.length, 1, "the check is held")
      var cancel = buttonWithText(section, "Cancel")
      compare(cancel.enabled, true, "Cancel is offered while the check is out")
      mouseClick(cancel)
      tryCompare(section, "adding", false)
      answerLastCheck({ verified: true }, null)
      compare(mailService.configWrites.length, 0, "the cancelled calendar is not written")
      compare(mailService.credentialWrites.length, 0, "the withdrawn password is not stored")
      compare(savedSpy.count, 0)
      compare(controller.sourceList.sources.length, 1)
      compare(controller.savingSource, false)
      compare(resultText().text, "", "nothing is reported for a cancelled add")
      compare(section.adding, false)
    }

    function test_cancelling_the_password_editor_during_the_check_keeps_the_saved_password() {
      mouseClick(buttonWithText(section, "Set password"))
      tryCompare(section, "passwordEditingId", "caldav:team")
      waitForRendering(section)
      fieldWithPlaceholder(section, "Password or app password").text = "withdrawn-secret"
      mouseClick(buttonWithText(section, "Save"))
      tryCompare(controller, "savingSource", true)
      compare(mailService.verifyCallbacks.length, 1, "the check is held")
      var cancel = buttonWithText(section, "Cancel")
      compare(cancel.enabled, true, "Cancel is offered while the check is out")
      mouseClick(cancel)
      tryCompare(section, "passwordEditingId", "")
      answerLastCheck({ verified: true }, null)
      compare(mailService.credentialWrites.length, 0, "the saved password is not overwritten")
      compare(mailService.configWrites.length, 0)
      compare(savedSpy.count, 0)
      compare(resultText().text, "")
      compare(controller.savingSource, false)
    }

    // Once the server has accepted the password the settings write is under
    // way; Cancel is not offered, the write finishes and the password follows.
    function test_cancel_is_not_offered_during_the_write_after_an_accepted_check() {
      mouseClick(buttonWithText(section, "Connect a CalDAV calendar..."))
      tryCompare(section, "adding", true)
      waitForRendering(section)
      fieldWithPlaceholder(section, "Calendar name").text = "Home"
      fieldWithPlaceholder(section, "CalDAV URL").text = "https://caldav.example.net/dav/home/"
      fieldWithPlaceholder(section, "Username").text = "me@example.net"
      fieldWithPlaceholder(section, "Password or app password").text = "right-secret"
      mouseClick(buttonWithText(section, "Add calendar"))
      tryCompare(controller, "savingSource", true)
      answerLastCheck({ verified: true }, null)
      compare(mailService.configWrites.length, 1, "the calendar list write has started")
      var cancel = buttonWithText(section, "Cancel")
      tryCompare(cancel, "enabled", false)
      mouseClick(cancel)
      compare(section.adding, true, "a disabled Cancel does nothing")
      compare(controller.savingSource, true)
      mailService.configCallbacks.pop()(true, "")
      tryCompare(section, "adding", false)
      compare(mailService.credentialWrites.length, 1)
      compare(mailService.credentialWrites[0].accountId, "caldav:caldav-example-net-dav-home")
      compare(savedSpy.count, 1)
      compare(savedSpy.signalArguments[0][0], true)
      compare(resultText().text, "Calendar saved")
      compare(controller.sourceList.sources.length, 2)
    }
  }
}
