package com.plugin.sysinsets

import android.app.Activity
import android.os.Build
import android.view.WindowInsets
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

// System-bar sizes straight from the window (px). CSS env() reads 0 in
// windows that never got inset dispatch even with real overlay bars —
// the OS numbers here stay authoritative. No permission needed.
@TauriPlugin
class SysInsetsPlugin(private val activity: Activity) : Plugin(activity) {

  @Command
  fun getInsets(invoke: Invoke) {
    var top = 0
    var bottom = 0
    var left = 0
    var right = 0
    try {
      val wi = activity.window.decorView.rootWindowInsets
      if (wi != null) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          val sb = wi.getInsets(WindowInsets.Type.statusBars())
          val nb = wi.getInsets(WindowInsets.Type.navigationBars())
          top = sb.top
          bottom = nb.bottom
          left = nb.left
          right = nb.right
        } else {
          @Suppress("DEPRECATION")
          top = wi.systemWindowInsetTop
          @Suppress("DEPRECATION")
          bottom = wi.systemWindowInsetBottom
          @Suppress("DEPRECATION")
          left = wi.systemWindowInsetLeft
          @Suppress("DEPRECATION")
          right = wi.systemWindowInsetRight
        }
      }
    } catch (_: Exception) {
      // fall through with zeros; CSS env() fallback stands
    }
    val res = JSObject()
    res.put("top", top)
    res.put("bottom", bottom)
    res.put("left", left)
    res.put("right", right)
    invoke.resolve(res)
  }
}
