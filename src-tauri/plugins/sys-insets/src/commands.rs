use tauri::{command, AppHandle, Runtime};

use crate::{models::*, Result, SysInsetsExt};

#[command]
pub(crate) async fn get_insets<R: Runtime>(
  app: AppHandle<R>,
) -> Result<GetInsetsResponse> {
  app.sys_insets().get_insets()
}
