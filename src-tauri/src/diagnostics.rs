use std::{
    fs::{create_dir_all, OpenOptions},
    io::Write,
    panic,
    path::PathBuf,
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

pub fn initialize(config_dir: PathBuf) -> Result<(), String> {
    let log_dir = config_dir.join("logs");
    create_dir_all(&log_dir).map_err(|error| format!("cannot create log directory: {error}"))?;
    let path = log_dir.join("echo-diagnostics.log");
    let _ = LOG_PATH.set(path.clone());
    info("diagnostics", &format!("logging to {}", path.display()));

    let previous = panic::take_hook();
    panic::set_hook(Box::new(move |panic_info| {
        let message = panic_info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| panic_info.payload().downcast_ref::<String>().map(String::as_str))
            .unwrap_or("non-string panic payload");
        let location = panic_info
            .location()
            .map(|value| format!("{}:{}:{}", value.file(), value.line(), value.column()))
            .unwrap_or_else(|| "unknown location".into());
        error("panic", &format!("panic at {location}: {message}"));
        previous(panic_info);
    }));
    Ok(())
}

pub fn info(scope: &str, message: &str) {
    write("INFO", scope, message);
}

pub fn error(scope: &str, message: &str) {
    write("ERROR", scope, message);
}

pub fn client_message(message: &str) {
    let message: String = message
        .chars()
        .take(500)
        .map(|character| if character == '\r' || character == '\n' { ' ' } else { character })
        .collect();
    info("client", &message);
}

fn write(level: &str, scope: &str, message: &str) {
    let Some(path) = LOG_PATH.get() else { return; };
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    let line = format!("{timestamp} {level} [{scope}] {message}\r\n");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}
