import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

Item {
  width: 900
  height: 600

  QtObject {
    id: contacts
    property var recipientContacts: []
    property bool backendCanGoogleCalendars: true
    property int refreshCalls: 0
    function refreshRecipientContacts() { refreshCalls++ }
  }
  QtObject {
    id: eventController
    property var service: contacts
    property bool creatingEvent: false
    property bool eventWriting: false
    property int createCalls: 0
    property int updateCalls: 0
    property var createdFields: null
    property var transferCallback: null
    function findSource(id) {
      for (var i=0;i<writableSourceGroups.length;i++)
        for (var j=0;j<writableSourceGroups[i].calendars.length;j++)
          if (writableSourceGroups[i].calendars[j].id === id) return writableSourceGroups[i].calendars[j]
      return null
    }
    function transferEvent(sourceId, destinationId, event, callback) {
      eventWriting = true
      transferCallback = callback
      return true
    }
    property string accountId: ""
    property bool composerHeld: false
    property var writableSourceGroups: [{
      id: "google:me@example.com", providerLabel: "Google", accountLabel: "me@example.com",
      calendars: [{ id: "google:me@example.com", name: "me@example.com", colorKey: "accent" }]
    }, {
      id: "account:imap:bob@example.com", providerLabel: "CalDAV", accountLabel: "bob@example.com",
      calendars: [{ id: "caldav:bob-home", name: "Home", colorKey: "accent" }]
    }]

    signal eventCreated(bool ok, string error)
    signal eventUpdated(bool ok, string error)
    signal composeRequested(var prefill)
    signal composeEnded()

    function createEvent(_sourceId, _fields) {
      if (creatingEvent || eventWriting) return false
      createCalls++
      createdFields = _fields
      creatingEvent = true
      return true
    }

    function updateEvent(_sourceId, _event, _fields) {
      if (creatingEvent || eventWriting) return false
      updateCalls++
      eventWriting = true
      return true
    }
  }

  Omamail.CalendarEventComposer {
    id: composer
    anchors.fill: parent
    controller: eventController
    textColor: Qt.rgba(1, 1, 1, 1)
    backgroundColor: Qt.rgba(0.06, 0.06, 0.06, 1)
    accentColor: Qt.rgba(1, 0.5, 0, 1)
    urgentColor: Qt.rgba(1, 0.2, 0.2, 1)
    dimColor: Qt.rgba(0.67, 0.67, 0.67, 1)
    panelFontFamily: "monospace"
  }

  TestCase {
    Omamail.KeyRouter {
      context: composer.opened ? (composer.guestSuggestionsOpen ? "eventGuests" : "eventCompose") : ""
      onTriggered: function(id) {
        if (id === "saveEvent") composer.submit("all")
        if (id === "guestNext") composer.moveGuestSuggestion(1)
        if (id === "guestPrevious") composer.moveGuestSuggestion(-1)
        if (id === "guestChoose") composer.chooseGuestSuggestion()
        if (id === "back") composer.dismissGuestSuggestions()
      }
    }
    name: "CalendarEventComposer"
    when: windowShown
    property var initialGroups: JSON.parse(JSON.stringify(eventController.writableSourceGroups))

    function init() {
      eventController.creatingEvent = false
      eventController.eventWriting = false
      eventController.createCalls = 0
      eventController.updateCalls = 0
      eventController.writableSourceGroups = JSON.parse(JSON.stringify(initialGroups))
      eventController.transferCallback = null
      composer.close()
      composer.writePending = false
      contacts.recipientContacts = []
      contacts.refreshCalls = 0
    }

    function test_microsoft_creation_keeps_basic_fields_without_repetition() {
      var groups = JSON.parse(JSON.stringify(initialGroups))
      groups[0].calendars[0].kind = "microsoft"
      eventController.writableSourceGroups = groups
      composer.begin()
      findChild(composer, "event-title-field").text = "Basic Outlook event"
      compare(findChild(composer, "event-repeat-selector").visible, false)
      // A previous calendar selection must not leak a hidden repeat setting.
      composer.recurring = true
      composer.submit("all")
      compare(eventController.createCalls, 1)
      compare(eventController.createdFields.recurrence.enabled, false)
    }

    function test_guest_suggestions_reuse_mail_contacts_without_submitting() {
      var groups = JSON.parse(JSON.stringify(initialGroups))
      groups[0].calendars[0].kind = "google"
      eventController.writableSourceGroups = groups
      composer.begin()
      compare(contacts.refreshCalls, 1)
      wait(0)
      var guests = findChild(composer, "event-guests-field")
      var list = findChild(composer, "event-guest-suggestions")
      findChild(composer, "event-title-field").text = "Guests"
      guests.forceActiveFocus()
      guests.text = "sam"
      compare(composer.guestSuggestions.length, 0)
      contacts.recipientContacts = [{name:"Sam Adams",email:"sam@example.test"},
        {name:"Sam Brown",email:"brown@example.test"}]
      compare(composer.guestSuggestions.length, 2)
      keyClick(Qt.Key_Down)
      keyClick(Qt.Key_Down)
      compare(list.currentIndex, 1)
      keyClick(Qt.Key_Return)
      compare(guests.text, "brown@example.test, ")
      compare(eventController.createCalls, 0)
      guests.text += "sam"
      compare(composer.guestSuggestions.length, 1)
      keyClick(Qt.Key_Escape)
      compare(composer.guestSuggestionsOpen, false)
      compare(composer.opened, true)
      guests.text += " "
      compare(composer.guestSuggestionsOpen, true)
      var scroll = findChild(composer, "event-composer-scroll")
      tryVerify(function() { return list.height > 40 })
      tryVerify(function() {
        var top = list.mapToItem(scroll, 0, 0).y
        return top >= 0 && top + list.height <= scroll.height
      })
      waitForRendering(list)
      wait(50)
      mouseClick(list, list.width / 2, 15)
      compare(guests.text, "brown@example.test, sam@example.test, ")
      compare(composer.guestSuggestionsOpen, false)
      keyClick(Qt.Key_Return)
      compare(eventController.createCalls, 1)
    }

    function test_enter_creates_and_closes_only_after_success() {
      composer.begin()
      var title = findChild(composer,"event-title-field")
      title.text = "Keyboard creation"
      title.forceActiveFocus()
      keyClick(Qt.Key_Return)
      compare(eventController.createCalls,1)
      compare(composer.opened,true)
      keyClick(Qt.Key_Return)
      compare(eventController.createCalls,1)
      eventController.creatingEvent = false
      eventController.eventCreated(false,"Try again")
      compare(composer.opened,true)
      keyClick(Qt.Key_Return)
      compare(eventController.createCalls,2)
      eventController.creatingEvent = false
      eventController.eventCreated(true,"")
      compare(composer.opened,false)
    }

    function test_save_failure_stays_visible_without_scrolling() {
      composer.begin()
      findChild(composer, "event-title-field").text = "Error visibility"
      composer.recurring = true
      composer.reminderMode = "custom"
      composer.submit("all")
      eventController.creatingEvent = false
      eventController.eventCreated(false, "Could not save this event. Your changes are still here. Please try again.")
      wait(0)
      var error = findChild(composer, "event-save-error")
      var footer = findChild(composer, "event-editor-footer")
      var scroll = findChild(composer, "event-composer-scroll")
      verify(error.visible)
      verify(error.mapToItem(composer, 0, 0).y >= 0)
      verify(error.mapToItem(composer, 0, error.height).y <= composer.height)
      verify(scroll.y + scroll.height <= footer.y)
      scroll.contentY = Math.max(0, scroll.contentHeight - scroll.height)
      verify(error.mapToItem(composer, 0, error.height).y <= composer.height)
      verify(composer.opened)
    }

    function test_enter_saves_an_edited_event() {
      composer.beginEdit("google:me@example.com",{googleId:"one",sourceId:"google:me@example.com",summary:"Existing",
        start:{ms:Date.now()},end:{ms:Date.now()+3600000}})
      var title = findChild(composer,"event-title-field")
      title.text = "Updated"
      title.forceActiveFocus()
      keyClick(Qt.Key_Enter)
      compare(eventController.updateCalls,1)
      eventController.eventWriting = false
      eventController.eventUpdated(true,"")
      compare(composer.opened,false)
    }

    function test_invalid_range_disables_save_and_blocks_enter() {
      composer.begin()
      var title = findChild(composer,"event-title-field")
      title.text = "Range validation"
      findChild(composer,"event-start-date-field").text = "2026-09-09"
      findChild(composer,"event-end-date-field").text = "2026-09-09"
      findChild(composer,"event-start-time-field").text = "11:15"
      findChild(composer,"event-end-time-field").text = "05:15"
      var save = findChild(composer,"event-save-button")
      compare(save.enabled,false)
      verify(findChild(composer,"event-date-range-error").visible)
      title.forceActiveFocus()
      keyClick(Qt.Key_Return)
      compare(eventController.createCalls,0)
      compare(composer.writePending,false)
      findChild(composer,"event-end-date-field").text = "2026-09-10"
      compare(save.enabled,true)
      composer.allDay = true
      findChild(composer,"event-end-date-field").text = "2026-09-08"
      compare(save.enabled,false)
      findChild(composer,"event-end-date-field").text = "2026-09-09"
      compare(save.enabled,true)
    }

    // A suggestion from a message opens the form filled in, on the
    // calendar the reading mailbox prefers, with nothing written yet.
    function test_all_day_prefill_uses_inclusive_last_day_without_writing() {
      composer.beginWith({startMs:new Date(2026,9,1).getTime(),endMs:new Date(2026,9,3).getTime(),allDay:true})
      compare(composer.allDay, true)
      compare(findChild(composer,"event-end-date-field").text, "2026-10-02")
      compare(eventController.createCalls, 0)
    }
    function test_calendar_dropdown_groups_accounts_and_selects_without_creating() {
      composer.begin()
      wait(0)
      var selector=findChild(composer,"event-calendar-selector")
      compare(selector.count,2)
      mouseClick(selector,selector.width/2,selector.height/2)
      tryCompare(selector.popup,"opened",true)
      tryVerify(function() { return selector.popup.contentItem.itemAtIndex(1) !== null })
      var option=selector.popup.contentItem.itemAtIndex(1)
      mouseClick(option,option.width/2,option.height-8)
      compare(composer.selectedSourceId,"caldav:bob-home")
      compare(eventController.createCalls,0)
    }
    function test_transfer_preserves_unsaved_fields_and_failure_restores_selection() {
      eventController.writableSourceGroups=[{providerLabel:"Google",accountLabel:"me@example.test",calendars:[
        {id:"original",name:"Original",kind:"google",accountId:"me@example.test"},
        {id:"destination",name:"Destination",kind:"google",accountId:"me@example.test"}]}]
      var event={googleId:"one",sourceId:"original",summary:"Saved title",eventType:"default",organizer:{self:true},etag:"old",
        start:{ms:Date.now()},end:{ms:Date.now()+3600000}}
      composer.beginEdit("original",event)
      findChild(composer,"event-title-field").text="Unsaved title"
      composer.chooseCalendar("destination")
      compare(composer.transferring,true)
      compare(eventController.updateCalls,0)
      eventController.eventWriting=false
      eventController.transferCallback(null,"Move failed")
      compare(composer.selectedSourceId,"original")
      compare(composer.titleText(),"Unsaved title")
      composer.chooseCalendar("destination")
      var moved=JSON.parse(JSON.stringify(event)); moved.sourceId="destination"; moved.etag="new"
      eventController.eventWriting=false
      eventController.transferCallback(moved,"")
      compare(composer.editingSourceId,"destination")
      compare(composer.editingEvent.etag,"new")
      compare(composer.titleText(),"Unsaved title")
      compare(eventController.updateCalls,0)
    }

    function test_repeat_dropdown_sets_schedule_directly() {
      composer.begin()
      wait(0)
      var selector = findChild(composer,"event-repeat-selector")
      compare(selector.currentIndex,0)
      selector.chosen("WEEKLY")
      compare(composer.recurring,true)
      compare(composer.recurrenceFrequency,"WEEKLY")
      selector.chosen("none")
      compare(composer.recurring,false)
      compare(eventController.createCalls,0)
    }

    function test_begin_with_fills_the_fields_and_writes_nothing() {
      var start = new Date(2026, 8, 12, 19, 0).getTime()
      eventController.composeRequested({ title: "Dinner with Bob", startMs: start, endMs: start + 7200000,
        location: "Luigi's", description: "Table for four" })
      compare(composer.opened, true)
      compare(composer.titleText(), "Dinner with Bob")
      compare(composer.whenText(), "2026-09-12 19:00 21:00")
      compare(composer.locationText(), "Luigi's")
      compare(composer.notesText(), "Table for four")
      compare(eventController.createCalls, 0, "nothing is written until the owner says so")
      composer.submit()
      compare(eventController.createCalls, 1)
    }

    // A form the owner is in the middle of is not replaced by a suggestion;
    // an empty one is. The suggestion's own mailbox chooses the calendar.
    function test_a_suggestion_does_not_clobber_a_form_in_use() {
      composer.beginAt(new Date(2026, 7, 25, 9, 0).getTime())
      compare(composer.pristine, true)
      compare(eventController.composerHeld, false)
      compare(composer.beginWith({ title: "Dinner", startMs: new Date(2026, 8, 12, 19, 0).getTime(),
        endMs: new Date(2026, 8, 12, 20, 0).getTime(), accountId: "imap:bob@example.com" }), true,
        "an empty form gives way")
      compare(composer.titleText(), "Dinner")
      compare(composer.selectedSourceId, "caldav:bob-home", "on the mailbox's own calendar")
      compare(eventController.composerHeld, true, "and now the form is in use")
      compare(composer.beginWith({ title: "Other", startMs: new Date(2026, 8, 13, 19, 0).getTime(),
        endMs: new Date(2026, 8, 13, 20, 0).getTime() }), false, "a second suggestion does not replace it")
      compare(composer.titleText(), "Dinner")
      var ended = 0
      eventController.composeEnded.connect(function() { ended++ })
      composer.close()
      compare(ended, 1, "closing says so")
      compare(eventController.composerHeld, false)
    }

    function test_old_update_completion_does_not_close_a_new_create_form() {
      eventController.eventWriting = true
      composer.beginAt(new Date(2026, 7, 25, 9, 0).getTime())

      composer.submit()
      compare(eventController.createCalls, 0)
      compare(composer.writePending, false,
        "a busy controller did not accept this form's write")

      eventController.eventWriting = false
      eventController.eventUpdated(true, "")
      compare(composer.opened, true,
        "the old update completion belongs to the cancelled form")
    }

    // Under the unified view every account's calendars are offered at once, and
    // `groupByAccount` orders them by the stored accounts rather than by which
    // mailbox is open. Opening the composer from mailbox B has to preselect B's
    // calendar: the first group is A's, and an event written there without the
    // user noticing the picker lands in the wrong account.
    function test_the_composer_opens_on_the_mailbox_being_read() {
      eventController.writableSourceGroups = [{
        id: "account:one@gmail.com", providerLabel: "Google", accountLabel: "one@gmail.com",
        calendars: [{ id: "google:one@gmail.com", name: "one", colorKey: "accent" }]
      }, {
        id: "account:two@gmail.com", providerLabel: "Google", accountLabel: "two@gmail.com",
        calendars: [{ id: "google:two@gmail.com", name: "two", colorKey: "accent" }]
      }]

      eventController.accountId = "two@gmail.com"
      composer.beginAt(new Date(2026, 0, 5, 10, 0), false)
      compare(composer.selectedSourceId, "google:two@gmail.com")
      composer.close()

      eventController.accountId = "one@gmail.com"
      composer.beginAt(new Date(2026, 0, 5, 10, 0), false)
      compare(composer.selectedSourceId, "google:one@gmail.com")
      composer.close()

      // A mailbox with no calendar of its own still gets a usable default.
      eventController.accountId = "imap:work@example.com"
      composer.beginAt(new Date(2026, 0, 5, 10, 0), false)
      compare(composer.selectedSourceId, "google:one@gmail.com")
      composer.close()
    }
  }
}
