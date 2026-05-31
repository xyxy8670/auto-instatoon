import express from "express";
import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { PDFParse } from "pdf-parse";
import { PDFDocument } from "pdf-lib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config({ path: path.join(process.cwd(), ".env") });

const PORT = Number.parseInt(process.env.LOCAL_API_PORT || process.env.PORT || "8787", 10);
const HOST = String(process.env.LOCAL_API_HOST || process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
const JSON_LIMIT = process.env.LOCAL_API_JSON_LIMIT || "2gb";
const PROJECT_ARCHIVE_PATH = path.resolve(
  process.env.LOCAL_PROJECT_ARCHIVE_PATH || path.join(process.cwd(), "local-project-archive", "projects.json")
);
const PIPELINE_RUNS_PATH = path.resolve(
  process.env.LOCAL_PIPELINE_RUNS_PATH || path.join(process.cwd(), "local-project-archive", "pipeline-runs.jsonl")
);
const STYLE_SAMPLE_ARCHIVE_DIR = path.resolve(
  process.env.LOCAL_STYLE_SAMPLE_ARCHIVE_DIR || path.join(process.cwd(), "local-project-archive", "style-samples")
);
const STYLE_SAMPLE_ARCHIVE_PATH = path.join(STYLE_SAMPLE_ARCHIVE_DIR, "style-samples.json");
const STYLE_SAMPLE_ASSET_DIR = path.join(STYLE_SAMPLE_ARCHIVE_DIR, "assets");
const CODEX_OAUTH_PROXY_PORT = Number.parseInt(
  process.env.CODEX_OAUTH_PROXY_PORT || process.env.OAUTH_PORT || "10531",
  10
);
let activeCodexOAuthPort = CODEX_OAUTH_PROXY_PORT;
const getCodexOAuthUrl = () => `http://127.0.0.1:${activeCodexOAuthPort}`;
const CODEX_OAUTH_AUTOSTART = !/^(1|true|yes)$/i.test(String(process.env.CODEX_NO_OAUTH_PROXY || ""));
const CODEX_DEFAULT_IMAGE_MODEL = String(process.env.CODEX_IMAGE_MODEL || "gpt-5.5").trim() || "gpt-5.5";
const CODEX_DEFAULT_TEXT_MODEL = String(process.env.CODEX_TEXT_MODEL || "gpt-5.5").trim() || "gpt-5.5";
const CODEX_DEFAULT_MODERATION = String(process.env.CODEX_IMAGE_MODERATION || "low").trim() || "low";
const CODEX_VALID_IMAGE_MODELS = new Set(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);
const CODEX_VALID_TEXT_MODELS = new Set(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);
const CODEX_IMAGE_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.CODEX_IMAGE_REQUEST_TIMEOUT_MS || `${8 * 60 * 1000}`, 10);
const CODEX_TEXT_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.CODEX_TEXT_REQUEST_TIMEOUT_MS || `${10 * 60 * 1000}`, 10);
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
const GEMINI_TEXT_MODEL = String(process.env.GEMINI_TEXT_MODEL || "gemini-3-pro-preview").trim() || "gemini-3-pro-preview";
const GEMINI_API_BASE_URL = String(process.env.GEMINI_API_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
const GEMINI_UPLOAD_BASE_URL = String(
  process.env.GEMINI_UPLOAD_BASE_URL ||
    GEMINI_API_BASE_URL.replace(/\/(v1beta|v1alpha|v1)$/, "/upload/$1")
).replace(/\/+$/, "");
const GEMINI_FILE_API_INLINE_MAX_BYTES = Number.parseInt(
  process.env.GEMINI_FILE_API_INLINE_MAX_BYTES || `${18 * 1024 * 1024}`,
  10
);
const GEMINI_PDF_MAX_BYTES = Number.parseInt(
  process.env.GEMINI_PDF_MAX_BYTES || `${50 * 1024 * 1024}`,
  10
);
const GEMINI_PDF_TEXT_FALLBACK_MAX_CHARS = Number.parseInt(
  process.env.GEMINI_PDF_TEXT_FALLBACK_MAX_CHARS || "120000",
  10
);
const GEMINI_PDF_SPLIT_TARGET_BYTES = Number.parseInt(
  process.env.GEMINI_PDF_SPLIT_TARGET_BYTES || `${45 * 1024 * 1024}`,
  10
);
const GEMINI_PDF_SPLIT_MAX_PARTS = Number.parseInt(
  process.env.GEMINI_PDF_SPLIT_MAX_PARTS || "12",
  10
);
const GEMINI_FILE_API_ALWAYS_UPLOAD_PDFS = !/^(0|false|no)$/i.test(
  String(process.env.GEMINI_FILE_API_ALWAYS_UPLOAD_PDFS || "true")
);
const GPT_IMAGE_DIMENSION_STEP = 16;
const GPT_IMAGE_MAX_EDGE = 3840;
const GPT_IMAGE_MAX_PIXELS = 8_294_400;
const GPT_IMAGE_MIN_PIXELS = 655_360;
const GPT_IMAGE_MAX_LONG_TO_SHORT_RATIO = 3;

const parseJsonSafe = (value) => {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const sanitizeErrorMessage = (message) => String(message || "").replace(/\s+/g, " ").trim().slice(0, 280);

const createRequestId = () => `req_${crypto.randomUUID().slice(0, 8)}`;

const getRequestId = (req) => {
  const fromHeader = String(req.get?.("x-request-id") || "").trim();
  return fromHeader || createRequestId();
};

const markError = (err, details = {}) => {
  Object.assign(err, details);
  return err;
};

const makeApiErrorPayload = (error, fallbackMessage, requestId) => ({
  error: {
    message: sanitizeErrorMessage(error?.message) || fallbackMessage,
    code: error?.code || "REQUEST_FAILED",
    category: error?.category || "unknown",
    retryable: error?.retryable === true,
    request_id: requestId
  }
});

const summarizeCodexOutputItems = (items) => {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 12).map((item) => ({
    type: item?.type || "unknown",
    status: item?.status || item?.state || "",
    has_result: typeof item?.result === "string" && item.result.length > 0,
    error_code: item?.error?.code || item?.last_error?.code || "",
    error_message: sanitizeErrorMessage(item?.error?.message || item?.last_error?.message || "")
  }));
};

const normalizeFetchFailure = (error, fallbackMessage, code, category) => {
  const message = sanitizeErrorMessage(error?.message) || fallbackMessage;
  const timeout = error?.name === "TimeoutError" || /aborted|timeout|timed out/i.test(message);
  return markError(new Error(timeout ? "Codex OAuth 요청 시간이 너무 길어져 중단했어. 다시 시도하거나 해상도/품질을 낮춰줘." : message), {
    status: 504,
    code: timeout ? "CODEX_OAUTH_TIMEOUT" : code,
    category: timeout ? "timeout" : category,
    retryable: true
  });
};

const ensureParentDir = async (filePath) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
};

