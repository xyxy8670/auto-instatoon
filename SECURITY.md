# Security Policy

## Supported Versions

Security fixes are accepted for the current `main` branch.

## Reporting a Vulnerability

Please do not open a public issue for a vulnerability that exposes credentials, local files, or private creator material.

Report privately by emailing the maintainer or by using GitHub private vulnerability reporting after the repository is published.

Include:

- affected commit or version
- steps to reproduce
- impact
- whether credentials, local files, or private prompts may be exposed
- any suggested fix

## Scope

In scope:

- local API vulnerabilities
- prompt or response handling that exposes private user content
- unsafe file handling
- dependency vulnerabilities with practical impact
- cross-site scripting in the local UI

Out of scope:

- scans of repositories or systems you do not own or do not have permission to test
- denial-of-service testing against third-party services
- social engineering
- reports based only on automated scanner output without a plausible impact

## Security Design Notes

- The app is intended to bind to `127.0.0.1`.
- There is no database or telemetry in this repository.
- `.env.local`, tokens, generated images, logs, and private briefs should never be committed.
- Codex access is handled through the local OAuth proxy.
