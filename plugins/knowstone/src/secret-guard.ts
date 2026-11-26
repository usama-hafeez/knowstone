/**
 * Secret-scan guard for the Knowstone write path.
 *
 * Before any remembered fact is cached to disk, its text is run through
 * {@link scanForSecrets}. Anything that looks like a credential must be caught
 * here so it never lands in the cache. The design is deliberately biased towards
 * catching: a false negative leaks a real secret (catastrophic), whereas a false
 * positive only withholds one fact from the cache (mildly annoying). When in
 * doubt, we flag.
 *
 * This module is pure string scanning: no imports, no I/O. Callers must never log
 * {@link SecretFinding.match} — it is the raw secret and exists only so the store
 * can redact it.
 */

export interface SecretFinding {
  /** A short machine label for the kind of secret, e.g. "aws-access-key-id". */
  kind: string;
  /** The matched substring. Sensitive: callers must never log it. */
  match: string;
  /** Character offset of the match within the input text. */
  index: number;
}

export interface ScanResult {
  /** true only when findings is empty. */
  safe: boolean;
  findings: SecretFinding[];
}

/** A finding before de-duplication, carrying a priority used to pick the winner. */
interface Candidate extends SecretFinding {
  /** Lower wins: 0 is the most specific rule, higher is more generic. */
  priority: number;
}

/**
 * Direct patterns match the whole secret as match[0]. Priority 0 is the most
 * specific; 10 covers the well-known provider token shapes.
 */
