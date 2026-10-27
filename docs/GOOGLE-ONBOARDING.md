# Personal Google onboarding

## What changes

The Linux Omarchy plugin now opens Gmail setup in **automatic mode** by default, both on first launch and when adding a mailbox. Previously, every user had to create a Google Cloud project and Desktop OAuth client, enable APIs, and copy credentials into Omamail. Automatic setup handles those steps after the user enters their Google address and chooses the browser profile containing that account. This is a new product default, not merely a shorter explanation of the existing manual workflow.

The standalone host continues to offer manual client setup. In the plugin, **Use an existing client instead...** switches to that workflow without starting automatic setup. Existing connected accounts keep their credentials. Opening the Gmail form alone checks installed tools; it does not read cookies, install packages, or create a Cloud project. Installing tools and starting setup require separate user actions.

This addresses the repeated first-run Cloud Console work while keeping ownership with the user. It introduces a Python helper, optional installation of Google Cloud CLI and uv, browser/keyring compatibility work, and maintenance of undocumented Google Console HTTP endpoints. There is no shared Omamail OAuth application or borrowed third-party client ID. Acceptance of that maintenance cost and of automatic mode as the default remains the maintainer's product decision.

## User flow and controls

| Stage | What the user sees and does | Controls and navigation |
| --- | --- | --- |
| Provider selection | Choose Gmail. | Back from the form returns here. |
| Tool check | Enter an address; choose a browser or disclose a profile path. | Connect requires a valid address and completed tool check. No automatic installation. |
| Missing tools | Choose **Install setup tools...** and answer package/password prompts in the terminal. | Fields, mode switch, duplicate installation, Back, Escape and window close are blocked while Omamail waits for installer completion (up to 15 minutes). If that wait times out, finish or cancel the existing terminal before retrying. |
| Installation failure | Read the error and retry installation, check tools again, or choose manual setup. | Controls unlock when the installer exits; the tool check runs again. |
| Ready | Choose **Connect Gmail...**. | Address, browser, profile, name and mode become fixed for the active operation. |
| Browser sign-in | An existing persisted login can be reused. Otherwise sign in normally in the opened browser. Cloud CLI authentication may open its own authorization page. | Omamail waits and resumes automatically. Cancel stops local setup. Back/Escape cancel before leaving. The helper does not automate browser input. |
| Project/client setup | Progress identifies the current step. | Repeated Connect and conflicting edits are disabled. Cancel remains available. |
| Setup failure | Read the error and use **Retry connecting Gmail...**, or choose manual setup. | Retained progress is reused. A retry must not silently replace a different client for the account. |
| Client handoff | The saved client is loaded, then Google's permission page opens automatically once. If the backend is not ready within about 20 seconds, the page asks the user to select Sign in when ready. | Duplicate sign-in and client changes are blocked. Back/cancel retires the pending handoff so it cannot open later. Client-file writes must finish before navigation or close. |
| Google permission approval | Approve Gmail and Calendar access in Google's browser page. | Omamail displays waiting status and Cancel. Cancelling retains the personal client for another attempt. |
| Permission failure | Sign in again with the saved client. | Setup need not be repeated; a duplicate permission flow cannot be launched while one is active. |
| Connected | Both setup steps collapse to completed summaries; the mailbox can load. | No duplicate Connect or Sign in action. |

The native plugin window respects the setup navigation guard. Closing it while installation or a client write is active restores it. Quickshell can retain a true visibility request after its native window closes, so recovery resets that request before showing the window again. This covers window-manager close as well as the app's Back/Escape paths.

## Persistence, privacy and recovery

Automatic setup creates a project in the user's account, enables Gmail and Calendar APIs, configures an owner-only PERSONAL brand, and saves a Desktop OAuth client. The normal native Gmail provider then performs OAuth consent and owns ongoing access/refresh tokens. Each Google account needs its own personal client. No billing account is linked by this workflow.

