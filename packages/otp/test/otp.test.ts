import { test } from "node:test";
import assert from "node:assert/strict";
import { base32Decode, base32Encode, hotp, totp, parseOtpauth, buildOtpauth, normalizeEntry } from "../src/index.ts";

const ascii = (s: string) => new TextEncoder().encode(s);

test("base32 round-trips and ignores case, spaces and padding", () => {
  const bytes = ascii("Hello!\xde\xad\xbe\xef");
  assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  assert.deepEqual(base32Decode("jbsw y3dp ehpk 3pxp===="), base32Decode("JBSWY3DPEHPK3PXP"));
  assert.throws(() => base32Decode("JBSW1"), /not base32/);
});

test("HOTP matches RFC 4226 appendix D", async () => {
  const secret = ascii("12345678901234567890");
  const want = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  for (let i = 0; i < want.length; i++) assert.equal(await hotp(secret, i), want[i]);
});

test("TOTP matches RFC 6238 appendix B for SHA1, SHA256 and SHA512", async () => {
  const keys = {
    SHA1: base32Encode(ascii("12345678901234567890")),
    SHA256: base32Encode(ascii("12345678901234567890123456789012")),
    SHA512: base32Encode(ascii("1234567890123456789012345678901234567890123456789012345678901234")),
  } as const;
  const cases: [number, Record<keyof typeof keys, string>][] = [
    [59, { SHA1: "94287082", SHA256: "46119246", SHA512: "90693936" }],
    [1111111109, { SHA1: "07081804", SHA256: "68084774", SHA512: "25091201" }],
    [1234567890, { SHA1: "89005924", SHA256: "91819424", SHA512: "93441116" }],
    [20000000000, { SHA1: "65353130", SHA256: "77737706", SHA512: "47863826" }],
  ];
  for (const [t, codes] of cases)
    for (const alg of ["SHA1", "SHA256", "SHA512"] as const)
      assert.equal((await totp({ secret: keys[alg], digits: 8, period: 30, algorithm: alg }, t * 1000)).code, codes[alg], `${alg} at ${t}`);
  assert.equal((await totp({ secret: keys.SHA1, digits: 6, period: 30, algorithm: "SHA1" }, 59_000)).remaining, 1);
});

test("otpauth links: parse the usual shapes, and build them back", () => {
  const e = parseOtpauth("otpauth://totp/GitHub:mi%40marobotic.dev?secret=jbswy3dpehpk3pxp&issuer=GitHub");
  assert.deepEqual(e, { type: "totp", issuer: "GitHub", account: "mi@marobotic.dev", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30, counter: 0 });
  assert.deepEqual(parseOtpauth(buildOtpauth(e)), e);
  const odd = parseOtpauth("otpauth://totp/Square%20Enix:maro?secret=GEZDGNBV&algorithm=SHA256&digits=8&period=60");
  assert.equal(odd.issuer, "Square Enix");
  assert.equal(odd.digits, 8);
  assert.equal(odd.period, 60);
  assert.equal(parseOtpauth("otpauth://totp/justme?secret=GEZDGNBV").account, "justme");
  assert.throws(() => parseOtpauth("https://example.com"), /otpauth/);
  assert.throws(() => parseOtpauth("otpauth://totp/x?issuer=y"), /no secret/);
  assert.throws(() => normalizeEntry({ secret: "GEZDGNBV", algorithm: "MD5" as never }), /unsupported/);
});
