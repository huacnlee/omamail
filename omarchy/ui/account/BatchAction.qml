import QtQuick

// The selection belongs to the desktop; expansion, edits and rollback are
// one native transaction for the entire selection.
QtObject {
  required property var account
  required property var intents

  function run(ids, action, completion) {
    return account.runNativeAction(Array.isArray(ids) ? ids : [], action,
      typeof completion === "function", false, false, completion)
  }
}
