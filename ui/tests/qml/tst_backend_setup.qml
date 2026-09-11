import QtQuick
import QtTest
import "../../components" as Omamail

Item {
  width: 720
  height: 500
  QtObject {
    id: runtime
    property string state: "ready"
    property string installedVersion: "0.9.0"
    property string requiredVersion: "0.9.0"
    property string error: ""
    property bool development: false
    property bool busy: false
    property bool canInstall: false
    property bool cliInstalled: false
    property int installs: 0
    property int checks: 0
    function refresh() { checks++ }
    function enableCli() { installs++; cliInstalled=true }
    function disableCli() { cliInstalled=false }
  }
  Omamail.BackendSetup {
    id: page
    width: 680
    runtime: runtime
    textColor: Qt.rgba(1,1,1,1)
    dimColor: Qt.rgba(0.6,0.6,0.6,1)
    accentColor: Qt.rgba(0.5,0.6,1,1)
    panelFontFamily: "monospace"
  }
  TestCase {
    name: "BackendSetup"
    when: windowShown
    function init() {
      runtime.cliInstalled=false
      runtime.installs=0
      runtime.busy=false
      page.visible=true
    }
    function test_check_is_ghost_beside_version() {
      var check=findChild(page,"backend-refresh")
      var version=findChild(page,"backend-version-label")
      compare(check.text,"Check")
      compare(check.bordered,false)
      compare(check.parent,version.parent)
      verify(check.x>=version.x+version.width)
    }
    function test_install_changes_button_and_hint() {
      var button=findChild(page,"backend-install-cli")
      compare(button.text,"Install CLI")
      verify(button.enabled)
      mouseClick(button)
      compare(runtime.installs,1)
      compare(button.text,"Remove CLI")
      verify(button.enabled)
      verify(findChild(page,"backend-cli-note").text.indexOf("is linked")>=0)
      mouseClick(button)
      compare(runtime.installs,1)
      compare(button.text,"Install CLI")
      verify(!runtime.cliInstalled)
    }
    function test_existing_link_and_reopen() {
      runtime.cliInstalled=true
      var button=findChild(page,"backend-install-cli")
      compare(button.text,"Remove CLI")
      verify(button.enabled)
      page.visible=false
      var before=runtime.checks
      page.visible=true
      compare(runtime.checks,before+1)
    }
  }
}
