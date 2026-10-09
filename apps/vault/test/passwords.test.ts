import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOtpauth } from "@marobotic/otp";
import { generatePassword, hostOf, matchTotp } from "../src/passwords.ts";

test("generated passwords: the asked length, every kind of character, no look-alikes, never the same", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 300; i++) {
    const p = generatePassword({ length: 20 });
    assert.equal(p.length, 20);
    assert.match(p, /[a-z]/); assert.match(p, /[A-Z]/); assert.match(p, /[2-9]/); assert.match(p, /[!@#$%^&*\-_=+?]/);
    assert.doesNotMatch(p, /[lIO01]/);
    seen.add(p);
  }
  assert.equal(seen.size, 300);
  assert.doesNotMatch(generatePassword({ length: 32, symbols: false }), /[^a-zA-Z2-9]/);
  assert.equal(generatePassword({ length: 3 }).length, 8);           // never shorter than 8
});

test("hostOf: URLs, bare hosts and plain text", () => {
  assert.equal(hostOf("https://www.GitHub.com/login"), "github.com");
  assert.equal(hostOf("accounts.zoho.com/signin"), "accounts.zoho.com");
  assert.equal(hostOf("  My Bank Card  "), "my bank card");                // not a URL: kept as typed
});

test("a login finds its 2FA code by site or name, and by account when there are two", () => {
  const code = (uri: string) => ({ otp: parseOtpauth(uri) });
  const github = code("otpauth://totp/GitHub:mi?secret=JBSWY3DPEHPK3PXP&issuer=GitHub");
  const zoho = code("otpauth://totp/Zoho:mi%40marobotic.dev?secret=GEZDGNBV&issuer=Zoho");
  const se1 = code("otpauth://totp/Square%20Enix:maro?secret=GEZDGNBV&issuer=Square%20Enix");
  const se2 = code("otpauth://totp/Square%20Enix:alt?secret=JBSWY3DP&issuer=Square%20Enix");
  const all = [github, zoho, se1, se2];
  assert.equal(matchTotp({ name: "github.com", urls: ["https://github.com/login"], username: "mi" }, all), github);
  assert.equal(matchTotp({ name: "Mail", urls: ["https://accounts.zoho.com"], username: "x" }, all), zoho);
  assert.equal(matchTotp({ name: "Square Enix", urls: [], username: "alt" }, all), se2);
  assert.equal(matchTotp({ name: "Square Enix", urls: [], username: "someone" }, all), undefined);  // two match, neither account
  assert.equal(matchTotp({ name: "Bank", urls: ["https://bank.example"], username: "x" }, all), undefined);
});
