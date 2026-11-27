# The Omarchy plugin entry that stays in this repository after the NSH
# cutover: the notice bar widget (notice/), its root manifest, and the
# standalone installers (install.sh / install.ps1, pending NSH packaging),
# and the release tooling in scripts/ that release.yml and `make publish` run.
.PHONY: test lint validate
.DEFAULT_GOAL := test

test:
	sh tests/test_manifest.sh
	sh tests/test_app_helper.sh
	bash tests/test_release_notes.sh
	bash tests/test_release_source.sh
	bash tests/test_publish.sh
	python3 tests/test_publish_backend.py

lint:
	shellcheck notice/omamail-app.sh tests/test_manifest.sh tests/test_app_helper.sh

# `omarchy plugin validate` where the Omarchy shell is installed.
validate:
	@if command -v omarchy >/dev/null 2>&1; then cd .. && omarchy plugin validate .; \
	else echo "omarchy is not installed here: skipping plugin validate"; fi
