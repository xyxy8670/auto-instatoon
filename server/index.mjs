import express from "express";
import dotenv from "dotenv";
import { spawn } from "node:child_process";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const app = express();
const PORT = Number.parseInt(process.env.LOCAL_API_PORT || process.env.PORT || "8787", 10);
const HOST = process.env.LOCAL_API_HOST || "127.0.0.1";
const REQUEST_LIMIT = process.env.LOCAL_API_JSON_LIMIT || "80mb";
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.CODEX_REQUEST_TIMEOUT_MS || "600000", 10);
const IMAGE_SIZE = "1088x1360";

const OAUTH_REQUESTED_PORT = Number.parseInt(process.env.CODEX_OAUTH_PROXY_PORT || "10531", 10);
let oauthPort = OAUTH_REQUESTED_PORT;
let oauthProcess = null;
let shuttingDown = false;

const textModel = process.env.CODEX_TEXT_MODEL || "gpt-5.5";
const imageModel = process.env.CODEX_IMAGE_MODEL || "gpt-5.5";

app.use(express.json({ limit: REQUEST_LIMIT }));

const oauthUrl = () => `http://127.0.0.1:${oauthPort}`;

const clean = (value, max = 5000) =>
  String(value || "")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, max);

const readSseText = async (response) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  const handle = (block) => {
    const line = block
      .split(/\n/)
      .find((item) => item.startsWith("data:"));
    const data = line?.replace(/^data:\s*/, "");
    if (!data || data === "[DONE]") return;
    const parsed = JSON.parse(data);
    if (parsed.type === "response.output_text.delta") text += parsed.delta || "";
    if (parsed.type === "response.output_text.done") text = parsed.text || text;
    if (parsed.type === "response.completed" && !text && typeof parsed.response?.output_text === "string") {
      text = parsed.response.output_text;
    }
    if (parsed.type === "error") throw new Error(parsed.error?.message || "Codex stream error");
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      handle(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  }
  if (buffer.trim()) handle(buffer);
  return text.trim();
};

const readSseImage = async (response) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let image = "";

  const handle = (block) => {
    const line = block
      .split(/\n/)
      .find((item) => item.startsWith("data:"));
    const data = line?.replace(/^data:\s*/, "");
    if (!data || data === "[DONE]") return;
    const parsed = JSON.parse(data);
    if (parsed.type === "response.output_item.done" && parsed.item?.type === "image_generation_call") {
      image = parsed.item.result || image;
    }
    if (parsed.type === "response.completed" && !image) {
      for (const item of parsed.response?.output || []) {
        if (item?.type === "image_generation_call" && item.result) image = item.result;
      }
    }
    if (parsed.type === "error") throw new Error(parsed.error?.message || "Codex image stream error");
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      handle(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  }
  if (buffer.trim()) handle(buffer);
  return image ? `data:image/png;base64,${image}` : "";
};

const codexFetch = async (body) => {
  const response = await fetch(`${oauthUrl()}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const auth = response.status === 401 || response.status === 403;
    throw Object.assign(
      new Error(auth ? "Codex 로그인이 필요합니다. `npx @openai/codex login`을 확인하세요." : detail || `Codex request failed (${response.status})`),
      { status: response.status }
    );
  }
  return response;
};

const planSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "audience", "thesis", "cards"],
  properties: {
    title: { type: "string" },
    audience: { type: "string" },
    thesis: { type: "string" },
    cards: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["headline", "scene", "dialogue", "caption", "visualPrompt"],
        properties: {
          headline: { type: "string" },
          scene: { type: "string" },
          dialogue: { type: "string" },
          caption: { type: "string" },
          visualPrompt: { type: "string" }
        }
      }
    }
  }
};

const stylePrompt = (style) => {
  const styles = {
    serialized: "Korean serialized webtoon episode panel, muted cel shading, casual crops, speech bubbles, not a poster.",
    clean: "Clean pastel Korean webtoon card, crisp lines, simple symbolic backgrounds, high readability.",
    marker: "Warm marker sketch comic, paper texture, expressive rough lines, handmade education note mood.",
    finance: "Modern finance explainer comic, calm professional palette, charts as background props, friendly characters."
  };
  return styles[style] || styles.serialized;
};

const toneText = (tone) => {
  const tones = { clear: "clear and concise", warm: "warm and encouraging", sharp: "direct and insight-driven", funny: "light and witty" };
  return tones[tone] || tones.clear;
};

const startOAuth = () => {
  if (oauthProcess) return;
  oauthProcess = spawn("npx", ["openai-oauth", "--port", String(OAUTH_REQUESTED_PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env }
  });

  oauthProcess.stdout.on("data", (chunk) => {
    const message = chunk.toString().trim();
    const fallback = /Using port\s+(\d+)\s+instead/i.exec(message)?.[1];
    const ready = /127\.0\.0\.1:(\d+)\/v1/i.exec(message)?.[1];
    const nextPort = Number.parseInt(ready || fallback || "", 10);
    if (Number.isFinite(nextPort) && nextPort > 0) oauthPort = nextPort;
    if (message) console.log(`[codex-oauth] ${message}`);
  });

  oauthProcess.stderr.on("data", (chunk) => {
    const message = chunk.toString().trim();
    if (message && !message.includes("npm warn")) console.error(`[codex-oauth] ${message}`);
  });

  oauthProcess.on("exit", () => {
    oauthProcess = null;
    if (!shuttingDown) setTimeout(startOAuth, 2000);
  });
};

const oauthStatus = async () => {
  try {
    const response = await fetch(`${oauthUrl()}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return { status: "auth_required", models: [] };
    const json = await response.json();
    return { status: "ready", models: (json.data || []).map((item) => item.id).filter(Boolean) };
  } catch {
    return { status: "starting", models: [] };
  }
};

