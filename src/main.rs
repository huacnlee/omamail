use std::{
    path::PathBuf,
    rc::Rc,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use gpui::{
    App, Bounds, KeyBinding, Menu, MenuItem, TitlebarOptions, Window, WindowBounds, WindowOptions,
    actions, point, px, size,
};
use gpui_shell::{AppAssets, HostModule, HostValue, ShellRuntime, plugin::PluginManifest};
use omamail::{
    APP_ID, ApplicationPaths, COMPANION_HEARTBEAT_INTERVAL_MS, CompanionStatus,
    CompanionStatusState, application_dir,
    command_router::{self, CommandQueue, Launch},
    companion_status_path,
    effects::install_effect_host,
    omarchy_palette_path, omarchy_shell_path, write_companion_status,
};

const TITLE_BAR_HEIGHT: f32 = 44.;
const TRAFFIC_LIGHT_INSET: f32 = (TITLE_BAR_HEIGHT - 14.) / 2.;

/// How long the window waits for a message it is holding open for, before going
/// anyway. The same deadline the effect host puts on a send, so the window
/// outlives the request it is waiting for and not a moment longer.
const OUTBOX_DRAIN_GRACE: Duration = Duration::from_millis(30_000);
/// How often the wait re-reads the outbox. Fine enough that the window does not
/// visibly linger after the message has gone.
const OUTBOX_DRAIN_POLL: Duration = Duration::from_millis(100);

actions!(omamail, [Quit]);

fn main() {
    let app_root = current_application_dir().unwrap_or_else(|error| {
        eprintln!("Omamail cannot find its application resources: {error}");
        std::process::exit(1);
    });
    let launch =
        command_router::parse_arguments(std::env::args_os().skip(1)).unwrap_or_else(|error| {
            eprintln!("{error}");
            // EX_USAGE, the code `scripts/omamail-companion.sh` already answers
            // an unknown verb with, so a caller sees one answer either side of
            // the process boundary.
            std::process::exit(64);
        });
    let launch = match launch {
        Launch::CheckResources => {
            println!("{}", app_root.display());
            return;
        }
        Launch::Run(command) => command,
    };

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let assets = AppAssets::new(app_root.clone());
    let state_home = std::env::var_os("XDG_STATE_HOME")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let companion_path =
        companion_status_path(state_home.as_deref(), home.as_deref(), std::env::consts::OS);
    let Some(commands) = claim_single_instance(state_home.as_deref(), home.as_deref(), launch)
    else {
        // The window that was already up has the command. Starting a second
        // mailbox to say so would be the bug this exists to prevent.
        return;
    };
    gpui_platform::application()
        .with_assets(assets)
        .run(move |cx| {
            gpui_shell::init(cx);
            gpui_shell::set_bundle_id(APP_ID).expect("configure Omamail application identity");
            let data_dir = application_data_dir().expect("locate Omamail application storage");
            gpui_shell::set_storage_path(data_dir.join("store.json"));
            let manifest =
                PluginManifest::read(&app_root).expect("read Omamail application manifest");
            gpui_shell::set_capabilities(manifest.capabilities(&app_root, &data_dir));
            install_omarchy_theme_reader().expect("install Omarchy theme reader");
            install_effect_host(&app_root).expect("install Omamail effect host");
            install_command_host(commands.clone()).expect("install Omamail command router");
            let companion_state =
                install_companion_status(companion_path.clone()).expect("install companion status");
            install_quit(cx, companion_path.clone(), Arc::clone(&companion_state));
            let exit_path = companion_path.clone();
            let exit_state = Arc::clone(&companion_state);
            gpui_shell::on_exit_request(move |_request, _window, cx| {
                request_quit(cx, exit_path.as_deref(), &exit_state)
            });
            let closed_path = companion_path.clone();
            let closed_state = Arc::clone(&companion_state);
            cx.on_window_closed(move |cx, _| {
                if cx.windows().is_empty() {
                    request_quit(cx, closed_path.as_deref(), &closed_state);
                }
            })
            .detach();
            let outbox = install_outbox_gate().expect("install Omamail outbox gate");
            cx.activate(true);

            let runtime = ShellRuntime::new(cx).expect("start gpui-shell runtime");
            let runtime = Rc::clone(&runtime);
            let guard_path = companion_path.clone();
            let guard_state = Arc::clone(&companion_state);
            cx.open_window(window_options(cx), move |window, cx| {
                hold_window_for_outbox(window, cx, outbox, guard_path, guard_state);
                let root = runtime.load(&app_root, window, cx);
                #[cfg(debug_assertions)]
                match runtime.watch(&root, window, cx) {
                    Ok(watcher) => watcher.forget(),
                    Err(error) => eprintln!("failed to watch application sources: {error:#}"),
                }
                root
            })
            .expect("open Omamail window");
        });
}

/// What the script has queued, and what the window has been asked to do about
/// it.
///
/// A queued send lives in this process and nowhere else. The undo window is a
/// courtesy the window can afford while it is open and cannot afford while it
/// is closing: quitting on the last window close, as this did, ended the delay
/// by discarding the message — undelivered, and with nothing said about it.
///
/// So the window refuses to close while one is waiting, and says so by setting
/// `close_requested`. The script's countdown — which is running precisely while
/// something is queued — reads that, spends the rest of the undo window at
/// once, and reports the outbox empty. The wait started at the refusal then
/// quits. One press, and what it costs is the delay rather than the mail.
#[derive(Default)]
struct OutboxGate {
    queued: bool,
    close_requested: bool,
}

/// The two facts the script and the window have to agree on, and nothing else:
/// the payload never crosses, because the window has no way to send one.
fn install_outbox_gate() -> Result<Arc<Mutex<OutboxGate>>, gpui_shell::HostError> {
    let state = Arc::new(Mutex::new(OutboxGate::default()));
    let hold_state = Arc::clone(&state);
    let asked_state = Arc::clone(&state);
    gpui_shell::export_module(
        HostModule::new("omamail-outbox")
            .declarations(
                "export function hold(queued: boolean): boolean;\n\
                 export function close_requested(): boolean;",
            )
            .function("hold", move |arguments| {
                let queued = arguments.boolean(0)?;
                let mut gate = hold_state.lock().expect("outbox gate lock");
                gate.queued = queued;
                Ok(HostValue::from(queued))
            })
            // Consumed rather than read: the script acts on it once, and a flag
            // left standing would drain every send queued after it too.
            .function("close_requested", move |_| {
                let mut gate = asked_state.lock().expect("outbox gate lock");
                let asked = gate.close_requested;
                gate.close_requested = false;
                Ok(HostValue::from(asked))
            }),
    )?;
    Ok(state)
}

/// Keep the window up while the outbox has something in it.
fn hold_window_for_outbox(
    window: &Window,
    cx: &App,
    gate: Arc<Mutex<OutboxGate>>,
    path: Option<PathBuf>,
    status: Arc<Mutex<CompanionStatusState>>,
) {
    window.on_window_should_close(cx, move |_window, cx| {
        let mut held = gate.lock().expect("outbox gate lock");
        if !held.queued {
            return true;
        }
        // A second press must not start a second wait, and must not re-arm a
        // request the script has already taken.
        if held.close_requested {
            return false;
        }
        held.close_requested = true;
        drop(held);
        let waiting = Arc::clone(&gate);
        let path = path.clone();
        let status = Arc::clone(&status);
        cx.spawn(async move |cx| {
            let deadline = Instant::now() + OUTBOX_DRAIN_GRACE;
            while Instant::now() < deadline {
                cx.background_executor().timer(OUTBOX_DRAIN_POLL).await;
                if !waiting.lock().expect("outbox gate lock").queued {
                    break;
                }
            }
            // On the deadline as well as on the drain. A send the server never
            // answers must not leave a window nobody can close.
            cx.update(|cx| request_quit(cx, path.as_deref(), &status));
        })
        .detach();
        false
    });
}

/// Be the one Omamail, or hand what was asked to the one that already is.
///
/// `Some(queue)` means this process is it, and the queue already holds the
/// command the argument vector asked for — so a `mailto:` link that starts the
/// application opens its composer as soon as the window paints, without a
/// second round trip. `None` means a running instance took the command and this
/// process has nothing left to do.
///
/// A host with nowhere to put a socket — no runtime directory, no home, not
/// Linux — is still a working mail client. It becomes the queue's only writer
/// instead, which is the same window with one door fewer.
fn claim_single_instance(
    state_home: Option<&std::path::Path>,
    home: Option<&std::path::Path>,
    command: command_router::Command,
) -> Option<CommandQueue> {
    let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);
    let socket = command_router::command_socket_path(
        runtime_dir.as_deref(),
        state_home,
        home,
        std::env::consts::OS,
    );
    if let Some(socket) = socket.as_deref()
        && command_router::deliver(socket, &command)
    {
        // Said out loud. Handing the command over and exiting in silence is
        // indistinguishable from failing to start — which is exactly how it
        // read from a terminal, because `cx.activate` is a no-op on Linux
        // (gpui says so itself) and so the window that took the command does
        // not come forward either.
        eprintln!(
            "Omamail is already running; the request went to that window. \
             Close it first to start another."
        );
        return None;
    }
    let queue = CommandQueue::new();
    queue.push(command);
    if let Some(socket) = socket.as_deref()
        && let Err(error) = command_router::listen(socket, queue.clone())
    {
        eprintln!("Omamail cannot answer desktop links in this session: {error}");
    }
    Some(queue)
}

