use std::{ops::Deref as _, path::PathBuf};

use gpui::{IntoElement as _, TestAppContext, VisualTestContext};
use gpui_shell::ShellRuntime;

fn app_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("app")
}

#[gpui::test]
fn setup_application_loads_through_the_public_shell_runtime(cx: &mut TestAppContext) {
    cx.update(gpui_shell::init);
    let root = app_dir();
    let manifest = gpui_shell::plugin::PluginManifest::read(&root).expect("application manifest");
    gpui_shell::set_capabilities(manifest.capabilities(&root, &std::env::temp_dir()));
    let storage = tempfile::tempdir().expect("storage fixture");
    let store_path = storage.path().join("store.json");
    // Shell storage is a JSON map of localStorage strings, exactly as a real
    // previous launch writes it.  This exercises restoration through the
    // public runtime rather than constructing the view with test props.
    std::fs::write(
        &store_path,
        serde_json::json!({
            "omamail.accounts": r#"{"version":1,"activeId":"saved@example.com","accounts":[{"id":"saved@example.com","email":"saved@example.com","provider":"hey","label":"Saved HEY"}]}"#
        }).to_string(),
    ).expect("saved workspace fixture");
    gpui_shell::set_storage_path(store_path);
    let runtime = cx.update(ShellRuntime::new).expect("runtime");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let shell_root = context
        .update(|window, cx| runtime.try_load(&root, window, cx))
        .expect("load application through the public host facade");
    let view = context.update(|_, cx| {
        shell_root
            .read(cx)
            .content()
            .clone()
            .downcast::<gpui_shell::ScriptView>()
            .expect("loaded content is a script view")
    });

    context.run_until_parked();
    let draw_view = view.clone();
    context.draw(
        gpui::Point::default(),
        gpui::size(gpui::px(1120.), gpui::px(760.)),
        move |_, _| draw_view.into_any_element(),
    );
    let rendered = context.update(|_, cx| {
        view.read(cx)
            .snapshot()
            .map(gpui_shell::RenderSnapshot::debug_tree)
            .unwrap_or_default()
    });

    assert!(
        rendered.contains("Saved HEY"),
        "saved workspace did not restore:\n{rendered}"
    );
}

struct Empty;

impl gpui::Render for Empty {
    fn render(
        &mut self,
        _: &mut gpui::Window,
        _: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        gpui::div()
    }
}
