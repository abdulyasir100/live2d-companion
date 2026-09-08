use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;

/// Whether the window currently lets clicks pass through to whatever is behind it.
static CLICK_THROUGH: AtomicBool = AtomicBool::new(false);

const PET_WINDOW: &str = "pet";

// ---------------------------------------------------------------------------
// Desktop-only behaviour.
//
// The pet is a desktop idea: a frameless, always-on-top, click-through window
// with a tray icon and a cursor to follow. None of those APIs exist on mobile,
// so everything that touches them is compiled out and the matching commands
// become no-ops rather than disappearing - the frontend is one codebase and
// still calls them.
// ---------------------------------------------------------------------------

#[cfg(desktop)]
mod desktop {
    use super::{CLICK_THROUGH, PET_WINDOW};
    use std::sync::atomic::Ordering;
    use tauri::{Emitter, Manager};

    /// Holds the tray's checkable item so it can follow state changed elsewhere
    /// (the hotkey, or a right-click on the character).
    pub struct Tray {
        pub through: tauri::menu::CheckMenuItem<tauri::Wry>,
    }

    pub fn apply_click_through(
        window: &tauri::WebviewWindow,
        enabled: bool,
    ) -> tauri::Result<()> {
        window.set_ignore_cursor_events(enabled)?;
        CLICK_THROUGH.store(enabled, Ordering::Relaxed);
        window.emit("click-through", enabled)?;

        if let Some(tray) = window.app_handle().try_state::<Tray>() {
            let _ = tray.through.set_checked(enabled);
        }
        Ok(())
    }

    pub fn toggle_visible(app: &tauri::AppHandle) {
        let Some(window) = app.get_webview_window(PET_WINDOW) else {
            return;
        };
        if window.is_visible().unwrap_or(true) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }

    /// Polls the OS cursor and reports it relative to her window.
    ///
    /// DOM `mousemove` only fires while the pointer is over the window, so she
    /// stopped tracking the moment you moved to another app - which is most of
    /// the time for a desktop companion. This watches the global cursor instead.
    pub fn spawn_cursor_tracker(app: tauri::AppHandle) {
        // full deflection at roughly 1.5 window-heights away
        const REACH: f64 = 1.5;
        const EPSILON: f64 = 0.004;
        const HEARTBEAT: std::time::Duration = std::time::Duration::from_millis(750);

        std::thread::spawn(move || {
            // Option, not a NaN sentinel: every comparison against NaN is false,
            // so a NaN seed silently suppresses the first emit and never gets
            // replaced.
            let mut last: Option<(f64, f64)> = None;
            let mut heartbeat = std::time::Instant::now();

            loop {
                std::thread::sleep(std::time::Duration::from_millis(33));

                let Some(window) = app.get_webview_window(PET_WINDOW) else {
                    continue;
                };
                if !window.is_visible().unwrap_or(false) {
                    continue;
                }
                let (Ok(cursor), Ok(pos), Ok(size)) = (
                    window.cursor_position(),
                    window.outer_position(),
                    window.inner_size(),
                ) else {
                    continue;
                };

                let cx = pos.x as f64 + size.width as f64 / 2.0;
                let cy = pos.y as f64 + size.height as f64 / 2.0;
                let reach = (size.width.max(size.height) as f64) * REACH;
                let nx = ((cursor.x - cx) / reach).clamp(-1.0, 1.0);
                let ny = (-(cursor.y - cy) / reach).clamp(-1.0, 1.0);

                // Emit on movement to keep IPC quiet, plus a slow heartbeat:
                // this thread starts long before the webview attaches its
                // listener, and Tauri does not buffer events, so a purely
                // change-driven stream would lose its only emit whenever the
                // cursor sits still.
                let moved = last.map_or(true, |(lx, ly)| {
                    (nx - lx).abs() > EPSILON || (ny - ly).abs() > EPSILON
                });
                if moved || heartbeat.elapsed() >= HEARTBEAT {
                    last = Some((nx, ny));
                    heartbeat = std::time::Instant::now();
                    let _ = window.emit("cursor", (nx, ny));
                }
            }
        });
    }

