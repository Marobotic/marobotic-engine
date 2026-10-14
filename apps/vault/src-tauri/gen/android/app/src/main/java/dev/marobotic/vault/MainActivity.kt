package dev.marobotic.vault

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.autofill.AutofillManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

class MainActivity : TauriActivity() {
  companion object { const val FOR_AUTOFILL = "dev.marobotic.vault.FOR_AUTOFILL" }

  private var webView: WebView? = null
  private val unlock by lazy { BiometricUnlock(this) }
  /** Opened to unlock for autofill: once the vault is open, go back to the app that asked. */
  @Volatile private var forAutofill = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Edge to edge, but the page stays clear of the status bar, the navigation bar and the keyboard.
    window.decorView.setBackgroundColor(Color.parseColor("#121212"))
    ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
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

  /** An answer for the page, as a `vault-native` event: { id, ...result }. */
  private fun answer(id: Int, result: JSONObject) = runOnUiThread {
    webView?.evaluateJavascript("dispatchEvent(new CustomEvent('vault-native', { detail: ${result.put("id", id)} }))", null)
  }

  /** What Vault's window can ask of Android. Only Vault's own page is ever loaded in this WebView. */
  inner class Bridge {
    @JavascriptInterface fun setAutofill(json: String) {
      AutofillStore.set(this@MainActivity, json)
      if (forAutofill) { forAutofill = false; runOnUiThread { moveTaskToBack(true) } }
    }
    @JavascriptInterface fun clearAutofill() = AutofillStore.clear()
    @JavascriptInterface fun takeSaves(): String = AutofillStore.takeSaves()
    @JavascriptInterface fun takePasskeys(): String = AutofillStore.takePasskeys()
    @JavascriptInterface fun takeLink(): String = AutofillStore.pendingLink.also { AutofillStore.pendingLink = null } ?: ""
    @JavascriptInterface fun autofillState(): String {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return "unsupported"
      val am = getSystemService(AutofillManager::class.java) ?: return "unsupported"
      if (!am.isAutofillSupported) return "unsupported"
      return if (am.hasEnabledAutofillServices()) "on" else "off"
    }
    /** The app now filling passwords on this phone (autofill, and passkeys on Android 14+), by name. */
    @JavascriptInterface fun autofillProvider(): String {
      val ids = listOf("autofill_service", "credential_service_primary", "credential_service")
        .mapNotNull { Settings.Secure.getString(contentResolver, it)?.split(":")?.firstOrNull()?.substringBefore("/")?.takeIf { p -> p.isNotBlank() } }
      val pkg = ids.firstOrNull() ?: return ""
      if (pkg == packageName) return "Vault"
      return try { packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString() } catch (_: Exception) { pkg }
    }
    @JavascriptInterface fun passkeyProviderIsVault(): Boolean =
      listOf("credential_service_primary", "credential_service").any { Settings.Secure.getString(contentResolver, it)?.contains("$packageName/") == true }

    /** Android's "Passwords, passkeys & autofill" picker, else the older autofill picker, else Settings. */
    @JavascriptInterface fun openAutofillSettings() = runOnUiThread {
      val pkg = Uri.parse("package:$packageName")
      val tries = buildList {
        if (Build.VERSION.SDK_INT >= 34) add(Intent(Settings.ACTION_CREDENTIAL_PROVIDER).setData(pkg))
        if (Build.VERSION.SDK_INT >= 26) add(Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE).setData(pkg))
        add(Intent(Settings.ACTION_SETTINGS))
      }
      for (i in tries) {
        try { startActivity(i); Log.i("Vault", "opened ${i.action}"); return@runOnUiThread }
        catch (e: Exception) { Log.w("Vault", "can't open ${i.action}: ${e.message}") }
      }
    }

    // ---- unlock with fingerprint / screen lock (BiometricUnlock.kt); answers come as vault-native events
    @JavascriptInterface fun unlockState(): String = unlock.state()
    @JavascriptInterface fun unlockClear() = unlock.clear()
    @JavascriptInterface fun unlockSave(id: Int, email: String, password: String) = runOnUiThread {
      unlock.save(email, password) { ok, err -> answer(id, JSONObject().put("ok", ok).put("error", err ?: "")) }
    }
    @JavascriptInterface fun unlockOpen(id: Int) = runOnUiThread {
      unlock.open { email, password, err ->
        answer(id, if (email != null) JSONObject().put("email", email).put("password", password) else JSONObject().put("error", err ?: ""))
      }
    }
  }
}
