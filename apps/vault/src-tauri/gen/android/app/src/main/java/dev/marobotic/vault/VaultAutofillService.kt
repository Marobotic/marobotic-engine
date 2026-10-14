package dev.marobotic.vault

import android.app.PendingIntent
import android.app.assist.AssistStructure
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.Dataset
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.FillResponse
import android.service.autofill.SaveCallback
import android.service.autofill.SaveInfo
import android.service.autofill.SaveRequest
import android.text.InputType
import android.view.View
import android.view.autofill.AutofillId
import android.view.autofill.AutofillValue
import android.widget.RemoteViews
import androidx.annotation.RequiresApi
import java.security.SecureRandom

/** The sign-in fields on a screen, and the site (in a browser) or app they belong to. */
@RequiresApi(Build.VERSION_CODES.O)
class Fields(structure: AssistStructure, ownPackage: String) {
    var username: AutofillId? = null
    var password: AutofillId? = null
    val newPasswords = mutableListOf<AutofillId>()
    var otp: AutofillId? = null
    var webDomain: String? = null
    var focused: AutofillId? = null
    val pkg: String = structure.activityComponent.packageName
    var usernameValue = ""
    /** The sign-in name field asks for an email ("Email or Phone Number", type=email, an email keyboard). */
    var usernameIsEmail = false
    var passwordValue = ""
    private var lastText: AssistStructure.ViewNode? = null
    private var passwordIsCurrent = false
    // Vault's own screens are left alone, except for a self-test: adb shell setprop debug.vault.selftest 1
    val own = pkg == ownPackage && !selfTest()
    /** What was seen, for logcat (tag VaultAutofill): field kinds and hints, never values. */
    val seen = StringBuilder()

    init {
        for (i in 0 until structure.windowNodeCount) visit(structure.getWindowNodeAt(i).rootViewNode)
        // Two password boxes and the first isn't "current password": a sign-up form, both are new.
        if (newPasswords.isNotEmpty() && !passwordIsCurrent) password?.let { newPasswords.add(0, it); password = null }
        // Self-test on Vault's own sign-in page: pretend it's another site (adb shell setprop debug.vault.selftest.site discord.com).
        if (pkg == ownPackage) selfTestSite()?.let { webDomain = it }
    }

    val any get() = username != null || password != null || newPasswords.isNotEmpty() || otp != null
    val ids get() = listOfNotNull(username, password, otp).plus(newPasswords).distinct()

    private fun visit(n: AssistStructure.ViewNode) {
        n.webDomain?.takeIf { it.isNotBlank() && webDomain == null }?.let { webDomain = it }
        if (n.autofillId != null && (n.className?.contains("EditText") == true || n.htmlInfo?.tag.equals("input", true) || n.autofillHints != null))
            seen.append("\n  ${n.className?.substringAfterLast('.')} type=${n.autofillType} vis=${n.visibility} input=0x${Integer.toHexString(n.inputType)} hints=${n.autofillHints?.joinToString()} id=${n.idEntry} hint=${n.hint} html=${n.htmlInfo?.attributes?.joinToString { "${it.first}=${it.second}" }?.take(160)}")
        if (n.autofillId != null && n.autofillType == View.AUTOFILL_TYPE_TEXT && n.visibility == View.VISIBLE) {
            if (n.isFocused) focused = n.autofillId
            classify(n)
        }
        for (i in 0 until n.childCount) visit(n.getChildAt(i))
    }

