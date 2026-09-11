"""The development install target must use the plugin host, not a package manager."""
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]


class PluginWorkflow(unittest.TestCase):
    def test_install_delegates_to_plugin_installer(self):
        result = subprocess.run(["make", "--no-print-directory", "-n", "install"], cwd=ROOT,
                                capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.strip(), "bash scripts/link-plugin.sh")


if __name__ == "__main__":
    unittest.main()
