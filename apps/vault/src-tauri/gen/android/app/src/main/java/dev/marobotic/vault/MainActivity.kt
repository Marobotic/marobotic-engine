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
import androidx.activity.OnBackPressedCallback
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

  // Back is the page's: it closes the window or menu on top, then steps back (window.vaultBack in
  // main.ts). Only when there's nothing left does Vault go to the background, back to the app before it.
  override val handleBackNavigation: Boolean = false

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
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val wv = webView ?: return leave()
        wv.evaluateJavascript("!!(window.vaultBack && window.vaultBack())") { handled -> if (handled != "true") leave() }
      }
    })
  }

  private fun leave() { moveTaskToBack(true) }

  override fun onResume() {
    super.onResume()
    // The page may have been alive while Android paused it; the page coalesces this with startup.
    webView?.evaluateJavascript("dispatchEvent(new Event('vault-resume'))", null)
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
    webView.settings.setSupportZoom(false)   // an app, not a web page: no pinch zoom
    webView.settings.builtInZoomControls = false
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
    @JavascriptInterface fun takeUses(): String = AutofillStore.takeUses(this@MainActivity)
    @JavascriptInterface fun takeLink(): String = AutofillStore.pendingLink.also { AutofillStore.pendingLink = null } ?: ""
    @JavascriptInterface fun autofillState(): String {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return "unsupported"
      val am = getSystemService(AutofillManager::class.java) ?: return "unsupported"
      if (!am.isAutofillSupported) return "unsupported"
      return if (am.hasEnabledAutofillServices()) "on" else "off"
    }
    /** The app now filling passwords on this phone, by name. Only autofill_service is readable by apps
     *  (the credential_service keys are system-only since Android 12). */
    @JavascriptInterface fun autofillProvider(): String = try {
      val pkg = Settings.Secure.getString(contentResolver, "autofill_service")?.substringBefore("/")?.takeIf { it.isNotBlank() }
      when (pkg) {
        null -> ""
        packageName -> "Vault"
        else -> packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
      }
    } catch (_: Exception) { "" }
    /** Whether Vault is an enabled passkey/password provider (Android 14+ public API). */
    @JavascriptInterface fun passkeyProviderIsVault(): Boolean = try {
      Build.VERSION.SDK_INT >= 34 && getSystemService(android.credentials.CredentialManager::class.java)
        ?.isEnabledCredentialProviderService(android.content.ComponentName(this@MainActivity, VaultCredentialService::class.java)) == true
    } catch (_: Exception) { false }

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

    /** Whether Android may pause Vault in the background (Samsung freezes it, and autofill then waits). */
    @JavascriptInterface fun keptReady(): Boolean = getSystemService(android.os.PowerManager::class.java)?.isIgnoringBatteryOptimizations(packageName) == true
    @JavascriptInterface fun keepReady() = runOnUiThread {
      try { startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).setData(Uri.parse("package:$packageName"))) }
      catch (_: Exception) { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
    }

    /** Vault's own list in apps that hide Android's (VaultAccessibilityService), turned on in Accessibility settings. */
    @JavascriptInterface fun overlayOn(): Boolean = VaultAccessibilityService.enabled(this@MainActivity)
    @JavascriptInterface fun openOverlaySettings() = runOnUiThread {
      val me = android.content.ComponentName(this@MainActivity, VaultAccessibilityService::class.java).flattenToString()
      val tries = listOf(
        Intent("android.settings.ACCESSIBILITY_DETAILS_SETTINGS").putExtra(Intent.EXTRA_COMPONENT_NAME, me),
        Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
      for (i in tries) { try { startActivity(i); return@runOnUiThread } catch (_: Exception) {} }
    }

    /** Installed browsers that keep their own autofill until told to use the phone's, with where that is. */
    @JavascriptInterface fun browsers(): String {
      val chromium = "In %s: Settings, Autofill services, Autofill using another service. Restart %s after changing it."
      val known = listOf(
        Triple("com.android.chrome", "Chrome", chromium), Triple("com.brave.browser", "Brave", chromium),
        Triple("com.microsoft.emmx", "Edge", chromium), Triple("com.vivaldi.browser", "Vivaldi", chromium),
        Triple("com.sec.android.app.sbrowser", "Samsung Internet", "Samsung Internet only fills with its own passwords and a few partners, so Vault can't fill there. Use Chrome or Brave to sign in to sites."))
      val out = org.json.JSONArray()
      for ((pkg, name, how) in known) {
        val there = try { packageManager.getApplicationInfo(pkg, 0).enabled } catch (_: Exception) { false }
        if (there) out.put(JSONObject().put("pkg", pkg).put("name", name).put("how", how.format(name, name)))
      }
      return out.toString()
    }
    @JavascriptInterface fun openApp(pkg: String) = runOnUiThread {
      packageManager.getLaunchIntentForPackage(pkg)?.let { try { startActivity(it) } catch (_: Exception) {} }
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
