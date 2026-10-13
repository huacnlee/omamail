import QtQuick
import QtQuick.Controls

// The mouse's back button, carrying the same intent Escape carries.
//
// It reports; the window decides. `canGoBack` is the application's answer to
// whether there is a step to take, and the step itself is the caller's — this
// draws nothing and knows nothing about where the window has been. That is
// the same shape `KeyRouter` has, and for the same reason: an action
// describes intent, not the device that raised it, so the mouse and the
// keyboard must not grow two implementations of going back.
//
// One defect is known and unfixed, and `tst_app_navigation.qml` carries the
// failing test for it. A non-modal `QQC.Popup` with `CloseOnPressOutside` —
// the app menu, a message menu, the account switcher, and five more — is
// dismissed by this press, and Qt's overlay then delivers the same press to
// what lies beneath, so the menu closes and the page under it goes back
// together: one gesture spent twice. Reading the overlay here does not help,
// and that was measured rather than assumed — Qt empties the overlay before
// running this handler, so a guard on `Overlay.overlay.children` sees zero
// open popups at exactly the moment one is closing. Suppressing it needs
// state the popup owns, and that is the application's to give.
//
// Only `Qt.BackButton` is accepted, so every other button reaches whatever is
// under the pointer exactly as before: left clicks on rows and chrome, a
// splitter drag, text selection in the reader, and the wheel handler in
// `WheelScroller` are all untouched by this lying beneath them.
MouseArea {
  id: root

  objectName: "mouse-back"

  // Whatever it is given, in full. The button is pressed wherever the pointer
  // happens to be resting, so there is no smaller area that would be right.
  anchors.fill: parent

  // Required rather than defaulted: a caller that forgets it would otherwise
  // get a button that is silently dead, which is the hardest kind to notice.
  required property bool canGoBack

  signal activated()

  acceptedButtons: Qt.BackButton

  // Qt's overlay closes a non-modal popup on a press outside it and then
  // delivers that same press to what lies beneath, so acting on it here would
  // spend one gesture twice: the menu would close and the page under it would
  // go back together. Reading the overlay inside the handler is too late — by
  // then it is already empty — so the close is caught as it happens instead,
  // and the flag lives exactly one turn of the event loop: long enough for the
  // press that caused it, gone before any press that did not.
  property bool dismissedAPopup: false
  property int popupCount: Overlay.overlay ? Overlay.overlay.children.length : 0

  onPopupCountChanged: {
    if (popupCount !== 0) return
    root.dismissedAPopup = true
    Qt.callLater(function() { root.dismissedAPopup = false })
  }

  onPressed: function(mouse) {
    mouse.accepted = true
    if (root.canGoBack && !root.dismissedAPopup) root.activated()
  }
}
