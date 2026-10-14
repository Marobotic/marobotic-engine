package dev.marobotic.vault

import android.app.Activity
import android.app.assist.AssistStructure
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.autofill.AutofillManager
import androidx.annotation.RequiresApi

/**
 * Opened by tapping "Vault is locked" under a sign-in field. It opens Vault to unlock and, as soon as
 * the vault is open, hands the matching logins back to the field while Vault steps out of the way.
 */
@RequiresApi(Build.VERSION_CODES.O)
class AutofillAuthActivity : Activity() {
    private val unlocked: () -> Unit = { runOnUiThread { answer() } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (AutofillStore.index != null) return answer()
        AutofillStore.onUnlock.add(unlocked)
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(MainActivity.FOR_AUTOFILL, true))
    }

    override fun onDestroy() {
        AutofillStore.onUnlock.remove(unlocked)
        super.onDestroy()
    }

    private fun answer() {
        if (isFinishing) return
        @Suppress("DEPRECATION")
        val structure = intent.getParcelableExtra<AssistStructure>(AutofillManager.EXTRA_ASSIST_STRUCTURE)
        val response = structure?.let { VaultAutofillService.respond(this, Fields(it, packageName)) }
        if (response != null) setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, response))
        else setResult(RESULT_CANCELED)
        finish()
    }
}
