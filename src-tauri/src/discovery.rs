use std::{path::{Path, PathBuf}, sync::{Arc, Mutex}, os::windows::{ffi::OsStrExt, fs::MetadataExt}};

use tauri_plugin_dialog::DialogExt;
#[link(name="version")]
extern "system" {
    fn GetFileVersionInfoSizeW(path: *const u16, handle: *mut u32) -> u32;
    fn GetFileVersionInfoW(path: *const u16, handle: u32, len: u32, data: *mut std::ffi::c_void) -> i32;
    fn VerQueryValueW(data: *const std::ffi::c_void, key: *const u16, out: *mut *mut std::ffi::c_void, len: *mut u32) -> i32;
}
pub fn version(path: &Path) -> Option<String> {
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        let mut handle = 0;
        let size = GetFileVersionInfoSizeW(wide.as_ptr(), &mut handle);
        if size == 0 || size > 1024*1024 { return None; }
        let mut data = vec![0u32; (size as usize + 3)/4];
        if GetFileVersionInfoW(wide.as_ptr(), 0, size, data.as_mut_ptr().cast()) == 0 { return None; }
        let mut ptr = std::ptr::null_mut(); let mut len = 0;
        if VerQueryValueW(data.as_ptr().cast(), [92u16,0].as_ptr(), &mut ptr, &mut len) == 0 || len < 52 || ptr.is_null() { return None; }
        let values = std::slice::from_raw_parts(ptr.cast::<u32>(), 13);
        if values[0] != 0xfeef04bd { return None; }
        Some(format!("{}.{}.{}.{}", values[2] >> 16, values[2] & 65535, values[3] >> 16, values[3] & 65535))
    }
}
#[derive(Clone, serde::Serialize)]
pub struct Candidate { pub path: String, pub version: Option<String> }
pub fn inspect(path: &Path) -> Candidate {
    Candidate { path: path.to_string_lossy().into_owned(), version: path.parent().and_then(|p| version(&p.join("Game.dll"))).or_else(|| version(path)) }
}
#[derive(Default, Clone, serde::Serialize)]
pub struct Scan { pub running: bool, pub cancelled: bool, pub visited: usize, pub skipped: usize, pub limited: bool, pub root: String, pub results: Vec<Candidate> }
pub type Search = Arc<Mutex<Scan>>;
#[tauri::command]
pub fn scan_status(state: tauri::State<Search>) -> Scan { state.lock().unwrap().clone() }
#[tauri::command]
pub fn cancel_scan(state: tauri::State<Search>) { state.lock().unwrap().cancelled = true; }
#[tauri::command]
pub async fn search_game(app: tauri::AppHandle, state: tauri::State<'_, Search>) -> Result<(), String> {
    { let mut scan = state.lock().unwrap(); if scan.running { return Err("搜索正在进行".into()); } scan.running = true; }
    let choice = app.dialog().file().set_title("选择要搜索的游戏目录").blocking_pick_folder();
    let root = match choice { Some(p) => match p.into_path() { Ok(p) => p, Err(e) => { state.lock().unwrap().running = false; return Err(e.to_string()); } }, None => { state.lock().unwrap().running = false; return Ok(()); } };
    *state.lock().unwrap() = Scan { running: true, root: root.to_string_lossy().into_owned(), ..Default::default() };
    let shared = state.inner().clone();
    std::thread::spawn(move || {
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            { let mut s = shared.lock().unwrap(); if s.cancelled { break; } if s.visited >= 200000 || s.results.len() >= 100 { s.limited = true; break; } s.visited += 1; }
            // Windows junctions and symlinks are reparse points: never follow them.
            let Ok(meta) = std::fs::symlink_metadata(&dir) else { shared.lock().unwrap().skipped += 1; continue; };
            if meta.file_attributes() & 0x400 != 0 { shared.lock().unwrap().skipped += 1; continue; }
            let exe = dir.join("war3.exe");
            if super::validate(&exe).is_ok() { shared.lock().unwrap().results.push(inspect(&exe)); }
            match std::fs::read_dir(&dir) {
                Ok(entries) => for entry in entries {
                    if shared.lock().unwrap().cancelled { break; }
                    match entry { Ok(e) => if e.file_type().map(|t| t.is_dir()).unwrap_or(false) { stack.push(e.path()); }, Err(_) => shared.lock().unwrap().skipped += 1 }
                },
                Err(_) => shared.lock().unwrap().skipped += 1,
            }
        }
        shared.lock().unwrap().running = false;
    });
    Ok(())
}
#[tauri::command]
pub fn select_search_result(app: tauri::AppHandle, search: tauri::State<Search>, state: tauri::State<Mutex<super::Game>>, index: usize) -> Result<super::Status, String> {
    let path = search.lock().unwrap().results.get(index).ok_or("搜索结果已失效")?.path.clone();
    let mut game = state.lock().map_err(|e| e.to_string())?;
    super::save_game(&app, &mut game, PathBuf::from(path))
}
