package dev.marobotic.vault

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * "Unlock with fingerprint or screen lock": the account password is sealed with a key in the phone's
 * Android Keystore that only works right after a fingerprint, face or the phone's PIN/pattern. The
 * sealed password sits in Vault's private storage; without that unlock it can't be read, not even by
 * Vault. A new fingerprint added to the phone voids the key, and Vault asks for the password once.
 */
class BiometricUnlock(private val activity: FragmentActivity) {
    private val prefs = activity.getSharedPreferences("vault.unlock", Context.MODE_PRIVATE)
    private val alias = "vault-unlock"
    private val authenticators = if (Build.VERSION.SDK_INT >= 30) BIOMETRIC_STRONG or DEVICE_CREDENTIAL else BIOMETRIC_STRONG

    /** "unavailable" (no fingerprint or screen lock set up), "ready", or "saved" (a password is sealed). */
    fun state(): String = when {
        BiometricManager.from(activity).canAuthenticate(authenticators) != BiometricManager.BIOMETRIC_SUCCESS -> "unavailable"
        prefs.contains("sealed") -> "saved"
        else -> "ready"
    }

    fun clear() {
        prefs.edit().clear().apply()
        runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias) }
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setUserAuthenticationRequired(true)
            .apply {
                if (Build.VERSION.SDK_INT >= 30) setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
            }
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(spec) }.generateKey()
    }

    private fun prompt(title: String, cipher: Cipher, done: (Cipher?, String?) -> Unit) {
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle("Fingerprint, face or your phone's screen lock")
            .setAllowedAuthenticators(authenticators)
            .apply { if (Build.VERSION.SDK_INT < 30) setNegativeButtonText("Use password") }
            .build()
        BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = done(result.cryptoObject?.cipher, null)
            override fun onAuthenticationError(code: Int, msg: CharSequence) = done(null, if (code == BiometricPrompt.ERROR_USER_CANCELED || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON || code == BiometricPrompt.ERROR_CANCELED) "cancelled" else msg.toString())
        }).authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }

    /** Seals "email \n password" behind the phone's unlock. */
    fun save(email: String, password: String, done: (Boolean, String?) -> Unit) {
        val cipher = try { Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) } }
            catch (e: KeyPermanentlyInvalidatedException) { clear(); return save(email, password, done) }
            catch (e: Exception) { return done(false, e.message) }
        prompt("Turn on unlock for Vault", cipher) { c, err ->
            if (c == null) return@prompt done(false, err)
            try {
                val sealed = c.doFinal("$email\n$password".toByteArray())
                prefs.edit().putString("iv", Base64.encodeToString(c.iv, Base64.NO_WRAP)).putString("sealed", Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
                done(true, null)
            } catch (e: Exception) { done(false, e.message) }
        }
    }

    /** The sealed email and password, after the phone's unlock. */
    fun open(done: (String?, String?, String?) -> Unit) {
        val iv = prefs.getString("iv", null) ?: return done(null, null, "none")
        val sealed = prefs.getString("sealed", null) ?: return done(null, null, "none")
        val cipher = try { Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP))) } }
            catch (e: KeyPermanentlyInvalidatedException) { clear(); return done(null, null, "changed") }
            catch (e: Exception) { return done(null, null, e.message) }
        prompt("Unlock Vault", cipher) { c, err ->
            if (c == null) return@prompt done(null, null, err)
            try {
                val text = String(c.doFinal(Base64.decode(sealed, Base64.NO_WRAP)))
                done(text.substringBefore("\n"), text.substringAfter("\n"), null)
            } catch (e: Exception) { done(null, null, e.message) }
        }
    }
}
