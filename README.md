# Auto InstaToon for Codex

Auto InstaToon is a local-first Codex app that turns a Korean content brief into a 4:5 Instagram carousel comic workflow: card planning, scene direction, dialogue, captions, image prompts, image generation, prompt copy, and PNG download.

The project is intentionally small and easy to audit. It is built for creators, educators, and maintainers who want a practical example of a Codex-powered local creative tool without uploading private drafts to a third-party app server.

## Features

- Korean brief-to-carousel planning
- Card-by-card headline, scene, dialogue, caption, and visual prompt generation
- 4:5 post-ready image generation through the local Codex OAuth proxy
- Local Express API with a Vite React interface
- No external database and no bundled analytics
- Review-first workflow: generated content stays in the browser unless the user downloads it

## Why This Exists

Many Korean creators make educational Instagram carousel comics by moving between notes, prompt drafts, image tools, and manual export steps. Auto InstaToon compresses that workflow into one local interface so creators can inspect every card before rendering images.

For open-source maintainers, this repo is also a compact reference implementation for:

- local Codex OAuth integration
- structured JSON generation for creative planning
- image-generation streaming through a local API
- a small, reviewable React tool surface

## Quick Start

Requirements:

- Node.js 22 or newer
- npm
- A Codex login on the local machine

```bash
npm install
npx @openai/codex login
npm run dev
```

Default URLs:

```txt
Web app:    http://127.0.0.1:3000
Local API:  http://127.0.0.1:8787/api/health
```

To run on a specific web port:

```bash
LOCAL_API_PORT=8787 npm run dev:api
LOCAL_API_PORT=8787 npm run dev:web -- --host 127.0.0.1 --port 3333
```

## Configuration

Copy the example environment file when you need local overrides:

```bash
cp .env.example .env.local
```

Important variables:

```txt
LOCAL_API_HOST=127.0.0.1
LOCAL_API_PORT=8787
CODEX_OAUTH_PROXY_PORT=10531
CODEX_TEXT_MODEL=gpt-5.5
CODEX_IMAGE_MODEL=gpt-5.5
```

Do not commit `.env.local`, account tokens, private briefs, generated client material, or local logs.

## Scripts

```bash
npm run dev        # API and web app together
npm run dev:api    # local API only
npm run dev:web    # Vite web app only
npm run typecheck  # TypeScript check
npm run build      # production build
npm run check      # typecheck + build
```

## Project Structure

```txt
App.tsx            React app and creator workflow UI
index.css          App styling and brand system
server/index.mjs   Local API, Codex OAuth proxy calls, SSE parsing
metadata.json      App metadata
.env.example       Safe local configuration template
```

## Security and Privacy

- The app is designed to run on `127.0.0.1`.
- Generated plans and images are not stored by this repo.
- No telemetry, analytics, or external database is included.
- The server talks to the local Codex OAuth proxy and streams responses back to the browser.
- Security reports should follow [SECURITY.md](SECURITY.md).

## Maintainer Workflow

Before opening a pull request:

```bash
npm ci
npm run check
```

Recommended review checks:

- UI still runs locally through Vite.
- `/api/health` returns a local API status.
- New prompts do not ask for private credentials or private source material.
- Generated files, images, and logs are not committed.

## Roadmap

- Export a full carousel set as a zip
- Add editable card text before rendering
- Add prompt/version history stored locally
- Add optional Korean typography presets
- Add safer retries for long image generations

## License

MIT. See [LICENSE](LICENSE).

## OpenAI Relationship

This is an independent open-source project. It is not an official OpenAI product.
