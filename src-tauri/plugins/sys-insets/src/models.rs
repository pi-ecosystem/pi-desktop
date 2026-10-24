use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetInsetsResponse {
  pub top: i32,
  pub bottom: i32,
  pub left: i32,
  pub right: i32,
}
