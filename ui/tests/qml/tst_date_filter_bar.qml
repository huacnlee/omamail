import QtQuick 2.15
import QtTest 1.3

Item {
  width: 700
  height: 100

  QtObject {
    id: account
    property bool canFilterByDate: true
    property string dateFilter: ""
    property var picked: []
    function setDateFilter(key) {
      picked = picked.concat([key])
      dateFilter = key
    }
  }

  Loader {
    id: barLoader
    width: parent.width
    Component.onCompleted: setSource("../../components/DateFilterBar.qml", ({
      account: account,
      textColor: Qt.rgba(1, 1, 1, 1),
      accentColor: Qt.rgba(0.5, 0.7, 1, 1)
    }))
  }

  TestCase {
    name: "DateFilterBar"
    when: windowShown

    function named(item, objectName) {
      if (!item) return null
      if (item.objectName === objectName) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var found = named(values[i], objectName)
        if (found) return found
      }
      return null
    }

    function init() {
      account.canFilterByDate = true
      account.dateFilter = ""
      account.picked = []
    }

    function test_chips_set_the_account_filter_and_show_the_current_one() {
      tryCompare(barLoader, "status", Loader.Ready)
      var bar = barLoader.item
      verify(bar.visible)
      var all = named(bar, "date-filter-all")
      var week = named(bar, "date-filter-7d")
      verify(all && week, "every filter must be an identifiable chip")
      verify(named(bar, "date-filter-today") && named(bar, "date-filter-yesterday")
        && named(bar, "date-filter-30d"))
      compare(all.selected, true)

      mouseClick(week, week.width / 2, week.height / 2)
      compare(account.picked, ["7d"])
      compare(week.selected, true)
      compare(all.selected, false)

      mouseClick(all, all.width / 2, all.height / 2)
      compare(account.picked, ["7d", ""])
      compare(all.selected, true)
    }

    function test_a_narrow_column_scrolls_the_row_instead_of_cutting_it() {
      tryCompare(barLoader, "status", Loader.Ready)
      var bar = barLoader.item
      verify(!bar.interactive)
      barLoader.width = 120
      verify(bar.interactive, "every chip stays reachable")
      verify(bar.contentWidth > bar.width)
      barLoader.width = Qt.binding(function() { return barLoader.parent.width })
      verify(!bar.interactive)
    }

    function test_hidden_without_a_date_capable_account() {
      tryCompare(barLoader, "status", Loader.Ready)
      var bar = barLoader.item
      account.canFilterByDate = false
      compare(bar.visible, false)
      compare(bar.implicitHeight, 0)
      bar.account = null
      compare(bar.visible, false)
    }
  }
}
