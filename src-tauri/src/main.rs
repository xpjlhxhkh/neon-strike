/* =====================================================================
   霓虹突袭 — Tauri 桌面外壳（Rust 侧）
   ---------------------------------------------------------------------
   只做两件"浏览器做不到"的事：
     · set_fullscreen —— 原生窗口全屏（不经过 Fullscreen API，
       因此没有"按 Esc 退出全屏"提示，也不会被 Esc 踢出全屏）
     · quit —— 结束进程（关窗即退，不再需要旧的启动器强杀逻辑）
   玩法逻辑全部在前端 web/ 里，这里一行都不碰。
   ===================================================================== */
/* 注意：这里刻意不写 windows_subsystem = "windows"。
   GNU 目标用 rust-lld 链接时，GUI 子系统会选错入口点，导致进程在 main
   之前就被加载器结束（表现为双击秒退）。改成按 console 子系统链接（入口点
   mainCRTStartup 正确），构建脚本 tools/build-tauri.ps1 再把 PE 头里的
   子系统字段改成 GUI(2)，这样既没有控制台窗口，入口点也是对的。 */
#![allow(dead_code)]

use std::io::Write;

/// 启动日志（GUI 子系统下没有控制台，用它定位启动期问题）
fn log(msg: &str) {
    let path = std::env::temp_dir().join("neon-boot.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}", msg);
    }
}

/// 原生全屏开关
#[tauri::command]
fn set_fullscreen(window: tauri::Window, on: bool) -> Result<(), String> {
    let r = window.set_fullscreen(on);
    log(&format!("set_fullscreen({on}) -> {:?}", r.is_ok()));
    r.map_err(|e| e.to_string())
}

/// 前端诊断日志（只写进 %TEMP%\neon-boot.log，方便排查外壳问题）
#[tauri::command]
fn log_from_page(msg: String) {
    log(&format!("[page] {msg}"));
}

/// 退出游戏：直接结束进程
#[tauri::command]
fn quit(app: tauri::AppHandle) {
    log("quit 被调用");
    app.exit(0);
}

/* ===================== 存档（只允许写进游戏文件夹） =====================
   规则：所有存档必须落在 <exe 所在目录>/saves/ 里，不允许写到用户目录、
        临时目录或任何其它位置。
   安全：文件名只允许 [A-Za-z0-9._-]，禁止路径分隔符与 ".."，防止越权写文件。 */
fn saves_dir() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or_else(|| "找不到程序目录".to_string())?.join("saves");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn safe_name(name: &str) -> Result<String, String> {
    let ok = !name.is_empty()
        && name.len() <= 96
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        && !name.contains("..");
    if !ok {
        return Err(format!("非法存档名: {name}"));
    }
    Ok(name.to_string())
}

/// 写存档（返回完整路径，前端会显示出来让用户确认位置）
#[tauri::command]
fn save_game_file(name: String, content: String) -> Result<String, String> {
    let name = safe_name(&name)?;
    let path = saves_dir()?.join(&name);
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    let p = path.to_string_lossy().to_string();
    log(&format!("存档已写入 {p}"));
    Ok(p)
}

/// 读存档（不存在返回 None）
#[tauri::command]
fn load_game_file(name: String) -> Result<Option<String>, String> {
    let name = safe_name(&name)?;
    let path = saves_dir()?.join(&name);
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path).map(Some).map_err(|e| e.to_string())
}

/// 列出存档目录里的文件名（开机时用它把所有存档恢复进页面）
#[tauri::command]
fn list_game_files() -> Result<Vec<String>, String> {
    let dir = saves_dir()?;
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            if let Some(n) = e.file_name().to_str() {
                if n.ends_with(".json") {
                    out.push(n.to_string());
                }
            }
        }
    }
    Ok(out)
}

/// 存档目录的绝对路径（设置界面展示用）
#[tauri::command]
fn saves_path() -> Result<String, String> {
    Ok(saves_dir()?.to_string_lossy().to_string())
}

fn main() {
    log("--- main 进入 ---");
    std::panic::set_hook(Box::new(|info| {
        let path = std::env::temp_dir().join("neon-boot.log");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "panic: {info}");
        }
    }));

    let ctx = tauri::generate_context!();
    log("context 生成完毕");

    match tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            set_fullscreen,
            quit,
            log_from_page,
            save_game_file,
            load_game_file,
            list_game_files,
            saves_path
        ])
        .run(ctx)
    {
        Ok(()) => log("run 正常返回"),
        Err(e) => log(&format!("run 返回错误: {e}")),
    }
    log("--- main 退出 ---");
}
