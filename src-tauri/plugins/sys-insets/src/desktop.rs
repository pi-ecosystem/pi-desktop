use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
  app: &AppHandle<R>,
  _api: PluginApi<R, C>,
) -> crate::Result<SysInsets<R>> {
  Ok(SysInsets(app.clone()))
}

/// Access to the sys-insets APIs.
pub struct SysInsets<R: Runtime>(AppHandle<R>);

impl<R: Runtime> SysInsets<R> {
  pub fn get_insets(&self) -> crate::Result<GetInsetsResponse> {
    // Desktop WebViews report CSS env() correctly (0 without overlay
    // bars) — nothing native to do.
    Ok(GetInsetsResponse::default())
  }
}
