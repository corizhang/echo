#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{path::PathBuf, process::{Child, Command}, sync::Mutex};
mod discovery;
mod relay;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct Game { path: Option<PathBuf>, child: Option<Child> }
#[derive(serde::Serialize)]
struct Status { path: Option<String>, running: bool, version: Option<String>, valid: bool }

fn validate(path: &std::path::Path) -> Result<(), String> {
    if !path.is_file() || !path.file_name().unwrap_or_default().to_string_lossy().eq_ignore_ascii_case("war3.exe") {
        return Err("请选择魔兽安装目录中的 war3.exe".into());
    }
    if !path.parent().unwrap().join("Game.dll").is_file() {
        return Err("同一目录中未找到 Game.dll，请选择完整的经典版魔兽安装目录".into());
    }
    Ok(())
}
fn status(game: &mut Game) -> Result<Status, String> {
    if let Some(child) = game.child.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() { game.child = None; }
    }
    Ok(Status { path: game.path.as_ref().map(|p| p.to_string_lossy().into_owned()), running: game.child.is_some(), version: game.path.as_ref().and_then(|p| discovery::inspect(p).version), valid: game.path.as_ref().map(|p| validate(p).is_ok()).unwrap_or(false) })
}
#[tauri::command]
fn game_status(state: tauri::State<Mutex<Game>>) -> Result<Status, String> {
    let mut game = state.lock().map_err(|e| e.to_string())?;
    status(&mut game)
}
#[tauri::command]
async fn choose_game(app: tauri::AppHandle, state: tauri::State<'_, Mutex<Game>>) -> Result<Status, String> {
    let file = app.dialog().file().set_title("选择经典版魔兽争霸的 war3.exe").add_filter("魔兽程序", &["exe"]).blocking_pick_file();
    let mut game = state.lock().map_err(|e| e.to_string())?;
    if let Some(file) = file {
        return save_game(&app, &mut game, file.into_path().map_err(|e| e.to_string())?);
    }
    status(&mut game)
}
fn save_game(app: &tauri::AppHandle, game: &mut Game, path: PathBuf) -> Result<Status, String> {
    if status(game)?.running { return Err("请先退出游戏，再更换路径".into()); }
    validate(&path)?;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("game.json"), serde_json::to_vec(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    game.path = Some(path);
    status(game)
}
#[tauri::command]
fn launch_game(state: tauri::State<Mutex<Game>>) -> Result<Status, String> {
    let mut game = state.lock().map_err(|e| e.to_string())?;
    if status(&mut game)?.running { return status(&mut game); }
    let path = game.path.clone().ok_or("请先选择游戏程序")?;
    validate(&path)?;
    game.child = Some(Command::new(&path).current_dir(path.parent().unwrap()).spawn().map_err(|e| format!("启动失败：{e}"))?);
    status(&mut game)
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(discovery::Search::default())
        .manage(Mutex::new(relay::Relay::default()))
        .setup(|app| {
            let path = app.path().app_config_dir().ok().and_then(|p| std::fs::read(p.join("game.json")).ok()).and_then(|v| serde_json::from_slice::<PathBuf>(&v).ok());
            app.manage(Mutex::new(Game { path, child: None }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![game_status, choose_game, launch_game, discovery::search_game, discovery::scan_status, discovery::cancel_scan, discovery::select_search_result, relay::start_relay, relay::stop_relay, relay::relay_status])
        .run(tauri::generate_context!())
        .expect("无法启动 Echo");
}
