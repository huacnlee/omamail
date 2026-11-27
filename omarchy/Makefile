# The Omarchy plugin entry that stays in this repository after the NSH
# cutover: the notice bar widget (notice/), its root manifest, and the
# standalone installers (install.sh / install.ps1) that release.yml uploads,
# and the release tooling in scripts/ that release.yml and `make publish` run.
# test_release.py needs Python's cryptography package (python3-cryptography).
.PHONY: test lint validate
.DEFAULT_GOAL := test

test:
	sh tests/test_manifest.sh
	sh tests/test_app_helper.sh
	bash tests/test_release_notes.sh
	bash tests/test_release_source.sh
	bash tests/test_publish.sh
	python3 tests/test_install.py
	python3 tests/test_release.py

lint:
	shellcheck notice/omamail-app.sh tests/test_manifest.sh tests/test_app_helper.sh
	shellcheck -e SC1007 install.sh scripts/publish.sh scripts/bump.sh scripts/release-source.sh

# `omarchy plugin validate` where the Omarchy shell is installed.
validate:
	@if command -v omarchy >/dev/null 2>&1; then cd .. && omarchy plugin validate .; \
	else echo "omarchy is not installed here: skipping plugin validate"; fi
