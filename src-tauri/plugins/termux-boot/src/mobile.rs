use serde::de::DeserializeOwned;
use tauri::{
  plugin::{PluginApi, PluginHandle},
  AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_termux_boot);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
  _app: &AppHandle<R>,
  api: PluginApi<R, C>,
) -> crate::Result<TermuxBoot<R>> {
  #[cfg(target_os = "android")]
  let handle = api.register_android_plugin("", "TermuxBootPlugin")?;
  #[cfg(target_os = "ios")]
  let handle = api.register_ios_plugin(init_plugin_termux_boot)?;
  Ok(TermuxBoot(handle))
}

/// Access to the termux-boot APIs.
pub struct TermuxBoot<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> TermuxBoot<R> {
  pub fn termux_available(&self) -> crate::Result<TermuxAvailableResponse> {
    self
      .0
      .run_mobile_plugin("termuxAvailable", ())
      .map_err(Into::into)
  }

  pub fn boot_server(&self, port: u16) -> crate::Result<BootServerResponse> {
    self
      .0
      .run_mobile_plugin("bootServer", BootServerRequest { port: Some(port) })
      .map_err(Into::into)
  }
}
