import { describe, it, expect } from "vitest";
import { scanForSecrets, redact, type SecretFinding } from "../src/secret-guard.js";

/**
 * All secrets below are deliberately FAKE. Where possible they are the public,
 * vendor-documented example values (e.g. AKIAIOSFODNN7EXAMPLE) so nobody mistakes
 * them for live credentials.
 */

/** True if any finding has the given kind. */
function hasKind(findings: SecretFinding[], kind: string): boolean {
  return findings.some((f) => f.kind === kind);
}

describe("scanForSecrets — one test per pattern", () => {
  it("detects a PEM private key block as private-key-block", () => {
    const text = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIBOgIBAAJBAKfakefakefakefakefakefakefakefakefakefakefakefake12",
      "AgMBAAECAQAfakefakefakefakefakefakefakefakefakefakefakefake3456",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const { safe, findings } = scanForSecrets(text);
    expect(safe).toBe(false);
    expect(hasKind(findings, "private-key-block")).toBe(true);
  });

  it("detects an AWS access key id as aws-access-key-id", () => {
    const { safe, findings } = scanForSecrets("key = AKIAIOSFODNN7EXAMPLE end");
    expect(safe).toBe(false);
    expect(hasKind(findings, "aws-access-key-id")).toBe(true);
  });

  it("detects an AWS secret access key as aws-secret-access-key", () => {
    const text = 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"';
    const { safe, findings } = scanForSecrets(text);
    expect(safe).toBe(false);
    expect(hasKind(findings, "aws-secret-access-key")).toBe(true);
  });

  it("detects a GitHub token as github-token", () => {
    const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const { safe, findings } = scanForSecrets(`token: ${token}`);
    expect(safe).toBe(false);
    expect(hasKind(findings, "github-token")).toBe(true);
  });

  it("detects a Slack token as slack-token", () => {
    const text = "SLACK=xoxb-fake-not-a-real-slack-token-value";
    const { findings } = scanForSecrets(text);
    expect(hasKind(findings, "slack-token")).toBe(true);
  });

  it("detects a Google API key as google-api-key", () => {
    const key = "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"; // 35 chars after prefix
    const { findings } = scanForSecrets(`const k = "${key}";`);
    expect(hasKind(findings, "google-api-key")).toBe(true);
  });

  it("detects a Stripe key as stripe-key", () => {
    const { findings } = scanForSecrets("stripe = sk_live_1234567890abcdefABCDEF");
    expect(hasKind(findings, "stripe-key")).toBe(true);
  });

  it("detects a JWT as jwt", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.fakeSignatureABC123_-";
    const { findings } = scanForSecrets(`Authorization: Bearer ${jwt}`);
    expect(hasKind(findings, "jwt")).toBe(true);
  });

  it("detects a generic secret assignment and captures the VALUE", () => {
    const text = 'const clientSecret = "sup3rS3cretV4lue123";';
    const { findings } = scanForSecrets(text);
    expect(hasKind(findings, "generic-assignment")).toBe(true);
    const finding = findings.find((f) => f.kind === "generic-assignment");
    // The match is the value only, not the whole line.
    expect(finding?.match).toBe("sup3rS3cretV4lue123");
  });

  it("detects a .env style credential line as env-var", () => {
    const { findings } = scanForSecrets("DATABASE_PASSWORD=hunter2hunter2");
    expect(hasKind(findings, "env-var")).toBe(true);
  });

  it("detects a standalone high-entropy hex string as high-entropy-string", () => {
    const text = "digest 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const { findings } = scanForSecrets(text);
    expect(hasKind(findings, "high-entropy-string")).toBe(true);
  });
});

describe("placeholders and benign input", () => {
  it("treats an empty string as safe", () => {
    expect(scanForSecrets("").safe).toBe(true);
  });

  it("treats plain prose as safe", () => {
    const prose =
      "The quick brown fox jumps over the lazy dog. Knowstone caches verified project facts.";
    expect(scanForSecrets(prose).safe).toBe(true);
  });

  it("treats a realistic benign code snippet as safe", () => {
    // Ordinary TypeScript: variable names, a URL, a long normal identifier. None
    // of these use credential-ish key names or long high-entropy runs, so they
    // are safe. (Known accepted false positives: a quoted value assigned to any
    // name containing words like "secret", "token" or "auth" — e.g. a variable
    // called "author" — would be flagged. We avoid those names here.)
    const snippet = [
      'const greeting = "hello world";',
      'const docsUrl = "https://example.com/docs/getting-started";',
      "const maxRetryCount = 5;",
      "function computeChecksum(input: string): number {",
      "  return input.length * 7;",
      "}",
    ].join("\n");
    const { safe, findings } = scanForSecrets(snippet);
    expect(findings).toEqual([]);
    expect(safe).toBe(true);
  });

  it("does not flag an obvious placeholder value", () => {
    expect(scanForSecrets('password = "changeme"').safe).toBe(true);
    expect(scanForSecrets('api_key = "your-key-here"').safe).toBe(true);
    expect(scanForSecrets('token = "<token>"').safe).toBe(true);
  });
});

describe("redact", () => {
  it('catches `const apiKey = "sk_live_..."` and redacts the value', () => {
    const text = 'const apiKey = "sk_live_1234567890abcdef";';
    const { safe } = scanForSecrets(text);
    expect(safe).toBe(false);
    const cleaned = redact(text);
    expect(cleaned).not.toContain("sk_live_1234567890abcdef");
    expect(cleaned).toContain("[REDACTED:");
  });

  it("replaces every detected secret and a re-scan of the result is safe", () => {
    const text = [
      "-----BEGIN EC PRIVATE KEY-----",
      "MHcCAQEEIFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFake01",
      "-----END EC PRIVATE KEY-----",
      "aws = AKIAIOSFODNN7EXAMPLE",
      'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
      'const clientSecret = "sup3rS3cretV4lue123";',
      "GITHUB_TOKEN=ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
      "digest 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    ].join("\n");

    const before = scanForSecrets(text);
    expect(before.safe).toBe(false);
    expect(before.findings.length).toBeGreaterThan(1);

    const cleaned = redact(text);
    const after = scanForSecrets(cleaned);
    expect(after.safe).toBe(true);
  });

  it("returns findings sorted by index with no overlapping spans", () => {
    const text = 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"';
    const { findings } = scanForSecrets(text);
    for (let i = 1; i < findings.length; i += 1) {
      const prev = findings[i - 1];
      const curr = findings[i];
      expect(prev).toBeDefined();
      expect(curr).toBeDefined();
      if (prev && curr) {
        expect(curr.index).toBeGreaterThanOrEqual(prev.index + prev.match.length);
      }
    }
  });
});
