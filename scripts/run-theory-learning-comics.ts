import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { analyzeResearchReport } from "../services/researchService";
import { generatePlan } from "../services/planner";
import { generateFullPageImage } from "../services/renderer";
import { selectStyle } from "../services/styleService";
import { getTemplatesForFormat } from "../services/formatConfig";
import { resolveDeliveryStyleSpec } from "../services/deliveryStyles";
import {
  loadSavedComicProjectsFromLocalArchive,
  persistSavedComicProjectsToLocalArchive,
  SavedComicProject,
  SavedComicProjectSnapshot
} from "../services/projectArchiveService";
import { CharacterSpec, GenerationResult, GroundingSource, ImageSize, LayoutTemplate, SeriesPlan, SeriesSpec, StylePreset } from "../types";

const ROOT = process.cwd();
const API_BASE = process.env.LOCAL_API_BASE || "http://127.0.0.1:8787";
const ARTICLE_DIR = "/Users/kimseohyeong/플스포/쓰레드/ps4_ps4pro/20260519_231337_19c266b49a1000oce/articles";
const QUEUE_DIR = path.join(ROOT, "local-project-archive", "theory_1_5_queue");
const RUN_LOG = path.join(ROOT, "local-project-archive", "theory-1-5-runner.jsonl");
const ARCHIVE_PATH = path.join(ROOT, "local-project-archive", "projects.json");
const PROJECT_DUMP_DIR = path.join(ROOT, "local-project-archive", "theory_webtoon_regenerated_projects");
const ARCHIVE_BACKUP_PATH = path.join(
  ROOT,
  "local-project-archive",
  `projects.before_theory_webtoon_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}.json`
);
const ACTIVE_ARCHIVE_MAX_BYTES = 360 * 1024 * 1024;
const STYLE_PRESET_ID = "kwebtoon_serialized_panel";
const IMAGE_SIZE: ImageSize = "2K";
const PAGE_COUNT = 12;
const IMAGE_CONCURRENCY = 3;

process.env.VITE_CODEX_TEXT_MODEL ||= "gpt-5.4-mini";

const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  if (typeof input === "string" && input.startsWith("/")) {
    return nativeFetch(`${API_BASE}${input}`, init);
  }
  return nativeFetch(input, init);
}) as typeof fetch;

const files = [
  "260218215940235ej.md",
  "260304213530925vz.md",
  "260311223513066fx.md",
  "260318224638739ku.md",
  "260322172944876jk.md"
].map((name) => path.join(ARTICLE_DIR, name));

const log = (entry: Record<string, unknown>) => {
  const line = JSON.stringify({ created_at: new Date().toISOString(), ...entry });
  fs.appendFileSync(RUN_LOG, `${line}\n`);
  console.log(line);
};

const safeFileName = (value: string): string =>
  value
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120) || "project";

const makeId = () => crypto.randomUUID();

const deriveTopicFromMaterial = (material: string, fallback: string): string => {
  const firstLine = material
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^#\s*/, ""))
    .find(Boolean);
  if (!firstLine) return fallback;
  return firstLine.length > 64 ? `${firstLine.slice(0, 64)}...` : firstLine;
};

const compactCastForStorage = (items: CharacterSpec[]): CharacterSpec[] =>
  items.map((c) => ({
    ...c,
    reference_images: Array.isArray(c.reference_images) ? c.reference_images.filter(Boolean).slice(0, 4) : [],
    style_aligned_reference_images: Array.isArray(c.style_aligned_reference_images)
      ? c.style_aligned_reference_images.filter(Boolean).slice(0, 1)
      : []
  }));

const buildImageEngineKey = (model = "gpt-5.5", quality = "high") => `codex:${model}:${quality}`;

const loadProjectsDirect = (): SavedComicProject[] => {
  if (!fs.existsSync(ARCHIVE_PATH)) return [];
  const raw = JSON.parse(fs.readFileSync(ARCHIVE_PATH, "utf8"));
  return Array.isArray(raw) ? raw : Array.isArray(raw.projects) ? raw.projects : [];
};

