package com.plugin.termuxboot

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class BootArgs {
  var port: Int = 1423
}

@TauriPlugin
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
    try {
      val args = invoke.parseArgs(BootArgs::class.java)
      if (!packageInstalled("com.termux")) {
        invoke.reject("Termux app is not installed")
        return
      }
      // Fire-and-forget: Termux runs pi-desktop-server in the background.
      // The frontend polls the HTTP backend until it answers.
      val intent = Intent("com.termux.app.RUN_COMMAND").apply {
        setClassName("com.termux", "com.termux.app.RunCommandService")
        putExtra("com.termux.execute.background", true)
        putExtra(
          "com.termux.execute.command_path",
          "/data/data/com.termux/files/usr/bin/pi-desktop-server"
        )
        putExtra("com.termux.execute.arguments", arrayOf("--server", args.port.toString()))
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
