import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, importPasswordCsv } from "../src/passwords.ts";

test("CSV: quotes, commas and line breaks inside fields, CRLF, a BOM", () => {
  const rows = parseCsv('﻿name,note\r\n"Bank, main","line one\nline ""two"""\r\nplain,x\r\n\r\n');
  assert.deepEqual(rows, [["name", "note"], ["Bank, main", 'line one\nline "two"'], ["plain", "x"]]);
});

test("Chrome / Brave / Edge export", () => {
  const r = importPasswordCsv("name,url,username,password,note\ngithub.com,https://github.com/login,mi@marobotic.dev,p@ss,\n,https://www.square-enix.com/,maro,\"pw,with,commas\",ff14\n");
  assert.equal(r.source, "Chrome, Brave or Edge");
  assert.equal(r.logins.length, 2);
  assert.deepEqual(r.logins[0], { name: "github.com", urls: ["https://github.com/login"], username: "mi@marobotic.dev", password: "p@ss", notes: "", totp: undefined });
  assert.equal(r.logins[1]!.name, "square-enix.com");          // no name: the site's host
  assert.equal(r.logins[1]!.password, "pw,with,commas");
});

test("Firefox export (no name column)", () => {
  const r = importPasswordCsv('"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\n"https://accounts.zoho.com","mi@marobotic.dev","secret","","https://accounts.zoho.com","{x}","1","2","3"\n');
  assert.equal(r.source, "Firefox");
  assert.equal(r.logins[0]!.name, "accounts.zoho.com");
  assert.equal(r.logins[0]!.password, "secret");
});

test("Bitwarden export: logins with their 2FA key; cards and notes are skipped with a reason", () => {
  const r = importPasswordCsv("folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,GitHub,,,0,https://github.com,mi,pw1,JBSWY3DPEHPK3PXP\n,,note,Wifi,the key is x,,0,,,,\n,,login,Zoho,,,0,https://zoho.com,mi,pw2,otpauth://totp/Zoho:mi?secret=GEZDGNBV&issuer=Zoho\n");
  assert.equal(r.source, "Bitwarden");
  assert.equal(r.logins.length, 2);
  assert.equal(r.logins[0]!.totp!.secret, "JBSWY3DPEHPK3PXP");
  assert.equal(r.logins[0]!.totp!.issuer, "GitHub");
  assert.equal(r.logins[1]!.totp!.issuer, "Zoho");
  assert.match(r.skipped[0]!, /row 3: a note, not a login/);
});

test("Apple Passwords export with OTPAuth", () => {
  const r = importPasswordCsv("Title,URL,Username,Password,Notes,OTPAuth\nApple ID,https://appleid.apple.com,mi,pw,,otpauth://totp/Apple:mi?secret=JBSWY3DPEHPK3PXP&issuer=Apple\n");
  assert.equal(r.source, "Apple Passwords");
  assert.equal(r.logins[0]!.name, "Apple ID");
  assert.equal(r.logins[0]!.totp!.issuer, "Apple");
});

test("a file without a password column says what it saw", () => {
  const r = importPasswordCsv("a,b\n1,2\n");
  assert.equal(r.logins.length, 0);
  assert.match(r.skipped[0]!, /no password column \(columns: a, b\)/);
});
