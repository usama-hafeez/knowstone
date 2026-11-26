import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanForSecrets } from "../src/secret-guard.js";
import { openStore, SecretError, type FactInput } from "../src/store.js";
import type { Binding } from "../src/freshness.js";

/**
 * Regression suite grown from a red-team pass on the secret guard. Every secret
 * below is DELIBERATELY FAKE.
 *
 * Active `it(...)` tests are leak holes that have been CLOSED: a real-world
 * credential of that shape is now caught before it could be cached.
 *
 * `it.skip(...)` tests are KNOWN best-effort gaps the guard does not yet catch.
 * They are kept (not deleted) so the exact shapes are on record and can be
 * un-skipped the moment they are addressed. Each assertion is the SAFE
 * expectation, so un-skipping turns it into a live test. See SECURITY.md for why
 * these are accepted for now (low real-world likelihood, or a false-positive cost
 * that is not worth paying yet).
 */

// -----------------------------------------------------------------------------
// Provider / token shapes presented BARE (no credential-ish key name nearby).
// -----------------------------------------------------------------------------
describe("provider tokens presented bare", () => {
  it("catches a bare Telegram bot token", () => {
    const token = `123456789:AAE${"fakeTOKEN0".repeat(3)}aa`;
    expect(scanForSecrets(`Telegram bot is ${token} and it polls updates`).safe).toBe(false);
  });

  it("catches a bare Twilio-style 32-hex auth token", () => {
    expect(scanForSecrets("twilio uses 7e8f1a2b3c4d5e6f7a8b9c0d1e2f3a4b now").safe).toBe(false);
  });

  it("catches a hyphenated 32-hex token (hyphen keeps the hex boundary)", () => {
    expect(scanForSecrets("sender ref-0123456789abcdef0123456789abcdef today").safe).toBe(false);
  });

  it("catches an underscore-prefixed 32-hex token (underscore no longer defeats the hex run)", () => {
    expect(scanForSecrets("token tok_0123456789abcdef0123456789abcdef installed").safe).toBe(false);
  });

  it("catches an Azure storage AccountKey (88-char base64)", () => {
    const key =
      "Q2hhbmdlTWVGYWtlQXp1cmVTdG9yYWdlQWNjb3VudEtleUV4YW1wbGVWYWx1ZURvTm90VXNlUmVhbDEyMzQ1Ng==";
    const conn = `DefaultEndpointsProtocol=https;AccountName=devstore;AccountKey=${key}`;
    expect(scanForSecrets(conn).safe).toBe(false);
  });

  // KNOWN GAP: Discord tokens are three dot-separated base64 segments, each below
  // the 40-char base64 floor; no provider pattern covers them yet.
  it.skip("catches a bare Discord bot token", () => {
    const token = "EXAMPLEdiscordid.EXAMPLE.not-a-real-discord-token-placeholder";
    expect(scanForSecrets(`Discord bot auth string: ${token}`).safe).toBe(false);
  });

  // KNOWN GAP: a bare 24-char alphanumeric token is below the length floors and
  // lowering them would flag ordinary identifiers.
  it.skip("catches a bare Vercel-style 24-char token", () => {
    expect(scanForSecrets("deploy hook uses AbCd1234EfGh5678IjKl9012 for CI").safe).toBe(false);
  });

  // KNOWN GAP: url-encoding (%2F, %2B) chops the SAS signature into sub-40 pieces.
  it.skip("catches an Azure SAS signature (url-encoded)", () => {
    const sas =
      "https://acct.blob.core.windows.net/c?sv=2021-08-06&sig=aB3dEf%2FgHiJkLmN%2BoPqRsTuVwXyZ0123456789%3D";
    expect(scanForSecrets(sas).safe).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Values that dodge the generic-assignment rule.
// -----------------------------------------------------------------------------
describe("generic-assignment dodges", () => {
  it("catches a JSON quoted key:value (quote between key and colon)", () => {
    expect(scanForSecrets('{"api_key": "SbX9kLmNpQ"}').safe).toBe(false);
  });

  it("catches a JSON quoted client_secret", () => {
    expect(scanForSecrets('{"client_secret": "verysecretVAL1"}').safe).toBe(false);
  });

  it("catches a YAML unquoted credential assignment", () => {
    expect(scanForSecrets("password: s3cr3tYamlValue").safe).toBe(false);
  });

  // KNOWN GAP: a 6-char minimum on values means a genuine <6-char credential slips.
  // Lowering it would flag many ordinary short strings.
  it.skip("catches a real token shorter than the 6-char value floor", () => {
    expect(scanForSecrets("prod db password=Qw3rt").safe).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// isPlaceholder over-eagerness.
// -----------------------------------------------------------------------------
describe("isPlaceholder over-eagerness", () => {
  // KNOWN GAP: same 6-char floor; values under 6 chars are treated as placeholders.
  it.skip("catches a genuine 5-char secret value", () => {
    expect(scanForSecrets('apiKey = "A1b2C"').safe).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Connection-URI password gaps.
// -----------------------------------------------------------------------------
describe("connection-URI passwords", () => {
  it("catches a redis URI with a password but NO username", () => {
    expect(scanForSecrets("cache at redis://:s3cr3tP4ssw0rd@cache.internal:6379/0").safe).toBe(
      false,
    );
  });

  it("catches an amqp URI with no username and a real password", () => {
    expect(scanForSecrets("broker amqp://:R4bb1tM4ssword@mq.host:5672/vhost").safe).toBe(false);
  });

  // KNOWN GAP: 6-char value floor again; a <6-char URI password slips.
  it.skip("catches a connection URI whose password is under 6 chars", () => {
    expect(scanForSecrets("db postgres://user:Pw1x@db.host:5432/app").safe).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// High-entropy / length evasion.
// -----------------------------------------------------------------------------
describe("high-entropy / length evasion", () => {
  // KNOWN GAP: below the 40-char base64 / 32-hex floors and no key name nearby.
  it.skip("catches a bare 28-char high-entropy token", () => {
    expect(scanForSecrets("session token Xy9mKq2Lp7Rt4Vw1Zb8Nc5Df3Gh set").safe).toBe(false);
  });

  // KNOWN GAP: a newline inside the statement splits the run into sub-40 halves.
  it.skip("catches a 48-char base64 secret split by a newline", () => {
    const half1 = "aB3dEfGhIjKlMnOpQrStUvWx";
    const half2 = "YzAbCdEfGhIjKlMnOpQrStUv";
    expect(scanForSecrets(`the key is ${half1}\n${half2} verbatim`).safe).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Store end-to-end: the guard runs in the write path, so these must never reach
// disk. Both were verified leaks before the fix.
// -----------------------------------------------------------------------------
describe("store end-to-end leak is refused", () => {
  const temps: string[] = [];
  afterEach(() => {
    while (temps.length > 0) {
      const dir = temps.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });
  function tmpBase(): string {
    const dir = mkdtempSync(join(tmpdir(), "knowstone-adv-"));
    temps.push(dir);
    return dir;
  }
  function binding(): Binding {
    return {
      toolVersion: "0.1.0",
      createdAt: 1000,
      cone: [{ path: "a.ts", hash: "abc", size: 10 }],
      coneRoot: "root",
      coneComplete: true,
    };
  }
  function input(statement: string): FactInput {
    return { kind: "finding", statement, binding: binding(), createdAt: 1000 };
  }

  it("refuses a fact carrying a redis URI password with no username", () => {
    const base = tmpBase();
    const store = openStore({ baseDir: base, projectRoot: "/proj/leak" });
    const stmt = "the queue connects to redis://:s3cr3tP4ssw0rd@cache.internal:6379/0";
    expect(() => store.put(input(stmt))).toThrow(SecretError);
    expect(store.list()).toHaveLength(0);
    expect(existsSync(store.path)).toBe(false);
  });

  it("refuses a fact carrying a JSON-style quoted api_key", () => {
    const base = tmpBase();
    const store = openStore({ baseDir: base, projectRoot: "/proj/leak2" });
    const stmt = 'config holds {"api_key": "SbX9kLmNpQ"} for the service';
    expect(() => store.put(input(stmt))).toThrow(SecretError);
    expect(store.list()).toHaveLength(0);
  });
});
