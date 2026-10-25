// Runs in the page itself (MAIN world), before the page's scripts: navigator.credentials.create/get
// for passkeys go to Vault first. Vault answers only after you confirm in its own panel (drawn by the
// content script, out of the page's reach); anything Vault doesn't take goes to the browser as usual.
(() => {
  const page = window as Window & { __vaultPasskeyHookInstalled?: boolean };
  if (page.__vaultPasskeyHookInstalled) return;
  page.__vaultPasskeyHookInstalled = true;

  const creds = navigator.credentials;
  if (!creds || !window.PublicKeyCredential) return;
  const nativeCreate = creds.create.bind(creds);
  const nativeGet = creds.get.bind(creds);

  const b64 = (b: BufferSource) => {
    const u = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    let s = "";
    for (const x of u) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const buf = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer;

  let n = 0;
  const waiting = new Map<number, (r: Record<string, unknown>) => void>();
  window.addEventListener("message", (e) => {
    const d = e.data as { __vault?: string; id?: number; result?: Record<string, unknown> };
    if (e.source !== window || d?.__vault !== "res" || typeof d.id !== "number") return;
    waiting.get(d.id)?.(d.result ?? {});
    waiting.delete(d.id);
  });
  const ask = (kind: "create" | "get", options: unknown, signal?: AbortSignal | null, conditional = false) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = ++n;
    waiting.set(id, resolve);
    signal?.addEventListener("abort", () => { waiting.delete(id); window.postMessage({ __vault: "abort", id }, location.origin); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); });
    window.postMessage({ __vault: "req", id, kind, options, conditional }, location.origin);
  });

  const define = (o: object, props: Record<string, unknown>) => { for (const [k, v] of Object.entries(props)) Object.defineProperty(o, k, { value: v, enumerable: true, configurable: true }); return o; };

  function credential(kind: "create" | "get", r: Record<string, string | number>): PublicKeyCredential {
    const raw = buf(r.id as string);
    const response = kind === "create"
      ? define(Object.create(AuthenticatorAttestationResponse.prototype), {
        clientDataJSON: buf(r.clientDataJSON as string), attestationObject: buf(r.attestationObject as string),
        getTransports: () => ["internal", "hybrid"], getAuthenticatorData: () => buf(r.authenticatorData as string),
        getPublicKey: () => buf(r.publicKey as string), getPublicKeyAlgorithm: () => r.publicKeyAlgorithm,
      })
      : define(Object.create(AuthenticatorAssertionResponse.prototype), {
        clientDataJSON: buf(r.clientDataJSON as string), authenticatorData: buf(r.authenticatorData as string),
        signature: buf(r.signature as string), userHandle: buf(r.userHandle as string),
      });
    const json = () => ({
      id: r.id, rawId: r.id, type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {},
      response: kind === "create"
        ? { clientDataJSON: r.clientDataJSON, attestationObject: r.attestationObject, authenticatorData: r.authenticatorData, transports: ["internal", "hybrid"], publicKey: r.publicKey, publicKeyAlgorithm: r.publicKeyAlgorithm }
        : { clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature, userHandle: r.userHandle },
    });
    return define(Object.create(PublicKeyCredential.prototype), {
      id: r.id, rawId: raw, type: "public-key", authenticatorAttachment: "platform", response,
      getClientExtensionResults: () => (kind === "create" ? { credProps: { rk: true } } : {}), toJSON: json,
    }) as PublicKeyCredential;
  }

  creds.create = async function (options?: CredentialCreationOptions) {
    const pk = options?.publicKey;
    if (!pk) return nativeCreate(options);
    const o = {
      rp: { id: pk.rp.id, name: pk.rp.name }, user: { id: b64(pk.user.id), name: pk.user.name, displayName: pk.user.displayName },
      challenge: b64(pk.challenge), pubKeyCredParams: pk.pubKeyCredParams.map((p) => ({ type: p.type, alg: p.alg })),
      excludeCredentials: (pk.excludeCredentials ?? []).map((c) => ({ id: b64(c.id) })),
    };
    const r = await ask("create", o, options?.signal);
    if (r.fallback) return nativeCreate(options);
    if (r.error) throw new DOMException(String(r.error), String(r.name || "NotAllowedError"));
    return credential("create", r as Record<string, string>);
  };

  creds.get = async function (options?: CredentialRequestOptions) {
    const pk = options?.publicKey;
    if (!pk) return nativeGet(options);
    const o = { rpId: pk.rpId, challenge: b64(pk.challenge), allowCredentials: (pk.allowCredentials ?? []).map((c) => ({ id: b64(c.id) })) };
    const r = await ask("get", o, options?.signal, options?.mediation === "conditional");
    if (r.fallback) return nativeGet(options);
    if (r.error) throw new DOMException(String(r.error), String(r.name || "NotAllowedError"));
    return credential("get", r as Record<string, string>);
  };

  // Sites ask these before offering passkeys: Vault can always make and use them.
  const PKC = window.PublicKeyCredential as unknown as Record<string, unknown>;
  const yes = () => Promise.resolve(true);
  try { PKC.isUserVerifyingPlatformAuthenticatorAvailable = yes; PKC.isConditionalMediationAvailable = yes; } catch { /* read-only in this browser */ }
})();
