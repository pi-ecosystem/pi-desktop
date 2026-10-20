package com.plugin.termuxboot

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class BootArgs {
  var port: Int = 1423
}

// com.termux.permission.RUN_COMMAND is protectionLevel=dangerous in the
// Termux manifest, so a manifest <uses-permission> alone is never enough:
// it must be granted at runtime. Without this the RUN_COMMAND intent dies
// with a Permission Denial and the backend never boots.
@TauriPlugin(
  permissions = [Permission(strings = ["com.termux.permission.RUN_COMMAND"], alias = "run-command")]
)
class TermuxBootPlugin(private val activity: Activity) : Plugin(activity) {

  private fun packageInstalled(name: String): Boolean {
    val pm = activity.packageManager
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        pm.getPackageInfo(name, PackageManager.PackageInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION")
        pm.getPackageInfo(name, 0)
      }
      true
    } catch (_: Exception) {
      false
    }
  }

  @Command
  fun termuxAvailable(invoke: Invoke) {
    val res = JSObject()
    res.put("termux", packageInstalled("com.termux"))
    res.put("termuxApi", packageInstalled("com.termux.api"))
    invoke.resolve(res)
  }

  @Command
  fun bootServer(invoke: Invoke) {
    if (getPermissionState("run-command") != PermissionState.GRANTED) {
      // System permission dialog; the callback below fires with the result.
      requestPermissionForAlias("run-command", invoke, "runCommandPermissionCallback")
      return
    }
    val args = invoke.parseArgs(BootArgs::class.java)
    fireBoot(invoke, args.port)
  }

  @PermissionCallback
  fun runCommandPermissionCallback(invoke: Invoke) {
    if (getPermissionState("run-command") == PermissionState.GRANTED) {
      val args = invoke.parseArgs(BootArgs::class.java)
      fireBoot(invoke, args.port)
    } else {
      invoke.reject("Termux permission denied — allow it in Settings → Apps → Pi → Permissions, then reopen the app")
    }
  }

  private fun fireBoot(invoke: Invoke, port: Int) {
    try {
      if (!packageInstalled("com.termux")) {
        invoke.reject("Termux app is not installed")
        return
      }
      // Fire-and-forget: Termux runs pi-desktop-server in the background.
      // Spec: https://github.com/termux/termux-app/wiki/RUN_COMMAND-Intent
      // (action + extras verified against RunCommandService bytecode).
      val intent = Intent("com.termux.RUN_COMMAND").apply {
        setClassName("com.termux", "com.termux.app.RunCommandService")
        putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
        putExtra(
          "com.termux.RUN_COMMAND_PATH",
          "/data/data/com.termux/files/usr/bin/pi-desktop-server"
        )
        putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("--server", port.toString()))
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        activity.startForegroundService(intent)
      } else {
        activity.startService(intent)
      }
      invoke.resolve(JSObject().put("started", true))
    } catch (e: Exception) {
      invoke.reject(e.message ?: "failed to send RUN_COMMAND to Termux")
    }
  }
}
