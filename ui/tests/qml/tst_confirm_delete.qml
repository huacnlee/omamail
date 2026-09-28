import QtQuick
import QtTest
import "../../components" as Omamail

Item {
  width: 500
  height: 350
  Omamail.ConfirmDeleteDialog {
    id: dialog
    textColor: Qt.rgba(1,1,1,1)
    dimColor: textColor
    dangerColor: textColor
    popupBackgroundColor: Qt.rgba(0,0,0,1)
    popupBorderColor: textColor
    panelFontFamily: "monospace"
  }
  SignalSpy { id: confirmed; target: dialog; signalName: "confirmed" }
  TestCase {
    name: "ConfirmDeleteKeyboard"
    when: windowShown
    function init() {
      confirmed.clear()
      dialog.openFor({kind:"event",name:"Synthetic meeting",event:{googleId:"one"}})
      tryCompare(dialog,"opened",true)
    }
    function cleanup() { dialog.close() }
    function test_enter_confirms_initial_choice() {
      keyClick(Qt.Key_Return)
      compare(confirmed.count,1)
      compare(confirmed.signalArguments[0][0].event.googleId,"one")
    }
    function test_tab_then_enter_cancels() {
      keyClick(Qt.Key_Tab)
      keyClick(Qt.Key_Return)
      tryCompare(dialog,"opened",false)
      compare(confirmed.count,0)
    }
    function test_tab_cycles_and_keypad_enter_confirms() {
      keyClick(Qt.Key_Tab)
      keyClick(Qt.Key_Tab)
      keyClick(Qt.Key_Enter)
      compare(confirmed.count,1)
    }
    function test_backtab_then_enter_cancels() {
      keyClick(Qt.Key_Backtab,Qt.ShiftModifier)
      keyClick(Qt.Key_Enter)
      tryCompare(dialog,"opened",false)
      compare(confirmed.count,0)
    }
    function test_escape_cancels() {
      keyClick(Qt.Key_Escape)
      tryCompare(dialog,"opened",false)
      compare(confirmed.count,0)
    }
  }
}
