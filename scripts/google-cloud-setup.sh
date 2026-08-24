#!/usr/bin/env bash
# Optional shortcut for the Google Cloud half of the setup.
#
# gcloud can do exactly two of the four steps: create the project and enable
# the Gmail API. The OAuth consent screen for external users and the Desktop
# app client have no CLI and no public API — `gcloud iam oauth-clients` builds
# Workforce Identity Federation apps, which is a different object, and
# `gcloud alpha iap oauth-brands` only produces org-internal brands that a
# personal Gmail account cannot use.
#
# So this script does the automatable half and then opens the console on the
# right pages *with the project already selected*, which is where most of the
# fumbling happens.
set -euo pipefail

project_id=""
open_browser=true

usage() {
  cat <<'USAGE'
Usage: google-cloud-setup.sh [--project ID] [--no-open]

  --project ID   Cloud project to create or reuse. Default: omamail-<random>
  --no-open      Print the console URLs instead of opening them.

Needs the gcloud CLI (AUR: google-cloud-cli) and a signed-in account.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) project_id=${2:-}; shift 2 ;;
    --no-open) open_browser=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

command -v gcloud >/dev/null 2>&1 || {
  printf '%s\n' 'gcloud is not on PATH. Install it (AUR: google-cloud-cli), or follow the four steps in the app instead.' >&2
  exit 1
}

if ! gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | grep -q .; then
  printf '%s\n' 'No active gcloud account. Run: gcloud auth login' >&2
  exit 1
fi

# Project ids are globally unique, so a fixed default would collide for the
# second person who runs this. Read a fixed three bytes rather than piping an
# endless `tr </dev/urandom` into `head`: there `head` closes the pipe first,
# `tr` dies of SIGPIPE, and under `pipefail` the whole script exits 141 without
# printing anything.
if [[ -z $project_id ]]; then
  project_id="omamail-$(od -An -tx1 -N3 /dev/urandom | tr -d ' \n')"
fi

if gcloud projects describe "$project_id" >/dev/null 2>&1; then
  printf 'Reusing existing project %s\n' "$project_id"
else
  printf 'Creating project %s…\n' "$project_id"
  gcloud projects create "$project_id" --name="Omamail"
fi

printf 'Enabling the Gmail and Google Calendar APIs…\n'
gcloud services enable gmail.googleapis.com calendar-json.googleapis.com --project="$project_id"

consent_url="https://console.cloud.google.com/auth/overview?project=$project_id"
clients_url="https://console.cloud.google.com/auth/clients/create?project=$project_id"

cat <<EOF

Done with the part gcloud can do. Two steps are left, and both are console-only:

  1. Configure the consent screen, add your Gmail address as a test user, then
     press "Publish app". Publishing matters: a project left in Testing is
     issued refresh tokens that expire after seven days, so the app would sign
     you out every week. You will see an "unverified app" warning once — that
     is expected for a client you made yourself.

     $consent_url

  2. Create an OAuth client, application type "Desktop app", then paste its
     client ID into Omamail.

     $clients_url

EOF

if $open_browser && command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$consent_url" >/dev/null 2>&1 || true
fi