/// The window's end of the router.
///
/// `next` is asynchronous and parks until something arrives, so the window
/// waits on a command rather than asking every second whether one has turned
/// up. `activate` is not: raising the window has to happen inside the calling
/// script's scope, which is the only place a host function is handed the
/// `App` it needs.
fn install_command_host(queue: CommandQueue) -> Result<(), gpui_shell::HostError> {
    let waiting = queue.clone();
    gpui_shell::export_module(
        HostModule::new("omamail-command")
            .declarations(
                "export function next(): Promise<string>;\n\
                 export function activate(): boolean;",
            )
            .async_function("next", move |_arguments| {
                let waiting = waiting.clone();
                Ok(async move { Ok(HostValue::from(waiting.next().await.to_json())) })
            })
            // A link that reached the running instance has to bring it forward
            // too, or the draft is filled in behind whatever the person was
            // looking at. Wayland may decline without an activation token, so
            // this reports whether the platform took it rather than claiming it
            // worked.
            .function("activate", |_| {
                Ok(HostValue::from(
                    gpui_shell::with_current_app(|cx| cx.activate(true)).is_some(),
                ))
            }),
    )
}

fn install_companion_status(
    path: Option<PathBuf>,
) -> Result<Arc<Mutex<CompanionStatusState>>, gpui_shell::HostError> {
    let state = Arc::new(Mutex::new(CompanionStatusState::running()));
    publish_companion_status(path.as_deref(), &state);
    let heartbeat_path = path.clone();
    let heartbeat_state = Arc::clone(&state);
    std::thread::Builder::new()
        .name("omamail-companion-heartbeat".into())
        .spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(COMPANION_HEARTBEAT_INTERVAL_MS));
                if !publish_companion_status(heartbeat_path.as_deref(), &heartbeat_state) {
                    return;
                }
            }
        })
        .map_err(|error| gpui_shell::HostError::from(error.to_string()))?;
    let module_path = path.clone();
    let module_state = Arc::clone(&state);
    gpui_shell::export_module(
        HostModule::new("omarchy-companion")
            .declarations("export function set_unread(count: number): boolean;")
            .function("set_unread", move |arguments| {
                let count = arguments.integer(0)?.max(0) as u64;
                let mut state = module_state.lock().expect("companion state lock");
                state.set_unread(count);
                Ok(HostValue::from(publish_locked_companion_status(
                    module_path.as_deref(),
                    &state,
                )))
            }),
    )?;
    Ok(state)
}

