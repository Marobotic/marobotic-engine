package dev.marobotic.vault

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.CancellationSignal
import android.os.OutcomeReceiver
import androidx.annotation.RequiresApi
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.CreateCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.provider.AuthenticationAction
import androidx.credentials.provider.BeginCreateCredentialRequest
import androidx.credentials.provider.BeginCreateCredentialResponse
import androidx.credentials.provider.BeginCreatePasswordCredentialRequest
import androidx.credentials.provider.BeginCreatePublicKeyCredentialRequest
import androidx.credentials.provider.BeginGetCredentialRequest
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.BeginGetPasswordOption
import androidx.credentials.provider.BeginGetPublicKeyCredentialOption
import androidx.credentials.provider.CreateEntry
import androidx.credentials.provider.CredentialProviderService
import androidx.credentials.provider.PasswordCredentialEntry
import androidx.credentials.provider.ProviderClearCredentialStateRequest
import androidx.credentials.provider.PublicKeyCredentialEntry
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

/**
 * Vault in Android's Credential Manager (Android 14+, "Passwords, passkeys & accounts"): it saves new
 * passkeys and passwords, and offers the matching ones when an app or a browser asks. The actual
 * making and signing happens in PasskeyActivity, after you pick Vault in the system sheet.
 */
@RequiresApi(34)
class VaultCredentialService : CredentialProviderService() {
    companion object {
        private val codes = AtomicInteger(100)

        fun intent(ctx: Context, kind: String, id: String = ""): PendingIntent =
            PendingIntent.getActivity(ctx, codes.incrementAndGet(),
                Intent(ctx, PasskeyActivity::class.java).putExtra("kind", kind).putExtra("id", id),
                PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        /** The entries for a sign-in request, from the open vault. */
        fun entries(ctx: Context, request: BeginGetCredentialRequest): BeginGetCredentialResponse {
            val index = AutofillStore.index ?: return BeginGetCredentialResponse.Builder()
                .addAuthenticationAction(AuthenticationAction("Unlock Vault", intent(ctx, "unlock"))).build()
            val b = BeginGetCredentialResponse.Builder()
            val pkg = request.callingAppInfo?.packageName ?: ""
            for (option in request.beginGetCredentialOptions) when (option) {
                is BeginGetPublicKeyCredentialOption -> {
                    val o = JSONObject(option.requestJson)
                    val rpId = o.optString("rpId")
                    val allow = o.optJSONArray("allowCredentials")?.let { a -> (0 until a.length()).map { a.getJSONObject(it).getString("id") }.toSet() } ?: emptySet()
                    for (p in index.passkeys.filter { it.rpId == rpId && (allow.isEmpty() || it.credentialId in allow) })
                        b.addCredentialEntry(PublicKeyCredentialEntry.Builder(ctx, p.username.ifBlank { p.displayName }, intent(ctx, "getPasskey", p.credentialId), option)
                            .setDisplayName(p.displayName.ifBlank { null }).build())
                }
                is BeginGetPasswordOption -> with(AutofillStore) {
                    for (l in index.loginsFor(null, pkg).filter { it.password.isNotEmpty() }.take(6))
                        b.addCredentialEntry(PasswordCredentialEntry.Builder(ctx, l.who, intent(ctx, "getPassword", l.id), option)
                            .setDisplayName(l.name).build())
                }
                else -> {}
            }
            return b.build()
        }
    }

    override fun onBeginGetCredentialRequest(request: BeginGetCredentialRequest, cancellationSignal: CancellationSignal,
                                             callback: OutcomeReceiver<BeginGetCredentialResponse, GetCredentialException>) {
        callback.onResult(entries(this, request))
    }

    override fun onBeginCreateCredentialRequest(request: BeginCreateCredentialRequest, cancellationSignal: CancellationSignal,
                                                callback: OutcomeReceiver<BeginCreateCredentialResponse, CreateCredentialException>) {
        val kind = when (request) {
            is BeginCreatePublicKeyCredentialRequest -> "createPasskey"
            is BeginCreatePasswordCredentialRequest -> "createPassword"
            else -> return callback.onError(CreateCredentialUnknownException("Vault can't save this kind of credential"))
        }
        callback.onResult(BeginCreateCredentialResponse.Builder()
            .addCreateEntry(CreateEntry.Builder("Vault", intent(this, kind)).setDescription("Saved in Vault and synced to your devices").build()).build())
    }

    override fun onClearCredentialStateRequest(request: ProviderClearCredentialStateRequest, cancellationSignal: CancellationSignal,
                                               callback: OutcomeReceiver<Void?, ClearCredentialException>) {
        callback.onResult(null)
    }
}
