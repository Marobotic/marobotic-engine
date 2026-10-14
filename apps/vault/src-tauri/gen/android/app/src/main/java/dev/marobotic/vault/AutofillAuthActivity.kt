package dev.marobotic.vault

import android.app.assist.AssistStructure
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.view.autofill.AutofillManager
import androidx.annotation.RequiresApi
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat

/**
 * Tapping a Vault suggestion while Vault is locked lands here. The fingerprint (face, or the phone's
 * screen lock) opens the sealed autofill list right over the app you're signing in to, and the picked
 * login or code fills. Without a sealed list yet (Vault never opened on this phone), Vault itself opens
 * to sign in, and the fields fill once it's unlocked.
 */
@RequiresApi(Build.VERSION_CODES.O)
class AutofillAuthActivity : AppCompatActivity() {
    private val unlocked: () -> Unit = { runOnUiThread { answer() } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (AutofillStore.index != null) return answer()
        if (SealedIndex.has(this)) return fingerprint()
        openVault()
    }

    override fun onDestroy() {
        AutofillStore.onUnlock.remove(unlocked)
        super.onDestroy()
    }

    private fun openVault() {
        AutofillStore.onUnlock.add(unlocked)
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(MainActivity.FOR_AUTOFILL, true))
    }

    private fun fingerprint() {
        val cipher = try { SealedIndex.unlockCipher() }
            catch (e: KeyPermanentlyInvalidatedException) { SealedIndex.clear(this); return openVault() }   // new fingerprints on the phone
            catch (e: Exception) { return openVault() }
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Fill with Vault")
            .setSubtitle("Fingerprint, face or your phone's screen lock")
            .setAllowedAuthenticators(if (Build.VERSION.SDK_INT >= 30) BIOMETRIC_STRONG or DEVICE_CREDENTIAL else BIOMETRIC_STRONG)
            .apply { if (Build.VERSION.SDK_INT < 30) setNegativeButtonText("Cancel") }
            .build()
        BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                try { AutofillStore.openSealed(SealedIndex.open(this@AutofillAuthActivity, result.cryptoObject!!.cipher!!)) }
                catch (e: Exception) { return openVault() }
                answer()
            }
            override fun onAuthenticationError(code: Int, msg: CharSequence) { setResult(RESULT_CANCELED); finish() }
        }).authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }

    /** The login's 2FA code to the clipboard (marked sensitive), for the sign-in step that asks for it. */
    private fun copyCode(loginId: String) {
        val otp = AutofillStore.index?.logins?.firstOrNull { it.id == loginId }?.otp ?: return
        val clip = android.content.ClipData.newPlainText("2FA code", Totp.code(otp))
        if (Build.VERSION.SDK_INT >= 33) clip.description.extras = android.os.PersistableBundle().apply { putBoolean(android.content.ClipDescription.EXTRA_IS_SENSITIVE, true) }
        getSystemService(android.content.ClipboardManager::class.java)?.setPrimaryClip(clip)
        android.widget.Toast.makeText(applicationContext, "Vault: 2FA code copied", android.widget.Toast.LENGTH_SHORT).show()
    }

    private fun answer() {
        if (isFinishing) return
        @Suppress("DEPRECATION")
        val structure = intent.getParcelableExtra<AssistStructure>(AutofillManager.EXTRA_ASSIST_STRUCTURE)
        val fields = structure?.let { Fields(it, packageName) }
        val kind = intent.getStringExtra("kind") ?: "all"
        val result: android.os.Parcelable? = when {
            fields == null -> null
            kind == "all" -> VaultAutofillService.respond(this, fields)
            else -> VaultAutofillService.datasetFor(this, fields, kind, intent.getStringExtra("ref") ?: "")
        }
        if (result != null && kind == "login") copyCode(intent.getStringExtra("ref") ?: "")
        if (result != null) setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, result))
        else setResult(RESULT_CANCELED)
        finish()
    }
}
