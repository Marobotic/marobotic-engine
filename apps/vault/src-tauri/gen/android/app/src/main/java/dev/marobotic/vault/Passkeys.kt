package dev.marobotic.vault

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec

/**
 * WebAuthn passkeys on Android, made and used the same way as apps/vault/src/passkeys.ts (the browser
 * extension), so a passkey made on one works on the other: ES256, the "synced" flags, counter 0,
 * Vault's AAGUID.
 */
object Passkeys {
    private const val AAGUID = "dca3e0bd-a9b2-429e-807c-b6af9e3b9b4a"
    private val random = SecureRandom()

    fun b64(b: ByteArray): String = Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    fun unb64(s: String): ByteArray = Base64.decode(s, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)

    // ---------------------------------------------------------------- CBOR (ints, text, bytes, maps)
    private fun head(out: ByteArrayOutputStream, major: Int, n: Long) {
        val m = major shl 5
        when {
            n < 24 -> out.write(m or n.toInt())
            n < 0x100 -> { out.write(m or 24); out.write(n.toInt()) }
            n < 0x10000 -> { out.write(m or 25); out.write((n shr 8).toInt()); out.write((n and 255).toInt()) }
            else -> { out.write(m or 26); for (s in intArrayOf(24, 16, 8, 0)) out.write(((n shr s) and 255).toInt()) }
        }
    }
    private fun cbor(out: ByteArrayOutputStream, v: Any) {
        when (v) {
            is Int -> if (v >= 0) head(out, 0, v.toLong()) else head(out, 1, (-1 - v).toLong())
            is String -> { val b = v.toByteArray(); head(out, 3, b.size.toLong()); out.write(b) }
            is ByteArray -> { head(out, 2, v.size.toLong()); out.write(v) }
            is Map<*, *> -> { head(out, 5, v.size.toLong()); for ((k, x) in v) { cbor(out, k!!); cbor(out, x!!) } }
            else -> error("cbor: ${v::class}")
        }
    }
    private fun cbor(v: Any) = ByteArrayOutputStream().also { cbor(it, v) }.toByteArray()

    // ---------------------------------------------------------------- which site
    /** The registrable part of a host, with the same two-part suffixes the rest of Vault knows. */
    private fun registrable(host: String): String {
        val parts = host.lowercase().split(".")
        if (parts.size <= 2) return host.lowercase()
        val last2 = parts.takeLast(2).joinToString(".")
        val multi = AutofillStore.index?.multi ?: emptySet()
        return if (last2 in multi) parts.takeLast(3).joinToString(".") else last2
    }

    /** A browser's page may use passkeys for its own host or a parent of it, never a public suffix. */
    fun rpAllowed(origin: String, rpId: String): Boolean {
        val u = URL(origin)
        if (u.protocol != "https") return false
        val host = u.host.lowercase()
        val rp = rpId.lowercase()
        return rp == host || (host.endsWith(".$rp") && rp.endsWith(registrable(host)))
    }

    /** An app may use a site's passkeys when the site says so in /.well-known/assetlinks.json. */
    fun appAllowed(rpId: String, pkg: String, certSha256: ByteArray): Boolean = try {
        val c = URL("https://$rpId/.well-known/assetlinks.json").openConnection() as HttpURLConnection
        c.connectTimeout = 6000; c.readTimeout = 6000
        val links = JSONArray(c.inputStream.bufferedReader().readText())
        val fp = certSha256.joinToString(":") { "%02X".format(it) }
        (0 until links.length()).map { links.getJSONObject(it) }.any { l ->
            val rel = l.optJSONArray("relation")?.let { r -> (0 until r.length()).map { r.getString(it) } } ?: emptyList()
            val t = l.optJSONObject("target") ?: return@any false
            ("delegate_permission/common.get_login_creds" in rel || "delegate_permission/common.handle_all_urls" in rel) &&
                t.optString("namespace") == "android_app" && t.optString("package_name") == pkg &&
                (t.optJSONArray("sha256_cert_fingerprints")?.let { f -> (0 until f.length()).any { f.getString(it).equals(fp, true) } } ?: false)
        }
    } catch (_: Exception) { false }

    private fun authData(rpId: String, attested: ByteArray? = null): ByteArray {
        val flags = 0x01 or 0x04 or 0x08 or 0x10 or (if (attested != null) 0x40 else 0)   // UP UV BE BS (AT)
        return sha256(rpId.toByteArray()) + byteArrayOf(flags.toByte(), 0, 0, 0, 0) + (attested ?: ByteArray(0))
    }

