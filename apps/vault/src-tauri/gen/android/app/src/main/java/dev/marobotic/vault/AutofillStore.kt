package dev.marobotic.vault

import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * What Android autofill may offer, handed over by Vault's window while the vault is open. It lives in
 * memory only: when Vault locks, or Android ends the app, it is gone and autofill asks to unlock.
 * Matching follows the same rules as the browser extension (the tables come from domains.ts).
 */
object AutofillStore {
    class Otp(val secret: String, val digits: Int, val period: Int, val algorithm: String)
    class Login(val id: String, val name: String, val username: String, val password: String, val hosts: List<String>, val words: List<String>, val otp: Otp?)
    class Code(val id: String, val issuer: String, val account: String, val words: List<String>, val otp: Otp)
    class Index(val logins: List<Login>, val codes: List<Code>, val multi: Set<String>, val groups: Map<String, String>)
    class Save(val url: String, val app: String, val username: String, val password: String)

    @Volatile var index: Index? = null
        private set
    @Volatile var pendingLink: String? = null
    private val saves = mutableListOf<Save>()
    val onUnlock = CopyOnWriteArrayList<() -> Unit>()

    fun set(json: String) {
        val o = JSONObject(json)
        val rules = o.optJSONObject("rules")
        val multi = rules?.optJSONArray("multi")?.strings()?.toSet() ?: emptySet()
        val groups = HashMap<String, String>()
        rules?.optJSONArray("groups")?.let { gs -> for (i in 0 until gs.length()) gs.getJSONArray(i).strings().let { g -> g.forEach { groups[it] = g[0] } } }
        val logins = o.optJSONArray("logins")?.objects()?.map {
            Login(it.getString("id"), it.optString("name"), it.optString("username"), it.optString("password"),
                it.optJSONArray("hosts")?.strings() ?: emptyList(), it.optJSONArray("words")?.strings() ?: emptyList(), it.optJSONObject("otp")?.toOtp())
        } ?: emptyList()
        val codes = o.optJSONArray("codes")?.objects()?.mapNotNull {
            val otp = it.optJSONObject("otp")?.toOtp() ?: return@mapNotNull null
            Code(it.getString("id"), it.optString("issuer"), it.optString("account"), it.optJSONArray("words")?.strings() ?: emptyList(), otp)
        } ?: emptyList()
        val wasLocked = index == null
        index = Index(logins, codes, multi, groups)
        if (wasLocked) onUnlock.forEach { it() }
    }

    fun clear() { index = null }

    fun addSave(s: Save) = synchronized(saves) { saves.add(s) }

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

    /** 2FA codes: those of the matching logins first, then codes named after the site or app. */
    fun Index.codesFor(domain: String?, pkg: String, matched: List<Login>): List<Pair<String, Otp>> {
        val out = LinkedHashMap<String, Pair<String, Otp>>()
        matched.forEach { l -> l.otp?.let { out[it.secret] = Pair(l.username.ifBlank { l.name }, it) } }
        val words = if (!domain.isNullOrBlank()) listOf(word(siteKey(domain).substringBefore('.'))) else packageWords(pkg)
        codes.filter { c -> c.words.any { w -> words.any { it == w || (it.length > 3 && w.contains(it)) } } }
            .forEach { c -> out.putIfAbsent(c.otp.secret, Pair(listOf(c.issuer, c.account).filter { it.isNotBlank() }.joinToString(" · "), c.otp)) }
        return out.values.toList()
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
