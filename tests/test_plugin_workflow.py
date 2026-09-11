"""The development install target must use the plugin host, not a package manager."""
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]


class PluginWorkflow(unittest.TestCase):
    def test_install_delegates_to_plugin_installer(self):
        result = subprocess.run(["make", "--no-print-directory", "-n", "install"], cwd=ROOT,
                                capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.strip().splitlines(), [
            f'cargo build --locked --release --target-dir "{ROOT}/target" --bin omamail',
            'python3 scripts/backend-runtime.py install-local',
            'bash scripts/link-plugin.sh',
        ])

    def test_install_plugin_does_not_build_or_install_backend(self):
        result = subprocess.run(["make", "--no-print-directory", "-n", "install-plugin"], cwd=ROOT,
                                capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.strip().splitlines(), [
            'python3 scripts/backend-runtime.py uninstall',
            'bash scripts/link-plugin.sh',
        ])


if __name__ == "__main__":
    unittest.main()