    private fun clientData(type: String, challenge: String, origin: String) =
        JSONObject().put("type", type).put("challenge", challenge).put("origin", origin).put("crossOrigin", false).toString().toByteArray()

    class Made(val item: JSONObject, val response: String)

    /**
     * A new passkey for the request (WebAuthn creation options as JSON). `clientDataHash` is given by
     * a browser, which builds clientDataJSON itself; for an app, Vault builds it for `origin`.
     */
    fun create(requestJson: String, origin: String, clientDataHash: ByteArray?): Made {
        val o = JSONObject(requestJson)
        val rp = o.getJSONObject("rp")
        val rpId = rp.optString("id").ifBlank { URL(origin).host }
        val user = o.getJSONObject("user")
        val params = o.optJSONArray("pubKeyCredParams")
        if (params != null && params.length() > 0 && (0 until params.length()).none { params.getJSONObject(it).optInt("alg") == -7 }) error("no supported algorithm")
        val excluded = o.optJSONArray("excludeCredentials")?.let { a -> (0 until a.length()).map { a.getJSONObject(it).getString("id") }.toSet() } ?: emptySet()
        if (AutofillStore.index?.passkeys?.any { it.rpId == rpId && it.credentialId in excluded } == true) error("This passkey is already in Vault")

        val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val pub = kp.public as ECPublicKey
        fun coord(b: java.math.BigInteger) = b.toByteArray().let { if (it.size > 32) it.copyOfRange(it.size - 32, it.size) else ByteArray(32 - it.size) + it }
        val cose = cbor(linkedMapOf<Any, Any>(1 to 2, 3 to -7, -1 to 1, -2 to coord(pub.w.affineX), -3 to coord(pub.w.affineY)))
        val credId = ByteArray(16).also { random.nextBytes(it) }
        val aaguid = AAGUID.replace("-", "").chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        val ad = authData(rpId, aaguid + byteArrayOf((credId.size shr 8).toByte(), (credId.size and 255).toByte()) + credId + cose)
        val att = cbor(linkedMapOf<Any, Any>("fmt" to "none", "attStmt" to linkedMapOf<Any, Any>(), "authData" to ad))
        val cd = if (clientDataHash == null) clientData("webauthn.create", o.getString("challenge"), origin) else JSONObject().put("type", "webauthn.create").toString().toByteArray()

        val item = JSONObject().put("type", "passkey").put("rpId", rpId).put("credentialId", b64(credId)).put("userHandle", user.getString("id"))
            .put("username", user.optString("name")).put("displayName", user.optString("displayName")).put("rpName", rp.optString("name").ifBlank { rpId })
            .put("created", System.currentTimeMillis()).put("counter", 0).put("privateKeyPkcs8", b64(kp.private.encoded))
        val response = JSONObject().put("id", b64(credId)).put("rawId", b64(credId)).put("type", "public-key").put("authenticatorAttachment", "platform")
            .put("response", JSONObject().put("clientDataJSON", b64(cd)).put("attestationObject", b64(att)).put("authenticatorData", b64(ad))
                .put("transports", JSONArray(listOf("internal", "hybrid"))).put("publicKey", b64(pub.encoded)).put("publicKeyAlgorithm", -7))
            .put("clientExtensionResults", JSONObject().put("credProps", JSONObject().put("rk", true)))
        return Made(item, response.toString())
    }

    /** Signs in with a stored passkey (WebAuthn request options as JSON). */
    fun assert(requestJson: String, origin: String, clientDataHash: ByteArray?, p: AutofillStore.Passkey): String {
        val o = JSONObject(requestJson)
        val rpId = o.optString("rpId").ifBlank { URL(origin).host }
        if (rpId != p.rpId) error("That passkey is for another site")
        val ad = authData(rpId)
        val cd = if (clientDataHash == null) clientData("webauthn.get", o.getString("challenge"), origin) else JSONObject().put("type", "webauthn.get").toString().toByteArray()
        val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(unb64(p.privateKeyPkcs8)))
        val sig = Signature.getInstance("SHA256withECDSA").apply { initSign(key); update(ad + (clientDataHash ?: sha256(cd))) }.sign()
        return JSONObject().put("id", p.credentialId).put("rawId", p.credentialId).put("type", "public-key").put("authenticatorAttachment", "platform")
            .put("response", JSONObject().put("clientDataJSON", b64(cd)).put("authenticatorData", b64(ad)).put("signature", b64(sig)).put("userHandle", p.userHandle))
            .put("clientExtensionResults", JSONObject()).toString()
    }
}
