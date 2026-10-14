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
    val pkg: String = structure.activityComponent.packageName
    var usernameValue = ""
    var passwordValue = ""
    private var lastText: AssistStructure.ViewNode? = null
    private var passwordIsCurrent = false
    val own = pkg == ownPackage

    init {
        for (i in 0 until structure.windowNodeCount) visit(structure.getWindowNodeAt(i).rootViewNode)
        // Two password boxes and the first isn't "current password": a sign-up form, both are new.
        if (newPasswords.isNotEmpty() && !passwordIsCurrent) password?.let { newPasswords.add(0, it); password = null }
    }

    val any get() = username != null || password != null || newPasswords.isNotEmpty() || otp != null
    val ids get() = listOfNotNull(username, password, otp).plus(newPasswords).distinct()

    private fun visit(n: AssistStructure.ViewNode) {
        n.webDomain?.takeIf { it.isNotBlank() && webDomain == null }?.let { webDomain = it }
        if (n.autofillId != null && n.autofillType == View.AUTOFILL_TYPE_TEXT && n.visibility == View.VISIBLE) classify(n)
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
                if (username == null) { username = n.autofillId; usernameValue = value }
            }
            else -> lastText = n
        }
    }
}

/** Vault as Android's autofill service: logins, a strong new password and 2FA codes, in apps and browsers. */
@RequiresApi(Build.VERSION_CODES.O)
class VaultAutofillService : AutofillService() {
    override fun onFillRequest(request: FillRequest, cancel: CancellationSignal, callback: FillCallback) {
        val structure = request.fillContexts.lastOrNull()?.structure ?: return callback.onSuccess(null)
        val fields = Fields(structure, packageName)
        if (fields.own || !fields.any) return callback.onSuccess(null)
        callback.onSuccess(respond(this, fields))
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

        @Suppress("DEPRECATION")
        fun respond(ctx: Context, f: Fields): FillResponse? {
            val b = FillResponse.Builder()
            val index = AutofillStore.index
            var any = false
            val loginField = f.password ?: f.username
            if (index == null) {
                // Locked: one entry that opens Vault; once it is unlocked the fields fill by themselves.
                val sender = PendingIntent.getActivity(ctx, 1, Intent(ctx, AutofillAuthActivity::class.java),
                    PendingIntent.FLAG_CANCEL_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)).intentSender
                b.setAuthentication(f.ids.toTypedArray(), sender, row(ctx, "Vault is locked", "Tap to unlock and fill"))
                any = true
            } else with(AutofillStore) {
                val logins = index.loginsFor(f.webDomain, f.pkg)
                if (loginField != null) for (l in logins.take(6)) {
                    val d = Dataset.Builder(row(ctx, l.username.ifBlank { l.name }, "${l.name} · Vault"))
                    f.username?.let { if (l.username.isNotEmpty()) d.setValue(it, AutofillValue.forText(l.username)) }
                    f.password?.let { d.setValue(it, AutofillValue.forText(l.password)) }
                    b.addDataset(d.build()); any = true
                }
                f.otp?.let { otpId ->
                    for ((who, otp) in index.codesFor(f.webDomain, f.pkg, logins).take(4)) {
                        val code = Totp.code(otp)
                        b.addDataset(Dataset.Builder(row(ctx, code.chunked(3).joinToString(" "), "2FA · $who")).setValue(otpId, AutofillValue.forText(code)).build())
                        any = true
                    }
                }
                if (f.newPasswords.isNotEmpty() || (f.password != null && logins.isEmpty())) {
                    val pw = strongPassword()
                    val d = Dataset.Builder(row(ctx, "Use a strong password", pw))
                    (f.newPasswords.ifEmpty { listOfNotNull(f.password) }).forEach { d.setValue(it, AutofillValue.forText(pw)) }
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