const persistProjectsDirect = (project: SavedComicProject) => {
  fs.mkdirSync(PROJECT_DUMP_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(PROJECT_DUMP_DIR, `${safeFileName(project.label)}.json`),
    JSON.stringify(project)
  );

  if (fs.existsSync(ARCHIVE_PATH) && !fs.existsSync(ARCHIVE_BACKUP_PATH)) {
    fs.copyFileSync(ARCHIVE_PATH, ARCHIVE_BACKUP_PATH);
    log({ stage: "archive", status: "backup", file: ARCHIVE_BACKUP_PATH });
  }

  const current = loadProjectsDirect();
  const deduped = current.filter((item) => item.label !== project.label);
  const prioritized = [
    project,
    ...deduped.filter((item) => String(item.label || "").startsWith("웹툰풍 재생성 · ")),
    ...deduped.filter((item) => String(item.label || "").includes("경매 1강 인스타툰")),
    ...deduped
  ];
  const seen = new Set<string>();
  const selected: SavedComicProject[] = [];
  for (const item of prioritized) {
    const key = item.id || item.label;
    if (seen.has(key)) continue;
    seen.add(key);
    const candidate = [...selected, item];
    const body = JSON.stringify({ version: 1, updated_at: new Date().toISOString(), projects: candidate });
    if (Buffer.byteLength(body) > ACTIVE_ARCHIVE_MAX_BYTES && selected.length > 0) continue;
    selected.push(item);
  }

  fs.writeFileSync(
    ARCHIVE_PATH,
    JSON.stringify({ version: 1, updated_at: new Date().toISOString(), projects: selected }, null, 2)
  );
  log({ stage: "archive", status: "compacted", active_projects: selected.length, max_mb: Math.round(ACTIVE_ARCHIVE_MAX_BYTES / 1024 / 1024) });
};

const getPrimaryCast = async (): Promise<CharacterSpec[]> => {
  const projects = await loadSavedComicProjectsFromLocalArchive();
  const source = projects.find((project) => String(project.label || "").includes("이론편 1강") && project.snapshot?.cast?.length);
  const cast = source?.snapshot?.cast || [];
  if (cast.length > 0) return compactCastForStorage(cast);

  const raw = JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, "shared_cast_from_1.json"), "utf8"));
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (Array.isArray(parsed) && parsed.length > 0) return compactCastForStorage(parsed as CharacterSpec[]);
  throw new Error("공통 캐릭터를 찾지 못했어. 1강 캐릭터 저장이 먼저 필요해.");
};

const saveProject = async (
  topic: string,
  style: SeriesSpec["anchors"]["style"],
  cast: CharacterSpec[],
  plan: SeriesPlan,
  digest: string,
  results: GenerationResult[],
  errors: Record<number, string>
) => {
  const now = Date.now();
  const sortedResults = [...results].sort((a, b) => a.page_index - b.page_index);
  const pageRenderedAt: Record<number, number> = {};
  const pageRenderedImageSize: Record<number, ImageSize> = {};
  const pageRenderedEngineKey: Record<number, string> = {};
  for (const result of sortedResults) {
    pageRenderedAt[result.page_index] = now;
    pageRenderedImageSize[result.page_index] = IMAGE_SIZE;
    pageRenderedEngineKey[result.page_index] = buildImageEngineKey();
  }

  const snapshot: SavedComicProjectSnapshot = {
    topic,
    questionType: "explain",
    comicMode: "learning",
    outputMode: "comic",
    publicationFormat: "learning_comic",
    mangaColorMode: "color",
    i2vAspectRatio: "16:9",
    toneMode: "normal",
    toneLevel: "medium",
    introStyle: "standard",
    language: "ko",
    audienceLevel: "beginner",
    deliveryStyleId: "standard",
    deliveryCustomInstruction: "",
    geminiReasoningEffort: "medium",
    layoutVariety: "high",
    imageSize: IMAGE_SIZE,
    imageProvider: "codex",
    codexImageQuality: "high",
    scriptDetail: "normal",
    pageCountMode: "manual",
    targetPageCount: PAGE_COUNT,
    narrativeRole: "narrator",
    characterConsistencyMode: "strict",
    useCrossPageStyleConsistency: false,
    researchMode: "auto_digest",
    researchDigestText: digest,
    cast: compactCastForStorage(cast),
    productReferenceImages: [],
    selectedPresetId: STYLE_PRESET_ID,
    selectedStyleCategory: "Webtoon",
    finalStyle: style,
    seriesPlan: plan,
    pageResults: sortedResults,
    pageErrors: errors,
    pageRenderedAt,
    pageRenderedImageSize,
    pageRenderedEngineKey,
    pageScriptEditedAt: {},
    pageStyleOverrides: {},
    pageStyleEditedAt: {},
    globalStyleEditedAt: 0,
    creationType: "educational",
    scriptText: "",
    storyInputType: "scenario",
    storyAdaptationMode: "analyzed",
    ageRating: "teen",
    storyGenre: null,
    pacingPreference: "balanced",
    storyAntiEducationGuardEnabled: true,
    storyDigestText: "",
    paperBrief: null
  };

  const baseLabel = plan.series_spec?.series?.title || topic;
  const label = `웹툰풍 재생성 · ${baseLabel}`;
  const project: SavedComicProject = {
    id: makeId(),
    label,
    created_at: now,
    updated_at: now,
    last_opened_at: now,
    snapshot
  };
  persistProjectsDirect(project);
  log({ stage: "save", status: "success", label, pages: sortedResults.length });
};