The helper reads Google cookie records directly from the selected existing database through read-only SQLite with normal locking. It filters domains in SQL before returning or decrypting cookie values; no cookie database copy, session-file fallback, or lock bypass is allowed. Selected values necessarily exist in helper memory while authenticated HTTP requests are made to Google. “No copy” means no additional database or cookie files, not a pointer that avoids loading values into memory. SQLite can create or update its WAL shared-memory index and lock metadata without copying cookie values. See [Mailbox setup](MAILBOXES.md) for supported profiles, Firefox limitations, keyring requirements and failure recovery.

Only after **Connect Gmail...** does this session access begin. Google cookies are not written into checkpoints or logs. Owner-only checkpoints and OAuth client files persist so retries can resume. Cancelling stops local work and does not remove a remotely created project, revoke browser sessions, uninstall tools, or roll back completed cloud steps. If creation succeeded remotely but its client secret was not saved, the helper refuses duplicate creation; recover the client through manual setup.

Undocumented endpoints may change. Google account restrictions, Cloud terms, organization policy, quotas, browser storage/encryption and desktop keyrings can prevent automatic setup. Manual setup remains the recovery route. PERSONAL-mode token longevity has not been measured; successful initial consent is not evidence of indefinite refresh-token lifetime.

## Reviewing the interface

The PR must include matched before/after screenshots and a complete recording under [CONTRIBUTING.md](../CONTRIBUTING.md). The maintained fixture at `ui/tests/review/GoogleOnboardingReview.qml` runs production `App.qml` in a native Quickshell window using installed Omarchy controls. Its service, helper responses and Google/package completion events are synthetic. It does not read real cookies, install packages, create projects, or use a mailbox. The caption strip identifies this boundary by default. Set `OMAMAIL_REVIEW_HIDE_CAPTION=1` to inspect the complete footer, then label exported evidence outside the captured window and in its manifest.

The fixture loads the installed Tokyo Night and Catppuccin Latte palettes with default control styling inside its own process. It clears user control overrides there so a dark hover color cannot contaminate the light-theme check. Interactive captures may hide the caption strip to inspect the complete footer; their exported evidence labels and accompanying metadata must still identify the synthetic responses. The `inbox` event advances the simulated mail service after authentication, allowing the complete transition into an empty mailbox to be checked.

Prepare a temporary Quickshell config directory containing `Commons` and `Ui` symlinks to the installed shell modules, `scripts/google-personal-setup.py` copied from `tests/review/google_onboarding_helper.py`, and a `shell.qml` importing the review fixture by absolute file URL. Launch it with `OMAMAIL_REVIEW_DIR` set to that directory. Keep the review window on an otherwise empty workspace before capture to prevent unrelated desktop content appearing through transparency. This uses the existing desktop, with no changes to its settings or installed prerequisites.

`tests/review/google_onboarding_capture.py --config /absolute/path/shell.qml --output /temporary/evidence --theme dark --width 1200 --height 900 --video` scripts real control mouse events and keyboard input while recording only the window region. Repeat with light/dark and 800×900/1200×900 dimensions. It requires the current Hyprland Lua dispatchers, `qs`, `grim`, `wtype`, and `ffmpeg`. Keep the window unobscured while recording. The driver checks the active window, visible workspace, display power and capture geometry before each frame; it skips frames while native close remaps the window. It exercises a real window-manager close during installation, then restores matching capture dimensions. Captures and timestamped `steps.json` stay outside the repository. For baseline screenshots, use the upstream UI sources with the same fixture and `--before`; states unique to automatic setup have no baseline equivalent and must be labeled accordingly.

Scripted native-window evidence establishes the displayed interaction states, not live Google compatibility or the separately required human walkthrough. Report those independently. Do not label a synthetic completion as a fresh live account setup or claim that a scripted recording substitutes for the contributing guide's hands-on check. Full validation, synthetic security regressions, actual user walkthroughs and visual evidence each cover different parts of the change.
