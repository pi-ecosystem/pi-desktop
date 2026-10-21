use tauri::{
  plugin::{Builder, TauriPlugin},
  Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::TermuxBoot;
#[cfg(mobile)]
use mobile::TermuxBoot;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the termux-boot APIs.
pub trait TermuxBootExt<R: Runtime> {
  fn termux_boot(&self) -> &TermuxBoot<R>;
}

impl<R: Runtime, T: Manager<R>> crate::TermuxBootExt<R> for T {
  fn termux_boot(&self) -> &TermuxBoot<R> {
    self.state::<TermuxBoot<R>>().inner()
  }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("termux-boot")
    .invoke_handler(tauri::generate_handler![commands::termux_available, commands::boot_server, commands::kill_server])
    .setup(|app, api| {
      #[cfg(mobile)]
      let termux_boot = mobile::init(app, api)?;
      #[cfg(desktop)]
      let termux_boot = desktop::init(app, api)?;
      app.manage(termux_boot);
      Ok(())
    })
    .build()
}
