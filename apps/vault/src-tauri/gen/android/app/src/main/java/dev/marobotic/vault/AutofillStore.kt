package dev.marobotic.vault

import android.content.Context
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * What Android autofill may offer. While Vault is unlocked, its window hands over the full list (in
 * memory). Two copies stay on the phone for when it's locked, so suggestions still show:
 *  - the hints: names, usernames and sites only - no password, no 2FA secret - in Vault's private storage;
 *  - the full list, sealed (SealedIndex) so it only opens after a fingerprint, face or the screen lock.
 * Tapping a suggestion while locked asks for that, then fills. Matching follows the same rules as the
 * browser extension (the tables come from domains.ts).
 */
object AutofillStore {
    class Otp(val secret: String, val digits: Int, val period: Int, val algorithm: String)
    class Login(val id: String, val name: String, val username: String, val email: String, val password: String, val hosts: List<String>, val words: List<String>, val otp: Otp?, val hasOtp: Boolean) {
        /** What the list shows big: the email when there is one (most sites sign in with it), else the username. */
        val who get() = email.ifBlank { username }.ifBlank { name }
        /** What goes into the sign-in name field: an email field gets the email, a username field the username. */
        fun signInName(emailField: Boolean) = if (emailField) email.ifBlank { username } else username.ifBlank { email }
    }
    class Code(val id: String, val issuer: String, val account: String, val words: List<String>, val otp: Otp?)
    class Passkey(val id: String, val rpId: String, val credentialId: String, val userHandle: String, val username: String, val displayName: String, val privateKeyPkcs8: String)
    class Index(val logins: List<Login>, val codes: List<Code>, val multi: Set<String>, val groups: Map<String, String>, val passkeys: List<Passkey>)
    class Save(val url: String, val app: String, val username: String, val password: String)
    /** A one-time code to offer: a login's own ("login:<id>") or a 2FA entry ("code:<id>"). */
    class CodeHit(val ref: String, val who: String, val otp: Otp?)

