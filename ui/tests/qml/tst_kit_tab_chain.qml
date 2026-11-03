import QtQuick
import QtTest
import "../../kit" as Kit

// Tab and Shift+Tab through plain wrapped buttons, where nothing but Qt's own
// focus chain handles the key: each button is one stop, in order, both ways.
// A wrapper that was a second stop around the shell's button would make Tab
// land on every button twice. (The standalone host's own button does not walk
// plain Tab under the test runner even unwrapped; its dialogs are covered by
// the standalone composition tests, which drive Tab the way the dialogs do.)
Item {
  id: scene
  width: 300; height: 100
  Row {
    Kit.Button { id: first; objectName: "first"; text: "First"; focusable: true }
    Kit.Button { id: second; objectName: "second"; text: "Second"; focusable: true }
    Kit.Button { id: third; objectName: "third"; text: "Third"; focusable: true }
  }
  TestCase {
    name: "KitTabChain"
    when: windowShown
    function test_tab_and_backtab_walk_each_button_once() {
      // Where the stop is differs by host (the shell's button is its own; the
      // standalone host's is the control inside it). Where Tab lands does not.
      first.forceActiveFocus()
      verify(first.activeFocus, "focus given to a button is focus on it")
      keyClick(Qt.Key_Tab); verify(second.activeFocus, "Tab: first -> second")
      keyClick(Qt.Key_Tab); verify(third.activeFocus, "Tab: second -> third")
      keyClick(Qt.Key_Backtab, Qt.ShiftModifier); verify(second.activeFocus, "Backtab: third -> second")
      keyClick(Qt.Key_Backtab, Qt.ShiftModifier); verify(first.activeFocus, "Backtab: second -> first")
    }
  }
}
