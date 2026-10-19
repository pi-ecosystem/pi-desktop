use tauri::{command, AppHandle, Runtime};

use crate::{models::*, Result, TermuxBootExt};

#[command]
pub(crate) async fn termux_available<R: Runtime>(
  app: AppHandle<R>,
) -> Result<TermuxAvailableResponse> {
  app.termux_boot().termux_available()
}

#[command]
pub(crate) async fn boot_server<R: Runtime>(
  app: AppHandle<R>,
  port: Option<u16>,
) -> Result<BootServerResponse> {
  app.termux_boot().boot_server(port.unwrap_or(1423))
}