    /** The full list: set while the vault is open (or right after a fingerprint opened the sealed copy). */
    @Volatile var index: Index? = null
        private set
    @Volatile private var hintsCache: Index? = null
    @Volatile var pendingLink: String? = null
    private val saves = mutableListOf<Save>()
    private val madePasskeys = mutableListOf<JSONObject>()
    val onUnlock = CopyOnWriteArrayList<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())
    private val relock = Runnable { index = null }

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("vault.autofill", Context.MODE_PRIVATE)

    /** From Vault's window: the vault is open. Kept in memory, and the hints + sealed copy are refreshed. */
    fun set(ctx: Context, json: String) {
        val wasLocked = index == null
        main.removeCallbacks(relock)
        index = withMade(parse(JSONObject(json), secrets = true))
        remember(ctx, json)
        if (wasLocked) onUnlock.forEach { it() }
    }

    /** After a fingerprint opened the sealed copy: usable for a few minutes, then locked again. */
    fun openSealed(json: String) {
        index = withMade(parse(JSONObject(json), secrets = true))
        main.removeCallbacks(relock)
        main.postDelayed(relock, 5 * 60_000L)
    }

    fun clear() { main.removeCallbacks(relock); index = null }

    /** Names, usernames and sites (no secrets), for suggestions while the vault is locked. */
    fun hints(ctx: Context): Index? {
        hintsCache?.let { return it }
        val text = prefs(ctx).getString("hints", null) ?: return null
        return runCatching { parse(JSONObject(text), secrets = false) }.getOrNull()?.also { hintsCache = it }
    }

    private fun remember(ctx: Context, json: String) {
        val o = JSONObject(json)
        val hints = JSONObject().put("rules", o.optJSONObject("rules") ?: JSONObject())
            .put("logins", JSONArray((o.optJSONArray("logins")?.objects() ?: emptyList()).map { l ->
                JSONObject().put("id", l.getString("id")).put("name", l.optString("name")).put("username", l.optString("username")).put("email", l.optString("email"))
                    .put("hosts", l.optJSONArray("hosts") ?: JSONArray()).put("words", l.optJSONArray("words") ?: JSONArray()).put("hasOtp", l.has("otp"))
            }))
            .put("codes", JSONArray((o.optJSONArray("codes")?.objects() ?: emptyList()).map { c ->
                JSONObject().put("id", c.getString("id")).put("issuer", c.optString("issuer")).put("account", c.optString("account")).put("words", c.optJSONArray("words") ?: JSONArray())
            }))
        prefs(ctx).edit().putString("hints", hints.toString()).apply()
        hintsCache = parse(hints, secrets = false)
        runCatching { SealedIndex.seal(ctx, json) }
    }

    /** Signed out of Vault on this phone: nothing is kept for autofill any more. */
    fun forget(ctx: Context) {
        clear()
        hintsCache = null
        prefs(ctx).edit().clear().apply()
        SealedIndex.clear(ctx)
    }

    private fun parse(o: JSONObject, secrets: Boolean): Index {
        val rules = o.optJSONObject("rules")
        val multi = rules?.optJSONArray("multi")?.strings()?.toSet() ?: emptySet()
        val groups = HashMap<String, String>()
        rules?.optJSONArray("groups")?.let { gs -> for (i in 0 until gs.length()) gs.getJSONArray(i).strings().let { g -> g.forEach { groups[it] = g[0] } } }
        val logins = o.optJSONArray("logins")?.objects()?.map {
            val otp = if (secrets) it.optJSONObject("otp")?.toOtp() else null
            Login(it.getString("id"), it.optString("name"), it.optString("username"), it.optString("email"), if (secrets) it.optString("password") else "",
                it.optJSONArray("hosts")?.strings() ?: emptyList(), it.optJSONArray("words")?.strings() ?: emptyList(), otp, otp != null || it.optBoolean("hasOtp"))
        } ?: emptyList()
        val codes = o.optJSONArray("codes")?.objects()?.map {
            Code(it.getString("id"), it.optString("issuer"), it.optString("account"), it.optJSONArray("words")?.strings() ?: emptyList(), if (secrets) it.optJSONObject("otp")?.toOtp() else null)
        } ?: emptyList()
        val passkeys = if (!secrets) emptyList() else o.optJSONArray("passkeys")?.objects()?.map {
            Passkey(it.getString("id"), it.getString("rpId"), it.getString("credentialId"), it.getString("userHandle"),
                it.optString("username"), it.optString("displayName"), it.getString("privateKeyPkcs8"))
        } ?: emptyList()
        return Index(logins, codes, multi, groups, passkeys)
    }

    // Passkeys made here but not yet taken in by Vault's window stay usable.
    private fun withMade(i: Index): Index {
        val waiting = synchronized(madePasskeys) { madePasskeys.map { it.toPasskey("new") } }
        return Index(i.logins, i.codes, i.multi, i.groups, i.passkeys + waiting.filter { w -> i.passkeys.none { it.credentialId == w.credentialId } })
    }

    fun addSave(s: Save) = synchronized(saves) { saves.add(s) }

    /** A passkey made by Android's credential manager: usable at once, kept in the vault by the window. */
    fun addPasskey(item: JSONObject) {
        synchronized(madePasskeys) { madePasskeys.add(item) }
        index?.let { i -> index = Index(i.logins, i.codes, i.multi, i.groups, i.passkeys + item.toPasskey("new")) }
    }
    fun takePasskeys(): String = synchronized(madePasskeys) { JSONArray(madePasskeys).toString().also { madePasskeys.clear() } }
    private fun JSONObject.toPasskey(id: String) = Passkey(id, getString("rpId"), getString("credentialId"), getString("userHandle"), optString("username"), optString("displayName"), getString("privateKeyPkcs8"))

    fun takeSaves(): String = synchronized(saves) {
        val a = JSONArray()
        saves.forEach { a.put(JSONObject().put("url", it.url).put("app", it.app).put("username", it.username).put("password", it.password)) }
        saves.clear()
        a.toString()
    }

    // ---------------------------------------------------------------- matching
    private val skipWords = setOf("com", "org", "net", "io", "app", "apps", "android", "mobile", "client", "www", "co", "uk", "de", "dev", "main", "release", "prod", "lite")
    private fun word(s: String) = s.lowercase().replace(Regex("[^a-z0-9]"), "")
    fun packageWords(pkg: String) = pkg.lowercase().split(".").map(::word).filter { it.length > 2 && it !in skipWords }

    private fun Index.registrable(host: String): String {
        val h = host.lowercase().trimEnd('.').removePrefix("www.")
        if (!h.contains('.') || Regex("^\\d+(\\.\\d+){3}$").matches(h)) return h
        val parts = h.split(".")
        val last2 = parts.takeLast(2).joinToString(".")
        return if (parts.size > 2 && last2 in multi) parts.takeLast(3).joinToString(".") else last2
    }
    private fun Index.siteKey(host: String) = registrable(host).let { groups[it] ?: it }

    /** The logins for a web page (by its domain) or an app (by its package), best first. */
    fun Index.loginsFor(domain: String?, pkg: String): List<Login> {
        if (!domain.isNullOrBlank()) {
            val key = siteKey(domain)
            val host = domain.lowercase().removePrefix("www.")
            return logins.filter { l -> l.hosts.any { siteKey(it) == key } }.sortedByDescending { l -> l.hosts.contains(host) }
        }
        val words = packageWords(pkg)
        return logins.filter { l -> l.hosts.contains(pkg.lowercase()) || l.words.any { it in words } }
    }

    /** One-time codes: those of the matching logins first, then 2FA entries named after the site or app. */
    fun Index.codesFor(domain: String?, pkg: String, matched: List<Login>): List<CodeHit> {
        val out = LinkedHashMap<String, CodeHit>()
        matched.filter { it.hasOtp }.forEach { l -> out["login:${l.id}"] = CodeHit("login:${l.id}", l.who, l.otp) }
        val words = if (!domain.isNullOrBlank()) listOf(word(siteKey(domain).substringBefore('.'))) else packageWords(pkg)
        codes.filter { c -> out.keys.none { it == "login:${c.id}" } && c.words.any { w -> words.any { it == w || (it.length > 3 && w.contains(it)) } } }
            .forEach { c -> out.putIfAbsent("code:${c.id}", CodeHit("code:${c.id}", listOf(c.issuer, c.account).filter { it.isNotBlank() }.joinToString(" · "), c.otp)) }
        // A login's own code also appears among the codes (with the login's id): once is enough.
        return out.values.distinctBy { it.otp?.secret ?: it.ref }
    }

    /** A code by its reference, from the full list. */
    fun Index.otpOf(ref: String): Otp? = when {
        ref.startsWith("login:") -> logins.firstOrNull { it.id == ref.removePrefix("login:") }?.otp
        else -> codes.firstOrNull { it.id == ref.removePrefix("code:") }?.otp
    }

    private fun JSONArray.strings() = (0 until length()).map { getString(it) }
    private fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }
    private fun JSONObject.toOtp() = Otp(getString("secret"), optInt("digits", 6), optInt("period", 30), optString("algorithm", "SHA1"))
}

