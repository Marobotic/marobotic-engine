package dev.marobotic.vault

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.autofill.AutofillManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  companion object { const val FOR_AUTOFILL = "dev.marobotic.vault.FOR_AUTOFILL" }

  private var webView: WebView? = null
  /** Opened to unlock for autofill: once the vault is open, go back to the app that asked. */
  @Volatile private var forAutofill = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    take(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    take(intent)
  }

  private fun take(intent: Intent?) {
    if (intent == null) return
    if (intent.getBooleanExtra(FOR_AUTOFILL, false)) forAutofill = true
    val link = intent.dataString
    if (link != null && link.lowercase().startsWith("otpauth")) {
      AutofillStore.pendingLink = link
      webView?.evaluateJavascript("dispatchEvent(new Event('vault-link'))", null)
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(Bridge(), "VaultAndroid")
  }

  /** What Vault's window can ask of Android. Only Vault's own page is ever loaded in this WebView. */
  inner class Bridge {
    @JavascriptInterface fun setAutofill(json: String) {
      AutofillStore.set(json)
      if (forAutofill) { forAutofill = false; runOnUiThread { moveTaskToBack(true) } }
    }
    @JavascriptInterface fun clearAutofill() = AutofillStore.clear()
    @JavascriptInterface fun takeSaves(): String = AutofillStore.takeSaves()
    @JavascriptInterface fun takeLink(): String = AutofillStore.pendingLink.also { AutofillStore.pendingLink = null } ?: ""
    @JavascriptInterface fun autofillState(): String {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return "unsupported"
      val am = getSystemService(AutofillManager::class.java) ?: return "unsupported"
      if (!am.isAutofillSupported) return "unsupported"
      return if (am.hasEnabledAutofillServices()) "on" else "off"
    }
    @JavascriptInterface fun openAutofillSettings() {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      runOnUiThread {
        try {
          startActivity(Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE).setData(Uri.parse("package:$packageName")))
        } catch (_: Exception) {
          startActivity(Intent(Settings.ACTION_SETTINGS))
        }
      }
    }
  }
}