const readProjectArchive = async () => {
  try {
    const raw = await fs.readFile(PROJECT_ARCHIVE_PATH, "utf8");
    const parsed = parseJsonSafe(raw);
    return Array.isArray(parsed?.projects) ? parsed.projects : Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
};

const writeProjectArchive = async (projects) => {
  if (!Array.isArray(projects)) {
    const err = new Error("Project archive payload must include a projects array.");
    err.status = 400;
    throw err;
  }
  await ensureParentDir(PROJECT_ARCHIVE_PATH);
  const payload = {
    version: 1,
    updated_at: new Date().toISOString(),
    projects
  };
  const tmpPath = `${PROJECT_ARCHIVE_PATH}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmpPath, PROJECT_ARCHIVE_PATH);
};

const sanitizeStyleSampleId = (value) => {
  const sanitized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return sanitized || `style_${crypto.randomUUID().slice(0, 8)}`;
};

const sanitizeStyleSampleResult = (value) => {
  const input = value && typeof value === "object" ? value : {};
  const presetId = sanitizeStyleSampleId(input.presetId);
  const status = ["idle", "running", "success", "error"].includes(input.status) ? input.status : "idle";
  return {
    presetId,
    status: status === "running" ? "idle" : status,
    prompt: typeof input.prompt === "string" ? input.prompt.slice(0, 4000) : undefined,
    imageUrl: typeof input.imageUrl === "string" ? input.imageUrl : undefined,
    error: typeof input.error === "string" ? sanitizeErrorMessage(input.error) : undefined,
    startedAt: Number.isFinite(input.startedAt) ? input.startedAt : undefined,
    completedAt: Number.isFinite(input.completedAt) ? input.completedAt : undefined
  };
};

const readStyleSampleArchive = async () => {
  try {
    const raw = await fs.readFile(STYLE_SAMPLE_ARCHIVE_PATH, "utf8");
    const parsed = parseJsonSafe(raw);
    const results = {};
    if (parsed?.results && typeof parsed.results === "object") {
      for (const rawResult of Object.values(parsed.results)) {
        const result = sanitizeStyleSampleResult(rawResult);
        results[result.presetId] = result;
      }
    }
    return {
      prompt: typeof parsed?.prompt === "string" ? parsed.prompt : undefined,
      results
    };
  } catch (e) {
    if (e?.code === "ENOENT") return { results: {} };
    throw e;
  }
};

const writeStyleSampleArchive = async (archive) => {
  await ensureParentDir(STYLE_SAMPLE_ARCHIVE_PATH);
  const payload = {
    version: 1,
    updated_at: new Date().toISOString(),
    prompt: typeof archive?.prompt === "string" ? archive.prompt : "",
    results: archive?.results && typeof archive.results === "object" ? archive.results : {}
  };
  const tmpPath = `${STYLE_SAMPLE_ARCHIVE_PATH}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmpPath, STYLE_SAMPLE_ARCHIVE_PATH);
};

const persistStyleSampleImage = async (presetId, imageUrl) => {
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,([\s\S]+)$/i.exec(String(imageUrl || ""));
  if (!match) return imageUrl;
  const extension = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  const fileName = `${sanitizeStyleSampleId(presetId)}.${extension}`;
  const filePath = path.join(STYLE_SAMPLE_ASSET_DIR, fileName);
  await fs.mkdir(STYLE_SAMPLE_ASSET_DIR, { recursive: true });
  await fs.writeFile(filePath, Buffer.from(match[2], "base64"));
  return `/archive-assets/style-samples/assets/${fileName}`;
};

const sanitizePipelineRunEntry = (value) => {
  const input = value && typeof value === "object" ? value : {};
  const elapsedMs = Number(input.elapsed_ms ?? input.elapsedMs ?? 0);
  const pageIndex = Number(input.page_index ?? input.pageIndex ?? 0);
  return {
    run_id: sanitizeErrorMessage(input.run_id ?? input.runId ?? createRequestId()),
    stage: sanitizeErrorMessage(input.stage ?? "unknown"),
    attempt: Math.max(1, Math.min(5, Number.parseInt(String(input.attempt ?? 1), 10) || 1)),
    status: sanitizeErrorMessage(input.status ?? "info"),
    message: sanitizeErrorMessage(input.message ?? ""),
    request_id: sanitizeErrorMessage(input.request_id ?? input.requestId ?? ""),
    category: sanitizeErrorMessage(input.category ?? ""),
    elapsed_ms: Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs)) : 0,
    page_index: Number.isFinite(pageIndex) && pageIndex > 0 ? Math.floor(pageIndex) : undefined,
    created_at: Date.now()
  };
};

const appendPipelineRunEntry = async (entry) => {
  await ensureParentDir(PIPELINE_RUNS_PATH);
  await fs.appendFile(PIPELINE_RUNS_PATH, `${JSON.stringify(sanitizePipelineRunEntry(entry))}\n`, "utf8");
};

const readRecentPipelineRuns = async (limit = 80) => {
  try {
    const raw = await fs.readFile(PIPELINE_RUNS_PATH, "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(300, limit)))
      .map((line) => parseJsonSafe(line))
      .filter(Boolean)
      .reverse();
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
};

const normalizeReferenceKind = (kind) => {
  const requested = String(kind || "").trim();
  return [
    "character_identity",
    "style_reference",
    "style_consistency",
    "product_reference"
  ].includes(requested)
    ? requested
    : "generic_reference";
};

const normalizeReferenceItems = (referenceImages) => {
  if (!Array.isArray(referenceImages)) return [];
  return referenceImages
    .map((item) => {
      if (typeof item === "string") {
        const imageUrl = item.trim();
        return imageUrl ? { kind: "generic_reference", label: "", imageUrl } : null;
      }

      const imageUrl = String(item?.image_url || item?.imageUrl || item?.url || item?.dataUrl || "").trim();
      if (!imageUrl) return null;
      return {
        kind: normalizeReferenceKind(item?.kind || item?.role || item?.type),
        label: sanitizeErrorMessage(item?.label || ""),
        imageUrl
      };
    })
    .filter(Boolean)
    .slice(0, 5);
};

const describeReferenceItem = (item, index) => {
  const prefix = `Reference image ${index + 1}${item.label ? ` (${item.label})` : ""}:`;
  if (item.kind === "character_identity") {
    return `${prefix} direct character reference. Keep the character recognizable and render them in the selected style from the prompt.`;
  }
  if (item.kind === "style_reference") {
    return `${prefix} style reference. Use linework, palette, shading, texture, and finish.`;
  }
  if (item.kind === "style_consistency") {
    return `${prefix} style continuity reference. Match rendering pipeline and finish level.`;
  }
  if (item.kind === "product_reference") {
    return `${prefix} product reference. Preserve product shape, color, material, and key details.`;
  }
  return `${prefix} visual reference for the prompt.`;
};

const isCodexSafetyRefusal = (error) => {
  const message = String(error?.message || "").toLowerCase();
  const code = String(error?.code || "").toLowerCase();
  return (
    message.includes("safety") ||
    message.includes("safety_violations") ||
    message.includes("sexual") ||
    message.includes("moderation") ||
    message.includes("rejected") ||
    message.includes("refused") ||
    code.includes("safety") ||
    code.includes("moderation")
  );
};

const buildCodexSafetyFallbackPrompt = (prompt) => `${prompt}

[SAFER VISUAL FALLBACK - IMPORTANT]
Regenerate the same comic/page with a clearer age-appropriate visual context: sports, leisure, fashion editorial, apparel catalog, or instruction.
- Preserve the educational meaning, layout, characters, and speech-bubble text exactly whenever possible. Change the visual staging, not the safe educational wording.
- Treat speech-bubble text and product/category labels as typography to render.
- If the topic is swimwear, keep it clearly about adult swimwear, swimming/sportswear, beachwear, fashion editorial, or apparel comparison. The presenter/model, if any, is clearly an adult.
- For swimwear type comparisons, product boards, hangers, mannequins, flat product diagrams, or worn examples are all valid when the adult/apparel context is clear.
- If any character is a child, student, teen, or minor, keep them in ordinary public clothing and use abstract charts/icons instead of modeling body-focused clothing or anatomy.
- Use full-body or waist-up composition with normal fashion, sports, leisure, store, pool, beach, or classroom staging.
- Choose the safer visual metaphor whenever wording could be ambiguous.`;

const extractSseData = (block) => {
  let eventData = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("data: ")) eventData += line.slice(6);
  }
  return eventData;
};

