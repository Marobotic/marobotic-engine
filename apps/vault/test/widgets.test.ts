import { test } from "node:test";
import assert from "node:assert/strict";
import { monogramColor, initials } from "../ui/widgets.ts";

test("monogram colour is deterministic and from the palette", () => {
  const PALETTE = ["#B14242", "#D66E36", "#F0BE66", "#4A8B8B", "#7E6BAF", "#5B8C4A", "#C2587E", "#8A8A8A"];
  assert.equal(monogramColor("GitHub"), monogramColor("github"));            // case-insensitive, stable
  assert.ok(PALETTE.includes(monogramColor("Square Enix")));
  assert.notEqual(monogramColor("GitHub"), monogramColor("Zoho"));           // different names usually differ
});

test("initials: one word takes two letters, two words take one each", () => {
  assert.equal(initials("GitHub"), "GI");
  assert.equal(initials("Square Enix"), "SE");
  assert.equal(initials("accounts.zoho.com"), "AZ");  // accounts + zoho
  assert.equal(initials("  "), "?");
});
