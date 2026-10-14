import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEntry } from "@marobotic/otp";
import { codesFor, fillableUrl, loginsFor, packageWords, registrableDomain, sameSite } from "../src/domains.ts";

test("registrable domains, with two-part suffixes", () => {
  assert.equal(registrableDomain("secure.square-enix.com"), "square-enix.com");
  assert.equal(registrableDomain("www.bbc.co.uk"), "bbc.co.uk");
  assert.equal(registrableDomain("login.example.com.au"), "example.com.au");
  assert.equal(registrableDomain("localhost"), "localhost");
  assert.equal(registrableDomain("192.168.3.10"), "192.168.3.10");
});

test("a login is offered on its own site and its sign-in siblings, never on a look-alike", () => {
  assert.ok(sameSite("https://secure.square-enix.com", "https://store.na.square-enix-games.com/login"));
  assert.ok(sameSite("github.com", "https://github.com/login"));
  assert.ok(sameSite("accounts.google.com", "https://www.youtube.com/"));
  assert.ok(!sameSite("github.com", "https://github.com.evil.io/login"));
  assert.ok(!sameSite("github.com", "https://githhub.com/login"));
  assert.ok(!sameSite("My Bank Card", "https://mybankcard.com"));      // a name, not a site
  assert.ok(!sameSite("bbc.co.uk", "https://evil.co.uk"));
});

test("only https pages (or the local network) get filled", () => {
  assert.ok(fillableUrl("https://github.com/login"));
  assert.ok(fillableUrl("http://192.168.3.1/"));
  assert.ok(!fillableUrl("http://github.com/login"));
  assert.ok(!fillableUrl("file:///C:/x.html"));
  assert.ok(!fillableUrl("javascript:alert(1)"));
});

test("logins and codes for a page: the exact host first, linked codes first", () => {
  const L = (id: string, urls: string[], username: string, totpId?: string) => ({ id, data: { name: id, urls, username, ...(totpId ? { totpId } : {}) } });
  const C = (id: string, issuer: string, account: string) => ({ id, data: { otp: normalizeEntry({ issuer, account, secret: "JBSWY3DPEHPK3PXP" }) } });
  const logins = [L("se-main", ["square-enix.com"], "maro", "c2"), L("se-store", ["secure.square-enix.com"], "alt"), L("gh", ["github.com"], "mi")];
  const codes = [C("c1", "Square Enix", "alt"), C("c2", "Square Enix", "maro"), C("c3", "GitHub", "mi"), C("c4", "DigitalOcean", "x")];
  assert.deepEqual(loginsFor("https://secure.square-enix.com/oauth", logins).map((l) => l.id), ["se-store", "se-main"]);
  assert.deepEqual(codesFor("https://secure.square-enix.com/oauth", codes, logins).map((c) => c.id), ["c1", "c2"]);
  assert.deepEqual(codesFor("https://github.com/sessions/two-factor", codes, logins).map((c) => c.id), ["c3"]);
  assert.deepEqual(codesFor("https://cloud.digitalocean.com/login", codes, logins).map((c) => c.id), ["c4"]);
  assert.deepEqual(codesFor("https://example.com", codes, logins), []);
});

test("app package names give matching words", () => {
  assert.deepEqual(packageWords("com.github.android"), ["github"]);
  assert.deepEqual(packageWords("com.square_enix.android_googleplay.FFXIVApp"), ["squareenix", "androidgoogleplay", "ffxivapp"]);
});

test("a login saved without an address matches the site its name names, exactly", () => {
  const L = { id: "d", data: { name: "Discord - Talk, Play, Hang Out with Friends", urls: [] as string[], username: "" } };
  assert.deepEqual(loginsFor("https://discord.com/login", [L]).map((l) => l.id), ["d"]);
  assert.deepEqual(loginsFor("https://discord.xyz/login", [L]), []);
  assert.deepEqual(loginsFor("https://discord.com.evil.io/login", [L]), []);
});