const DIRECT_PATTERNS: { kind: string; priority: number; re: RegExp }[] = [
  // PEM private key blocks, header to footer, any key type (RSA/EC/OPENSSH/DSA/PGP).
  {
    kind: "private-key-block",
    priority: 0,
    re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  },
  // AWS access key id (long-term AKIA, temporary ASIA).
  { kind: "aws-access-key-id", priority: 10, re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // GitHub tokens: the gh*_ family and fine-grained github_pat_ tokens.
  {
    kind: "github-token",
    priority: 10,
    re: /\b(?:gh[porsu]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  // Slack tokens.
  { kind: "slack-token", priority: 10, re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // Google API key.
  { kind: "google-api-key", priority: 10, re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Stripe live/test secret and restricted keys.
  { kind: "stripe-key", priority: 10, re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{10,}\b/g },
  // JSON Web Tokens: header.payload.signature, both parts starting eyJ / eyJ.
  { kind: "jwt", priority: 10, re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  // Anthropic API keys (checked before the generic OpenAI sk- shape).
  { kind: "anthropic-key", priority: 10, re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  // OpenAI API keys (classic sk- and project sk-proj-).
  { kind: "openai-key", priority: 10, re: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b/g },
  // GitLab personal access tokens.
  { kind: "gitlab-token", priority: 10, re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  // npm automation/access tokens.
  { kind: "npm-token", priority: 10, re: /\bnpm_[A-Za-z0-9]{36,}\b/g },
  // Hugging Face access tokens.
  { kind: "huggingface-token", priority: 10, re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  // SendGrid API keys.
  { kind: "sendgrid-key", priority: 10, re: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g },
  // PyPI upload tokens.
  { kind: "pypi-token", priority: 10, re: /\bpypi-[A-Za-z0-9_-]{16,}\b/g },
  // DigitalOcean personal access tokens.
  { kind: "digitalocean-token", priority: 10, re: /\bdop_v1_[a-f0-9]{64}\b/g },
  // Telegram bot tokens: numeric bot id, colon, then a long token.
  { kind: "telegram-bot-token", priority: 10, re: /\b\d{6,10}:[A-Za-z0-9_-]{35,}\b/g },
];

/**
 * Value patterns capture the secret VALUE (group 1) rather than the whole line,
 * so redaction removes the value and leaves the key name in place.
 */
const VALUE_PATTERNS: { kind: string; priority: number; group: number; re: RegExp }[] = [
  // AWS secret access key: a 40-char base64-ish value sitting next to an aws_secret
  // style key name.
  {
    kind: "aws-secret-access-key",
    priority: 20,
    group: 1,
    re: /(?:aws_secret_access_key|aws_secret|secret_access_key)["']?\s*[:=]\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/gi,
  },
  // .env style line: ALL_CAPS key that names a credential, then a non-trivial value.
  {
    kind: "env-var",
    priority: 25,
    group: 1,
    re: /^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|KEY|API|CREDENTIAL)[A-Z0-9_]*\s*=\s*["']?([^\s"'#\n]{6,})/gm,
  },
  // Password embedded in a connection URI: scheme://user:password@host.
  {
    kind: "connection-uri-password",
    priority: 15,
    group: 1,
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^:@\s/]*:([^@\s/"']{3,})@/gi,
  },
];

/**
 * Generic secret assignment. The key name contains a credential-ish word and is
 * followed by = or : and a non-trivial value, quoted (group 2) or unquoted
 * (group 3). The unquoted value may not start with "[" so a redaction placeholder
 * is never re-matched.
 */
const GENERIC_ASSIGNMENT =
  /[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_.-]*["']?\s*[:=]\s*(?:(["'])([^"'\n]{6,})\1|([^\s"'<>;,[][^\s"'<>;,\n]{5,}))/gi;

/** Runs of hex (>= 32) or base64/base64url (>= 40) that no other rule has claimed. */
const HEX_RUN = /(?<![0-9a-fA-F])[0-9a-fA-F]{32,}(?![0-9a-fA-F])/g;
const BASE64_RUN = /[A-Za-z0-9+/_-]{40,}={0,2}/g;

/** Minimum Shannon entropy (bits per character) for a base64 run to count. */
const BASE64_ENTROPY_THRESHOLD = 3.2;

/**
 * Values we treat as obvious placeholders rather than real secrets, so a
 * credential-shaped assignment to e.g. "changeme" is not flagged. Also catches
 * our own redaction output so a re-scan of redacted text comes back safe.
 */
function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (v.length < 6) return true;
  if (/^\[REDACTED:/.test(v)) return true;
  if (/^<.*>$/.test(v)) return true; // <...>
  if (/^x+$/i.test(v)) return true; // xxxx
  if (/^\.+$/.test(v)) return true; // ....
  if (/^your[-_].*[-_]here$/i.test(v)) return true; // your-...-here
  const known = new Set([
    "changeme",
    "change_me",
    "password",
    "secret",
    "placeholder",
    "example",
    "redacted",
    "todo",
    "null",
    "none",
    "undefined",
  ]);
  return known.has(v.toLowerCase());
}

/** Shannon entropy in bits per character. Empty strings return 0. */
function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * De-duplicate overlapping candidates, keeping the most specific (lowest
 * priority, then longest) for any given span. Returns findings sorted by index.
 */
function dedupe(candidates: Candidate[]): SecretFinding[] {
  const ordered = [...candidates].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.match.length !== b.match.length) return b.match.length - a.match.length;
    return a.index - b.index;
  });

  const kept: Candidate[] = [];
  for (const candidate of ordered) {
    const start = candidate.index;
    const end = candidate.index + candidate.match.length;
    const overlaps = kept.some((k) => {
      const kStart = k.index;
      const kEnd = k.index + k.match.length;
      return start < kEnd && kStart < end;
    });
    if (!overlaps) kept.push(candidate);
  }

  return kept
    .map((c) => ({ kind: c.kind, match: c.match, index: c.index }))
    .sort((a, b) => a.index - b.index);
}

/** Scan arbitrary text for things that look like secrets. Best-effort, biased towards catching. */
export function scanForSecrets(text: string): ScanResult {
  if (text.length === 0) return { safe: true, findings: [] };

  const candidates: Candidate[] = [];

  // Direct patterns: the whole match is the secret.
  for (const pattern of DIRECT_PATTERNS) {
    for (const match of text.matchAll(pattern.re)) {
      if (match.index === undefined) continue;
      const value = match[0];
      if (value.length === 0) continue;
      candidates.push({
        kind: pattern.kind,
        match: value,
        index: match.index,
        priority: pattern.priority,
      });
    }
  }

  // Value patterns with a single value capture group.
  for (const pattern of VALUE_PATTERNS) {
    for (const match of text.matchAll(pattern.re)) {
      if (match.index === undefined) continue;
      const value = match[pattern.group];
      if (value === undefined || value.length === 0 || isPlaceholder(value)) continue;
      const offset = match[0].lastIndexOf(value);
      if (offset < 0) continue;
      candidates.push({
        kind: pattern.kind,
        match: value,
        index: match.index + offset,
        priority: pattern.priority,
      });
    }
  }

  // Generic assignment: value is either the quoted (group 2) or unquoted (group 3) branch.
  for (const match of text.matchAll(GENERIC_ASSIGNMENT)) {
    if (match.index === undefined) continue;
    const value = match[2] ?? match[3];
    if (value === undefined || value.length === 0 || isPlaceholder(value)) continue;
    const offset = match[0].lastIndexOf(value);
    if (offset < 0) continue;
    candidates.push({
      kind: "generic-assignment",
      match: value,
      index: match.index + offset,
      priority: 30,
    });
  }

  // High-entropy standalone strings, claimed only if no other rule covers the span.
  for (const match of text.matchAll(HEX_RUN)) {
    if (match.index === undefined) continue;
    const value = match[0];
    if (value.length === 0) continue;
    candidates.push({
      kind: "high-entropy-string",
      match: value,
      index: match.index,
      priority: 40,
    });
  }
  for (const match of text.matchAll(BASE64_RUN)) {
    if (match.index === undefined) continue;
    const value = match[0];
    if (value.length === 0 || shannonEntropy(value) < BASE64_ENTROPY_THRESHOLD) continue;
    candidates.push({
      kind: "high-entropy-string",
      match: value,
      index: match.index,
      priority: 40,
    });
  }

  const findings = dedupe(candidates);
  return { safe: findings.length === 0, findings };
}

/** Return the text with every detected secret replaced by a placeholder like "[REDACTED:<kind>]". */
export function redact(text: string): string {
  const { findings } = scanForSecrets(text);
  // Replace from the end so earlier offsets stay valid; findings never overlap.
  const ordered = [...findings].sort((a, b) => b.index - a.index);
  let out = text;
  for (const finding of ordered) {
    const start = finding.index;
    const end = finding.index + finding.match.length;
    out = `${out.slice(0, start)}[REDACTED:${finding.kind}]${out.slice(end)}`;
  }
  return out;
}
