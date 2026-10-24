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
use desktop::SysInsets;
#[cfg(mobile)]
use mobile::SysInsets;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the sys-insets APIs.
pub trait SysInsetsExt<R: Runtime> {
  fn sys_insets(&self) -> &SysInsets<R>;
}

impl<R: Runtime, T: Manager<R>> crate::SysInsetsExt<R> for T {
  fn sys_insets(&self) -> &SysInsets<R> {
    self.state::<SysInsets<R>>().inner()
  }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("sys-insets")
    .invoke_handler(tauri::generate_handler![commands::get_insets])
    .setup(|app, api| {
      #[cfg(mobile)]
      let sys_insets = mobile::init(app, api)?;
      #[cfg(desktop)]
      let sys_insets = desktop::init(app, api)?;
      app.manage(sys_insets);
      Ok(())
    })
    .build()
}