const generateImages = async (plan: SeriesPlan): Promise<{ results: GenerationResult[]; errors: Record<number, string> }> => {
  const results: GenerationResult[] = [];
  const errors: Record<number, string> = {};
  const pages = plan.pages || [];
  for (let start = 0; start < pages.length; start += IMAGE_CONCURRENCY) {
    const chunk = pages.slice(start, start + IMAGE_CONCURRENCY);
    await Promise.all(chunk.map(async (page) => {
      const pageIndex = page.page.index;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          log({ stage: "image", status: "started", page: pageIndex, attempt });
          const imageUrl = await generateFullPageImage(plan.series_spec, page, IMAGE_SIZE, "learning", {
            styleConsistencyImage: null,
            imageProvider: "codex",
            codexImageQuality: "high",
            codexImageModel: "gpt-5.5"
          });
          results.push({ page_index: pageIndex, composed_image_url: imageUrl });
          delete errors[pageIndex];
          log({ stage: "image", status: "success", page: pageIndex, attempt });
          return;
        } catch (e: any) {
          const message = String(e?.message || e || "image failed");
          log({ stage: "image", status: attempt < 2 ? "retrying" : "error", page: pageIndex, attempt, message });
          if (attempt >= 2) errors[pageIndex] = message;
        }
      }
    }));
  }
  return {
    results: results.sort((a, b) => a.page_index - b.page_index),
    errors
  };
};

const main = async () => {
  const stylePresets = JSON.parse(fs.readFileSync(path.join(ROOT, "style_presets.json"), "utf8")) as StylePreset[];
  const templates = JSON.parse(fs.readFileSync(path.join(ROOT, "layout_templates.json"), "utf8")) as LayoutTemplate[];
  const style = selectStyle(stylePresets, STYLE_PRESET_ID, "", { publicationFormat: "learning_comic", mangaColorMode: "color" });
  const templatesForPlan = getTemplatesForFormat("learning_comic", templates);
  const cast = await getPrimaryCast();
  const primary = cast.find((c) => c.role === "protagonist") || cast[0];
  const primaryAppearance = String(primary?.analyzed_appearance || primary?.appearance || primary?.name || "A friendly guide character").trim();
  const primaryRefs = Array.isArray(primary?.reference_images) ? primary.reference_images.filter(Boolean) : [];
  const supportingSummary = cast
    .filter((c) => c.role === "supporting")
    .map((c) => `${c.name}: ${c.appearance || ""} ${c.persona || ""}`.trim())
    .filter(Boolean)
    .join("\n");

  for (const filePath of files) {
    const sourceText = fs.readFileSync(filePath, "utf8");
    const fallback = path.basename(filePath, path.extname(filePath));
    const topic = deriveTopicFromMaterial(sourceText, fallback);
    const existing = await loadSavedComicProjectsFromLocalArchive();
    const expectedLabelPrefix = `웹툰풍 재생성 · `;
    const alreadyDone = existing.find((project) =>
      String(project.label || "").startsWith(expectedLabelPrefix) &&
      (project.snapshot?.topic === topic || String(project.label || "").includes(topic)) &&
      (project.snapshot?.pageResults?.length || 0) >= PAGE_COUNT
    );
    if (alreadyDone) {
      log({ stage: "skip", status: "exists", topic });
      continue;
    }

    log({ stage: "digest", status: "started", topic });
    const digestResult = await analyzeResearchReport({ topic, report_text: sourceText });
    const digest = digestResult.notes;
    log({ stage: "digest", status: "success", topic, chars: digest.length });

    log({ stage: "plan", status: "started", topic });
    const plan = await generatePlan({
      topic,
      question_type: "explain",
      comic_mode: "learning",
      output_mode: "comic",
      publication_format: "learning_comic",
      manga_color_mode: "color",
      i2v_aspect_ratio: "16:9",
      tone_mode: "normal",
      tone_level: "medium",
      intro_style: "standard",
      detail_level: "normal",
      language: "ko",
      audience_level: "beginner",
      character_consistency_mode: "strict",
      delivery_style: resolveDeliveryStyleSpec({
        preset_id: "standard",
        custom_instruction: "",
        audience_level: "beginner",
        comic_mode: "learning"
      }),
      layout_variety: "high",
      image_size: IMAGE_SIZE,
      page_count: PAGE_COUNT,
      character_description: primaryAppearance,
      character_role: "narrator",
      character_refs: { main: primaryRefs[0] || "", pack: primaryRefs },
      supporting_cast: supportingSummary || undefined,
      cast,
      style,
      templates: templatesForPlan,
      gemini_reasoning_effort: "medium",
      research: {
        mode: "auto_digest",
        pack: {
          notes: digest,
          sources: [] as GroundingSource[]
        }
      }
    });
    plan.plan_meta = {
      ...plan.plan_meta,
      research_digest: digest,
      source_file_name: path.basename(filePath)
    };
    log({ stage: "plan", status: "success", topic, pages: plan.pages.length });

    const { results, errors } = await generateImages(plan);
    await saveProject(topic, style, cast, plan, digest, results, errors);
  }
};

main().catch((e) => {
  log({ stage: "fatal", status: "error", message: String(e?.stack || e?.message || e) });
  process.exitCode = 1;
});
