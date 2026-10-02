.pragma library
.import "../message/Html.js" as Html
.import "../message/Direction.js" as Direction
.import "Appearance.js" as Appearance

var DEFAULTS = ({
  refreshIntervalSec: 120,
  maxMessages: 50,
  heavyMessageRendering: Html.HEAVY_MESSAGE_RENDERING_DEFAULT,
  contentDirection: Direction.MODE_DEFAULT,
  appearance: Appearance.MODE_DEFAULT,
  defaultQuery: "in:inbox",
  notifyNewMail: "On",
  oauthPort: 9481,
  undoSendSeconds: 10,
  unifiedCalendarView: false,
  calendarRemindersEnabled: true,
  calendarSnoozeMinutes: 5,
  showBarIcon: true,
  unifiedMailboxes: false,
  spellingEnabled: true,
  spellingLanguage: "en_US",
  suggestEvents: false,
  aiAgent: "System default",
  aiModel: ""
})

function normalize(values) {
  var next = ({})
  for (var key in DEFAULTS) next[key] = DEFAULTS[key]
  var source = values || ({})
  for (var name in source) {
    if (source[name] !== undefined && source[name] !== null) next[name] = source[name]
  }
  return next
}
