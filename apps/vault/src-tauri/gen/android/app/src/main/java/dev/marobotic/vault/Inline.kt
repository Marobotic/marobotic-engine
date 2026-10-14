package dev.marobotic.vault

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.service.autofill.InlinePresentation
import android.view.inputmethod.InlineSuggestionsRequest
import androidx.annotation.RequiresApi
import androidx.autofill.inline.UiVersions
import androidx.autofill.inline.v1.InlineSuggestionUi

/** Suggestions as chips in the keyboard's bar (Android 11+, when the keyboard asks for them). */
@RequiresApi(30)
object Inline {
    fun presentation(ctx: Context, request: Any?, index: Int, title: String, sub: String): InlinePresentation? {
        val req = request as? InlineSuggestionsRequest ?: return null
        val specs = req.inlinePresentationSpecs
        if (index >= req.maxSuggestionCount || specs.isEmpty()) return null
        val spec = specs[minOf(index, specs.size - 1)]
        if (!UiVersions.getVersions(spec.style).contains(UiVersions.INLINE_UI_VERSION_1)) return null
        val attribution = PendingIntent.getActivity(ctx, 0, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val content = InlineSuggestionUi.newContentBuilder(attribution)
            .setTitle(title).setSubtitle(sub).setContentDescription("$title, $sub")
            .setStartIcon(Icon.createWithResource(ctx, R.drawable.ic_vault_chip)).build()
        return InlinePresentation(content.slice, spec, false)
    }
}