const normalizeCodexImageModel = (model) => {
  const requested = String(model || "").trim();
  if (!requested) return CODEX_DEFAULT_IMAGE_MODEL;
  return CODEX_VALID_IMAGE_MODELS.has(requested) ? requested : CODEX_DEFAULT_IMAGE_MODEL;
};

const normalizeCodexTextModel = (model) => {
  const requested = String(model || "").trim();
  if (!requested) return CODEX_DEFAULT_TEXT_MODEL;
  return CODEX_VALID_TEXT_MODELS.has(requested) ? requested : CODEX_DEFAULT_TEXT_MODEL;
};

const normalizeReasoningEffort = (value) => {
  const requested = String(value || "").trim().toLowerCase();
  return ["low", "medium", "high"].includes(requested) ? requested : "high";
};

const normalizeMaxOutputTokens = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(100_000, Math.floor(parsed));
};

const validateCodexImageSize = (size) => {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return "Expected WIDTHxHEIGHT.";
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const pixels = width * height;

  if (width % GPT_IMAGE_DIMENSION_STEP !== 0 || height % GPT_IMAGE_DIMENSION_STEP !== 0) {
    return "Both edges must be multiples of 16px.";
  }
  if (longEdge > GPT_IMAGE_MAX_EDGE) {
    return "Maximum edge length is 3840px.";
  }
  if (longEdge / shortEdge > GPT_IMAGE_MAX_LONG_TO_SHORT_RATIO) {
    return "Long edge to short edge ratio must not exceed 3:1.";
  }
  if (pixels < GPT_IMAGE_MIN_PIXELS || pixels > GPT_IMAGE_MAX_PIXELS) {
    return "Total pixels must be between 655360 and 8294400.";
  }
  return null;
};

let codexOAuthChild = null;
let codexOAuthShuttingDown = false;

const startCodexOAuthProxy = () => {
  if (!CODEX_OAUTH_AUTOSTART || codexOAuthChild) return;

  console.log(`[codex-oauth] starting openai-oauth on port ${CODEX_OAUTH_PROXY_PORT}...`);
  codexOAuthChild = spawn("npx", ["openai-oauth", "--port", String(CODEX_OAUTH_PROXY_PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env }
  });

  codexOAuthChild.stdout.on("data", (chunk) => {
    const message = chunk.toString().trim();
    const fallbackPort = /Using port\s+(\d+)\s+instead/i.exec(message)?.[1];
    const readyPort = /endpoint ready at http:\/\/127\.0\.0\.1:(\d+)\/v1/i.exec(message)?.[1];
    const nextPort = Number.parseInt(readyPort || fallbackPort || "", 10);
    if (Number.isFinite(nextPort) && nextPort > 0) activeCodexOAuthPort = nextPort;
    if (message) console.log(`[codex-oauth] ${message}`);
  });
  codexOAuthChild.stderr.on("data", (chunk) => {
    const message = chunk.toString().trim();
    if (message && !message.includes("npm warn")) console.error(`[codex-oauth] ${message}`);
  });
  codexOAuthChild.on("exit", (code) => {
    codexOAuthChild = null;
    if (codexOAuthShuttingDown || !CODEX_OAUTH_AUTOSTART) return;
    console.warn(`[codex-oauth] exited with code ${code}; restarting in 5s...`);
    setTimeout(startCodexOAuthProxy, 5000);
  });
};

const stopCodexOAuthProxy = () => {
  codexOAuthShuttingDown = true;
  try {
    codexOAuthChild?.kill();
  } catch {
    // Best effort during server shutdown.
  }
};

process.once("SIGINT", () => {
  stopCodexOAuthProxy();
  process.exit(0);
});
process.once("SIGTERM", () => {
  stopCodexOAuthProxy();
  process.exit(0);
});

const getCodexOAuthStatus = async () => {
  try {
    const response = await fetch(`${getCodexOAuthUrl()}/v1/models`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) return { status: "auth_required", models: [] };
    const data = await response.json();
    const models = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : [];
    return { status: "ready", models };
  } catch {
    return { status: CODEX_OAUTH_AUTOSTART ? "starting" : "offline", models: [] };
  }
};

const CODEX_IMAGE_DEVELOPER_PROMPT = [
  "You are an image generation assistant for a local comic production app.",
  "Your sole function is to invoke the image_generation tool and return an image.",
  "Follow the user's comic page prompt closely. Preserve Korean text exactly when requested.",
  "Do not add logos, watermarks, signatures, or UI elements.",
  "Prioritize clean linework, readable speech bubbles, consistent character identity, and stable multi-panel composition.",
  "Respect per-image reference role labels. Character references are identity-only unless the user prompt says otherwise; style must come from the prompt's STYLE instructions.",
  "You may use web_search only to ground current real-world details when helpful, but you must always finish by invoking the image_generation tool.",
  "Just do it."
].join(" ");

const CODEX_PROMPT_FIDELITY_SUFFIX =
  "\n\nWhen you call the image_generation tool, use the user's prompt as the primary image prompt. Do not translate, summarize, restyle, or inject extra story details. If the prompt contains Korean text, keep it in Korean.";

const readCodexImageStream = async (response) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let imageB64 = null;
  let revisedPrompt = null;
  let usage = null;
  const outputItems = [];
  let responseStatus = "";
  let incompleteReason = "";

  const handleBlock = (block) => {
    const eventData = extractSseData(block);
    if (!eventData || eventData === "[DONE]") return;

    const data = parseJsonSafe(eventData);
    if (!data) return;
    if (data.type === "response.output_item.done" && data.item?.type === "image_generation_call") {
      outputItems.push(data.item);
      if (typeof data.item.result === "string" && data.item.result) imageB64 = data.item.result;
      if (typeof data.item.revised_prompt === "string" && data.item.revised_prompt) {
        revisedPrompt = data.item.revised_prompt;
      }
    }
    if (data.type === "response.output_item.done" && data.item?.type !== "image_generation_call") {
      outputItems.push(data.item);
    }
    if (data.type === "response.completed") {
      usage = data.response?.usage || null;
      responseStatus = data.response?.status || "completed";
      incompleteReason = data.response?.incomplete_details?.reason || "";
      if (Array.isArray(data.response?.output)) outputItems.push(...data.response.output);
    }
    if (data.type === "error") {
      const err = new Error(sanitizeErrorMessage(data.error?.message) || "Codex OAuth stream returned an error.");
      err.code = data.error?.code || "CODEX_OAUTH_STREAM_ERROR";
      err.category = "stream";
      err.retryable = true;
      throw err;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      handleBlock(block);
    }
  }

  if (buffer.trim()) handleBlock(buffer);
  return {
    imageB64,
    revisedPrompt,
    usage,
    diagnostics: {
      response_status: responseStatus,
      incomplete_reason: incompleteReason,
      output_items: summarizeCodexOutputItems(outputItems)
    }
  };
};