    pub fn install(app: &tauri::App) -> tauri::Result<()> {
        use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
        use tauri::tray::TrayIconBuilder;

        let show = MenuItem::with_id(app, "show", "Show / Hide", true, None::<&str>)?;
        let through = CheckMenuItem::with_id(
            app,
            "through",
            "Click-through  (Ctrl+Alt+L)",
            true,
            false,
            None::<&str>,
        )?;
        let costume = MenuItem::with_id(app, "costume", "Next costume", true, None::<&str>)?;
        let bigger = MenuItem::with_id(app, "bigger", "Bigger", true, None::<&str>)?;
        let smaller = MenuItem::with_id(app, "smaller", "Smaller", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
        let menu = Menu::with_items(
            app,
            &[
                &show,
                &through,
                &costume,
                &PredefinedMenuItem::separator(app)?,
                &bigger,
                &smaller,
                &PredefinedMenuItem::separator(app)?,
                &quit,
            ],
        )?;

        TrayIconBuilder::with_id("companion")
            .icon(app.default_window_icon().unwrap().clone())
            .tooltip("Companion")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id().as_ref() {
                "show" => toggle_visible(app),
                "through" => {
                    if let Some(window) = app.get_webview_window(PET_WINDOW) {
                        let next = !CLICK_THROUGH.load(Ordering::Relaxed);
                        let _ = apply_click_through(&window, next);
                    }
                }
                "costume" => {
                    // the webview owns the costume list, so just nudge it
                    if let Some(window) = app.get_webview_window(PET_WINDOW) {
                        let _ = window.emit("next-costume", ());
                    }
                }
                // the webview knows the character's aspect, so it applies the
                // scale - this only says which direction
                id @ ("bigger" | "smaller") => {
                    if let Some(window) = app.get_webview_window(PET_WINDOW) {
                        let factor = if id == "bigger" { 1.15 } else { 1.0 / 1.15 };
                        let _ = window.emit("zoom", factor);
                    }
                }
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    toggle_visible(tray.app_handle());
                }
            })
            .build(app)?;

        app.manage(Tray { through });
        spawn_cursor_tracker(app.handle().clone());

        // Ctrl+Alt+L toggles click-through from anywhere, so the companion can be
        // made inert without alt-tabbing out of a fullscreen game.
        {
            use tauri_plugin_global_shortcut::{
                Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
            };

            let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyL);
            let watched = toggle;

            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, shortcut, event| {
                        if event.state() != ShortcutState::Pressed || shortcut != &watched {
                            return;
                        }
                        if let Some(window) = app.get_webview_window(PET_WINDOW) {
                            let next = !CLICK_THROUGH.load(Ordering::Relaxed);
                            let _ = apply_click_through(&window, next);
                        }
                    })
                    .build(),
            )?;

            // Another process (often a stale copy of this one) may already own the
            // combination. That costs us a convenience, not the app - so warn and
            // carry on rather than failing the setup hook.
            if let Err(e) = app.global_shortcut().register(toggle) {
                log::warn!("Ctrl+Alt+L unavailable, use right-click instead: {e}");
            }
        }

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Commands. These stay registered on every platform so the shared frontend can
// call them unconditionally; on mobile the window-manipulating ones do nothing.
// ---------------------------------------------------------------------------

#[tauri::command]
fn set_click_through(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    #[cfg(desktop)]
    {
        return desktop::apply_click_through(&window, enabled).map_err(|e| e.to_string());
    }
    #[cfg(not(desktop))]
    {
        let _ = (window, enabled);
        Ok(())
    }
}

#[tauri::command]
fn click_through_state() -> bool {
    CLICK_THROUGH.load(Ordering::Relaxed)
}

/// Lets the webview write into the Rust log, so headless checks of the running
/// app are readable from the terminal without attaching a browser.
#[tauri::command]
fn report(msg: String) {
    log::info!("[web] {msg}");
}

/// Writes a canvas capture from the webview to disk, restoring visual checks of
/// the running app now that no browser automation is attached.
#[tauri::command]
fn save_capture(name: String, png_base64: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let bytes = STANDARD
        .decode(png_base64.as_bytes())
        .map_err(|e| e.to_string())?;
    let safe = name.replace(['/', '\\', '.'], "_");
    let path = std::env::current_dir()
        .map_err(|e| e.to_string())?
        .join(format!("{safe}.png"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    log::info!("[web] capture -> {}", path.display());
    Ok(path.display().to_string())
}

/// Fetches a URL through the native HTTP stack.
///
/// avatar-server serves audio without CORS headers, so the webview cannot fetch
/// it directly. Going through Rust sidesteps that without changing the server,
/// and keeps working wherever this is packaged.
#[tauri::command]
async fn fetch_bytes(url: String) -> Result<tauri::ipc::Response, String> {
    let res = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {} for {url}", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

/// Scales the window, holding the character's aspect so she never distorts.
/// A frameless window has no resize grips, so the scroll wheel drives this.
#[tauri::command]
fn resize(window: tauri::WebviewWindow, factor: f64, aspect: f64) -> Result<(f64, f64), String> {
    #[cfg(desktop)]
    {
        const MIN_H: f64 = 200.0;
        const MAX_H: f64 = 1600.0;

        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let current = window
            .inner_size()
            .map_err(|e| e.to_string())?
            .to_logical::<f64>(scale);

        let height = (current.height * factor).clamp(MIN_H, MAX_H);
        let width = (height * aspect).max(120.0);
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        return Ok((width, height));
    }
    #[cfg(not(desktop))]
    {
        // the app is fullscreen on mobile; nothing to resize
        let _ = (window, factor, aspect);
        Ok((0.0, 0.0))
    }
}

/// A frameless window has no title bar to drag, so the character is the handle.
#[tauri::command]
fn start_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(desktop)]
    {
        return window.start_dragging().map_err(|e| e.to_string());
    }
    #[cfg(not(desktop))]
    {
        let _ = window;
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            set_click_through,
            click_through_state,
            report,
            save_capture,
            resize,
            fetch_bytes,
            start_drag
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            #[cfg(desktop)]
            desktop::install(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
