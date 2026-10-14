package dev.marobotic.vault

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * Vault's own list under a sign-in field, for apps where Android's autofill list can't stay up.
 *
 * React Native apps (Discord, among others) drop the field's focus for a moment when the keyboard opens;
 * Android then hides the autofill list and doesn't show it again on that screen. With this turned on
 * (Settings > "Fill in apps like Discord"), Vault draws the same list itself, under the field: locked,
 * one "Unlock Vault" row (fingerprint or screen lock); unlocked, the app's logins with the email big,
 * and 2FA codes in a code field. Picking one types it in. It serves every app, and 2FA codes in browsers;
 * browser logins stay with Android's list (see wanted).
 *
 * It reads only the sign-in fields of the app in front, never their values except to narrow the list.
 */
class VaultAccessibilityService : AccessibilityService() {
    private val main = Handler(Looper.getMainLooper())
    private var overlay: View? = null
    private var field: AccessibilityNodeInfo? = null
    private var fieldKey = ""
    /** A field picked from just now: the list stays away until another field or screen. */
    private var doneWith = ""
    private var pending: Runnable? = null
    /** What the list shows now (titles), so a fresh look at the same field moves it instead of redrawing. */
    private var showing = ""

    override fun onServiceConnected() { instance = this }
    override fun onUnbind(intent: Intent?): Boolean { hide(); instance = null; return super.onUnbind(intent) }
    override fun onInterrupt() = hide()
    override fun onDestroy() { hide(); instance = null; super.onDestroy() }

