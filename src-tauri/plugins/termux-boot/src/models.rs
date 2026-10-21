use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermuxAvailableResponse {
  pub termux: bool,
  pub termux_api: bool,
  #[serde(default)]
  pub termux_stopped: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootServerRequest {
  pub port: Option<u16>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootServerResponse {
  pub started: bool,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KillServerResponse {
  pub killed: bool,
}