const readCodexImageJson = (json) => {
  let imageB64 = null;
  let revisedPrompt = null;

  for (const item of json?.output || []) {
    if (item?.type !== "image_generation_call") continue;
    if (typeof item.result === "string" && item.result) imageB64 = item.result;
    if (typeof item.revised_prompt === "string" && item.revised_prompt) {
      revisedPrompt = item.revised_prompt;
    }
    if (imageB64) break;
  }

  return {
    imageB64,
    revisedPrompt,
    usage: json?.usage || null,
    diagnostics: {
      response_status: json?.status || "",
      incomplete_reason: json?.incomplete_details?.reason || "",
      output_items: summarizeCodexOutputItems(json?.output)
    }
  };
};

const throwCodexImageHttpError = async (response) => {
  const rawText = await response.text();
  const parsed = parseJsonSafe(rawText);
  const message = sanitizeErrorMessage(parsed?.error?.message || rawText) || `Codex OAuth image request failed (${response.status}).`;
  const err = new Error(
    response.status === 401 || response.status === 403
      ? "Codex 로그인이 필요하거나 권한이 부족해. `npx @openai/codex login`을 확인해줘."
      : message
  );
  err.status = response.status;
  err.code = parsed?.error?.code || `CODEX_IMAGE_HTTP_${response.status}`;
  err.category =
    response.status === 401 || response.status === 403
      ? "auth"
      : response.status === 429
        ? "rate_limit"
        : response.status >= 500
          ? "upstream"
          : "http";
  err.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  throw err;
};

const generateCodexImage = async ({ prompt, size, quality, moderation, model, referenceImages, requestId }) => {
  const resolvedModel = normalizeCodexImageModel(model);
  const validReferenceItems = normalizeReferenceItems(referenceImages);
  const userContent = validReferenceItems.length > 0
    ? [
        {
          type: "input_text",
          text: "Use the attached images as visual references for the prompt."
        },
        ...validReferenceItems.flatMap((item, index) => [
          { type: "input_text", text: describeReferenceItem(item, index) },
          { type: "input_image", image_url: item.imageUrl }
        ]),
        { type: "input_text", text: `${prompt}${CODEX_PROMPT_FIDELITY_SUFFIX}` }
      ]
    : `${prompt}${CODEX_PROMPT_FIDELITY_SUFFIX}`;
  const buildRequestBody = (stream) => ({
    model: resolvedModel,
    input: [
      { role: "developer", content: CODEX_IMAGE_DEVELOPER_PROMPT },
      { role: "user", content: userContent }
    ],
    tools: [
      { type: "web_search" },
      {
        type: "image_generation",
        quality,
        size,
        moderation
      }
    ],
    tool_choice: "required",
    stream
  });

  let response;
  try {
    response = await fetch(`${getCodexOAuthUrl()}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", "X-Request-Id": requestId || createRequestId() },
      body: JSON.stringify(buildRequestBody(true)),
      signal: AbortSignal.timeout(CODEX_IMAGE_REQUEST_TIMEOUT_MS)
    });
  } catch (e) {
    throw normalizeFetchFailure(e, "Codex OAuth image request failed.", "CODEX_IMAGE_NETWORK_ERROR", "network");
  }

  if (!response.ok) await throwCodexImageHttpError(response);

  const contentType = response.headers.get("content-type") || "";
  let imageReadResult;
  try {
    imageReadResult = contentType.includes("text/event-stream")
      ? await readCodexImageStream(response)
      : readCodexImageJson(await response.json());
  } catch (e) {
    throw normalizeFetchFailure(e, "Codex OAuth image response could not be read.", "CODEX_IMAGE_READ_ERROR", "network");
  }
  let { imageB64, revisedPrompt, usage, diagnostics } = imageReadResult;

  if (!imageB64) {
    console.warn("[codex-oauth] image stream contained no image; retrying as JSON", {
      request_id: requestId,
      model: resolvedModel,
      size,
      quality,
      diagnostics
    });
    let retryResponse;
    try {
      retryResponse = await fetch(`${getCodexOAuthUrl()}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Request-Id": requestId || createRequestId() },
        body: JSON.stringify(buildRequestBody(false)),
        signal: AbortSignal.timeout(CODEX_IMAGE_REQUEST_TIMEOUT_MS)
      });
    } catch (e) {
      throw normalizeFetchFailure(e, "Codex OAuth image retry failed.", "CODEX_IMAGE_RETRY_NETWORK_ERROR", "network");
    }

    if (!retryResponse.ok) await throwCodexImageHttpError(retryResponse);

    try {
      ({ imageB64, revisedPrompt, usage, diagnostics } = readCodexImageJson(await retryResponse.json()));
    } catch (e) {
      throw normalizeFetchFailure(e, "Codex OAuth image retry response could not be read.", "CODEX_IMAGE_RETRY_READ_ERROR", "network");
    }
  }
  if (!imageB64) {
    throw markError(
      new Error("이미지 응답은 도착했지만 실제 이미지 데이터가 비어 있어. 다시 시도하거나 해상도/품질/참조 이미지를 낮춰줘."),
      {
        status: 502,
        code: "CODEX_IMAGE_EMPTY",
        category: "no_image",
        retryable: true,
        diagnostics
      }
    );
  }
  return {
    image_data_url: "data:image/png;base64," + imageB64,
    revised_prompt: revisedPrompt,
    usage,
    model: resolvedModel
  };
};

const extractCodexText = (json) => {
  if (typeof json?.output_text === "string") return json.output_text;
  for (const item of json?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") return content.text;
      if (typeof content?.value === "string") return content.value;
    }
  }
  return "";
};

const readCodexTextStream = async (response) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage = null;

  const handleBlock = (block) => {
    const eventData = extractSseData(block);
    if (!eventData || eventData === "[DONE]") return;

    const data = parseJsonSafe(eventData);
    if (!data) return;

    if (data.type === "response.output_text.delta" && typeof data.delta === "string") {
      text += data.delta;
    }
    if (data.type === "response.output_text.done" && typeof data.text === "string") {
      text = data.text;
    }
    if (data.type === "response.output_item.done" && data.item?.type === "message" && !text.trim()) {
      const itemText = extractCodexText({ output: [data.item] });
      if (itemText) text = itemText;
    }
    if (data.type === "response.completed") usage = data.response?.usage || null;
    if (data.type === "error") {
      const err = new Error(sanitizeErrorMessage(data.error?.message) || "Codex OAuth stream returned an error.");
      err.code = data.error?.code || "CODEX_OAUTH_STREAM_ERROR";
      throw err;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      handleBlock(block);
    }
  }

  if (buffer.trim()) handleBlock(buffer);
  return { text: text.trim(), usage };
};

const normalizeSchemaType = (value) => {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  if (["object", "array", "string", "number", "integer", "boolean", "null"].includes(normalized)) return normalized;
  return undefined;
};

