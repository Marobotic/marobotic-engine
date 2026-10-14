package dev.marobotic.vault

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.spec.MGF1ParameterSpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.SecretKeySpec

/**
 * The full autofill list, kept on the phone so a locked Vault can still fill: sealed with a fresh AES
 * key each time, and that key with an RSA key in the phone's keystore. Sealing uses only the public
 * half, so Vault can update it any time; opening needs the private half, which the keystore only uses
 * right after a fingerprint, face or the phone's screen lock.
 */
object SealedIndex {
    private const val ALIAS = "vault-autofill"
    private const val RSA = "RSA/ECB/OAEPWithSHA-256AndMGF1Padding"
    private val OAEP = OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT)
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("vault.sealed", Context.MODE_PRIVATE)
    private fun keystore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun publicKey(): java.security.PublicKey {
        val ks = keystore()
        if (!ks.containsAlias(ALIAS)) {
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore").apply {
                initialize(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_DECRYPT)
                    .setKeySize(2048)
                    .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA1)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
                    .setUserAuthenticationRequired(true)
                    .apply { if (Build.VERSION.SDK_INT >= 30) setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL) }
                    .build())
            }.generateKeyPair()
        }
        // Outside the keystore, so encrypting needs no unlock.
        val pub = ks.getCertificate(ALIAS).publicKey
        return KeyFactory.getInstance(pub.algorithm).generatePublic(X509EncodedKeySpec(pub.encoded))
    }

    fun has(ctx: Context) = prefs(ctx).contains("box")

    fun seal(ctx: Context, json: String) {
        val aes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val gcm = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, SecretKeySpec(aes, "AES")) }
        val box = gcm.doFinal(json.toByteArray())
        val wrapped = Cipher.getInstance(RSA).apply { init(Cipher.ENCRYPT_MODE, publicKey(), OAEP) }.doFinal(aes)
        val b64 = { b: ByteArray -> Base64.encodeToString(b, Base64.NO_WRAP) }
        prefs(ctx).edit().putString("key", b64(wrapped)).putString("iv", b64(gcm.iv)).putString("box", b64(box)).apply()
    }

    /** The cipher to hand to BiometricPrompt; after the unlock, `open` reads the list with it. */
    fun unlockCipher(): Cipher = Cipher.getInstance(RSA).apply { init(Cipher.DECRYPT_MODE, keystore().getKey(ALIAS, null) as PrivateKey, OAEP) }

    fun open(ctx: Context, unlocked: Cipher): String {
        val p = prefs(ctx)
        val d = { k: String -> Base64.decode(p.getString(k, "") ?: "", Base64.NO_WRAP) }
        val aes = unlocked.doFinal(d("key"))
        val gcm = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, SecretKeySpec(aes, "AES"), GCMParameterSpec(128, d("iv"))) }
        return String(gcm.doFinal(d("box")))
    }

    fun clear(ctx: Context) {
        prefs(ctx).edit().clear().apply()
        runCatching { keystore().deleteEntry(ALIAS) }
    }
}