fn publish_companion_status(
    path: Option<&std::path::Path>,
    state: &Arc<Mutex<CompanionStatusState>>,
) -> bool {
    let state = state.lock().expect("companion state lock");
    publish_locked_companion_status(path, &state)
}

fn stop_companion_status(path: Option<&std::path::Path>, state: &Arc<Mutex<CompanionStatusState>>) {
    let mut state = state.lock().expect("companion state lock");
    state.stop();
    write_status_snapshot(path, state.snapshot(now_millis()));
}

fn publish_locked_companion_status(
    path: Option<&std::path::Path>,
    state: &CompanionStatusState,
) -> bool {
    if !state.should_publish() {
        return false;
    }
    write_status_snapshot(path, state.snapshot(now_millis()));
    true
}

fn write_status_snapshot(path: Option<&std::path::Path>, status: CompanionStatus) {
    let Some(path) = path else { return };
    if let Err(error) = write_companion_status(path, status) {
        eprintln!("could not publish Omarchy companion status: {error}");
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn install_omarchy_theme_reader() -> Result<(), gpui_shell::HostError> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let colors = omarchy_palette_path(home.as_deref(), std::env::consts::OS);
    let shell = omarchy_shell_path(home.as_deref(), std::env::consts::OS);
    if colors.is_none() {
        return Ok(());
    }
    gpui_shell::export_module(
        HostModule::new("omarchy-theme")
            .declarations(
                "export function current_colors(): string;\n\
                 export function current_shell(): string;\n\
                 export function current_corner_radius(): number;\n\
                 export function current_font_family(): string;",
            )
            .function("current_colors", move |_| {
                let source = colors
                    .as_ref()
                    .and_then(|path| std::fs::read_to_string(path).ok())
                    .unwrap_or_default();
                Ok(HostValue::from(source))
            })
            .function("current_shell", move |_| {
                let source = shell
                    .as_ref()
                    .and_then(|path| std::fs::read_to_string(path).ok())
                    .unwrap_or_default();
                Ok(HostValue::from(source))
            })
            .function("current_corner_radius", |_| {
                Ok(HostValue::from(hyprland_corner_radius().unwrap_or(0) as i64))
            })
            .function("current_font_family", |_| {
                Ok(HostValue::from(resolved_monospace_family()))
            }),
    )
}

/// Omarchy windows round their corners to Hyprland's `decoration:rounding`, so
/// the shell reads it rather than choosing one. A machine with no Hyprland
/// answers nothing, and square corners are the safer miss: a window that is
/// rounder than its neighbours is more obviously wrong than one that is
/// squarer.
fn hyprland_corner_radius() -> Option<u32> {
    let output = std::process::Command::new("hyprctl")
        .args(["-j", "getoption", "decoration:rounding"])
        .output()
        .ok()?;
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    value.get("int")?.as_u64().map(|radius| radius as u32)
}

/// `monospace` is the fontconfig alias `omarchy font set` rewrites. Qt resolves
/// the alias itself; gpui does not, so the family is resolved here once and
/// handed over concretely.
fn resolved_monospace_family() -> String {
    std::process::Command::new("fc-match")
        .args(["-f", "%{family[0]}", "monospace"])
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|family| !family.is_empty())
        .unwrap_or_else(|| "monospace".to_owned())
}