    private fun classify(n: AssistStructure.ViewNode) {
        val hints = n.autofillHints?.map { it.lowercase() } ?: emptyList()
        val html = n.htmlInfo?.attributes?.associate { it.first.lowercase() to (it.second ?: "").lowercase() } ?: emptyMap()
        if (n.htmlInfo != null && n.htmlInfo!!.tag.lowercase() != "input") return
        val htmlType = html["type"] ?: ""
        if (htmlType in setOf("hidden", "submit", "button", "checkbox", "radio", "search")) return
        val ac = html["autocomplete"] ?: ""
        val words = listOfNotNull(n.idEntry, n.hint?.toString(), html["name"], html["id"], html["placeholder"], html["aria-label"], ac).joinToString(" ").lowercase()
        val cls = n.inputType and InputType.TYPE_MASK_CLASS
        val variation = n.inputType and InputType.TYPE_MASK_VARIATION
        val value = n.autofillValue?.takeIf { it.isText }?.textValue?.toString() ?: ""
        val isPassword = hints.any { "password" in it } || htmlType == "password" ||
            (cls == InputType.TYPE_CLASS_TEXT && variation in setOf(InputType.TYPE_TEXT_VARIATION_PASSWORD, InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD, InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD)) ||
            (cls == InputType.TYPE_CLASS_NUMBER && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD && Regex("pass|pin").containsMatchIn(words))
        val isOtp = hints.any { "otp" in it } || "one-time-code" in ac ||
            (Regex("otp|totp|2fa|mfa|one.?time|verification|verify|security.?code|auth\\w*.?code|passcode|\\bcode\\b").containsMatchIn(words) && !Regex("zip|postal|promo|coupon|country|captcha|gift|referral").containsMatchIn(words))
        when {
            isPassword -> {
                val isNew = hints.any { "newpassword" in it } || "new-password" in ac || Regex("new|confirm|repeat|retype|again|sign.?up|register|create").containsMatchIn(words)
                if (isNew || password != null) newPasswords.add(n.autofillId!!) else password = n.autofillId
                if (!isNew && Regex("current|old").containsMatchIn(words + " " + ac)) passwordIsCurrent = true
                if (value.isNotEmpty()) passwordValue = value
                if (username == null) lastText?.let { username = it.autofillId; usernameValue = it.autofillValue?.textValue?.toString() ?: "" }
            }
            isOtp && otp == null -> otp = n.autofillId
            hints.any { it in setOf("username", "emailaddress", "email", "phone", "phonenumber") } || htmlType == "email" || "username" in ac || ac.startsWith("email") ||
                (cls == InputType.TYPE_CLASS_TEXT && variation in setOf(InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS, InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS)) ||
                Regex("user|e-?mail|login|account|identifier").containsMatchIn(words) -> {
                if (username == null) {
                    username = n.autofillId; usernameValue = value
                    usernameIsEmail = hints.any { "email" in it } || htmlType == "email" || ac.startsWith("email") ||
                        variation in setOf(InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS, InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS) ||
                        Regex("e-?mail").containsMatchIn(words)
                }
            }
            else -> lastText = n
        }
    }
}

private fun selfTestSite(): String? = runCatching {
    (Class.forName("android.os.SystemProperties").getMethod("get", String::class.java).invoke(null, "debug.vault.selftest.site") as String).ifBlank { null }
}.getOrNull()

private fun selfTest(): Boolean = runCatching {
    Class.forName("android.os.SystemProperties").getMethod("get", String::class.java).invoke(null, "debug.vault.selftest") == "1"
}.getOrDefault(false)

/** Vault as Android's autofill service: logins, a strong new password and 2FA codes, in apps and browsers. */
@RequiresApi(Build.VERSION_CODES.O)
class VaultAutofillService : AutofillService() {
    override fun onFillRequest(request: FillRequest, cancel: CancellationSignal, callback: FillCallback) {
        val structure = request.fillContexts.lastOrNull()?.structure ?: return callback.onSuccess(null)
        val fields = Fields(structure, packageName)
        val inline = if (Build.VERSION.SDK_INT >= 30) request.inlineSuggestionsRequest else null
        // With Vault's own list on (VaultAccessibilityService), it shows the suggestions in apps and the
        // codes in browsers; Android's list keeps the rest, and still offers to save new logins.
        val overlay = VaultAccessibilityService.instance != null
        if (overlay) fields.otp = null
        val response = if (fields.own || !fields.any) null else respond(this, fields, inline, listed = !(overlay && fields.webDomain == null))
        android.util.Log.i("VaultAutofill", "fill ${fields.pkg} web=${fields.webDomain} user=${fields.username != null} pw=${fields.password != null} new=${fields.newPasswords.size} otp=${fields.otp != null} " +
            "locked=${AutofillStore.index == null} logins=${(AutofillStore.index ?: AutofillStore.hints(this))?.let { with(AutofillStore) { it.loginsFor(fields.webDomain, fields.pkg).size } }} answered=${response != null} overlay=$overlay inline=${inline != null}${fields.seen}")
        callback.onSuccess(response)
    }

