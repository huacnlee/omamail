use std::{
    path::PathBuf,
    rc::Rc,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use gpui::{
    App, Bounds, KeyBinding, Menu, MenuItem, TitlebarOptions, WindowBounds, WindowOptions, actions,
    point, px, size,
};
use gpui_shell::{AppAssets, HostModule, HostValue, ShellRuntime, plugin::PluginManifest};
use omamail::{
    APP_ID, ApplicationPaths, COMPANION_HEARTBEAT_INTERVAL_MS, CompanionStatus,
    CompanionStatusState, application_dir, companion_status_path, effects::install_effect_host,
    omarchy_palette_path, write_companion_status,
};

const TITLE_BAR_HEIGHT: f32 = 44.;
const TRAFFIC_LIGHT_INSET: f32 = (TITLE_BAR_HEIGHT - 14.) / 2.;

actions!(omamail, [Quit]);

fn main() {
    let app_root = current_application_dir().unwrap_or_else(|error| {
        eprintln!("Omamail cannot find its application resources: {error}");
        std::process::exit(1);
    });
    if std::env::args_os().any(|argument| argument == "--check-resources") {
        println!("{}", app_root.display());
        return;
    }

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
            cx.activate(true);

            let runtime = ShellRuntime::new(cx).expect("start gpui-shell runtime");
            let runtime = Rc::clone(&runtime);
            cx.open_window(window_options(cx), move |window, cx| {
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
    if colors.is_none() {
        return Ok(());
    }
    gpui_shell::export_module(
        HostModule::new("omarchy-theme")
            .declarations("export function current_colors(): string;")
            .function("current_colors", move |_| {
                let source = colors
                    .as_ref()
                    .and_then(|path| std::fs::read_to_string(path).ok())
                    .unwrap_or_default();
                Ok(HostValue::from(source))
            }),
    )
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
        titlebar: Some(TitlebarOptions {
            title: None,
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
