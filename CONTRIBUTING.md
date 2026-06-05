# Contributing

Thanks for taking an interest in Auto InstaToon for Codex.

This project is intentionally small. Contributions should keep the app local-first, reviewable, and easy to run on a creator's machine.

## Development Setup

```bash
npm ci
cp .env.example .env.local
npx @openai/codex login
npm run dev
```

Before submitting changes:

```bash
npm run check
```

## Contribution Guidelines

- Keep generated images, private briefs, logs, and tokens out of git.
- Prefer small pull requests with a clear before/after.
- Do not add telemetry, analytics, remote storage, or external upload behavior without a separate design discussion.
- Keep the default server host on `127.0.0.1`.
- If you change prompts, include the reason and a sample output shape.
- If you change the UI, verify the app on a desktop viewport and a narrow mobile viewport.

## Good First Issues

Good starter work includes:

- Improving Korean copy and empty states
- Adding local-only export helpers
- Improving error messages
- Adding focused tests around server parsing helpers
- Improving documentation for non-technical users

## Pull Request Checklist

- [ ] `npm run check` passes.
- [ ] The change does not commit private files or generated media.
- [ ] User-facing copy is clear in Korean and English where relevant.
- [ ] Security and privacy assumptions are unchanged or documented.
- [ ] Screenshots or notes are included for UI changes.
