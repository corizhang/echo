fn main() { println!("cargo:rerun-if-env-changed=ECHO_SERVER_URL"); tauri_build::build() }
