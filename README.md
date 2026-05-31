# InstaToon Studio for Codex

A local, minimal Instagram carousel comic maker powered by Codex OAuth.

This repo is intentionally small. It does one thing:

1. Turn a Korean brief into a card-by-card instatoon plan.
2. Generate 4:5 post-ready card images.
3. Let the creator review, copy prompts, and download each PNG.

## Run

```bash
npm install
npx @openai/codex login
npm run dev
```

Frontend:

```txt
http://127.0.0.1:3000
```

Local API:

```txt
http://127.0.0.1:8787/api/health
```

## Scripts

```bash
npm run dev
npm run dev:api
npm run dev:web
npm run typecheck
npm run build
```

## Private Files

Do not commit:

- `.env.local`
- generated images
- local logs
- account tokens
- private source material

## License

MIT. See [LICENSE](LICENSE).
