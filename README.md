# InstaToon Studio for Codex

InstaToon Studio for Codex is a local AI production tool for turning notes, PDFs, scripts, and ideas into 4:5 Instagram carousel comics.

It is extracted from the broader comic-studio codebase and tuned for one job: make short Korean instatoon/card-news episodes with consistent characters, style presets, page planning, image generation, and ZIP export.

## What It Makes

- 4:5 instatoon cards for Instagram carousel posts
- Educational explainer comics from PDF/TXT/material uploads
- Short story-to-card episodes with recurring characters
- Multiple visual style samples before committing to a full run
- Local ZIP exports for review, editing, and posting workflows

## Why It Is Different

- **Instatoon-first defaults**: the app opens on the instatoon autopilot flow and defaults to 4:5 card output.
- **Local Codex workflow**: text planning and image generation run through a local backend and your logged-in Codex/OpenAI session.
- **Card-aware planning**: the planner splits longer material into card units and can divide long output into multiple episodes.
- **Style experimentation**: generate small style samples before spending time on the full comic run.
- **Private by default**: local env files, generated outputs, uploads, and project archives are ignored by git.

## Quick Start

Requirements:

- Node.js `22+`
- A working Codex/OpenAI login on the machine that will run generation

Install and prepare local config:

```bash
npm run setup
npm install
npx @openai/codex login
npm run doctor
```

Run the app:

```bash
npm run dev
```

Open the frontend URL printed by Vite. Usually it is:

```txt
http://localhost:3000
```

Check backend health:

```txt
http://127.0.0.1:8787/api/health
```

## Configuration

Create local env config:

```bash
cp .env.example .env.local
```

Important local values:

- `CODEX_OAUTH_PROXY_PORT=10531`
- `LOCAL_API_PORT=8787`
- `LOCAL_API_HOST=127.0.0.1`
- `CODEX_TEXT_MODEL=gpt-5.5`
- `CODEX_IMAGE_MODEL=gpt-5.4-mini`
- `VITE_MAX_PAGE_COUNT=12`
- `LOCAL_API_MAX_PAGE_COUNT=12`

Never commit `.env.local`. It can contain machine-specific local settings.

## Main Pipeline

1. Add a topic, script, or source file.
2. Choose an instatoon style preset or upload a style reference.
3. Let the planner create a card-by-card story structure.
4. Generate final 4:5 card images.
5. Review, retry failed cards, and export a ZIP.

## Useful Commands

```bash
npm run setup
npm run doctor
npm run dev
npm run dev:api
npm run dev:web
npm run typecheck
npm run build
npm run security:check
```

## GitHub Release Checklist

- Add 2-4 screenshots or sample output images under `docs/` or a separate demo folder.
- Run `npm install`.
- Run `npm run typecheck`.
- Run `npm run build`.
- Confirm `.env.local`, generated outputs, uploads, and local archives are not tracked.
- Create a public GitHub repo named `instatoon-studio-codex`.
- Push after checking `git status`.

## Security Notes

- Do not commit `.env.local`.
- Do not commit OAuth tokens, API keys, account cookies, or private source material.
- Do not commit generated private client/user outputs.
- Keep the local API bound to `127.0.0.1` unless you intentionally expose it on a trusted network.

## License

MIT. See [LICENSE](LICENSE).
