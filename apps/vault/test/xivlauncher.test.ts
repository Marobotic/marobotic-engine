import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { parseOtpauth, totp } from "@marobotic/otp";
import { findFfxivEntry, sendWhenAsked, sendCode, XL_PORT } from "../src/xivlauncher.ts";

const se = parseOtpauth("otpauth://totp/Square%20Enix:maro?secret=JBSWY3DPEHPK3PXP&issuer=Square%20Enix");
const gh = parseOtpauth("otpauth://totp/GitHub:mi?secret=GEZDGNBVGY3TQOJQ&issuer=GitHub");

test("finds the Square Enix account among the others", () => {
  assert.equal(findFfxivEntry([gh, se]), se);
  assert.equal(findFfxivEntry([gh]), undefined);
});

// A stand-in for XIVLauncher: like the real one it only listens once its OTP box is "open".
function fakeLauncher(): Promise<{ server: Server; got: string[] }> {
  const got: string[] = [];
  const server = createServer((req, res) => {
    const m = /^\/ffxivlauncher\/(\d+)$/.exec(req.url ?? "");
    if (m) got.push(m[1]!);
    res.writeHead(m ? 200 : 404).end();
  });
  return new Promise((ok) => server.listen(XL_PORT, "127.0.0.1", () => ok({ server, got })));
}

test("nothing listening: one attempt fails quietly", async () => {
  assert.equal(await sendCode("123456", "127.0.0.1", 500), false);
});

test("keeps offering until the launcher opens its OTP box, then sends the current code once", async () => {
  const pending = sendWhenAsked(se, { everyMs: 100, untilMs: 10_000 });
  await new Promise((r) => setTimeout(r, 350));          // the launcher opens its OTP box a bit later
  const { server, got } = await fakeLauncher();
  try {
    const r = await pending;
    assert.equal(r.sent, true);
    assert.deepEqual(got, [r.code]);
    const { code: now } = await totp(se);
    const { code: next } = await totp(se, Date.now() + 30_000);
    assert.ok(r.code === now || r.code === next);        // current code, or the next one near a boundary
  } finally {
    server.close();
  }
});

test("gives up after the time limit when the launcher never asks", async () => {
  const r = await sendWhenAsked(se, { everyMs: 50, untilMs: 300 });
  assert.equal(r.sent, false);
});
