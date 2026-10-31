#!/usr/bin/env python3
"""Capture the native review window. Run only on a desktop dedicated to this review.

The caller launches GoogleOnboardingReview.qml with synthetic helper responses.
No browser, package manager, real account, or mail service is used.
"""
import argparse
import json
from pathlib import Path
import subprocess
import time
import threading

parser = argparse.ArgumentParser()
parser.add_argument('--config', required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--theme', choices=['dark', 'light'], default='dark')
parser.add_argument('--width', type=int, default=1200)
parser.add_argument('--height', type=int, default=900)
parser.add_argument('--before', action='store_true')
parser.add_argument('--video', action='store_true')
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
log = []
started = time.monotonic()

def run(*cmd):
    return subprocess.check_output(cmd, text=True).strip()

def ipc(action, *values):
    return run('qs', 'ipc', '-p', args.config, 'call', 'omamailReview', action, *map(str, values))

def review_window():
    windows = [w for w in json.loads(run('hyprctl', 'clients', '-j'))
               if w['title'] == 'OmaMail review — synthetic account']
    if len(windows) != 1:
        raise RuntimeError('Exactly one visible review window is required')
    return windows[0]

def guarded_frame():
    window = review_window()
    active = json.loads(run('hyprctl', 'activewindow', '-j'))
    monitors = json.loads(run('hyprctl', 'monitors', '-j'))
    monitor = next(m for m in monitors if m['id'] == window['monitor'])
    if (active.get('address') != window['address'] or not monitor['dpmsStatus']
            or monitor['activeWorkspace']['id'] != window['workspace']['id']
            or window['at'] != [100, 80] or window['size'] != [args.width, args.height]):
        raise RuntimeError('Review window is obscured, hidden, or moved; refusing capture')
    return subprocess.check_output(['grim', '-g', f'100,80 {args.width}x{args.height}', '-'], timeout=5)

def place_window():
    address = 'address:' + review_window()['address']
    for statement in [f'hl.dsp.window.float({{action="on",window="{address}"}})',
                      f'hl.dsp.window.resize({{x={args.width},y={args.height},relative=false,window="{address}"}})',
                      f'hl.dsp.window.move({{x=100,y=80,relative=false,window="{address}"}})',
                      f'hl.dsp.focus({{window="{address}"}})']:
        run('hyprctl', 'dispatch', statement)
    time.sleep(.5)

def caption(value):
    ipc('caption', value)
    log.append({'seconds': round(time.monotonic()-started, 1), 'step': value})

def click(name):
    if name == 'google-setup-install':
        ipc('event', 'tools-start')
    elif name == 'google-setup-start':
        ipc('event', 'setup-start')
    info = json.loads(ipc('locate', name))
    if not info or not info['visible'] or not info['enabled']:
        raise RuntimeError('Control is unavailable: '+name+' '+str(info))
    ipc('click', name)
    time.sleep(1.2)
    if name == 'provider-gmail' and json.loads(ipc('state'))['page'] == 'picker':
        ipc('click', name)
        time.sleep(.5)
    print(name, ipc('state'), flush=True)

def capture(name, text):
    caption(text)
    time.sleep(1.4)
    (args.output/(name+'.png')).write_bytes(guarded_frame())
    log[-1]['state'] = json.loads(ipc('state'))
    if args.video:
        time.sleep(1.5)

def event(name):
    ipc('event', name)
    time.sleep(.8)

ipc('reset', args.theme, args.width, args.height)
time.sleep(1)
place_window()
recorder = None
recording = threading.Event()
record_thread = None
try:
    if args.video:
        recorder = subprocess.Popen(['ffmpeg','-y','-f','image2pipe','-framerate','5','-use_wallclock_as_timestamps','1','-i','pipe:0',
            '-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-preset','fast','-crf','22',
            '-pix_fmt','yuv420p','-fps_mode','vfr','-movflags','+faststart',str(args.output/'walkthrough.mp4')],
            stdin=subprocess.PIPE, stdout=(args.output/'recorder.log').open('w'), stderr=subprocess.STDOUT)
        recording.set()
        def frames():
            while recording.is_set():
                tick = time.monotonic()
                try:
                    frame = guarded_frame()
                except RuntimeError:
                    # Native close can remap the surface. Skip all obscured frames.
                    time.sleep(.2)
                    continue
                recorder.stdin.write(frame)
                time.sleep(max(0, .2-(time.monotonic()-tick)))
        record_thread = threading.Thread(target=frames)
        record_thread.start()
    started = time.monotonic()
    capture('01-entry', 'Entry: choose Gmail with the mouse.')
    click('provider-gmail')
    if args.before:
        capture('02-setup', 'BEFORE: Gmail requires a manually created Cloud client.')
        ipc('event', 'manual-error')
        capture('03-error', 'BEFORE: error and host Back control on the manual setup page.')
        ipc('click', 'page-back')
        capture('04-back', 'BEFORE: Back returns to provider selection.')
        click('provider-gmail')
        event('baseline-consent')
        capture('05-consent', 'BEFORE: permission approval with a manually configured client.')
        event('consent-failed')
        capture('06-consent-error', 'BEFORE: permission failure and manual retry.')
        event('connected')
        capture('07-connected', 'BEFORE: connected mailbox setup summary.')
    else:
        click('google-setup-email')
        ipc('text', 'google-setup-email', '')
        time.sleep(.6)
        run('wtype', 'owner@example.com')
        print('typed', ipc('state'), ipc('locate','google-setup-email'), flush=True)
        run('wtype', '-k', 'Tab')
        print('tabbed', ipc('state'), flush=True)
        capture('02-setup', 'Type the account; Tab moves focus. Missing tools are offered explicitly.')
        click('google-setup-install')
        ipc('click', 'page-back')
        run('wtype', '-k', 'Escape')
        ipc('close')
        address = 'address:' + review_window()['address']
        run('hyprctl', 'dispatch', f'hl.dsp.window.close({{window="{address}"}})')
        time.sleep(1)
        assert json.loads(ipc('state'))['visible'], 'Native close must restore a busy window'
        place_window()
        capture('03-installing', 'Installing: fields, duplicate actions and Back are locked. Escape/close stay here.')
        event('tools-failed')
        capture('04-install-error', 'Installation failure: the error remains visible; retry is enabled.')
        click('google-setup-install')
        event('tools-done')
        capture('05-tools-ready', 'Installation succeeds: tools are rechecked; Connect becomes available.')
        click('google-setup-start')
        event('browser')
        capture('06-browser', 'Browser sign-in boundary (simulated): waiting automatically; Cancel remains available.')
        event('provision')
        capture('07-provision', 'Provisioning: address, browser and mode are locked to this operation.')
        event('setup-failed')
        capture('08-setup-error', 'Setup failure: progress can be resumed with Retry connecting Gmail.')
        click('google-setup-start')
        event('provision')
        click('google-setup-cancel')
        capture('09-cancelled', 'Cancel stops the helper and unlocks the form; it does not delete a Cloud project.')
        click('google-setup-start')
        event('browser')
        ipc('click', 'page-back')
        capture('10-back-cancel', 'Back during setup cancels local work and returns to the provider picker.')
        click('provider-gmail')
        click('google-setup-email')
        run('wtype', 'owner@example.com')
        click('google-setup-start')
        event('provision')
        event('saved')
        capture('11-consent', 'Client saved: one Google permission flow opens automatically (simulated response).')
        assert json.loads(ipc('state'))['signIns'] == 1
        event('consent-failed')
        capture('12-consent-error', 'Permission failure: the saved client is retained; Sign in is available again.')
        click('google-sign-in')
        click('google-sign-in-cancel')
        capture('13-consent-cancel', 'Cancel permission approval: keep the client and allow sign-in later.')
        click('google-sign-in')
        event('connected')
        capture('14-connected', 'Connected: both steps complete; no duplicate Connect or Sign in action.')
        event('inbox')
        capture('14b-inbox', 'Result: synthetic mailbox opens after authentication completes.')
        ipc('reset', args.theme, args.width, args.height)
        time.sleep(.5)
        click('provider-gmail')
        click('google-setup-mode')
        capture('15-manual', 'Manual client setup remains available as an explicit alternative.')
        run('wtype', '-k', 'Escape')
        capture('16-keyboard-back', 'Escape returns to provider selection when no operation blocks navigation.')
finally:
    if recorder:
        recording.clear()
        record_thread.join(timeout=10)
        recorder.stdin.close()
        recorder.wait(timeout=15)
    (args.output/'steps.json').write_text(json.dumps(log, indent=2)+'\n')