app.get("/api/health", (_req, res) => {
  res.json({
    app: "auto-instatoon",
    local_api: "ready",
    oauth_url: oauthUrl(),
    oauth_port: oauthPort,
    text_model: textModel,
    image_model: imageModel,
    image_size: IMAGE_SIZE
  });
});

app.get("/api/oauth/status", async (_req, res) => {
  res.json(await oauthStatus());
});

app.post("/api/instatoon/plan", async (req, res) => {
  try {
    const brief = clean(req.body?.brief, 12000);
    const cardCount = Math.max(3, Math.min(12, Number.parseInt(req.body?.cardCount || "6", 10)));
    const tone = clean(req.body?.tone, 40) || "clear";
    const style = clean(req.body?.style, 40) || "serialized";
    if (!brief) return res.status(400).json({ error: "brief is required" });

    const response = await codexFetch({
      model: textModel,
      input: [
        {
          role: "developer",
          content: "You are a Korean Instagram carousel comic director. Return production-ready JSON only."
        },
        {
          role: "user",
          content: `Create exactly ${cardCount} Korean 4:5 instatoon cards.\nTone: ${toneText(tone)}.\nStyle: ${stylePrompt(style)}.\nBrief:\n${brief}\n\nEach card needs headline, scene, dialogue, caption, and visualPrompt. Keep Korean text short enough for mobile.`
        }
      ],
      stream: true,
      text: { format: { type: "json_schema", name: "instatoon_plan", strict: true, schema: planSchema } },
      reasoning: { effort: "medium" }
    });
    const text = await readSseText(response);
    res.json(JSON.parse(text));
  } catch (error) {
    res.status(error.status || 500).json({ error: clean(error.message, 800) });
  }
});

app.post("/api/instatoon/image", async (req, res) => {
  try {
    const title = clean(req.body?.title, 300);
    const thesis = clean(req.body?.thesis, 1000);
    const style = clean(req.body?.style, 40) || "serialized";
    const quality = ["medium", "high"].includes(req.body?.quality) ? req.body.quality : "high";
    const card = req.body?.card || {};
    const prompt = `Create one final post-ready Korean Instagram instatoon card.

Canvas: ${IMAGE_SIZE}px, 4:5 vertical.
Series title: ${title}
Series thesis: ${thesis}
Card number: ${card.index}
Headline text: "${clean(card.headline, 120)}"
Dialogue text: "${clean(card.dialogue, 180)}"
Caption text: "${clean(card.caption, 180)}"
Scene: ${clean(card.scene, 600)}
Visual direction: ${clean(card.visualPrompt, 800)}
Style: ${stylePrompt(style)}

Rules:
- readable Korean text only
- 1 to 3 comic beats maximum
- no brand logos, no watermark, no fake app UI
- no huge paragraph text
- finished image, not a mockup`;

    const response = await codexFetch({
      model: imageModel,
      input: [
        { role: "developer", content: "Use the image_generation tool and return one image." },
        { role: "user", content: prompt }
      ],
      tools: [{ type: "image_generation", size: IMAGE_SIZE, quality, moderation: "low" }],
      tool_choice: "required",
      stream: true
    });
    const imageUrl = await readSseImage(response);
    if (!imageUrl) throw new Error("이미지 응답이 비어 있습니다.");
    res.json({ imageUrl });
  } catch (error) {
    res.status(error.status || 500).json({ error: clean(error.message, 800) });
  }
});

process.once("SIGINT", () => {
  shuttingDown = true;
  oauthProcess?.kill();
  process.exit(0);
});

process.once("SIGTERM", () => {
  shuttingDown = true;
  oauthProcess?.kill();
  process.exit(0);
});

startOAuth();

app.listen(PORT, HOST, () => {
  console.log(`[api] Auto InstaToon on http://${HOST}:${PORT}`);
  console.log(`[api] Codex OAuth ${oauthUrl()}`);
});
