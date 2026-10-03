import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

// The overlay that records one key. It exists because a window Shortcut beats
// a focused item's Keys handler, so it has to hold the keyboard itself while
// the router stands down — which means the way out of it is load-bearing: a
// capture that goes away without saying so leaves the router suspended with
// nothing on screen and no key left to recover with.
Item {
  width: 400
  height: 300

  Omamail.KeyCapture {
    id: capture
    anchors.fill: parent
    textColor: Qt.rgba(1, 1, 1, 1)
    backgroundColor: Qt.rgba(0, 0, 0, 1)
    panelFontFamily: "monospace"
    label: "Archive"
  }

  SignalSpy { id: captured; target: capture; signalName: "captured" }
  SignalSpy { id: cancelled; target: capture; signalName: "cancelled" }

  TestCase {
    name: "KeyCapture"
    when: windowShown

    function init() {
      capture.active = false
      captured.clear()
      cancelled.clear()
    }

    // Nothing reaches it unless it has the keyboard, so this is the whole
    // contract's precondition.
    function test_it_takes_the_keyboard_while_it_is_up() {
      verify(!capture.visible, "down by default")
      capture.active = true
      tryVerify(function() { return capture.activeFocus }, 1000,
        "the overlay holds the keyboard while a key is being recorded")
    }

    function test_a_press_is_reported_with_its_modifiers() {
      capture.active = true
      tryVerify(function() { return capture.activeFocus })
      keyClick(Qt.Key_Z, Qt.ControlModifier)
      compare(cancelled.count, 0, "a key is not a cancel")
      // Holding Ctrl is a press of its own, so the overlay reports it and
      // `keys/Capture.js` returns "" for it: the window keeps waiting rather
      // than binding the modifier. Deciding that here as well would be a
      // second copy of the rule, so the last press is the one that matters.
      var last = captured.signalArguments[captured.count - 1]
      compare(last[0], Qt.Key_Z)
      compare(last[1] & Qt.ControlModifier, Qt.ControlModifier)
    }

    function test_escape_cancels_rather_than_binding_itself() {
      capture.active = true
      tryVerify(function() { return capture.activeFocus })
      keyClick(Qt.Key_Escape)
      compare(captured.count, 0, "Escape is the way out of every context")
      compare(cancelled.count, 1)
    }

    // The recovery path. Settings closing, the window navigating away, the
    // section being scrolled off — anything that takes the overlay down while
    // a capture is open has to report the cancel, or `suspended` stays true.
    function test_going_away_mid_capture_still_reports_the_cancel() {
      capture.active = true
      tryVerify(function() { return capture.activeFocus })
      capture.active = false
      tryCompare(cancelled, "count", 1)
      compare(captured.count, 0, "a capture taken away is a capture cancelled")
    }

    // The window's handler ends the capture, which hides this, which reports
    // the cancel again. Anything relying on it firing once would break the
    // ordinary Escape path, so the signal is deliberately not deduplicated.
    function test_the_cancel_is_reported_again_when_it_goes_down() {
      capture.active = true
      tryVerify(function() { return capture.activeFocus })
      keyClick(Qt.Key_Escape)
      compare(cancelled.count, 1)
      capture.active = false
      tryCompare(cancelled, "count", 2)
    }
  }
}