const convertSchemaToJsonSchema = (schema) => {
  if (!schema || typeof schema !== "object") return {};

  const type = normalizeSchemaType(schema.type);
  const next = {};
  if (schema.description) next.description = schema.description;
  if (Array.isArray(schema.enum)) next.enum = [...schema.enum];

  if (type === "object") {
    next.type = "object";
    const properties = schema.properties || {};
    next.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, convertSchemaToJsonSchema(value)])
    );
    next.required = Array.isArray(schema.required) ? schema.required : Object.keys(next.properties);
    next.additionalProperties = false;
  } else if (type === "array") {
    next.type = "array";
    next.items = convertSchemaToJsonSchema(schema.items || {});
  } else if (type) {
    next.type = type;
  }

  return next;
};

const getRequestParts = (request) => {
  const contents = request?.contents;
  if (Array.isArray(contents?.parts)) return contents.parts;
  if (Array.isArray(contents)) {
    return contents.flatMap((entry) => (Array.isArray(entry?.parts) ? entry.parts : []));
  }
  return [];
};

const buildCodexUserContent = (request) => {
  const parts = getRequestParts(request);
  const content = [];
  for (const part of parts) {
    if (typeof part?.text === "string" && part.text.trim()) {
      content.push({ type: "input_text", text: part.text });
    }
    const inlineData = part?.inlineData || part?.inline_data;
    const mimeType = inlineData?.mimeType || inlineData?.mime_type || "image/png";
    const data = inlineData?.data;
    if (typeof data === "string" && data.trim() && String(mimeType).startsWith("image/")) {
      content.push({ type: "input_image", image_url: `data:${mimeType};base64,${data}` });
    } else if (typeof data === "string" && data.trim()) {
      content.push({
        type: "input_file",
        filename: inlineData?.name || `input.${String(mimeType).includes("pdf") ? "pdf" : "bin"}`,
        file_data: `data:${mimeType};base64,${data}`
      });
    }
  }
  if (content.length === 1 && content[0].type === "input_text") return content[0].text;
  return content;
};

const generateCodexContent = async (request) => {
  const systemInstruction = String(request?.config?.systemInstruction || "").trim();
  const schema = request?.config?.responseJsonSchema || (
    request?.config?.responseSchema ? convertSchemaToJsonSchema(request.config.responseSchema) : null
  );
  const wantsPlainText = String(request?.config?.responseMimeType || "").trim().toLowerCase() === "text/plain";
  const enableSearch = Array.isArray(request?.config?.tools) && request.config.tools.some((tool) => tool?.googleSearch);
  const model = normalizeCodexTextModel(request?.model || CODEX_DEFAULT_TEXT_MODEL);
  const reasoningEffort = normalizeReasoningEffort(
    request?.config?.reasoningEffort ||
      request?.config?.reasoning_effort ||
      request?.config?.thinkingConfig?.reasoningEffort
  );
  const maxOutputTokens = normalizeMaxOutputTokens(
    request?.config?.maxOutputTokens ?? request?.config?.max_output_tokens
  );
  const userContent = buildCodexUserContent(request);
  const body = {
    model,
    input: [
      systemInstruction ? { role: "developer", content: systemInstruction } : null,
      { role: "user", content: userContent }
    ].filter(Boolean),
    stream: true,
    ...(wantsPlainText
      ? {}
      : schema
      ? {
          text: {
            format: {
              type: "json_schema",
              name: "toon_for_codex_output",
              strict: true,
              schema
            }
          }
        }
      : { text: { format: { type: "json_object" } } }),
    ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
    reasoning: { effort: reasoningEffort },
    ...(enableSearch ? { tools: [{ type: "web_search" }] } : {})
  };

  let response;
  try {
    response = await fetch(`${getCodexOAuthUrl()}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CODEX_TEXT_REQUEST_TIMEOUT_MS)
    });
  } catch (e) {
    throw normalizeFetchFailure(e, "Codex OAuth text request failed.", "CODEX_TEXT_NETWORK_ERROR", "network");
  }

  if (!response.ok && schema) {
    try {
      response = await fetch(`${getCodexOAuthUrl()}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          ...body,
          text: { format: { type: "json_object" } }
        }),
        signal: AbortSignal.timeout(CODEX_TEXT_REQUEST_TIMEOUT_MS)
      });
    } catch (e) {
      throw normalizeFetchFailure(e, "Codex OAuth text retry failed.", "CODEX_TEXT_RETRY_NETWORK_ERROR", "network");
    }
  }

  if (!response.ok) {
    const rawText = await response.text();
    const err = new Error(
      sanitizeErrorMessage(parseJsonSafe(rawText)?.error?.message || rawText) ||
        `Codex OAuth text request failed (${response.status}).`
    );
    err.status = response.status;
    err.code = parseJsonSafe(rawText)?.error?.code || `CODEX_TEXT_HTTP_${response.status}`;
    err.category = response.status === 401 || response.status === 403 ? "auth" : response.status === 429 ? "rate_limit" : response.status >= 500 ? "upstream" : "http";
    err.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw err;
  }

  let streamResult;
  try {
    streamResult = await readCodexTextStream(response);
  } catch (e) {
    throw normalizeFetchFailure(e, "Codex OAuth text response could not be read.", "CODEX_TEXT_READ_ERROR", "network");
  }
  const text = streamResult.text;
  if (!text) throw new Error("Codex OAuth response did not include text.");
  return {
    text,
    candidates: [{ content: { parts: [{ text }] } }],
    raw_response: null,
    usage: streamResult.usage
  };
};

const getBase64ByteLength = (value) => {
  try {
    return Buffer.byteLength(String(value || ""), "base64");
  } catch {
    return 0;
  }
};

const shouldUploadGeminiFile = (mimeType, data) => {
  const normalizedMime = String(mimeType || "").toLowerCase();
  if (GEMINI_FILE_API_ALWAYS_UPLOAD_PDFS && normalizedMime === "application/pdf") return true;
  const byteLength = getBase64ByteLength(data);
  return byteLength > GEMINI_FILE_API_INLINE_MAX_BYTES;
};

const buildPdfTextFallbackPart = async ({ data, displayName }) => {
  const bytes = Buffer.from(String(data || ""), "base64");
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    const fullText = String(result?.text || "").replace(/\s+\n/g, "\n").trim();
    if (!fullText) {
      const err = new Error("PDF에서 추출할 수 있는 텍스트가 없었어. 스캔 이미지 PDF라면 텍스트 복사본이나 OCR된 PDF가 필요해.");
      err.status = 422;
      throw err;
    }

    const maxChars = Number.isFinite(GEMINI_PDF_TEXT_FALLBACK_MAX_CHARS) && GEMINI_PDF_TEXT_FALLBACK_MAX_CHARS > 0
      ? GEMINI_PDF_TEXT_FALLBACK_MAX_CHARS
      : 120000;
    const truncated = fullText.length > maxChars;
    const text = truncated ? fullText.slice(0, maxChars) : fullText;
    const sizeMb = (bytes.byteLength / 1024 / 1024).toFixed(1);
    const fileLabel = sanitizeErrorMessage(displayName || "uploaded PDF") || "uploaded PDF";

    return {
      text: [
        `[PDF text extracted locally because the original PDF exceeds Gemini's PDF upload limit.]`,
        `File: ${fileLabel}`,
        `Original PDF size: ${sizeMb}MB`,
        `Extracted pages: ${result?.total || "unknown"}`,
        truncated ? `Note: extracted text was truncated to ${maxChars} characters for the model request.` : "",
        "",
        text
      ].filter(Boolean).join("\n")
    };
  } finally {
    await parser.destroy();
  }
};