    override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
        // Every screen of the sign-in (name on one page, password on the next) is in fillContexts.
        var user = ""
        var pass = ""
        var domain: String? = null
        var pkg = ""
        for (ctx in request.fillContexts) {
            val f = Fields(ctx.structure, packageName)
            if (f.usernameValue.isNotBlank()) user = f.usernameValue
            if (f.passwordValue.isNotBlank()) pass = f.passwordValue
            domain = f.webDomain ?: domain
            pkg = f.pkg
        }
        if (pass.isBlank()) return callback.onSuccess()
        AutofillStore.addSave(AutofillStore.Save(domain?.let { "https://$it" } ?: "", if (domain == null) pkg else "", user.trim(), pass))
        if (AutofillStore.index == null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // Locked: open Vault, which keeps the login as soon as it is unlocked.
            val open = PendingIntent.getActivity(this, 2, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE)
            callback.onSuccess(open.intentSender)
        } else callback.onSuccess()
    }

    companion object {
        private val random = SecureRandom()

        private fun row(ctx: Context, title: String, sub: String): RemoteViews =
            RemoteViews(ctx.packageName, R.layout.autofill_item).apply {
                setTextViewText(R.id.af_title, title)
                setTextViewText(R.id.af_sub, sub)
            }

        /** The same alphabet as Vault's generator (no look-alikes), with every kind of character. */
        fun strongPassword(length: Int = 20): String {
            val sets = listOf("abcdefghijkmnopqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789", "!@#$%^&*-_=+?")
            val all = sets.joinToString("")
            val chars = sets.map { it[random.nextInt(it.length)] }.toMutableList()
            while (chars.size < length) chars.add(all[random.nextInt(all.length)])
            chars.shuffle(random)
            return chars.joinToString("")
        }

        /** One suggestion, both as a row under the field and (Android 11+) as a chip in the keyboard. */
        private class Chips(val ctx: Context, val inline: Any?) {
            private var n = 0
            fun dataset(title: String, sub: String): Dataset.Builder {
                val menu = row(ctx, title, sub)
                if (Build.VERSION.SDK_INT >= 30) Inline.presentation(ctx, inline, n++, title, sub)?.let {
                    @Suppress("DEPRECATION") return Dataset.Builder(menu).setInlinePresentation(it)
                }
                return Dataset.Builder(menu)
            }
        }

        private val requests = java.util.concurrent.atomic.AtomicInteger(10)

        /** Taps a locked suggestion through AutofillAuthActivity: fingerprint first, then the real values. */
        private fun unlockIntent(ctx: Context, kind: String, ref: String) = PendingIntent.getActivity(ctx, requests.incrementAndGet(),
            Intent(ctx, AutofillAuthActivity::class.java).putExtra("kind", kind).putExtra("ref", ref),
            PendingIntent.FLAG_CANCEL_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)).intentSender

        /** The values of one suggestion, for the fields on this screen (the vault must be open). */
        fun datasetFor(ctx: Context, f: Fields, kind: String, ref: String): Dataset? = with(AutofillStore) {
            val index = index ?: return null
            if (kind == "code") {
                val otp = index.otpOf(ref) ?: return null
                val id = f.otp ?: return null
                return Dataset.Builder(row(ctx, "2FA code", "Vault")).setValue(id, AutofillValue.forText(Totp.code(otp))).build()
            }
            val l = index.logins.firstOrNull { it.id == ref } ?: return null
            val d = Dataset.Builder(row(ctx, l.who, "${l.name} · Vault"))
            var any = false
            val name = l.signInName(f.usernameIsEmail)
            f.username?.let { if (name.isNotEmpty()) { d.setValue(it, AutofillValue.forText(name)); any = true } }
            f.password?.let { d.setValue(it, AutofillValue.forText(l.password)); any = true }
            if (!any) return null
            return d.build()
        }

        /**
         * The suggestions for a screen, following the same rules as the browser extension: the logins for
         * this site or app (Android narrows them as you type); a username already filled in means only
         * that account's password; a strong password only in sign-up fields; the one-time code in a code
         * field. They show while Vault is locked too (from the hints, no secrets): tapping one asks for
         * the fingerprint or screen lock, then fills.
         */
        @Suppress("DEPRECATION")
        fun respond(ctx: Context, f: Fields, inline: Any? = null, listed: Boolean = true): FillResponse? {
            val b = FillResponse.Builder()
            val chips = Chips(ctx, inline)
            var any = false
            val loginField = f.password ?: f.username
            val open = AutofillStore.index
            val hints = if (open == null) AutofillStore.hints(ctx) else null
            val signUpOnly = f.newPasswords.isNotEmpty() && f.password == null && f.otp == null
            // Locked: one "Unlock Vault" entry, only where Vault has something for this screen (the hints,
            // no secrets, tell). The fingerprint or screen lock opens the sealed list, and Android then
            // shows the real suggestions. A sign-up form needs nothing unlocked: its strong password shows at once.
            val list = if (open == null && signUpOnly) hints ?: AutofillStore.Index(emptyList(), emptyList(), emptySet(), emptyMap(), emptyList()) else open
            if (!listed) {
                // Only the offer to save what's typed here.
            } else if (list == null) {
                val worth = hints == null || with(AutofillStore) {
                    hints.loginsFor(f.webDomain, f.pkg).isNotEmpty() || (f.otp != null && hints.codesFor(f.webDomain, f.pkg, hints.loginsFor(f.webDomain, f.pkg)).isNotEmpty())
                }
                if (worth) {
                    val sender = unlockIntent(ctx, "all", "")
                    val title = "Unlock Vault"
                    val sub = "Fingerprint or screen lock, then pick a login"
                    val chip = if (Build.VERSION.SDK_INT >= 30) Inline.presentation(ctx, inline, 0, title, sub) else null
                    if (chip != null && Build.VERSION.SDK_INT >= 30) b.setAuthentication(f.ids.toTypedArray(), sender, row(ctx, title, sub), chip)
                    else b.setAuthentication(f.ids.toTypedArray(), sender, row(ctx, title, sub))
                    any = true
                }
            } else with(AutofillStore) {
                var logins = list.loginsFor(f.webDomain, f.pkg)
                // The password field of a form whose username is already there: that account only.
                val typedUser = f.usernameValue.trim().lowercase()
                if (typedUser.isNotEmpty() && f.focused != null && f.focused != f.username) {
                    val exact = logins.filter { it.username.lowercase() == typedUser || it.email.lowercase() == typedUser }
                    logins = exact.ifEmpty { logins.filter { it.username.lowercase().startsWith(typedUser) || it.email.lowercase().startsWith(typedUser) } }
                }
                if (loginField != null && f.focused != f.otp) for (l in logins.take(30)) {
                    val sub = listOfNotNull(l.username.takeIf { it.isNotBlank() && l.email.isNotBlank() }, l.name).joinToString(" · ")
                    val d = chips.dataset(l.who, if (open != null) "$sub · Vault" else "$sub · Vault (tap to unlock)")
                    val name = l.signInName(f.usernameIsEmail)
                    if (open != null) {
                        f.username?.let { if (name.isNotEmpty()) d.setValue(it, AutofillValue.forText(name)) }
                        f.password?.let { d.setValue(it, AutofillValue.forText(l.password)) }
                        // With a 2FA code: picking it goes through AutofillAuthActivity, which copies the code.
                        if (l.hasOtp) d.setAuthentication(unlockIntent(ctx, "login", l.id))
                    } else {
                        // The username is no secret: it shows (and filters as you type); the rest comes after the unlock.
                        f.username?.let { d.setValue(it, if (name.isNotEmpty()) AutofillValue.forText(name) else null) }
                        f.password?.let { d.setValue(it, null) }
                        d.setAuthentication(unlockIntent(ctx, "login", l.id))
                    }
                    b.addDataset(d.build()); any = true
                }
                f.otp?.let { otpId ->
                    for (c in list.codesFor(f.webDomain, f.pkg, logins).take(10)) {
                        val otp = c.otp
                        val d = if (open != null && otp != null) {
                            val code = Totp.code(otp)
                            chips.dataset(code.chunked(3).joinToString(" "), "2FA · ${c.who}").setValue(otpId, AutofillValue.forText(code))
                        } else chips.dataset("2FA code", "${c.who} · tap to unlock").setValue(otpId, null).setAuthentication(unlockIntent(ctx, "code", c.ref))
                        b.addDataset(d.build()); any = true
                    }
                }
                if (f.newPasswords.isNotEmpty()) {
                    val pw = strongPassword()
                    val d = chips.dataset("Use a strong password", pw)
                    f.newPasswords.forEach { d.setValue(it, AutofillValue.forText(pw)) }
                    b.addDataset(d.build()); any = true
                }
            }
            val saveIds = (f.newPasswords.ifEmpty { listOfNotNull(f.password) })
            if (saveIds.isNotEmpty()) {
                val save = SaveInfo.Builder(SaveInfo.SAVE_DATA_TYPE_PASSWORD or (if (f.username != null) SaveInfo.SAVE_DATA_TYPE_USERNAME else 0), saveIds.toTypedArray())
                f.username?.let { save.setOptionalIds(arrayOf(it)) }
                save.setFlags(SaveInfo.FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE)
                b.setSaveInfo(save.build()); any = true
            }
            return if (any) b.build() else null
        }
    }
}
