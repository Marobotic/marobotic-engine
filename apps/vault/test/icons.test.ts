import { test } from "node:test";
import assert from "node:assert/strict";
import { siteOf } from "../src/icons.ts";

test("a login's icon comes from its own address, without sign-in subdomains", () => {
  assert.equal(siteOf({ urls: ["https://secure.square-enix.com/oauth"] }), "square-enix.com");
  assert.equal(siteOf({ urls: ["https://www.github.com/login"] }), "github.com");
  assert.equal(siteOf({ urls: ["mail.zoho.eu"] }), "mail.zoho.eu");
});

test("a 2FA code's icon is guessed from its service name", () => {
  assert.equal(siteOf({ issuer: "DigitalOcean" }), "digitalocean.com");
  assert.equal(siteOf({ issuer: "Square Enix" }), "square-enix.com");
  assert.equal(siteOf({ issuer: "SQUARE ENIX" }), "square-enix.com");
  assert.equal(siteOf({ issuer: "Proton" }), "proton.me");
  assert.equal(siteOf({ issuer: "accounts.example.org" }), "example.org");
  assert.equal(siteOf({ issuer: "", name: "" }), "");
});
