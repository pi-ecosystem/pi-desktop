use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
  app: &AppHandle<R>,
  _api: PluginApi<R, C>,
) -> crate::Result<TermuxBoot<R>> {
  Ok(TermuxBoot(app.clone()))
}

/// Access to the termux-boot APIs.
pub struct TermuxBoot<R: Runtime>(AppHandle<R>);

impl<R: Runtime> TermuxBoot<R> {
  pub fn termux_available(&self) -> crate::Result<TermuxAvailableResponse> {
    // No Termux on desktop: the backend is local, nothing to boot.
    Ok(TermuxAvailableResponse {
      termux: false,
      termux_api: false,
    })
  }

  pub fn boot_server(&self, _port: u16) -> crate::Result<BootServerResponse> {
    Err(crate::Error::Backend("termux boot is Android-only".into()))
  }
}
