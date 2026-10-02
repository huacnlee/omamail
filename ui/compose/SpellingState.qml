import QtQuick
import "Spelling.js" as Spelling

// Service-owned spelling state. User preference and runtime availability are
// separate: a missing module/dictionary leaves composing available and gives
// Settings a reason even before the first composer opens.
Item {
  id: root
  visible: false
  required property var service
  readonly property bool enabledRequest: Spelling.decodeSettings(service.settings).enabled
  readonly property string language: Spelling.decodeSettings(service.settings).language
  readonly property bool available: probe.status === Loader.Ready
    && probe.item !== null && probe.item.available
  readonly property string status: probe.status === Loader.Error
    ? "no-module" : (probe.item ? probe.item.status : "loading")
  readonly property alias wordStore: personalWords
  readonly property alias words: personalWords.words
  readonly property alias error: personalWords.error

  PersonalWords { id: personalWords; service: root.service }

  // Sonnet enumerates dictionaries once per process. Installing one requires
  // restarting Omamail; a new adapter alone cannot discover it.
  Loader { id: probe; source: "SpellcheckAdapter.qml" }
  Binding {
    target: probe.item
    property: "language"
    value: root.language
    when: probe.item !== null
  }
}
