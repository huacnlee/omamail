import QtQuick
import QtTest
import "../.." as Omamail

// The wiring, not the parsing: PluginPath.js is covered by tests/test_plugin_path.js
// without a compositor. What needs the engine is that Service asks it with its own
// URL, so a manifest stripped of __sourceDir (which is what Omarchy hands every
// third-party plugin) still yields the directory the helpers live in.
Item {
  width: 600
  height: 400

  // Derived from this test's own URL, two directories up. It pins the exact
  // directory rather than a plausible shape, which is what the old assertion
  // lacked; it shares Qt's URL handling with the code under test, so it catches
  // a wrong directory rather than a wrong idea of what a file URL is.
  readonly property string checkoutDir: {
    var path = decodeURIComponent(String(Qt.resolvedUrl("../..")).substring(7))
    return path.length > 1 && path.charAt(path.length - 1) === "/"
      ? path.substring(0, path.length - 1) : path
  }

  QtObject {
    id: store
    function updateEntryInline(id, entry) {
    }
  }

  Component {
    id: sanitisedComponent
    Omamail.Service {
      shell: store
      manifest: ({
          id: "omamail"
        })
    }
  }

  Component {
    id: explicitComponent
    Omamail.Service {
      shell: store
      manifest: ({
          id: "omamail",
          __sourceDir: "/tmp/synthetic"
        })
    }
  }

  TestCase {
    name: "PluginDir"
    when: windowShown

    function test_a_stripped_manifest_still_finds_the_checkout() {
      var svc = createTemporaryObject(sanitisedComponent, parent);
      verify(svc !== null);
      compare(svc.pluginDir, checkoutDir);
    }

    function test_a_manifest_that_carries_one_still_wins() {
      var svc = createTemporaryObject(explicitComponent, parent);
      verify(svc !== null);
      compare(svc.pluginDir, "/tmp/synthetic");
    }
  }
}