const createPdfChunkBuffer = async (sourcePdf, pageIndices) => {
  const chunkPdf = await PDFDocument.create();
  const copiedPages = await chunkPdf.copyPages(sourcePdf, pageIndices);
  copiedPages.forEach((page) => chunkPdf.addPage(page));
  return Buffer.from(await chunkPdf.save());
};

const splitPdfForGeminiUpload = async ({ data, displayName }) => {
  const bytes = Buffer.from(String(data || ""), "base64");
  const sourcePdf = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false
  });
  const pageCount = sourcePdf.getPageCount();
  const targetBytes = Math.min(
    Math.max(GEMINI_PDF_SPLIT_TARGET_BYTES || 0, 1024 * 1024),
    GEMINI_PDF_MAX_BYTES
  );
  const maxParts = Math.max(GEMINI_PDF_SPLIT_MAX_PARTS || 0, 1);
  const chunks = [];
  let pageIndices = [];

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const candidateIndices = [...pageIndices, pageIndex];
    const candidateBytes = await createPdfChunkBuffer(sourcePdf, candidateIndices);

    if (candidateBytes.byteLength > targetBytes && pageIndices.length > 0) {
      chunks.push({
        pageStart: pageIndices[0] + 1,
        pageEnd: pageIndices[pageIndices.length - 1] + 1,
        bytes: await createPdfChunkBuffer(sourcePdf, pageIndices)
      });
      pageIndices = [pageIndex];
      continue;
    }

    if (candidateBytes.byteLength > GEMINI_PDF_MAX_BYTES) {
      const fileLabel = displayName ? ` (${sanitizeErrorMessage(displayName)})` : "";
      const err = new Error(`PDF${fileLabel}의 단일 페이지가 Gemini PDF 한도 50MB를 넘어. 이 경우에는 해당 페이지를 압축하거나 텍스트/OCR 자료로 넣어줘.`);
      err.status = 413;
      throw err;
    }

    pageIndices = candidateIndices;
  }

  if (pageIndices.length > 0) {
    chunks.push({
      pageStart: pageIndices[0] + 1,
      pageEnd: pageIndices[pageIndices.length - 1] + 1,
      bytes: await createPdfChunkBuffer(sourcePdf, pageIndices)
    });
  }

  if (chunks.length > maxParts) {
    const err = new Error(`PDF를 ${chunks.length}개 조각으로 나눠야 해서 중단했어. 현재 자동 분할 한도는 ${maxParts}개야. 논문 일부만 넣거나 GEMINI_PDF_SPLIT_MAX_PARTS를 올려줘.`);
    err.status = 413;
    throw err;
  }

  return chunks;
};

const buildSplitPdfFileParts = async ({ data, mimeType, displayName }) => {
  try {
    const chunks = await splitPdfForGeminiUpload({ data, displayName });
    const totalParts = chunks.length;
    const fileLabel = sanitizeErrorMessage(displayName || "uploaded PDF") || "uploaded PDF";
    const parts = [
      {
        text: [
          `[The uploaded PDF was larger than Gemini's single-PDF limit, so the local server split it into ${totalParts} page-range PDFs.]`,
          `Original file: ${fileLabel}`,
          `Use all PDF parts together as one continuous source document.`
        ].join("\n")
      }
    ];

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const uploaded = await uploadGeminiFileFromBase64({
        data: chunk.bytes.toString("base64"),
        mimeType,
        displayName: `${fileLabel} pages ${chunk.pageStart}-${chunk.pageEnd} (${index + 1}/${totalParts})`
      });
      parts.push({
        fileData: {
          mimeType: uploaded.mimeType,
          fileUri: uploaded.fileUri
        }
      });
    }

    return parts;
  } catch (error) {
    console.warn("[api] gemini pdf split upload failed, trying text extraction fallback", {
      message: sanitizeErrorMessage(error?.message)
    });
    return [await buildPdfTextFallbackPart({ data, displayName })];
  }
};

const assertGeminiFileSizeSupported = (mimeType, data, displayName) => {
  const normalizedMime = String(mimeType || "").toLowerCase();
  const byteLength = getBase64ByteLength(data);
  if (normalizedMime === "application/pdf" && byteLength > GEMINI_PDF_MAX_BYTES) {
    const sizeMb = (byteLength / 1024 / 1024).toFixed(1);
    const maxMb = Math.floor(GEMINI_PDF_MAX_BYTES / 1024 / 1024);
    const fileLabel = displayName ? ` (${sanitizeErrorMessage(displayName)})` : "";
    const err = new Error(`Gemini PDF 한도는 ${maxMb}MB야. 업로드한 PDF${fileLabel}는 약 ${sizeMb}MB라서, 자동 PDF 분할이 필요해.`);
    err.status = 413;
    throw err;
  }
};

