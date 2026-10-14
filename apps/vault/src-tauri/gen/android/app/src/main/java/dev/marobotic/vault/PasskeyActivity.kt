package dev.marobotic.vault

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import androidx.annotation.RequiresApi
import androidx.credentials.CreatePasswordRequest
import androidx.credentials.CreatePasswordResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPasswordOption
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PasswordCredential
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.provider.CallingAppInfo
import androidx.credentials.provider.PendingIntentHandler
import org.json.JSONObject

/**
 * Opened from the system's passkey sheet after you pick Vault. When Vault is locked it opens Vault to
 * unlock first. Then it makes the passkey (or signs in with one, or hands over a password), checking
 * that the asking page or app really belongs to the site: a browser on Google's list of browsers says
 * which page is asking; any other app must be named by the site's assetlinks.json.
 */
@RequiresApi(34)
class PasskeyActivity : Activity() {
    private val unlocked: () -> Unit = { runOnUiThread { go() } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (AutofillStore.index != null) return go()
        AutofillStore.onUnlock.add(unlocked)
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(MainActivity.FOR_AUTOFILL, true))
    }

    override fun onDestroy() {
        AutofillStore.onUnlock.remove(unlocked)
        super.onDestroy()
    }

    private fun done(result: Intent?) {
        if (isFinishing) return
        setResult(if (result != null) RESULT_OK else RESULT_CANCELED, result)
        finish()
    }

    /** Where the request comes from: the page's origin for a trusted browser, else the app's own origin. */
    private fun originOf(app: CallingAppInfo, rpId: String): String? {
        val list = resources.openRawResource(R.raw.privileged_browsers).bufferedReader().readText()
        val browser = try { app.getOrigin(list) } catch (_: Exception) { null }
        if (browser != null) return browser.trimEnd('/').takeIf { Passkeys.rpAllowed(it, rpId) }
        val cert = app.signingInfo.apkContentsSigners.firstOrNull()?.toByteArray() ?: return null
        val fp = Passkeys.sha256(cert)
        return if (Passkeys.appAllowed(rpId, app.packageName, fp)) "android:apk-key-hash:${Passkeys.b64(fp)}" else null
    }

    private fun go() {
        val kind = intent.getStringExtra("kind") ?: ""
        if (kind == "unlock") {
            // The sheet asked Vault to unlock: answer with the entries it can offer now.
            val begin = PendingIntentHandler.retrieveBeginGetCredentialRequest(intent) ?: return done(null)
            val out = Intent()
            PendingIntentHandler.setBeginGetCredentialResponse(out, VaultCredentialService.entries(this, begin))
            return done(out)
        }
        // Checking a site's assetlinks.json goes to the network: off the main thread.
        Thread {
            val out = Intent()
            try {
                when (kind) {
                    "createPasskey", "createPassword" -> create(out)
                    else -> get(kind, out)
                }
                runOnUiThread { done(out) }
            } catch (e: Exception) {
                if (kind.startsWith("create")) PendingIntentHandler.setCreateCredentialException(out, CreateCredentialUnknownException(e.message))
                else PendingIntentHandler.setGetCredentialException(out, GetCredentialUnknownException(e.message))
                runOnUiThread { done(out) }
            }
        }.start()
    }

    private fun create(out: Intent) {
        val req = PendingIntentHandler.retrieveProviderCreateCredentialRequest(intent) ?: error("no request")
        when (val r = req.callingRequest) {
            is CreatePublicKeyCredentialRequest -> {
                val rpId = JSONObject(r.requestJson).getJSONObject("rp").optString("id")
                val origin = originOf(req.callingAppInfo, rpId) ?: error("This app or page isn't allowed to make passkeys for $rpId")
                val made = Passkeys.create(r.requestJson, origin, r.clientDataHash)
                AutofillStore.addPasskey(made.item)
                PendingIntentHandler.setCreateCredentialResponse(out, CreatePublicKeyCredentialResponse(made.response))
            }
            is CreatePasswordRequest -> {
                AutofillStore.addSave(AutofillStore.Save("", req.callingAppInfo.packageName, r.id, r.password))
                PendingIntentHandler.setCreateCredentialResponse(out, CreatePasswordResponse())
            }
            else -> error("Vault can't save this")
        }
    }

    private fun get(kind: String, out: Intent) {
        val req = PendingIntentHandler.retrieveProviderGetCredentialRequest(intent) ?: error("no request")
        val id = intent.getStringExtra("id") ?: ""
        val index = AutofillStore.index ?: error("Vault is locked")
        if (kind == "getPassword") {
            val l = index.logins.firstOrNull { it.id == id } ?: error("not found")
            req.credentialOptions.firstOrNull { it is GetPasswordOption } ?: error("no password asked")
            PendingIntentHandler.setGetCredentialResponse(out, GetCredentialResponse(PasswordCredential(l.email.ifBlank { l.username }, l.password)))
            return
        }
        val option = req.credentialOptions.filterIsInstance<GetPublicKeyCredentialOption>().firstOrNull() ?: error("no passkey asked")
        val p = index.passkeys.firstOrNull { it.credentialId == id } ?: error("not found")
        val origin = originOf(req.callingAppInfo, p.rpId) ?: error("This app or page isn't allowed to use passkeys for ${p.rpId}")
        val json = Passkeys.assert(option.requestJson, origin, option.clientDataHash, p)
        PendingIntentHandler.setGetCredentialResponse(out, GetCredentialResponse(PublicKeyCredential(json)))
    }
}
