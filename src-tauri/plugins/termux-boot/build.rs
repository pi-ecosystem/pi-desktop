const COMMANDS: &[&str] = &["termux-available", "boot-server", "insets"];

fn main() {
  tauri_plugin::Builder::new(COMMANDS)
    .android_path("android")
    .ios_path("ios")
    .build();
}