const uploadGeminiFileFromBase64 = async ({ data, mimeType, displayName }) => {
  const bytes = Buffer.from(String(data || ""), "base64");
  if (bytes.byteLength === 0) {
    const err = new Error("Gemini file upload failed: file data was empty.");
    err.status = 400;
    throw err;
  }

  const startResponse = await fetch(`${GEMINI_UPLOAD_BASE_URL}/files?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Header-Content-Type": mimeType
    },
    body: JSON.stringify({
      file: {
        display_name: sanitizeErrorMessage(displayName || "uploaded-file") || "uploaded-file"
      }
    })
  });

  if (!startResponse.ok) {
    const rawText = await startResponse.text();
    const message = sanitizeErrorMessage(parseJsonSafe(rawText)?.error?.message || rawText) ||
      `Gemini file upload start failed (${startResponse.status}).`;
    const err = new Error(message);
    err.status = startResponse.status;
    throw err;
  }

  const uploadUrl = startResponse.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    const err = new Error("Gemini file upload did not return an upload URL.");
    err.status = 502;
    throw err;
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize"
    },
    body: bytes
  });

  if (!uploadResponse.ok) {
    const rawText = await uploadResponse.text();
    const message = sanitizeErrorMessage(parseJsonSafe(rawText)?.error?.message || rawText) ||
      `Gemini file upload failed (${uploadResponse.status}).`;
    const err = new Error(message);
    err.status = uploadResponse.status;
    throw err;
  }

  const json = await uploadResponse.json();
  const fileUri = String(json?.file?.uri || "").trim();
  const uploadedMimeType = String(json?.file?.mimeType || json?.file?.mime_type || mimeType).trim() || mimeType;
  if (!fileUri) {
    const err = new Error("Gemini file upload did not return a file URI.");
    err.status = 502;
    throw err;
  }

  return {
    fileUri,
    mimeType: uploadedMimeType
  };
};

const buildGeminiPart = async (part) => {
  if (typeof part?.text === "string") return { text: part.text };

  const inlineData = part?.inlineData || part?.inline_data;
  const mimeType = inlineData?.mimeType || inlineData?.mime_type || "application/octet-stream";
  const data = inlineData?.data;
  if (typeof data === "string" && data.trim()) {
    const displayName = inlineData?.name || inlineData?.displayName || inlineData?.display_name || "uploaded-file";
    const normalizedMime = String(mimeType || "").toLowerCase();
    const byteLength = getBase64ByteLength(data);
    if (normalizedMime === "application/pdf" && byteLength > GEMINI_PDF_MAX_BYTES) {
      return await buildSplitPdfFileParts({ data, mimeType, displayName });
    }
    assertGeminiFileSizeSupported(mimeType, data, displayName);
    if (shouldUploadGeminiFile(mimeType, data)) {
      const uploaded = await uploadGeminiFileFromBase64({
        data,
        mimeType,
        displayName
      });
      return {
        fileData: {
          mimeType: uploaded.mimeType,
          fileUri: uploaded.fileUri
        }
      };
    }
    return {
      inlineData: {
        mimeType,
        data
      }
    };
  }

  return null;
};

const normalizeGeminiContents = async (request) => {
  const contents = request?.contents;
  if (Array.isArray(contents)) return contents;

  const parts = (await Promise.all(getRequestParts(request).map(buildGeminiPart)))
    .flat()
    .filter(Boolean);
  return [{ role: "user", parts }];
};

const buildGeminiGenerationConfig = (request) => {
  const config = request?.config || {};
  const generationConfig = {};
  const responseMimeType = String(config.responseMimeType || config.response_mime_type || "").trim();
  const maxOutputTokens = normalizeMaxOutputTokens(config.maxOutputTokens ?? config.max_output_tokens);

  if (responseMimeType) generationConfig.responseMimeType = responseMimeType;
  if (maxOutputTokens) generationConfig.maxOutputTokens = maxOutputTokens;
  if (config.responseJsonSchema) generationConfig.responseJsonSchema = config.responseJsonSchema;
  if (config.responseSchema) generationConfig.responseSchema = config.responseSchema;

  return generationConfig;
};

const buildGeminiBody = async (request) => {
  const config = request?.config || {};
  const systemInstruction = String(config.systemInstruction || config.system_instruction || "").trim();
  const tools = Array.isArray(config.tools) ? config.tools : [];
  const generationConfig = buildGeminiGenerationConfig(request);
  const body = {
    contents: await normalizeGeminiContents(request),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    ...(tools.length > 0 ? { tools } : {})
  };

  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  return body;
};

const extractGeminiText = (json) => {
  if (typeof json?.text === "string" && json.text.trim()) return json.text.trim();
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
};

const generateGeminiContent = async (request) => {
  return await generateCodexContent(request);
};

const app = express();
app.disable("x-powered-by");
app.use("/archive-assets", express.static(path.join(process.cwd(), "local-project-archive"), {
  index: false,
  maxAge: "1h"
}));
app.use(express.json({ limit: JSON_LIMIT }));
app.use((err, _req, res, next) => {
  if (!err) {
    next();
    return;
  }
  if (err.type === "entity.too.large") {
    const message = `요청 자료가 너무 커서 로컬 API가 받지 못했어. 더 작은 PDF/TXT를 쓰거나 LOCAL_API_JSON_LIMIT 값을 현재 ${JSON_LIMIT}보다 크게 올린 뒤 서버를 다시 시작해줘.`;
    console.error("[api] request payload too large", {
      limit: JSON_LIMIT,
      length: err.length,
      expected: err.expected
    });
    res.status(413).json({ error: { message } });
    return;
  }
  next(err);
});

app.get("/api/health", (_req, res) => {
  res.json({
    codex_oauth_autostart: CODEX_OAUTH_AUTOSTART,
    codex_oauth_port: activeCodexOAuthPort,
    codex_oauth_url: getCodexOAuthUrl(),
    codex_image_model: CODEX_DEFAULT_IMAGE_MODEL,
    codex_text_model: CODEX_DEFAULT_TEXT_MODEL,
    text_generation_provider: "codex_oauth",
    gemini_text_model: GEMINI_TEXT_MODEL,
    local_api_json_limit: JSON_LIMIT,
    gemini_file_api_always_upload_pdfs: GEMINI_FILE_API_ALWAYS_UPLOAD_PDFS,
    gemini_pdf_max_bytes: GEMINI_PDF_MAX_BYTES,
    gemini_pdf_split_target_bytes: GEMINI_PDF_SPLIT_TARGET_BYTES,
    gemini_pdf_split_max_parts: GEMINI_PDF_SPLIT_MAX_PARTS,
    gemini_api_configured: Boolean(GEMINI_API_KEY)
  });
});

app.get("/api/oauth/status", async (_req, res) => {
  res.json(await getCodexOAuthStatus());
});

app.get("/api/project-archive", async (_req, res) => {
  try {
    res.json({
      storage_path: PROJECT_ARCHIVE_PATH,
      projects: await readProjectArchive()
    });
  } catch (e) {
    const message = sanitizeErrorMessage(e?.message) || "Failed to read local project archive.";
    console.error("[api] project archive read failed", { message, storage_path: PROJECT_ARCHIVE_PATH });
    res.status(500).json({ error: { message } });
  }
});

app.post("/api/project-archive", async (req, res) => {
  try {
    await writeProjectArchive(req.body?.projects);
    res.json({
      ok: true,
      storage_path: PROJECT_ARCHIVE_PATH,
      count: req.body.projects.length
    });
  } catch (e) {
    const message = sanitizeErrorMessage(e?.message) || "Failed to write local project archive.";
    console.error("[api] project archive write failed", { status: e?.status || 500, message, storage_path: PROJECT_ARCHIVE_PATH });
    res.status(e?.status || 500).json({ error: { message } });
  }
});

app.get("/api/style-samples", async (_req, res) => {
  try {
    const archive = await readStyleSampleArchive();
    res.json({
      storage_path: STYLE_SAMPLE_ARCHIVE_PATH,
      asset_dir: STYLE_SAMPLE_ASSET_DIR,
      prompt: archive.prompt || "",
      results: archive.results
    });
  } catch (e) {
    const message = sanitizeErrorMessage(e?.message) || "Failed to read style sample archive.";
    console.error("[api] style sample archive read failed", { message, storage_path: STYLE_SAMPLE_ARCHIVE_PATH });
    res.status(500).json({ error: { message } });
  }
});

app.post("/api/style-samples/prompt", async (req, res) => {
  try {
    const archive = await readStyleSampleArchive();
    archive.prompt = typeof req.body?.prompt === "string" ? req.body.prompt.slice(0, 4000) : "";
    await writeStyleSampleArchive(archive);
    res.json({ ok: true, storage_path: STYLE_SAMPLE_ARCHIVE_PATH, prompt: archive.prompt });
  } catch (e) {
    const message = sanitizeErrorMessage(e?.message) || "Failed to write style sample prompt.";
    console.error("[api] style sample prompt write failed", { message, storage_path: STYLE_SAMPLE_ARCHIVE_PATH });
    res.status(500).json({ error: { message } });
  }
});

app.post("/api/style-samples/result", async (req, res) => {
  try {
    const archive = await readStyleSampleArchive();
    const result = sanitizeStyleSampleResult(req.body || {});
    result.imageUrl = await persistStyleSampleImage(result.presetId, result.imageUrl);
    archive.results[result.presetId] = result;
    if (typeof result.prompt === "string" && result.prompt.trim()) archive.prompt = result.prompt;
    await writeStyleSampleArchive(archive);
    res.json({ ok: true, storage_path: STYLE_SAMPLE_ARCHIVE_PATH, result });
  } catch (e) {
    const message = sanitizeErrorMessage(e?.message) || "Failed to write style sample result.";
    console.error("[api] style sample result write failed", { message, storage_path: STYLE_SAMPLE_ARCHIVE_PATH });
    res.status(500).json({ error: { message } });
  }
});

app.delete("/api/style-samples", async (_req, res) => {
  try {
    await fs.rm(STYLE_SAMPLE_ARCHIVE_DIR, { recursive: true, force: true });
    res.json({ ok: true, storage_path: STYLE_SAMPLE_ARCHIVE_PATH });
  } catch (e) {
    const message = sanitizeErrorMessage(e?.message) || "Failed to clear style sample archive.";
    console.error("[api] style sample archive clear failed", { message, storage_path: STYLE_SAMPLE_ARCHIVE_PATH });
    res.status(500).json({ error: { message } });
  }
});

app.get("/api/pipeline-runs/recent", async (req, res) => {
  try {
    const limit = Number.parseInt(String(req.query?.limit || "80"), 10);
    res.json({
      storage_path: PIPELINE_RUNS_PATH,
      entries: await readRecentPipelineRuns(Number.isFinite(limit) ? limit : 80)
    });
  } catch (e) {
    const message = sanitizeErrorMessage(e?.message) || "Failed to read pipeline run logs.";
    console.error("[api] pipeline run log read failed", { message, storage_path: PIPELINE_RUNS_PATH });
    res.status(500).json({ error: { message } });
  }
});

app.post("/api/pipeline-runs", async (req, res) => {
  try {
    await appendPipelineRunEntry(req.body || {});
    res.json({ ok: true, storage_path: PIPELINE_RUNS_PATH });
  } catch (e) {
    const message = sanitizeErrorMessage(e?.message) || "Failed to write pipeline run log.";
    console.error("[api] pipeline run log write failed", { message, storage_path: PIPELINE_RUNS_PATH });
    res.status(500).json({ error: { message } });
  }
});

app.post("/api/codex/generate-image", async (req, res) => {
  const requestId = getRequestId(req);
  res.setHeader("X-Request-Id", requestId);
  const prompt = String(req.body?.prompt || "").trim();
  const size = String(req.body?.size || "").trim();
  const quality = String(req.body?.quality || "high").trim().toLowerCase();
  const moderation = String(req.body?.moderation || CODEX_DEFAULT_MODERATION).trim().toLowerCase();
  const model = String(req.body?.model || CODEX_DEFAULT_IMAGE_MODEL).trim() || CODEX_DEFAULT_IMAGE_MODEL;
  const referenceImages = Array.isArray(req.body?.reference_images) ? req.body.reference_images : [];

  if (!prompt) {
    res.status(400).json({ error: { message: "Missing prompt." } });
    return;
  }
  const sizeError = validateCodexImageSize(size);
  if (sizeError) {
    res.status(400).json({ error: { message: `Invalid Codex image size. ${sizeError}` } });
    return;
  }
  if (!["low", "medium", "high"].includes(quality)) {
    res.status(400).json({ error: { message: "Invalid Codex image quality. Use low, medium, or high." } });
    return;
  }
  if (!["auto", "low"].includes(moderation)) {
    res.status(400).json({ error: { message: "Invalid Codex image moderation. Use auto or low." } });
    return;
  }

  try {
    let image;
    try {
      image = await generateCodexImage({
        prompt,
        size,
        quality,
        moderation,
        model,
        referenceImages,
        requestId
      });
    } catch (firstError) {
      if (!isCodexSafetyRefusal(firstError)) throw firstError;

      console.warn("[api] codex generate-image safety fallback retry", {
        request_id: requestId,
        status: firstError?.status || 422,
        model: normalizeCodexImageModel(model),
        message: sanitizeErrorMessage(firstError?.message)
      });

      image = await generateCodexImage({
        prompt: buildCodexSafetyFallbackPrompt(prompt),
        size,
        quality,
        moderation: "low",
        model,
        referenceImages,
        requestId
      });
      image.safety_retry = true;
    }
    res.json(image);
  } catch (e) {
    const message = sanitizeErrorMessage(e?.message) || "Codex OAuth image request failed.";
    console.error("[api] codex generate-image failed", {
      request_id: requestId,
      status: e?.status || 502,
      model: normalizeCodexImageModel(model),
      code: e?.code || "CODEX_IMAGE_FAILED",
      category: e?.category || "unknown",
      retryable: e?.retryable === true,
      message,
      diagnostics: e?.diagnostics || null
    });
    res.status(e?.status || 502).json(makeApiErrorPayload(e, "Codex OAuth image request failed.", requestId));
  }
});

app.post("/api/codex/generate-content", async (req, res) => {
  const requestId = getRequestId(req);
  res.setHeader("X-Request-Id", requestId);
  const request = req.body?.request ?? req.body;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    res.status(400).json({ error: { message: "Missing request payload." } });
    return;
  }
  if (!request.contents) {
    res.status(400).json({ error: { message: "Invalid request payload: `contents` is required." } });
    return;
  }

  try {
    res.json(await generateCodexContent(request));
  } catch (e) {
    const message = sanitizeErrorMessage(e?.message) || "Codex OAuth text request failed.";
    console.error("[api] codex generate-content failed", {
      request_id: requestId,
      status: e?.status || 502,
      model: normalizeCodexTextModel(request?.model || CODEX_DEFAULT_TEXT_MODEL),
      code: e?.code || "CODEX_TEXT_FAILED",
      category: e?.category || "unknown",
      retryable: e?.retryable === true,
      message
    });
    res.status(e?.status || 502).json(makeApiErrorPayload(e, "Codex OAuth text request failed.", requestId));
  }
});

app.post("/api/gemini/generate-content", async (req, res) => {
  const requestId = getRequestId(req);
  res.setHeader("X-Request-Id", requestId);
  const request = req.body?.request ?? req.body;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    res.status(400).json({ error: { message: "Missing request payload." } });
    return;
  }
  if (!request.contents) {
    res.status(400).json({ error: { message: "Invalid request payload: `contents` is required." } });
    return;
  }

  try {
    res.json(await generateGeminiContent(request));
  } catch (e) {
    const message = sanitizeErrorMessage(e?.message) || "Codex OAuth text request failed.";
    console.error("[api] gemini compatibility generate-content failed", {
      request_id: requestId,
      status: e?.status || 502,
      model: normalizeCodexTextModel(request?.model || CODEX_DEFAULT_TEXT_MODEL),
      code: e?.code || "CODEX_TEXT_FAILED",
      category: e?.category || "unknown",
      retryable: e?.retryable === true,
      message
    });
    res.status(e?.status || 502).json(makeApiErrorPayload(e, "Codex OAuth text request failed.", requestId));
  }
});

startCodexOAuthProxy();

app.listen(PORT, HOST, () => {
  const displayedHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  if (!["127.0.0.1", "localhost", "::1"].includes(HOST)) {
    console.warn(`[local-api] warning: API is bound to ${HOST}. Use LOCAL_API_HOST=127.0.0.1 for local-only access.`);
  }
  console.log(`[local-api] listening on http://${displayedHost}:${PORT}`);
  console.log(`[local-api] Codex OAuth: ${CODEX_OAUTH_AUTOSTART ? "auto" : "manual"} on ${getCodexOAuthUrl()}`);
});
