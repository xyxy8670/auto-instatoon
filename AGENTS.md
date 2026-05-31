## Project Identity

InstaToon Studio for Codex is a local AI app for generating 4:5 Instagram carousel comics from topics, documents, and scripts.

## Agent Rules

- Read `README.md`, `package.json`, and `.env.example` before setup or runtime changes.
- Treat this repo as a local app, not a hosted SaaS backend.
- Do not invent secrets, account tokens, API keys, or OAuth credentials.
- Do not commit or expose `.env.local`, local generated outputs, user-uploaded files, exported ZIPs, or `local-project-archive/`.
- Preserve the instatoon-first product direction unless the user asks for broader comic formats.

## Safe Setup Flow

1. Run `npm run setup`.
2. Run `npm install` if dependencies are missing.
3. Ask the user to run `npx @openai/codex login` if Codex OAuth is not available.
4. Run `npm run doctor`.
5. Run `npm run dev`.
6. Verify frontend and backend health.

## Runtime Defaults

- Frontend: `http://localhost:3000`
- Local API: `http://127.0.0.1:8787`
- Health check: `http://127.0.0.1:8787/api/health`
- Codex OAuth proxy: `10531`
