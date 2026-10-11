import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "Calendar.js" as Calendar
import "Sources.js" as Sources

Item {
  id: root

  required property var service
  required property string pluginDir
  property string cacheName: "calendar"
  property bool reminderMode: false
  function sourceIncluded(source) { return !!source && (reminderMode ? Sources.nativeCalendarFeatures(source) && source.remindersEnabled === true : source.enabled !== false) }
  property string accountId: ""
  property var sourceList: Sources.emptyList()
  property bool sourcesLoaded: false
  property var events: []
  property bool loading: false
  property string lastError: ""
  property string lastErrorKind: ""
  property var undoChange: null
  property double rangeStart: 0
  property double rangeEnd: 0
  property double pendingRangeStart: 0
  property double pendingRangeEnd: 0
  property string refreshAccountId: ""
  // The scope an answer belongs to, which is not always the mailbox.
  //
  // The cache is keyed by it and an in-flight refresh is checked against it, so
  // it has to name what the visible calendar actually depends on. In the
  // default mode that is the account; in the unified mode the same sources are
  // shown whichever mailbox is open, so the account is not part of the
  // question — keying by it stored one copy of the same events per account,
  // spent the eight-range budget three times over, and made every mailbox
  // switch a cache miss: the calendar blanked and every account's calendars
  // were fetched again to redraw what was already on screen.
  property string refreshScope: ""
  property var queue: []
  property var activeSource: null
  property var passwordSaveQueue: []
  property string passwordToSave: ""
  property bool savingPassword: false
  property string sourceWritePayload: ""
  property string sourceSecret: ""
  property var sourceBeingSaved: null
  property bool savingSource: false
  property bool discoveringCalendars: false
  property string discoveringAccountId: ""
  property string discoveryError: ""
  property int discoverySerial: 0
  property bool discoverySaving: false
  property int discoveryPendingCount: 0
  property var discoveryChoices: null
  property string discoveryChoiceAccount: ""
  property bool clockRunning: false
  property double nowMs: Date.now()
  property bool refreshAfterSourceWrite: false
  property bool creatingEvent: false
  property var eventSource: null
  property var eventDraft: null
  // One write at a time, create or otherwise: the password lookup, the writer
  // and the deadline all hold one operation's state, so update and delete
  // share this guard with create rather than growing their own.
  property string writeOp: ""
  property var writeSource: null
  property var writeEvent: null
  property var writeDraft: null
  // The address the current CalDAV write goes to, judged before the keyring
  // is touched and carried to the writer that runs after it.
  property string writeUrl: ""
  property bool eventWriting: false
  readonly property var availableSources: Sources.withMicrosoftAccounts(Sources.withGoogleAccounts(
    sourceList, service ? service.accountSummaries : []), service ? service.accountSummaries : [])
  readonly property bool unifiedCalendarView: !!service
    && service.unifiedCalendarView === true
  readonly property var contextSources: unifiedCalendarView
    ? availableSources : Sources.forAccount(availableSources, accountId)
  // One name for every mailbox, because the unified view is one view.
  //
  // A controller with no account is already showing every source — the bar
  // preview is one, and `Sources.forAccount(list, "")` has always returned all
  // of them — so the setting cannot change what it shows, and renaming its
  // scope would orphan a cache entry and refetch every calendar to redraw what
  // was already there.
  readonly property string calendarScope: unifiedCalendarView && accountId !== ""
    ? "__unified__" : accountId
  readonly property var sourceGroups: Sources.groupByAccount(
    contextSources, service ? service.accountSummaries : [])
  // The composer offers only calendars a write can run against.
  readonly property var writableSourceGroups: Sources.writableGroups(sourceGroups)

  Timer {
    interval: 60000
    repeat: true
    running: root.clockRunning
    triggeredOnStart: true
    onTriggered: root.nowMs = Date.now()
  }

  // The one event worth reloading for, said once: what is on screen depends on
  // the scope, so it is a change of scope that makes the answer stale. A
  // mailbox switch under the unified view is not one, and neither is turning
  // the setting on for a controller that had no mailbox to follow — watching
  // the two inputs separately got both of those wrong in opposite directions.
  onCalendarScopeChanged: reloadVisibleRange()

  // The calendars the scope would ask, as one string. Google and Microsoft
  // calendars arrive with their account's sign-in, after a view that was
  // already open asked for its range; and an account poll rebuilds the
  // summaries twice a cycle with no calendar having come or gone, which a
  // string compares away where the array would not.
  readonly property string enabledSourceKey: contextSources.sources.filter(function(source) {
    return root.sourceIncluded(source)
  }).map(function(source) { return String(source.id || "") }).join("\n")
  onEnabledSourceKeyChanged: reloadVisibleRange()

  // No `eventCache.loaded` guard, and it is not missing. `refresh` refuses on
  // an unloaded cache and `eventCache.onRestored` runs one as soon as it is
  // there, so the only thing the guard changed was whether an empty list was
  // assigned to a property that could not yet hold anything else: nothing can
  // have been fetched before the cache loaded, because fetching needs it too.
  function reloadVisibleRange() {
    if (!rangeStart || !rangeEnd) return
    setEvents(cachedEventsFor(calendarScope, rangeStart, rangeEnd))
    refresh(rangeStart, rangeEnd)
  }

  signal passwordSaved(bool ok, string error)
  signal calendarSaved(bool ok, string error)
  signal discoveryFinished(bool ok, string error, int count)
  signal eventCreated(bool ok, string error)
  // Somebody wants the composer open with these fields — the reader's
  // suggested event, say. The composer listens; the controller only relays.
  signal composeRequested(var prefill)
  // Whether the composer is open on something the owner has typed or is
  // editing, which a request to open it with other fields must not clobber;
  // and the word that it closed, written or not.
  property bool composerHeld: false
  signal composeEnded()
  signal eventUpdated(bool ok, string error)
  signal eventDeleted(bool ok, string error)

  readonly property string configPath: {
    return service && typeof service.configPath === "function"
      ? service.configPath("calendars.json") : ""
  }

  function openExternal(value) {
    return service && typeof service.openExternal === "function"
      ? service.openExternal(value) : false
  }

  function copyText(value) {
    return service && typeof service.copyText === "function"
      ? service.copyText(value) : false
  }

  function refresh(startMs, endMs) {
    var requestedStart = Number(startMs) || 0
    var requestedEnd = Number(endMs) || 0
    if (loading) {
      pendingRangeStart = requestedStart
      pendingRangeEnd = requestedEnd
      return
    }
    pendingRangeStart = 0
    pendingRangeEnd = 0
    rangeStart = requestedStart
    rangeEnd = requestedEnd
    if (!eventCache.loaded) return
    lastError = ""
    lastErrorKind = ""
    refreshAccountId = accountId
    refreshScope = calendarScope
    var effectiveSources = sourcesForAccount(refreshAccountId)
    queue = effectiveSources.sources.filter(function(source) {
      return root.sourceIncluded(source)
    })
    var sourceIds = queue.map(function(source) { return String(source.id || "") })
    loading = true
    setEvents(eventCache.get(refreshScope, rangeStart, rangeEnd, sourceIds))
    processNext()
  }

  function sourcesForAccount(wantedAccountId) {
    var available = Sources.withMicrosoftAccounts(Sources.withGoogleAccounts(
      sourceList, service ? service.accountSummaries : []), service ? service.accountSummaries : [])
    return unifiedCalendarView ? available : Sources.forAccount(available, wantedAccountId)
  }

  function discoverableAccount(accountId) {
    var accounts = service && Array.isArray(service.accountSummaries)
      ? service.accountSummaries : []
    for (var i = 0; i < accounts.length; i++) {
      var account = accounts[i] || {}
      if (String(account.id || "") !== String(accountId || "")) continue
      return account.signedIn === true
        && (account.calendarProvider === "microsoft" || account.calendarProvider === "icloud"
          || (account.calendarProvider === "google" && service.backendCanGoogleCalendars === true))
    }
    return false
  }

  function discoveredCount(accountId) {
    var values = availableSources && Array.isArray(availableSources.sources)
      ? availableSources.sources : []
    var count = 0
    for (var i = 0; i < values.length; i++) {
      var source = values[i] || {}
      if (String(source.accountId || "") === String(accountId || "")
          && source.discovered === true) count++
    }
    return count
  }

  function discoveryFailure(error) {
    // JSON-RPC codes are numeric; the backend's stable reason is its message.
    // Match only known reasons and never display the raw diagnostic.
    var code = String(error && error.message || error || "")
    if (code === "auth_signed_out" || code === "calendar_auth_refused")
      return "Sign in to this mailbox again"
    if (code === "calendar_provider_unsupported")
      return "This mailbox does not support calendar discovery"
    if (code === "calendar_timeout") return "Calendar discovery timed out"
    return "Calendars could not be discovered"
  }

  function discoverAccountCalendars(accountId) {
    var wanted = String(accountId || "")
    if (discoveringCalendars || savingSource || !discoverableAccount(wanted)) return false
    if (!service || !service.backend || !service.backend.ready) {
      discoveryError = "Calendar backend is unavailable"
      discoveryFinished(false, discoveryError, 0)
      return false
    }
    if (service.backendCanDiscoverCalendars !== true) {
      discoveryError = "Update the backend to discover account calendars"
      discoveryFinished(false, discoveryError, 0)
      return false
    }
    var serial = ++discoverySerial
    discoveringCalendars = true
    discoveringAccountId = wanted
    discoveryError = ""
    service.backend.call("calendar.discover", { accountId: wanted }, function(result, error) {
      if (serial !== root.discoverySerial || root.discoveringAccountId !== wanted) return
      root.discoveringCalendars = false
      root.discoveringAccountId = ""
      if (error || !result || String(result.accountId || "") !== wanted
          || !Array.isArray(result.calendars) || !root.discoverableAccount(wanted)) {
        root.discoveryError = root.discoveryFailure(error)
        root.discoveryFinished(false, root.discoveryError, 0)
        return
      }
      var next = Sources.applyDiscovery(root.sourceList, result)
      if (result.provider === "google") {
        root.discoveryChoiceAccount = wanted
        root.discoveryChoices = next
        root.discoveryPendingCount = result.calendars.length
        return
      }
      root.discoveryPendingCount = result.calendars.length
      root.discoverySaving = true
      root.sourceBeingSaved = null
      root.sourceSecret = ""
      root.sourceWritePayload = Sources.serialize(next)
      root.refreshAfterSourceWrite = true
      root.savingSource = true
      root.writeSources()
    })
    return true
  }

  function chooseDiscovered(id, enabled) {
    if (!discoveryChoices) return
    var next = Sources.setEnabled(discoveryChoices, id, enabled)
    var existing = sourceList.sources.some(function(source) { return source.id === id && source.discovered })
    if (!existing) next.sources = next.sources.map(function(source) {
      if (source.id !== id) return source
      var value = Sources.makeSource(source)
      value.remindersEnabled = enabled === true
      return value
    })
    discoveryChoices = next
  }

  function confirmDiscovery() {
    if (!discoveryChoices || savingSource) return
    if (!discoverableAccount(discoveryChoiceAccount)) { discoveryChoices = null; return }
    var chosen = Sources.copyList(sourceList)
    chosen.sources = chosen.sources.filter(function(source) {
      return source.kind !== "google" || source.accountId !== root.discoveryChoiceAccount
    })
    discoveryChoices.sources.forEach(function(source) {
      if (source.kind === "google" && source.accountId === root.discoveryChoiceAccount) chosen = Sources.add(chosen, source)
    })
    sourceWritePayload = Sources.serialize(chosen)
    discoveryChoices = null
    discoverySaving = true
    sourceBeingSaved = null
    sourceSecret = ""
    refreshAfterSourceWrite = true
    savingSource = true
    writeSources()
  }

  // `scope` rather than an account id: in the unified view every mailbox reads
  // the same entry, and asking for it by account would find nothing.
  function cachedEventsFor(scope, startMs, endMs) {
    var values = sourcesForAccount(accountId).sources.filter(function(source) {
      return root.sourceIncluded(source)
    })
    return eventCache.get(scope, startMs, endMs,
      values.map(function(source) { return String(source.id || "") }))
  }

  function findSource(sourceId) {
    return sourceById(contextSources, sourceId)
  }

  function sourceById(list, sourceId) {
    var values = list.sources
    for (var i = 0; i < values.length; i++) {
      if (values[i] && values[i].id === String(sourceId)) return values[i]
    }
    return null
  }

  function createEvent(sourceId, fields) {
    if (creatingEvent || eventWriting) {
      eventCreated(false, "Another event change is still in progress")
      return false
    }
    var source = findSource(sourceId)
    var refusal = Calendar.writeRefusal(source, null)
    if (refusal !== "") { eventCreated(false, refusal); return false }
    var built = Calendar.createEvent(fields, Date.now())
    if (!built.ok) { eventCreated(false, built.error); return false }
    if (source.kind === "google") {
      var refusedOptions = googleOptionsRefusal(fields)
      if (refusedOptions !== "") { eventCreated(false, refusedOptions); return false }
    }
    if (source.kind === "google" && service.backendCanGoogleCalendars === true) {
      var options = Calendar.googleOptions(built.google, fields, source, null)
      if (!options.ok) { eventCreated(false, options.error); return false }
      built.google = options.body
      built.sendUpdates = fields.sendUpdates === "none" ? "none" : "all"
    }
    eventSource = source
    eventDraft = built
    creatingEvent = true
    if (source.kind === "microsoft" && built.recurring) {
      creatingEvent = false
      eventSource = null
      eventDraft = null
      eventCreated(false, "A repeating event on a Microsoft calendar is made in Outlook")
      return false
    }
    if (source.kind === "google") createGoogleEvent()
    else if (source.kind === "microsoft") createGraphEvent()
    else createNativeEvent()
    return true
  }

  function finishEvent(ok, error) {
    creatingEvent = false
    eventSource = null
    eventDraft = null
    eventCreated(ok, String(error || ""))
    if (ok && rangeStart && rangeEnd) refresh(rangeStart, rangeEnd)
  }

  // Guests, Meet and a changed repeat rule reach Google only through the API 6
  // backend, which also carries sendUpdates and If-Match. An older backend
  // would save the event without them and report success, so they are
  // refused rather than dropped.
  function googleOptionsRefusal(fields) {
    if (service.backendCanGoogleCalendars === true) return ""
    if (fields.createMeet === true || fields.changeRecurrence === true
        || String(fields.guestEmails || "").trim() !== "")
      return "Update the backend to add guests, Meet or repetition changes"
    return ""
  }

  // Dragging writes without opening the editor, so it needs the revision
  // check only the API 6 backend sends.
  function rescheduleRefusal(event) {
    var refusal = Calendar.writeRefusal(findSource(event && event.sourceId), event, "reschedule")
    if (refusal === "" && service.backendCanGoogleCalendars !== true)
      refusal = "Update the backend to move events by dragging"
    return refusal
  }

  function updateEvent(sourceId, event, fields) {
    if (creatingEvent || eventWriting) {
      eventUpdated(false, "Another event change is still in progress")
      return false
    }
    var source = findSource(sourceId)
    if (source && source.kind === "google" && service.backendCanGoogleCalendars === true && !event.etag) {
      eventUpdated(false, "Refresh this event before editing it")
      return false
    }
    var refusal = Calendar.writeRefusal(source, event)
    if (refusal !== "") { eventUpdated(false, refusal); return false }
    var built = Calendar.updateEvent(fields, event, Date.now())
    if (!built.ok) { eventUpdated(false, built.error); return false }
    var destination = fields.destinationSourceId && fields.destinationSourceId !== sourceId
      ? findSource(fields.destinationSourceId) : null
    if (fields.destinationSourceId && fields.destinationSourceId !== sourceId) {
      var transferError = Calendar.transferRefusal(source, destination, event)
      if (transferError !== "") { eventUpdated(false, transferError); return false }
      if (service.backendCanGoogleCalendars !== true) {
        eventUpdated(false, "Update the backend to transfer events"); return false
      }
      built.destination = destination
    }
    if (source.kind === "google") {
      var refusedChange = googleOptionsRefusal(fields)
      if (refusedChange !== "") { eventUpdated(false, refusedChange); return false }
    }
    if (source.kind === "google" && service.backendCanGoogleCalendars === true) {
      var options = Calendar.googleOptions(built.google, fields, source, event)
      if (!options.ok) { eventUpdated(false, options.error); return false }
      built.google = options.body
      built.sendUpdates = fields.sendUpdates === "none" ? "none" : "all"
    }
    writeOp = "update"
    writeSource = source
    writeEvent = event
    writeDraft = built
    eventWriting = true
    if (source.kind === "google") startGoogleWrite()
    else if (source.kind === "microsoft") startGraphWrite()
    else startCaldavWrite()
    return true
  }

  // What the delete confirmation asks: named, with a button per consequence.
  function deleteRequest(sourceId, event) {
    var request = Calendar.deleteRequest(event, findSource(String(sourceId || "")),
      service.backendCanGoogleCalendars === true)
    request.sourceId = String(sourceId || "")
    request.event = event
    return request
  }

  // The answer: the series, or this event with or without telling guests.
  function confirmDelete(request) {
    if (!request || !request.event) return false
    if (request.choice === "series") return deleteSeries(request.sourceId, request.event)
    var event = {}
    for (var key in request.event) event[key] = request.event[key]
    event.deleteSendUpdates = request.choice === "none" ? "none" : "all"
    return deleteEvent(request.sourceId, event)
  }

  // A series is deleted by its own identity: an occurrence carries only the
  // parent's id, so the parent is read first and deleted as itself.
  function deleteSeries(sourceId, occurrence) {
    var owner = findSource(sourceId)
    if (!owner || !occurrence || !occurrence.recurringEventId) return false
    if (service.backendCanGoogleCalendars !== true) { lastError = "Update the backend to delete a series"; return false }
    nativeRequest(owner, "get", { eventId: occurrence.recurringEventId }, function(result, error) {
      if (error) { root.lastError = error; return }
      var parent
      try { parent = JSON.parse(result.body) } catch (e) { root.lastError = "Could not read the series"; return }
      var events = Calendar.eventsFromGoogle({ items: [parent] }, owner.id)
      if (events.length !== 1) { root.lastError = "Could not read the series"; return }
      events[0].deleteSendUpdates = occurrence.deleteSendUpdates === "none" ? "none" : "all"
      root.deleteEvent(owner.id, events[0])
    })
    return true
  }

  function deleteEvent(sourceId, event) {
    if (creatingEvent || eventWriting) {
      eventDeleted(false, "Another event change is still in progress")
      return false
    }
    var source = findSource(sourceId)
    var refusal = Calendar.writeRefusal(source, event, "delete")
    if (refusal !== "") { eventDeleted(false, refusal); return false }
    writeOp = "delete"
    writeSource = source
    writeEvent = event
    writeDraft = null
    eventWriting = true
    if (source.kind === "google") startGoogleWrite()
    else if (source.kind === "microsoft") startGraphWrite()
    else startCaldavWrite()
    return true
  }

  function transferEvent(sourceId, destinationId, event, callback) {
    var source = findSource(sourceId), destination = findSource(destinationId)
    var refusal = Calendar.transferRefusal(source, destination, event)
    if (creatingEvent || eventWriting) refusal = "Another event change is still in progress"
    else if (service.backendCanGoogleCalendars !== true) refusal = "Update the backend to transfer events"
    else if (!event || !event.etag) refusal = "Refresh this event before moving it"
    if (refusal) { callback(null, refusal); return false }
    eventWriting = true
    nativeRequest(source, "move", {eventId:event.googleId, destination:destination.calendarId || "primary",
      ifMatch:event.etag, sendUpdates:"none"}, function(result, error) {
      root.eventWriting = false
      if (error) { callback(null, error); return }
      root.undoChange = null
      var resource = null
      try { resource = JSON.parse(result.body) } catch (e) {}
      var moved = resource ? Calendar.eventsFromGoogle({items:[resource]}, destination.id) : []
      callback(moved.length === 1 ? moved[0] : null,
        moved.length === 1 ? "" : "The calendar changed, but its updated details could not be read. Reopen the event before editing further.", true)
      if (root.rangeStart && root.rangeEnd) root.refresh(root.rangeStart, root.rangeEnd)
    })
    return true
  }

  function finishWrite(ok, error) {
    var op = writeOp
    eventWriting = false
    writeOp = ""
    writeSource = null
    writeEvent = null
    writeDraft = null
    writeUrl = ""
    if (op === "delete") eventDeleted(ok, String(error || ""))
    else eventUpdated(ok, String(error || ""))
    // A delete is asked for from the detail, not the composer, so nothing
    // else is listening: the failure has to land on the view's own banner.
    if (!ok) {
      lastError = String(error || "Could not write the event")
      lastErrorKind = ""
    }
    if (ok && rangeStart && rangeEnd) refresh(rangeStart, rangeEnd)
  }

  function startGoogleWrite() { startNativeWrite() }

  function startGraphWrite() { startNativeWrite() }

  function createGraphEvent() { createNativeEvent() }

  function startCaldavWrite() { startNativeWrite() }

  function createGoogleEvent() { createNativeEvent() }

  // The account's primary Microsoft calendar, which is the one calendar a
  // backend from before discovery reaches: it ignores the identity and asks
  // for /me/calendarView, and that is this calendar. Discovery stores its
  // real Graph id under the same source id, so the id is what says which
  // source may go on without one rather than being refused.
  function isDefaultMicrosoftCalendar(source) {
    return !!source && source.kind === "microsoft"
      && String(source.id || "") === "microsoft:" + String(source.accountId || "")
  }

  function nativeRequest(source, operation, fields, callback) {
    if (!service || !service.backend) { callback(null, "Calendar backend is unavailable"); return }
    if (source && source.kind === "google"
        && (source.calendarId || ["get", "lookup", "instances", "move"].indexOf(operation) >= 0
          || fields && (fields.ifMatch || fields.sendUpdates !== undefined))
        && service.backendCanGoogleCalendars !== true) {
      callback(null, "Update the backend to access Google calendars")
      return
    }
    if (source && service.backendCanDiscoverCalendars !== true) {
      if (source.kind === "microsoft" && String(source.calendarId || "") !== ""
          && isDefaultMicrosoftCalendar(source)) {
        var degraded = Sources.makeSource(source)
        degraded.calendarId = ""
        source = degraded
      } else if (source.kind === "icloud"
          || (source.kind === "microsoft" && String(source.calendarId || "") !== "")) {
        callback(null, "Update the backend to access this calendar")
        return
      }
    }
    var params = fields || {}
    params.source = source
    params.operation = operation
    service.backend.call("calendar.request", params, function(result, error) {
      var reason = ""
      if (error) {
        reason = error.message === "calendar_conflict" ? "This event changed elsewhere. Refresh and try again."
          : Calendar.nativeRequestError(String(source && source.kind || ""))
      }
      callback(result, reason)
    })
  }

  function createNativeEvent() {
    var fields = {}
    if (eventSource.kind === "google" && service.backendCanGoogleCalendars === true)
      fields.sendUpdates = eventDraft.sendUpdates
    if (eventSource.kind === "caldav" || eventSource.kind === "icloud") {
      var base = String(eventSource.url || "")
      if (base.charAt(base.length - 1) !== "/") base += "/"
      fields.href = base + encodeURIComponent(eventDraft.uid) + ".ics"
      fields.body = eventDraft.ics
    } else fields.body = JSON.stringify(eventSource.kind === "google" ? eventDraft.google : eventDraft.graph)
    nativeRequest(eventSource, "create", fields, function(result, error) { root.finishEvent(!error, error) })
  }

  function startNativeWrite() {
    var fields = {}
    // Undo belongs to the calendar the change was made in: a write that lands
    // after the view moved to another account offers nothing to undo there.
    var scope = calendarScope
    if (writeSource.kind === "caldav" || writeSource.kind === "icloud") {
      fields.href = String(writeEvent.href || Calendar.caldavEventUrl(writeSource.url, writeEvent))
      if (!fields.href) { finishWrite(false, "The event's address is outside this calendar's server"); return }
      if (writeDraft) fields.body = writeDraft.ics
    } else {
      fields.eventId = String(writeSource.kind === "google" ? writeEvent.googleId : writeEvent.graphId)
      if (writeSource.kind === "google" && writeEvent.etag && service.backendCanGoogleCalendars === true)
        fields.ifMatch = writeEvent.etag
      if (writeSource.kind === "google" && writeDraft && service.backendCanGoogleCalendars === true)
        fields.sendUpdates = writeDraft.sendUpdates
      if (writeSource.kind === "google" && writeOp === "delete" && service.backendCanGoogleCalendars === true)
        fields.sendUpdates = writeEvent.deleteSendUpdates === "none" ? "none" : "all"
      if (writeDraft) fields.body = JSON.stringify(writeSource.kind === "google" ? writeDraft.google : writeDraft.graph)
    }
    nativeRequest(writeSource, writeOp, fields, function(result, error) {
      if (!error) root.undoChange = null
      if (!error && root.writeOp === "update" && root.writeSource.kind === "google"
          && root.service.backendCanGoogleCalendars === true
          && root.writeEvent.start && root.writeEvent.end
          && !root.writeDraft.destination && !(root.writeEvent.attendees || []).some(function(a) { return a.self !== true })
          && !(root.writeDraft.google.attendees || []).some(function(a) { return a.self !== true })) {
        var saved = null
        try { saved = JSON.parse(result.body) } catch (e) {}
        if (saved && saved.etag) {
          var previous = root.writeEvent
          var inverse = Calendar.googleEventPatch({ title: previous.summary, description: previous.description,
            location: previous.location, start: previous.start.ms, end: previous.end.ms }, previous.start.allDay)
          if (root.writeDraft.google.conferenceData) inverse.conferenceData = previous.conferenceData || null
          if (root.writeDraft.google.recurrence !== undefined) inverse.recurrence = previous.recurrenceLines || []
          var preserved = ["reminders", "transparency", "visibility", "attendees"]
          var completeUndo = true
          for (var p = 0; p < preserved.length; p++) {
            var field = preserved[p]
            if (root.writeDraft.google[field] !== undefined && previous[field] !== undefined)
              inverse[field] = previous[field]
            else if (root.writeDraft.google[field] !== undefined) completeUndo = false
          }
          if (!previous.start.allDay && previous.timeZone) {
            inverse.start.timeZone = previous.timeZone
            inverse.end.timeZone = previous.timeZone
          }
          if (completeUndo && scope === root.calendarScope)
            root.undoChange = { source: root.writeSource, eventId: fields.eventId, ifMatch: saved.etag,
              body: JSON.stringify(inverse), sendUpdates: "none", scope: scope }
        }
      }
      if (error || !root.writeDraft || !root.writeDraft.destination) { root.finishWrite(!error, error); return }
      var move = { eventId: fields.eventId, destination: root.writeDraft.destination.calendarId || "primary",
        sendUpdates: root.writeDraft.sendUpdates }
      root.nativeRequest(root.writeSource, "move", move, function(moved, moveError) {
        root.finishWrite(!moveError, moveError ? "Changes were saved, but the calendar transfer failed. Refresh before trying again." : "")
        if (moveError && root.rangeStart && root.rangeEnd) root.refresh(root.rangeStart, root.rangeEnd)
      })
    })
  }

  function undoLastChange() {
    if (!undoChange || creatingEvent || eventWriting) return
    if (undoChange.scope !== calendarScope) { undoChange = null; return }
    if (service.backendCanGoogleCalendars !== true) { lastError = "Update the backend to undo calendar changes"; return }
    var change = undoChange
    undoChange = null
    eventWriting = true
    nativeRequest(change.source, "update", { eventId: change.eventId, ifMatch: change.ifMatch,
      body: change.body, sendUpdates: change.sendUpdates }, function(result, error) {
      root.eventWriting = false
      if (root.rangeStart && root.rangeEnd) root.refresh(root.rangeStart, root.rangeEnd)
      if (error) root.lastError = error
    })
  }

  function saveCalDavPassword(secret) {
    if (discoveringCalendars) return
    var password = String(secret || "")
    if (password === "") { passwordSaved(false, "Enter the calendar password"); return }
    var values = sourceList && Array.isArray(sourceList.sources) ? sourceList.sources : []
    var targets = []
    for (var i = 0; i < values.length; i++) {
      if (values[i] && values[i].kind === "caldav") targets.push(values[i])
    }
    if (targets.length === 0) { passwordSaved(false, "No CalDAV calendars are configured"); return }
    passwordToSave = password
    password = ""
    passwordSaveQueue = targets
    savingPassword = true
    storeNextPassword()
  }

  function addCalDavCalendar(raw, secret) {
    if (savingSource || discoveringCalendars) return
    var candidate = raw || {}
    candidate.kind = "caldav"
    candidate.id = Sources.sourceId(candidate)
    candidate.enabled = true
    var checked = Sources.validate(candidate)
    if (!checked.ok) { calendarSaved(false, checked.error); return }
    if (String(secret || "") === "") {
      calendarSaved(false, "Add the calendar password")
      return
    }
    sourceBeingSaved = checked.source
    sourceSecret = String(secret)
    sourceWritePayload = Sources.serialize(Sources.add(sourceList, checked.source))
    savingSource = true
    writeSources()
  }

  function removeCalendar(sourceId) {
    if (savingSource || discoveringCalendars) return
    sourceBeingSaved = null
    sourceSecret = ""
    sourceWritePayload = Sources.serialize(Sources.remove(sourceList, sourceId))
    refreshAfterSourceWrite = true
    savingSource = true
    writeSources()
  }

  function setSourceEnabled(sourceId, enabled) {
    if (savingSource || discoveringCalendars) return
    var values = availableSources && Array.isArray(availableSources.sources)
      ? availableSources.sources : []
    var source = null
    for (var i = 0; i < values.length; i++) {
      if (values[i] && values[i].id === String(sourceId)) { source = values[i]; break }
    }
    if (!source) return
    var next = Sources.add(sourceList, source)
    next = Sources.setEnabled(next, source.id, enabled)
    sourceBeingSaved = null
    sourceSecret = ""
    sourceWritePayload = Sources.serialize(next)
    refreshAfterSourceWrite = true
    savingSource = true
    writeSources()
  }

  function colorKeyFor(sourceId) {
    var values = availableSources && Array.isArray(availableSources.sources)
      ? availableSources.sources : []
    for (var i = 0; i < values.length; i++) {
      if (values[i] && values[i].id === String(sourceId)) return values[i].colorKey
    }
    return Sources.defaultColorKey(sourceId)
  }

  function setDefaultCalendar(sourceId) {
    if (savingSource || discoveringCalendars) return
    var chosen = sourceById(availableSources, sourceId)
    if (!chosen || chosen.readOnly) return
    var next = Sources.add(sourceList, chosen)
    next.sources = next.sources.map(function(source) {
      var value = Sources.makeSource(source)
      if (value.accountId === chosen.accountId) value.preferred = value.id === chosen.id
      return value
    })
    sourceBeingSaved = null
    sourceSecret = ""
    sourceWritePayload = Sources.serialize(next)
    refreshAfterSourceWrite = false
    savingSource = true
    writeSources()
  }

  function setReminderPolicy(sourceId, enabled, minutes) {
    if (savingSource || discoveringCalendars) return
    var source = sourceById(availableSources, sourceId)
    if (!Sources.nativeCalendarFeatures(source)) return
    var value = Sources.makeSource(source)
    value.remindersEnabled = enabled === true
    value.reminderMinutes = Math.max(-1, Math.min(40320, Math.floor(Number(minutes))))
    if (!isFinite(value.reminderMinutes)) return
    sourceWritePayload = Sources.serialize(Sources.add(sourceList, value))
    sourceBeingSaved = null
    sourceSecret = ""
    refreshAfterSourceWrite = false
    savingSource = true
    writeSources()
  }

  function setSourceColor(sourceId, colorKey) {
    if (savingSource || discoveringCalendars) return
    var values = availableSources && Array.isArray(availableSources.sources)
      ? availableSources.sources : []
    var source = null
    for (var i = 0; i < values.length; i++) {
      if (values[i] && values[i].id === String(sourceId)) { source = values[i]; break }
    }
    if (!source) return
    var next = Sources.add(sourceList, source)
    next = Sources.setColor(next, source.id, colorKey)
    sourceBeingSaved = null
    sourceSecret = ""
    sourceWritePayload = Sources.serialize(next)
    refreshAfterSourceWrite = false
    savingSource = true
    writeSources()
  }

  function updateCalendarPassword(source, secret) {
    if (savingSource || discoveringCalendars) return
    if (!source || source.kind !== "caldav") {
      calendarSaved(false, "Choose a CalDAV calendar")
      return
    }
    if (String(secret || "") === "") {
      calendarSaved(false, "Add the calendar password")
      return
    }
    sourceBeingSaved = source
    sourceSecret = String(secret)
    savingSource = true
    storeSourcePassword(true)
  }

  function storeNextPassword() {
    if (passwordSaveQueue.length === 0) {
      passwordToSave = ""
      savingPassword = false
      passwordSaved(true, "")
      if (rangeStart && rangeEnd) refresh(rangeStart, rangeEnd)
      return
    }
    var pending = passwordSaveQueue.slice()
    var source = pending.shift()
    passwordSaveQueue = pending
    if (!service || typeof service.credentialPut !== "function") {
      passwordToSave = ""
      passwordSaveQueue = []
      savingPassword = false
      passwordSaved(false, "Credential storage is unavailable")
      return
    }
    service.credentialPut("calendar-password", String(source.id || ""), "",
      passwordToSave, function(ok, error) {
        if (!ok) {
          root.passwordToSave = ""
          root.passwordSaveQueue = []
          root.savingPassword = false
          root.passwordSaved(false, String(error || "Could not save the password"))
          return
        }
        root.storeNextPassword()
      })
  }

  function sourceWriteFailed(error) {
    savingSource = false
    sourceSecret = ""
    sourceBeingSaved = null
    refreshAfterSourceWrite = false
    calendarSaved(false, String(error || "Could not save the calendar"))
    if (discoverySaving) {
      discoverySaving = false
      discoveryPendingCount = 0
      discoveryError = "The discovered calendars could not be saved"
      discoveryFinished(false, discoveryError, 0)
    }
  }

  function writeSources() {
    if (!service || typeof service.writeConfig !== "function") {
      sourceWriteFailed("Settings storage is unavailable")
      return
    }
    service.writeConfig("calendars.json", sourceWritePayload, function(ok, error) {
      if (!ok) { root.sourceWriteFailed(error); return }
      root.sourceList = Sources.load(root.sourceWritePayload)
      if (!root.sourceBeingSaved) {
        root.savingSource = false
        root.calendarSaved(true, "")
        if (root.discoverySaving) {
          var count = root.discoveryPendingCount
          root.discoverySaving = false
          root.discoveryPendingCount = 0
          root.discoveryFinished(true, "", count)
        }
        if (root.refreshAfterSourceWrite && root.rangeStart && root.rangeEnd)
          root.refresh(root.rangeStart, root.rangeEnd)
        root.refreshAfterSourceWrite = false
        return
      }
      root.storeSourcePassword(true)
    })
  }

  function storeSourcePassword(refreshAfter) {
    if (!service || typeof service.credentialPut !== "function") {
      sourceWriteFailed("Credential storage is unavailable")
      return
    }
    var sourceId = sourceBeingSaved ? String(sourceBeingSaved.id || "") : ""
    var secret = sourceSecret
    service.credentialPut("calendar-password", sourceId, "", secret, function(ok, error) {
      root.sourceSecret = ""
      root.sourceBeingSaved = null
      root.savingSource = false
      if (!ok) {
        root.calendarSaved(false, String(error || "Could not save the password"))
        return
      }
      root.calendarSaved(true, "")
      if (refreshAfter && root.rangeStart && root.rangeEnd)
        root.refresh(root.rangeStart, root.rangeEnd)
    })
  }

  function replaceActiveSourceEvents(values) {
    if (refreshScope !== calendarScope) return
    var sourceId = activeSource ? String(activeSource.id || "") : ""
    var next = events.filter(function(event) {
      return String(event && event.sourceId || "") !== sourceId
    })
    var additions = Array.isArray(values) ? values : []
    for (var i = 0; i < additions.length; i++) {
      additions[i].sourceName = activeSource
        ? String(activeSource.name || activeSource.id || "Calendar") : "Calendar"
      next.push(additions[i])
    }
    next.sort(Calendar.compareEvents)
    setEvents(next)
  }

  function setEvents(next) {
    if (!Calendar.sameEvents(events, next)) events = next
  }

  function failSource(reason, kind) {
    if (refreshScope !== calendarScope) { processNext(); return }
    var name = Sources.errorLabel(activeSource, service ? service.accountSummaries : [])
    lastError = name + ": " + String(reason || "Could not load events")
    lastErrorKind = String(kind || "")
    processNext()
  }

  function processNext() {
    if (queue.length === 0) {
      activeSource = null
      loading = false
      var enabled = sourcesForAccount(refreshAccountId).sources.filter(function(source) {
        return root.sourceIncluded(source)
      }).map(function(source) { return String(source.id || "") })
      var allowed = {}
      for (var i = 0; i < enabled.length; i++) allowed[enabled[i]] = true
      if (refreshScope === calendarScope) setEvents(events.filter(function(event) {
        return allowed[String(event && event.sourceId || "")] === true
      }))
      if (rangeStart && rangeEnd && refreshScope === calendarScope)
        eventCache.put(refreshScope, rangeStart, rangeEnd, events,
          contextSources.sources.filter(function(source) { return root.sourceIncluded(source) }).map(function(source) { return String(source.id) }))
      var nextStart = pendingRangeStart
      var nextEnd = pendingRangeEnd
      pendingRangeStart = 0
      pendingRangeEnd = 0
      if (nextStart && nextEnd)
        Qt.callLater(function() { root.refresh(nextStart, nextEnd) })
      return
    }
    var pending = queue.slice()
    activeSource = pending.shift()
    queue = pending
    if (activeSource.kind === "google") startGoogle()
    else if (activeSource.kind === "microsoft") startGraph()
    else if (activeSource.kind === "caldav" || activeSource.kind === "icloud") startPasswordLookup()
    else failSource("The HEY CLI does not expose calendar events")
  }

  function startPasswordLookup() { startNativeList() }

  function startNativeList() {
    var fields = { start: new Date(rangeStart).toISOString(), end: new Date(rangeEnd).toISOString() }
    if (activeSource.kind === "caldav" || activeSource.kind === "icloud")
      fields.body = Calendar.caldavReport(rangeStart, rangeEnd)
    nativeRequest(activeSource, "list", fields, function(result, error) {
      if (error) { root.failSource(error); return }
      var body = String(result && result.body || "")
      var values = []
      if (root.activeSource.kind === "caldav" || root.activeSource.kind === "icloud")
        values = Calendar.eventsFromCaldav(body, root.activeSource.id, root.rangeStart, root.rangeEnd)
      else {
        var payload = null
        try { payload = JSON.parse(body) } catch (e) {}
        if (!payload) { root.failSource("The calendar returned an unreadable response"); return }
        values = root.activeSource.kind === "google"
          ? Calendar.eventsFromGoogle(payload, root.activeSource.id)
          : Calendar.eventsFromGraph(payload, root.activeSource.id)
      }
      root.replaceActiveSourceEvents(values)
      root.processNext()
    })
  }

  function startGraph() { startNativeList() }

  function startGoogle() { startNativeList() }

  FileView {
    path: root.configPath
    watchChanges: true
    printErrors: false
    // No refresh here: a file that brings calendars changes
    // `enabledSourceKey`, which reloads the range, and one that brings none
    // leaves nothing to ask for.
    onLoaded: {
      root.sourceList = Sources.load(text())
      root.sourcesLoaded = true
    }
    onFileChanged: reload()
    // Hearing again that the file is absent is not a change. The file's
    // directory is touched whenever the backend reads its registry, which a
    // calendar refresh does, and announcing a fresh empty list started the
    // next refresh.
    onLoadFailed: {
      if (!root.sourceList || !Array.isArray(root.sourceList.sources)
          || root.sourceList.sources.length > 0)
        root.sourceList = Sources.emptyList()
      root.sourcesLoaded = true
    }
  }


  CalendarCache {
    id: eventCache
    backend: root.service ? root.service.backend : null
    cacheName: root.cacheName
    onRestored: {
      if (root.rangeStart && root.rangeEnd && !root.loading)
        root.refresh(root.rangeStart, root.rangeEnd)
    }
  }

}
