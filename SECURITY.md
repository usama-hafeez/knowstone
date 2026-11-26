# Security Policy

Knowstone is designed to be safe by default:

- **Local-first.** It runs on your machine and does not send your source code,
  file contents, or project data to any external service. No embedding API, no
  telemetry, no network calls in the core path.
- **Never caches secrets.** A secret-scan guard runs before anything is written to the
  cache; anything matching secret patterns (`.env`, keys, tokens, high-entropy strings)
  is refused or redacted, never stored.
- **Read-only by default.** It analyses your code and writes only to its own local cache.
  It does not modify project files or run destructive commands. Any action that runs a
  command (for example re-verifying a finding against a test) is explicit.
- **Per-project isolation.** One project's cache is never served to another.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Instead, report it privately
through the repository's security advisory feature (GitHub → Security → Report a
vulnerability). Include steps to reproduce and the affected version. We aim to
acknowledge reports within a few days.

Do not include real secrets, tokens, or private source in a report.