fn current_application_dir() -> Result<PathBuf, String> {
    application_dir(&ApplicationPaths {
        explicit: std::env::var_os("OMAMAIL_APP_DIR").map(PathBuf::from),
        executable: std::env::current_exe()
            .map_err(|error| format!("could not locate the executable: {error}"))?,
        manifest_dir: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
    })
}

fn application_data_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join("Library/Application Support"));

    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| home.join(".local/share"))
        });

    base.map(|root| root.join("omamail"))
        .ok_or_else(|| "no platform application-data directory is available".to_owned())
}

fn window_options(cx: &gpui::App) -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(1120.), px(760.)),
            cx,
        ))),
        window_min_size: Some(size(px(720.), px(600.))),
        // Without this the Wayland surface carries an empty app_id: Hyprland
        // window rules cannot address the window, and no desktop entry can
        // claim it. It is the same identity the manifest and the .desktop file
        // already use.
        app_id: Some(APP_ID.to_owned()),
        titlebar: Some(TitlebarOptions {
            title: Some("Omamail".into()),
            appears_transparent: true,
            traffic_light_position: Some(point(px(TRAFFIC_LIGHT_INSET), px(TRAFFIC_LIGHT_INSET))),
        }),
        ..Default::default()
    }
}

fn request_quit(
    cx: &mut App,
    path: Option<&std::path::Path>,
    state: &Arc<Mutex<CompanionStatusState>>,
) {
    stop_companion_status(path, state);
    cx.quit();
}

fn install_quit(cx: &mut App, path: Option<PathBuf>, state: Arc<Mutex<CompanionStatusState>>) {
    cx.on_action(move |_: &Quit, cx| request_quit(cx, path.as_deref(), &state));
    if cfg!(target_os = "macos") {
        cx.bind_keys([KeyBinding::new("cmd-q", Quit, None)]);
        cx.set_menus(vec![Menu {
            name: "Omamail".into(),
            items: vec![MenuItem::action("Quit Omamail", Quit)],
            disabled: false,
        }]);
    } else {
        cx.bind_keys([KeyBinding::new("alt-f4", Quit, None)]);
    }
}
