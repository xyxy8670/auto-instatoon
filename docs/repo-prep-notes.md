# Repo Prep Notes

## Extracted From

- Source folder: `/Users/kimseohyeong/Documents/New project/jadonghwa-comic-studio-codex`
- New repo folder: `/Users/kimseohyeong/Documents/New project/instatoon-studio-codex`

## What Was Kept

- React/Vite frontend
- Local Express backend
- Codex/OpenAI OAuth generation flow
- Instatoon format config and 4:5 layout templates
- Style presets, character tools, planning, rendering, ZIP export, and safety/setup scripts

## What Was Removed

- `.git` history from the source repo
- `node_modules/`
- `dist/`
- `.env.local`
- local logs and PID files
- generated outputs
- local project archive data
- original workspace-local agent skills
- broad legacy docs that were not specific to the instatoon repo

## Product Direction

This repo is now instatoon-first:

- default tab: Instatoon Autopilot
- default publication format: `instatoon`
- default target card count: `6`
- app title: `InstaToon Studio for Codex`
- package name: `instatoon-studio-codex`

## Before First Public Push

- Add screenshots or sample images.
- Confirm the GitHub repo owner/name.
- Add remote:

```bash
git remote add origin https://github.com/YOUR_ID/instatoon-studio-codex.git
```

- Push:

```bash
git branch -M main
git push -u origin main
```
