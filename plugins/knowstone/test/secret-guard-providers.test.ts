import { describe, expect, it } from "vitest";
import { scanForSecrets, redact } from "../src/secret-guard.js";

/**
 * Coverage for the common developer-secret providers added on top of the base
 * guard: OpenAI/Anthropic keys, GitLab/npm/Hugging Face/SendGrid/PyPI/DigitalOcean
 * tokens, and passwords embedded in connection URIs. All fixtures are fake.
 */

function kinds(text: string): string[] {
  return scanForSecrets(text).findings.map((f) => f.kind);
}

describe("provider token detection", () => {
  it("catches an Anthropic key", () => {
    expect(kinds(`key = "sk-ant-api03-${"A1b2C3d4E5".repeat(4)}"`)).toContain("anthropic-key");
  });

  it("catches an OpenAI key", () => {
    expect(kinds(`OPENAI="sk-${"abc123XYZ0".repeat(5)}"`)).toContain("openai-key");
  });

  it("catches a GitLab PAT", () => {
    expect(kinds(`glpat-${"aZ09_-aZ09".repeat(3)}`)).toContain("gitlab-token");
  });

  it("catches an npm token", () => {
    expect(kinds(`npm_${"abcABC0123".repeat(4)}`)).toContain("npm-token");
  });

  it("catches a Hugging Face token", () => {
    expect(kinds(`hf_${"abcABC0123".repeat(4)}`)).toContain("huggingface-token");
  });

  it("catches a SendGrid key", () => {
    expect(kinds(`SG.${"abcABC0123_-".repeat(2)}.${"abcABC0123_-".repeat(3)}`)).toContain(
      "sendgrid-key",
    );
  });

  it("catches a PyPI token", () => {
    expect(kinds(`pypi-${"AgEIcHlwaS5vcmc".repeat(2)}`)).toContain("pypi-token");
  });

  it("catches a DigitalOcean token", () => {
    expect(kinds(`dop_v1_${"a1b2c3d4".repeat(8)}`)).toContain("digitalocean-token");
  });
});

describe("connection URI passwords", () => {
  it("catches a Postgres URI password and redacts only the password", () => {
    const text = "DB: postgres://appuser:s3cr3tP4ssw0rd@db.internal:5432/app";
    expect(kinds(text)).toContain("connection-uri-password");
    const red = redact(text);
    expect(red).not.toContain("s3cr3tP4ssw0rd");
    expect(red).toContain("appuser"); // the username is left intact
    expect(scanForSecrets(red).safe).toBe(true);
  });

  it("catches a password in an https basic-auth URL", () => {
    expect(kinds("https://admin:hunter2hunter2@example.com/api")).toContain(
      "connection-uri-password",
    );
  });

  it("leaves a URL with no credentials alone", () => {
    expect(scanForSecrets("https://example.com/docs/page?x=1").safe).toBe(true);
  });
});
