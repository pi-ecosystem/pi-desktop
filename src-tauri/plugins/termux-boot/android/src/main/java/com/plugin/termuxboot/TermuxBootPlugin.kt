package com.plugin.termuxboot

import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
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

  // A force-stopped (or swiped-away-on-aggressive-OEMs) Termux silently
  // drops service intents until the user opens it once. Detect that state
  // so boot fails fast with an actionable message instead of polling dead.
  private fun isPackageStopped(name: String): Boolean {
    return try {
      val ai = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        activity.packageManager.getApplicationInfo(name, PackageManager.ApplicationInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION")
        activity.packageManager.getApplicationInfo(name, 0)
      }
      (ai.flags and ApplicationInfo.FLAG_STOPPED) != 0
    } catch (_: Exception) {
      false
    }
  }

  @Command
  fun termuxAvailable(invoke: Invoke) {
    val res = JSObject()
    res.put("termux", packageInstalled("com.termux"))
    res.put("termuxApi", packageInstalled("com.termux.api"))
    res.put("termuxStopped", isPackageStopped("com.termux"))
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

  // Version-independent kill: old backends predate the shutdown_server
  // command, so Stop/Restart can't rely on asking the backend to exit.
  // Runs pkill inside Termux instead — nothing needs to be listening.
  @Command
  fun killServer(invoke: Invoke) {
    if (getPermissionState("run-command") != PermissionState.GRANTED) {
      requestPermissionForAlias("run-command", invoke, "killPermissionCallback")
      return
    }
    fireKill(invoke)
  }

  @PermissionCallback
  fun killPermissionCallback(invoke: Invoke) {
    if (getPermissionState("run-command") == PermissionState.GRANTED) {
      fireKill(invoke)
    } else {
      invoke.reject("Termux permission denied — allow it in Settings → Apps → Pi → Permissions, then reopen the app")
    }
  }

  private fun fireKill(invoke: Invoke) {
    try {
      if (!packageInstalled("com.termux")) {
        invoke.reject("Termux app is not installed")
        return
      }
      // Bracket pattern matches the server cmdline but not this
      // transient sh wrapper's own (which contains the literal text).
      val intent = Intent("com.termux.RUN_COMMAND").apply {
        setClassName("com.termux", "com.termux.app.RunCommandService")
        putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
        putExtra(
          "com.termux.RUN_COMMAND_PATH",
          "/data/data/com.termux/files/usr/bin/sh"
        )
        putExtra(
          "com.termux.RUN_COMMAND_ARGUMENTS",
          arrayOf("-c", "pkill -f '[p]i-desktop-server --server' || true")
        )
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        activity.startForegroundService(intent)
      } else {
        activity.startService(intent)
      }
      invoke.resolve(JSObject().put("killed", true))
    } catch (e: Exception) {
      invoke.reject(e.message ?: "failed to send RUN_COMMAND to Termux")
    }
  }

  private fun fireBoot(invoke: Invoke, port: Int) {
    try {
      if (!packageInstalled("com.termux")) {
        invoke.reject("Termux app is not installed")
        return
      }
      if (isPackageStopped("com.termux")) {
        invoke.reject("Termux is stopped — open the Termux app once, then retry")
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
