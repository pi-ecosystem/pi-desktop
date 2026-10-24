const COMMANDS: &[&str] = &["get-insets"];

fn main() {
  tauri_plugin::Builder::new(COMMANDS)
    .android_path("android")
    .build();
}
