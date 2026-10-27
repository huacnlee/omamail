"""Synthetic process responses for the native Google onboarding review fixture.

Never imports the production helper or accesses Google/browser/package state.
"""
import json
from pathlib import Path
import sys
import time

control = Path(__file__).parents[1] / 'control.json'


def read():
    try:
        return json.loads(control.read_text())
    except (OSError, ValueError):
        return {}


def emit(event, **data):
    print(json.dumps(dict(event=event, **data)), flush=True)


if '--check' in sys.argv:
    emit('preflight', missingTools=read().get('missingTools', []), browser='edge')
    sys.exit()

install = '--install-tools-ui' in sys.argv
seen = ''
for _ in range(6000):
    action = read().get('action', '')
    if action != seen:
        seen = action
        if install and action == 'install-done':
            sys.exit()
        if install and action == 'install-fail':
            emit('error', message='Synthetic installer failure. Retry the installer.')
            sys.exit(1)
        if not install:
            if action == 'browser':
                emit('progress', message='Sign in to Google in the window that opened. Setup will continue automatically when sign-in is detected.')
            if action == 'provision':
                emit('progress', message='Creating your personal Google project…')
            if action == 'setup-fail':
                emit('error', message='Synthetic network failure. Your progress is saved; retry to resume setup.')
                sys.exit(1)
            if action == 'setup-done':
                emit('done')
                sys.exit()
    time.sleep(.1)
sys.exit(1)
