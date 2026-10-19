import QtQuick
import QtTest
import "../../components" as Components
import "../../providers/Registry.js" as Provider

Item {
  Component {
    id: tabsFactory
    Components.MailboxTabs {
      textColor: palette.text
      accentColor: palette.highlight
      panelFontFamily: "sans-serif"
      allMailboxes: Provider.mailboxes("imap")
    }
  }
  SystemPalette { id: palette }
  TestCase {
    name: "MailboxTabsDestinations"
    function test_narrow_windows_keep_all_mail_junk_and_trash_reachable() {
      var tabs = createTemporaryObject(tabsFactory, parent, { width: 160 })
      verify(tabs !== null)
      compare(tabs.mailboxes.length, tabs.allMailboxes.length)
      var keys = tabs.mailboxes.map(function(box) { return box.key })
      verify(keys.indexOf("all") >= 0)
      verify(keys.indexOf("spam") >= 0)
      verify(keys.indexOf("trash") >= 0)
      tryVerify(function() { return tabs.contentWidth > tabs.width })
      verify(tabs.interactive)
      tabs.current = "trash"
      tryVerify(function() { return tabs.contentX > 0 })
      tabs.current = "inbox"
      tryCompare(tabs, "contentX", 0)
    }
  }
}
