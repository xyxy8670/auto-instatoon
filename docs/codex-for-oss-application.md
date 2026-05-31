# Codex for Open Source Application Prep

This file is a maintainer checklist and draft material for the Codex for Open Source application.

Official pages checked on 2026-05-31:

- <https://openai.com/ko-KR/form/codex-for-oss/>
- <https://developers.openai.com/community/codex-for-oss>
- <https://developers.openai.com/codex/codex-for-oss-terms>

## Official Signals to Prepare

- Public GitHub profile
- Public GitHub repository
- Valid ChatGPT account email
- Maintainer role: primary maintainer or core contributor
- Evidence of repository usage, ecosystem importance, and active maintenance
- OpenAI organization ID
- Clear API credit use case
- Agreement with the program terms

## Repo Readiness Checklist

- [x] MIT license
- [x] README with purpose, run instructions, security notes, and roadmap
- [x] Contribution guide
- [x] Security policy
- [x] Code of conduct
- [x] Support guide
- [x] Changelog
- [x] CI workflow
- [x] Dependabot configuration
- [x] Issue templates
- [x] Pull request template
- [x] `.env.example` without secrets
- [x] Build and typecheck scripts
- [x] Add the public GitHub URL to `package.json`
- [x] Publish the repository publicly on GitHub
- [x] Add repository topics on GitHub: `codex`, `openai`, `creator-tools`, `webtoon`, `local-first`
- [ ] Add a short demo GIF or screenshots to the README after publishing
- [ ] Add real usage signals over time: issues, releases, stars, forks, installs, or external mentions

## Draft Form Answers

### GitHub repository URL

```txt
https://github.com/xyxy8670/instatoon-studio-codex
```

### Role

```txt
Primary maintainer
```

### Why this repository is a fit

Under 500 characters:

```txt
InstaToon Studio is a local-first Codex reference app for Korean creators turning briefs into reviewable Instagram carousel comics. It demonstrates maintainer-relevant Codex workflows: structured JSON planning, local OAuth integration, streamed image generation, privacy-conscious defaults, and a small reviewable codebase. I maintain the repo and plan to use Codex for PR review, issue triage, release prep, and security checks.
```

### Interested benefits

Recommended:

```txt
Codex Security
Project API credits
```

### API credit use plan

Under 500 characters:

```txt
I will use API credits for open-source maintainer workflows: testing Codex-assisted PR review, prompt regression checks, issue triage, release-note drafting, and sample carousel generation for reproducible bug reports. Credits will support repository maintenance and documentation examples, not private client work or unauthorized scanning.
```

### Additional note

Under 500 characters:

```txt
The project is intentionally local-first: no telemetry, no database, no committed secrets, and a default 127.0.0.1 server. The repo includes CI, Dependabot, security policy, contribution guide, issue templates, and a roadmap. I can provide repository control verification if needed.
```

## Reality Check

OpenAI says selection may consider repository usage, ecosystem importance, active maintenance, role or permissions, and program capacity. This repo can be made submission-ready, but selection is not guaranteed. The strongest next step is to publish it, add screenshots, tag a release, and collect real public usage signals.