    override fun onAccessibilityEvent(e: AccessibilityEvent) {
        val pkg = e.packageName?.toString() ?: return
        if (pkg == packageName || pkg == "com.android.systemui") return
        when (e.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                if (!isImePackage(pkg)) doneWith = ""
                later(120) { refresh() }
            }
            AccessibilityEvent.TYPE_VIEW_FOCUSED, AccessibilityEvent.TYPE_VIEW_CLICKED -> {
                val n = e.source ?: return
                // Focus left the field: wait a moment, as React Native apps hand it straight back.
                if (!n.isEditable) return later(200) { refresh() }
                val key = keyOf(n)
                if (e.eventType == AccessibilityEvent.TYPE_VIEW_CLICKED || key != fieldKey) { if (key == doneWith) doneWith = "" }
                pending?.let { main.removeCallbacks(it); pending = null }
                consider(n)   // at once: the list is there when the field is
            }
            AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED -> {
                val n = e.source ?: return
                if (keyOf(n) == fieldKey) later(60) { consider(n) }
            }
            // The keyboard opened or closed: the list moves to fit.
            AccessibilityEvent.TYPE_WINDOWS_CHANGED -> if (overlay != null) later(60) { field?.let { consider(it) } }
        }
    }

    /** Debounced, so a field that loses and regains focus at once (React Native) keeps its list. */
    private fun later(ms: Long, run: () -> Unit) {
        pending?.let { main.removeCallbacks(it) }
        pending = Runnable { pending = null; run() }.also { main.postDelayed(it, ms) }
    }

    /** What has input focus now, in the app in front. */
    private fun refresh() {
        val n = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (n == null || !n.isEditable) hide() else consider(n)
    }

    /** A field, the same while the screen shifts for the keyboard or its password is shown. */
    private fun keyOf(n: AccessibilityNodeInfo) =
        "${n.packageName}|${n.windowId}|${n.viewIdResourceName}|${Form.isPasswordLike(n)}|${if (Build.VERSION.SDK_INT >= 26) n.hintText else ""}"

    private fun consider(node: AccessibilityNodeInfo) {
        if (!node.refresh() || !node.isFocused || !node.isEditable) return hide()
        val pkg = node.packageName?.toString() ?: return hide()
        val key = keyOf(node)
        if (key == doneWith) return hide()
        val form = Form.of(node) ?: return hide()
        val browser = isBrowser(pkg)
        // In a browser, the site is what its address bar shows (the page can't write there).
        val site = if (browser) siteIn(node) ?: return hide() else null
        if (!wanted(form, browser)) return hide()
        val rows = rowsFor(form, pkg, site)
        android.util.Log.i("VaultOverlay", "field in $pkg site=$site otp=${form.otp} user=${form.user != null} pw=${form.password != null} rows=${rows.size}")
        if (rows.isEmpty()) return hide()
        field = node; fieldKey = key
        show(node, rows, rows.joinToString("\n") { it.title + it.sub })
    }

    /**
     * Who shows the list, so there is only ever one. In apps, this list does (Android's comes and goes
     * there: Discord drops it when the keyboard opens and never asks on its code screen). In browsers,
     * Android's list keeps the logins (the browser tells it the site), and this one the 2FA codes: a code
     * box focused when the page loads only gets Android's list after a tap elsewhere. The autofill
     * service leaves out whatever is this list's (VaultAutofillService.onFillRequest).
     */
    private fun wanted(f: Form, browser: Boolean): Boolean = f.otp || !browser

    /** The site a browser shows: its address bar ("discord.com/login" or a full address). */
    private fun siteIn(n: AccessibilityNodeInfo): String? {
        val root = n.window?.root ?: rootInActiveWindow ?: return null
        val pkg = n.packageName ?: return null
        val bar = listOf("url_bar", "mozac_browser_toolbar_url_view", "url_field", "location_bar_edit_text")
            .firstNotNullOfOrNull { id -> root.findAccessibilityNodeInfosByViewId("$pkg:id/$id").firstOrNull() } ?: return null
        val text = bar.text?.toString()?.trim()?.takeIf { it.isNotEmpty() && !it.contains(' ') } ?: return null
        return text.substringAfter("://").substringBefore('/').substringBefore(':').lowercase().takeIf { it.contains('.') }
    }

    private fun isBrowser(pkg: String): Boolean = browsers.getOrPut(pkg) {
        val i = Intent(Intent.ACTION_VIEW, android.net.Uri.parse("https://example.com")).setPackage(pkg)
        packageManager.queryIntentActivities(i, 0).isNotEmpty()
    }
    private val browsers = HashMap<String, Boolean>()

    private fun isImePackage(pkg: String) =
        Settings.Secure.getString(contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)?.startsWith("$pkg/") == true

    // ---------------------------------------------------------------- the sign-in form around a field
    private class Form(val focused: AccessibilityNodeInfo, val user: AccessibilityNodeInfo?, val password: AccessibilityNodeInfo?, val otp: Boolean, val emailField: Boolean) {
        val focusIsUser get() = user != null && focused == user
        companion object {
            private val otpWords = Regex("otp|2fa|mfa|one.?time|verification|verify|security.?code|auth\\w*.?code|passcode|\\bcode\\b|6.?digit", RegexOption.IGNORE_CASE)
            private val userWords = Regex("user|e-?mail|login|account|phone|identifier|sign.?in", RegexOption.IGNORE_CASE)
            private val emailWords = Regex("e-?mail", RegexOption.IGNORE_CASE)
            private val passwordWords = Regex("password|passwort|mot de passe|contrase|passcode", RegexOption.IGNORE_CASE)

            /** A password box, also while the eye shows what's typed (it's plain text then). */
            fun isPasswordLike(n: AccessibilityNodeInfo, before: String = ""): Boolean {
                if (n.isPassword) return true
                val v = n.inputType and InputType.TYPE_MASK_VARIATION
                if ((n.inputType and InputType.TYPE_MASK_CLASS) == InputType.TYPE_CLASS_TEXT &&
                    (v == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD || v == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD || v == InputType.TYPE_TEXT_VARIATION_PASSWORD)) return true
                return passwordWords.containsMatchIn(words(n) + " " + before)
            }

            private fun words(n: AccessibilityNodeInfo) = listOfNotNull(
                n.viewIdResourceName, n.contentDescription, if (Build.VERSION.SDK_INT >= 26) n.hintText else null,
                n.text?.takeIf { !n.isPassword && n.isShowingHint() }, labelOf(n)).joinToString(" ")

            private fun AccessibilityNodeInfo.isShowingHint() = Build.VERSION.SDK_INT >= 26 && isShowingHintText

            /** The text just above a field ("Email or Phone Number"), as React Native apps label them. */
            private fun labelOf(n: AccessibilityNodeInfo): String? = n.labeledBy?.text?.toString()

            private fun isEmailInput(n: AccessibilityNodeInfo): Boolean {
                val v = n.inputType and InputType.TYPE_MASK_VARIATION
                return (n.inputType and InputType.TYPE_MASK_CLASS) == InputType.TYPE_CLASS_TEXT &&
                    (v == InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS || v == InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS)
            }

            fun of(focused: AccessibilityNodeInfo): Form? {
                // Only the part of the screen around the field (each node is a call into the app, and a
                // whole Discord screen is hundreds): a few levels up holds the sign-in form.
                var top = focused
                for (i in 0 until 6) top = top.parent ?: break
                val edits = mutableListOf<AccessibilityNodeInfo>()
                val texts = HashMap<AccessibilityNodeInfo, String>()   // each field with the text just before it
                var lastText = ""
                var seen = 0
                fun walk(n: AccessibilityNodeInfo, depth: Int) {
                    if (depth > 14 || edits.size > 8 || ++seen > 160) return
                    if (n.isEditable && n.isVisibleToUser) { edits.add(n); texts[n] = lastText }
                    else n.text?.toString()?.takeIf { it.isNotBlank() && it.length < 60 }?.let { lastText = it }
                    for (i in 0 until n.childCount) n.getChild(i)?.let { walk(it, depth + 1) }
                }
                walk(top, 0)
                if (edits.none { it == focused }) { edits.add(focused) }
                val all = { n: AccessibilityNodeInfo -> words(n) + " " + (texts[n] ?: "") }
                val password = edits.firstOrNull { isPasswordLike(it, texts[it] ?: "") }
                val me = edits.firstOrNull { it == focused } ?: focused
                val number = (me.inputType and InputType.TYPE_MASK_CLASS) == InputType.TYPE_CLASS_NUMBER
                val otp = me != password && password == null && (otpWords.containsMatchIn(all(me)) || (number && edits.size == 1))
                val user = when {
                    password != null -> edits.takeWhile { it != password }.lastOrNull()
                    !otp && (isEmailInput(me) || userWords.containsMatchIn(all(me))) -> me   // a name-only first step
                    else -> null
                }
                if (password == null && user == null && !otp) return null
                if (!otp && me != user && me != password) return null
                val emailField = user != null && (isEmailInput(user) || emailWords.containsMatchIn(all(user)))
                return Form(me, user, password, otp, emailField)
            }
        }
    }

    // ---------------------------------------------------------------- what the list offers
    private class Row(val title: String, val sub: String, val pick: () -> Unit)

    private fun rowsFor(f: Form, pkg: String, site: String?): List<Row> = with(AutofillStore) {
        val open = index
        if (open == null) {
            val hints = hints(this@VaultAccessibilityService) ?: return emptyList()
            val logins = hints.loginsFor(site, pkg)
            val any = if (f.otp) hints.codesFor(site, pkg, logins).isNotEmpty() else logins.isNotEmpty()
            return if (any) listOf(Row("Unlock Vault", if (f.otp) "Fingerprint or screen lock, then pick the code" else "Fingerprint or screen lock, then pick a login") { unlock() }) else emptyList()
        }
        var logins = open.loginsFor(site, pkg)
        if (f.otp) return open.codesFor(site, pkg, logins).take(10).mapNotNull { c ->
            val otp = c.otp ?: return@mapNotNull null
            val code = Totp.code(otp)
            Row(code.chunked(3).joinToString(" "), "2FA · ${c.who}") { setText(f.focused, Totp.code(otp)); done() }
        }
        // Narrow as you type in the name field; with a name already typed, the password field offers that account.
        val typedUser = f.user?.takeIf { !it.isShowingHintSafe() }?.text?.toString()?.trim()?.lowercase().orEmpty()
        if (typedUser.isNotEmpty()) {
            val exact = logins.filter { it.username.lowercase() == typedUser || it.email.lowercase() == typedUser }
            logins = if (f.focusIsUser) {
                if (exact.isNotEmpty()) return emptyList()   // already the full name: nothing left to suggest
                logins.filter { "${it.email} ${it.username}".lowercase().contains(typedUser) || it.name.lowercase().startsWith(typedUser) }
            } else exact.ifEmpty { logins.filter { it.username.lowercase().startsWith(typedUser) || it.email.lowercase().startsWith(typedUser) } }
        }
        logins.take(30).map { l ->
            val sub = listOfNotNull(l.username.takeIf { it.isNotBlank() && l.email.isNotBlank() }, l.name).joinToString(" · ")
            Row(l.who, sub) { fill(f, l) }
        }
    }

    private fun AccessibilityNodeInfo.isShowingHintSafe() = Build.VERSION.SDK_INT >= 26 && isShowingHintText

    private fun fill(f: Form, l: AutofillStore.Login) {
        val name = l.signInName(f.emailField)
        f.user?.let { if (name.isNotEmpty()) setText(it, name) }
        f.password?.let { setText(it, l.password) }
        l.otp?.let { copyCode(this, it) }
        done()
    }

    private fun setText(n: AccessibilityNodeInfo, value: String) {
        n.refresh()
        n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
        })
    }

    private fun done() { doneWith = fieldKey; hide() }

    private fun unlock() {
        hide()
        startActivity(Intent(this, AutofillAuthActivity::class.java).putExtra("kind", AutofillAuthActivity.OVERLAY)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION))
    }

    /** Back from the fingerprint: the app's field is in front again, with the real list. */
    fun unlocked() = main.postDelayed({ refresh() }, 350)

    // ---------------------------------------------------------------- the list itself
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun show(anchor: AccessibilityNodeInfo, rows: List<Row>, what: String) {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val box = Rect().also(anchor::getBoundsInScreen)
        val screen = resources.displayMetrics
        // The keyboard's top: the list fits between the field and it, or goes above the field.
        val keyboardTop = windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }
            ?.let { Rect().also(it::getBoundsInScreen).top } ?: screen.heightPixels
        val rowH = dp(58)
        val wantH = minOf(rows.size, 3) * rowH + (if (rows.size > 3) rowH / 2 else 0)
        val below = keyboardTop - box.bottom - dp(8)
        val above = box.top - dp(8) - dp(24)
        val (y, h) = when {
            below >= minOf(wantH, rowH * 2) || below >= above -> box.bottom + dp(4) to minOf(wantH, below)
            else -> box.top - dp(4) - minOf(wantH, above) to minOf(wantH, above)
        }
        if (h < rowH / 2) return hide()
        val width = maxOf(box.width(), dp(260)).coerceAtMost(screen.widthPixels - dp(16))
        val x = box.left.coerceIn(dp(8), maxOf(dp(8), screen.widthPixels - width - dp(8)))
        overlay?.let { v ->
            if (what == showing) {   // the same list: just follow the field
                val p = v.layoutParams as WindowManager.LayoutParams
                if (p.x != x || p.y != y || p.height != h || p.width != width) {
                    p.x = x; p.y = y; p.height = h; p.width = width
                    try { wm.updateViewLayout(v, p) } catch (_: Exception) {}
                }
                return
            }
        }
        hide()

        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val inflater = LayoutInflater.from(this)
        rows.forEachIndexed { i, r ->
            val v = inflater.inflate(R.layout.autofill_item, list, false)
            v.findViewById<TextView>(R.id.af_title).text = r.title
            v.findViewById<TextView>(R.id.af_sub).text = r.sub
            v.background = null
            v.setOnClickListener { r.pick() }
            if (i > 0) list.addView(View(this).apply { setBackgroundColor(0xFF2A2A2A.toInt()) }, LinearLayout.LayoutParams(-1, 1))
            list.addView(v)
        }
        val scroll = ScrollView(this).apply {
            addView(list)
            isVerticalScrollBarEnabled = rows.size > 3
            background = GradientDrawable().apply { setColor(0xFF1C1C1C.toInt()); cornerRadius = dp(10).toFloat(); setStroke(1, 0xFF333333.toInt()) }
            clipToOutline = true
            elevation = dp(6).toFloat()
            // A tap outside (the app, the keyboard) closes it, so it never sits on the next field; tapping the field brings it back.
            setOnTouchListener { _, ev -> if (ev.action == MotionEvent.ACTION_OUTSIDE) { hide(); true } else false }
        }
        val p = WindowManager.LayoutParams(width, h,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT).apply {
            gravity = Gravity.TOP or Gravity.START
            this.x = x
            this.y = y
        }
        try { wm.addView(scroll, p); overlay = scroll; showing = what } catch (_: Exception) { overlay = null }
    }

    private fun hide() {
        overlay?.let { v -> try { (getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(v) } catch (_: Exception) {} }
        overlay = null
        showing = ""
    }

    companion object {
        @Volatile var instance: VaultAccessibilityService? = null
            private set

        /** Whether this list is turned on (Android's Accessibility settings). */
        fun enabled(ctx: Context): Boolean {
            val me = "${ctx.packageName}/${VaultAccessibilityService::class.java.name}"
            val on = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
            return on.split(':').any { it.equals(me, true) || it.equals("${ctx.packageName}/.VaultAccessibilityService", true) }
        }

        /** The login's 2FA code to the clipboard (marked sensitive), for the sign-in step that asks for it. */
        fun copyCode(ctx: Context, otp: AutofillStore.Otp) {
            val clip = android.content.ClipData.newPlainText("2FA code", Totp.code(otp))
            if (Build.VERSION.SDK_INT >= 33) clip.description.extras = android.os.PersistableBundle().apply { putBoolean(android.content.ClipDescription.EXTRA_IS_SENSITIVE, true) }
            ctx.getSystemService(android.content.ClipboardManager::class.java)?.setPrimaryClip(clip)
            android.widget.Toast.makeText(ctx.applicationContext, "Vault: 2FA code copied", android.widget.Toast.LENGTH_SHORT).show()
        }
    }
}
