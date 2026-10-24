use serde::de::DeserializeOwned;
use tauri::{
  plugin::{PluginApi, PluginHandle},
  AppHandle, Runtime,
};

use crate::models::*;

/// Access to the sys-insets APIs.
pub struct SysInsets<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> SysInsets<R> {
  pub fn get_insets(&self) -> crate::Result<GetInsetsResponse> {
    self
      .0
      .run_mobile_plugin("getInsets", ())
      .map_err(Into::into)
  }
}

// initializes the Kotlin plugin class
pub fn init<R: Runtime, C: DeserializeOwned>(
  _app: &AppHandle<R>,
  api: PluginApi<R, C>,
) -> crate::Result<SysInsets<R>> {
  #[cfg(target_os = "android")]
  let handle = api.register_android_plugin("com.plugin.sysinsets", "SysInsetsPlugin")?;
  #[cfg(not(target_os = "android"))]
  return Err(crate::Error::Backend("sys-insets is Android-only".into()));
  #[cfg(target_os = "android")]
  Ok(SysInsets(handle))
}