/** RFC 6238 codes, the same as @marobotic/otp. */
object Totp {
    private const val B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

    private fun base32(text: String): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        var bits = 0
        var value = 0
        for (ch in text.uppercase()) {
            val i = B32.indexOf(ch)
            if (i < 0) continue
            value = (value shl 5) or i
            bits += 5
            if (bits >= 8) { out.write((value ushr (bits - 8)) and 255); bits -= 8 }
        }
        return out.toByteArray()
    }

    /** The code now; one with under 3 seconds left is swapped for the next. */
    fun code(o: AutofillStore.Otp, now: Long = System.currentTimeMillis()): String {
        var t = now / 1000
        if (o.period - (t % o.period) < 3) t += o.period
        val counter = t / o.period
        val alg = when (o.algorithm.uppercase()) { "SHA256" -> "HmacSHA256"; "SHA512" -> "HmacSHA512"; else -> "HmacSHA1" }
        val mac = Mac.getInstance(alg).apply { init(SecretKeySpec(base32(o.secret), alg)) }
        val msg = ByteArray(8) { i -> (counter ushr (56 - 8 * i)).toByte() }
        val h = mac.doFinal(msg)
        val off = h[h.size - 1].toInt() and 0x0f
        val bin = ((h[off].toInt() and 0x7f) shl 24) or ((h[off + 1].toInt() and 0xff) shl 16) or ((h[off + 2].toInt() and 0xff) shl 8) or (h[off + 3].toInt() and 0xff)
        var mod = 1
        repeat(o.digits) { mod *= 10 }
        return (bin % mod).toString().padStart(o.digits, '0')
    }
}
