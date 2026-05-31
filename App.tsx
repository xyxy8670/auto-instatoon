
import React, { useEffect, useRef, useState } from 'react';
import { buildKlingI2VPromptPack } from './services/klingPrompt';
import { buildSeedanceRunwayPromptPack } from './services/seedancePrompt';
import { getStylePresetDisplayLabel, getStylePresets, selectStyle } from './services/styleService';
import { getJson, postJson } from './services/localApi';
import { compressImageDataUrl, readImageFileAsCompressedDataUrl } from './services/imageDataUrl';
import { DELIVERY_STYLE_PRESETS, resolveDeliveryStyleSpec } from './services/deliveryStyles';
import { composeWebtoonEpisodeSegments } from './services/webtoonEpisodeService';
import { CastPreset, CastPresetPayload, loadCastPresets, persistCastPresets } from './services/castPresetService';
import { analyzeCharacterImage, analyzeEpisodeCastFromLibrary, EpisodeCastSelectionResult, generateCharacterCandidates, generateStyleAlignedCharacterReference, suggestCastFromContent } from './services/characterService';
import { SavedComicProject, SavedComicProjectSnapshot, loadSavedComicProjects, loadSavedComicProjectsFromLocalArchive, mergeSavedComicProjects, persistSavedComicProjects, persistSavedComicProjectsToLocalArchive } from './services/projectArchiveService';
import { SavedLongformProject, SavedLongformProjectSnapshot, loadLongformProjects, persistLongformProjects } from './services/seriesLibraryService';
import { PageScriptEditorModal } from './components/PageScriptEditorModal';
import { PageEditActionModal } from './components/PageEditActionModal';
import { PageStyleEditorModal } from './components/PageStyleEditorModal';
import { PageNarrativePreview } from './components/PageNarrativePreview';
import { DevPromptCheckModal } from './components/DevPromptCheckModal';
import { SeriesPlan, SeriesSpec, PageSpec, AppStatus, GenerationResult, NarrativeRole, StylePreset, LayoutTemplate, LayoutVariety, ImageSize, GroundingSource, ResearchMode, ResearchPack, QuestionType, ComicMode, ToneMode, ToneLevel, ScriptDetail, PageCountMode, AudienceLevel, DeliveryStyleId, IntroStyle, CharacterSpec, CastRole, CatchphraseFrequency, CharacterConsistencyMode, Language, OutputMode, I2VAspectRatio, PublicationFormat, MangaColorMode, CreationType, StoryInputType, StoryAdaptationMode, AgeRating, StoryGenre, PacingPreference, PaperBrief, GeminiReasoningEffort, WebtoonEpisodeRenderResult, ImageProvider, CodexImageQuality } from './types';
import { getFormatConfig, getTemplatesForFormat, FORMAT_CONFIGS, isKlingI2V as isKlingI2VFormat, isWebtoon, isInstatoon, isManga, isLearningComic } from './services/formatConfig';
import { Loader2, BookOpen, Sparkles, Key, User, ArrowRight, Upload, Palette, CheckCircle2, RotateCcw, Plus, Wand2, LayoutGrid, Layers, Monitor, ChevronRight, ChevronLeft, Download, FileText, Settings2, Globe, ExternalLink, Lightbulb, UserCheck, MessageSquareText, Copy, Trash2, Bookmark, FolderOpen, Save, AlertTriangle } from 'lucide-react';

const DEFAULT_MAX_PAGE_COUNT = 12;
const GEMINI_PLANNER_MODEL = "gpt-5.5";
const MAX_SAVED_PROJECTS = 2000;
const MAX_PERSISTABLE_DATA_URL_LENGTH = Number.POSITIVE_INFINITY;
const MAX_PERSISTABLE_REF_IMAGES_PER_CHARACTER = 1;
const MAX_PERSISTABLE_PRODUCT_REF_IMAGES = 1;
const STORY_MIN_INPUT_CHARS = 50;
const REFERENCE_IMAGE_MAX_EDGE = 1024;
const REFERENCE_IMAGE_JPEG_QUALITY = 0.82;
const MAX_PARALLEL_PAGE_GENERATIONS = 3;
const PLANNING_STUCK_SECONDS = 10 * 60;

const loadPlannerService = () => import('./services/planner');
const loadTranslationService = () => import('./services/translationService');
const loadRendererService = () => import('./services/renderer');
const loadResearchService = () => import('./services/researchService');
const loadStoryAnalysisService = () => import('./services/storyAnalysisService');
const loadPaperService = () => import('./services/paperService');
const loadGeminiResearchService = () => import('./services/geminiResearchService');
const loadPageSuggestionService = () => import('./services/pageSuggestionService');
const loadPostprocessorService = () => import('./services/postprocessor');
const loadCodexHandoffService = () => import('./services/codexHandoffService');

const isTextLikeMaterialFile = (file: File): boolean => {
  const name = file.name.toLowerCase();
  return (
    file.type.startsWith("text/") ||
    name.endsWith(".md") ||
    name.endsWith(".txt") ||
    name.endsWith(".json")
  );
};

const isPdfMaterialFile = (file: File): boolean => {
  const name = file.name.toLowerCase();
  return file.type === "application/pdf" || name.endsWith(".pdf");
};

const resolveMaxPageCount = (): number => {
  const raw = String(import.meta.env.VITE_MAX_PAGE_COUNT ?? "").trim();
  if (!raw) return DEFAULT_MAX_PAGE_COUNT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_PAGE_COUNT;
};

const MAX_PAGE_COUNT = resolveMaxPageCount();

const clampPageCount = (value: number): number => {
  const floored = Math.floor(value);
  if (!Number.isFinite(floored)) return 1;
  return Math.max(1, Math.min(MAX_PAGE_COUNT, floored));
};

const estimateDirectStoryPageSuggestions = (
  text: string,
  inputType: StoryInputType
): Record<ScriptDetail, number> => {
  const body = String(text || "").trim();
  const nonSpaceChars = body.replace(/\s/g, "").length;
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const paragraphs = body.split(/\n\s*\n+/).map((part) => part.trim()).filter(Boolean).length;
  const sentenceBeats = body
    .split(/[.!?。！？]+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 12).length;
  const dialogueLines = lines.filter((line) => /["“”'‘’「」『』]|[:：]/.test(line)).length;
  const sceneActionLines = lines.filter((line) => line.length >= 16 && !/^["“”'‘’「」『』]/.test(line)).length;
  const storyBeats = Math.max(paragraphs, Math.ceil(sentenceBeats / 2), dialogueLines, sceneActionLines);
  const beatBudgets: Record<StoryInputType, Record<ScriptDetail, number>> = {
    script: { brief: 8, normal: 6, detailed: 4 },
    prose: { brief: 8, normal: 5, detailed: 4 },
    scenario: { brief: 6, normal: 4, detailed: 3 }
  };
  const budgets: Record<StoryInputType, Record<ScriptDetail, number>> = {
    script: { brief: 1200, normal: 800, detailed: 560 },
    prose: { brief: 950, normal: 620, detailed: 440 },
    scenario: { brief: 800, normal: 550, detailed: 380 }
  };
  const minPages: Record<ScriptDetail, number> = { brief: 1, normal: 2, detailed: 3 };
  return {
    brief: clampPageCount(Math.max(minPages.brief, Math.ceil(storyBeats / beatBudgets[inputType].brief), Math.ceil(nonSpaceChars / budgets[inputType].brief))),
    normal: clampPageCount(Math.max(minPages.normal, Math.ceil(storyBeats / beatBudgets[inputType].normal), Math.ceil(nonSpaceChars / budgets[inputType].normal))),
    detailed: clampPageCount(Math.max(minPages.detailed, Math.ceil(storyBeats / beatBudgets[inputType].detailed), Math.ceil(nonSpaceChars / budgets[inputType].detailed)))
  };
};

const isEduCinematicMode = (mode: ComicMode): boolean => mode === "cinematic";
const isPureCinematicMode = (mode: ComicMode): boolean => mode === "pure_cinematic";
const isAnyCinematicMode = (mode: ComicMode): boolean => isEduCinematicMode(mode) || isPureCinematicMode(mode);
const I2V_TEMPLATE_BY_RATIO: Record<I2VAspectRatio, string> = {
  "16:9": "i2v_frame_16_9",
  "9:16": "i2v_frame_9_16",
  "1:1": "i2v_frame_1_1"
};
const IMAGE_SIZE_OPTIONS: ImageSize[] = ["1K", "2K", "4K"];
const DEFAULT_IMAGE_PROVIDER: ImageProvider = "codex";
const DEFAULT_CODEX_IMAGE_QUALITY: CodexImageQuality = "high";
const FALLBACK_CODEX_IMAGE_MODEL = "gpt-5.5";
const DEFAULT_LAYOUT_VARIETY: LayoutVariety = "high";
const LEARNING_QUESTION_TYPE: QuestionType = "explain";
const LEARNING_COMIC_MODE: ComicMode = "learning";
const LEARNING_INTRO_STYLE: IntroStyle = "standard";
const LEARNING_NARRATIVE_ROLE: NarrativeRole = "narrator";
type OutputReaderMode = "visual" | "visual_plus_script";
type UiLanguage = "ko" | "en";
type BusyPhase = "planning" | "translating";
type TopicInputTab = "quick" | "instatoon" | "style_samples" | "advanced" | "status";
type QuickPipelinePublicationFormat = "webtoon" | "learning_comic" | "instatoon";
type QuickPipelineStage = "idle" | "digest" | "cast" | "plan" | "images" | "complete" | "error";
type QuickPipelineLogStatus = "started" | "success" | "retrying" | "error" | "info";
type QuickPipelineQueueStatus = "pending" | "running" | "success" | "error";
type StyleSampleStatus = "idle" | "running" | "success" | "error";

interface QuickPipelineProgress {
  runId: string;
  stage: QuickPipelineStage;
  startedAt: number;
  stageStartedAt: number;
  attempt: number;
  message: string;
  detail?: string;
  totalPages?: number;
  completedPages?: number;
  failedPages?: number;
}

interface QuickPipelineRunLog {
  run_id?: string;
  stage?: QuickPipelineStage | string;
  attempt?: number;
  status?: QuickPipelineLogStatus | string;
  message?: string;
  request_id?: string;
  category?: string;
  elapsed_ms?: number;
  page_index?: number;
  created_at?: number;
}

interface QuickPipelineQueueRun {
  id: string;
  label: string;
  stage: QuickPipelineStage;
  status: QuickPipelineQueueStatus;
  message: string;
  startedAt: number;
  completedAt?: number;
  totalPages?: number;
  completedPages?: number;
  failedPages?: number;
  error?: string;
  cast?: CharacterSpec[];
  plan?: SeriesPlan;
  pageResults?: GenerationResult[];
  pageErrors?: Record<number, string>;
}

interface QuickPipelineSourceJob {
  id: string;
  file: File;
  topic: string;
  publicationFormat: QuickPipelinePublicationFormat;
}

interface StyleSampleResult {
  presetId: string;
  status: StyleSampleStatus;
  prompt?: string;
  imageUrl?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

const QUICK_PIPELINE_TIMEOUT_MS = 30 * 60_000;
const QUICK_PIPELINE_MAX_STRIPS_PER_EPISODE = 12;
const QUICK_PIPELINE_MAX_TOTAL_STRIPS = 36;
const QUICK_PIPELINE_MAX_QUEUE_COUNT = 3;
const INSTATOON_EXPORT_WIDTH = 1080;
const INSTATOON_EXPORT_HEIGHT = 1350;
const INSTATOON_MAX_CARDS_PER_EPISODE = 12;
const STYLE_SAMPLE_IMAGE_SIZE = "1024x1024";
const STYLE_SAMPLE_DB_NAME = "instatoon-studio-style-samples";
const STYLE_SAMPLE_DB_VERSION = 1;
const STYLE_SAMPLE_STORE_NAME = "samples";
const STYLE_SAMPLE_META_KEY = "__meta__";

type PersistedStyleSamples = {
  prompt?: string;
  results: Record<string, StyleSampleResult>;
};

type StyleSampleArchiveResponse = PersistedStyleSamples & {
  storage_path?: string;
  asset_dir?: string;
};

type StyleSampleResultResponse = {
  ok?: boolean;
  result?: StyleSampleResult;
};

const normalizeStyleSampleResult = (raw: any): StyleSampleResult | null => {
  if (!raw || typeof raw !== "object") return null;
  const presetId = String(raw.presetId || "").trim();
  if (!presetId) return null;
  const status: StyleSampleStatus = raw.status === "success" || raw.status === "error" || raw.status === "running" ? raw.status : "idle";
  return {
    presetId,
    status: status === "running" ? "idle" : status,
    prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
    imageUrl: typeof raw.imageUrl === "string" ? raw.imageUrl : undefined,
    error: typeof raw.error === "string" ? raw.error : undefined,
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : undefined,
    completedAt: typeof raw.completedAt === "number" ? raw.completedAt : undefined
  };
};

const openStyleSampleDb = (): Promise<IDBDatabase | null> => {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(STYLE_SAMPLE_DB_NAME, STYLE_SAMPLE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STYLE_SAMPLE_STORE_NAME)) {
        db.createObjectStore(STYLE_SAMPLE_STORE_NAME, { keyPath: "presetId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open style sample storage."));
  });
};

const loadBrowserStyleSamples = async (): Promise<PersistedStyleSamples> => {
  const db = await openStyleSampleDb();
  if (!db) return { results: {} };
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STYLE_SAMPLE_STORE_NAME, "readonly");
    const store = transaction.objectStore(STYLE_SAMPLE_STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      const results: Record<string, StyleSampleResult> = {};
      let prompt: string | undefined;
      for (const raw of request.result as any[]) {
        if (!raw || typeof raw !== "object") continue;
        if (raw.presetId === STYLE_SAMPLE_META_KEY) {
          if (typeof raw.prompt === "string") prompt = raw.prompt;
          continue;
        }
        const result = normalizeStyleSampleResult(raw);
        if (result) results[result.presetId] = result;
      }
      resolve({ prompt, results });
    };
    request.onerror = () => reject(request.error || new Error("Could not read style sample storage."));
    transaction.oncomplete = () => db.close();
  });
};

const loadServerStyleSamples = async (): Promise<PersistedStyleSamples> => {
  const archive = await getJson<StyleSampleArchiveResponse>("/api/style-samples");
  const results: Record<string, StyleSampleResult> = {};
  for (const raw of Object.values(archive.results || {})) {
    const result = normalizeStyleSampleResult(raw);
    if (result) results[result.presetId] = result;
  }
  return {
    prompt: typeof archive.prompt === "string" ? archive.prompt : undefined,
    results
  };
};

const loadPersistedStyleSamples = async (): Promise<PersistedStyleSamples> => {
  const [browser, server] = await Promise.allSettled([
    loadBrowserStyleSamples(),
    loadServerStyleSamples()
  ]);
  const browserSamples = browser.status === "fulfilled" ? browser.value : { results: {} };
  if (browser.status === "rejected") console.warn("Failed to load browser style samples:", browser.reason);
  const serverSamples = server.status === "fulfilled" ? server.value : { results: {} };
  if (server.status === "rejected") console.warn("Failed to load local style sample archive:", server.reason);

  return {
    prompt: serverSamples.prompt || browserSamples.prompt,
    results: {
      ...browserSamples.results,
      ...serverSamples.results
    }
  };
};

const persistBrowserStyleSampleResult = async (result: StyleSampleResult): Promise<void> => {
  const db = await openStyleSampleDb();
  if (!db) return;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STYLE_SAMPLE_STORE_NAME, "readwrite");
    transaction.objectStore(STYLE_SAMPLE_STORE_NAME).put(result);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Could not save style sample."));
    };
  });
};

const persistStyleSampleResult = async (result: StyleSampleResult): Promise<StyleSampleResult | null> => {
  const [browser, server] = await Promise.allSettled([
    persistBrowserStyleSampleResult(result),
    postJson<StyleSampleResultResponse>("/api/style-samples/result", result)
  ]);
  if (browser.status === "rejected") console.warn("Failed to save style sample in browser:", browser.reason);
  if (server.status === "rejected") console.warn("Failed to save style sample in local archive:", server.reason);
  if (server.status === "fulfilled") {
    const saved = normalizeStyleSampleResult(server.value.result);
    if (saved) {
      void persistBrowserStyleSampleResult(saved).catch((err) => console.warn("Failed to sync style sample back to browser:", err));
      return saved;
    }
  }
  return null;
};

const persistBrowserStyleSamplePrompt = async (prompt: string): Promise<void> => {
  const db = await openStyleSampleDb();
  if (!db) return;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STYLE_SAMPLE_STORE_NAME, "readwrite");
    transaction.objectStore(STYLE_SAMPLE_STORE_NAME).put({
      presetId: STYLE_SAMPLE_META_KEY,
      prompt,
      updatedAt: Date.now()
    });
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Could not save style sample prompt."));
    };
  });
};

const persistStyleSamplePrompt = async (prompt: string): Promise<void> => {
  const [browser, server] = await Promise.allSettled([
    persistBrowserStyleSamplePrompt(prompt),
    postJson<{ ok?: boolean }>("/api/style-samples/prompt", { prompt })
  ]);
  if (browser.status === "rejected") console.warn("Failed to save style sample prompt in browser:", browser.reason);
  if (server.status === "rejected") console.warn("Failed to save style sample prompt in local archive:", server.reason);
};

const clearBrowserStyleSamples = async (): Promise<void> => {
  const db = await openStyleSampleDb();
  if (!db) return;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STYLE_SAMPLE_STORE_NAME, "readwrite");
    transaction.objectStore(STYLE_SAMPLE_STORE_NAME).clear();
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Could not clear style samples."));
    };
  });
};

const clearServerStyleSamples = async (): Promise<void> => {
  const response = await fetch("/api/style-samples", { method: "DELETE" });
  if (!response.ok) throw new Error("Could not clear local style sample archive.");
};

const clearPersistedStyleSamples = async (): Promise<void> => {
  const [browser, server] = await Promise.allSettled([
    clearBrowserStyleSamples(),
    clearServerStyleSamples()
  ]);
  if (browser.status === "rejected") throw browser.reason;
  if (server.status === "rejected") throw server.reason;
};

const formatBusyDuration = (seconds: number, uiLanguage: UiLanguage): string => {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const restSeconds = safeSeconds % 60;
  if (uiLanguage === "ko") {
    if (minutes <= 0) return `${restSeconds}초`;
    return `${minutes}분 ${restSeconds.toString().padStart(2, "0")}초`;
  }
  if (minutes <= 0) return `${restSeconds}s`;
  return `${minutes}m ${restSeconds.toString().padStart(2, "0")}s`;
};

const estimatePlanningSeconds = ({
  busyPhase,
  creationType,
  targetPageCount,
  scriptDetail,
  geminiReasoningEffort,
  layoutVariety,
  pageCountMode
}: {
  busyPhase: BusyPhase;
  creationType: CreationType;
  targetPageCount: number;
  scriptDetail: ScriptDetail;
  geminiReasoningEffort: GeminiReasoningEffort;
  layoutVariety: LayoutVariety;
  pageCountMode: PageCountMode;
}): number => {
  if (busyPhase === "translating") return 90;
  const detailWeight = scriptDetail === "detailed" ? 60 : scriptDetail === "normal" ? 30 : 0;
  const reasoningWeight = geminiReasoningEffort === "high" ? 90 : geminiReasoningEffort === "medium" ? 45 : 0;
  const formatWeight = creationType === "paper" ? 70 : creationType === "story" ? 60 : 40;
  const layoutWeight = layoutVariety === "high" ? 45 : layoutVariety === "medium" ? 20 : 0;
  const autoPageWeight = pageCountMode === "auto" ? 30 : 0;
  const pageWeight = Math.max(1, targetPageCount) * 20;
  return Math.max(240, Math.min(720, 120 + detailWeight + reasoningWeight + formatWeight + layoutWeight + autoPageWeight + pageWeight));
};

const getPlanningProgressDetail = ({
  busyPhase,
  creationType,
  elapsedSeconds,
  estimatedSeconds,
  uiLanguage
}: {
  busyPhase: BusyPhase;
  creationType: CreationType;
  elapsedSeconds: number;
  estimatedSeconds: number;
  uiLanguage: UiLanguage;
}): { percent: number; label: string; helper: string; remainingLabel: string } => {
  const progressRatio = estimatedSeconds > 0 ? elapsedSeconds / estimatedSeconds : 0;
  const percent = progressRatio <= 1
    ? Math.max(6, Math.min(82, Math.round(6 + progressRatio * 76)))
    : Math.max(82, Math.min(95, Math.round(82 + Math.min(1, (elapsedSeconds - estimatedSeconds) / 300) * 13)));
  const isOverEstimate = elapsedSeconds > estimatedSeconds;
  const isWaitingForModel = percent >= 92 || isOverEstimate;
  const remainingSeconds = Math.max(0, estimatedSeconds - elapsedSeconds);
  const remainingLabel = isOverEstimate
    ? uiLanguage === "ko" ? "모델 응답 대기 중" : "Waiting for model response"
    : uiLanguage === "ko" ? `예상 남음 ${formatBusyDuration(remainingSeconds, uiLanguage)}` : `Est. remaining ${formatBusyDuration(remainingSeconds, uiLanguage)}`;

  if (busyPhase === "translating") {
    return {
      percent,
      remainingLabel,
      label: isWaitingForModel
        ? uiLanguage === "ko" ? "변환 결과 받는 중" : "Waiting for conversion result"
        : uiLanguage === "ko" ? "언어 변환 요청 처리 중" : "Processing language conversion",
      helper: uiLanguage === "ko" ? "완료 신호가 오기 전까지는 예상치야. 오래 걸리면 서버 응답을 기다리는 중으로 봐줘." : "This is an estimate until the model returns. If it runs long, it is waiting for the server response."
    };
  }

  if (elapsedSeconds >= PLANNING_STUCK_SECONDS) {
    return {
      percent: 95,
      remainingLabel: uiLanguage === "ko" ? "중단 필요" : "Needs restart",
      label: uiLanguage === "ko" ? "요청이 너무 오래 걸림" : "Request is taking too long",
      helper: uiLanguage === "ko"
        ? "10분을 넘긴 분석은 정상 생성으로 보지 않고 중단 처리해."
        : "Planning over 10 minutes is treated as stuck and should be stopped."
    };
  }

  if (isWaitingForModel) {
    return {
      percent,
      remainingLabel,
      label: uiLanguage === "ko" ? "서버 응답 대기 중" : "Waiting for server response",
      helper: uiLanguage === "ko"
        ? "콘티 요청은 서버에 올라갔고, 지금은 모델이 JSON 결과를 돌려주길 기다리는 구간이야."
        : "The planning request has been sent; the app is waiting for the model to return the JSON plan."
    };
  }

  const labelsKo =
    creationType === "paper"
      ? ["논문 구조 읽는 중", "페이지 흐름 설계 중", "컷별 설명 구성 중", "콘티 JSON 정리 중"]
      : creationType === "story"
        ? ["스토리 구조 읽는 중", "주인공 역할 설계 중", "장면별 콘티 구성 중", "콘티 JSON 정리 중"]
        : ["자료 핵심 정리 중", "주인공 역할 설계 중", "페이지별 콘티 구성 중", "콘티 JSON 정리 중"];
  const labelsEn =
    creationType === "paper"
      ? ["Reading paper structure", "Designing page flow", "Composing explanatory cuts", "Finalizing plan JSON"]
      : creationType === "story"
        ? ["Reading story structure", "Designing protagonist role", "Composing scene plan", "Finalizing plan JSON"]
        : ["Digesting source material", "Designing protagonist role", "Composing page plan", "Finalizing plan JSON"];
  const index = percent < 28 ? 0 : percent < 58 ? 1 : percent < 82 ? 2 : 3;
  return {
    percent,
    remainingLabel,
    label: uiLanguage === "ko" ? labelsKo[index] : labelsEn[index],
    helper: uiLanguage === "ko"
      ? "모델 내부 진행률이 아니라 경과 시간 기준 예상치야. 완료 신호가 오기 전에는 100%로 표시하지 않아."
      : "This is an elapsed-time estimate, not the model's internal progress. It will not show 100% until completion."
  };
};

const getInitialUiLanguage = (): UiLanguage => {
  try {
    const saved = localStorage.getItem("toon_for_codex_ui_language");
    return saved === "en" ? "en" : "ko";
  } catch {
    return "ko";
  }
};

const formatLabel = (
  uiLanguage: UiLanguage,
  labelKo: string | undefined,
  labelEn: string | undefined,
  fallback: string
): string => {
  if (uiLanguage === "ko") return labelKo || fallback;
  return labelEn || fallback;
};

const getAudienceLevelLabel = (level: AudienceLevel, uiLanguage: UiLanguage): string => {
  const labels: Record<AudienceLevel, { ko: string; en: string }> = {
    kids: { ko: "어린이", en: "Kids" },
    teen: { ko: "청소년", en: "Teens" },
    beginner: { ko: "입문자", en: "Beginners" },
    intermediate: { ko: "중급자", en: "Intermediate" },
    expert: { ko: "전문가", en: "Experts" }
  };
  const label = labels[level];
  return uiLanguage === "ko" ? label.ko : label.en;
};

const getAgeRatingLabel = (rating: AgeRating, uiLanguage: UiLanguage): string => {
  const labels: Record<AgeRating, { ko: string; en: string }> = {
    all_ages: { ko: "전체 이용가", en: "All Ages" },
    teen: { ko: "청소년 (PG-13)", en: "Teen (PG-13)" },
    mature: { ko: "성인", en: "Mature" }
  };
  const label = labels[rating];
  return uiLanguage === "ko" ? label.ko : label.en;
};

const getStoryGenreLabel = (genre: StoryGenre, uiLanguage: UiLanguage): string => {
  const labels: Record<StoryGenre, { ko: string; en: string }> = {
    action: { ko: "액션", en: "Action" },
    romance: { ko: "로맨스", en: "Romance" },
    horror: { ko: "호러", en: "Horror" },
    comedy: { ko: "코미디", en: "Comedy" },
    drama: { ko: "드라마", en: "Drama" },
    fantasy: { ko: "판타지", en: "Fantasy" },
    sci_fi: { ko: "SF", en: "Sci-Fi" },
    slice_of_life: { ko: "일상", en: "Slice of Life" },
    mystery: { ko: "미스터리", en: "Mystery" }
  };
  const label = labels[genre];
  return uiLanguage === "ko" ? label.ko : label.en;
};

const getDeliveryStyleLabel = (id: DeliveryStyleId | string | undefined, uiLanguage: UiLanguage): string => {
  const labels: Record<DeliveryStyleId, { ko: string; en: string }> = {
    standard: { ko: "일반적(표준)", en: "Natural Standard" },
    community: { ko: "인터넷 커뮤니티 말투", en: "Online Community" },
    friendly_banmal: { ko: "친근한 반말", en: "Casual Friendly" },
    elder: { ko: "어르신 대상", en: "Senior-Friendly" },
    half_honorific: { ko: "반존대", en: "Casual-Polite Mix" },
    military: { ko: "군인 말투", en: "Military Briefing" },
    kindergarten_teacher: { ko: "유치원 선생님", en: "Kindergarten Teacher" },
    custom: { ko: "직접 입력(커스텀)", en: "Custom" }
  };
  const label = labels[(id || "standard") as DeliveryStyleId] || labels.standard;
  return uiLanguage === "ko" ? label.ko : label.en;
};

interface HealthResponse {
  codex_oauth_autostart?: boolean;
  codex_oauth_port?: number;
  codex_image_model?: string;
  codex_text_model?: string;
  gemini_text_model?: string;
  gemini_api_configured?: boolean;
}

interface OAuthStatusResponse {
  status?: string;
}

const normalizeCodexImageModel = (model?: string): string =>
  String(model || "").trim() || FALLBACK_CODEX_IMAGE_MODEL;

const deriveTopicFromMaterial = (material: string, fallback: string): string => {
  const firstLine = material
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return fallback;
  return firstLine.length > 48 ? `${firstLine.slice(0, 48)}...` : firstLine;
};

const getCodexImageModelLabel = (model?: string): string => {
  const normalized = normalizeCodexImageModel(model);
  if (normalized === "gpt-5.4-mini") return "Codex GPT 5.4 Mini";
  if (normalized === "gpt-5.4") return "Codex GPT 5.4";
  if (normalized === "gpt-5.5") return "Codex GPT 5.5";
  return normalized;
};

const getCodexTextModelLabel = (model?: string): string => {
  const normalized = String(model || "").trim() || GEMINI_PLANNER_MODEL;
  if (normalized === "gpt-5.4-mini") return "Codex GPT 5.4 Mini";
  if (normalized === "gpt-5.4") return "Codex GPT 5.4";
  if (normalized === "gpt-5.5") return "Codex GPT 5.5";
  return normalized;
};

const buildImageEngineKey = (
  provider: ImageProvider,
  codexImageModel: string,
  codexImageQuality: CodexImageQuality
): string =>
  `codex:${normalizeCodexImageModel(codexImageModel)}:${codexImageQuality}`;

const getImageEngineLabel = (
  provider: ImageProvider,
  codexImageModel: string,
  codexImageQuality: CodexImageQuality
): string =>
  `${getCodexImageModelLabel(codexImageModel)} (${codexImageQuality})`;

const getImageEngineChipLabel = (
  provider: ImageProvider,
  codexImageModel: string,
  codexImageQuality: CodexImageQuality
): string =>
  `Codex ${codexImageQuality}`;

const getImageEngineChipLabelFromKey = (key: string | null | undefined): string => {
  const normalized = String(key || "").trim();
  if (!normalized) return "";
  if (normalized.startsWith("codex:")) {
    const [, model = FALLBACK_CODEX_IMAGE_MODEL, quality = DEFAULT_CODEX_IMAGE_QUALITY] = normalized.split(":");
    return `${getCodexImageModelLabel(model).replace(/^Codex\s+/, "")} ${quality}`;
  }
  return normalized;
};

const getPreviewAspectClass = (format: PublicationFormat, ratio: I2VAspectRatio): string => {
  if (isKlingI2VFormat(format)) {
    if (ratio === "16:9") return "aspect-[16/9]";
    if (ratio === "1:1") return "aspect-[1/1]";
    return "aspect-[9/16]";
  }
  if (isInstatoon(format)) return "aspect-[4/5]";
  if (isWebtoon(format)) return "aspect-[9/16]";
  if (isManga(format)) return "aspect-[728/1032]";
  return "aspect-[9/16]";
};

const getUnitLabelForFormat = (format: PublicationFormat): string =>
  getFormatConfig(format).unitLabel;

/** Map PublicationFormat back to legacy OutputMode for downstream services */
const toLegacyOutputMode = (format: PublicationFormat): OutputMode =>
  format === "kling_i2v" ? "kling_i2v" : "comic";

const getComicModeDisplayLabel = (mode: ComicMode): string => {
  if (isPureCinematicMode(mode)) return "CINEMATIC";
  if (isEduCinematicMode(mode)) return "SCENE-LED";
  return "LEARNING";
};

const getComicModeEssenceLabel = (mode: ComicMode): string => {
  if (isPureCinematicMode(mode)) return "Cinematic Essence";
  if (isEduCinematicMode(mode)) return "Scene-Led Learning";
  return "Learning Essence";
};

const maskSecretsInText = (value: string): string => {
  return value
    .replace(/sk-[A-Za-z0-9]{8,}/g, "sk-***")
    .replace(/AIza[0-9A-Za-z\-_]{8,}/g, "AIza***")
    .replace(/Bearer\s+[A-Za-z0-9\-_\.]{8,}/gi, "Bearer ***");
};

const toUserFacingError = (rawMessage: string, fallback: string, uiLanguage: UiLanguage = "ko"): string => {
  const masked = maskSecretsInText(String(rawMessage || "").trim() || fallback);
  if (/failed to fetch|networkerror/i.test(masked)) {
    return uiLanguage === "ko"
      ? [
        "로컬 API 서버에 연결하지 못했어. (Failed to fetch)",
        "1) `npm run dev`로 web+api를 함께 실행해줘.",
        "2) 또는 `npm run dev:api`(8787) + `npm run dev:web`(3000)을 각각 실행해줘.",
        "3) `http://127.0.0.1:8787/api/health` 접속 시 JSON이 보이면 정상이야."
      ].join("\n")
      : [
        "Could not connect to the local API server. (Failed to fetch)",
        "1. Run web+api together with `npm run dev`.",
        "2. Or run `npm run dev:api` (8787) and `npm run dev:web` (3000) separately.",
        "3. If `http://127.0.0.1:8787/api/health` returns JSON, the API is healthy."
      ].join("\n");
  }
  return masked;
};

type CastSuggestionNotice = {
  kind: "info" | "success" | "error";
  message: string;
  detail?: string;
};

const deepClone = <T,>(value: T): T => {
  const sc = (globalThis as any)?.structuredClone as ((v: T) => T) | undefined;
  if (typeof sc === "function") return sc(value);
  return JSON.parse(JSON.stringify(value)) as T;
};

const createClientId = (): string => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: any = crypto as any;
    if (c?.randomUUID) return c.randomUUID();
  } catch { }
  return `c_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

const createCharacter = (role: CastRole, name?: string): CharacterSpec => {
  const defaultName = role === "protagonist" ? "주인공" : "";
  return {
    id: createClientId(),
    role,
    name: String(name ?? defaultName),
    appearance: "",
    persona: "",
    catchphrase: "",
    catchphrase_frequency: "rare",
    reference_images: []
  };
};

const cloneCastForQuickReuse = (items: CharacterSpec[]): CharacterSpec[] =>
  items.map((c) => ({
    ...c,
    reference_images: Array.isArray(c.reference_images) ? [...c.reference_images] : [],
    style_aligned_reference_images: Array.isArray(c.style_aligned_reference_images)
      ? [...c.style_aligned_reference_images]
      : c.style_aligned_reference_images
  }));

const isDataUrl = (value: unknown): boolean => {
  return typeof value === "string" && /^data:/i.test(value.trim());
};

const keepPersistableImageUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isDataUrl(trimmed) && trimmed.length > MAX_PERSISTABLE_DATA_URL_LENGTH) return null;
  return trimmed;
};

const pickPersistableImageUrls = (value: unknown, limit: number): string[] => {
  if (!Array.isArray(value) || limit <= 0) return [];
  const picked: string[] = [];
  for (const raw of value) {
    const persistable = keepPersistableImageUrl(raw);
    if (!persistable) continue;
    picked.push(persistable);
    if (picked.length >= limit) break;
  }
  return picked;
};

const sortGenerationResults = (items: GenerationResult[]): GenerationResult[] =>
  [...items].sort((a, b) => a.page_index - b.page_index);

const upsertGenerationResult = (
  prev: GenerationResult[],
  nextItem: GenerationResult
): GenerationResult[] =>
  sortGenerationResults([
    ...prev.filter((item) => item.page_index !== nextItem.page_index),
    nextItem,
  ]);

const clampQuickStripCount = (value: number): number => {
  const floored = Math.floor(value);
  if (!Number.isFinite(floored)) return 1;
  return Math.max(1, Math.min(QUICK_PIPELINE_MAX_TOTAL_STRIPS, floored));
};

const applyQuickEpisodeSplit = (
  plan: SeriesPlan,
  maxUnitsPerEpisode = QUICK_PIPELINE_MAX_STRIPS_PER_EPISODE,
  unitLabel = "strip"
): SeriesPlan => {
  let episodeIndex = 1;
  let episodeUnitCount = 0;
  const episodeBreaks: Array<{ episode: number; start_unit: number; end_unit: number; unit_count: number; start_strip?: number; end_strip?: number; strip_count?: number }> = [];
  let currentStartUnit = plan.pages[0]?.page.index || 1;
  let currentEpisodeStrips = 0;

  const pages = plan.pages.map((page) => {
    if (episodeUnitCount > 0 && episodeUnitCount + 1 > maxUnitsPerEpisode) {
      episodeBreaks.push({
        episode: episodeIndex,
        start_unit: currentStartUnit,
        end_unit: page.page.index - 1,
        unit_count: currentEpisodeStrips,
        start_strip: currentStartUnit,
        end_strip: page.page.index - 1,
        strip_count: currentEpisodeStrips
      });
      episodeIndex += 1;
      episodeUnitCount = 0;
      currentEpisodeStrips = 0;
      currentStartUnit = page.page.index;
    }

    episodeUnitCount += 1;
    currentEpisodeStrips += 1;

    const cleanTitle = String(page.page.chapter_title || "").replace(/^\d+편\s*[·:-]\s*/u, "").trim();
    return {
      ...page,
      page: {
        ...page.page,
        chapter_title: `${episodeIndex}편 · ${cleanTitle || `파트 ${page.page.index}`}`
      }
    };
  });

  if (pages.length > 0) {
    episodeBreaks.push({
      episode: episodeIndex,
      start_unit: currentStartUnit,
      end_unit: pages[pages.length - 1].page.index,
      unit_count: currentEpisodeStrips,
      start_strip: currentStartUnit,
      end_strip: pages[pages.length - 1].page.index,
      strip_count: currentEpisodeStrips
    });
  }

  return {
    ...plan,
    pages,
    plan_meta: {
      ...plan.plan_meta,
      quick_episode_split: {
        unit_label: unitLabel,
        max_units_per_episode: maxUnitsPerEpisode,
        max_strips_per_episode: maxUnitsPerEpisode,
        episode_count: episodeBreaks.length,
        total_units: pages.length,
        total_strips: pages.length,
        episodes: episodeBreaks
      }
    }
  };
};

const isQuickEpisodeSplitFormat = (format: QuickPipelinePublicationFormat): boolean =>
  format === "webtoon" || format === "instatoon";

const getQuickEpisodeUnitLimit = (
  format: QuickPipelinePublicationFormat,
  requestedUnitsPerEpisode = QUICK_PIPELINE_MAX_STRIPS_PER_EPISODE
): number => {
  const limit = format === "instatoon" ? INSTATOON_MAX_CARDS_PER_EPISODE : QUICK_PIPELINE_MAX_STRIPS_PER_EPISODE;
  const requested = Math.floor(requestedUnitsPerEpisode);
  if (!Number.isFinite(requested)) return limit;
  return Math.max(1, Math.min(limit, requested));
};

const applyQuickEpisodeSplitForFormat = (
  plan: SeriesPlan,
  format: QuickPipelinePublicationFormat,
  requestedUnitsPerEpisode = QUICK_PIPELINE_MAX_STRIPS_PER_EPISODE
): SeriesPlan =>
  isQuickEpisodeSplitFormat(format)
    ? applyQuickEpisodeSplit(plan, getQuickEpisodeUnitLimit(format, requestedUnitsPerEpisode), format === "instatoon" ? "card" : "strip")
    : plan;

const getQuickFormatUnitLabel = (
  format: QuickPipelinePublicationFormat,
  uiLanguage: UiLanguage
): string => {
  if (format === "instatoon") return uiLanguage === "ko" ? "카드" : "Card";
  if (format === "webtoon") return uiLanguage === "ko" ? "스트립" : "Strip";
  return uiLanguage === "ko" ? "페이지" : "Page";
};

const compactStyleForStorage = (
  style: SeriesSpec["anchors"]["style"] | null | undefined
): SeriesSpec["anchors"]["style"] | null => {
  if (!style) return null;
  return {
    ...style,
    style_reference_image: keepPersistableImageUrl(style.style_reference_image ?? "") || null
  };
};

const compactCastForStorage = (items: CharacterSpec[]): CharacterSpec[] => {
  return items.map((c) => ({
    ...c,
    reference_images: pickPersistableImageUrls(c.reference_images, MAX_PERSISTABLE_REF_IMAGES_PER_CHARACTER),
    style_aligned_reference_images: pickPersistableImageUrls(c.style_aligned_reference_images, 1)
  }));
};

const compactSeriesPlanForStorage = (plan: SeriesPlan): SeriesPlan => {
  const next = deepClone(plan);
  // Planner debug payload can be very large and cause localStorage quota failures.
  if ((next as any).debug) delete (next as any).debug;
  const anchors = next.series_spec?.anchors;
  if (!anchors) return next;

  if (anchors.protagonist?.reference_images) {
    const compactedPack = pickPersistableImageUrls(
      anchors.protagonist.reference_images.pack,
      MAX_PERSISTABLE_REF_IMAGES_PER_CHARACTER
    );
    const compactedMain = keepPersistableImageUrl(anchors.protagonist.reference_images.main);
    anchors.protagonist.reference_images.main = compactedMain || compactedPack[0] || "";
    anchors.protagonist.reference_images.pack = compactedPack;
  }

  if (anchors.product?.reference_images) {
    anchors.product.reference_images = pickPersistableImageUrls(
      anchors.product.reference_images,
      MAX_PERSISTABLE_PRODUCT_REF_IMAGES
    );
  }

  if (Array.isArray(anchors.cast)) {
    anchors.cast = compactCastForStorage(anchors.cast);
  }

  const compactedStyle = compactStyleForStorage(anchors.style);
  if (compactedStyle) {
    anchors.style = compactedStyle;
  }

  return next;
};

const compactStyleOverrideRecordForStorage = (
  overrides: Record<number, SeriesSpec["anchors"]["style"]>
): Record<number, SeriesSpec["anchors"]["style"]> => {
  const next: Record<number, SeriesSpec["anchors"]["style"]> = {};
  for (const [rawIndex, style] of Object.entries(overrides)) {
    const pageIndex = Number.parseInt(rawIndex, 10);
    if (!Number.isFinite(pageIndex)) continue;
    const compactedStyle = compactStyleForStorage(style);
    if (!compactedStyle) continue;
    next[pageIndex] = compactedStyle;
  }
  return next;
};

const normalizeCastFromSnapshot = (items: CharacterSpec[] | null | undefined): CharacterSpec[] => {
  const mapped: CharacterSpec[] = (Array.isArray(items) ? items : []).map((c) => {
    const role: CastRole = c?.role === "supporting" ? "supporting" : "protagonist";
    const catchphraseFrequency: CatchphraseFrequency =
      c?.catchphrase_frequency === "often" || c?.catchphrase_frequency === "sometimes"
        ? c.catchphrase_frequency
        : "rare";

    return {
      ...createCharacter(role),
      id: createClientId(),
      role,
      name: String(c?.name ?? ""),
      appearance: String(c?.appearance ?? ""),
      analyzed_appearance: String(c?.analyzed_appearance ?? "").trim() || undefined,
      persona: String(c?.persona ?? ""),
      catchphrase: String(c?.catchphrase ?? ""),
      catchphrase_frequency: catchphraseFrequency,
      reference_images: Array.isArray(c?.reference_images)
        ? c.reference_images
          .map((img) => keepPersistableImageUrl(img))
          .filter((img): img is string => Boolean(img))
        : [],
      style_aligned_reference_images: pickPersistableImageUrls((c as any)?.style_aligned_reference_images, 1),
      style_aligned_reference_style_key: String((c as any)?.style_aligned_reference_style_key ?? "").trim() || undefined
    };
  });

  const protagonists = mapped.filter((c) => c.role === "protagonist").slice(0, 2);
  const supporting = mapped.filter((c) => c.role === "supporting");
  return protagonists.length > 0 ? [...protagonists, ...supporting] : [createCharacter("protagonist"), ...supporting];
};

const syncPlanAnchorsFromSnapshot = (
  plan: SeriesPlan,
  opts: {
    cast: CharacterSpec[];
    productReferenceImages: string[];
    finalStyle: SeriesSpec["anchors"]["style"] | null;
    narrativeRole: NarrativeRole;
    topic: string;
    comicMode: ComicMode;
    publicationFormat: PublicationFormat;
    i2vAspectRatio: I2VAspectRatio;
    mangaColorMode?: MangaColorMode;
    imageProvider: ImageProvider;
    codexImageQuality: CodexImageQuality;
    characterConsistencyMode: CharacterConsistencyMode;
    storyAntiEducationGuardEnabled: boolean;
  }
): SeriesPlan => {
  const next = deepClone(plan);
  const spec = next?.series_spec;
  if (!spec?.anchors?.protagonist) return next;

  const anchors = spec.anchors;
  const cast = (opts.cast || []).map((c) => ({
    ...c,
    reference_images: Array.isArray(c.reference_images) ? [...c.reference_images] : []
  }));

  if (cast.length > 0) anchors.cast = cast;
  else delete anchors.cast;

  const primary = cast.find((c) => c.role === "protagonist");
  if (primary) {
    const refPack = Array.isArray(primary.reference_images) ? primary.reference_images.filter(Boolean) : [];
    const fallbackMain = keepPersistableImageUrl(anchors.protagonist.reference_images?.main) || "";
    const fallbackPack = Array.isArray(anchors.protagonist.reference_images?.pack)
      ? anchors.protagonist.reference_images.pack.filter(Boolean)
      : [];
    const protagonistAppearance =
      String(primary.appearance || "").trim() ||
      String(primary.name || "").trim() ||
      String(anchors.protagonist.appearance || "").trim();
    const mergedPack = refPack.length > 0 ? refPack : fallbackPack;

    anchors.protagonist = {
      ...anchors.protagonist,
      appearance: protagonistAppearance,
      role: opts.narrativeRole,
      reference_images: {
        main: mergedPack[0] || fallbackMain,
        pack: mergedPack
      }
    };
  } else {
    anchors.protagonist = {
      ...anchors.protagonist,
      role: opts.narrativeRole
    };
  }

  if (opts.productReferenceImages.length > 0) {
    const existingLabel = String(anchors.product?.label || "").trim();
    const fallbackLabel =
      String(opts.topic || "").trim() || String(spec.series?.title || "").trim() || "Product";
    anchors.product = {
      label: existingLabel || fallbackLabel,
      reference_images: opts.productReferenceImages
    };
  } else {
    delete anchors.product;
  }

  if (opts.finalStyle) anchors.style = opts.finalStyle;
  spec.constraints = {
    ...spec.constraints,
    comic_mode: opts.comicMode,
    output_mode: toLegacyOutputMode(opts.publicationFormat),
    publication_format: opts.publicationFormat,
    manga_color_mode: opts.mangaColorMode,
    i2v_aspect_ratio: opts.i2vAspectRatio,
    image_provider: opts.imageProvider,
    codex_image_quality: opts.codexImageQuality,
    character_consistency_mode: opts.characterConsistencyMode,
    story_anti_education_guard: opts.storyAntiEducationGuardEnabled
  };
  return next;
};

const buildCastSummaryLine = (c: CharacterSpec): string => {
  const name = String(c.name || "").trim();
  const appearance = String(c.appearance || "").trim();
  const persona = String(c.persona || "").trim();
  const catchphrase = String(c.catchphrase || "").trim();
  const freq = String(c.catchphrase_frequency || "rare").trim();
  const bits = [];
  if (name) bits.push(name);
  if (persona) bits.push(persona);
  if (appearance) bits.push(appearance);
  if (catchphrase) bits.push(`말버릇(${freq}): ${catchphrase}`);
  return bits.join(" / ");
};

const buildStyleReferenceKey = (style: SeriesSpec["anchors"]["style"]): string =>
  [
    "photo-style-transfer-v1",
    style.preset_id,
    style.render_mode,
    style.style_prompt,
    style.user_style_prompt || ""
  ].join("|");

const buildGenreEraLockForCharacter = (sourceText: string): string => {
  if (/(무협|무림|강호|문파|내공|단전|검법|검기|협객|사부|사형|사매|장문인|비급|객잔|도관|도사|마교|정파|사파)/i.test(sourceText)) {
    return "WUXIA / murim martial arts world. Use traditional East Asian martial arts costume: flowing hanfu/hanbok-inspired robes, martial sect uniform, cloth belt, bracers, sword sheath, topknot or long tied hair. Absolutely avoid modern business suits, blazers, neckties, office-worker styling, sneakers, and contemporary city fashion unless the source explicitly says so.";
  }
  if (/(사극|조선|고려|왕궁|궁궐|왕세자|왕비|선비|한복|도포|상투|기생|장군|포졸|관아)/i.test(sourceText)) {
    return "Historical period drama world. Use traditional period clothing such as hanbok, dopo, official robes, armor, or court clothing. Avoid modern suits, neckties, office outfits, and contemporary fashion.";
  }
  if (/(중세|기사|마법사|왕국|공작|후작|백작|검과 마법|드래곤|엘프|마탑|성기사)/i.test(sourceText)) {
    return "Medieval fantasy world. Use tunics, cloaks, robes, leather gear, armor, or fantasy uniforms. Avoid modern suits, neckties, and office outfits.";
  }
  if (/(sf|sci-fi|우주|행성|사이버|로봇|안드로이드|우주선|미래도시)/i.test(sourceText)) {
    return "Science-fiction world. Use future-facing uniforms, functional jackets, tech gear, or space/cyber silhouettes instead of ordinary modern business clothing.";
  }
  return "Follow the era, place, and genre implied by the source material. Do not default to modern business suits or office clothing unless the source clearly requires it.";
};

const buildResearchPrompt = (topic: string, role: NarrativeRole, questionType: QuestionType): string => {
  const looksLikeHowToTopic = (t: string): boolean =>
    /(방법|하는\s*법|만드는\s*법|만들기|레시피|조리법|요리|튜토리얼|가이드|절차|순서|단계|설치|세팅|설정|사용법|how\s*to|tutorial|guide|recipe|setup|install)/i.test(
      String(t || "").trim()
    );

  const isHowTo = looksLikeHowToTopic(topic);

  const roleLine =
    role === 'narrator'
      ? '주인공은 제3자 가이드/관찰자(설명자)입니다. 실제 대상(인물/사물/원리)은 주인공과 분리해서 묘사될 수 있게 정보를 정리하세요.'
      : '주인공이 주제의 핵심 인물/원리/대상이 되어 직접 연기합니다. 장면화가 가능한 행동/상황 중심으로 정보를 정리하세요.';

  const questionLine =
    questionType === "compare"
      ? '질문 형태: Compare (A vs B). 승자/패자 단정이 아니라 비교축 기반의 조건부 결론이 목표입니다.'
      : isHowTo
        ? '질문 형태: Explain (How-to). "방법/절차/레시피/튜토리얼" 주제이므로, 오해 반박형 훅(“~라고 생각했겠지만…”)을 강제하지 말고 바로 따라할 수 있게 구성하세요.'
        : '질문 형태: Explain (Concept / Standard). 첫 문장은 "A란/현재진행형이란/오늘은 A를 배워요"처럼 정의/목표로 바로 시작하세요. 도입에서 "단순히 ~가 아니라", "단순한 ~가 아니라", "그것은 단순한 ~가 아니라, ~다", "많이들 ~라고 생각하지만", "사실은", "오해/착각" 같은 AI식 반박/대조 프레이밍을 쓰지 마세요. 오해 교정은 필요할 때만 중후반에 짧게.';

  const extraRuleLine =
    questionType === "compare"
      ? '(Compare) A와 B를 명확히 분리해 question.a / question.b에 넣으세요. (주제가 "A vs B" 형태면 그대로 분해)'
      : "(Explain) 질문을 safe_framing으로 다시 쓰되, 반드시 '정의/경계(무엇이 아닌지)'까지 포함하세요.";

  const outputShape =
    questionType === "compare"
      ? `{
  "question": { "type": "compare", "a": "A", "b": "B" },
  "mini_brief": {
    "safe_framing": "과장/선동 없이 다시 쓴 질문(비교 프레임)",
    "one_line_takeaway": "독자가 가져갈 한 줄(조건부)",
    "comparison_axes": ["비교축1", "비교축2", "비교축3"],
    "verified_claims": [
      { "claim": "핵심 사실/관찰(검증됨)", "evidence": "짧은 근거(링크 없이도 OK)" }
    ],
    "where_a_wins": ["조건 ..."],
    "where_b_wins": ["조건 ..."],
    "beats_4_panel": ["1컷(프레임)", "2컷(축1/2)", "3컷(축3/트레이드오프)", "4컷(조건부 결론/주의)"]
  }
}`
      : `{
  "question": { "type": "explain", "topic": "주제" },
  "mini_brief": {
    "safe_framing": "과장/선동 없이 다시 쓴 질문(정의/경계 포함)",
    "one_line_takeaway": "독자가 가져갈 한 줄",
    "verified_claims": [
      { "claim": "핵심 사실/관찰(검증됨)", "evidence": "짧은 근거(링크 없이도 OK)" }
    ],
    "common_misconceptions": [
      { "myth": "오해(선택)", "fact": "정정(선택)" }
    ],
    "analogy_bank": [
      { "analogy": "강력한 비유", "maps_to": "어떤 개념을 설명하는지" }
    ],
    "beats_4_panel": ${isHowTo
        ? '["1컷(오늘의 목표/완성)", "2컷(준비물/전제)", "3컷(핵심 단계/순서)", "4컷(주의/팁/체크)"]'
        : '["1컷(상황/질문 훅)", "2컷(정의/경계)", "3컷(원리/예시)", "4컷(요약/체크)"]'
      }
  }
}`;

  return `정보조사 AI에게 다음을 요청하십시오.

주제: "${topic || '[여기에 주제를 넣으세요]'}"
목표: 이 앱(교육 만화)이 환각 없이 스크립트를 만들 수 있도록, 근거가 있는 사실/맥락/비유 재료를 수집해 주세요.
${questionLine}

중요:
- 모르는 내용은 추측하지 말고, 확인하기 어렵다고 자연스럽게 남기세요.
- 단정적 사실/수치는 반드시 "근거(evidence)"를 함께 적어 주세요. (출처 URL은 선택)
- 숫자/연도/고유명사/인과관계는 특히 엄격하게 검증하세요.
- ${extraRuleLine}
- 한국어로 작성하세요.
- ${roleLine}

출력 형식(반드시 JSON만):
${outputShape}`;
};

const buildReportRequestTemplate = (
  topic: string,
  role: NarrativeRole,
  questionType: QuestionType,
  comicMode: ComicMode
): string => {
  const isEduCinematic = comicMode === "cinematic";
  const isPureCinematic = comicMode === "pure_cinematic";

  const roleLine =
    role === "narrator"
      ? isPureCinematic
        ? "주인공은 제3자 관찰자/반응자로 등장합니다. 설명자가 아니라 사건의 리듬을 조절하는 시점으로 재료를 정리해 주세요."
        : isEduCinematic
          ? "주인공은 제3자 가이드/관찰자로 등장합니다. 과도한 강의문 대신 장면에서 의미가 드러나게 정리해 주세요."
          : "주인공은 제3자 가이드/관찰자(설명자)로 등장합니다. 실제 대상(인물/사물/원리)은 주인공과 분리해서 설명되도록, 장면화 가능한 설명 재료로 정리해 주세요."
      : isPureCinematic
        ? "주인공이 사건의 중심 배우가 됩니다. 욕망-갈등-선택-대가가 보이는 사건/행동 중심으로 정리해 주세요."
        : "주인공이 주제의 핵심 인물/원리/대상이 되어 직접 연기합니다. 장면화 가능한 사건/행동/상황 중심으로 정리해 주세요.";

  if (isPureCinematic) {
    const commonRules = `당신은 '시네마틱 스토리 제작'을 위한 리서치 보고서를 작성합니다.

모드: CINEMATIC (순수 스토리)
주제: "${topic || "확인 불가"}"
목표: 아래 보고서만을 근거로, 4컷 시네마틱 스토리의 장면 재료(세계관/갈등/전환/엔딩 훅)를 만들 수 있게 합니다.

매우 중요한 규칙(반드시 준수):
- 출력은 한국어, 자연스러운 보고서 문장으로 작성하세요.
- 표(테이블) 사용 금지. (마크다운 표 포함)
- 입력/근거 없이 사실/수치/연도/고유명사/인과관계를 만들어내지 마세요.
- 확인 불가 항목은 없는 내용을 채우지 말고 자연스럽게 보류하세요.
- 특정 개인/집단 비방, 허위 사실 단정, 명예훼손성 서사는 금지합니다.
- "교육적 요약/정의 강의" 대신 장면화 가능한 재료(행동, 충돌, 동기, 소품, 공간, 카메라 무드)로 정리하세요.

${roleLine}

권장 분량: 1,500~5,000자(더 길어도 OK).`;

    if (questionType === "review") {
      return `${commonRules}

[보고서 구성(Cinematic Review)]
1) 로그라인(1~2문장)
- 주인공이 무엇을 얻으려다 어떤 문제를 만나는지.

2) 세팅/맥락
- 시간/장소/인물 관계/초기 목표를 명확히.

3) 테스트/충돌 포인트(3~7개)
- 장면에서 바로 보여줄 수 있는 문제/제약/장애물 중심.

4) 전환(해법/선택/트릭)
- 어떤 선택으로 흐름이 바뀌는지, 대가가 무엇인지.

5) 엔딩 훅
- 결론 요약문이 아니라 여운/다음 갈등 암시로 마무리.

6) 비주얼 모티프
- 반복 소품/색감/질감/공간 톤(실사/애니/만화 연출 힌트).

7) 4컷 비트
- 1컷 세팅 → 2컷 충돌 → 3컷 전환 → 4컷 엔딩 훅.


9) Sources
- [S1] ...
- [S2] ...
`;
    }

    if (questionType === "compare") {
      return `${commonRules}

[보고서 구성(Cinematic Compare: 라이벌전)]
1) 로그라인(1~2문장)
- A와 B의 충돌 이유와 결판 조건.

2) 라이벌 프로필
- A의 강점/약점, B의 강점/약점을 장면화 가능한 요소로 정리.

3) 갈등축(3~6개)
- 축마다 어떤 장면 충돌이 가능한지(행동/전술/환경)까지 명시.

4) 반전 포인트
- 우위가 뒤집히는 조건/단서/트리거.

5) 엔딩 설계
- 승패 또는 열린 결말의 조건(비방/허위 단정 금지).

6) 비주얼 모티프
- 각 진영의 상징 요소/톤/카메라 무드.

7) 4컷 비트
- 1컷 대치 → 2컷 압박 → 3컷 반전 → 4컷 결판/훅.


9) Sources
- [S1] ...
- [S2] ...
`;
    }

    return `${commonRules}

[보고서 구성(Cinematic Story: Explain)]
1) 로그라인(1~2문장)
- 주인공의 욕망/결핍과 첫 사건.

2) 세계관/배경 규칙
- 공간, 시대감, 제약 조건, 사건이 성립하는 전제.

3) 인물 동기/감정선
- 주인공(필수)과 대립 요소(인물/환경/상황)의 목표 충돌.

4) 핵심 갈등과 상승 구조
- 긴장이 단계적으로 올라가는 2~4개의 포인트.

5) 전환점과 대가
- 선택 이후 무엇을 얻고 무엇을 잃는지.

6) 엔딩 훅
- 교훈문 대신 여운/질문/다음 갈등 제시.

7) 비주얼 모티프
- 그림체/실사 감각 전환에 도움 되는 소품/색/질감/카메라 톤.

8) 4컷 비트
- 1컷 세팅(욕망) → 2컷 충돌 → 3컷 전환(선택/대가) → 4컷 엔딩 훅.


10) Sources
- [S1] ...
- [S2] ...
`;
  }

  const productionLabel = isEduCinematic ? "Edu-Cinematic 만화 제작" : "교육 만화 제작";
  const goalLabel = isEduCinematic
    ? "교육 핵심은 유지하되 장면 중심으로 전개되는 4컷 스크립트를 안전하게 만들 수 있게 합니다."
    : "교육 만화(페이지 단위, 1페이지=4컷) 스크립트를 안전하게 만들 수 있게 합니다.";
  const commonRules = `당신은 '${productionLabel}'을 위한 리서치 보고서를 작성합니다.

모드: ${isEduCinematic ? "EDU-CINEMATIC" : "LEARNING"}
주제: "${topic || "확인 불가"}"
목표: 아래 보고서만을 근거로, ${goalLabel}

매우 중요한 규칙(반드시 준수):
- 출력은 한국어, '한 편의 보고서'처럼 자연스럽게 작성하세요.
- 표(테이블) 사용 금지. (마크다운 표 포함)
- 입력/근거 없이 사실/수치/연도/고유명사/인과관계를 만들어내지 마세요.
- 사실/수치/연도/고유명사는 가능한 한 근거를 함께 붙이세요.
- 근거 형식(예시): [S1] 출처명 (URL) "짧은 인용(1~2문장)" 또는 요약.
- 불확실/논쟁/근거 부족은 없는 내용을 채우지 말고 자연스럽게 보류하세요.
- ${isEduCinematic ? "강의문 과다 금지: 장면에서 보여줄 수 있는 재료(행동/상황/소품)를 포함하세요." : "학습 난이도에 맞게 설명 가능하도록 정의/경계를 명확히 써주세요."}

${roleLine}

권장 분량: 1,500~5,000자(더 길어도 OK).`;

  if (questionType === "review") {
    return `${commonRules}

[보고서 구성(Review: 상품/물건)]
1) 한 줄 결론(조건부)
- "무조건 최고/최악" 단정 금지. "X가 중요하면 추천, Y가 중요하면 비추천"처럼 조건부로.

2) 리뷰 대상(제품/버전/가격대/출시 시기/카테고리)
- 모델명/버전/세부 스펙을 확인할 수 없다면 확인하기 어렵다고만 남기세요.

3) 사용 시나리오(전제)
- 어떤 사용자/환경/예산/우선순위에서 평가하는지 먼저 선언.

4) 평가 기준(3~7개)
- 각 기준의 의미를 한 문장으로 정의.

5) 장점/단점/리스크(근거 포함)
- 기준별로 균형 있게 작성. 근거 약하면 단정 금지.

6) 만화화 힌트(4컷)
- ${isEduCinematic ? "도입(상황) → 긴장(문제) → 전환(해결) → 결론(조건부 추천)" : "도입(목표) → 핵심기준 → 비교/검증 → 결론/체크"}


8) Sources
- [S1] ...
- [S2] ...
`;
  }

  if (questionType === "compare") {
    return `${commonRules}

[보고서 구성(Compare: A vs B)]
1) 한 줄 결론(조건부)
- "무조건 A가 낫다" 같은 단정 금지.

2) 비교 대상 정의 및 범위
- A/B 정의와 경계(무엇이 아닌지) 포함.

3) 비교축(3~6개)
- 각 비교축의 의미를 한 문장으로 정의.

4) 축별 비교(근거 포함)
- A/B 장점/약점을 균형 있게.

5) 만화화 힌트(4컷)
- ${isEduCinematic ? "도입(대치) → 긴장(충돌) → 전환(트레이드오프) → 결론(조건부)" : "도입(질문) → 축1/2 → 축3/트레이드오프 → 조건부 결론"}


7) Sources
- [S1] ...
- [S2] ...
`;
  }

  return `${commonRules}

[보고서 구성(Explain: A)]
1) 한 줄 결론(요약)

2) 안전한 프레이밍(범위/경계)
- "정확히 무엇을 설명하는지" + "무엇이 아닌지(경계)" 포함

3) 핵심 정의/용어
- 핵심 용어 3~8개를 명료하게 정의 (필요 시 근거)

4) 핵심 원리/절차
- 원리의 단계나 순서를 독자가 따라갈 수 있게 구성

5) 대표 예시/비유(장면화 가능)
- 비유 2~4개 + 무엇을 대응시키는지

6) 만화화 힌트(4컷)
- ${isEduCinematic ? "도입(상황/목표) → 정의/경계 → 사건/행동으로 원리 제시 → 여운/체크" : "도입(질문/목표) → 정의/경계 → 원리/예시 → 요약/체크"}


8) Sources
- [S1] ...
- [S2] ...
`;
};

const parseResearchPack = (input: string): { pack: ResearchPack; error?: string } => {
  const trimmed = input.trim();
  if (!trimmed) return { pack: { notes: "" } };

  const extractFirstUrl = (text: string): string | null => {
    const match = text.match(/https?:\/\/[^\s)>\]"]+/);
    if (!match) return null;
    return match[0].replace(/[),.;\]]+$/, "");
  };

  const normalizeUrl = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const str = value.trim();
    if (!str) return null;
    const url = extractFirstUrl(str);
    return url || str;
  };

  const parseSources = (value: unknown): GroundingSource[] => {
    if (!Array.isArray(value)) return [];
    const out: GroundingSource[] = [];
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const uri = (rec.uri ?? rec.url ?? rec.href ?? rec.link) as unknown;
      const title = (rec.title ?? rec.name ?? rec.label) as unknown;
      const normalized = normalizeUrl(uri);
      if (normalized && normalized.startsWith("http")) {
        out.push({ title: typeof title === 'string' && title.trim() ? title.trim() : '참고 자료', uri: normalized });
      }
    }
    return out;
  };

  const stringifyIfPresent = (value: unknown): string | null => {
    if (typeof value === "string") return value.trim() ? value.trim() : null;
    if (typeof value === "number") return String(value);
    return null;
  };

  const formatMiniBriefNotes = (data: any): string => {
    const lines: string[] = [];

    const question = data?.question;
    const mini = data?.mini_brief;
    const hasV2 = Boolean(mini && typeof mini === "object");

    if (question && typeof question === "object") {
      const type = stringifyIfPresent(question.type) || "";
      const topic = stringifyIfPresent(question.topic);
      const a = stringifyIfPresent(question.a);
      const b = stringifyIfPresent(question.b);
      const title = type === "compare" ? "비교(Compare)" : type === "explain" ? "설명(Explain)" : type || "확인 불가";

      lines.push("[QUESTION]");
      lines.push(`- type: ${title}`);
      if (topic) lines.push(`- topic: ${topic}`);
      if (a) lines.push(`- A: ${a}`);
      if (b) lines.push(`- B: ${b}`);
      lines.push("");
    }

    if (hasV2) {
      const safeFraming = stringifyIfPresent(mini.safe_framing);
      const oneLine = stringifyIfPresent(mini.one_line_takeaway);
      if (safeFraming || oneLine) {
        lines.push("[FRAMING / TAKEAWAY]");
        if (safeFraming) lines.push(`- safe_framing: ${safeFraming}`);
        if (oneLine) lines.push(`- one_line_takeaway: ${oneLine}`);
        lines.push("");
      }

      const axes = Array.isArray(mini.comparison_axes) ? mini.comparison_axes : [];
      if (axes.length > 0) {
        lines.push("[COMPARISON AXES]");
        for (const ax of axes) {
          const s = stringifyIfPresent(ax);
          if (s) lines.push(`- ${s}`);
        }
        lines.push("");
      }

      const fairnessRules = Array.isArray(mini.fairness_rules) ? mini.fairness_rules : [];
      if (fairnessRules.length > 0) {
        lines.push("[FAIRNESS RULES]");
        for (const r of fairnessRules) {
          const s = stringifyIfPresent(r);
          if (s) lines.push(`- ${s}`);
        }
        lines.push("");
      }

      const whereAWins = Array.isArray(mini.where_a_wins) ? mini.where_a_wins : [];
      if (whereAWins.length > 0) {
        lines.push("[WHERE A WINS]");
        for (const w of whereAWins) {
          const s = stringifyIfPresent(w);
          if (s) lines.push(`- ${s}`);
        }
        lines.push("");
      }

      const whereBWins = Array.isArray(mini.where_b_wins) ? mini.where_b_wins : [];
      if (whereBWins.length > 0) {
        lines.push("[WHERE B WINS]");
        for (const w of whereBWins) {
          const s = stringifyIfPresent(w);
          if (s) lines.push(`- ${s}`);
        }
        lines.push("");
      }

      const claims = Array.isArray(mini.verified_claims) ? mini.verified_claims : [];
      if (claims.length > 0) {
        lines.push("[VERIFIED CLAIMS]");
        for (const [idx, c] of claims.entries()) {
          if (!c || typeof c !== "object") continue;
          const claim = stringifyIfPresent(c.claim);
          const evidence = stringifyIfPresent(c.evidence ?? c.quote ?? c.why);
          const sourceUrl = normalizeUrl(c.source_url ?? c.source ?? c.url ?? c.uri);
          if (!claim) continue;
          lines.push(`${idx + 1}) ${claim}`);
          if (evidence) lines.push(`   - evidence: ${evidence}`);
          if (sourceUrl) lines.push(`   - source: ${sourceUrl}`);
        }
        lines.push("");
      }
      const misconceptions = Array.isArray(mini.common_misconceptions) ? mini.common_misconceptions : [];
      if (misconceptions.length > 0) {
        lines.push("[COMMON MISCONCEPTIONS]");
        for (const m of misconceptions) {
          if (!m || typeof m !== "object") continue;
          const myth = stringifyIfPresent(m.myth);
          const fact = stringifyIfPresent(m.fact);
          const sourceUrl = normalizeUrl(m.source_url ?? m.source ?? m.url ?? m.uri);
          if (!myth && !fact) continue;
          lines.push(`- myth: ${myth || "확인 불가"}`);
          lines.push(`  fact: ${fact || "확인 불가"}${sourceUrl ? ` (${sourceUrl})` : ""}`);
        }
        lines.push("");
      }

      const analogies = Array.isArray(mini.analogy_bank) ? mini.analogy_bank : [];
      if (analogies.length > 0) {
        lines.push("[ANALOGY BANK]");
        for (const a of analogies) {
          if (!a || typeof a !== "object") continue;
          const analogy = stringifyIfPresent(a.analogy);
          const mapsTo = stringifyIfPresent(a.maps_to);
          if (!analogy) continue;
          lines.push(`- ${analogy}${mapsTo ? ` (maps_to: ${mapsTo})` : ""}`);
        }
        lines.push("");
      }

      const beats = Array.isArray(mini.beats_4_panel) ? mini.beats_4_panel : [];
      if (beats.length > 0) {
        lines.push("[BEATS (4-PANEL)]");
        for (const [idx, b] of beats.entries()) {
          const s = stringifyIfPresent(b);
          if (s) lines.push(`${idx + 1}) ${s}`);
        }
        lines.push("");
      }
      return lines.join("\n").trim();
    }

    // Legacy format support (notes + key_facts + timeline + ...)
    const summary = stringifyIfPresent(data?.notes ?? data?.summary);
    if (summary) {
      lines.push("[SUMMARY]");
      lines.push(summary);
      lines.push("");
    }

    const keyFacts = Array.isArray(data?.key_facts) ? data.key_facts : [];
    if (keyFacts.length > 0) {
      lines.push("[VERIFIED CLAIMS]");
      for (const [idx, f] of keyFacts.entries()) {
        if (!f || typeof f !== "object") continue;
        const claim = stringifyIfPresent(f.claim);
        const why = stringifyIfPresent(f.why);
        const quote = stringifyIfPresent(f.quote);
        const sourceUrl = normalizeUrl(f.source_url ?? f.source ?? f.url ?? f.uri);
        if (!claim) continue;
        lines.push(`${idx + 1}) ${claim}`);
        if (why) lines.push(`   - why: ${why}`);
        if (quote) lines.push(`   - quote: ${quote}`);
        if (sourceUrl) lines.push(`   - source: ${sourceUrl}`);
      }
      lines.push("");
    }

    const timeline = Array.isArray(data?.timeline) ? data.timeline : [];
    if (timeline.length > 0) {
      lines.push("[TIMELINE]");
      for (const t of timeline) {
        if (!t || typeof t !== "object") continue;
        const date = stringifyIfPresent(t.date);
        const event = stringifyIfPresent(t.event);
        const sourceUrl = normalizeUrl(t.source_url ?? t.source ?? t.url ?? t.uri);
        if (!date && !event) continue;
        lines.push(`- ${date || "DATE"}: ${event || "EVENT"}${sourceUrl ? ` (${sourceUrl})` : ""}`);
      }
      lines.push("");
    }

    const misconceptions = Array.isArray(data?.common_misconceptions) ? data.common_misconceptions : [];
    if (misconceptions.length > 0) {
      lines.push("[COMMON MISCONCEPTIONS]");
      for (const m of misconceptions) {
        if (!m || typeof m !== "object") continue;
        const myth = stringifyIfPresent(m.myth);
        const fact = stringifyIfPresent(m.fact);
        const sourceUrl = normalizeUrl(m.source_url ?? m.source ?? m.url ?? m.uri);
        if (!myth && !fact) continue;
        lines.push(`- myth: ${myth || "확인 불가"}`);
        lines.push(`  fact: ${fact || "확인 불가"}${sourceUrl ? ` (${sourceUrl})` : ""}`);
      }
      lines.push("");
    }

    const glossary = Array.isArray(data?.glossary) ? data.glossary : [];
    if (glossary.length > 0) {
      lines.push("[GLOSSARY]");
      for (const g of glossary) {
        if (!g || typeof g !== "object") continue;
        const term = stringifyIfPresent(g.term);
        const def = stringifyIfPresent(g.definition);
        const sourceUrl = normalizeUrl(g.source_url ?? g.source ?? g.url ?? g.uri);
        if (!term && !def) continue;
        lines.push(`- ${term || "TERM"}: ${def || "DEFINITION"}${sourceUrl ? ` (${sourceUrl})` : ""}`);
      }
      lines.push("");
    }

    const analogies = Array.isArray(data?.analogy_bank) ? data.analogy_bank : [];
    if (analogies.length > 0) {
      lines.push("[ANALOGY BANK]");
      for (const a of analogies) {
        if (!a || typeof a !== "object") continue;
        const analogy = stringifyIfPresent(a.analogy);
        const mapsTo = stringifyIfPresent(a.maps_to);
        if (!analogy) continue;
        lines.push(`- ${analogy}${mapsTo ? ` (maps_to: ${mapsTo})` : ""}`);
      }
      lines.push("");
    }

    return lines.join("\n").trim() || trimmed;
  };

  try {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const data = JSON.parse(trimmed) as any;
      if (Array.isArray(data)) {
        return { pack: { notes: JSON.stringify(data, null, 2) } };
      }
      const notes = formatMiniBriefNotes(data) || trimmed;
      const sources = parseSources(data.sources ?? data.references ?? data.citations);
      return { pack: { notes, sources } };
    }
  } catch (e: any) {
    return { pack: { notes: trimmed }, error: e?.message || 'Invalid JSON' };
  }

  return { pack: { notes: trimmed } };
};

const STORY_PUBLICATION_FORMATS: PublicationFormat[] = ["learning_comic", "webtoon", "instatoon", "kling_i2v"];
const PAPER_PUBLICATION_FORMATS: PublicationFormat[] = ["learning_comic", "webtoon", "instatoon"];

const getSelectablePublicationFormats = (creationType: CreationType): PublicationFormat[] =>
  creationType === "paper" ? PAPER_PUBLICATION_FORMATS : STORY_PUBLICATION_FORMATS;

const getDefaultPublicationFormat = (creationType: CreationType): PublicationFormat =>
  creationType === "story" ? "webtoon" : "learning_comic";

const normalizeSelectablePublicationFormat = (
  format: PublicationFormat,
  creationType: CreationType
): PublicationFormat => {
  if (format === "manga") return "learning_comic";
  if (creationType === "paper" && format === "kling_i2v") return getDefaultPublicationFormat(creationType);
  return format;
};

const getDefaultNarrativeRole = (creationType: CreationType): NarrativeRole =>
  creationType === "story" ? "actor" : "narrator";

const App: React.FC = () => {
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>(getInitialUiLanguage);
  const [topic, setTopic] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [localApiAvailable, setLocalApiAvailable] = useState(false);
  const [localStudioIssue, setLocalStudioIssue] = useState<"api" | "gemini" | "oauth" | null>(null);
  const [codexImageModel, setCodexImageModel] = useState(FALLBACK_CODEX_IMAGE_MODEL);
  const [geminiTextModel, setGeminiTextModel] = useState(GEMINI_PLANNER_MODEL);
  const [geminiApiConfigured, setGeminiApiConfigured] = useState(false);
  const [systemError, setSystemError] = useState<string | null>(null);
  const [geminiReasoningEffort, setGeminiReasoningEffort] = useState<GeminiReasoningEffort>("medium");
  const [productionMode, setProductionMode] = useState<"single" | "new_longform" | "longform">("single");
  const [creationType, setCreationType] = useState<CreationType>("educational");
  const [scriptText, setScriptText] = useState("");
  const [storyInputType, setStoryInputType] = useState<StoryInputType>("scenario");
  const [storyAdaptationMode, setStoryAdaptationMode] = useState<StoryAdaptationMode>("analyzed");
  const [ageRating, setAgeRating] = useState<AgeRating>("teen");
  const [storyGenre, setStoryGenre] = useState<StoryGenre | null>(null);
  const [pacingPreference, setPacingPreference] = useState<PacingPreference>("balanced");
  const [storyAntiEducationGuardEnabled, setStoryAntiEducationGuardEnabled] = useState<boolean>(true);
  const [storyDigestText, setStoryDigestText] = useState("");
  const [storyDigestWarnings, setStoryDigestWarnings] = useState<string[]>([]);
  const [storyDigestError, setStoryDigestError] = useState<string | null>(null);
  const [storyPageSuggestions, setStoryPageSuggestions] = useState<Record<ScriptDetail, number> | null>(null);
  const [isStoryAnalyzing, setIsStoryAnalyzing] = useState(false);
  const [paperFile, setPaperFile] = useState<File | null>(null);
  const [paperUrl, setPaperUrl] = useState("");
  const [paperBrief, setPaperBrief] = useState<PaperBrief | null>(null);
  const [paperBriefError, setPaperBriefError] = useState<string | null>(null);
  const [isPaperAnalyzing, setIsPaperAnalyzing] = useState(false);
  const [topicInputTab, setTopicInputTab] = useState<TopicInputTab>("instatoon");
  const [comicMode, setComicMode] = useState<ComicMode>("learning");
  const [publicationFormat, setPublicationFormat] = useState<PublicationFormat>("instatoon");
  const [mangaColorMode, setMangaColorMode] = useState<MangaColorMode>("bw");
  const [i2vAspectRatio, setI2VAspectRatio] = useState<I2VAspectRatio>("16:9");
  const [toneMode, setToneMode] = useState<ToneMode>("normal");
  const [toneLevel, setToneLevel] = useState<ToneLevel>("medium");
  const [language, setLanguage] = useState<Language>("ko");
  const [busyPhase, setBusyPhase] = useState<BusyPhase>("planning");
  const [busyStartedAt, setBusyStartedAt] = useState<number | null>(null);
  const [busyNow, setBusyNow] = useState<number>(() => Date.now());
  const [audienceLevel, setAudienceLevel] = useState<AudienceLevel>("beginner");
  const [deliveryStyleId, setDeliveryStyleId] = useState<DeliveryStyleId>("standard");
  const [deliveryCustomInstruction, setDeliveryCustomInstruction] = useState<string>("");
  const [layoutVariety, setLayoutVariety] = useState<LayoutVariety>(DEFAULT_LAYOUT_VARIETY);
  const [imageSize, setImageSize] = useState<ImageSize>("2K");
  const [imageProvider, setImageProvider] = useState<ImageProvider>(DEFAULT_IMAGE_PROVIDER);
  const [codexImageQuality, setCodexImageQuality] = useState<CodexImageQuality>(DEFAULT_CODEX_IMAGE_QUALITY);
  const [scriptDetail, setScriptDetail] = useState<ScriptDetail>("normal");
  const [pageCountMode, setPageCountMode] = useState<PageCountMode>("auto");
  const [targetPageCount, setTargetPageCount] = useState<number>(6);
  const [narrativeRole, setNarrativeRole] = useState<NarrativeRole>("narrator");
  const [characterConsistencyMode, setCharacterConsistencyMode] = useState<CharacterConsistencyMode>("loose");
  const [useCrossPageStyleConsistency, setUseCrossPageStyleConsistency] = useState<boolean>(false);
  const [researchMode, setResearchMode] = useState<ResearchMode>("auto_digest");
  const [researchReportText, setResearchReportText] = useState("");
  const [researchReportFile, setResearchReportFile] = useState<File | null>(null);
  const [quickPipelineSourceFiles, setQuickPipelineSourceFiles] = useState<File[]>([]);
  const [quickPipelineSourceJobs, setQuickPipelineSourceJobs] = useState<QuickPipelineSourceJob[]>([]);
  const [isManualMaterialOpen, setIsManualMaterialOpen] = useState(false);
  const [researchDigestText, setResearchDigestText] = useState("");
  const [researchDigestSources, setResearchDigestSources] = useState<GroundingSource[]>([]);
  const [researchDigestWarnings, setResearchDigestWarnings] = useState<string[]>([]);
  const [researchDigestError, setResearchDigestError] = useState<string | null>(null);
  const [pageSuggestions, setPageSuggestions] = useState<Record<ScriptDetail, number> | null>(null);
  const [isResearchAnalyzing, setIsResearchAnalyzing] = useState(false);

  // Resources
  const [stylePresets, setStylePresets] = useState<StylePreset[]>([]);
  const [templates, setTemplates] = useState<LayoutTemplate[]>([]);

  // Cast
  const [characterInputMode, setCharacterInputMode] = useState<"suggest" | "manual">("suggest");
  const [cast, setCast] = useState<CharacterSpec[]>(() => [createCharacter("protagonist")]);
  const [isSuggestingCastFromContent, setIsSuggestingCastFromContent] = useState(false);
  const [castSuggestionNotice, setCastSuggestionNotice] = useState<CastSuggestionNotice | null>(null);
  const [generatingCharacterImageIds, setGeneratingCharacterImageIds] = useState<Record<string, boolean>>({});
  const [stylingCharacterImageIds, setStylingCharacterImageIds] = useState<Record<string, boolean>>({});
  const [characterReferenceErrors, setCharacterReferenceErrors] = useState<Record<string, string>>({});
  const [productReferenceImages, setProductReferenceImages] = useState<string[]>([]);
  const [castPresets, setCastPresets] = useState<CastPreset[]>(() => loadCastPresets());
  const [selectedCastPresetId, setSelectedCastPresetId] = useState<string>("");
  const [savedProjects, setSavedProjects] = useState<SavedComicProject[]>(() => loadSavedComicProjects());
  const [selectedSavedProjectId, setSelectedSavedProjectId] = useState<string>("");
  const [activeProjectId, setActiveProjectId] = useState<string>("");
  const [longformProjects, setLongformProjects] = useState<SavedLongformProject[]>(() => loadLongformProjects());
  const [selectedLongformProjectId, setSelectedLongformProjectId] = useState<string>("");
  const [activeLongformProjectId, setActiveLongformProjectId] = useState<string>("");
  const [longformNotice, setLongformNotice] = useState<CastSuggestionNotice | null>(null);
  const [episodeCastReview, setEpisodeCastReview] = useState<EpisodeCastSelectionResult | null>(null);
  const [episodePossibleMatchSelections, setEpisodePossibleMatchSelections] = useState<Record<number, string>>({});
  const [episodeNewCharacterSelections, setEpisodeNewCharacterSelections] = useState<Record<number, boolean>>({});
  const [isSelectingEpisodeCast, setIsSelectingEpisodeCast] = useState(false);
  const [selectedPresetId, setSelectedPresetId] = useState<string>("kwebtoon_clean_pastel");
  const [selectedStyleCategory, setSelectedStyleCategory] = useState<string>("Webtoon");
  const [finalStyle, setFinalStyle] = useState<SeriesSpec['anchors']['style'] | null>(null);
  const [styleReferenceImage, setStyleReferenceImage] = useState<string | null>(null);
  const [styleReferenceError, setStyleReferenceError] = useState<string | null>(null);

  // Planner
  const [seriesPlan, setSeriesPlan] = useState<SeriesPlan | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [devPromptCheckOpen, setDevPromptCheckOpen] = useState(false);

  // Generation Results
  const [pageResults, setPageResults] = useState<GenerationResult[]>([]);
  const [pageErrors, setPageErrors] = useState<Record<number, string>>({});
  const [webtoonEpisodeResult, setWebtoonEpisodeResult] = useState<WebtoonEpisodeRenderResult | null>(null);
  const [isBuildingWebtoonEpisode, setIsBuildingWebtoonEpisode] = useState(false);
  const [isExportingCodexHandoff, setIsExportingCodexHandoff] = useState(false);
  const [outputReaderMode, setOutputReaderMode] = useState<OutputReaderMode>("visual");
  const [isProcessingPageIndex, setIsProcessingPageIndex] = useState<number | null>(null);
  const [autoGeneratePages, setAutoGeneratePages] = useState(false);
  const [regenerateAllPages, setRegenerateAllPages] = useState(false);
  const [regenerateCursor, setRegenerateCursor] = useState<number>(1);
  const [pageScriptEditedAt, setPageScriptEditedAt] = useState<Record<number, number>>({});
  const [pageStyleOverrides, setPageStyleOverrides] = useState<Record<number, SeriesSpec["anchors"]["style"]>>({});
  const [pageStyleEditedAt, setPageStyleEditedAt] = useState<Record<number, number>>({});
  const [globalStyleEditedAt, setGlobalStyleEditedAt] = useState<number>(0);
  const [pageRenderedAt, setPageRenderedAt] = useState<Record<number, number>>({});
  const [pageRenderedImageSize, setPageRenderedImageSize] = useState<Record<number, ImageSize>>({});
  const [pageRenderedEngineKey, setPageRenderedEngineKey] = useState<Record<number, string>>({});
  const [pageScriptEditorOpen, setPageScriptEditorOpen] = useState(false);
  const [pageScriptDraft, setPageScriptDraft] = useState<PageSpec | null>(null);
  const [pageEditActionOpen, setPageEditActionOpen] = useState(false);
  const [pageEditTargetIndex, setPageEditTargetIndex] = useState<number | null>(null);
  const [pageStyleEditorOpen, setPageStyleEditorOpen] = useState(false);
  const [pageStyleTargetIndex, setPageStyleTargetIndex] = useState<number | null>(null);
  const [generationSettingsOpen, setGenerationSettingsOpen] = useState(false);
  const [isDownloadingZip, setIsDownloadingZip] = useState(false);
  const [isQuickPipelineRunning, setIsQuickPipelineRunning] = useState(false);
  const [quickPipelinePublicationFormat, setQuickPipelinePublicationFormat] = useState<QuickPipelinePublicationFormat>("instatoon");
  const [quickPipelineParallelAll, setQuickPipelineParallelAll] = useState(true);
  const [quickPipelineQueueCount, setQuickPipelineQueueCount] = useState(1);
  const [quickPipelineUnitsPerEpisode, setQuickPipelineUnitsPerEpisode] = useState(12);
  const [quickPipelineQueueRuns, setQuickPipelineQueueRuns] = useState<QuickPipelineQueueRun[]>([]);
  const [selectedQuickPipelineQueueId, setSelectedQuickPipelineQueueId] = useState("");
  const [quickPipelineProgress, setQuickPipelineProgress] = useState<QuickPipelineProgress | null>(null);
  const [quickPipelineLogs, setQuickPipelineLogs] = useState<QuickPipelineRunLog[]>([]);
  const [quickPipelineLogsOpen, setQuickPipelineLogsOpen] = useState(false);
  const [styleSamplePrompt, setStyleSamplePrompt] = useState("친절한 선생님과 학생이 로봇 부품을 쉽고 재미있게 설명하는 한 장면");
  const [styleSampleResults, setStyleSampleResults] = useState<Record<string, StyleSampleResult>>({});
  const [isGeneratingStyleSamples, setIsGeneratingStyleSamples] = useState(false);
  const styleSamplesLoadedRef = useRef(false);
  const generationRunIdRef = useRef(0);
  const isGeneratingPageRef = useRef(false);
  const activePageGenerationIndexesRef = useRef<Set<number>>(new Set());
  const parallelAutoGenerateRunRef = useRef(false);
  const autoGeneratePagesRef = useRef(false);
  const quickPipelineRunIdRef = useRef<string | null>(null);
  const generationAbortControllersRef = useRef<Set<AbortController>>(new Set());
  const [processingPageIndexes, setProcessingPageIndexes] = useState<number[]>([]);
  const [generationPhaseMessage, setGenerationPhaseMessage] = useState<string | null>(null);
  const lastNonErrorStatusRef = useRef<AppStatus>(AppStatus.IDLE);
  const localArchiveLoadedRef = useRef(false);
  const localArchiveSaveTimerRef = useRef<number | null>(null);
  const [projectArchiveError, setProjectArchiveError] = useState<string | null>(null);

  const syncPageGenerationState = (nextIndexes: Set<number>) => {
    const indexes = Array.from(nextIndexes).sort((a, b) => a - b);
    activePageGenerationIndexesRef.current = nextIndexes;
    isGeneratingPageRef.current = indexes.length > 0;
    setProcessingPageIndexes(indexes);
    setIsProcessingPageIndex(indexes[0] ?? null);
  };

  const clearPageGenerationTracking = () => {
    parallelAutoGenerateRunRef.current = false;
    autoGeneratePagesRef.current = false;
    setGenerationPhaseMessage(null);
    syncPageGenerationState(new Set());
  };

  const startPageGeneration = (pageIndex: number, allowConcurrent: boolean): boolean => {
    const active = activePageGenerationIndexesRef.current;
    if (!allowConcurrent && active.size > 0) return false;
    if (active.has(pageIndex)) return false;
    const next = new Set<number>(active);
    next.add(pageIndex);
    syncPageGenerationState(next);
    return true;
  };

  const finishPageGeneration = (pageIndex: number) => {
    const active = activePageGenerationIndexesRef.current;
    if (!active.has(pageIndex)) return;
    const next = new Set<number>(active);
    next.delete(pageIndex);
    syncPageGenerationState(next);
  };

  const isAnyPageGenerating = processingPageIndexes.length > 0;
  const isPageGenerating = (pageIndex: number) => processingPageIndexes.includes(pageIndex);

  const abortActiveGenerationRequests = () => {
    for (const controller of generationAbortControllersRef.current) {
      controller.abort(new Error("User cancelled generation."));
    }
    generationAbortControllersRef.current.clear();
  };

  useEffect(() => {
    autoGeneratePagesRef.current = autoGeneratePages;
  }, [autoGeneratePages]);

  useEffect(() => {
    try {
      localStorage.setItem("toon_for_codex_ui_language", uiLanguage);
    } catch { }
  }, [uiLanguage]);

  const ui = (ko: string, en: string): string => uiLanguage === "ko" ? ko : en;

  useEffect(() => {
    if (status !== AppStatus.PLANNING) {
      setBusyStartedAt(null);
      return;
    }
    const startedAt = Date.now();
    setBusyStartedAt(startedAt);
    setBusyNow(startedAt);
    const timer = window.setInterval(() => setBusyNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [status, busyPhase]);

  useEffect(() => {
    if (!isQuickPipelineRunning) return;
    const timer = window.setInterval(() => setBusyNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isQuickPipelineRunning]);

  useEffect(() => {
    if (status !== AppStatus.ERROR) lastNonErrorStatusRef.current = status;
  }, [status]);

  const getPreviousStepStatus = (s: AppStatus): AppStatus | null => {
    switch (s) {
      case AppStatus.CHARACTER_SELECT:
        return AppStatus.STYLE_SELECT;
      case AppStatus.STYLE_SELECT:
        return AppStatus.TOPIC_INPUT;
      case AppStatus.PLANNING:
        return AppStatus.CHARACTER_SELECT;
      case AppStatus.PLAN_REVIEW:
        return AppStatus.CHARACTER_SELECT;
      case AppStatus.READY_TO_GENERATE:
      case AppStatus.GENERATING_PANELS:
        return AppStatus.PLAN_REVIEW;
      default:
        return null;
    }
  };

  const cancelInFlightGeneration = () => {
    generationRunIdRef.current += 1;
    abortActiveGenerationRequests();
    setAutoGeneratePages(false);
    setRegenerateAllPages(false);
    setRegenerateCursor(1);
    clearPageGenerationTracking();
  };

  useEffect(() => {
    if (status !== AppStatus.PLANNING || !busyStartedAt) return;
    if (isQuickPipelineRunning) return;
    const elapsedSeconds = Math.floor((busyNow - busyStartedAt) / 1000);
    if (elapsedSeconds < PLANNING_STUCK_SECONDS) return;
    cancelInFlightGeneration();
    setSystemError(ui(
      "AI 분석이 10분 넘게 응답하지 않아서 중단했어. 서버나 모델 요청이 꼬인 상태일 가능성이 커. 이전 단계에서 다시 시도해줘.",
      "AI analysis did not respond for over 10 minutes, so it was stopped. The server or model request may be stuck. Please go back and try again."
    ));
    setBusyPhase("planning");
    setStatus(AppStatus.ERROR);
  }, [status, busyStartedAt, busyNow, uiLanguage, isQuickPipelineRunning]);

  const goPreviousStep = () => {
    const effectiveStatus = status === AppStatus.ERROR ? lastNonErrorStatusRef.current : status;
    const prev = getPreviousStepStatus(effectiveStatus);
    if (!prev) return;

    if (
      effectiveStatus === AppStatus.PLANNING ||
      effectiveStatus === AppStatus.READY_TO_GENERATE ||
      effectiveStatus === AppStatus.GENERATING_PANELS
    ) {
      cancelInFlightGeneration();
    }

    setSystemError(null);
    setStatus(prev);
  };

  const PreviousStepButton: React.FC<{ className?: string }> = ({ className }) => {
    const effectiveStatus = status === AppStatus.ERROR ? lastNonErrorStatusRef.current : status;
    const canGoBack = Boolean(getPreviousStepStatus(effectiveStatus));
    return (
      <button
        type="button"
        onClick={goPreviousStep}
        disabled={!canGoBack}
        className={`text-[10px] md:text-xs font-black uppercase flex items-center gap-1 transition-colors ${canGoBack ? "text-slate-500 hover:text-black" : "text-slate-300 cursor-not-allowed"
          } ${className || ""}`}
      >
        <ChevronLeft size={14} />
        {ui("이전 단계", "Back")}
      </button>
    );
  };

  const refreshQuickPipelineLogs = async () => {
    if (!localApiAvailable) return;
    try {
      const data = await getJson<{ entries?: QuickPipelineRunLog[] }>("/api/pipeline-runs/recent?limit=40");
      setQuickPipelineLogs(Array.isArray(data.entries) ? data.entries : []);
    } catch (e) {
      console.warn("Failed to load quick pipeline logs", e);
    }
  };

  const writeQuickPipelineLog = async (entry: QuickPipelineRunLog) => {
    const nextEntry: QuickPipelineRunLog = {
      ...entry,
      created_at: Date.now()
    };
    setQuickPipelineLogs((prev) => [nextEntry, ...prev].slice(0, 40));
    try {
      await postJson("/api/pipeline-runs", nextEntry, { timeoutMs: 10_000, retries: 0 });
    } catch (e) {
      console.warn("Failed to persist quick pipeline log", e);
    }
  };

  const setQuickStageProgress = (
    runId: string,
    stage: QuickPipelineStage,
    attempt: number,
    message: string,
    detail?: string,
    patch?: Partial<QuickPipelineProgress>
  ) => {
    const now = Date.now();
    setQuickPipelineProgress((prev) => ({
      runId,
      stage,
      startedAt: prev?.runId === runId ? prev.startedAt : now,
      stageStartedAt: prev?.stage === stage ? prev.stageStartedAt : now,
      attempt,
      message,
      detail,
      totalPages: prev?.totalPages,
      completedPages: prev?.completedPages,
      failedPages: prev?.failedPages,
      ...patch
    }));
  };

  const updateQuickQueueRun = (queueId: string, patch: Partial<QuickPipelineQueueRun>) => {
    setQuickPipelineQueueRuns((prev) => prev.map((run) => (
      run.id === queueId ? { ...run, ...patch } : run
    )));
  };

  const loadQuickPipelineQueueResult = (run: QuickPipelineQueueRun) => {
    if (!run.plan) return;
    const runPublicationFormat = run.plan.series_spec.constraints.publication_format;
    const results = sortGenerationResults(run.pageResults || []);
    const renderedAt = results.reduce<Record<number, number>>((acc, result) => {
      acc[result.page_index] = Date.now();
      return acc;
    }, {});
    const renderedSize = results.reduce<Record<number, ImageSize>>((acc, result) => {
      acc[result.page_index] = "2K";
      return acc;
    }, {});
    const renderedEngine = results.reduce<Record<number, string>>((acc, result) => {
      acc[result.page_index] = buildImageEngineKey("codex", codexImageModel, DEFAULT_CODEX_IMAGE_QUALITY);
      return acc;
    }, {});

    generationRunIdRef.current += 1;
    clearPageGenerationTracking();
    setSeriesPlan(run.plan);
    if (runPublicationFormat) {
      setPublicationFormat(runPublicationFormat);
      if (runPublicationFormat === "webtoon" || runPublicationFormat === "learning_comic" || runPublicationFormat === "instatoon") {
        setQuickPipelinePublicationFormat(runPublicationFormat);
      }
    }
    if (run.cast?.length) setCast(cloneCastForQuickReuse(run.cast));
    setPageResults(results);
    setPageErrors(run.pageErrors || {});
    setWebtoonEpisodeResult(null);
    setIsBuildingWebtoonEpisode(false);
    setPageRenderedAt(renderedAt);
    setPageRenderedImageSize(renderedSize);
    setPageRenderedEngineKey(renderedEngine);
    setSelectedQuickPipelineQueueId(run.id);
    setStatus(AppStatus.READY_TO_GENERATE);
    setSystemError(null);
  };

  useEffect(() => {
    if (!localApiAvailable) return;
    void refreshQuickPipelineLogs();
  }, [localApiAvailable]);

  useEffect(() => {
    if (styleSamplesLoadedRef.current) return;
    styleSamplesLoadedRef.current = true;
    void loadPersistedStyleSamples()
      .then((stored) => {
        if (stored.prompt) setStyleSamplePrompt(stored.prompt);
        if (Object.keys(stored.results).length > 0) setStyleSampleResults(stored.results);
      })
      .catch((e) => {
        console.warn("Failed to load style samples:", e);
      });
  }, []);

  useEffect(() => {
    persistCastPresets(castPresets);
  }, [castPresets]);

  useEffect(() => {
    persistLongformProjects(longformProjects);
  }, [longformProjects]);

  useEffect(() => {
    persistSavedComicProjects(savedProjects);
    if (!localApiAvailable || !localArchiveLoadedRef.current) return;

    if (localArchiveSaveTimerRef.current) {
      window.clearTimeout(localArchiveSaveTimerRef.current);
    }
    localArchiveSaveTimerRef.current = window.setTimeout(() => {
      localArchiveSaveTimerRef.current = null;
      void persistSavedComicProjectsToLocalArchive(savedProjects)
        .then(() => setProjectArchiveError(null))
        .catch((e) => {
          console.warn("Failed to persist local project archive:", e);
          setProjectArchiveError(ui("로컬 프로젝트 파일 저장에 실패했어. 서버 로그를 확인해줘.", "Failed to save the local project file. Check the server log."));
        });
    }, 300);

    return () => {
      if (localArchiveSaveTimerRef.current) {
        window.clearTimeout(localArchiveSaveTimerRef.current);
        localArchiveSaveTimerRef.current = null;
      }
    };
  }, [localApiAvailable, savedProjects, uiLanguage]);

  useEffect(() => {
    if (!localApiAvailable || localArchiveLoadedRef.current) return;
    let cancelled = false;

    void loadSavedComicProjectsFromLocalArchive()
      .then((localProjects) => {
        if (cancelled) return;
        localArchiveLoadedRef.current = true;
        setProjectArchiveError(null);
        setSavedProjects((prev) => mergeSavedComicProjects(localProjects, prev).slice(0, MAX_SAVED_PROJECTS));
      })
      .catch((e) => {
        if (cancelled) return;
        console.warn("Failed to load local project archive:", e);
        localArchiveLoadedRef.current = true;
        setProjectArchiveError(ui("로컬 프로젝트 파일 저장소를 불러오지 못했어. 브라우저 임시 저장으로만 동작 중이야.", "Could not load the local project file archive. Using browser fallback only."));
      });

    return () => {
      cancelled = true;
    };
  }, [localApiAvailable, uiLanguage]);

  useEffect(() => {
    if (!selectedCastPresetId && castPresets.length > 0) {
      setSelectedCastPresetId(castPresets.slice().sort((a, b) => b.updated_at - a.updated_at)[0]?.id || "");
    }
  }, [castPresets, selectedCastPresetId]);

  useEffect(() => {
    if (savedProjects.length === 0) {
      if (selectedSavedProjectId) setSelectedSavedProjectId("");
      return;
    }
    const exists = savedProjects.some((p) => p.id === selectedSavedProjectId);
    if (!exists) {
      setSelectedSavedProjectId(savedProjects[0]?.id || "");
    }
  }, [savedProjects, selectedSavedProjectId]);

  useEffect(() => {
    if (longformProjects.length === 0) {
      if (selectedLongformProjectId) setSelectedLongformProjectId("");
      if (activeLongformProjectId) setActiveLongformProjectId("");
      return;
    }
    if (!longformProjects.some((p) => p.id === selectedLongformProjectId)) {
      setSelectedLongformProjectId(longformProjects[0]?.id || "");
    }
    if (activeLongformProjectId && !longformProjects.some((p) => p.id === activeLongformProjectId)) {
      setActiveLongformProjectId("");
    }
  }, [activeLongformProjectId, longformProjects, selectedLongformProjectId]);

  useEffect(() => {
    const init = async () => {
      let apiAvailable = false;
      let oauthReady = false;
      try {
        const health = await getJson<HealthResponse>("/api/health");
        setCodexImageModel(normalizeCodexImageModel(health.codex_image_model));
        setGeminiTextModel(String(health.codex_text_model || "").trim() || GEMINI_PLANNER_MODEL);
        setGeminiApiConfigured(true);
        apiAvailable = true;
      } catch (e) {
        console.warn("Local API health check failed. Is the backend running?", e);
        setGeminiApiConfigured(false);
      }
      setLocalApiAvailable(apiAvailable);

      if (apiAvailable) {
        try {
          const oauth = await getJson<OAuthStatusResponse>("/api/oauth/status");
          oauthReady = oauth.status === "ready";
        } catch (e) {
          console.warn("Codex OAuth status check failed. Is Codex logged in?", e);
        }
      }

      setHasApiKey(apiAvailable && oauthReady);
      setLocalStudioIssue(!apiAvailable ? "api" : oauthReady ? null : "oauth");

      const styles = await getStylePresets();
      setStylePresets(styles);
      try {
        const tResp = await fetch('/layout_templates.json');
        if (tResp.ok) {
          setTemplates(await tResp.json());
        }
      } catch (e) {
        console.error("Layout templates fetch failed", e);
      }

      if (apiAvailable && oauthReady) {
        setStatus(AppStatus.TOPIC_INPUT);
      }
    };
    init();
  }, []);

  useEffect(() => {
    if (researchMode !== 'user') {
      setResearchReportText("");
      setResearchReportFile(null);
      setResearchDigestText("");
      setResearchDigestSources([]);
      setResearchDigestWarnings([]);
      setResearchDigestError(null);
      setPageSuggestions(null);
      setIsResearchAnalyzing(false);
    }
  }, [researchMode]);

  useEffect(() => {
    if (creationType !== "educational") return;
    if (comicMode !== LEARNING_COMIC_MODE) {
      setComicMode(LEARNING_COMIC_MODE);
      return;
    }
    if (narrativeRole !== LEARNING_NARRATIVE_ROLE) {
      setNarrativeRole(LEARNING_NARRATIVE_ROLE);
      return;
    }
    setResearchDigestText("");
    setResearchDigestSources([]);
    setResearchDigestWarnings([]);
    setResearchDigestError(null);
    setPageSuggestions(null);
  }, [creationType, topic, comicMode, narrativeRole]);

  useEffect(() => {
    if (creationType !== "paper") return;
    setComicMode("learning");
    const nextPublicationFormat = normalizeSelectablePublicationFormat(publicationFormat, creationType);
    if (nextPublicationFormat !== publicationFormat) setPublicationFormat(nextPublicationFormat);
    setLanguage("ko");
    setLayoutVariety(DEFAULT_LAYOUT_VARIETY);
    setImageSize("2K");
    setToneMode("normal");
  }, [creationType, publicationFormat]);

  useEffect(() => {
    const nextPublicationFormat = normalizeSelectablePublicationFormat(publicationFormat, creationType);
    if (nextPublicationFormat !== publicationFormat) setPublicationFormat(nextPublicationFormat);
  }, [creationType, publicationFormat]);

  useEffect(() => {
    if (creationType !== "story" || storyInputType !== "scenario" || storyAdaptationMode !== "direct") return;
    setStoryAdaptationMode("analyzed");
    setStoryPageSuggestions(null);
  }, [creationType, storyInputType, storyAdaptationMode]);

  useEffect(() => {
    if (stylePresets.length === 0) return;
    const allCategories = Array.from(
      new Set(stylePresets.map((p) => p.category || "Uncategorized"))
    );
    if (!allCategories.includes(selectedStyleCategory)) {
      setSelectedStyleCategory(allCategories[0] || "Webtoon");
    }
  }, [selectedStyleCategory, stylePresets]);

  useEffect(() => {
    if (stylePresets.length === 0) return;
    const filtered = stylePresets.filter(
      (p) => (p.category || "Uncategorized") === selectedStyleCategory
    );
    if (filtered.length === 0) return;
    if (!filtered.some((p) => p.id === selectedPresetId)) {
      setSelectedPresetId(filtered[0].id);
    }
  }, [selectedPresetId, selectedStyleCategory, stylePresets]);

  useEffect(() => {
    if (pageCountMode !== "auto") return;
    const fallback = scriptDetail === "brief" ? 1 : scriptDetail === "normal" ? 2 : 3;
    const suggestions =
      creationType === "story"
        ? storyAdaptationMode === "direct"
          ? estimateDirectStoryPageSuggestions(scriptText, storyInputType)
          : storyPageSuggestions
        : creationType === "paper"
          ? paperBrief?.page_suggestions || null
          : pageSuggestions;
    const suggested = suggestions?.[scriptDetail];
    setTargetPageCount(clampPageCount(typeof suggested === "number" ? suggested : fallback));
  }, [pageCountMode, scriptDetail, pageSuggestions, storyPageSuggestions, storyAdaptationMode, scriptText, storyInputType, creationType, paperBrief]);

  const handleImageSizeChange = (nextSize: ImageSize) => {
    if (nextSize === imageSize) return;
    setImageSize(nextSize);
    setSeriesPlan((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        series_spec: {
          ...prev.series_spec,
          constraints: {
            ...prev.series_spec.constraints,
            image_size: nextSize
          }
        }
      };
    });
  };

  const handleImageProviderChange = (_nextProvider: ImageProvider) => {
    const resolvedProvider: ImageProvider = "codex";
    if (resolvedProvider === imageProvider) return;
    setImageProvider(resolvedProvider);
    setSeriesPlan((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        series_spec: {
          ...prev.series_spec,
          constraints: {
            ...prev.series_spec.constraints,
            image_provider: resolvedProvider
          }
        }
      };
    });
  };

  const handleCodexImageQualityChange = (nextQuality: CodexImageQuality) => {
    if (nextQuality === codexImageQuality) return;
    setCodexImageQuality(nextQuality);
    setSeriesPlan((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        series_spec: {
          ...prev.series_spec,
          constraints: {
            ...prev.series_spec.constraints,
            codex_image_quality: nextQuality
          }
        }
      };
    });
  };

  const buildStyleSamplePrompt = (preset: StylePreset): string => {
    const subject = String(styleSamplePrompt || topic || "").trim() || "친절한 선생님과 학생이 로봇 부품을 쉽고 재미있게 설명하는 한 장면";
    return [
      `Create one polished square style sample image for this art preset.`,
      `Sample scene: ${subject}`,
      `Art preset label: ${preset.label}`,
      `Category: ${preset.category || "General"}`,
      `Render mode: ${preset.render_mode}`,
      `Style rules: ${preset.style_prompt}`,
      preset.preview_hint ? `Preview hint: ${preset.preview_hint}` : "",
      preset.negative_style_prompt ? `Avoid: ${preset.negative_style_prompt}` : "",
      `Keep the same subject across all samples so the user can compare art direction.`,
      `Make it a finished single image, clean composition, no UI chrome, no watermark.`,
      `If Korean text appears, keep it short and readable.`
    ].filter(Boolean).join("\n");
  };

  const generateOneStyleSample = async (preset: StylePreset) => {
    const startedAt = Date.now();
    const prompt = styleSamplePrompt;
    setStyleSampleResults((prev) => ({
      ...prev,
      [preset.id]: {
        presetId: preset.id,
        status: "running",
        prompt,
        imageUrl: prev[preset.id]?.imageUrl,
        startedAt
      }
    }));

    try {
      const response = await postJson<{ image_data_url?: string | null }>("/api/codex/generate-image", {
        prompt: buildStyleSamplePrompt(preset),
        model: codexImageModel,
        size: STYLE_SAMPLE_IMAGE_SIZE,
        quality: DEFAULT_CODEX_IMAGE_QUALITY,
        moderation: "low"
      }, {
        timeoutMs: 10 * 60_000,
        retries: 1
      });

      if (!response.image_data_url) {
        throw new Error(ui("이미지 응답이 비어 있어.", "Image response was empty."));
      }

      const nextResult: StyleSampleResult = {
        presetId: preset.id,
        status: "success",
        prompt,
        imageUrl: response.image_data_url || "",
        startedAt,
        completedAt: Date.now()
      };
      setStyleSampleResults((prev) => ({
        ...prev,
        [preset.id]: nextResult
      }));
      void persistStyleSampleResult(nextResult)
        .then((savedResult) => {
          if (!savedResult) return;
          setStyleSampleResults((prev) => ({
            ...prev,
            [preset.id]: savedResult
          }));
        })
        .catch((err) => console.warn("Failed to persist style sample:", err));
    } catch (e: any) {
      const nextResult: StyleSampleResult = {
        presetId: preset.id,
        status: "error",
        prompt,
        error: toUserFacingError(e?.message, ui("작화 예시 생성에 실패했어.", "Style sample generation failed."), uiLanguage),
        startedAt,
        completedAt: Date.now()
      };
      setStyleSampleResults((prev) => ({
        ...prev,
        [preset.id]: nextResult
      }));
      void persistStyleSampleResult(nextResult).catch((err) => console.warn("Failed to persist style sample error:", err));
    }
  };

  const generateSelectedStyleSamples = async (presetsToGenerate: StylePreset[]) => {
    if (isGeneratingStyleSamples || stylePresets.length === 0) return;
    if (presetsToGenerate.length === 0) return;
    setSystemError(null);
    setIsGeneratingStyleSamples(true);
    void persistStyleSamplePrompt(styleSamplePrompt).catch((err) => console.warn("Failed to persist style sample prompt:", err));
    const presetIds = new Set(presetsToGenerate.map((preset) => preset.id));
    setStyleSampleResults((prev) => ({
      ...prev,
      ...stylePresets.reduce<Record<string, StyleSampleResult>>((acc, preset) => {
        if (!presetIds.has(preset.id)) return acc;
        acc[preset.id] = {
          ...(prev[preset.id] || { presetId: preset.id }),
          status: "running",
          prompt: styleSamplePrompt,
          error: undefined,
          startedAt: Date.now()
        };
        return acc;
      }, {})
    }));

    try {
      await Promise.allSettled(presetsToGenerate.map((preset) => generateOneStyleSample(preset)));
    } finally {
      setIsGeneratingStyleSamples(false);
    }
  };

  const generateAllStyleSamples = async () => {
    await generateSelectedStyleSamples(stylePresets);
  };

  const generateFailedStyleSamples = async () => {
    const failedPresets = stylePresets.filter((preset) => styleSampleResults[preset.id]?.status === "error");
    await generateSelectedStyleSamples(failedPresets);
  };

  const generateMissingStyleSamples = async () => {
    const missingPresets = stylePresets.filter((preset) => {
      const result = styleSampleResults[preset.id];
      return !result || result.status === "idle" || (result.status !== "success" && !result.imageUrl);
    });
    await generateSelectedStyleSamples(missingPresets);
  };

  const resetApp = () => {
    generationRunIdRef.current += 1;
    setAutoGeneratePages(false);
    setRegenerateAllPages(false);
    setRegenerateCursor(1);
    setSystemError(null);
    setGeminiReasoningEffort("medium");
    setProductionMode("single");
    setTopic("");
    setScriptDetail("normal");
    setPageCountMode("auto");
    setTargetPageCount(2);
    setPublicationFormat(getDefaultPublicationFormat("educational"));
    setMangaColorMode("bw");
    setI2VAspectRatio("16:9");
    setToneMode("normal");
    setToneLevel("medium");
    setLanguage("ko");
    setBusyPhase("planning");
    setImageSize("2K");
    setImageProvider(DEFAULT_IMAGE_PROVIDER);
    setCodexImageQuality(DEFAULT_CODEX_IMAGE_QUALITY);
    setCharacterInputMode("suggest");
    setNarrativeRole("narrator");
    setCharacterConsistencyMode("loose");
    setUseCrossPageStyleConsistency(false);
    setResearchMode("auto_digest");
    setResearchReportText("");
    setResearchReportFile(null);
    setResearchDigestText("");
    setResearchDigestSources([]);
    setResearchDigestWarnings([]);
    setResearchDigestError(null);
    setPageSuggestions(null);
    setIsResearchAnalyzing(false);
    setPaperFile(null);
    setPaperUrl("");
    setPaperBrief(null);
    setPaperBriefError(null);
    setIsPaperAnalyzing(false);
    setCast([createCharacter("protagonist")]);
    setProductReferenceImages([]);
    setActiveProjectId("");
    setActiveLongformProjectId("");
    setLongformNotice(null);
    setEpisodeCastReview(null);
    setEpisodePossibleMatchSelections({});
    setEpisodeNewCharacterSelections({});
    setIsSelectingEpisodeCast(false);
    setSelectedPresetId("kwebtoon_clean_pastel");
    setFinalStyle(null);
    setStyleReferenceImage(null);
    setStyleReferenceError(null);
    setSeriesPlan(null);
    setPageResults([]);
    setPageErrors({});
    setWebtoonEpisodeResult(null);
    setIsBuildingWebtoonEpisode(false);
    setPageRenderedAt({});
    setPageRenderedImageSize({});
    setPageRenderedEngineKey({});
    setPageScriptEditedAt({});
    setPageStyleOverrides({});
    setPageStyleEditedAt({});
    setGlobalStyleEditedAt(0);
    clearPageGenerationTracking();
    setPageScriptEditorOpen(false);
    setPageScriptDraft(null);
    setPageEditActionOpen(false);
    setPageEditTargetIndex(null);
    setPageStyleEditorOpen(false);
    setPageStyleTargetIndex(null);
    setStatus(AppStatus.TOPIC_INPUT);
  };

  const suggestSavedProjectLabel = (): string => {
    const titleFromPlan = String(seriesPlan?.series_spec?.series?.title || "").trim();
    const titleFromTopic = String(topic || "").trim();
    return titleFromPlan || titleFromTopic || "새 만화 프로젝트";
  };

  const buildSavedProjectSnapshot = (): SavedComicProjectSnapshot | null => {
    if (!seriesPlan) return null;

    const compactFinalStyle = compactStyleForStorage(finalStyle || seriesPlan.series_spec.anchors.style);

    return {
      topic,
      questionType: LEARNING_QUESTION_TYPE,
      comicMode: creationType === "educational" ? LEARNING_COMIC_MODE : comicMode,
      outputMode: toLegacyOutputMode(publicationFormat),
      publicationFormat,
      mangaColorMode,
      i2vAspectRatio,
      toneMode,
      toneLevel,
      introStyle: LEARNING_INTRO_STYLE,
      language,
      audienceLevel,
      deliveryStyleId,
      deliveryCustomInstruction,
      geminiReasoningEffort,
      layoutVariety,
      imageSize,
      imageProvider,
      codexImageQuality,
      scriptDetail,
      pageCountMode,
      targetPageCount,
      narrativeRole: creationType === "educational" ? LEARNING_NARRATIVE_ROLE : narrativeRole,
      characterConsistencyMode,
      useCrossPageStyleConsistency,
      researchMode,
      researchDigestText,
      cast: compactCastForStorage(cast),
      productReferenceImages: pickPersistableImageUrls(
        productReferenceImages,
        MAX_PERSISTABLE_PRODUCT_REF_IMAGES
      ),
      selectedPresetId,
      selectedStyleCategory,
      finalStyle: compactFinalStyle,
      seriesPlan: compactSeriesPlanForStorage(seriesPlan),
      pageResults: sortGenerationResults(pageResults),
      pageErrors,
      pageRenderedAt,
      pageRenderedImageSize,
      pageRenderedEngineKey,
      pageScriptEditedAt,
      pageStyleOverrides: compactStyleOverrideRecordForStorage(pageStyleOverrides),
      pageStyleEditedAt,
      globalStyleEditedAt,
      creationType,
      scriptText,
      storyInputType,
      storyAdaptationMode,
      ageRating,
      storyGenre,
      pacingPreference,
      storyAntiEducationGuardEnabled,
      storyDigestText,
      paperBrief
    };
  };

  const upsertSavedProject = (opts?: { label?: string; forceNew?: boolean; silent?: boolean }) => {
    const snapshot = buildSavedProjectSnapshot();
    if (!snapshot) {
      if (!opts?.silent) setSystemError(ui("저장할 플랜이 없어. 먼저 플랜을 생성해줘.", "No plan to save. Generate a plan first."));
      return;
    }

    const now = Date.now();
    const requestedLabel = String(opts?.label || "").trim();
    setSavedProjects((prev) => {
      const existing = !opts?.forceNew && activeProjectId
        ? prev.find((p) => p.id === activeProjectId)
        : null;
      const fallbackLabel = existing?.label || suggestSavedProjectLabel();
      const resolvedLabel = requestedLabel || fallbackLabel || "새 만화 프로젝트";

      const nextProject: SavedComicProject = existing
        ? {
          ...existing,
          label: resolvedLabel,
          updated_at: now,
          snapshot
        }
        : {
          id: createClientId(),
          label: resolvedLabel,
          created_at: now,
          updated_at: now,
          last_opened_at: now,
          snapshot
        };

      const next = [nextProject, ...prev.filter((p) => p.id !== nextProject.id)].slice(0, MAX_SAVED_PROJECTS);
      setActiveProjectId(nextProject.id);
      setSelectedSavedProjectId(nextProject.id);
      return next;
    });
    if (!opts?.silent) setSystemError(null);
  };

  const promptSaveProject = () => {
    const snapshot = buildSavedProjectSnapshot();
    if (!snapshot) {
      setSystemError(ui("저장할 플랜이 없어. 먼저 플랜을 생성해줘.", "No plan to save. Generate a plan first."));
      return;
    }
    const active = savedProjects.find((p) => p.id === activeProjectId);
    const suggested = active?.label || suggestSavedProjectLabel();
    const entered = window.prompt(ui("프로젝트 이름(저장 라벨)", "Project name (save label)"), suggested);
    if (entered === null) return;
    upsertSavedProject({ label: entered });
  };

  const loadSavedProject = (projectId: string) => {
    const project = savedProjects.find((p) => p.id === projectId);
    if (!project) return;
    const snapshot = project.snapshot;
    if (!snapshot?.seriesPlan) return;

    cancelInFlightGeneration();
    const restoredRawPlan = deepClone(snapshot.seriesPlan);
    const restoredFinalStyle =
      compactStyleForStorage(snapshot.finalStyle || restoredRawPlan?.series_spec?.anchors?.style) ||
      restoredRawPlan?.series_spec?.anchors?.style ||
      null;
    const restoredCast = normalizeCastFromSnapshot(snapshot.cast);
    const restoredCreationType: CreationType = snapshot.creationType || "educational";
    const restoredComicMode =
      restoredCreationType === "educational"
        ? LEARNING_COMIC_MODE
        : snapshot.comicMode || "learning";
    const restoredOutputMode: OutputMode = snapshot.outputMode || "comic";
    const restoredRawPublicationFormat: PublicationFormat =
      (snapshot as any).publicationFormat ||
      (restoredOutputMode === "kling_i2v" ? "kling_i2v" : getDefaultPublicationFormat(restoredCreationType));
    const restoredPublicationFormat = normalizeSelectablePublicationFormat(
      restoredRawPublicationFormat,
      restoredCreationType
    );
    const restoredMangaColorMode: MangaColorMode = (snapshot as any).mangaColorMode || "bw";
    const restoredI2VAspectRatio: I2VAspectRatio = snapshot.i2vAspectRatio || "16:9";
    const restoredNarrativeRole =
      restoredCreationType === "educational"
        ? LEARNING_NARRATIVE_ROLE
        : snapshot.narrativeRole || "narrator";
    const restoredCharacterConsistencyMode = snapshot.characterConsistencyMode || "loose";
    const restoredUseCrossPageStyleConsistency = snapshot.useCrossPageStyleConsistency === true;
    const restoredStoryAntiEducationGuardEnabled =
      typeof snapshot.storyAntiEducationGuardEnabled === "boolean"
        ? snapshot.storyAntiEducationGuardEnabled
        : restoredRawPlan.series_spec.constraints?.story_anti_education_guard !== false;
    const restoredProductReferenceImages = (snapshot.productReferenceImages || [])
      .map((img) => keepPersistableImageUrl(img))
      .filter((img): img is string => Boolean(img));
    const restoredPlan = syncPlanAnchorsFromSnapshot(restoredRawPlan, {
      cast: restoredCast,
      productReferenceImages: restoredProductReferenceImages,
      finalStyle: restoredFinalStyle,
      narrativeRole: restoredNarrativeRole,
      topic: snapshot.topic || "",
      comicMode: restoredComicMode,
      publicationFormat: restoredPublicationFormat,
      i2vAspectRatio: restoredI2VAspectRatio,
      mangaColorMode: restoredMangaColorMode,
      imageProvider:
        snapshot.imageProvider ||
        restoredRawPlan.series_spec.constraints?.image_provider ||
        DEFAULT_IMAGE_PROVIDER,
      codexImageQuality:
        snapshot.codexImageQuality ||
        snapshot.openAiImageQuality ||
        restoredRawPlan.series_spec.constraints?.codex_image_quality ||
        restoredRawPlan.series_spec.constraints?.openai_image_quality ||
        DEFAULT_CODEX_IMAGE_QUALITY,
      characterConsistencyMode: restoredCharacterConsistencyMode,
      storyAntiEducationGuardEnabled: restoredStoryAntiEducationGuardEnabled
    });
    const restoredImageSize = snapshot.imageSize || restoredPlan.series_spec.constraints.image_size || "2K";
    const restoredImageProvider: ImageProvider = "codex";
    const restoredCodexImageQuality: CodexImageQuality =
      snapshot.codexImageQuality ||
      snapshot.openAiImageQuality ||
      restoredPlan.series_spec.constraints.codex_image_quality ||
      (restoredPlan.series_spec.constraints as any).openai_image_quality ||
      DEFAULT_CODEX_IMAGE_QUALITY;
    const effectiveRestoredImageProvider: ImageProvider = "codex";
    const syncedRestoredPlan: SeriesPlan = {
      ...restoredPlan,
      series_spec: {
        ...restoredPlan.series_spec,
        constraints: {
          ...restoredPlan.series_spec.constraints,
          image_size: restoredImageSize,
          image_provider: effectiveRestoredImageProvider,
          codex_image_quality: restoredCodexImageQuality
        }
      }
    };
    const restoredPageResults = sortGenerationResults(snapshot.pageResults || []);
    const restoredPageErrors = snapshot.pageErrors || {};
    const restoredRenderedAt = restoredPageResults.reduce<Record<number, number>>((acc, result) => {
      acc[result.page_index] = snapshot.pageRenderedAt?.[result.page_index] || project.updated_at || Date.now();
      return acc;
    }, { ...(snapshot.pageRenderedAt || {}) });
    const restoredRenderedImageSize = restoredPageResults.reduce<Record<number, ImageSize>>((acc, result) => {
      acc[result.page_index] = snapshot.pageRenderedImageSize?.[result.page_index] || restoredImageSize;
      return acc;
    }, { ...(snapshot.pageRenderedImageSize || {}) });
    const restoredRenderedEngineKey = restoredPageResults.reduce<Record<number, string>>((acc, result) => {
      acc[result.page_index] = snapshot.pageRenderedEngineKey?.[result.page_index] || buildImageEngineKey(effectiveRestoredImageProvider, codexImageModel, restoredCodexImageQuality);
      return acc;
    }, { ...(snapshot.pageRenderedEngineKey || {}) });

    setSystemError(null);
    setGeminiReasoningEffort(snapshot.geminiReasoningEffort || "medium");
    setTopic(snapshot.topic || "");
    setComicMode(restoredComicMode);
    setPublicationFormat(restoredPublicationFormat);
    setMangaColorMode(restoredMangaColorMode);
    setI2VAspectRatio(restoredI2VAspectRatio);
    setToneMode(snapshot.toneMode || "normal");
    setToneLevel(snapshot.toneLevel || "medium");
    setLanguage(snapshot.language || restoredPlan.series_spec.series.language || "ko");
    setBusyPhase("planning");
    setAudienceLevel(snapshot.audienceLevel || "beginner");
    setDeliveryStyleId(snapshot.deliveryStyleId || "standard");
    setDeliveryCustomInstruction(snapshot.deliveryCustomInstruction || "");
    setLayoutVariety(snapshot.layoutVariety || DEFAULT_LAYOUT_VARIETY);
    setImageSize(restoredImageSize);
    setImageProvider(effectiveRestoredImageProvider);
    setCodexImageQuality(restoredCodexImageQuality);
    setScriptDetail(snapshot.scriptDetail || "normal");
    setPageCountMode(snapshot.pageCountMode || "auto");
    setTargetPageCount(clampPageCount(snapshot.targetPageCount || syncedRestoredPlan.series_spec.series.page_count || 2));
    setNarrativeRole(restoredNarrativeRole);
    setCharacterConsistencyMode(restoredCharacterConsistencyMode);
    setUseCrossPageStyleConsistency(restoredUseCrossPageStyleConsistency);
    setCreationType(restoredCreationType);
    setScriptText(snapshot.scriptText || "");
    setStoryInputType(snapshot.storyInputType || "scenario");
    setStoryAdaptationMode(snapshot.storyAdaptationMode || "analyzed");
    setAgeRating(snapshot.ageRating || "teen");
    setStoryGenre(snapshot.storyGenre ?? null);
    setPacingPreference(snapshot.pacingPreference || "balanced");
    setStoryAntiEducationGuardEnabled(restoredStoryAntiEducationGuardEnabled);
    setStoryDigestText(snapshot.storyDigestText || "");
    setStoryDigestWarnings([]);
    setStoryDigestError(null);
    setStoryPageSuggestions(null);
    setPaperFile(null);
    setPaperUrl("");
    setPaperBrief(snapshot.paperBrief || null);
    setPaperBriefError(null);
    setIsPaperAnalyzing(false);
    setResearchMode("auto_digest");
    setResearchReportText("");
    setResearchReportFile(null);
    setResearchDigestText(snapshot.researchDigestText || "");
    setResearchDigestSources([]);
    setResearchDigestWarnings([]);
    setResearchDigestError(null);
    setPageSuggestions(null);
    setIsResearchAnalyzing(false);
    setCast(restoredCast);
    setProductReferenceImages(restoredProductReferenceImages);
    setSelectedPresetId(snapshot.selectedPresetId || "kwebtoon_clean_pastel");
    setSelectedStyleCategory(snapshot.selectedStyleCategory || "Webtoon");
    setFinalStyle(restoredFinalStyle);
    setStyleReferenceImage(restoredFinalStyle?.style_reference_image || null);
    setStyleReferenceError(null);
    setSeriesPlan(syncedRestoredPlan);
    setPageResults(restoredPageResults);
    setPageErrors(restoredPageErrors);
    setWebtoonEpisodeResult(null);
    setIsBuildingWebtoonEpisode(false);
    setPageRenderedAt(restoredRenderedAt);
    setPageRenderedImageSize(restoredRenderedImageSize);
    setPageRenderedEngineKey(restoredRenderedEngineKey);
    setPageScriptEditedAt(snapshot.pageScriptEditedAt || {});
    setPageStyleOverrides(snapshot.pageStyleOverrides || {});
    setPageStyleEditedAt(snapshot.pageStyleEditedAt || {});
    setGlobalStyleEditedAt(Number(snapshot.globalStyleEditedAt || 0));
    clearPageGenerationTracking();
    setPageScriptEditorOpen(false);
    setPageScriptDraft(null);
    setPageEditActionOpen(false);
    setPageEditTargetIndex(null);
    setPageStyleEditorOpen(false);
    setPageStyleTargetIndex(null);
    setStatus(AppStatus.READY_TO_GENERATE);
    setActiveProjectId(project.id);
    setSelectedSavedProjectId(project.id);

    const now = Date.now();
    setSavedProjects((prev) => {
      const existing = prev.find((p) => p.id === project.id);
      if (!existing) return prev;
      const touched = { ...existing, updated_at: now, last_opened_at: now };
      return [touched, ...prev.filter((p) => p.id !== project.id)].slice(0, MAX_SAVED_PROJECTS);
    });
  };

  const deleteSavedProject = (projectId: string) => {
    const project = savedProjects.find((p) => p.id === projectId);
    if (!project) return;
    if (!window.confirm(ui(`"${project.label}" 프로젝트를 삭제할까요?`, `Delete project "${project.label}"?`))) return;
    setSavedProjects((prev) => prev.filter((p) => p.id !== projectId));
    if (activeProjectId === projectId) setActiveProjectId("");
    if (selectedSavedProjectId === projectId) setSelectedSavedProjectId("");
  };

  useEffect(() => {
    if (!seriesPlan) return;
    if (!(status === AppStatus.READY_TO_GENERATE || status === AppStatus.GENERATING_PANELS)) return;
    upsertSavedProject({ silent: true });
  }, [
    activeProjectId,
    audienceLevel,
    cast,
    characterConsistencyMode,
    comicMode,
    deliveryCustomInstruction,
    deliveryStyleId,
    finalStyle,
    globalStyleEditedAt,
    imageProvider,
    imageSize,
    language,
    layoutVariety,
    narrativeRole,
    codexImageQuality,
    geminiReasoningEffort,
    publicationFormat,
    mangaColorMode,
    i2vAspectRatio,
    pageCountMode,
    pageErrors,
    pageRenderedAt,
    pageRenderedEngineKey,
    pageRenderedImageSize,
    pageResults,
    pageScriptEditedAt,
    pageStyleEditedAt,
    pageStyleOverrides,
    paperBrief,
    productReferenceImages,
    researchDigestText,
    researchMode,
    scriptDetail,
    selectedPresetId,
    selectedStyleCategory,
    seriesPlan,
    status,
    targetPageCount,
    toneLevel,
    toneMode,
    topic,
    storyAntiEducationGuardEnabled,
    useCrossPageStyleConsistency
  ]);

  useEffect(() => {
    if (
      !(
        status === AppStatus.PLAN_REVIEW ||
        status === AppStatus.READY_TO_GENERATE ||
        status === AppStatus.GENERATING_PANELS
      )
    ) {
      return;
    }
    syncSeriesPlanAnchors(cast, productReferenceImages);
  }, [
    cast,
    characterConsistencyMode,
    comicMode,
    publicationFormat,
    mangaColorMode,
    i2vAspectRatio,
    finalStyle,
    narrativeRole,
    productReferenceImages,
    storyAntiEducationGuardEnabled,
    status,
    topic
  ]);

  const updateCastMember = (id: string, patch: Partial<CharacterSpec>) => {
    setCast((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const addCastMember = (role: CastRole) => {
    setCast((prev) => {
      const protagonistCount = prev.filter((c) => c.role === "protagonist").length;
      if (role === "protagonist" && protagonistCount >= 2) {
        setSystemError(ui("주연(주인공)은 최대 2명까지 가능해.", "You can have up to 2 lead characters."));
        return prev;
      }
      setSystemError(null);
      return [...prev, createCharacter(role)];
    });
  };

  const removeCastMember = (id: string) => {
    setCast((prev) => {
      const target = prev.find((c) => c.id === id);
      if (!target) return prev;
      if (target.role === "protagonist") {
        const protagonistCount = prev.filter((c) => c.role === "protagonist").length;
        if (protagonistCount <= 1) {
          setSystemError(ui("주연(주인공)은 최소 1명은 있어야 해.", "You need at least 1 lead character."));
          return prev;
        }
      }
      setSystemError(null);
      return prev.filter((c) => c.id !== id);
    });
  };

  const compressReferenceDataUrl = async (dataUrl: string): Promise<string> => {
    return compressImageDataUrl(dataUrl, {
      maxEdge: REFERENCE_IMAGE_MAX_EDGE,
      maxLength: MAX_PERSISTABLE_DATA_URL_LENGTH,
      quality: REFERENCE_IMAGE_JPEG_QUALITY,
    });
  };

  const readFileAsDataUrl = async (file: File): Promise<string> => {
    return readImageFileAsCompressedDataUrl(file, {
      maxEdge: REFERENCE_IMAGE_MAX_EDGE,
      maxLength: MAX_PERSISTABLE_DATA_URL_LENGTH,
      quality: REFERENCE_IMAGE_JPEG_QUALITY,
    });
  };

  const readStyleReferenceFileAsDataUrl = async (file: File): Promise<string> => {
    const dataUrl = await readFileAsDataUrl(file);
    if (isDataUrl(dataUrl) && dataUrl.length > MAX_PERSISTABLE_DATA_URL_LENGTH) {
      throw new Error(ui("스타일 이미지를 저장 가능한 크기로 줄이지 못했어. 더 작은 PNG/JPG 이미지를 올려줘.", "Could not shrink the style image enough to save. Upload a smaller PNG/JPG image."));
    }
    return dataUrl;
  };

  const MAX_REF_IMAGES_PER_CHARACTER = 4;
  const MAX_REF_IMAGE_BYTES = 6 * 1024 * 1024; // 6MB
  const MAX_PRODUCT_REF_IMAGES = 2;

  const syncSeriesPlanAnchors = (
    nextCast: CharacterSpec[],
    nextProductReferenceImages: string[]
  ) => {
    setSeriesPlan((prev) => {
      if (!prev) return prev;
      return syncPlanAnchorsFromSnapshot(prev, {
        cast: nextCast,
        productReferenceImages: nextProductReferenceImages,
        finalStyle: finalStyle || prev.series_spec.anchors.style,
        narrativeRole,
        topic,
        comicMode,
        publicationFormat,
        mangaColorMode,
        i2vAspectRatio,
        imageProvider,
        codexImageQuality,
        characterConsistencyMode,
        storyAntiEducationGuardEnabled
      });
    });
  };

  const addProductReferenceImages = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const fileArray = Array.from(files);
    const oversized = fileArray.find((f) => f.size > MAX_REF_IMAGE_BYTES);
    if (oversized) {
      setSystemError(ui("이미지 용량이 너무 커. 6MB 이하로 업로드해줘.", "Image is too large. Upload an image under 6MB."));
      return;
    }

    const capacity = Math.max(0, MAX_PRODUCT_REF_IMAGES - productReferenceImages.length);
    const toRead = fileArray.slice(0, capacity);
    if (toRead.length === 0) {
      setSystemError(ui(`상품 레퍼런스 이미지는 최대 ${MAX_PRODUCT_REF_IMAGES}장까지 가능해.`, `Product reference images are limited to ${MAX_PRODUCT_REF_IMAGES}.`));
      return;
    }

    try {
      setSystemError(null);
      const urls = await Promise.all(toRead.map(readFileAsDataUrl));
      setProductReferenceImages((prev) => [...prev, ...urls].filter(Boolean));
    } catch (e: any) {
      setSystemError(e?.message || ui("이미지 업로드에 실패했어.", "Image upload failed."));
    }
  };

  const removeProductReferenceImage = (index: number) => {
    setProductReferenceImages((prev) => prev.filter((_, i) => i !== index));
  };

  const addReferenceImages = async (id: string, files: FileList | null) => {
    if (!files || files.length === 0) return;
    const fileArray = Array.from(files);
    const oversized = fileArray.find((f) => f.size > MAX_REF_IMAGE_BYTES);
    if (oversized) {
      setSystemError(ui("이미지 용량이 너무 커. 6MB 이하로 업로드해줘.", "Image is too large. Upload an image under 6MB."));
      return;
    }

    const current = cast.find((c) => c.id === id);
    const currentCount = current?.reference_images?.length || 0;
    const capacity = Math.max(0, MAX_REF_IMAGES_PER_CHARACTER - currentCount);
    const toRead = fileArray.slice(0, capacity);
    if (toRead.length === 0) {
      setSystemError(ui(`캐릭터당 레퍼런스 이미지는 최대 ${MAX_REF_IMAGES_PER_CHARACTER}장까지 가능해.`, `Reference images are limited to ${MAX_REF_IMAGES_PER_CHARACTER} per character.`));
      return;
    }

    try {
      setSystemError(null);
      const urls = await Promise.all(toRead.map(readFileAsDataUrl));
      setCast((prev) =>
        prev.map((c) => (c.id === id ? {
          ...c,
          reference_images: [...(c.reference_images || []), ...urls].filter(Boolean),
          style_aligned_reference_images: [],
          style_aligned_reference_style_key: undefined
        } : c))
      );

      // Auto-analyze the first uploaded image to extract structured appearance attributes
      const firstNewUrl = urls.find(Boolean);
      if (firstNewUrl) {
        analyzeCharacterImage(firstNewUrl).then((analyzed) => {
          if (analyzed) {
            setCast((prev) =>
              prev.map((c) => (c.id === id ? { ...c, analyzed_appearance: analyzed } : c))
            );
            console.log(`[addReferenceImages] Auto-analyzed character ${id}:`, analyzed);
          }
        }).catch(() => { /* silent — manual appearance is the fallback */ });
      }
    } catch (e: any) {
      setSystemError(e?.message || ui("이미지 업로드에 실패했어.", "Image upload failed."));
    }
  };

  const removeReferenceImage = (id: string, index: number) => {
    setCast((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        const remaining = (c.reference_images || []).filter((_: string, i: number) => i !== index);
        const removed = (c.reference_images || [])[index];
        const remainingStyleAligned = (c.style_aligned_reference_images || []).filter((url) => url !== removed);
        return {
          ...c,
          reference_images: remaining,
          style_aligned_reference_images: remaining.length > 0 ? remainingStyleAligned : [],
          style_aligned_reference_style_key: remaining.length > 0 && remainingStyleAligned.length > 0 ? c.style_aligned_reference_style_key : undefined,
          ...(remaining.length === 0 ? { analyzed_appearance: undefined } : {})
        };
      })
    );
  };

  const clearStyleAlignedReference = (id: string) => {
    setCast((prev) =>
      prev.map((c) => (c.id === id ? {
        ...c,
        style_aligned_reference_images: [],
        style_aligned_reference_style_key: undefined
      } : c))
    );
    setCharacterReferenceErrors((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const buildContentSourceForCast = (): { label: string; text: string } => {
    if (creationType === "story") {
      const digest = storyDigestText.trim();
      const original = scriptText.trim();
      if (digest && original) {
        return {
          label: ui("스토리 분석본+원문", "Story digest + original"),
          text: [
            "[STORY DIGEST]",
            digest,
            "",
            "[ORIGINAL STORY EXCERPT]",
            original.slice(0, 50000)
          ].join("\n")
        };
      }
      if (digest) return { label: ui("스토리 분석본", "Story digest"), text: digest };
      return { label: ui("원문 스토리", "Original story"), text: scriptText.trim() };
    }

    if (creationType === "paper") {
      if (!paperBrief) return { label: ui("논문 해설 원고", "Paper story"), text: "" };
      return {
        label: ui("논문 해설 원고", "Paper story"),
        text: [
          paperBrief.paper_title,
          paperBrief.explainer_story
        ].filter(Boolean).join("\n")
      };
    }

    const digest = researchDigestText.trim();
    if (digest) return { label: ui("소설형 해설 원고", "Story-style explainer"), text: digest };
    const userReport = researchReportText.trim();
    if (userReport) return { label: ui("업로드 자료", "Uploaded material"), text: userReport };
    return { label: ui("주제", "Topic"), text: topic.trim() };
  };

  const resolveCurrentStyle = (): SeriesSpec["anchors"]["style"] => ({
    ...selectStyle(stylePresets, selectedPresetId, "", { publicationFormat, mangaColorMode }),
    style_reference_image: styleReferenceImage
  });

  const getCurrentReferenceStyle = (): SeriesSpec["anchors"]["style"] => finalStyle || resolveCurrentStyle();

  const suggestLongformProjectLabel = (): string => {
    const namedCharacters = cast
      .map((c) => String(c.name || "").trim())
      .filter(Boolean)
      .slice(0, 2);
    if (topic.trim()) return topic.trim();
    if (namedCharacters.length > 0) return `${namedCharacters.join("+")} 세계관`;
    return "새 장편 프로젝트";
  };

  const buildLongformSnapshot = (): SavedLongformProjectSnapshot | null => {
    const meaningfulCast = cast.filter((c) =>
      Boolean(
        String(c.name || "").trim() ||
        String(c.appearance || "").trim() ||
        String(c.persona || "").trim() ||
        (c.reference_images || []).filter(Boolean).length > 0
      )
    );
    if (meaningfulCast.length === 0) return null;
    return {
      cast: compactCastForStorage(meaningfulCast),
      selectedPresetId,
      selectedStyleCategory,
      finalStyle: compactStyleForStorage(finalStyle || resolveCurrentStyle()),
      styleReferenceImage: keepPersistableImageUrl(styleReferenceImage) || null,
      creationType,
      comicMode,
      publicationFormat,
      mangaColorMode,
      i2vAspectRatio,
      narrativeRole: creationType === "educational" ? LEARNING_NARRATIVE_ROLE : narrativeRole,
      characterConsistencyMode,
      useCrossPageStyleConsistency
    };
  };

  const getCharacterMergeKey = (character: CharacterSpec): string => {
    const name = String(character.name || "").trim().toLowerCase();
    if (name) return `name:${name}`;
    return `id:${character.id}`;
  };

  const mergeLongformCast = (existingCast: CharacterSpec[], incomingCast: CharacterSpec[]): CharacterSpec[] => {
    const merged = existingCast.map((c) => ({
      ...c,
      reference_images: Array.isArray(c.reference_images) ? [...c.reference_images] : [],
      style_aligned_reference_images: Array.isArray(c.style_aligned_reference_images) ? [...c.style_aligned_reference_images] : []
    }));
    const indexById = new Map(merged.map((c, index) => [c.id, index]));
    const indexByKey = new Map(merged.map((c, index) => [getCharacterMergeKey(c), index]));

    for (const incoming of incomingCast) {
      const byId = indexById.get(incoming.id);
      const byKey = indexByKey.get(getCharacterMergeKey(incoming));
      const targetIndex = typeof byId === "number" ? byId : byKey;
      if (typeof targetIndex === "number") {
        const current = merged[targetIndex];
        const nextRefs = (incoming.reference_images || []).filter(Boolean);
        const nextStyleRefs = (incoming.style_aligned_reference_images || []).filter(Boolean);
        merged[targetIndex] = {
          ...current,
          ...incoming,
          id: current.id,
          reference_images: nextRefs.length > 0 ? nextRefs : current.reference_images,
          style_aligned_reference_images: nextStyleRefs.length > 0 ? nextStyleRefs : current.style_aligned_reference_images,
          style_aligned_reference_style_key: incoming.style_aligned_reference_style_key || current.style_aligned_reference_style_key
        };
      } else {
        merged.push({
          ...incoming,
          id: incoming.id || createClientId(),
          reference_images: Array.isArray(incoming.reference_images) ? [...incoming.reference_images] : [],
          style_aligned_reference_images: Array.isArray(incoming.style_aligned_reference_images) ? [...incoming.style_aligned_reference_images] : []
        });
      }
    }
    return merged;
  };

  const upsertLongformProject = (opts?: { label?: string; forceNew?: boolean; silent?: boolean }) => {
    const baseSnapshot = buildLongformSnapshot();
    if (!baseSnapshot) {
      const message = ui("보관함에 저장할 캐릭터가 없어.", "No characters to save to the library.");
      setLongformNotice({ kind: "error", message });
      if (!opts?.silent) setSystemError(message);
      return;
    }

    const now = Date.now();
    const requestedLabel = String(opts?.label || "").trim();
    setLongformProjects((prev) => {
      const existing = !opts?.forceNew && activeLongformProjectId
        ? prev.find((p) => p.id === activeLongformProjectId)
        : null;
      const resolvedLabel = requestedLabel || existing?.label || suggestLongformProjectLabel();
      const snapshot: SavedLongformProjectSnapshot = existing
        ? {
          ...baseSnapshot,
          cast: compactCastForStorage(mergeLongformCast(existing.snapshot.cast, baseSnapshot.cast))
        }
        : baseSnapshot;
      const nextProject: SavedLongformProject = existing
        ? {
          ...existing,
          label: resolvedLabel,
          updated_at: now,
          snapshot
        }
        : {
          id: createClientId(),
          label: resolvedLabel,
          created_at: now,
          updated_at: now,
          last_opened_at: now,
          snapshot
        };
      setActiveLongformProjectId(nextProject.id);
      setSelectedLongformProjectId(nextProject.id);
      return [nextProject, ...prev.filter((p) => p.id !== nextProject.id)].slice(0, 80);
    });
    setLongformNotice({
      kind: "success",
      message: ui("현재 캐릭터와 스타일을 장편 보관함에 저장했어.", "Saved the current cast and style to the longform library."),
      detail: ui(`${baseSnapshot.cast.length}명 반영`, `${baseSnapshot.cast.length} characters applied`)
    });
    if (!opts?.silent) setSystemError(null);
  };

  const promptSaveLongformProject = (forceNew = false) => {
    const suggested = forceNew
      ? suggestLongformProjectLabel()
      : longformProjects.find((p) => p.id === activeLongformProjectId)?.label || suggestLongformProjectLabel();
    const entered = window.prompt(ui("장편 프로젝트 이름", "Longform project name"), suggested);
    if (entered === null) return;
    upsertLongformProject({ label: entered, forceNew });
  };

  const loadLongformProject = (projectId: string) => {
    const project = longformProjects.find((p) => p.id === projectId);
    if (!project) return;
    const snapshot = project.snapshot;
    cancelInFlightGeneration();
    setProductionMode("longform");
    setActiveLongformProjectId(project.id);
    setSelectedLongformProjectId(project.id);
    setCreationType(snapshot.creationType || "story");
    setComicMode(snapshot.comicMode || "pure_cinematic");
    setPublicationFormat(normalizeSelectablePublicationFormat(
      snapshot.publicationFormat || getDefaultPublicationFormat(snapshot.creationType || "story"),
      snapshot.creationType || "story"
    ));
    setMangaColorMode(snapshot.mangaColorMode || "bw");
    setI2VAspectRatio(snapshot.i2vAspectRatio || "16:9");
    setNarrativeRole(snapshot.narrativeRole || "actor");
    setCharacterConsistencyMode(snapshot.characterConsistencyMode || "strict");
    setUseCrossPageStyleConsistency(snapshot.useCrossPageStyleConsistency === true);
    setSelectedPresetId(snapshot.selectedPresetId || "kwebtoon_clean_pastel");
    setSelectedStyleCategory(snapshot.selectedStyleCategory || "Webtoon");
    setFinalStyle(snapshot.finalStyle || null);
    setStyleReferenceImage(snapshot.styleReferenceImage || snapshot.finalStyle?.style_reference_image || null);
    setStyleReferenceError(null);
    setCharacterInputMode("suggest");
    setCast([createCharacter("protagonist")]);
    setEpisodeCastReview(null);
    setEpisodePossibleMatchSelections({});
    setEpisodeNewCharacterSelections({});
    setLongformNotice({
      kind: "success",
      message: ui(`"${project.label}" 보관함을 불러왔어.`, `Loaded "${project.label}".`),
      detail: ui(`${snapshot.cast.length}명 보관 중. 이번 화 원고를 넣고 출연진을 자동 선택해줘.`, `${snapshot.cast.length} saved characters. Add this episode's script and select the cast.`)
    });
    setSystemError(null);
  };

  const deleteLongformProject = (projectId: string) => {
    const project = longformProjects.find((p) => p.id === projectId);
    if (!project) return;
    if (!window.confirm(ui(`"${project.label}" 장편 프로젝트를 삭제할까?`, `Delete longform project "${project.label}"?`))) return;
    setLongformProjects((prev) => prev.filter((p) => p.id !== projectId));
    if (activeLongformProjectId === projectId) {
      setActiveLongformProjectId("");
      setEpisodeCastReview(null);
      setEpisodePossibleMatchSelections({});
      setEpisodeNewCharacterSelections({});
    }
  };

  const cloneCharacterForEpisode = (source: CharacterSpec, role?: CastRole): CharacterSpec => ({
    ...source,
    id: createClientId(),
    role: role || source.role,
    reference_images: Array.isArray(source.reference_images) ? [...source.reference_images] : [],
    style_aligned_reference_images: Array.isArray(source.style_aligned_reference_images) ? [...source.style_aligned_reference_images] : []
  });

  const normalizeEpisodeCast = (items: CharacterSpec[]): CharacterSpec[] => {
    const clean = items.filter((c) =>
      Boolean(String(c.name || c.appearance || c.persona || "").trim() || (c.reference_images || []).length > 0)
    );
    if (clean.length === 0) return [createCharacter("protagonist")];
    const protagonists = clean.filter((c) => c.role === "protagonist").slice(0, 2);
    const supporting = clean.filter((c) => c.role === "supporting");
    if (protagonists.length > 0) return [...protagonists, ...supporting];
    const [first, ...rest] = clean;
    return [{ ...first, role: "protagonist" }, ...rest.map((c) => ({ ...c, role: "supporting" as CastRole }))];
  };

  const createCharacterFromEpisodeCandidate = (
    candidate: EpisodeCastSelectionResult["new_character_candidates"][number]
  ): CharacterSpec => ({
    ...createCharacter(candidate.role, candidate.name),
    appearance: candidate.appearance || candidate.visual_prompt,
    persona: [candidate.persona, candidate.story_function].filter(Boolean).join("\n"),
    catchphrase: candidate.catchphrase || "",
    catchphrase_frequency: "rare",
    reference_images: []
  });

  const getSelectedNewEpisodeCandidates = (): EpisodeCastSelectionResult["new_character_candidates"] => {
    if (!episodeCastReview) return [];
    return episodeCastReview.new_character_candidates.filter((_, index) => episodeNewCharacterSelections[index] !== false);
  };

  const runEpisodeCastSelection = async () => {
    if (isSelectingEpisodeCast) return;
    const project = longformProjects.find((p) => p.id === activeLongformProjectId);
    if (!project) {
      const message = ui("먼저 장편 프로젝트를 불러와줘.", "Load a longform project first.");
      setLongformNotice({ kind: "error", message });
      return;
    }
    if (!hasApiKey) {
      const message = ui("출연진 자동 선택에는 로컬 서버와 Codex 로그인이 필요해.", "Episode cast selection requires the local server and Codex login.");
      setLongformNotice({ kind: "error", message });
      setSystemError(message);
      return;
    }
    if (scriptText.trim().length < STORY_MIN_INPUT_CHARS) {
      const message = ui(`이번 화 소설/원고를 먼저 ${STORY_MIN_INPUT_CHARS}자 이상 입력해줘.`, `Add at least ${STORY_MIN_INPUT_CHARS} characters of this episode's script first.`);
      setLongformNotice({ kind: "error", message });
      return;
    }

    setIsSelectingEpisodeCast(true);
    setEpisodeCastReview(null);
    setEpisodePossibleMatchSelections({});
    setEpisodeNewCharacterSelections({});
    setLongformNotice({
      kind: "info",
      message: ui("이번 화 원고에서 출연진을 찾는 중이야.", "Finding this episode's cast from the script."),
      detail: ui(`${project.snapshot.cast.length}명 보관함과 비교 중`, `Comparing against ${project.snapshot.cast.length} saved characters`)
    });
    try {
      const selectedStyle = resolveCurrentStyle();
      const result = await analyzeEpisodeCastFromLibrary({
        episode_text: scriptText,
        character_library: project.snapshot.cast,
        publication_format: publicationFormat,
        story_genre: storyGenre || undefined,
        story_input_type: storyInputType,
        age_rating: ageRating,
        selected_style: {
          preset_id: selectedStyle.preset_id,
          preset_label: selectedStyle.preset_label,
          render_mode: selectedStyle.render_mode,
          style_prompt: selectedStyle.style_prompt,
          user_style_prompt: selectedStyle.user_style_prompt
        }
      });
      setEpisodeCastReview(result);
      setEpisodePossibleMatchSelections(
        Object.fromEntries(
          result.possible_matches.map((match, index) => [index, match.candidate_character_ids[0] || "__skip__"])
        )
      );
      setEpisodeNewCharacterSelections(
        Object.fromEntries(result.new_character_candidates.map((_, index) => [index, true]))
      );
      const matchedCount = result.matched_existing_characters.length;
      const possibleCount = result.possible_matches.length;
      const newCount = result.new_character_candidates.length;
      setLongformNotice({
        kind: "success",
        message: ui(
          `기존 ${matchedCount}명, 확인 필요 ${possibleCount}건, 신규 ${newCount}명을 찾았어.`,
          `Found ${matchedCount} existing, ${possibleCount} possible, and ${newCount} new character${newCount === 1 ? "" : "s"}.`
        )
      });
      setSystemError(null);
    } catch (e: any) {
      const detail = toUserFacingError(e?.message, ui("이번 화 출연진 분석에 실패했어.", "Episode cast selection failed."), uiLanguage);
      setLongformNotice({
        kind: "error",
        message: ui("이번 화 출연진을 자동 선택하지 못했어.", "Could not select this episode's cast."),
        detail
      });
      setSystemError(detail);
    } finally {
      setIsSelectingEpisodeCast(false);
    }
  };

  const applyEpisodeCastReview = (includeNewCharacters = true) => {
    const project = longformProjects.find((p) => p.id === activeLongformProjectId);
    if (!project || !episodeCastReview) return;
    const libraryById = new Map<string, CharacterSpec>(
      project.snapshot.cast.map((c): [string, CharacterSpec] => [c.id, c])
    );
    const picked: CharacterSpec[] = [];
    const pickedIds = new Set<string>();

    for (const match of episodeCastReview.matched_existing_characters) {
      const source = libraryById.get(match.character_id);
      if (!source || pickedIds.has(source.id)) continue;
      picked.push(cloneCharacterForEpisode(source, match.role));
      pickedIds.add(source.id);
    }

    for (const [index, possible] of episodeCastReview.possible_matches.entries()) {
      const selectedId = episodePossibleMatchSelections[index] || possible.candidate_character_ids[0] || "__skip__";
      if (selectedId === "__skip__") continue;
      const source = libraryById.get(selectedId);
      if (!source || pickedIds.has(source.id)) continue;
      picked.push(cloneCharacterForEpisode(source));
      pickedIds.add(source.id);
    }

    if (includeNewCharacters) {
      for (const candidate of getSelectedNewEpisodeCandidates()) {
        picked.push(createCharacterFromEpisodeCandidate(candidate));
      }
    }

    const nextCast = normalizeEpisodeCast(picked);
    setCast(nextCast);
    setCharacterConsistencyMode("strict");
    setCharacterInputMode("manual");
    setCastSuggestionNotice({
      kind: "success",
      message: ui(`이번 화 출연진 ${nextCast.length}명을 적용했어.`, `Applied ${nextCast.length} episode character${nextCast.length === 1 ? "" : "s"}.`),
      detail: includeNewCharacters && getSelectedNewEpisodeCandidates().length > 0
        ? ui("신규 인물은 캐릭터 카드에서 확인하고 필요하면 AI 이미지까지 만든 뒤 보관함에 다시 저장해줘.", "Review new characters in the cards, generate references if needed, then save them back to the library.")
        : undefined
    });
    setLongformNotice({
      kind: "success",
      message: ui("이번 화 출연진을 캐릭터 설정에 적용했어.", "Applied this episode's cast to character setup.")
    });
    setStatus(AppStatus.CHARACTER_SELECT);
  };

  const addSelectedEpisodeNewCharactersToLibrary = () => {
    const project = longformProjects.find((p) => p.id === activeLongformProjectId);
    if (!project || !episodeCastReview) return;
    const selectedCandidates = getSelectedNewEpisodeCandidates();
    if (selectedCandidates.length === 0) {
      setLongformNotice({
        kind: "error",
        message: ui("보관함에 추가할 신규 인물을 선택해줘.", "Select new characters to add to the library.")
      });
      return;
    }

    const newCharacters = selectedCandidates.map(createCharacterFromEpisodeCandidate);
    setLongformProjects((prev) => prev.map((p) => {
      if (p.id !== project.id) return p;
      const mergedCast = compactCastForStorage(mergeLongformCast(p.snapshot.cast, newCharacters));
      return {
        ...p,
        updated_at: Date.now(),
        snapshot: {
          ...p.snapshot,
          cast: mergedCast
        }
      };
    }));
    setLongformNotice({
      kind: "success",
      message: ui(`신규 인물 ${newCharacters.length}명을 보관함 초안으로 추가했어.`, `Added ${newCharacters.length} new character draft${newCharacters.length === 1 ? "" : "s"} to the library.`),
      detail: ui("레퍼런스 이미지는 캐릭터 설정 화면에서 만든 뒤 보관함 업데이트로 보강하면 돼.", "Generate reference images in character setup, then update the library to enrich them.")
    });
  };

  const enterSingleMode = () => {
    setProductionMode("single");
    setLongformNotice(null);
  };

  const enterNewLongformMode = () => {
    setProductionMode("new_longform");
    setCreationType("story");
    setNarrativeRole(getDefaultNarrativeRole("story"));
    setComicMode("pure_cinematic");
    setLayoutVariety(DEFAULT_LAYOUT_VARIETY);
    setActiveLongformProjectId("");
    setEpisodeCastReview(null);
    setEpisodePossibleMatchSelections({});
    setEpisodeNewCharacterSelections({});
    setLongformNotice({
      kind: "info",
      message: ui("1화를 만든 뒤 캐릭터 설정에서 장편 보관함으로 저장하면 돼.", "Make episode 1, then save the cast and style as a longform library in character setup.")
    });
  };

  const enterLongformMode = () => {
    setProductionMode("longform");
    setCreationType("story");
    setNarrativeRole(getDefaultNarrativeRole("story"));
    setComicMode("pure_cinematic");
    setLayoutVariety(DEFAULT_LAYOUT_VARIETY);
    if (!activeLongformProject && longformProjects.length > 0) {
      setSelectedLongformProjectId(longformProjects.slice().sort((a, b) => b.updated_at - a.updated_at)[0]?.id || "");
    }
  };

  const buildCastSuggestionsFromContent = async (
    source: { label: string; text: string },
    selectedStyle: SeriesSpec["anchors"]["style"],
    existingCast: CharacterSpec[]
  ): Promise<CharacterSpec[]> => {
    const suggestions = await suggestCastFromContent({
      source_text: source.text,
      creation_type: creationType,
      publication_format: publicationFormat,
      audience_level: audienceLevel,
      source_label: source.label,
      story_genre: storyGenre || undefined,
      story_input_type: storyInputType,
      age_rating: ageRating,
      pacing: pacingPreference,
      existing_cast: existingCast,
      selected_style: {
        preset_id: selectedStyle.preset_id,
        preset_label: selectedStyle.preset_label,
        render_mode: selectedStyle.render_mode,
        style_prompt: selectedStyle.style_prompt,
        user_style_prompt: selectedStyle.user_style_prompt
      }
    });

    return suggestions.map((c) => ({
      ...createCharacter(c.role, c.name),
      appearance: c.appearance || c.visual_prompt,
      persona: [c.persona, c.story_function].filter(Boolean).join("\n"),
      catchphrase: c.catchphrase || "",
      catchphrase_frequency: "rare" as CatchphraseFrequency,
      reference_images: []
    }));
  };

  const applyContentCastSuggestions = async () => {
    if (isSuggestingCastFromContent) return;
    if (!hasApiKey) {
      const message = ui("캐릭터 제안에는 로컬 서버와 Codex 로그인이 필요해.", "Character suggestions require the local server and Codex login.");
      setCastSuggestionNotice({
        kind: "error",
        message,
        detail: ui("`npm run dev`와 `npx @openai/codex login` 상태를 확인해줘.", "Check `npm run dev` and `npx @openai/codex login`.")
      });
      setSystemError(message);
      return;
    }

    const source = buildContentSourceForCast();
    if (!source.text || source.text.length < 2) {
      const message = ui("먼저 주제나 해설 원고가 필요해.", "Add a topic or story draft first.");
      setCastSuggestionNotice({ kind: "error", message });
      setSystemError(message);
      return;
    }

    setIsSuggestingCastFromContent(true);
    setSystemError(null);
    setCastSuggestionNotice({
      kind: "info",
      message: ui("자료를 읽고 캐릭터 후보를 뽑는 중이야.", "Reading the material and drafting character candidates."),
      detail: ui(`사용 자료: ${source.label}`, `Source: ${source.label}`)
    });
    try {
      const selectedStyle = resolveCurrentStyle();
      const mapped = await buildCastSuggestionsFromContent(source, selectedStyle, cast);

      if (mapped.length === 0) {
        const message = ui("자료에서 캐릭터 후보를 찾지 못했어.", "Could not find character candidates from the material.");
        setCastSuggestionNotice({
          kind: "error",
          message,
          detail: ui(
            `사용 자료: ${source.label}. 자료가 너무 짧거나 인물/역할 단서가 부족하면 빈 결과가 나올 수 있어.`,
            `Source: ${source.label}. This can happen when the material is too short or has too few character/role cues.`
          )
        });
        setSystemError(message);
        return;
      }

      const protagonists = mapped.filter((c) => c.role === "protagonist").slice(0, 2);
      const supporting = mapped.filter((c) => c.role === "supporting");
      setCast(protagonists.length > 0 ? [...protagonists, ...supporting] : [createCharacter("protagonist"), ...supporting]);
      setCharacterConsistencyMode("strict");
      setCastSuggestionNotice({
        kind: "success",
        message: ui(`AI 캐릭터 제안 ${mapped.length}명을 적용했어.`, `Applied ${mapped.length} AI character suggestion${mapped.length === 1 ? "" : "s"}.`),
        detail: ui(`사용 자료: ${source.label}`, `Source: ${source.label}`)
      });
      setSystemError(null);
    } catch (e: any) {
      const detail = toUserFacingError(
        e?.message,
        ui("캐릭터 제안 생성에 실패했어.", "Character suggestion failed."),
        uiLanguage
      );
      setCastSuggestionNotice({
        kind: "error",
        message: ui("AI 캐릭터 제안 적용에 실패했어.", "Could not apply AI character suggestions."),
        detail
      });
      setSystemError(detail);
    } finally {
      setIsSuggestingCastFromContent(false);
    }
  };

  const generateReferenceImageForCharacter = async (id: string) => {
    if (generatingCharacterImageIds[id]) return;
    if (!hasApiKey) {
      setSystemError(ui("AI 캐릭터 이미지 생성에는 로컬 서버와 Codex 로그인이 필요해.", "AI character image generation requires the local server and Codex login."));
      return;
    }

    const target = cast.find((c) => c.id === id);
    if (!target) return;
    const currentRefs = (target.reference_images || []).filter(Boolean);
    const styleAlignedRefSet = new Set((target.style_aligned_reference_images || []).filter(Boolean));
    const sourceIdentityRefs = currentRefs.filter((url) => !styleAlignedRefSet.has(url));

    const selectedStyle = getCurrentReferenceStyle();
    const selectedStyleKey = buildStyleReferenceKey(selectedStyle);
    const contentSource = buildContentSourceForCast();
    const genreEraLock = buildGenreEraLockForCharacter(contentSource.text);
    const identityProfile = String(target.analyzed_appearance || "").trim();
    const manualAppearance = String(target.appearance || "").trim();
    const description = [
      `Source material type: ${contentSource.label}`,
      `Creation type: ${creationType}`,
      `Publication format: ${publicationFormat}`,
      `Story genre setting: ${storyGenre || "unspecified"}`,
      `World / era lock: ${genreEraLock}`,
      `Name/title: ${String(target.name || "").trim() || (target.role === "protagonist" ? "Protagonist" : "Supporting character")}`,
      `Role: ${target.role}`,
      `Identity profile from uploaded reference: ${identityProfile || "none"}`,
      `Manual appearance notes: ${manualAppearance || "none"}`,
      `Appearance to preserve: ${identityProfile || manualAppearance || "clear readable character design"}`,
      `Persona: ${String(target.persona || "").trim() || "recurring comic character"}`,
      `Style direction: ${selectedStyle.style_prompt}`,
      selectedStyle.user_style_prompt ? `Style addition: ${selectedStyle.user_style_prompt}` : "",
      "If uploaded identity references are attached, use them only for likeness/identity. Ignore their original photo look, illustration medium, linework, lighting, color grading, texture, and rendering style.",
      `Source excerpt for genre fidelity: ${contentSource.text.slice(0, 2500)}`,
      "Do not modernize the character. Do not invent a business suit, blazer, necktie, office-worker outfit, school uniform, or contemporary street fashion unless explicitly required by the source.",
      "Create a single clean front-facing character reference sheet. Plain background. No speech bubbles. No text labels."
    ].filter(Boolean).join("\n");

    setGeneratingCharacterImageIds((prev) => ({ ...prev, [id]: true }));
    setSystemError(null);
    try {
      const candidates = await generateCharacterCandidates(description, imageSize, 1, {
        identityReferenceImages: sourceIdentityRefs.length > 0 ? sourceIdentityRefs : currentRefs
      });
      const imageUrl = candidates[0]?.preview_url || "";
      if (!imageUrl.startsWith("data:")) {
        throw new Error(ui("캐릭터 이미지를 생성하지 못했어.", "Could not generate the character image."));
      }
      const compressed = await compressReferenceDataUrl(imageUrl);
      setCharacterReferenceErrors((prev) => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setCast((prev) =>
        prev.map((c) => (c.id === id ? {
          ...c,
          reference_images: [
            ...(c.reference_images || []).filter(Boolean).slice(0, MAX_REF_IMAGES_PER_CHARACTER - 1),
            compressed
          ],
          style_aligned_reference_images: [compressed],
          style_aligned_reference_style_key: selectedStyleKey
        } : c))
      );
      setCharacterConsistencyMode("strict");
    } catch (e: any) {
      setSystemError(e?.message || ui("AI 캐릭터 이미지 생성에 실패했어.", "AI character image generation failed."));
    } finally {
      setGeneratingCharacterImageIds((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const styleReferenceImageForCharacter = async (id: string) => {
    if (stylingCharacterImageIds[id]) return;
    if (!hasApiKey) {
      const message = ui("그림체 변환에는 로컬 서버와 Codex 로그인이 필요해.", "Style conversion requires the local server and Codex login.");
      setCharacterReferenceErrors((prev) => ({ ...prev, [id]: message }));
      setSystemError(message);
      return;
    }

    const target = cast.find((c) => c.id === id);
    if (!target) return;
    const refs = (target.reference_images || []).filter(Boolean);
    if (refs.length === 0) {
      const message = ui("먼저 캐릭터 레퍼런스 이미지를 추가해줘.", "Add a character reference image first.");
      setCharacterReferenceErrors((prev) => ({ ...prev, [id]: message }));
      return;
    }

    const style = getCurrentReferenceStyle();
    const styleKey = buildStyleReferenceKey(style);
    setStylingCharacterImageIds((prev) => ({ ...prev, [id]: true }));
    setCharacterReferenceErrors((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSystemError(null);

    try {
      const generated = await generateStyleAlignedCharacterReference({
        characterName: target.name,
        identityProfile: target.analyzed_appearance,
        manualAppearance: target.appearance,
        stylePrompt: style.style_prompt,
        userStylePrompt: style.user_style_prompt,
        imageSize,
        identityReferenceImages: refs
      });
      if (!generated) {
        throw new Error(ui("현재 그림체 변환 결과가 비어 있어.", "The style conversion returned no image."));
      }

      const compressed = await compressReferenceDataUrl(generated);
      setCast((prev) =>
        prev.map((c) => (c.id === id ? {
          ...c,
          style_aligned_reference_images: [compressed],
          style_aligned_reference_style_key: styleKey
        } : c))
      );
      setCharacterConsistencyMode("strict");
    } catch (e: any) {
      const message = e?.message || ui("현재 그림체 변환에 실패했어.", "Style conversion failed.");
      setCharacterReferenceErrors((prev) => ({ ...prev, [id]: message }));
    } finally {
      setStylingCharacterImageIds((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const renderCharacterReferenceControls = (
    c: CharacterSpec,
    options: {
      inputId: string;
      displayName: string;
      altFallback: string;
      panelClassName: string;
      titleClassName: string;
      countClassName: string;
      uploadDisabled?: boolean;
      compact?: boolean;
    }
  ) => {
    const refs = (c.reference_images || []).filter(Boolean);
    const currentStyleKey = buildStyleReferenceKey(getCurrentReferenceStyle());
    const currentStyleAlignedRefs = c.style_aligned_reference_style_key === currentStyleKey
      ? (c.style_aligned_reference_images || []).filter(Boolean)
      : [];
    const refSet = new Set(refs);
    const detachedStyleAlignedRefs = currentStyleAlignedRefs.filter((url) => !refSet.has(url));
    const hasCurrentStyleAlignedRef = currentStyleAlignedRefs.length > 0;
    const hasAnyStyleAlignedRef = (c.style_aligned_reference_images || []).filter(Boolean).length > 0;
    const isGenerating = Boolean(generatingCharacterImageIds[c.id]);
    const isStyling = Boolean(stylingCharacterImageIds[c.id]);
    const uploadDisabled = Boolean(options.uploadDisabled);
    const buttonTextSize = options.compact ? "text-[10px]" : "text-[10px] md:text-xs";
    const iconSize = options.compact ? 12 : 14;
    const thumbnailIconSize = options.compact ? 10 : 12;

    return (
      <div className={options.panelClassName}>
        <div className="flex items-center justify-between gap-3">
          <p className={options.titleClassName}>{ui("레퍼런스 사진", "Reference Photos")}</p>
          <p className={options.countClassName}>{refs.length}/{MAX_REF_IMAGES_PER_CHARACTER}</p>
        </div>

        <input
          type="file"
          accept="image/*"
          multiple
          id={options.inputId}
          className="hidden"
          disabled={uploadDisabled}
          onChange={(e) => {
            void addReferenceImages(c.id, e.target.files);
            e.currentTarget.value = "";
          }}
        />
        <div className="mt-2 flex flex-wrap gap-2">
          <label
            htmlFor={options.inputId}
            className={`inline-flex items-center justify-center gap-2 px-4 py-2 font-black border-2 border-black ${buttonTextSize} ${uploadDisabled ? "bg-slate-200 text-slate-400 cursor-not-allowed" : "bg-black text-white cursor-pointer hover:bg-blue-600 transition-colors"}`}
          >
            <Upload size={iconSize} /> {ui("사진 추가", "Add Photos")}
          </label>
          <button
            type="button"
            onClick={() => void generateReferenceImageForCharacter(c.id)}
            disabled={isGenerating || uploadDisabled}
            className={`inline-flex items-center justify-center gap-2 border-2 border-black bg-white px-4 py-2 font-black hover:bg-yellow-50 transition-colors ${buttonTextSize} disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {isGenerating ? <Loader2 size={iconSize} className="animate-spin" /> : <Wand2 size={iconSize} />}
            {ui("AI 이미지", "AI Image")}
          </button>
          <button
            type="button"
            onClick={() => void styleReferenceImageForCharacter(c.id)}
            disabled={refs.length === 0 || isStyling || uploadDisabled}
            className={`inline-flex items-center justify-center gap-2 border-2 border-black bg-white px-4 py-2 font-black hover:bg-blue-50 transition-colors ${buttonTextSize} disabled:opacity-50 disabled:cursor-not-allowed`}
            title={ui("업로드한 레퍼런스를 현재 선택한 그림체로 변환", "Convert uploaded references to the selected style")}
          >
            {isStyling ? <Loader2 size={iconSize} className="animate-spin" /> : <Palette size={iconSize} />}
            {hasCurrentStyleAlignedRef
              ? ui("현재 그림체 다시", "Restyle")
              : hasAnyStyleAlignedRef
                ? ui("현재 그림체로 다시", "Restyle Current")
                : ui("현재 그림체로 다듬기", "Style Match")}
          </button>
        </div>

        {hasCurrentStyleAlignedRef ? (
          <p className="mt-2 text-[10px] font-black text-blue-700">{ui("현재 그림체 변환본을 최종 생성에 우선 사용", "Current-style reference is prioritized for final generation")}</p>
        ) : null}
        {characterReferenceErrors[c.id] ? (
          <p className="mt-2 text-[10px] font-bold text-red-600">{characterReferenceErrors[c.id]}</p>
        ) : null}

        {refs.length > 0 ? (
          <div className="mt-3 grid grid-cols-4 gap-2">
            {refs.map((url, idx) => {
              const isCurrentStyleRef = currentStyleAlignedRefs.includes(url);
              return (
                <div key={`${c.id}_${options.inputId}_${idx}`} className="relative border-2 border-black bg-white overflow-hidden aspect-square">
                  <img src={url} alt={`${options.displayName || options.altFallback} ref ${idx + 1}`} className="w-full h-full object-cover" />
                  {isCurrentStyleRef ? (
                    <span className="absolute bottom-1 left-1 right-1 bg-blue-600 text-white text-[8px] font-black text-center px-1 py-0.5">
                      {ui("현재 그림체", "Styled")}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => downloadReferenceImage(url, c, idx)}
                    className="absolute top-1 left-1 bg-white border-2 border-black p-1 hover:bg-blue-50"
                    title={ui("다운로드", "Download")}
                  >
                    <Download size={thumbnailIconSize} />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeReferenceImage(c.id, idx)}
                    disabled={uploadDisabled}
                    className={`absolute top-1 right-1 border-2 border-black p-1 ${uploadDisabled ? "bg-slate-200 text-slate-400 cursor-not-allowed" : "bg-white hover:bg-slate-100"}`}
                    title={ui("삭제", "Remove")}
                  >
                    <Trash2 size={thumbnailIconSize} />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}

        {detachedStyleAlignedRefs.length > 0 ? (
          <div className="mt-3">
            <p className="mb-2 text-[10px] font-black text-blue-700">{ui("변환된 레퍼런스", "Styled Reference")}</p>
            <div className="grid grid-cols-4 gap-2">
              {detachedStyleAlignedRefs.map((url, idx) => (
                <div key={`${c.id}_${options.inputId}_styled_${idx}`} className="relative border-2 border-blue-600 bg-white overflow-hidden aspect-square">
                  <img src={url} alt={`${options.displayName || options.altFallback} styled reference ${idx + 1}`} className="w-full h-full object-cover" />
                  <span className="absolute bottom-1 left-1 right-1 bg-blue-600 text-white text-[8px] font-black text-center px-1 py-0.5">
                    {ui("현재 그림체", "Styled")}
                  </span>
                  <button
                    type="button"
                    onClick={() => downloadReferenceImage(url, c, idx)}
                    className="absolute top-1 left-1 bg-white border-2 border-black p-1 hover:bg-blue-50"
                    title={ui("다운로드", "Download")}
                  >
                    <Download size={thumbnailIconSize} />
                  </button>
                  <button
                    type="button"
                    onClick={() => clearStyleAlignedReference(c.id)}
                    disabled={uploadDisabled}
                    className={`absolute top-1 right-1 border-2 border-black p-1 ${uploadDisabled ? "bg-slate-200 text-slate-400 cursor-not-allowed" : "bg-white hover:bg-slate-100"}`}
                    title={ui("삭제", "Remove")}
                  >
                    <Trash2 size={thumbnailIconSize} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  const buildCastPresetPayload = (): CastPresetPayload => {
    return {
      narrativeRole,
      cast: cast.map((c) => ({
        role: c.role,
        name: String(c.name ?? ""),
        appearance: String(c.appearance ?? ""),
        persona: typeof c.persona === "string" ? c.persona : "",
        catchphrase: typeof c.catchphrase === "string" ? c.catchphrase : "",
        catchphrase_frequency: (c.catchphrase_frequency || "rare") as CatchphraseFrequency
      }))
    };
  };

  const suggestCastPresetLabel = (): string => {
    const protos = cast
      .filter((c) => c.role === "protagonist")
      .map((c) => String(c.name || "").trim())
      .filter(Boolean)
      .slice(0, 2);
    const supportingCount = cast.filter((c) => c.role === "supporting").length;
    const base = protos.length > 0 ? protos.join("+") : "캐스트";
    return supportingCount > 0 ? `${base}+조연${supportingCount}` : base;
  };

  const saveCastPreset = (labelInput?: string) => {
    const label = String(labelInput || "").trim() || suggestCastPresetLabel();
    if (!label) {
      setSystemError(ui("프리셋 이름을 입력해줘.", "Enter a preset name."));
      return;
    }

    const now = Date.now();
    const payload = buildCastPresetPayload();

    setCastPresets((prev) => {
      const existing = prev.find((p) => p.label === label);
      const nextPreset: CastPreset = existing
        ? { ...existing, updated_at: now, payload }
        : { id: createClientId(), label, created_at: now, updated_at: now, payload };

      const withoutExisting = prev.filter((p) => p.id !== nextPreset.id);
      const next = [nextPreset, ...withoutExisting].slice(0, 30);
      setSelectedCastPresetId(nextPreset.id);
      setSystemError(null);
      setCastSuggestionNotice(null);
      return next;
    });
  };

  const promptSaveCastPreset = () => {
    const suggested = suggestCastPresetLabel();
    const entered = window.prompt(ui("프리셋 이름(저장 라벨)", "Preset name (save label)"), suggested);
    if (entered === null) return;
    saveCastPreset(entered);
  };

  const applyCastPreset = (presetId: string) => {
    const preset = castPresets.find((p) => p.id === presetId);
    if (!preset) return;

    const nextNarrativeRole: NarrativeRole =
      preset.payload.narrativeRole === "actor" ? "actor" : "narrator";
    setNarrativeRole(nextNarrativeRole);

    const mapped = (preset.payload.cast || []).map((c) => ({
      id: createClientId(),
      role: c.role,
      name: String(c.name || (c.role === "protagonist" ? "주인공" : "")),
      appearance: String(c.appearance || ""),
      persona: String(c.persona || ""),
      catchphrase: String(c.catchphrase || ""),
      catchphrase_frequency: (c.catchphrase_frequency || "rare") as CatchphraseFrequency,
      reference_images: []
    }));

    const protagonists = mapped.filter((c) => c.role === "protagonist").slice(0, 2);
    const supporting = mapped.filter((c) => c.role === "supporting");
    const nextCast = protagonists.length > 0 ? [...protagonists, ...supporting] : [createCharacter("protagonist"), ...supporting];
    setCast(nextCast);
    setSystemError(null);
    setCastSuggestionNotice(null);
  };

  const applyCastPresetToSection = (presetId: string, role: CastRole) => {
    const preset = castPresets.find((p) => p.id === presetId);
    if (!preset) return;

    if (role === "protagonist") {
      const nextNarrativeRole: NarrativeRole =
        preset.payload.narrativeRole === "actor" ? "actor" : "narrator";
      setNarrativeRole(nextNarrativeRole);
    }

    const mapped = (preset.payload.cast || []).map((c) => ({
      id: createClientId(),
      role: c.role,
      name: String(c.name || (c.role === "protagonist" ? "주인공" : "")),
      appearance: String(c.appearance || ""),
      persona: String(c.persona || ""),
      catchphrase: String(c.catchphrase || ""),
      catchphrase_frequency: (c.catchphrase_frequency || "rare") as CatchphraseFrequency,
      reference_images: []
    }));

    if (role === "protagonist") {
      const nextProtagonists = mapped.filter((c) => c.role === "protagonist").slice(0, 2);
      if (nextProtagonists.length === 0) {
        const message = ui("이 프리셋에는 주연 캐릭터가 없어.", "This preset has no lead character.");
        setSystemError(message);
        setCastSuggestionNotice({ kind: "error", message });
        return;
      }
      const existingSupporting = cast.filter((c) => c.role === "supporting");
      setCast([...nextProtagonists, ...existingSupporting]);
      setSystemError(null);
      setCastSuggestionNotice(null);
      return;
    }

    const existingProtagonists = cast.filter((c) => c.role === "protagonist").slice(0, 2);
    if (existingProtagonists.length === 0) {
      const message = ui("주연(주인공)은 최소 1명은 있어야 해.", "You need at least 1 lead character.");
      setSystemError(message);
      setCastSuggestionNotice({ kind: "error", message });
      return;
    }
    const nextSupporting = mapped.filter((c) => c.role === "supporting");
    setCast([...existingProtagonists, ...nextSupporting]);
    setSystemError(null);
    setCastSuggestionNotice(null);
  };

  const deleteCastPreset = (presetId: string) => {
    const preset = castPresets.find((p) => p.id === presetId);
    if (!preset) return;
    if (!window.confirm(ui(`"${preset.label}" 프리셋을 삭제할까요?`, `Delete preset "${preset.label}"?`))) return;
    setCastPresets((prev) => prev.filter((p) => p.id !== presetId));
    setSelectedCastPresetId((prev) => (prev === presetId ? "" : prev));
  };

  const clearResearchDigest = () => {
    setResearchDigestText("");
    setResearchDigestSources([]);
    setResearchDigestWarnings([]);
    setResearchDigestError(null);
    setPageSuggestions(null);
  };

  const handleResearchFileChange = async (file: File | null) => {
    clearResearchDigest();

    if (!file) {
      setResearchReportFile(null);
      return;
    }

    if (!isTextLikeMaterialFile(file) && !isPdfMaterialFile(file)) {
      setResearchReportFile(null);
      setResearchDigestError(ui("PDF, TXT, MD, JSON 파일만 지원해. 다른 문서는 내용을 복사해서 직접 입력에 붙여넣어줘.", "Only PDF, TXT, MD, and JSON files are supported. Paste other document text manually."));
      return;
    }

    setResearchReportFile(file);

    if (isTextLikeMaterialFile(file)) {
      try {
        const text = await file.text();
        setResearchReportText(text);
      } catch (e) {
        console.warn("Failed to read research file as text", e);
      }
    }
  };

  const handleQuickSourceFilesChange = async (fileList: FileList | File[] | null) => {
    clearResearchDigest();
    const files = Array.from(fileList || []);
    const supported = files.filter((file) => isTextLikeMaterialFile(file) || isPdfMaterialFile(file));
    if (files.length > 0 && supported.length !== files.length) {
      setResearchDigestError(ui("PDF, TXT, MD, JSON 파일만 큐에 넣을 수 있어. 지원하지 않는 파일은 제외했어.", "Only PDF, TXT, MD, and JSON files can be queued. Unsupported files were skipped."));
    }
    setQuickPipelineSourceFiles(supported);
    setQuickPipelineSourceJobs(supported.map((file) => ({
      id: createClientId(),
      file,
      topic: "",
      publicationFormat: quickPipelinePublicationFormat
    })));
    const first = supported[0] || null;
    setResearchReportFile(first);
    if (!first) return;
    if (isTextLikeMaterialFile(first)) {
      try {
        setResearchReportText(await first.text());
      } catch (e) {
        console.warn("Failed to read first quick source file as text", e);
      }
    }
  };

  const suggestPagesFromNarrative = async (narrativeText: string, subject: string) => {
    const trimmed = narrativeText.trim();
    if (!trimmed) return null;
    try {
      const { suggestNarrativePageCounts } = await loadPageSuggestionService();
      return await suggestNarrativePageCounts({
        narrative_text: trimmed,
        subject
      });
    } catch (e) {
      console.warn("Failed to suggest page counts from narrative", e);
      return null;
    }
  };

  const handleRunQuickPipelineFileBatch = async (sourceFiles: File[]) => {
    if (isQuickPipelineRunning || sourceFiles.length === 0) return;
    const batchRunId = `quick_batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const startedAt = Date.now();
    const sourceJobs = sourceFiles.map((file, index) => {
      const existing = quickPipelineSourceJobs[index];
      return existing?.file === file
        ? existing
        : {
          id: createClientId(),
          file,
          topic: "",
          publicationFormat: quickPipelinePublicationFormat
        };
    });
    const runImagesFullyParallel = quickPipelineParallelAll;
    const sharedManualText = researchReportText.trim();
    const queueRuns: QuickPipelineQueueRun[] = sourceJobs.map((job, index) => ({
      id: `${batchRunId}_file${index + 1}`,
      label: `${index + 1}큐`,
      stage: "idle",
      status: index === 0 ? "running" : "pending",
      message: job.file.name,
      startedAt,
      totalPages: 0,
      completedPages: 0,
      failedPages: 0
    }));

    const logBatch = async (
      queue: QuickPipelineQueueRun,
      stage: QuickPipelineStage,
      statusValue: QuickPipelineLogStatus,
      attempt: number,
      message: string,
      extra: Partial<QuickPipelineRunLog> = {}
    ) => {
      await writeQuickPipelineLog({
        run_id: `${batchRunId}:${queue.label}:${sourceFiles[Number(queue.label.replace(/\D/g, "")) - 1]?.name || ""}`,
        stage,
        status: statusValue,
        attempt,
        message,
        elapsed_ms: Date.now() - startedAt,
        ...extra
      });
    };

    const saveBatchProject = (
      queue: QuickPipelineQueueRun,
      sourceFile: File,
      effectiveTopic: string,
      jobFormat: QuickPipelinePublicationFormat,
      jobStyle: SeriesSpec["anchors"]["style"],
      plan: SeriesPlan,
      queueCast: CharacterSpec[],
      results: GenerationResult[],
      errors: Record<number, string>
    ) => {
      const now = Date.now();
      const sortedResults = sortGenerationResults(results);
      const renderedAt = sortedResults.reduce<Record<number, number>>((acc, result) => {
        acc[result.page_index] = now;
        return acc;
      }, {});
      const renderedImageSize = sortedResults.reduce<Record<number, ImageSize>>((acc, result) => {
        acc[result.page_index] = "2K";
        return acc;
      }, {});
      const renderedEngineKey = sortedResults.reduce<Record<number, string>>((acc, result) => {
        acc[result.page_index] = buildImageEngineKey("codex", codexImageModel, DEFAULT_CODEX_IMAGE_QUALITY);
        return acc;
      }, {});
      const snapshot: SavedComicProjectSnapshot = {
        topic: effectiveTopic,
        questionType: LEARNING_QUESTION_TYPE,
        comicMode: LEARNING_COMIC_MODE,
        outputMode: toLegacyOutputMode(jobFormat),
        publicationFormat: jobFormat,
        mangaColorMode,
        i2vAspectRatio,
        toneMode: "normal",
        toneLevel: "medium",
        introStyle: LEARNING_INTRO_STYLE,
        language: "ko",
        audienceLevel: "beginner",
        deliveryStyleId: "standard",
        deliveryCustomInstruction: "",
        geminiReasoningEffort: "medium",
        layoutVariety: DEFAULT_LAYOUT_VARIETY,
        imageSize: "2K",
        imageProvider: "codex",
        codexImageQuality: DEFAULT_CODEX_IMAGE_QUALITY,
        scriptDetail: "normal",
        pageCountMode: "auto",
        targetPageCount: plan.pages.length,
        narrativeRole: LEARNING_NARRATIVE_ROLE,
        characterConsistencyMode: "strict",
        useCrossPageStyleConsistency: false,
        researchMode: "auto_digest",
        researchDigestText: plan.plan_meta?.research_digest || "",
        cast: compactCastForStorage(queueCast),
        productReferenceImages: pickPersistableImageUrls(productReferenceImages, MAX_PERSISTABLE_PRODUCT_REF_IMAGES),
        selectedPresetId,
        selectedStyleCategory,
        finalStyle: compactStyleForStorage(jobStyle),
        seriesPlan: compactSeriesPlanForStorage(plan),
        pageResults: sortedResults,
        pageErrors: errors,
        pageRenderedAt: renderedAt,
        pageRenderedImageSize: renderedImageSize,
        pageRenderedEngineKey: renderedEngineKey,
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
      const label = plan.series_spec?.series?.title || effectiveTopic || sourceFile.name.replace(/\.[^.]+$/, "");
      const project: SavedComicProject = {
        id: createClientId(),
        label,
        created_at: now,
        updated_at: now,
        last_opened_at: now,
        snapshot
      };
      setSavedProjects((prev) => [project, ...prev.filter((p) => p.id !== project.id)].slice(0, MAX_SAVED_PROJECTS));
      setActiveProjectId(project.id);
      setSelectedSavedProjectId(project.id);
    };

    const runBatchStage = async <T,>(
      queue: QuickPipelineQueueRun,
      stage: QuickPipelineStage,
      message: string,
      operation: (attempt: number) => Promise<T>
    ): Promise<T> => {
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          updateQuickQueueRun(queue.id, {
            stage,
            status: "running",
            message: attempt === 1 ? message : ui("재시도 중", "Retrying"),
            error: undefined
          });
          await logBatch(queue, stage, "started", attempt, message);
          const result = await operation(attempt);
          await logBatch(queue, stage, "success", attempt, ui("완료", "Done"));
          return result;
        } catch (e: any) {
          lastError = e;
          const errorMessage = toUserFacingError(e?.message, ui("자료 큐 단계 처리에 실패했어.", "Source queue stage failed."), uiLanguage);
          const retryable = attempt < 2;
          updateQuickQueueRun(queue.id, {
            stage,
            status: "running",
            message: retryable ? ui("오류 후 재시도 대기", "Waiting to retry after an error") : errorMessage,
            error: errorMessage
          });
          await logBatch(queue, stage, retryable ? "retrying" : "error", attempt, errorMessage, {
            request_id: e?.requestId,
            category: e?.category
          });
          if (retryable) await new Promise((resolve) => window.setTimeout(resolve, 1200));
        }
      }
      throw lastError instanceof Error ? lastError : new Error(ui("자료 큐 생성에 실패했어.", "Source queue generation failed."));
    };

    setIsQuickPipelineRunning(true);
    setSystemError(null);
    setQuickPipelineLogsOpen(true);
    setQuickPipelineQueueRuns(queueRuns);
    setSelectedQuickPipelineQueueId("");
    setQuickPipelineProgress({
      runId: batchRunId,
      stage: "digest",
      startedAt,
      stageStartedAt: startedAt,
      attempt: 1,
      message: ui(`${sourceFiles.length}개 자료 큐를 순서대로 시작했어.`, `Started ${sourceFiles.length} source queues in order.`)
    });

    try {
      enterSingleMode();
      setCreationType("educational");
      setComicMode(LEARNING_COMIC_MODE);
      setStatus(AppStatus.PLANNING);

      const completedRuns: QuickPipelineQueueRun[] = [];
      let sharedBatchCast: CharacterSpec[] | null = null;
      for (let i = 0; i < sourceJobs.length; i += 1) {
        const sourceJob = sourceJobs[i];
        const sourceFile = sourceJob.file;
        const queue = queueRuns[i];
        const jobFormat = sourceJob.publicationFormat;
        const isJobEpisodeSplitFormat = isQuickEpisodeSplitFormat(jobFormat);
        const jobUnitLabel = getQuickFormatUnitLabel(jobFormat, uiLanguage);
        const jobStyle: SeriesSpec["anchors"]["style"] = {
          ...selectStyle(stylePresets, selectedPresetId, "", { publicationFormat: jobFormat, mangaColorMode }),
          style_reference_image: styleReferenceImage
        };
        const sourceText = isTextLikeMaterialFile(sourceFile)
          ? await sourceFile.text()
          : sharedManualText;
        const effectiveTopic = sourceJob.topic.trim() || topic.trim() || deriveTopicFromMaterial(sourceText, sourceFile.name.replace(/\.[^.]+$/, "") || ui("업로드 자료", "Uploaded material"));
        setTopic(effectiveTopic);
        setPublicationFormat(jobFormat);
        setFinalStyle(jobStyle);
        setResearchReportFile(sourceFile);
        setResearchReportText(sourceText);
        setQuickStageProgress(
          batchRunId,
          "digest",
          1,
          ui(`${queue.label} 자료 정리 중`, `${queue.label} digesting source`),
          sourceFile.name,
          { totalPages: sourceFiles.length, completedPages: i, failedPages: 0 }
        );

        try {
          const digestResult = await runBatchStage(queue, "digest", ui("자료 핵심 정리 중", "Digesting source material"), async () => {
            const researchFileForUpload = isPdfMaterialFile(sourceFile) ? sourceFile : undefined;
            const result = await (await loadResearchService()).analyzeResearchReport({
              topic: effectiveTopic,
              report_text: sourceText,
              file: researchFileForUpload
            });
            const suggestionResult = await suggestPagesFromNarrative(result.notes, effectiveTopic);
            return {
              notes: result.notes,
              sources: "sources" in result && Array.isArray((result as any).sources) ? (result as any).sources as GroundingSource[] : [],
              warnings: "warnings" in result && Array.isArray(result.warnings) ? result.warnings : [],
              pageSuggestions: suggestionResult?.page_suggestions || null
            };
          });
          const suggestedNormal = digestResult.pageSuggestions?.normal;
          const sourceLengthForUnits = Math.max(sourceText.length, digestResult.notes.length);
          const lengthBasedUnitCount = isJobEpisodeSplitFormat
            ? sourceLengthForUnits >= 24000 ? 36 :
              sourceLengthForUnits >= 12000 ? 24 :
              sourceLengthForUnits >= 6000 ? 18 :
              sourceLengthForUnits >= 2500 ? 12 :
              4
            : sourceLengthForUnits >= 24000 ? 12 :
              sourceLengthForUnits >= 12000 ? 10 :
              sourceLengthForUnits >= 6000 ? 8 :
              sourceLengthForUnits >= 2500 ? 6 :
              4;
          const rawUnitCount = pageCountMode === "manual"
            ? targetPageCount
            : Math.max(typeof suggestedNormal === "number" ? suggestedNormal : 0, lengthBasedUnitCount);
          const effectivePageCount = isJobEpisodeSplitFormat
            ? clampQuickStripCount(rawUnitCount)
            : clampPageCount(Math.min(12, rawUnitCount));
          setResearchDigestText(digestResult.notes);
          setResearchDigestSources(digestResult.sources);
          setResearchDigestWarnings(digestResult.warnings);
          setPageSuggestions(digestResult.pageSuggestions);
          setTargetPageCount(effectivePageCount);

          let queueCast: CharacterSpec[];
          if (sharedBatchCast?.length) {
            queueCast = cloneCastForQuickReuse(sharedBatchCast);
            updateQuickQueueRun(queue.id, {
              stage: "cast",
              status: "running",
              message: ui("1큐 캐릭터 고정 적용 중", "Applying locked queue-1 cast"),
              cast: queueCast
            });
            await logBatch(queue, "cast", "info", 1, ui("첫 성공 큐의 캐릭터를 그대로 재사용했어.", "Reused the first successful queue cast."));
          } else {
            queueCast = await runBatchStage(queue, "cast", ui("캐릭터 자동 제안 중", "Suggesting characters"), async () => {
              const suggestions = await suggestCastFromContent({
                source_text: digestResult.notes,
                creation_type: "educational",
                publication_format: jobFormat,
                audience_level: "beginner",
                source_label: `${sourceFile.name} · ${queue.label}`,
                existing_cast: [createCharacter("protagonist")],
                selected_style: {
                  preset_id: jobStyle.preset_id,
                  preset_label: jobStyle.preset_label,
                  render_mode: jobStyle.render_mode,
                  style_prompt: jobStyle.style_prompt,
                  user_style_prompt: jobStyle.user_style_prompt
                }
              });
              const mapped = suggestions.map((c) => ({
                ...createCharacter(c.role, c.name),
                appearance: c.appearance || c.visual_prompt,
                persona: [c.persona, c.story_function].filter(Boolean).join("\n"),
                catchphrase: c.catchphrase || "",
                catchphrase_frequency: "rare" as CatchphraseFrequency,
                reference_images: []
              }));
              const protagonists = mapped.filter((c) => c.role === "protagonist").slice(0, 2);
              const supporting = mapped.filter((c) => c.role === "supporting");
              return protagonists.length > 0 ? [...protagonists, ...supporting] : [createCharacter("protagonist"), ...supporting];
            });
            sharedBatchCast = cloneCastForQuickReuse(queueCast);
            await logBatch(queue, "cast", "info", 1, ui("이 캐릭터 세트를 이후 자료 큐에 고정했어.", "Locked this cast for following source queues."));
          }
          setCast(queueCast);
          updateQuickQueueRun(queue.id, { cast: queueCast });

          const plan = await runBatchStage(queue, "plan", jobFormat === "instatoon" ? ui("인스타툰 카드 콘티 생성 중", "Generating instatoon card plan") : jobFormat === "webtoon" ? ui("웹툰 콘티 생성 중", "Generating webtoon plan") : ui("학습만화 콘티 생성 중", "Generating learning comic plan"), async () => {
            const templatesForPlan = getTemplatesForFormat(jobFormat, templates);
            if (templatesForPlan.length === 0) throw new Error(ui("레이아웃 템플릿을 찾지 못했어.", "Could not find layout templates."));
            const primary = queueCast.find((c) => c.role === "protagonist") || queueCast[0] || createCharacter("protagonist");
            const primaryAppearance = String(primary.analyzed_appearance || primary.appearance || primary.name || "A friendly guide character").trim();
            const primaryRefs = Array.isArray(primary.reference_images) ? primary.reference_images.filter(Boolean) : [];
            const supportingSummary = queueCast
              .filter((c) => c.role === "supporting")
              .map(buildCastSummaryLine)
              .map((s) => s.trim())
              .filter(Boolean)
              .join("\n");
            const generatedPlan = await (await loadPlannerService()).generatePlan({
              topic: effectiveTopic,
              question_type: LEARNING_QUESTION_TYPE,
              comic_mode: LEARNING_COMIC_MODE,
              output_mode: "comic",
              publication_format: jobFormat,
              manga_color_mode: mangaColorMode,
              i2v_aspect_ratio: i2vAspectRatio,
              tone_mode: "normal",
              tone_level: "medium",
              intro_style: LEARNING_INTRO_STYLE,
              detail_level: "normal",
              language: "ko",
              audience_level: "beginner",
              character_consistency_mode: "strict",
              delivery_style: resolveDeliveryStyleSpec({
                preset_id: "standard",
                custom_instruction: "",
                audience_level: "beginner",
                comic_mode: LEARNING_COMIC_MODE
              }),
              layout_variety: DEFAULT_LAYOUT_VARIETY,
              image_size: "2K",
              page_count: effectivePageCount,
              character_description: primaryAppearance,
              character_role: LEARNING_NARRATIVE_ROLE,
              character_refs: { main: primaryRefs[0] || "", pack: primaryRefs },
              product:
                productReferenceImages.length > 0
                  ? { label: effectiveTopic, reference_images: productReferenceImages.filter(Boolean) }
                  : undefined,
              supporting_cast: supportingSummary || undefined,
              cast: queueCast,
              style: jobStyle,
              templates: templatesForPlan,
              gemini_reasoning_effort: "medium",
              research: {
                mode: "auto_digest",
                pack: {
                  notes: digestResult.notes,
                  sources: digestResult.sources,
                  page_suggestions: digestResult.pageSuggestions || undefined
                }
              }
            });
            const withMeta: SeriesPlan = {
              ...applyQuickEpisodeSplitForFormat(generatedPlan, jobFormat, quickPipelineUnitsPerEpisode),
              plan_meta: {
                ...generatedPlan.plan_meta,
                research_digest: digestResult.notes,
                source_file_name: sourceFile.name,
                batch_queue_index: i + 1,
                batch_queue_total: sourceFiles.length
              }
            };
            return withMeta;
          });

          setSeriesPlan(plan);
          setPageResults([]);
          setPageErrors({});
          setWebtoonEpisodeResult(null);
          setPageRenderedAt({});
          setPageRenderedImageSize({});
          setPageRenderedEngineKey({});
          setStatus(AppStatus.GENERATING_PANELS);

          const results: GenerationResult[] = [];
          const errors: Record<number, string> = {};
          const pages = plan.pages || [];
          let cursor = 0;
          const workerCount = runImagesFullyParallel ? pages.length : Math.min(MAX_PARALLEL_PAGE_GENERATIONS, pages.length);
          updateQuickQueueRun(queue.id, {
            stage: "images",
            status: "running",
            message: ui("이미지 생성 중", "Generating images"),
            totalPages: pages.length,
            completedPages: 0,
            failedPages: 0,
            plan
          });
          setQuickStageProgress(batchRunId, "images", 1, ui(`${queue.label} 이미지 생성 중`, `${queue.label} generating images`), sourceFile.name, {
            totalPages: pages.length,
            completedPages: 0,
            failedPages: 0
          });

          const generateBatchPage = async (page: PageSpec, attempt: number): Promise<boolean> => {
            const pageIndex = page.page.index;
            try {
              const pageImageUrl = await (await loadRendererService()).generateFullPageImage(plan.series_spec, page, "2K", LEARNING_COMIC_MODE, {
                styleConsistencyImage: null,
                imageProvider: "codex",
                codexImageQuality: DEFAULT_CODEX_IMAGE_QUALITY,
                codexImageModel
              });
              const nextResult = { page_index: pageIndex, composed_image_url: pageImageUrl };
              results.splice(0, results.length, ...upsertGenerationResult(results, nextResult));
              delete errors[pageIndex];
              setPageResults((prev) => upsertGenerationResult(prev, nextResult));
              setPageRenderedAt((prev) => ({ ...prev, [pageIndex]: Date.now() }));
              setPageRenderedImageSize((prev) => ({ ...prev, [pageIndex]: "2K" }));
              setPageRenderedEngineKey((prev) => ({ ...prev, [pageIndex]: buildImageEngineKey("codex", codexImageModel, DEFAULT_CODEX_IMAGE_QUALITY) }));
              updateQuickQueueRun(queue.id, {
                stage: "images",
                status: "running",
                message: `${results.length}/${pages.length}`,
                completedPages: results.length,
                failedPages: Object.keys(errors).length,
                pageResults: [...results],
                pageErrors: { ...errors }
              });
              await logBatch(queue, "images", "success", attempt, `${jobUnitLabel} ${pageIndex}`, { page_index: pageIndex });
              return true;
            } catch (e: any) {
              const message = toUserFacingError(e?.message, ui("페이지 생성에 실패했어.", "Page generation failed."), uiLanguage);
              await logBatch(queue, "images", attempt < 2 ? "retrying" : "error", attempt, message, {
                page_index: pageIndex,
                request_id: e?.requestId,
                category: e?.category
              });
              if (attempt >= 2) {
                errors[pageIndex] = message;
                setPageErrors((prev) => ({ ...prev, [pageIndex]: message }));
              }
              return false;
            }
          };

          const workers = Array.from({ length: workerCount }, async () => {
            while (cursor < pages.length) {
              const page = pages[cursor++];
              let ok = await generateBatchPage(page, 1);
              if (!ok) ok = await generateBatchPage(page, 2);
            }
          });
          await runBatchStage(queue, "images", ui("최종 이미지 생성 중", "Generating final images"), async () => {
            await Promise.all(workers);
            if (Object.keys(errors).length > 0) {
              throw new Error(ui(`이미지 ${Object.keys(errors).length}장이 실패했어.`, `${Object.keys(errors).length} image(s) failed.`));
            }
          });

          const completedRun: QuickPipelineQueueRun = {
            ...queue,
            stage: "complete",
            status: "success",
            message: sourceFile.name,
            completedAt: Date.now(),
            totalPages: pages.length,
            completedPages: results.length,
            failedPages: Object.keys(errors).length,
            cast: queueCast,
            plan,
            pageResults: [...results],
            pageErrors: { ...errors }
          };
          updateQuickQueueRun(queue.id, completedRun);
          completedRuns.push(completedRun);
          saveBatchProject(queue, sourceFile, effectiveTopic, jobFormat, jobStyle, plan, queueCast, results, errors);
          loadQuickPipelineQueueResult(completedRun);
          setQuickStageProgress(batchRunId, "complete", 1, ui(`${i + 1}/${sourceFiles.length}개 자료 큐 완료`, `${i + 1}/${sourceFiles.length} source queues complete`), sourceFile.name, {
            totalPages: sourceFiles.length,
            completedPages: i + 1,
            failedPages: 0
          });
        } catch (e: any) {
          const message = toUserFacingError(e?.message, ui("자료 큐 생성에 실패했어.", "Source queue generation failed."), uiLanguage);
          updateQuickQueueRun(queue.id, {
            stage: "error",
            status: "error",
            message,
            error: message,
            completedAt: Date.now()
          });
          await logBatch(queue, "error", "error", 1, message, {
            request_id: e?.requestId,
            category: e?.category
          });
        }
      }

      if (completedRuns.length === 0) {
        throw new Error(ui("모든 자료 큐가 실패했어.", "All source queues failed."));
      }
      setStatus(AppStatus.READY_TO_GENERATE);
      setSystemError(null);
      setQuickStageProgress(batchRunId, "complete", 1, ui(`${completedRuns.length}/${sourceFiles.length}개 자료 큐 완료`, `${completedRuns.length}/${sourceFiles.length} source queues complete`), ui("각 결과는 저장된 프로젝트에서 다시 불러올 수 있어.", "Each result can be loaded again from saved projects."), {
        totalPages: sourceFiles.length,
        completedPages: completedRuns.length,
        failedPages: sourceFiles.length - completedRuns.length
      });
    } catch (e: any) {
      const message = toUserFacingError(e?.message, ui("자료 큐 생성에 실패했어.", "Source queue generation failed."), uiLanguage);
      setSystemError(message);
      setQuickStageProgress(batchRunId, "error", 1, ui("자료 큐 생성 실패", "Source queue generation failed"), message);
      setStatus(AppStatus.ERROR);
    } finally {
      setIsQuickPipelineRunning(false);
      setGenerationPhaseMessage(null);
      void refreshQuickPipelineLogs();
    }
  };

  const handleAnalyzeResearch = async () => {
    if (isResearchAnalyzing) return;
    const materialText = researchReportText.trim();
    const effectiveTopic = topic.trim() || deriveTopicFromMaterial(
      materialText,
      researchReportFile?.name || ui("업로드 자료", "Uploaded material")
    );
    if (!effectiveTopic.trim()) return;
    if (!topic.trim()) setTopic(effectiveTopic);

    setIsResearchAnalyzing(true);
    setResearchDigestError(null);
    setResearchDigestWarnings([]);
    setPageSuggestions(null);

    try {
      const hasUserMaterial = Boolean(researchReportText.trim() || researchReportFile);
      const researchFileForUpload =
        researchReportFile && isPdfMaterialFile(researchReportFile)
          ? researchReportFile
          : undefined;
      const result = hasUserMaterial
        ? await (await loadResearchService()).analyzeResearchReport({
          topic: effectiveTopic,
          report_text: researchReportText,
          file: researchFileForUpload
        })
        : await (await loadGeminiResearchService()).generateGeminiResearchPack({
          topic: effectiveTopic,
          reasoning_effort: geminiReasoningEffort
        });
      setResearchDigestText(result.notes);
      setResearchDigestSources("sources" in result && Array.isArray(result.sources) ? result.sources : []);
      setResearchDigestWarnings("warnings" in result && Array.isArray(result.warnings) ? result.warnings : []);
      const suggestionResult = await suggestPagesFromNarrative(result.notes, effectiveTopic);
      const suggestions = suggestionResult?.page_suggestions || null;
      setPageSuggestions(suggestions);
      if (pageCountMode === "auto" && suggestions) {
        const suggested = suggestions[scriptDetail];
        if (typeof suggested === "number") setTargetPageCount(clampPageCount(suggested));
      }
    } catch (e: any) {
      setResearchDigestError(e?.message || ui("리서치 분석에 실패했어.", "Research analysis failed."));
    } finally {
      setIsResearchAnalyzing(false);
    }
  };

  const handleRunQuickPipeline = async () => {
    if (isQuickPipelineRunning) return;
    if (!hasApiKey) {
      setSystemError(ui("간편 생성에는 로컬 서버와 Codex 로그인이 필요해. `npm run dev`와 `npx @openai/codex login`을 확인해줘.", "Quick generation requires the local server and Codex login. Check `npm run dev` and `npx @openai/codex login`."));
      return;
    }
    if (quickPipelineSourceJobs.length > 0) {
      await handleRunQuickPipelineFileBatch(quickPipelineSourceJobs.map((job) => job.file));
      return;
    }
    const materialText = researchReportText.trim();
    const effectiveTopic = topic.trim() || deriveTopicFromMaterial(
      materialText,
      researchReportFile?.name || ui("업로드 자료", "Uploaded material")
    );
    if (!effectiveTopic.trim()) {
      setSystemError(ui("먼저 주제나 자료를 넣어줘.", "Add a topic or source material first."));
      return;
    }

    const runId = `quick_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const startedAt = Date.now();
    quickPipelineRunIdRef.current = runId;
    generationRunIdRef.current += 1;
    const generationRunId = generationRunIdRef.current;
    const quickFormat = quickPipelinePublicationFormat;
    const isQuickWebtoon = quickFormat === "webtoon";
    const isQuickInstatoon = quickFormat === "instatoon";
    const isQuickEpisodeSplit = isQuickEpisodeSplitFormat(quickFormat);
    const requestedQueueCount = Math.max(1, Math.min(QUICK_PIPELINE_MAX_QUEUE_COUNT, quickPipelineQueueCount));

    const quickStyle: SeriesSpec["anchors"]["style"] = {
      ...selectStyle(stylePresets, selectedPresetId, "", { publicationFormat: quickFormat, mangaColorMode }),
      style_reference_image: styleReferenceImage
    };
    const quickUnitLabel = getQuickFormatUnitLabel(quickFormat, uiLanguage);
    const runImagesFullyParallel = quickPipelineParallelAll;

    const logStage = async (
      stage: QuickPipelineStage,
      status: QuickPipelineLogStatus,
      attempt: number,
      message: string,
      extra: Partial<QuickPipelineRunLog> = {}
    ) => {
      await writeQuickPipelineLog({
        run_id: runId,
        stage,
        status,
        attempt,
        message,
        elapsed_ms: Date.now() - startedAt,
        ...extra
      });
    };

    async function runQuickStage<T>(
      stage: QuickPipelineStage,
      message: string,
      detail: string | undefined,
      operation: (attempt: number) => Promise<T>
    ): Promise<T> {
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (Date.now() - startedAt > QUICK_PIPELINE_TIMEOUT_MS && attempt === 1) {
          lastError = new Error(ui("간편 생성이 30분을 넘어 현재 단계를 다시 시작했어.", "Quick generation exceeded 30 minutes, so this stage was restarted."));
        } else {
          try {
            setQuickStageProgress(runId, stage, attempt, message, detail);
            await logStage(stage, "started", attempt, message);
            const result = await operation(attempt);
            await logStage(stage, "success", attempt, ui("완료", "Done"));
            return result;
          } catch (e: any) {
            lastError = e;
          }
        }

        const errorMessage = toUserFacingError(
          (lastError as any)?.message,
          ui("단계 처리에 실패했어.", "Stage failed."),
          uiLanguage
        );
        const retryable = attempt < 2;
        await logStage(stage, retryable ? "retrying" : "error", attempt, errorMessage, {
          request_id: (lastError as any)?.requestId,
          category: (lastError as any)?.category
        });
        if (retryable) {
          setQuickStageProgress(
            runId,
            stage,
            attempt + 1,
            ui("오류가 나서 이 단계만 다시 시도하는 중", "Retrying only this failed stage"),
            errorMessage
          );
          await new Promise((resolve) => window.setTimeout(resolve, 1200));
        }
      }
      throw lastError instanceof Error ? lastError : new Error(ui("간편 생성에 실패했어.", "Quick generation failed."));
    }

    const quickGenerateImages = async (plan: SeriesPlan): Promise<void> => {
      const pages = plan.pages || [];
      const completed = new Set<number>();
      const failed = new Set<number>();
      let cursor = 0;
      const workerCount = runImagesFullyParallel
        ? pages.length
        : Math.min(MAX_PARALLEL_PAGE_GENERATIONS, pages.length);

      setStatus(AppStatus.GENERATING_PANELS);
      setGenerationPhaseMessage(
        runImagesFullyParallel
          ? ui(`${pages.length}${quickUnitLabel} 전체 병렬 이미지 요청 중...`, `Requesting all ${pages.length} ${quickUnitLabel.toLowerCase()} images in parallel...`)
          : ui(`최대 ${MAX_PARALLEL_PAGE_GENERATIONS}장씩 이미지 요청 중...`, `Requesting up to ${MAX_PARALLEL_PAGE_GENERATIONS} images at a time...`)
      );
      setQuickStageProgress(runId, "images", 1, ui("이미지 생성 중", "Generating images"), runImagesFullyParallel ? ui("전체 병렬 모드", "Full parallel mode") : ui("안정 모드", "Stable mode"), {
        totalPages: pages.length,
        completedPages: 0,
        failedPages: 0
      });

      const generateQuickPage = async (page: PageSpec, attempt: number): Promise<boolean> => {
        const pageIndex = page.page.index;
        if (generationRunIdRef.current !== generationRunId) return false;
        if (!startPageGeneration(pageIndex, true)) return false;
        const abortController = new AbortController();
        generationAbortControllersRef.current.add(abortController);
      setGenerationPhaseMessage(ui(`${quickUnitLabel} ${pageIndex} 이미지 요청 중...`, `${quickUnitLabel} ${pageIndex} image request...`));
        setPageErrors((prev) => {
          if (!prev[pageIndex]) return prev;
          const next = { ...prev };
          delete next[pageIndex];
          return next;
        });

        try {
          const pageImageUrl = await (await loadRendererService()).generateFullPageImage(plan.series_spec, page, "2K", LEARNING_COMIC_MODE, {
            styleConsistencyImage: null,
            imageProvider: "codex",
            codexImageQuality: DEFAULT_CODEX_IMAGE_QUALITY,
            codexImageModel,
            signal: abortController.signal,
            onPhase: (phase) => {
              setGenerationPhaseMessage(phase === "retry"
                ? ui(`${quickUnitLabel} ${pageIndex} 이미지 재시도 중...`, `${quickUnitLabel} ${pageIndex} image retry...`)
                : ui(`${quickUnitLabel} ${pageIndex} 이미지 요청 중...`, `${quickUnitLabel} ${pageIndex} image request...`));
            }
          });
          if (generationRunIdRef.current !== generationRunId) return false;
          setPageResults((prev) => upsertGenerationResult(prev, {
            page_index: pageIndex,
            composed_image_url: pageImageUrl
          }));
          setPageRenderedAt((prev) => ({ ...prev, [pageIndex]: Date.now() }));
          setPageRenderedImageSize((prev) => ({ ...prev, [pageIndex]: "2K" }));
          setPageRenderedEngineKey((prev) => ({
            ...prev,
            [pageIndex]: buildImageEngineKey("codex", codexImageModel, DEFAULT_CODEX_IMAGE_QUALITY)
          }));
          completed.add(pageIndex);
          failed.delete(pageIndex);
          setQuickStageProgress(runId, "images", 1, ui("이미지 생성 중", "Generating images"), `${completed.size}/${pages.length}`, {
            totalPages: pages.length,
            completedPages: completed.size,
            failedPages: failed.size
          });
          await logStage("images", "success", attempt, `${quickUnitLabel} ${pageIndex}`, { page_index: pageIndex });
          return true;
        } catch (e: any) {
          const message = toUserFacingError(e?.message, ui("페이지 생성에 실패했어.", "Page generation failed."), uiLanguage);
          await logStage(attempt < 2 ? "images" : "error", attempt < 2 ? "retrying" : "error", attempt, message, {
            page_index: pageIndex,
            request_id: e?.requestId,
            category: e?.category
          });
          if (attempt >= 2) {
            failed.add(pageIndex);
            setPageErrors((prev) => ({ ...prev, [pageIndex]: message }));
            setQuickStageProgress(runId, "images", 1, ui("일부 이미지 실패", "Some images failed"), message, {
              totalPages: pages.length,
              completedPages: completed.size,
              failedPages: failed.size
            });
          }
          return false;
        } finally {
          generationAbortControllersRef.current.delete(abortController);
          finishPageGeneration(pageIndex);
        }
      };

      const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < pages.length && generationRunIdRef.current === generationRunId) {
          const page = pages[cursor++];
          let ok = await generateQuickPage(page, 1);
          if (!ok && generationRunIdRef.current === generationRunId) {
            setGenerationPhaseMessage(ui(`${quickUnitLabel} ${page.page.index} 실패분 재시도 중...`, `${quickUnitLabel} ${page.page.index} retrying failed image...`));
            ok = await generateQuickPage(page, 2);
          }
          if (!ok) failed.add(page.page.index);
        }
      });

      await Promise.all(workers);
      clearPageGenerationTracking();
      setGenerationPhaseMessage(null);
      setStatus(AppStatus.READY_TO_GENERATE);
      if (failed.size > 0) {
        throw new Error(ui(`이미지 ${failed.size}장이 실패했어. 성공한 이미지는 유지했어.`, `${failed.size} image(s) failed. Successful images were kept.`));
      }
    };

    setIsQuickPipelineRunning(true);
    setSystemError(null);
    setQuickPipelineLogsOpen(true);
    setQuickPipelineQueueRuns([]);
    setSelectedQuickPipelineQueueId("");
    setQuickPipelineProgress({
      runId,
      stage: "digest",
      startedAt,
      stageStartedAt: startedAt,
      attempt: 1,
      message: ui("간편 생성을 시작했어.", "Started quick generation.")
    });

    try {
      enterSingleMode();
      setCreationType("educational");
      setComicMode(LEARNING_COMIC_MODE);
      setPublicationFormat(quickFormat);
      setAudienceLevel("beginner");
      setToneMode("normal");
      setToneLevel("medium");
      setDeliveryStyleId("standard");
      setDeliveryCustomInstruction("");
      setScriptDetail("normal");
      setPageCountMode("auto");
      setLanguage("ko");
      setLayoutVariety(DEFAULT_LAYOUT_VARIETY);
      setImageSize("2K");
      setCodexImageQuality(DEFAULT_CODEX_IMAGE_QUALITY);
      setUseCrossPageStyleConsistency(false);
      setCharacterInputMode("suggest");
      setTopic(effectiveTopic);
      setFinalStyle(quickStyle);
      setStatus(AppStatus.PLANNING);

      const digestResult = await runQuickStage("digest", ui("자료 핵심 정리 중", "Digesting source material"), effectiveTopic, async () => {
        const hasUserMaterial = Boolean(materialText || researchReportFile);
        const researchFileForUpload =
          researchReportFile && isPdfMaterialFile(researchReportFile)
            ? researchReportFile
            : undefined;
        const result = hasUserMaterial
          ? await (await loadResearchService()).analyzeResearchReport({
            topic: effectiveTopic,
            report_text: materialText,
            file: researchFileForUpload
          })
          : await (await loadGeminiResearchService()).generateGeminiResearchPack({
            topic: effectiveTopic,
            reasoning_effort: "medium"
          });
        const suggestionResult = await suggestPagesFromNarrative(result.notes, effectiveTopic);
        return {
          notes: result.notes,
          sources: "sources" in result && Array.isArray((result as any).sources) ? (result as any).sources as GroundingSource[] : [],
          warnings: "warnings" in result && Array.isArray(result.warnings) ? result.warnings : [],
          pageSuggestions: suggestionResult?.page_suggestions || null
        };
      });

      const suggestedNormal = digestResult.pageSuggestions?.normal;
      const sourceLengthForUnits = Math.max(materialText.length, digestResult.notes.length);
      const lengthBasedUnitCount = isQuickEpisodeSplit
        ? sourceLengthForUnits >= 24000 ? 36 :
          sourceLengthForUnits >= 12000 ? 24 :
          sourceLengthForUnits >= 6000 ? 18 :
          sourceLengthForUnits >= 2500 ? 12 :
          4
        : sourceLengthForUnits >= 24000 ? 12 :
          sourceLengthForUnits >= 12000 ? 10 :
          sourceLengthForUnits >= 6000 ? 8 :
          sourceLengthForUnits >= 2500 ? 6 :
          4;
      const rawUnitCount = Math.max(
        typeof suggestedNormal === "number" ? suggestedNormal : 0,
        lengthBasedUnitCount
      );
      const requestedUnitCount = pageCountMode === "manual" ? targetPageCount : rawUnitCount;
      const effectivePageCount = isQuickEpisodeSplit
        ? clampQuickStripCount(requestedUnitCount)
        : clampPageCount(Math.min(12, requestedUnitCount));
      setResearchDigestText(digestResult.notes);
      setResearchDigestSources(digestResult.sources);
      setResearchDigestWarnings(digestResult.warnings);
      setResearchDigestError(null);
      setPageSuggestions(digestResult.pageSuggestions);
      setTargetPageCount(effectivePageCount);

      if (requestedQueueCount > 1) {
        const queueRuns: QuickPipelineQueueRun[] = Array.from({ length: requestedQueueCount }, (_, index) => ({
          id: `${runId}_q${index + 1}`,
          label: `${index + 1}큐`,
          stage: "cast",
          status: "pending",
          message: ui("대기 중", "Waiting"),
          startedAt
        }));
        setQuickPipelineQueueRuns(queueRuns);
        setSelectedQuickPipelineQueueId("");
        setQuickStageProgress(
          runId,
          "cast",
          1,
          ui(`${requestedQueueCount}개 큐 동시 생성 중`, `Generating ${requestedQueueCount} queues in parallel`),
          ui("핵심정리는 한 번만 만들고, 캐릭터/콘티/이미지는 큐별 후보로 따로 생성해.", "Digest is shared once; cast, plan, and images are generated separately per queue.")
        );

        const runQueueStage = async <T,>(
          queue: QuickPipelineQueueRun,
          stage: QuickPipelineStage,
          message: string,
          operation: (attempt: number) => Promise<T>
        ): Promise<T> => {
          let lastError: unknown = null;
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
              updateQuickQueueRun(queue.id, {
                stage,
                status: "running",
                message: attempt === 1 ? message : ui("재시도 중", "Retrying"),
                error: undefined
              });
              await writeQuickPipelineLog({
                run_id: `${runId}:${queue.label}`,
                stage,
                status: "started",
                attempt,
                message,
                elapsed_ms: Date.now() - startedAt
              });
              const result = await operation(attempt);
              await writeQuickPipelineLog({
                run_id: `${runId}:${queue.label}`,
                stage,
                status: "success",
                attempt,
                message: ui("완료", "Done"),
                elapsed_ms: Date.now() - startedAt
              });
              return result;
            } catch (e: any) {
              lastError = e;
              const errorMessage = toUserFacingError(e?.message, ui("큐 단계 처리에 실패했어.", "Queue stage failed."), uiLanguage);
              const retryable = attempt < 2;
              updateQuickQueueRun(queue.id, {
                stage,
                status: "running",
                message: retryable ? ui("오류 후 재시도 대기", "Waiting to retry after an error") : errorMessage,
                error: errorMessage
              });
              await writeQuickPipelineLog({
                run_id: `${runId}:${queue.label}`,
                stage,
                status: retryable ? "retrying" : "error",
                attempt,
                message: errorMessage,
                request_id: e?.requestId,
                category: e?.category,
                elapsed_ms: Date.now() - startedAt
              });
              if (retryable) await new Promise((resolve) => window.setTimeout(resolve, 1200));
            }
          }
          throw lastError instanceof Error ? lastError : new Error(ui("큐 생성에 실패했어.", "Queue generation failed."));
        };

        const suggestQuickCastForQueue = async (queue: QuickPipelineQueueRun): Promise<CharacterSpec[]> => {
          const source = { label: ui("간편 핵심정리", "Quick digest"), text: digestResult.notes };
          const suggestions = await suggestCastFromContent({
            source_text: source.text,
            creation_type: "educational",
            publication_format: quickFormat,
            audience_level: "beginner",
            source_label: `${source.label} · ${queue.label}`,
            existing_cast: [createCharacter("protagonist")],
            selected_style: {
              preset_id: quickStyle.preset_id,
              preset_label: quickStyle.preset_label,
              render_mode: quickStyle.render_mode,
              style_prompt: quickStyle.style_prompt,
              user_style_prompt: quickStyle.user_style_prompt
            }
          });
          const mapped = suggestions.map((c) => ({
            ...createCharacter(c.role, c.name),
            appearance: c.appearance || c.visual_prompt,
            persona: [c.persona, c.story_function].filter(Boolean).join("\n"),
            catchphrase: c.catchphrase || "",
            catchphrase_frequency: "rare" as CatchphraseFrequency,
            reference_images: []
          }));
          const protagonists = mapped.filter((c) => c.role === "protagonist").slice(0, 2);
          const supporting = mapped.filter((c) => c.role === "supporting");
          return protagonists.length > 0 ? [...protagonists, ...supporting] : [createCharacter("protagonist"), ...supporting];
        };

        const generateQuickPlanForQueue = async (queue: QuickPipelineQueueRun, queueCast: CharacterSpec[]): Promise<SeriesPlan> => {
          const templatesForPlan = getTemplatesForFormat(quickFormat, templates);
          if (templatesForPlan.length === 0) {
            throw new Error(isQuickInstatoon
              ? ui("인스타툰 카드 템플릿을 찾지 못했어.", "Could not find instatoon card templates.")
              : isQuickWebtoon
              ? ui("웹툰 레이아웃 템플릿을 찾지 못했어.", "Could not find webtoon layout templates.")
              : ui("학습만화 레이아웃 템플릿을 찾지 못했어.", "Could not find learning comic layout templates."));
          }
          const protagonists = queueCast.filter((c) => c.role === "protagonist");
          const primary = protagonists[0] || queueCast[0] || createCharacter("protagonist");
          const primaryAppearance =
            String(primary.analyzed_appearance || primary.appearance || "").trim() ||
            String(primary.name || "").trim() ||
            "A friendly guide character";
          const primaryRefs = Array.isArray(primary.reference_images) ? primary.reference_images.filter(Boolean) : [];
          const supportingSummary = queueCast
            .filter((c) => c.role === "supporting")
            .map(buildCastSummaryLine)
            .map((s) => s.trim())
            .filter(Boolean)
            .join("\n");

          const generatedPlan = await (await loadPlannerService()).generatePlan({
            topic: `${effectiveTopic} (${queue.label} 후보)`,
            question_type: LEARNING_QUESTION_TYPE,
            comic_mode: LEARNING_COMIC_MODE,
            output_mode: "comic",
            publication_format: quickFormat,
            manga_color_mode: mangaColorMode,
            i2v_aspect_ratio: i2vAspectRatio,
            tone_mode: "normal",
            tone_level: "medium",
            intro_style: LEARNING_INTRO_STYLE,
            detail_level: "normal",
            language: "ko",
            audience_level: "beginner",
            character_consistency_mode: "strict",
            delivery_style: resolveDeliveryStyleSpec({
              preset_id: "standard",
              custom_instruction: "",
              audience_level: "beginner",
              comic_mode: LEARNING_COMIC_MODE
            }),
            layout_variety: DEFAULT_LAYOUT_VARIETY,
            image_size: "2K",
            page_count: effectivePageCount,
            character_description: primaryAppearance,
            character_role: LEARNING_NARRATIVE_ROLE,
            character_refs: { main: primaryRefs[0] || "", pack: primaryRefs },
            product:
              productReferenceImages.length > 0
                ? { label: effectiveTopic, reference_images: productReferenceImages.filter(Boolean) }
                : undefined,
            supporting_cast: supportingSummary || undefined,
            cast: queueCast,
            style: quickStyle,
            templates: templatesForPlan,
            gemini_reasoning_effort: "medium",
            research: {
              mode: "auto_digest",
              pack: {
                notes: `${digestResult.notes}\n\n큐 지시: ${queue.label}는 같은 주제를 다른 구성/장면 흐름으로 변주한 후보여야 한다. 앞선 큐와 같은 제목/첫 장면/비유를 반복하지 말 것.`,
                sources: digestResult.sources,
                page_suggestions: digestResult.pageSuggestions || undefined
              }
            }
          });
          return applyQuickEpisodeSplitForFormat(generatedPlan, quickFormat, quickPipelineUnitsPerEpisode);
        };

        const generateQuickImagesForQueue = async (queue: QuickPipelineQueueRun, plan: SeriesPlan): Promise<Pick<QuickPipelineQueueRun, "pageResults" | "pageErrors">> => {
          const pages = plan.pages || [];
          const completed = new Set<number>();
          const failed = new Set<number>();
          const pageErrorsForQueue: Record<number, string> = {};
          let pageResultsForQueue: GenerationResult[] = [];
          let cursor = 0;
          const workerCount = runImagesFullyParallel
            ? pages.length
            : Math.min(MAX_PARALLEL_PAGE_GENERATIONS, pages.length);

          updateQuickQueueRun(queue.id, {
            stage: "images",
            status: "running",
            message: runImagesFullyParallel ? ui("이미지 전체 병렬 요청 중", "Requesting all images in parallel") : ui("이미지 3장씩 요청 중", "Requesting images 3 at a time"),
            totalPages: pages.length,
            completedPages: 0,
            failedPages: 0
          });

          const generateQueuePage = async (page: PageSpec, attempt: number): Promise<boolean> => {
            const pageIndex = page.page.index;
            const abortController = new AbortController();
            generationAbortControllersRef.current.add(abortController);
            try {
              const pageImageUrl = await (await loadRendererService()).generateFullPageImage(plan.series_spec, page, "2K", LEARNING_COMIC_MODE, {
                styleConsistencyImage: null,
                imageProvider: "codex",
                codexImageQuality: DEFAULT_CODEX_IMAGE_QUALITY,
                codexImageModel,
                signal: abortController.signal
              });
              pageResultsForQueue = upsertGenerationResult(pageResultsForQueue, {
                page_index: pageIndex,
                composed_image_url: pageImageUrl
              });
              completed.add(pageIndex);
              failed.delete(pageIndex);
              delete pageErrorsForQueue[pageIndex];
              updateQuickQueueRun(queue.id, {
                stage: "images",
                status: "running",
                message: `${completed.size}/${pages.length}`,
                completedPages: completed.size,
                failedPages: failed.size,
                pageResults: pageResultsForQueue,
                pageErrors: { ...pageErrorsForQueue }
              });
              await writeQuickPipelineLog({
                run_id: `${runId}:${queue.label}`,
                stage: "images",
                status: "success",
                attempt,
                message: `${quickUnitLabel} ${pageIndex}`,
                page_index: pageIndex,
                elapsed_ms: Date.now() - startedAt
              });
              return true;
            } catch (e: any) {
              const message = toUserFacingError(e?.message, ui("페이지 생성에 실패했어.", "Page generation failed."), uiLanguage);
              await writeQuickPipelineLog({
                run_id: `${runId}:${queue.label}`,
                stage: "images",
                status: attempt < 2 ? "retrying" : "error",
                attempt,
                message,
                page_index: pageIndex,
                request_id: e?.requestId,
                category: e?.category,
                elapsed_ms: Date.now() - startedAt
              });
              if (attempt >= 2) {
                failed.add(pageIndex);
                pageErrorsForQueue[pageIndex] = message;
                updateQuickQueueRun(queue.id, {
                  stage: "images",
                  status: "running",
                  message,
                  completedPages: completed.size,
                  failedPages: failed.size,
                  pageResults: pageResultsForQueue,
                  pageErrors: { ...pageErrorsForQueue }
                });
              }
              return false;
            } finally {
              generationAbortControllersRef.current.delete(abortController);
            }
          };

          const workers = Array.from({ length: workerCount }, async () => {
            while (cursor < pages.length) {
              const page = pages[cursor++];
              let ok = await generateQueuePage(page, 1);
              if (!ok) ok = await generateQueuePage(page, 2);
              if (!ok) failed.add(page.page.index);
            }
          });
          await Promise.all(workers);
          if (failed.size > 0) {
            throw new Error(ui(`이미지 ${failed.size}장이 실패했어. 성공한 이미지는 큐에 유지했어.`, `${failed.size} image(s) failed. Successful images were kept in the queue.`));
          }
          return { pageResults: pageResultsForQueue, pageErrors: pageErrorsForQueue };
        };

        const runOneQueue = async (queue: QuickPipelineQueueRun): Promise<QuickPipelineQueueRun> => {
          try {
            const queueCast = await runQueueStage(queue, "cast", ui("캐릭터 후보 생성 중", "Generating cast candidate"), () => suggestQuickCastForQueue(queue));
            const queuePlan = await runQueueStage(
              queue,
              "plan",
              isQuickInstatoon ? ui("인스타툰 카드 콘티 후보 생성 중", "Generating instatoon card plan candidate") : isQuickWebtoon ? ui("웹툰 콘티 후보 생성 중", "Generating webtoon plan candidate") : ui("학습만화 콘티 후보 생성 중", "Generating learning comic plan candidate"),
              () => generateQuickPlanForQueue(queue, queueCast)
            );
            updateQuickQueueRun(queue.id, {
              stage: "images",
              status: "running",
              message: ui("이미지 생성 준비", "Preparing image generation"),
              plan: queuePlan,
              totalPages: queuePlan.pages.length,
              completedPages: 0,
              failedPages: 0
            });
            const imageResult = await runQueueStage(queue, "images", ui("최종 이미지 생성 중", "Generating final images"), () => generateQuickImagesForQueue(queue, queuePlan));
            const completedRun: QuickPipelineQueueRun = {
              ...queue,
              stage: "complete",
              status: "success",
              message: ui("완료", "Done"),
              completedAt: Date.now(),
              totalPages: queuePlan.pages.length,
              completedPages: imageResult.pageResults?.length || 0,
              failedPages: Object.keys(imageResult.pageErrors || {}).length,
              plan: queuePlan,
              pageResults: imageResult.pageResults || [],
              pageErrors: imageResult.pageErrors || {}
            };
            updateQuickQueueRun(queue.id, completedRun);
            return completedRun;
          } catch (e: any) {
            const message = toUserFacingError(e?.message, ui("큐 생성에 실패했어.", "Queue generation failed."), uiLanguage);
            const failedRun: QuickPipelineQueueRun = {
              ...queue,
              stage: "error",
              status: "error",
              message,
              error: message,
              completedAt: Date.now()
            };
            updateQuickQueueRun(queue.id, failedRun);
            return failedRun;
          }
        };

        setStatus(AppStatus.GENERATING_PANELS);
        setGenerationPhaseMessage(ui(`${requestedQueueCount}개 큐를 동시에 생성 중...`, `Generating ${requestedQueueCount} queues in parallel...`));
        const queueResults = await Promise.all(queueRuns.map((queue) => runOneQueue(queue)));
        const successfulRuns = queueResults.filter((run) => run.status === "success" && run.plan);
        if (successfulRuns.length === 0) {
          throw new Error(ui("모든 큐 생성이 실패했어. 최근 기록에서 실패 원인을 확인해줘.", "All queue generations failed. Check recent logs for the failure reason."));
        }
        const firstSuccess = successfulRuns[0];
        loadQuickPipelineQueueResult(firstSuccess);
        setCast([]);
        setCharacterConsistencyMode("strict");
        setQuickStageProgress(runId, "complete", 1, ui(`${successfulRuns.length}/${requestedQueueCount}개 큐 완료`, `${successfulRuns.length}/${requestedQueueCount} queues complete`), ui("완료된 큐는 아래에서 골라 볼 수 있어.", "Pick a completed queue below."), {
          totalPages: firstSuccess.totalPages,
          completedPages: firstSuccess.completedPages,
          failedPages: firstSuccess.failedPages || 0
        });
        await logStage("complete", "success", 1, ui(`${successfulRuns.length}개 큐 생성 완료`, `${successfulRuns.length} queue(s) generated.`));
        setGenerationPhaseMessage(null);
        return;
      }

      const quickCast = await runQuickStage("cast", ui("캐릭터 자동 제안 중", "Suggesting characters"), ui("AI 제안 받기 기본값 사용", "Using AI suggestion defaults"), async () => {
        const source = { label: ui("간편 핵심정리", "Quick digest"), text: digestResult.notes };
        const suggestions = await suggestCastFromContent({
          source_text: source.text,
          creation_type: "educational",
          publication_format: quickFormat,
          audience_level: "beginner",
          source_label: source.label,
          existing_cast: [createCharacter("protagonist")],
          selected_style: {
            preset_id: quickStyle.preset_id,
            preset_label: quickStyle.preset_label,
            render_mode: quickStyle.render_mode,
            style_prompt: quickStyle.style_prompt,
            user_style_prompt: quickStyle.user_style_prompt
          }
        });
        const mapped = suggestions.map((c) => ({
          ...createCharacter(c.role, c.name),
          appearance: c.appearance || c.visual_prompt,
          persona: [c.persona, c.story_function].filter(Boolean).join("\n"),
          catchphrase: c.catchphrase || "",
          catchphrase_frequency: "rare" as CatchphraseFrequency,
          reference_images: []
        }));
        const protagonists = mapped.filter((c) => c.role === "protagonist").slice(0, 2);
        const supporting = mapped.filter((c) => c.role === "supporting");
        return protagonists.length > 0 ? [...protagonists, ...supporting] : [createCharacter("protagonist"), ...supporting];
      });
      setCast(quickCast);
      setCharacterConsistencyMode("strict");
      setCastSuggestionNotice({
        kind: "success",
        message: ui(`간편 생성용 캐릭터 ${quickCast.length}명을 적용했어.`, `Applied ${quickCast.length} quick-generation characters.`)
      });

      const plan = await runQuickStage(
        "plan",
        isQuickInstatoon ? ui("인스타툰 카드 콘티 생성 중", "Generating instatoon card plan") : isQuickWebtoon ? ui("웹툰 콘티 생성 중", "Generating webtoon plan") : ui("학습만화 콘티 생성 중", "Generating learning comic plan"),
        isQuickInstatoon
          ? ui(`${effectivePageCount}카드 · ${getQuickEpisodeUnitLimit("instatoon", quickPipelineUnitsPerEpisode)}카드마다 N편 분할`, `${effectivePageCount} cards · split every ${getQuickEpisodeUnitLimit("instatoon", quickPipelineUnitsPerEpisode)} cards`)
          : isQuickWebtoon
          ? ui(`${effectivePageCount}스트립 · 12스트립마다 N편 분할`, `${effectivePageCount} strips · split every 12 strips`)
          : ui(`${effectivePageCount}페이지 학습만화 구성`, `${effectivePageCount} learning-comic pages`),
        async () => {
        const templatesForPlan = getTemplatesForFormat(quickFormat, templates);
        if (templatesForPlan.length === 0) {
          throw new Error(isQuickInstatoon
            ? ui("인스타툰 카드 템플릿을 찾지 못했어.", "Could not find instatoon card templates.")
            : isQuickWebtoon
            ? ui("웹툰 레이아웃 템플릿을 찾지 못했어.", "Could not find webtoon layout templates.")
            : ui("학습만화 레이아웃 템플릿을 찾지 못했어.", "Could not find learning comic layout templates."));
        }
        const protagonists = quickCast.filter((c) => c.role === "protagonist");
        const primary = protagonists[0] || quickCast[0] || createCharacter("protagonist");
        const primaryAppearance =
          String(primary.analyzed_appearance || primary.appearance || "").trim() ||
          String(primary.name || "").trim() ||
          "A friendly guide character";
        const primaryRefs = Array.isArray(primary.reference_images) ? primary.reference_images.filter(Boolean) : [];
        const supportingSummary = quickCast
          .filter((c) => c.role === "supporting")
          .map(buildCastSummaryLine)
          .map((s) => s.trim())
          .filter(Boolean)
          .join("\n");

        const generatedPlan = await (await loadPlannerService()).generatePlan({
          topic: effectiveTopic,
          question_type: LEARNING_QUESTION_TYPE,
          comic_mode: LEARNING_COMIC_MODE,
          output_mode: "comic",
          publication_format: quickFormat,
          manga_color_mode: mangaColorMode,
          i2v_aspect_ratio: i2vAspectRatio,
          tone_mode: "normal",
          tone_level: "medium",
          intro_style: LEARNING_INTRO_STYLE,
          detail_level: "normal",
          language: "ko",
          audience_level: "beginner",
          character_consistency_mode: "strict",
          delivery_style: resolveDeliveryStyleSpec({
            preset_id: "standard",
            custom_instruction: "",
            audience_level: "beginner",
            comic_mode: LEARNING_COMIC_MODE
          }),
          layout_variety: DEFAULT_LAYOUT_VARIETY,
          image_size: "2K",
          page_count: effectivePageCount,
          character_description: primaryAppearance,
          character_role: LEARNING_NARRATIVE_ROLE,
          character_refs: { main: primaryRefs[0] || "", pack: primaryRefs },
          product:
            productReferenceImages.length > 0
              ? { label: effectiveTopic, reference_images: productReferenceImages.filter(Boolean) }
              : undefined,
          supporting_cast: supportingSummary || undefined,
          cast: quickCast,
          style: quickStyle,
          templates: templatesForPlan,
          gemini_reasoning_effort: "medium",
          research: {
            mode: "auto_digest",
            pack: {
              notes: digestResult.notes,
              sources: digestResult.sources,
              page_suggestions: digestResult.pageSuggestions || undefined
            }
          }
        });
        return applyQuickEpisodeSplitForFormat(generatedPlan, quickFormat, quickPipelineUnitsPerEpisode);
      });

      if (generationRunIdRef.current !== generationRunId) return;
      setSeriesPlan(plan);
      setPageResults([]);
      setPageErrors({});
      setWebtoonEpisodeResult(null);
      setIsBuildingWebtoonEpisode(false);
      setPageRenderedAt({});
      setPageRenderedImageSize({});
      setPageRenderedEngineKey({});
      setPageScriptEditedAt({});
      setPageStyleOverrides({});
      setPageStyleEditedAt({});
      setGlobalStyleEditedAt(0);

      await runQuickStage("images", ui("최종 이미지 생성 중", "Generating final images"), ui("성공한 이미지는 유지하고 실패분만 재시도", "Successful images are kept; failed pages retry once"), async () => {
        await quickGenerateImages(plan);
      });

      setQuickStageProgress(runId, "complete", 1, ui("간편 생성 완료", "Quick generation complete"), undefined, {
        totalPages: plan.pages.length,
        completedPages: plan.pages.length,
        failedPages: 0
      });
      await logStage("complete", "success", 1, isQuickInstatoon
        ? ui("최종 인스타툰 카드 이미지 생성 완료", "Final instatoon card images generated.")
        : isQuickWebtoon
        ? ui("최종 웹툰 이미지 생성 완료", "Final webtoon images generated.")
        : ui("최종 학습만화 이미지 생성 완료", "Final learning comic images generated."));
      setStatus(AppStatus.READY_TO_GENERATE);
      setSystemError(null);
    } catch (e: any) {
      const message = toUserFacingError(e?.message, ui("간편 생성에 실패했어.", "Quick generation failed."), uiLanguage);
      setSystemError(message);
      setQuickStageProgress(runId, "error", 1, ui("간편 생성 실패", "Quick generation failed"), message);
      await logStage("error", "error", 1, message, {
        request_id: e?.requestId,
        category: e?.category
      });
      if (!seriesPlan && pageResults.length === 0) setStatus(AppStatus.ERROR);
    } finally {
      if (quickPipelineRunIdRef.current === runId) quickPipelineRunIdRef.current = null;
      setIsQuickPipelineRunning(false);
      void refreshQuickPipelineLogs();
    }
  };

  const handleAnalyzeStory = async () => {
    if (isStoryAnalyzing || scriptText.trim().length < STORY_MIN_INPUT_CHARS) return;
    setIsStoryAnalyzing(true);
    setStoryDigestError(null);
    setStoryDigestWarnings([]);
    setStoryPageSuggestions(null);

    try {
      const result = await (await loadStoryAnalysisService()).analyzeStoryScript({
        script_text: scriptText,
        story_input_type: storyInputType,
        genre: storyGenre || undefined,
        pacing: pacingPreference,
        age_rating: ageRating,
        publication_format: publicationFormat
      });
      setStoryAdaptationMode("analyzed");
      setStoryDigestText(result.notes);
      setStoryDigestWarnings(result.warnings);
      setStoryPageSuggestions(result.page_suggestions);
    } catch (e: any) {
      setStoryDigestError(e?.message || ui("AI 각색에 실패했어.", "AI adaptation failed."));
    } finally {
      setIsStoryAnalyzing(false);
    }
  };

  const handleUseStoryAsIs = () => {
    if (storyInputType === "scenario") return;
    if (scriptText.trim().length < STORY_MIN_INPUT_CHARS) return;
    const suggestions = estimateDirectStoryPageSuggestions(scriptText, storyInputType);
    setStoryAdaptationMode("direct");
    setStoryDigestText("");
    setStoryDigestWarnings([]);
    setStoryDigestError(null);
    setStoryPageSuggestions(suggestions);
    if (pageCountMode === "auto") {
      setTargetPageCount(clampPageCount(suggestions[scriptDetail]));
    }
  };

  const handleStoryInputTypeChange = (nextType: StoryInputType) => {
    if (nextType === storyInputType) return;
    setStoryInputType(nextType);
    setStoryAdaptationMode("analyzed");
    setStoryDigestText("");
    setStoryDigestWarnings([]);
    setStoryDigestError(null);
    setStoryPageSuggestions(null);
  };

  const runPaperAnalysis = async (file: File) => {
    if (isPaperAnalyzing) return;
    setIsPaperAnalyzing(true);
    setPaperBriefError(null);
    setPaperBrief(null);

    try {
      const rawResult = await (await loadPaperService()).analyzePaperPdf({
        file,
        audience_level: audienceLevel,
        detail_level: scriptDetail,
        publication_format: publicationFormat
      });
      const pageSuggestion = await suggestPagesFromNarrative(rawResult.explainer_story, rawResult.paper_title || file.name);
      const result = pageSuggestion
        ? {
          ...rawResult,
          page_suggestions: pageSuggestion.page_suggestions,
          page_division_note: pageSuggestion.page_division_note
        }
        : rawResult;
      setPaperBrief(result);
      setTopic(result.paper_title || "");
      if (pageCountMode === "auto") {
        const suggested = result.page_suggestions?.[scriptDetail];
        if (typeof suggested === "number") setTargetPageCount(clampPageCount(suggested));
      }
    } catch (e: any) {
      setPaperBriefError(e?.message || ui("논문 분석에 실패했어.", "Paper analysis failed."));
    } finally {
      setIsPaperAnalyzing(false);
    }
  };

  const runPaperUrlAnalysis = async () => {
    if (isPaperAnalyzing) return;
    const rawUrl = paperUrl.trim();
    if (!rawUrl) {
      setPaperBriefError(ui("논문 URL을 먼저 입력해줘.", "Enter a paper URL first."));
      return;
    }
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    try {
      new URL(url);
    } catch {
      setPaperBriefError(ui("URL 형식이 올바르지 않아.", "The URL format looks invalid."));
      return;
    }

    setIsPaperAnalyzing(true);
    setPaperBriefError(null);
    setPaperBrief(null);
    setPaperFile(null);
    setPaperUrl(url);

    try {
      const rawResult = await (await loadPaperService()).analyzePaperUrl({
        url,
        audience_level: audienceLevel,
        detail_level: scriptDetail,
        publication_format: publicationFormat
      });
      const pageSuggestion = await suggestPagesFromNarrative(rawResult.explainer_story, rawResult.paper_title || url);
      const result = pageSuggestion
        ? {
          ...rawResult,
          page_suggestions: pageSuggestion.page_suggestions,
          page_division_note: pageSuggestion.page_division_note
        }
        : rawResult;
      setPaperBrief(result);
      setTopic(result.paper_title || "");
      if (pageCountMode === "auto") {
        const suggested = result.page_suggestions?.[scriptDetail];
        if (typeof suggested === "number") setTargetPageCount(clampPageCount(suggested));
      }
    } catch (e: any) {
      setPaperBriefError(e?.message || ui("논문 URL 조사에 실패했어.", "Paper URL research failed."));
    } finally {
      setIsPaperAnalyzing(false);
    }
  };

  const handlePaperFileChange = async (file: File | null) => {
    setPaperFile(file);
    if (file) setPaperUrl("");
    setPaperBrief(null);
    setPaperBriefError(null);
    if (!file) return;
    await runPaperAnalysis(file);
  };

  const handleGeneratePlan = async (styleOverride?: SeriesSpec["anchors"]["style"] | null) => {
    if (!hasApiKey) {
      setSystemError(ui("플랜/스크립트 생성에는 로컬 서버와 Codex 로그인이 필요해. `npm run dev`와 `npx @openai/codex login`을 확인해줘.", "Plan/script generation requires the local server and Codex login. Check `npm run dev` and `npx @openai/codex login`."));
      setStatus(AppStatus.CHARACTER_SELECT);
      return;
    }
    const effectiveStyle = styleOverride || finalStyle || {
      ...resolveCurrentStyle()
    };
    if (!effectiveStyle) return;
    if (creationType === "story") {
      if (scriptText.trim().length < STORY_MIN_INPUT_CHARS) return;
      if (storyInputType === "scenario" && !storyDigestText.trim()) {
        setSystemError(ui("상황/설정 입력은 먼저 AI 각색을 해줘.", "Scenario input needs AI adaptation first."));
        return;
      }
    } else if (creationType === "paper") {
      if (!paperBrief) return;
    } else {
      if (!topic.trim()) return;
    }
    generationRunIdRef.current += 1;
    const runId = generationRunIdRef.current;
    const previousStatus = status;
    const hadExistingPlan = Boolean(seriesPlan);
    try {
      setSystemError(null);
      setAutoGeneratePages(false);
      setRegenerateAllPages(false);
      setRegenerateCursor(1);
      clearPageGenerationTracking();
      setPageScriptEditorOpen(false);
      setPageScriptDraft(null);
      setPageEditActionOpen(false);
      setPageEditTargetIndex(null);
      setPageStyleEditorOpen(false);
      setPageStyleTargetIndex(null);
      setBusyPhase("planning");
      setStatus(AppStatus.PLANNING);
      const protagonists = cast.filter((c) => c.role === "protagonist");
      if (protagonists.length === 0) {
        setSystemError(ui("주연(주인공)을 최소 1명 추가해줘.", "Add at least 1 lead character."));
        setStatus(AppStatus.CHARACTER_SELECT);
        return;
      }

      const primary = protagonists[0];
      const primaryAppearance =
        String(primary.analyzed_appearance || primary.appearance || "").trim() || String(primary.name || "").trim() || "A friendly guide character";
      const primaryRefs = Array.isArray(primary.reference_images) ? primary.reference_images.filter(Boolean) : [];
      const supportingSummary = cast
        .filter((c) => c.role === "supporting")
        .map(buildCastSummaryLine)
        .map((s) => s.trim())
        .filter(Boolean)
        .join("\n");

      const isI2VSelected = isKlingI2VFormat(publicationFormat);
      let templatesForPlan: LayoutTemplate[];
      if (isI2VSelected) {
        const targetI2VTemplateId = I2V_TEMPLATE_BY_RATIO[i2vAspectRatio];
        const i2vTemplate =
          templates.find((t) => t.id === targetI2VTemplateId) ||
          templates.find((t) => t.panels.length === 1);
        templatesForPlan = i2vTemplate ? [i2vTemplate] : [];
      } else {
        templatesForPlan = getTemplatesForFormat(publicationFormat, templates);
        if (publicationFormat === "learning_comic" && layoutVariety !== "high") {
          templatesForPlan = templatesForPlan.filter((t) => t.panels.length === 4);
        }
        if (templatesForPlan.length === 0) {
          // Fallback for formats without dedicated templates yet
          templatesForPlan = templates.filter((t) => t.panels.length === 4);
        }
      }

      if (templatesForPlan.length === 0) {
        setSystemError(ui("레이아웃 템플릿을 찾을 수 없어. 새로고침 후 다시 시도해줘.", "Could not find layout templates. Refresh and try again."));
        setStatus(AppStatus.CHARACTER_SELECT);
        return;
      }

      let plan: SeriesPlan;
      if (creationType === "story") {
        plan = await (await loadPlannerService()).generateStoryPlan({
          script_text: scriptText,
          story_input_type: storyInputType,
          story_adaptation_mode: storyAdaptationMode,
          genre: storyGenre || undefined,
          pacing: pacingPreference,
          age_rating: ageRating,
          detail_level: scriptDetail,
          language,
          delivery_style: resolveDeliveryStyleSpec({
            preset_id: deliveryStyleId,
            custom_instruction: deliveryCustomInstruction,
            audience_level: audienceLevel,
            comic_mode: "pure_cinematic"
          }),
          tone_mode: toneMode,
          tone_level: toneLevel,
          layout_variety: layoutVariety,
          image_size: imageSize,
          page_count: targetPageCount,
          publication_format: publicationFormat,
          manga_color_mode: mangaColorMode,
          i2v_aspect_ratio: i2vAspectRatio,
          story_anti_education_guard: storyAntiEducationGuardEnabled,
          character_consistency_mode: characterConsistencyMode,
          character_description: primaryAppearance,
          character_role: narrativeRole,
          character_refs: { main: primaryRefs[0] || "", pack: primaryRefs },
          product:
            productReferenceImages.length > 0
              ? { label: scriptText.slice(0, 30), reference_images: productReferenceImages.filter(Boolean) }
              : undefined,
          supporting_cast: supportingSummary || undefined,
          cast,
          style: effectiveStyle,
          templates: templatesForPlan,
          digest_notes: storyAdaptationMode === "analyzed" ? storyDigestText.trim() || undefined : undefined,
          use_story_outline: storyAdaptationMode !== "direct",
          gemini_reasoning_effort: geminiReasoningEffort,
        });
      } else if (creationType === "paper") {
        plan = await (await loadPlannerService()).generatePaperPlan({
          paper_brief: paperBrief,
          detail_level: scriptDetail,
          language,
          audience_level: audienceLevel,
          layout_variety: layoutVariety,
          image_size: imageSize,
          page_count: targetPageCount,
          publication_format: publicationFormat,
          manga_color_mode: mangaColorMode,
          i2v_aspect_ratio: i2vAspectRatio,
          tone_mode: toneMode,
          tone_level: toneLevel,
          character_consistency_mode: characterConsistencyMode,
          character_description: primaryAppearance,
          character_role: narrativeRole,
          character_refs: { main: primaryRefs[0] || "", pack: primaryRefs },
          supporting_cast: supportingSummary || undefined,
          cast,
          style: effectiveStyle,
          templates: templatesForPlan,
          gemini_reasoning_effort: geminiReasoningEffort
        });
      } else {
        let effectivePageCount = targetPageCount;
        if (!researchDigestText.trim()) {
          setSystemError(ui("먼저 자료를 AI로 핵심 정리해줘.", "Summarize the material with AI first."));
          setStatus(AppStatus.TOPIC_INPUT);
          return;
        }
        const resolvedResearchParam = {
          mode: "auto_digest" as const,
          pack: {
            notes: researchDigestText.trim(),
            sources: researchDigestSources,
            page_suggestions: pageSuggestions || undefined
          }
        };
        if (pageCountMode === "auto") {
          const suggestions = "page_suggestions" in resolvedResearchParam.pack
            ? resolvedResearchParam.pack.page_suggestions || null
            : null;
          const suggested = suggestions?.[scriptDetail];
          if (typeof suggested === "number") {
            effectivePageCount = clampPageCount(suggested);
            setTargetPageCount(effectivePageCount);
            setPageSuggestions(suggestions);
          }
        }
        plan = await (await loadPlannerService()).generatePlan({
          topic,
          question_type: LEARNING_QUESTION_TYPE,
          comic_mode: LEARNING_COMIC_MODE,
          output_mode: toLegacyOutputMode(publicationFormat),
          publication_format: publicationFormat,
          manga_color_mode: mangaColorMode,
          i2v_aspect_ratio: i2vAspectRatio,
          tone_mode: toneMode,
          tone_level: toneLevel,
          intro_style: LEARNING_INTRO_STYLE,
          detail_level: scriptDetail,
          language,
          audience_level: audienceLevel,
          character_consistency_mode: characterConsistencyMode,
          delivery_style: resolveDeliveryStyleSpec({
            preset_id: deliveryStyleId,
            custom_instruction: deliveryCustomInstruction,
            audience_level: audienceLevel,
            comic_mode: LEARNING_COMIC_MODE
          }),
          layout_variety: layoutVariety,
          image_size: imageSize,
          page_count: effectivePageCount,
          character_description: primaryAppearance,
          character_role: LEARNING_NARRATIVE_ROLE,
          character_refs: { main: primaryRefs[0] || "", pack: primaryRefs },
          product:
            productReferenceImages.length > 0
              ? { label: topic, reference_images: productReferenceImages.filter(Boolean) }
              : undefined,
          supporting_cast: supportingSummary || undefined,
          cast,
          style: effectiveStyle,
          templates: templatesForPlan,
          gemini_reasoning_effort: geminiReasoningEffort,
          research: resolvedResearchParam
        });
      }
      if (generationRunIdRef.current !== runId) return;
      setSeriesPlan(plan);
      setPageResults([]);
      setPageErrors({});
      setWebtoonEpisodeResult(null);
      setIsBuildingWebtoonEpisode(false);
      setPageRenderedAt({});
      setPageRenderedImageSize({});
      setPageRenderedEngineKey({});
      setPageScriptEditedAt({});
      setPageStyleOverrides({});
      setPageStyleEditedAt({});
      setGlobalStyleEditedAt(0);
      setStatus(AppStatus.PLAN_REVIEW);
    } catch (e) {
      console.error(e);
      if (generationRunIdRef.current !== runId) return;
      setSystemError(toUserFacingError((e as any)?.message, ui("플랜 생성에 실패했어.", "Plan generation failed."), uiLanguage));
      setStatus(hadExistingPlan ? previousStatus : AppStatus.ERROR);
    }
  };

  const switchPlanLanguage = async (nextLanguage: Language) => {
    const currentPlanLanguage = seriesPlan?.series_spec?.series?.language;
    const previousLanguage = language;
    if (!seriesPlan) {
      setLanguage(nextLanguage);
      return;
    }
    if (currentPlanLanguage === nextLanguage) {
      setLanguage(nextLanguage);
      return;
    }
    setLanguage(nextLanguage);

    generationRunIdRef.current += 1;
    const runId = generationRunIdRef.current;

    setAutoGeneratePages(false);
    setRegenerateAllPages(false);
    setRegenerateCursor(1);
    clearPageGenerationTracking();
    setPageEditActionOpen(false);
    setPageEditTargetIndex(null);
    setPageStyleEditorOpen(false);
    setPageStyleTargetIndex(null);
    setSystemError(null);
    setBusyPhase("translating");
    setStatus(AppStatus.PLANNING);

    const returnStatus =
      status === AppStatus.READY_TO_GENERATE || status === AppStatus.GENERATING_PANELS
        ? AppStatus.READY_TO_GENERATE
        : AppStatus.PLAN_REVIEW;

    try {
      const translated = await (await loadTranslationService()).translateSeriesPlan({
        series_spec: seriesPlan.series_spec,
        pages: seriesPlan.pages,
        to: nextLanguage
      });
      if (generationRunIdRef.current !== runId) return;
      setSeriesPlan((prev) => (prev ? { ...prev, series_spec: translated.series_spec, pages: translated.pages } : prev));
      setPageResults([]);
      setPageErrors({});
      setWebtoonEpisodeResult(null);
      setIsBuildingWebtoonEpisode(false);
      setPageRenderedAt({});
      setPageRenderedImageSize({});
      setPageRenderedEngineKey({});
      setBusyPhase("planning");
      setStatus(returnStatus);
    } catch (e) {
      console.error(e);
      if (generationRunIdRef.current !== runId) return;
      setLanguage(currentPlanLanguage || previousLanguage);
      setSystemError(toUserFacingError((e as any)?.message, ui("언어 변환에 실패했어.", "Language conversion failed."), uiLanguage));
      setBusyPhase("planning");
      setStatus(returnStatus);
    }
  };

  const openPageScriptEditor = (pageIndex: number) => {
    if (!seriesPlan) return;
    const page = seriesPlan.pages.find((p) => p.page.index === pageIndex) || seriesPlan.pages[pageIndex - 1];
    if (!page) return;
    setPageScriptDraft(deepClone(page));
    setPageScriptEditorOpen(true);
  };

  const closePageScriptEditor = () => {
    setPageScriptEditorOpen(false);
    setPageScriptDraft(null);
  };

  const openPageEditAction = (pageIndex: number) => {
    setPageEditTargetIndex(pageIndex);
    setPageEditActionOpen(true);
  };

  const closePageEditAction = () => {
    setPageEditActionOpen(false);
    setPageEditTargetIndex(null);
  };

  const openPageStyleEditor = (pageIndex: number) => {
    setPageStyleTargetIndex(pageIndex);
    setPageStyleEditorOpen(true);
  };

  const closePageStyleEditor = () => {
    setPageStyleEditorOpen(false);
    setPageStyleTargetIndex(null);
  };

  const clearPageStyleOverride = () => {
    const pageIndex = pageStyleTargetIndex;
    if (!pageIndex) return;
    setPageStyleOverrides((prev) => {
      const next = { ...prev };
      delete next[pageIndex];
      return next;
    });
    setPageStyleEditedAt((prev) => ({ ...prev, [pageIndex]: Date.now() }));
    closePageStyleEditor();
  };

  const savePageStyle = async (
    style: SeriesSpec["anchors"]["style"],
    scope: "page" | "all",
    opts: { redraw: boolean }
  ) => {
    if (!seriesPlan) return;
    const pageIndex = pageStyleTargetIndex;
    if (!pageIndex) return;
    const now = Date.now();

    if (scope === "page") {
      setPageStyleOverrides((prev) => ({ ...prev, [pageIndex]: style }));
      setPageStyleEditedAt((prev) => ({ ...prev, [pageIndex]: now }));
    } else {
      setSeriesPlan((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          series_spec: {
            ...prev.series_spec,
            anchors: { ...prev.series_spec.anchors, style }
          }
        };
      });
      setFinalStyle(style);
      setGlobalStyleEditedAt(now);
      setPageStyleOverrides({});
      setPageStyleEditedAt({});
    }

    closePageStyleEditor();

    if (opts.redraw) {
      await generatePage(pageIndex, undefined, style, { allowConcurrent: true });
    }
  };

  const persistPageScriptDraft = (draft: PageSpec) => {
    const pageIndex = draft.page.index;
    setSeriesPlan((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        pages: prev.pages.map((p) => (p.page.index === pageIndex ? draft : p))
      };
    });
    setPageScriptEditedAt((prev) => ({ ...prev, [pageIndex]: Date.now() }));
  };

  const savePageScript = () => {
    if (!pageScriptDraft) return;
    persistPageScriptDraft(pageScriptDraft);
    closePageScriptEditor();
  };

  const saveAndRedrawPageScript = async () => {
    if (!pageScriptDraft) return;
    const draft = pageScriptDraft;
    persistPageScriptDraft(draft);
    closePageScriptEditor();
    await generatePage(draft.page.index, draft, undefined, { allowConcurrent: true });
  };

  const generatePage = async (
    pageIndex: number,
    overridePage?: PageSpec,
    overrideStyle?: SeriesSpec["anchors"]["style"],
    options?: { allowConcurrent?: boolean }
  ): Promise<boolean> => {
    if (!seriesPlan) return false;
    const runId = generationRunIdRef.current;
    const page = overridePage || seriesPlan.pages.find((p) => p.page.index === pageIndex);
    if (!page) return false;
    const allowConcurrent = options?.allowConcurrent === true;
    if (!startPageGeneration(pageIndex, allowConcurrent)) return false;
    const abortController = new AbortController();
    generationAbortControllersRef.current.add(abortController);
    const styleForThisCall = overrideStyle || pageStyleOverrides[pageIndex] || null;
    let resolvedSeriesSpec: SeriesSpec = styleForThisCall
      ? {
        ...seriesPlan.series_spec,
        anchors: { ...seriesPlan.series_spec.anchors, style: styleForThisCall }
      }
      : seriesPlan.series_spec;

    const styleConsistencyImage = useCrossPageStyleConsistency && !styleForThisCall
      ? pageResults
        .filter((r) => r.page_index !== pageIndex && r.composed_image_url?.startsWith("data:"))
        .sort((a, b) => {
          const diffA = Math.abs(a.page_index - pageIndex);
          const diffB = Math.abs(b.page_index - pageIndex);
          if (diffA !== diffB) return diffA - diffB;
          return a.page_index - b.page_index;
        })[0]?.composed_image_url || null
      : null;

    setStatus(AppStatus.GENERATING_PANELS);
    setGenerationPhaseMessage(ui(`${unitLabel} ${pageIndex} 이미지 요청 중...`, `${unitLabel} ${pageIndex} image request...`));
    setPageErrors((prev) => {
      if (!prev[pageIndex]) return prev;
      const next = { ...prev };
      delete next[pageIndex];
      return next;
    });

    try {
      const compressedStyleConsistencyImage = styleConsistencyImage
        ? await compressReferenceDataUrl(styleConsistencyImage)
        : null;
      const pageImageUrl = await (await loadRendererService()).generateFullPageImage(resolvedSeriesSpec, page, imageSize, comicMode, {
        styleConsistencyImage: compressedStyleConsistencyImage,
        imageProvider,
        codexImageQuality,
        codexImageModel,
        signal: abortController.signal,
        onPhase: (phase) => {
          if (phase === "retry") {
            setGenerationPhaseMessage(ui(`${unitLabel} ${pageIndex} 재시도 중...`, `${unitLabel} ${pageIndex} retrying...`));
          } else {
            setGenerationPhaseMessage(ui(`${unitLabel} ${pageIndex} 이미지 요청 중...`, `${unitLabel} ${pageIndex} image request...`));
          }
        }
      });
      if (generationRunIdRef.current !== runId) return false;
      setPageResults((prev) => upsertGenerationResult(prev, {
        page_index: pageIndex,
        composed_image_url: pageImageUrl
      }));
      setPageRenderedAt((prev) => ({ ...prev, [pageIndex]: Date.now() }));
      setPageRenderedImageSize((prev) => ({ ...prev, [pageIndex]: imageSize }));
      setPageRenderedEngineKey((prev) => ({
        ...prev,
        [pageIndex]: buildImageEngineKey(imageProvider, codexImageModel, codexImageQuality)
      }));
      setSystemError(null);
      return true;
    } catch (e) {
      console.error(e);
      if (generationRunIdRef.current !== runId) return false;
      const message = toUserFacingError(
        (e as any)?.message,
        isKlingI2VFormat(publicationFormat)
          ? ui("프레임 생성에 실패했어.", "Frame generation failed.")
          : ui("페이지 생성에 실패했어.", "Page generation failed."),
        uiLanguage
      );
      setPageErrors((prev) => ({ ...prev, [pageIndex]: message }));
      setSystemError(message);
      return false;
    } finally {
      generationAbortControllersRef.current.delete(abortController);
      finishPageGeneration(pageIndex);
      if (generationRunIdRef.current === runId && activePageGenerationIndexesRef.current.size === 0) {
        setGenerationPhaseMessage(null);
        setStatus(AppStatus.READY_TO_GENERATE);
      }
    }
  };

  useEffect(() => {
    if (!autoGeneratePages) return;
    if (regenerateAllPages) return;
    if (!seriesPlan) return;
    if (!(status === AppStatus.READY_TO_GENERATE || status === AppStatus.GENERATING_PANELS)) return;
    const canRunParallel = !useCrossPageStyleConsistency && !isKlingI2VFormat(publicationFormat);
    if (canRunParallel) {
      if (parallelAutoGenerateRunRef.current) return;

      const pendingPages = seriesPlan.pages.filter(
        (p) =>
          !pageResults.some((r) => r.page_index === p.page.index) &&
          !activePageGenerationIndexesRef.current.has(p.page.index)
      );
      if (pendingPages.length === 0) {
        setAutoGeneratePages(false);
        return;
      }

      const runId = generationRunIdRef.current;
      parallelAutoGenerateRunRef.current = true;
      setStatus(AppStatus.GENERATING_PANELS);
      setGenerationPhaseMessage(ui(`최대 ${MAX_PARALLEL_PAGE_GENERATIONS}장씩 이미지 요청 중...`, `Requesting up to ${MAX_PARALLEL_PAGE_GENERATIONS} images at a time...`));

      void (async () => {
        let cursor = 0;
        let failed = false;
        const workerCount = Math.min(MAX_PARALLEL_PAGE_GENERATIONS, pendingPages.length);
        const workers = Array.from({ length: workerCount }, async () => {
          while (cursor < pendingPages.length && generationRunIdRef.current === runId && autoGeneratePagesRef.current) {
            const page = pendingPages[cursor++];
            let ok = await generatePage(page.page.index, undefined, undefined, { allowConcurrent: true });
            if (!ok && generationRunIdRef.current === runId && autoGeneratePagesRef.current) {
              setGenerationPhaseMessage(ui(`${unitLabel} ${page.page.index} 실패분 재시도 중...`, `${unitLabel} ${page.page.index} retrying failed image...`));
              ok = await generatePage(page.page.index, undefined, undefined, { allowConcurrent: true });
            }
            if (!ok) failed = true;
          }
        });

        await Promise.all(workers);

        if (generationRunIdRef.current !== runId) return;
        parallelAutoGenerateRunRef.current = false;
        setAutoGeneratePages(false);
        if (activePageGenerationIndexesRef.current.size === 0) setStatus(AppStatus.READY_TO_GENERATE);
        if (failed) {
          setSystemError((prev) => prev || ui("일부 페이지 생성에 실패했어. 실패한 페이지만 다시 생성해줘.", "Some pages failed. Retry only the failed pages."));
        }
      })();
      return;
    }

    if (isProcessingPageIndex !== null) return;
    if (isGeneratingPageRef.current) return;

    const nextPage = seriesPlan.pages.find(p => !pageResults.some(r => r.page_index === p.page.index));
    if (!nextPage) {
      setAutoGeneratePages(false);
      return;
    }

    void (async () => {
      let ok = await generatePage(nextPage.page.index);
      if (!ok && autoGeneratePagesRef.current) {
        setGenerationPhaseMessage(ui(`${unitLabel} ${nextPage.page.index} 실패분 재시도 중...`, `${unitLabel} ${nextPage.page.index} retrying failed image...`));
        ok = await generatePage(nextPage.page.index);
      }
      if (!ok) setAutoGeneratePages(false);
    })();
  }, [autoGeneratePages, codexImageModel, imageProvider, imageSize, isProcessingPageIndex, codexImageQuality, pageResults, regenerateAllPages, seriesPlan, status, useCrossPageStyleConsistency, publicationFormat]);

  useEffect(() => {
    if (!regenerateAllPages) return;
    if (autoGeneratePages) return;
    if (!seriesPlan) return;
    if (!(status === AppStatus.READY_TO_GENERATE || status === AppStatus.GENERATING_PANELS)) return;
    if (isProcessingPageIndex !== null) return;
    if (isGeneratingPageRef.current) return;

    const total = seriesPlan.pages.length;
    if (regenerateCursor < 1 || regenerateCursor > total) {
      setRegenerateAllPages(false);
      setRegenerateCursor(1);
      return;
    }

    void (async () => {
      const ok = await generatePage(regenerateCursor);
      if (!ok) {
        setRegenerateAllPages(false);
        setRegenerateCursor(1);
        return;
      }
      setRegenerateCursor((prev) => prev + 1);
    })();
  }, [autoGeneratePages, codexImageModel, imageProvider, imageSize, isProcessingPageIndex, codexImageQuality, regenerateAllPages, regenerateCursor, seriesPlan, status]);

  useEffect(() => {
    let cancelled = false;

    if (!seriesPlan || !isWebtoon(publicationFormat) || pageResults.length === 0) {
      setWebtoonEpisodeResult(null);
      setIsBuildingWebtoonEpisode(false);
      return () => {
        cancelled = true;
      };
    }

    setIsBuildingWebtoonEpisode(true);
    void (async () => {
      try {
        const nextResult = await composeWebtoonEpisodeSegments(seriesPlan.pages, pageResults, imageSize);
        if (!cancelled) {
          setWebtoonEpisodeResult(nextResult);
        }
      } catch (e) {
        console.error("Webtoon episode compose failed", e);
        if (!cancelled) {
          setSystemError(ui("웹툰 세로 리더를 조립하지 못했어. 페이지 이미지는 그대로 유지돼.", "Could not assemble the vertical webtoon reader. Page images are preserved."));
          setWebtoonEpisodeResult(null);
        }
      } finally {
        if (!cancelled) setIsBuildingWebtoonEpisode(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [imageSize, pageResults, publicationFormat, seriesPlan]);

  const downloadImage = async (url: string, index: number) => {
    const fmtConfig = getFormatConfig(publicationFormat);
    const unit = fmtConfig.unitLabel.toLowerCase();
    const link = document.createElement('a');
    link.href = isInstatoon(publicationFormat)
      ? await (await loadPostprocessorService()).resizeImageToPngDataUrl(url, INSTATOON_EXPORT_WIDTH, INSTATOON_EXPORT_HEIGHT)
      : url;
    link.download = `toon_for_codex_${unit}_${index}.png`;
    link.click();
  };

  const downloadReferenceImage = (url: string, character: CharacterSpec, index: number) => {
    const safeName = String(character.name || (character.role === "protagonist" ? "protagonist" : "supporting"))
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 40) || "character";
    const link = document.createElement("a");
    link.href = url;
    link.download = `toon_for_codex_${safeName}_ref_${index + 1}.png`;
    link.click();
  };

  const downloadAllPagesAsZip = async () => {
    if (!seriesPlan) return;
    if (isDownloadingZip) return;

    const fmtConfig = getFormatConfig(publicationFormat);
    let images = seriesPlan.pages
      .map((p) => {
        const res = pageResults.find((r) => r.page_index === p.page.index);
        if (!res) return null;
        const episodeInfo = (seriesPlan.plan_meta?.quick_episode_split?.episodes || [])
          .find((episode: any) => p.page.index >= Number(episode.start_unit || episode.start_strip || 0) && p.page.index <= Number(episode.end_unit || episode.end_strip || 0));
        const episodePrefix = episodeInfo ? `episode_${String(episodeInfo.episode || 1).padStart(2, "0")}/` : "";
        const episodeStart = episodeInfo ? Number(episodeInfo.start_unit || episodeInfo.start_strip || 1) : 1;
        const slideIndex = Math.max(1, p.page.index - episodeStart + 1);
        const episodeEnd = episodeInfo ? Number(episodeInfo.end_unit || episodeInfo.end_strip || seriesPlan.pages.length) : seriesPlan.pages.length;
        const slideName = isInstatoon(publicationFormat)
          ? `${episodePrefix}slide_${String(slideIndex).padStart(2, "0")}_${p.page.index === episodeStart ? "cover" : p.page.index === episodeEnd ? "cta" : "card"}`
          : `${fmtConfig.unitLabel}_${p.page.index}_${p.page.chapter_title}`;
        return {
          name: slideName,
          url: res.composed_image_url
        };
      })
      .filter((v): v is { name: string; url: string } => Boolean(v));

    if (images.length === 0) {
      setSystemError(ui(`다운로드할 ${fmtConfig.unitLabelKo}이(가) 없어. 먼저 생성해줘.`, `No ${fmtConfig.unitLabel.toLowerCase()}s to download. Generate them first.`));
      return;
    }

    setSystemError(null);
    setIsDownloadingZip(true);
    try {
      if (isInstatoon(publicationFormat)) {
        images = await Promise.all(images.map(async (image) => ({
          ...image,
          url: await (await loadPostprocessorService()).resizeImageToPngDataUrl(image.url, INSTATOON_EXPORT_WIDTH, INSTATOON_EXPORT_HEIGHT)
        })));
      }
      const title = seriesPlan.series_spec.series.title || "InstaToon Studio";
      await (await loadPostprocessorService()).downloadAsZip(images, `${title}_${fmtConfig.id}_${images.length}${fmtConfig.unitLabel.toLowerCase()}s`);
    } catch (e) {
      console.error(e);
      setSystemError(toUserFacingError((e as any)?.message, ui("전체 다운로드에 실패했어.", "Full download failed."), uiLanguage));
    } finally {
      setIsDownloadingZip(false);
    }
  };

  const exportCodexHandoffZip = async () => {
    if (!seriesPlan) return;
    if (isExportingCodexHandoff) return;

    setSystemError(null);
    setIsExportingCodexHandoff(true);
    try {
      const files = (await loadCodexHandoffService()).buildCodexHandoffFiles({
        seriesPlan,
        imageSize,
        comicMode,
        codexImageQuality,
        codexImageModel,
        pageStyleOverrides,
        pageResults,
        useCrossPageStyleConsistency
      });
      const title = seriesPlan.series_spec.series.title || "InstaToon Studio";
      (await loadPostprocessorService()).downloadFilesAsZip(files, `${title}_codex_handoff_${seriesPlan.pages.length}pages`);
    } catch (e) {
      console.error(e);
      setSystemError(toUserFacingError((e as any)?.message, ui("Codex 제작 묶음 내보내기에 실패했어.", "Codex handoff export failed."), uiLanguage));
    } finally {
      setIsExportingCodexHandoff(false);
    }
  };

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setSystemError(null);
    } catch (e) {
      console.warn("Clipboard copy failed", e);
      setSystemError(ui("클립보드 복사에 실패했어. 브라우저 권한을 확인해줘.", "Clipboard copy failed. Check browser permissions."));
    }
  };

  const castProtagonists = cast.filter((c) => c.role === "protagonist");
  const castSupporting = cast.filter((c) => c.role === "supporting");
  const activeLongformProject = longformProjects.find((p) => p.id === activeLongformProjectId) || null;
  const selectedLongformProject = longformProjects.find((p) => p.id === selectedLongformProjectId) || null;
  const activeLongformCharactersById = new Map<string, CharacterSpec>(
    (activeLongformProject?.snapshot.cast || []).map((c): [string, CharacterSpec] => [c.id, c])
  );
  const isPaperSelected = creationType === "paper";
  const isI2VSelected = isKlingI2VFormat(publicationFormat);
  const isLearningComicSelected = isLearningComic(publicationFormat);
  const isWebtoonSelected = isWebtoon(publicationFormat);
  const currentFormatConfig = getFormatConfig(publicationFormat);
  const unitLabel = uiLanguage === "ko" ? currentFormatConfig.unitLabelKo : currentFormatConfig.unitLabel;
  const previewAspectClass = getPreviewAspectClass(publicationFormat, i2vAspectRatio);
  const showNarrativeText = outputReaderMode === "visual_plus_script";
  const currentImageEngineKey = buildImageEngineKey(imageProvider, codexImageModel, codexImageQuality);
  const currentImageEngineLabel = getImageEngineLabel(imageProvider, codexImageModel, codexImageQuality);
  const imageSizeSummary = imageSize === "1K"
    ? ui("1K 빠름", "1K fast")
    : imageSize === "2K"
      ? ui("2K 선명", "2K sharp")
      : ui("4K 고해상도", "4K high-res");
  const imageQualitySummary = codexImageQuality === "low"
    ? ui("품질 빠르게", "quick quality")
    : codexImageQuality === "high"
      ? ui("품질 높게", "high quality")
      : ui("품질 보통", "normal quality");
  const readerModeSummary = outputReaderMode === "visual_plus_script"
    ? ui("이미지+장면 텍스트", "image + scene text")
    : ui("이미지만 보기", "images only");
  const planningElapsedSeconds = status === AppStatus.PLANNING && busyStartedAt
    ? Math.max(0, Math.floor((busyNow - busyStartedAt) / 1000))
    : 0;
  const planningEstimatedSeconds = estimatePlanningSeconds({
    busyPhase,
    creationType,
    targetPageCount,
    scriptDetail,
    geminiReasoningEffort,
    layoutVariety,
    pageCountMode
  });
  const planningProgressDetail = getPlanningProgressDetail({
    busyPhase,
    creationType,
    elapsedSeconds: planningElapsedSeconds,
    estimatedSeconds: planningEstimatedSeconds,
    uiLanguage
  });
  const generatedProgressLabel = seriesPlan
    ? `${pageResults.length}/${seriesPlan.pages.length} ${isI2VSelected ? ui("프레임", "frames") : ui("페이지", "pages")}`
    : "";
  const pageErrorEntries = Object.entries(pageErrors)
    .map(([pageIndex, message]) => ({ pageIndex: Number(pageIndex), message }))
    .filter((entry) => Number.isFinite(entry.pageIndex) && Boolean(entry.message))
    .sort((a, b) => a.pageIndex - b.pageIndex);
  const failedUnitCount = pageErrorEntries.length;
  const pageResultsMap = new Map<number, GenerationResult>(pageResults.map((result) => [result.page_index, result]));
  const quickPipelineElapsedSeconds = quickPipelineProgress
    ? Math.max(0, Math.floor((busyNow - quickPipelineProgress.startedAt) / 1000))
    : 0;
  const quickPipelineStageElapsedSeconds = quickPipelineProgress
    ? Math.max(0, Math.floor((busyNow - quickPipelineProgress.stageStartedAt) / 1000))
    : 0;
  const quickStageLabel = (stage: QuickPipelineStage | string | undefined): string => {
    const labels: Record<QuickPipelineStage, string> = {
      idle: ui("대기", "Idle"),
      digest: ui("자료 정리", "Digest"),
      cast: ui("캐릭터 제안", "Cast"),
      plan: ui("콘티 생성", "Plan"),
      images: ui("이미지 생성", "Images"),
      complete: ui("완료", "Complete"),
      error: ui("오류", "Error")
    };
    return labels[(stage || "idle") as QuickPipelineStage] || String(stage || "");
  };
  const quickFormatLabel = (format: QuickPipelinePublicationFormat): string => {
    if (format === "instatoon") return ui("인스타툰", "Instatoon");
    if (format === "webtoon") return ui("웹툰", "Webtoon");
    return ui("학습만화", "Learning Comic");
  };
  const quickPipelinePercent = quickPipelineProgress
    ? quickPipelineProgress.stage === "complete"
      ? 100
      : quickPipelineProgress.stage === "error"
        ? 100
        : quickPipelineProgress.stage === "images" && quickPipelineProgress.totalPages
          ? Math.max(70, Math.min(98, 70 + Math.round(((quickPipelineProgress.completedPages || 0) / quickPipelineProgress.totalPages) * 28)))
          : quickPipelineProgress.stage === "plan"
            ? 60
            : quickPipelineProgress.stage === "cast"
              ? 38
              : quickPipelineProgress.stage === "digest"
                ? 18
                : 4
    : 0;
  const rawWebtoonFallbackSegments = (seriesPlan?.pages || [])
    .filter((page) => pageResultsMap.has(page.page.index))
    .map((page) => ({
      pageIndex: page.page.index,
      url: pageResultsMap.get(page.page.index)?.composed_image_url || "",
    }))
    .filter((segment) => Boolean(segment.url));
  const nextPendingPage = seriesPlan?.pages.find((page) => !pageResultsMap.has(page.page.index)) || null;
  const canParallelAutoGeneratePages = !useCrossPageStyleConsistency && !isI2VSelected;
  const generatedPageCount = pageResults.length;
  const isTopicRequiredMissing = creationType === "educational" && !topic.trim();
  const storyInputMeetsMinimum = scriptText.trim().length >= STORY_MIN_INPUT_CHARS;
  const isScenarioStoryInput = creationType === "story" && storyInputType === "scenario";
  const canUseStoryDirectly = creationType === "story" && storyInputType !== "scenario";
  const hasRequiredStoryAdaptation = !isScenarioStoryInput || (storyAdaptationMode === "analyzed" && Boolean(storyDigestText.trim()));
  const canProceedMissionSetup =
    creationType === "story"
      ? storyInputMeetsMinimum && !isStoryAnalyzing && hasRequiredStoryAdaptation
      : creationType === "paper"
        ? Boolean(paperBrief) && !isPaperAnalyzing
        : (
          Boolean(topic.trim()) &&
          !isResearchAnalyzing &&
          Boolean(researchDigestText.trim())
        );
  const canProceedCharacterSetup =
    castProtagonists.length > 0 &&
    castProtagonists.some((c) => Boolean(String(c.appearance || "").trim() || String(c.name || "").trim() || (c.reference_images || []).length > 0));
  const canGeneratePlan =
    canProceedMissionSetup &&
    canProceedCharacterSetup &&
    stylePresets.length > 0 &&
    hasApiKey;
  const canRunQuickPipeline = !isQuickPipelineRunning && hasApiKey && Boolean(topic.trim() || researchReportText.trim() || researchReportFile || quickPipelineSourceFiles.length > 0 || quickPipelineSourceJobs.length > 0);
  const selectedStylePresetForDisplay = stylePresets.find((p) => p.id === selectedPresetId);
  const styleSampleResultList = stylePresets.map((preset) => styleSampleResults[preset.id] || { presetId: preset.id, status: "idle" as StyleSampleStatus });
  const styleSampleSuccessCount = styleSampleResultList.filter((result) => result.status === "success").length;
  const styleSampleRunningCount = styleSampleResultList.filter((result) => result.status === "running").length;
  const styleSampleErrorCount = styleSampleResultList.filter((result) => result.status === "error").length;
  const styleSampleMissingCount = styleSampleResultList.filter((result) => result.status === "idle" || (result.status !== "success" && !result.imageUrl)).length;
  const canGenerateStyleSamples = hasApiKey && stylePresets.length > 0 && !isGeneratingStyleSamples;

  if (!hasApiKey) {
    const isOauthIssue = localStudioIssue === "oauth";
    const title = isOauthIssue
        ? ui("Codex 로그인 필요", "Codex Login Required")
        : ui("로컬 스튜디오 오프라인", "Local Studio Offline");
    const action = isOauthIssue
        ? "npx @openai/codex login"
        : "npm run dev";
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6 text-center">
        <div className="bg-white border-4 border-black p-8 comic-shadow max-w-md w-full">
          <Key className="w-16 h-16 mx-auto mb-4 text-blue-600" />
          <h1 className="text-2xl font-black mb-4 uppercase">{title}</h1>
          <p className="text-sm font-bold text-slate-500 mb-6">
            {isOauthIssue
              ? ui("로컬 API는 켜져 있는데 Codex OAuth가 아직 준비되지 않았어. 터미널에서", "The local API is running, but Codex OAuth is not ready. Run")
              : ui("로컬 서버가 필요해.", "Local server is required.")}
            {" "}
            <span className="font-black">{action}</span>
            {isOauthIssue
              ? ui("을 실행한 뒤 새로고침해줘.", " and refresh.")
              : ui("로 실행하고, Codex 로그인이 안 되어 있으면 터미널에서 npx @openai/codex login을 먼저 실행해줘.", " should be running. If Codex is not logged in, run npx @openai/codex login first.")}
          </p>
        </div>
      </div>
    );
  }

  const buildDevPromptSettingsSummary = (plan: SeriesPlan | null): string => {
    if (!plan) return "";
    const detailLevelNumeric = Number(plan.plan_meta?.detail_level);
    const detailLabel = detailLevelNumeric === 0 ? "brief" : detailLevelNumeric === 2 ? "detailed" : "normal";
    const deliveryLabel = getDeliveryStyleLabel(deliveryStyleId, uiLanguage);
    const createdAt =
      plan.debug?.created_at ? new Date(plan.debug.created_at).toLocaleString() : "";

    const lines: string[] = [];
    lines.push(`created_at: ${createdAt || "(unknown)"}`);
    lines.push(`topic: ${topic || "(empty)"}`);
    lines.push(`comic_mode: ${comicMode} (${getComicModeDisplayLabel(comicMode)})`);
    lines.push(`publication_format: ${publicationFormat}`);
    lines.push(`i2v_aspect_ratio: ${i2vAspectRatio}`);
    lines.push(`tone_mode: ${toneMode}${toneMode === "gag" ? `(${toneLevel})` : ""}`);
    lines.push(`audience_level: ${audienceLevel}`);
    lines.push(`research_mode: ${researchMode}`);
    lines.push(`planner_model: ${GEMINI_PLANNER_MODEL}`);
    lines.push(`planner_reasoning_effort: ${geminiReasoningEffort}`);
    lines.push(`narrative_role: ${narrativeRole}`);
    lines.push(`detail_level: ${detailLabel} (${Number.isFinite(detailLevelNumeric) ? detailLevelNumeric : "?"})`);
    lines.push(`language: ${plan.series_spec.series.language}`);
    lines.push(`page_count: ${plan.series_spec.series.page_count}`);
    lines.push(`layout_variety: ${plan.series_spec.constraints.layout_variety}`);
    lines.push(`image_size: ${plan.series_spec.constraints.image_size}`);
    lines.push(`image_model: ${currentImageEngineLabel}`);
    lines.push(`character_consistency_mode: ${plan.series_spec.constraints.character_consistency_mode || "loose"}`);
    lines.push(`cross_page_style_consistency: ${useCrossPageStyleConsistency ? "on" : "off"}`);
    lines.push(`style_preset: ${plan.series_spec.anchors.style.preset_label} (${plan.series_spec.anchors.style.preset_id})`);
    lines.push(`delivery_style: ${deliveryLabel}`);
    return lines.join("\n");
  };

  return (
    <div className="min-h-screen bg-[#f5f5f5] text-gray-900 p-4 md:p-6 pb-24 font-sans">
      <div className="max-w-6xl mx-auto">
        <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between mb-8 md:mb-12 border-b-4 border-black pb-6">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2 border-2 border-black rotate-3">
              <BookOpen className="text-white w-6 h-6" />
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h1 className="text-2xl md:text-4xl font-black italic tracking-tighter uppercase">
                InstaToon <span className="text-pink-600">Studio</span>
              </h1>
              <span className="border-2 border-black bg-white px-2 py-1 text-[10px] md:text-xs font-black uppercase tracking-normal">
                Creator Edition
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 self-end md:self-auto">
            <div className="flex overflow-hidden border-2 border-black bg-white">
              <button
                type="button"
                onClick={() => setUiLanguage("ko")}
                className={`px-3 py-2 text-[10px] md:text-xs font-black uppercase border-r-2 border-black ${uiLanguage === "ko" ? "bg-black text-white" : "bg-white hover:bg-slate-100"}`}
                aria-pressed={uiLanguage === "ko"}
              >
                {ui("한국어", "KO")}
              </button>
              <button
                type="button"
                onClick={() => setUiLanguage("en")}
                className={`px-3 py-2 text-[10px] md:text-xs font-black uppercase ${uiLanguage === "en" ? "bg-black text-white" : "bg-white hover:bg-slate-100"}`}
                aria-pressed={uiLanguage === "en"}
              >
                EN
              </button>
            </div>
            <button onClick={resetApp} className="border-2 border-black px-3 py-2 md:px-4 bg-white font-black text-[10px] md:text-xs flex items-center gap-2 hover:bg-slate-100"><RotateCcw size={14} /> {ui("새로 시작", "New")}</button>
          </div>
        </header>

        <div className="mb-8 bg-white border-4 border-black p-4 md:p-5 comic-shadow">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-[10px] font-black uppercase text-blue-700 flex items-center gap-2">
                <Bookmark size={14} /> {ui("프로젝트 보관함", "Project Library")}
              </p>
              {activeProjectId ? (
                <p className="text-[10px] font-black text-slate-700 mt-2">
                  {ui("현재 연결된 프로젝트", "Current project")}: {savedProjects.find((p) => p.id === activeProjectId)?.label || ui("(알 수 없음)", "(unknown)")}
                </p>
              ) : (
                <p className="text-[10px] font-bold text-slate-400 mt-2">{ui("현재는 새 프로젝트 상태야.", "This is a new project.")}</p>
              )}
              {projectArchiveError ? (
                <p className="mt-2 text-[10px] font-black text-red-600">
                  {projectArchiveError}
                </p>
              ) : (
                <p className="mt-2 text-[10px] font-bold text-slate-400">
                  {hasApiKey
                    ? ui("로컬 파일 보관함에 저장돼.", "Saved to the local file archive.")
                    : ui("로컬 서버 연결 전에는 브라우저 임시 저장만 사용해.", "Browser fallback is used until the local server connects.")}
                </p>
              )}
            </div>
            <div className="w-full md:w-auto">
              <div className="grid grid-cols-1 md:grid-cols-[360px_auto_auto_auto] gap-2">
                <select
                  value={selectedSavedProjectId}
                  onChange={(e) => setSelectedSavedProjectId(e.target.value)}
                  className="w-full border-2 border-black px-3 py-2 font-black outline-none focus:bg-white text-[10px] md:text-xs bg-white"
                >
                  <option value="">
                    {savedProjects.length > 0 ? ui("(저장된 프로젝트 선택)", "(Select saved project)") : ui("(저장된 프로젝트 없음)", "(No saved projects)")}
                  </option>
                  {savedProjects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} · {new Date(p.updated_at).toLocaleString()}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => loadSavedProject(selectedSavedProjectId)}
                  disabled={!selectedSavedProjectId}
                  className="border-2 border-black bg-white px-3 py-2 font-black flex items-center justify-center gap-2 hover:bg-slate-100 transition-colors text-[10px] md:text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                  title={ui("저장한 프로젝트 불러오기", "Load saved project")}
                >
                  <FolderOpen size={14} /> {ui("불러오기", "Load")}
                </button>
                <button
                  type="button"
                  onClick={promptSaveProject}
                  disabled={!seriesPlan}
                  className="bg-black text-white px-3 py-2 font-black flex items-center justify-center gap-2 hover:bg-blue-600 transition-colors text-[10px] md:text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                  title={ui("현재 프로젝트 즉시 저장", "Save current project")}
                >
                  <Save size={14} /> {ui("저장", "Save")}
                </button>
                <button
                  type="button"
                  onClick={() => deleteSavedProject(selectedSavedProjectId)}
                  disabled={!selectedSavedProjectId}
                  className="border-2 border-black bg-white px-3 py-2 font-black flex items-center justify-center gap-2 hover:bg-slate-100 transition-colors text-[10px] md:text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                  title={ui("선택된 프로젝트 삭제", "Delete selected project")}
                >
                  <Trash2 size={14} /> {ui("삭제", "Delete")}
                </button>
              </div>
            </div>
          </div>
        </div>

        <PageScriptEditorModal
          open={pageScriptEditorOpen}
          page={pageScriptDraft}
          uiLanguage={uiLanguage}
          isI2V={isI2VSelected}
          isBusy={status === AppStatus.GENERATING_PANELS}
          onClose={closePageScriptEditor}
          onChange={(next) => setPageScriptDraft(next)}
          onSave={savePageScript}
          onSaveAndRedraw={
            status === AppStatus.READY_TO_GENERATE || status === AppStatus.GENERATING_PANELS
              ? saveAndRedrawPageScript
              : undefined
          }
        />

        <PageEditActionModal
          open={pageEditActionOpen}
          pageIndex={pageEditTargetIndex}
          uiLanguage={uiLanguage}
          onClose={closePageEditAction}
          onEditScript={() => {
            const idx = pageEditTargetIndex;
            closePageEditAction();
            if (idx) openPageScriptEditor(idx);
          }}
          onEditStyle={() => {
            const idx = pageEditTargetIndex;
            closePageEditAction();
            if (idx) openPageStyleEditor(idx);
          }}
        />

        <PageStyleEditorModal
          open={pageStyleEditorOpen}
          pageIndex={pageStyleTargetIndex}
          uiLanguage={uiLanguage}
          presets={stylePresets}
          initialStyle={
            pageStyleTargetIndex && seriesPlan
              ? pageStyleOverrides[pageStyleTargetIndex] || seriesPlan.series_spec.anchors.style
              : null
          }
          hasPageOverride={Boolean(pageStyleTargetIndex && pageStyleOverrides[pageStyleTargetIndex])}
          isBusy={status === AppStatus.GENERATING_PANELS}
          onClose={closePageStyleEditor}
          onClearPageOverride={
            pageStyleTargetIndex && pageStyleOverrides[pageStyleTargetIndex] ? clearPageStyleOverride : undefined
          }
          onSave={savePageStyle}
        />

        <DevPromptCheckModal
          open={devPromptCheckOpen}
          plan={seriesPlan}
          settingsSummary={buildDevPromptSettingsSummary(seriesPlan)}
          uiLanguage={uiLanguage}
          onClose={() => setDevPromptCheckOpen(false)}
        />

        {status === AppStatus.CHARACTER_SELECT && (
          <div className="bg-white border-4 border-black p-6 md:p-10 comic-shadow animate-fade-in">
            <div className="mb-3">
              <PreviousStepButton />
            </div>
            <h2 className="text-2xl md:text-3xl font-black mb-6 md:mb-8 border-l-8 border-blue-600 pl-4 uppercase">{ui("03. 캐릭터 설정", "03. Setup Character")}</h2>
            <div className="mb-8 border-2 border-blue-600 bg-blue-50 px-4 py-3 text-[10px] md:text-xs font-black text-blue-900 uppercase flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
              <span>{ui("선택된 그림체", "Selected Style")}</span>
	              <span>{selectedStylePresetForDisplay ? getStylePresetDisplayLabel(selectedStylePresetForDisplay, uiLanguage) : selectedPresetId}</span>
            </div>

            <div className="mb-8 border-2 border-indigo-600 bg-indigo-50 p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-xs font-black text-indigo-800 uppercase flex items-center gap-2">
                    <BookOpen size={15} /> {ui("캐릭터 보관함", "Character Library")}
                  </p>
                  <p className="mt-1 text-[10px] font-bold text-slate-600">
	                    {activeLongformProject
	                      ? ui(`${activeLongformProject.label} · 보관 캐릭터 ${activeLongformProject.snapshot.cast.length}명`, `${activeLongformProject.label} · ${activeLongformProject.snapshot.cast.length} saved characters`)
	                      : productionMode === "new_longform"
	                        ? ui("1화 캐릭터와 그림체가 정해지면 여기서 장편 보관함을 만들어.", "Once episode 1 cast and style are set, create the longform library here.")
	                        : ui("현재 캐릭터와 그림체를 장편 프로젝트로 저장할 수 있어.", "Save the current cast and style as a longform project.")}
                  </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 w-full md:w-auto">
                  <button
                    type="button"
                    onClick={() => promptSaveLongformProject(false)}
                    className="bg-black text-white px-4 py-2 text-[10px] font-black border-2 border-black hover:bg-indigo-700 transition-colors flex items-center justify-center gap-2"
                  >
	                    <Save size={14} /> {activeLongformProject ? ui("보관함 업데이트", "Update Library") : productionMode === "new_longform" ? ui("새 장편 시작 저장", "Save New Longform") : ui("장편 저장", "Save Longform")}
                  </button>
                  <button
                    type="button"
                    onClick={() => promptSaveLongformProject(true)}
                    className="border-2 border-black bg-white px-4 py-2 text-[10px] font-black hover:bg-slate-100 transition-colors flex items-center justify-center gap-2"
                  >
                    <Plus size={14} /> {ui("새 장편으로 저장", "Save As New")}
                  </button>
                </div>
              </div>
              {longformNotice && (
                <div
                  className={`mt-3 border-2 p-3 text-[10px] font-bold ${
                    longformNotice.kind === "error"
                      ? "border-red-500 bg-red-50 text-red-900"
                      : longformNotice.kind === "success"
                        ? "border-emerald-600 bg-emerald-50 text-emerald-900"
                        : "border-indigo-600 bg-white text-slate-800"
                  }`}
                >
                  <p className="font-black">{longformNotice.message}</p>
                  {longformNotice.detail && <p className="mt-1 whitespace-pre-wrap">{longformNotice.detail}</p>}
                </div>
              )}
            </div>

            <div className="mb-8 p-6 bg-slate-50 border-2 border-black">
              <p className="text-sm font-black text-gray-700 uppercase mb-4 flex items-center gap-2">
                <UserCheck size={18} className="text-blue-600" /> {ui("캐릭터 만드는 방법", "Character Setup Method")}
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <button
                  type="button"
                  onClick={() => setCharacterInputMode("suggest")}
                  className={`flex items-start gap-4 p-4 border-4 transition-all ${characterInputMode === "suggest" ? "border-blue-600 bg-blue-50" : "border-black bg-white hover:bg-gray-50"}`}
                >
                  <div className="bg-blue-600 text-white p-2 rounded-lg"><Wand2 size={20} /></div>
                  <div className="text-left">
                    <p className="font-black text-sm uppercase">{ui("캐릭터 제안 받기", "Suggest Characters")}</p>
                    <p className="mt-1 text-[10px] font-bold text-slate-500 leading-relaxed">
                      {ui("자료에서 실제 등장인물 후보를 먼저 뽑아.", "Draft character candidates from your material first.")}
                    </p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setCharacterInputMode("manual")}
                  className={`flex items-start gap-4 p-4 border-4 transition-all ${characterInputMode === "manual" ? "border-blue-600 bg-blue-50" : "border-black bg-white hover:bg-gray-50"}`}
                >
                  <div className="bg-black text-white p-2 rounded-lg"><User size={20} /></div>
                  <div className="text-left">
                    <p className="font-black text-sm uppercase">{ui("직접 캐릭터 채우기", "Fill Characters Manually")}</p>
                    <p className="mt-1 text-[10px] font-bold text-slate-500 leading-relaxed">
                      {ui("이름을 빠르게 넣거나 아래 카드에서 직접 작성해.", "Add names quickly or fill the cards below.")}
                    </p>
                  </div>
                </button>
              </div>
            </div>

            {characterInputMode === "suggest" && (
            <div className="mb-8 p-6 bg-yellow-50 border-2 border-black">
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div>
                  <p className="text-sm font-black text-gray-800 uppercase mb-2 flex items-center gap-2">
                    <Wand2 size={18} className="text-yellow-600" /> {ui("자료에서 캐릭터 제안", "Suggest Characters from Material")}
                  </p>
                  <p className="text-[10px] md:text-xs font-bold text-slate-600 leading-relaxed">
                    {ui("원문 안의 행동, 관계, 호칭 단서로만 주연과 반복 출연자를 채워.", "Uses only source cues such as actions, relationships, and titles.")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void applyContentCastSuggestions()}
                  disabled={isSuggestingCastFromContent || isProcessing}
                  className="bg-black text-white px-5 py-3 font-black flex items-center justify-center gap-2 hover:bg-blue-600 transition-colors text-[10px] md:text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSuggestingCastFromContent ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
                  {isSuggestingCastFromContent ? ui("제안 중", "Suggesting") : ui("AI 제안 받기", "Get AI Suggestions")}
                </button>
              </div>
              {castSuggestionNotice && (
                <div
                  className={`mt-5 border-2 p-3 text-[10px] md:text-xs font-bold whitespace-pre-wrap ${
                    castSuggestionNotice.kind === "error"
                      ? "border-red-500 bg-red-50 text-red-900"
                      : castSuggestionNotice.kind === "success"
                        ? "border-emerald-600 bg-emerald-50 text-emerald-900"
                        : "border-yellow-600 bg-white text-slate-800"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {castSuggestionNotice.kind === "error" ? <AlertTriangle size={15} className="mt-0.5 shrink-0" /> : castSuggestionNotice.kind === "success" ? <CheckCircle2 size={15} className="mt-0.5 shrink-0" /> : <Loader2 size={15} className="mt-0.5 shrink-0 animate-spin" />}
                    <div className="min-w-0">
                      <p className="font-black">{castSuggestionNotice.message}</p>
                      {castSuggestionNotice.detail && (
                        <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed">{castSuggestionNotice.detail}</pre>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
            )}

            <div className="mb-8 grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="p-6 bg-slate-50 border-2 border-black">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-4">
                  <p className="text-sm font-black text-gray-700 uppercase flex items-center gap-2"><UserCheck size={18} className="text-blue-600" /> {ui("주인공 역할", "Protagonist Role")}</p>
                  <span className="w-fit border-2 border-blue-600 bg-blue-50 px-3 py-1 text-[10px] font-black text-blue-700 uppercase">
                    {ui("현재 모드 기본값", "Mode Default")}
                  </span>
                </div>
                {creationType === "educational" ? (
                  <div className="grid grid-cols-1 gap-3">
                    <div className="flex items-start gap-4 p-4 border-4 border-blue-600 bg-blue-50">
                      <div className="bg-blue-600 text-white p-2 rounded-lg"><MessageSquareText size={20} /></div>
                      <div className="text-left">
                        <p className="font-black text-sm uppercase">{ui("설명하는 가이드", "Guide / Narrator")}</p>
                        <p className="mt-1 text-[11px] font-bold text-slate-600">
                          {ui("학습만화는 이 역할로 고정돼. 궁금증을 따라가며 쉽게 풀어주는 방식으로 진행해.", "Learning comics stay on this role so the explanation can unfold clearly." )}
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3">
                    <button
                      type="button"
                      onClick={() => setNarrativeRole("narrator")}
                      className={`flex items-start gap-4 p-4 border-4 transition-all ${narrativeRole === "narrator" ? "border-blue-600 bg-blue-50" : "border-black bg-white hover:bg-gray-50"}`}
                    >
                      <div className="bg-blue-600 text-white p-2 rounded-lg"><MessageSquareText size={20} /></div>
                      <div className="text-left">
                        <p className="font-black text-sm uppercase">{ui("설명하는 가이드", "Guide / Narrator")}</p>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setNarrativeRole("actor")}
                      className={`flex items-start gap-4 p-4 border-4 transition-all ${narrativeRole === "actor" ? "border-blue-600 bg-blue-50" : "border-black bg-white hover:bg-gray-50"}`}
                    >
                      <div className="bg-black text-white p-2 rounded-lg"><User size={20} /></div>
                      <div className="text-left">
                        <p className="font-black text-sm uppercase">{ui("직접 연기하는 배우", "Actor / Performer")}</p>
                      </div>
                    </button>
                  </div>
                )}
              </div>

              <div className="p-6 bg-slate-50 border-2 border-black">
                <p className="text-sm font-black text-gray-700 uppercase mb-4 flex items-center gap-2">
                  <Layers size={18} className="text-blue-600" /> {ui("캐릭터 일관성", "Character Consistency")}
                </p>
                <div className="grid grid-cols-1 gap-3">
                  <button
                    type="button"
                    onClick={() => setCharacterConsistencyMode("loose")}
                    className={`flex items-start gap-4 p-4 border-4 transition-all ${characterConsistencyMode === "loose" ? "border-blue-600 bg-blue-50" : "border-black bg-white hover:bg-gray-50"}`}
                  >
                    <div className="bg-white border-2 border-black p-2 rounded-lg">
                      <p className="text-[10px] font-black uppercase">LOOSE</p>
                    </div>
                    <div className="text-left">
                      <p className="font-black text-sm uppercase">{ui("느슨", "Loose")}</p>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setCharacterConsistencyMode("strict")}
                    className={`flex items-start gap-4 p-4 border-4 transition-all ${characterConsistencyMode === "strict" ? "border-blue-600 bg-blue-50" : "border-black bg-white hover:bg-gray-50"}`}
                  >
                    <div className="bg-black text-white p-2 rounded-lg">
                      <p className="text-[10px] font-black uppercase">STRICT</p>
                    </div>
                    <div className="text-left">
                      <p className="font-black text-sm uppercase">{ui("엄격", "Strict")}</p>
                    </div>
                  </button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-10">
              <div className="bg-white border-4 border-black p-6 md:p-8">
                <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <p className="text-xs font-black text-slate-700 uppercase">{ui("주연(최대 2명)", "Lead Characters (Max 2)")}</p>
                    <p className="mt-2 text-[10px] md:text-xs font-bold text-slate-500 leading-relaxed">
                      {ui("주인공 1명만 있어도 다음 단계로 갈 수 있어.", "You can continue with just 1 lead character.")}
                    </p>
                  </div>
                  <div className="w-full md:w-[420px]">
                    <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2">
                      <select
                        value={selectedCastPresetId}
                        onChange={(e) => setSelectedCastPresetId(e.target.value)}
                        className="w-full border-2 border-black px-3 py-2 font-black outline-none focus:bg-white text-[10px] md:text-xs bg-white"
                      >
                        <option value="">
                          {castPresets.length > 0 ? ui("(프리셋 선택)", "(Select preset)") : ui("(저장된 프리셋 없음)", "(No saved presets)")}
                        </option>
                        {castPresets
                          .slice()
                          .sort((a, b) => b.updated_at - a.updated_at)
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.label}
                            </option>
                          ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => addCastMember("protagonist")}
                        disabled={castProtagonists.length >= 2}
                        className="bg-black text-white px-3 py-2 font-black flex items-center justify-center gap-2 hover:bg-blue-600 transition-colors text-[10px] md:text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Plus size={14} /> {ui("추가", "Add")}
                      </button>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => applyCastPresetToSection(selectedCastPresetId, "protagonist")}
                        disabled={!selectedCastPresetId}
                        className="border-2 border-black bg-white px-3 py-2 font-black flex items-center justify-center gap-2 hover:bg-slate-100 transition-colors text-[10px] md:text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                        title={ui("선택된 프리셋의 주연만 적용", "Apply only lead characters from selected preset")}
                      >
                        <FolderOpen size={14} /> {ui("프리셋 불러오기", "Load Preset")}
                      </button>
                      <button
                        type="button"
                        onClick={() => applyCastPreset(selectedCastPresetId)}
                        disabled={!selectedCastPresetId}
                        className="bg-black text-white px-3 py-2 font-black flex items-center justify-center gap-2 hover:bg-blue-600 transition-colors text-[10px] md:text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                        title={ui("선택된 프리셋을 주연+보조 전체에 적용", "Apply selected preset to lead and supporting cast")}
                      >
                        <FolderOpen size={14} /> {ui("전체 불러오기", "Load All")}
                      </button>
                      <button
                        type="button"
                        onClick={promptSaveCastPreset}
                        className="border-2 border-black bg-white px-3 py-2 font-black flex items-center justify-center gap-2 hover:bg-slate-100 transition-colors text-[10px] md:text-xs"
                        title={ui("현재 캐스트를 프리셋으로 저장", "Save current cast as preset")}
                      >
                        <Save size={14} /> {ui("프리셋 저장", "Save Preset")}
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteCastPreset(selectedCastPresetId)}
                        disabled={!selectedCastPresetId}
                        className="border-2 border-black bg-white px-3 py-2 font-black flex items-center justify-center gap-2 hover:bg-slate-100 transition-colors text-[10px] md:text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                        title={ui("선택된 프리셋 삭제", "Delete selected preset")}
                      >
                        <Trash2 size={14} /> {ui("삭제", "Delete")}
                      </button>
                    </div>
                  </div>
                </div>

                {castProtagonists.map((c) => (
                  <div key={c.id} className="mb-6 bg-slate-50 border-4 border-black p-4">
                    <div className="flex items-center justify-between mb-3">
                      <p className="font-black text-[10px] uppercase text-slate-700">{ui("주연", "Protagonist")}</p>
                      <button
                        type="button"
                        onClick={() => removeCastMember(c.id)}
                        className="border-2 border-black bg-white px-2 py-1 font-black hover:bg-slate-100 text-[10px] flex items-center gap-1"
                      >
                        <Trash2 size={14} /> {ui("삭제", "Remove")}
                      </button>
                    </div>

                    <input
                      type="text"
                      value={c.name}
                      onChange={(e) => updateCastMember(c.id, { name: e.target.value })}
                      placeholder={ui("이름/호칭 (예: 세종대왕)", "Name/title (e.g. King Sejong)")}
                      className="w-full border-2 border-black p-3 font-bold mb-3 outline-none focus:bg-white text-sm"
                    />
                    <textarea
                      value={c.appearance}
                      onChange={(e) => updateCastMember(c.id, { appearance: e.target.value })}
                      placeholder={ui("외형/복장 (예: 단정한 한복, 근엄한 표정, 왕관)", "Appearance/outfit (e.g. neat hanbok, stern face, crown)")}
                      className="w-full border-2 border-black p-3 font-bold mb-3 outline-none focus:bg-white text-sm min-h-[76px]"
                    />
                    <textarea
                      value={c.persona || ""}
                      onChange={(e) => updateCastMember(c.id, { persona: e.target.value })}
                      placeholder={ui('페르소나/관계/직업 (예: "장영실의 후원자")', 'Persona/relationship/job (e.g. "Jang Yeong-sil’s sponsor")')}
                      className="w-full border-2 border-black p-3 font-bold mb-3 outline-none focus:bg-white text-sm min-h-[76px]"
                    />

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                      <input
                        type="text"
                        value={c.catchphrase || ""}
                        onChange={(e) => updateCastMember(c.id, { catchphrase: e.target.value })}
                        placeholder={ui('말버릇(선택) (예: "자, 집중!")', 'Catchphrase (optional)')}
                        className="w-full border-2 border-black p-3 font-bold outline-none focus:bg-white text-sm"
                      />
                      <select
                        value={(c.catchphrase_frequency || "rare") as CatchphraseFrequency}
                        onChange={(e) => updateCastMember(c.id, { catchphrase_frequency: e.target.value as CatchphraseFrequency })}
                        className="w-full border-2 border-black p-3 font-black outline-none focus:bg-white text-sm"
                      >
                        <option value="rare">{ui("드물게", "Rarely")}</option>
                        <option value="sometimes">{ui("가끔", "Sometimes")}</option>
                        <option value="often">{ui("자주", "Often")}</option>
                      </select>
                    </div>

	                    {renderCharacterReferenceControls(c, {
	                      inputId: `cast-img-${c.id}`,
	                      displayName: String(c.name || "").trim(),
	                      altFallback: "protagonist",
	                      panelClassName: "bg-white border-2 border-black p-3",
	                      titleClassName: "text-[10px] font-black uppercase text-slate-600",
	                      countClassName: "text-[10px] font-bold text-slate-500"
	                    })}
                  </div>
                ))}
              </div>

              <div className="bg-blue-50 border-4 border-blue-200 p-6 md:p-8">
                <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <p className="text-xs font-black text-blue-600 uppercase">{ui("보조 출연자(반복 등장)", "Supporting Cast")}</p>
                  <div className="w-full md:w-[320px]">
                    <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2">
                      <select
                        value={selectedCastPresetId}
                        onChange={(e) => setSelectedCastPresetId(e.target.value)}
                        className="w-full border-2 border-black px-3 py-2 font-black outline-none focus:bg-white text-[10px] md:text-xs bg-white"
                      >
                        <option value="">
                          {castPresets.length > 0 ? ui("(프리셋 선택)", "(Select preset)") : ui("(저장된 프리셋 없음)", "(No saved presets)")}
                        </option>
                        {castPresets
                          .slice()
                          .sort((a, b) => b.updated_at - a.updated_at)
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.label}
                            </option>
                          ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => addCastMember("supporting")}
                        className="bg-black text-white px-3 py-2 font-black flex items-center justify-center gap-2 hover:bg-blue-600 transition-colors text-[10px] md:text-xs"
                      >
                        <Plus size={14} /> {ui("추가", "Add")}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => applyCastPresetToSection(selectedCastPresetId, "supporting")}
                      disabled={!selectedCastPresetId}
                      className="mt-2 w-full border-2 border-black bg-white px-3 py-2 font-black flex items-center justify-center gap-2 hover:bg-slate-100 transition-colors text-[10px] md:text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                      title={ui("선택된 프리셋의 보조 출연자만 적용", "Apply only supporting cast from selected preset")}
                    >
                      <FolderOpen size={14} /> {ui("프리셋 불러오기", "Load Preset")}
                    </button>
                  </div>
                </div>

                {castSupporting.length === 0 ? (
                  <div className="border-2 border-blue-300 bg-white p-4">
                    <p className="text-[10px] font-bold text-slate-600">
                      {ui('아직 보조 출연자가 없어. (예: "민수의 아버지", "영어 선생님")', 'No supporting cast yet.')}
                    </p>
                  </div>
                ) : (
                  castSupporting.map((c) => (
                    <div key={c.id} className="mb-6 bg-white border-4 border-black p-4">
                      <div className="flex items-center justify-between mb-3">
                        <p className="font-black text-[10px] uppercase text-blue-700">{ui("조연", "Supporting")}</p>
                        <button
                          type="button"
                          onClick={() => removeCastMember(c.id)}
                          className="border-2 border-black bg-white px-2 py-1 font-black hover:bg-slate-100 text-[10px] flex items-center gap-1"
                        >
                          <Trash2 size={14} /> {ui("삭제", "Remove")}
                        </button>
                      </div>

                      <input
                        type="text"
                        value={c.name}
                        onChange={(e) => updateCastMember(c.id, { name: e.target.value })}
                        placeholder={ui('이름/호칭 (예: "민수의 아버지")', 'Name/title')}
                        className="w-full border-2 border-black p-3 font-bold mb-3 outline-none focus:bg-white text-sm"
                      />
                      <textarea
                        value={c.appearance}
                        onChange={(e) => updateCastMember(c.id, { appearance: e.target.value })}
                        placeholder={ui("외형/복장 (예: 와이셔츠, 안경, 피곤한 표정)", "Appearance/outfit")}
                        className="w-full border-2 border-black p-3 font-bold mb-3 outline-none focus:bg-white text-sm min-h-[76px]"
                      />
                      <textarea
                        value={c.persona || ""}
                        onChange={(e) => updateCastMember(c.id, { persona: e.target.value })}
                        placeholder={ui('페르소나/관계/직업 (예: "엄격하지만 속정 깊음")', 'Persona/relationship/job')}
                        className="w-full border-2 border-black p-3 font-bold mb-3 outline-none focus:bg-white text-sm min-h-[76px]"
                      />

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                        <input
                          type="text"
                          value={c.catchphrase || ""}
                          onChange={(e) => updateCastMember(c.id, { catchphrase: e.target.value })}
                          placeholder={ui('말버릇(선택) (예: "그게 말이 돼?")', 'Catchphrase (optional)')}
                          className="w-full border-2 border-black p-3 font-bold outline-none focus:bg-white text-sm"
                        />
                        <select
                          value={(c.catchphrase_frequency || "rare") as CatchphraseFrequency}
                          onChange={(e) => updateCastMember(c.id, { catchphrase_frequency: e.target.value as CatchphraseFrequency })}
                          className="w-full border-2 border-black p-3 font-black outline-none focus:bg-white text-sm"
                        >
                          <option value="rare">{ui("드물게", "Rarely")}</option>
                          <option value="sometimes">{ui("가끔", "Sometimes")}</option>
                          <option value="often">{ui("자주", "Often")}</option>
                        </select>
                      </div>

	                      {renderCharacterReferenceControls(c, {
	                        inputId: `cast-img-${c.id}`,
	                        displayName: String(c.name || "").trim(),
	                        altFallback: "supporting",
	                        panelClassName: "bg-blue-100 border-2 border-black p-3",
	                        titleClassName: "text-[10px] font-black uppercase text-blue-900",
	                        countClassName: "text-[10px] font-bold text-blue-900/70"
	                      })}
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="mt-12 flex flex-col items-end gap-3">
              <p className={`text-[10px] md:text-xs font-black ${canProceedCharacterSetup ? "text-emerald-700" : "text-slate-500"}`}>
                {canProceedCharacterSetup
                  ? ui("준비됐어. 주인공 1명만으로도 다음 단계 진행 가능해.", "Ready. You can continue with just 1 lead character.")
                  : ui("주인공 이름, 외형, 사진 중 하나만 채워도 다음으로 갈 수 있어.", "Add a lead name, appearance, or photo to continue.")}
              </p>
              <button
                onClick={() => void handleGeneratePlan()}
                disabled={!canGeneratePlan}
                className={`px-10 py-5 font-black flex items-center gap-2 uppercase italic transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${creationType === "story" ? "bg-violet-600 text-white hover:bg-violet-700" : creationType === "paper" ? "bg-emerald-600 text-white hover:bg-emerald-700" : "bg-blue-600 text-white hover:bg-blue-700"}`}
              >
                {creationType === "story" ? ui("각색하고 플랜 생성", "Adapt & Plan") : creationType === "paper" ? ui("계속해서 플랜 생성", "Continue & Plan") : ui("원고로 플랜 생성", "Plan from story")} <ArrowRight />
              </button>
            </div>
          </div>
        )}

        {status === AppStatus.STYLE_SELECT && (
          <div className="bg-white border-4 border-black p-6 md:p-10 comic-shadow animate-fade-in">
            <div className="mb-3">
              <PreviousStepButton />
            </div>
            <h2 className="text-2xl md:text-3xl font-black mb-8 border-l-8 border-blue-600 pl-4 uppercase">{ui("02. 아트 디렉션", "02. Art Direction")}</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {(() => {
                const allCategories = ["Webtoon", "Anime", "Manga", "Illustration", "3D/Craft", "Realism", "Uncategorized"].filter(cat =>
                  stylePresets.some(p => (p.category || "Uncategorized") === cat)
                );

                const filteredPresets = stylePresets.filter(p => (p.category || "Uncategorized") === selectedStyleCategory);

                // Auto-select first category if current selection is invalid (e.g. on initial load or preset change)
                // Use useEffect-like logic inside render? No, side effects in render are bad.
                // However, since we initialized state to "Webtoon" it should be fine.
                // If "Webtoon" doesn't exist, we might have empty grid.
                // Better: if filtered is empty and allCategories is not, we might want to guide user?
                // But let's trust "Webtoon" exists or user clicks tab.

                return (
                  <>
                    {/* TABS */}
                    <div className="col-span-2 md:col-span-4 flex flex-wrap gap-2 mb-6">
                      {allCategories.map((cat) => (
                        <button
                          key={cat}
                          type="button"
                          onClick={() => setSelectedStyleCategory(cat)}
                          className={`px-6 py-3 text-xs md:text-sm font-black uppercase border-2 transition-all rounded-full ${selectedStyleCategory === cat
                            ? "bg-black text-white border-black scale-105 shadow-md"
                            : "bg-white text-slate-500 border-slate-300 hover:border-black hover:text-black"
                            }`}
                        >
                          {cat}
                        </button>
                      ))}
                    </div>

                    {/* GRID */}
                    {filteredPresets.map(p => (
                      <div key={p.id} onClick={() => setSelectedPresetId(p.id)} className={`p-4 md:p-6 border-4 cursor-pointer transition-all flex flex-col h-full ${selectedPresetId === p.id ? 'border-blue-600 bg-blue-50 scale-[1.02] shadow-md' : 'border-black hover:bg-slate-50'}`}>
	                        <h3 className={`font-black text-xs md:text-sm mb-2 uppercase ${selectedPresetId === p.id ? "text-blue-700" : "text-black"}`}>{getStylePresetDisplayLabel(p, uiLanguage)}</h3>
                        {selectedPresetId === p.id && (
                          <div className="mt-3 flex justify-end">
                            <CheckCircle2 size={16} className="text-blue-600" />
                          </div>
                        )}
                      </div>
                    ))}
                  </>
                );
              })()}
            </div>

            <div className="mt-8 p-6 bg-slate-50 border-2 border-black">
              <p className="text-xs font-black text-slate-700 uppercase mb-2">{ui("스타일 레퍼런스(선택)", "Style Reference (Optional)")}</p>

              <input
                type="file"
                accept="image/*"
                id="style-up"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  setStyleReferenceError(null);
                  if (!f) return;

                  if (f.size > 6 * 1024 * 1024) {
                    setStyleReferenceError(ui("이미지 용량이 너무 커. 6MB 이하로 업로드해줘.", "Image is too large. Upload an image under 6MB."));
                    setStyleReferenceImage(null);
                    e.currentTarget.value = "";
                    return;
                  }

                  void readStyleReferenceFileAsDataUrl(f)
                    .then((dataUrl) => setStyleReferenceImage(dataUrl))
                    .catch((error: any) => {
                      setStyleReferenceError(error?.message || ui("이미지를 불러오지 못했어.", "Could not load the image."));
                      setStyleReferenceImage(null);
                    });
                  e.currentTarget.value = "";
                }}
              />

              {styleReferenceError && (
                <p className="text-[10px] font-black text-red-600 mb-3">{styleReferenceError}</p>
              )}

              {!styleReferenceImage ? (
                <label
                  htmlFor="style-up"
                  className="inline-block bg-black text-white px-6 py-3 font-black cursor-pointer hover:bg-blue-600 transition-colors text-[10px] md:text-xs"
                >
                  {ui("스타일 이미지 업로드", "Upload Style Image")}
                </label>
              ) : (
                <div className="flex flex-col md:flex-row gap-4 items-start">
                  <div className="w-40 h-40 border-4 border-black overflow-hidden bg-white">
                    <img src={styleReferenceImage} alt="Style reference" className="w-full h-full object-cover" />
                  </div>
                  <div className="flex gap-2">
                    <label
                      htmlFor="style-up"
                      className="bg-black text-white px-4 py-2 font-black cursor-pointer hover:bg-blue-600 transition-colors text-[10px] md:text-xs"
                    >
                      {ui("변경", "Change")}
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setStyleReferenceImage(null);
                        setStyleReferenceError(null);
                      }}
                      className="border-2 border-black bg-white px-4 py-2 font-black hover:bg-slate-100 text-[10px] md:text-xs"
                    >
                      {ui("지우기", "Clear")}
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="mt-12 flex justify-end items-center">
              <button
                onClick={() => {
                  const nextStyle = resolveCurrentStyle();
                  setFinalStyle(nextStyle);
                  setStatus(AppStatus.CHARACTER_SELECT);
                }}
                disabled={!canProceedMissionSetup || stylePresets.length === 0}
                className="bg-black text-white px-10 py-5 font-black flex items-center gap-2 hover:bg-blue-600 transition-colors uppercase italic disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {ui("다음: 캐릭터 설정", "Next: Character Setup")} <ArrowRight />
              </button>
            </div>
          </div>
        )}

        {status === AppStatus.TOPIC_INPUT && (
          <div className={`${topicInputTab === "advanced" ? "max-w-2xl" : topicInputTab === "style_samples" ? "max-w-7xl" : "max-w-5xl"} mx-auto animate-fade-in`}>
            <div className="bg-white border-4 border-black p-6 md:p-10 comic-shadow">
              <div className="mb-3">
                <PreviousStepButton />
              </div>
              <h2 className="text-2xl md:text-3xl font-black mb-4 uppercase">{ui("01. 작업 설정", "01. The Mission")}</h2>

              <div className="mb-8 grid grid-cols-1 gap-2 border-4 border-black bg-slate-100 p-2 md:grid-cols-5">
                <button
                  type="button"
                  onClick={() => setTopicInputTab("quick")}
                  className={`flex min-h-[72px] items-center gap-3 border-2 border-black px-4 py-3 text-left transition-colors ${
                    topicInputTab === "quick" ? "bg-blue-600 text-white" : "bg-white hover:bg-blue-50"
                  }`}
                >
                  <div className={`shrink-0 border-2 border-black p-2 ${topicInputTab === "quick" ? "bg-white text-blue-700" : "bg-blue-600 text-white"}`}>
                    <Wand2 size={18} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-black uppercase">{ui("간편만화자동생성", "Quick Comic Autopilot")}</p>
                    <p className={`mt-1 text-[10px] font-bold leading-relaxed ${topicInputTab === "quick" ? "text-blue-50" : "text-slate-600"}`}>
                      {ui("주제별, PDF별, 결과형식별로 바로 생성하는 전용 탭", "A focused tab for topic, PDF queue, and output format runs.")}
                    </p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTopicInputTab("instatoon");
                    setQuickPipelinePublicationFormat("instatoon");
                    setQuickPipelineSourceJobs((prev) => prev.map((job) => ({ ...job, publicationFormat: "instatoon" })));
                    setComicMode("learning");
                    setPublicationFormat("instatoon");
                    setPageCountMode("auto");
                    setQuickPipelineUnitsPerEpisode(INSTATOON_MAX_CARDS_PER_EPISODE);
                  }}
                  className={`flex min-h-[72px] items-center gap-3 border-2 border-black px-4 py-3 text-left transition-colors ${
                    topicInputTab === "instatoon" ? "bg-pink-600 text-white" : "bg-white hover:bg-pink-50"
                  }`}
                >
                  <div className={`shrink-0 border-2 border-black p-2 ${topicInputTab === "instatoon" ? "bg-white text-pink-700" : "bg-pink-600 text-white"}`}>
                    <LayoutGrid size={18} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-black uppercase">{ui("인스타툰 자동생성", "Instatoon Autopilot")}</p>
                    <p className={`mt-1 text-[10px] font-bold leading-relaxed ${topicInputTab === "instatoon" ? "text-pink-50" : "text-slate-600"}`}>
                      {ui("4:5 캐러셀 카드, N편 분할, ZIP까지 자동 생성", "4:5 carousel cards, episode split, and ZIP export.")}
                    </p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setTopicInputTab("style_samples")}
                  className={`flex min-h-[72px] items-center gap-3 border-2 border-black px-4 py-3 text-left transition-colors ${
                    topicInputTab === "style_samples" ? "bg-violet-600 text-white" : "bg-white hover:bg-violet-50"
                  }`}
                >
                  <div className={`shrink-0 border-2 border-black p-2 ${topicInputTab === "style_samples" ? "bg-white text-violet-700" : "bg-violet-600 text-white"}`}>
                    <Palette size={18} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-black uppercase">{ui("작화 예시", "Style Samples")}</p>
                    <p className={`mt-1 text-[10px] font-bold leading-relaxed ${topicInputTab === "style_samples" ? "text-violet-50" : "text-slate-600"}`}>
                      {ui("전체 작화 프리셋을 1장씩 병렬 생성해서 비교", "Generate one parallel sample per art preset.")}
                    </p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setTopicInputTab("advanced")}
                  className={`flex min-h-[72px] items-center gap-3 border-2 border-black px-4 py-3 text-left transition-colors ${
                    topicInputTab === "advanced" ? "bg-black text-white" : "bg-white hover:bg-slate-100"
                  }`}
                >
                  <div className={`shrink-0 border-2 border-black p-2 ${topicInputTab === "advanced" ? "bg-white text-black" : "bg-slate-900 text-white"}`}>
                    <Settings2 size={18} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-black uppercase">{ui("고급 제작 설정", "Advanced Build Setup")}</p>
                    <p className={`mt-1 text-[10px] font-bold leading-relaxed ${topicInputTab === "advanced" ? "text-slate-200" : "text-slate-600"}`}>
                      {ui("캐릭터, 톤, 페이지 수, 장편 제작까지 직접 조정", "Tune characters, tone, pages, and longform settings manually.")}
                    </p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setTopicInputTab("status")}
                  className={`flex min-h-[72px] items-center gap-3 border-2 border-black px-4 py-3 text-left transition-colors ${
                    topicInputTab === "status" ? "bg-emerald-600 text-white" : "bg-white hover:bg-emerald-50"
                  }`}
                >
                  <div className={`shrink-0 border-2 border-black p-2 ${topicInputTab === "status" ? "bg-white text-emerald-700" : "bg-emerald-600 text-white"}`}>
                    <Monitor size={18} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-black uppercase">{ui("상태 확인", "Status Monitor")}</p>
                    <p className={`mt-1 text-[10px] font-bold leading-relaxed ${topicInputTab === "status" ? "text-emerald-50" : "text-slate-600"}`}>
                      {ui("현재 큐, 완료 결과, 최근 오류를 한 번에 확인", "Check queues, completed results, and recent errors.")}
                    </p>
                  </div>
                </button>
              </div>

              {topicInputTab === "quick" && (
              <div className="mb-8 border-4 border-blue-700 bg-blue-50 p-5 md:p-6">
                <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <p className="text-[10px] font-black uppercase text-blue-700 flex items-center gap-2">
                      <Sparkles size={14} /> {ui("간편 만화 자동 생성", "Quick Comic Autopilot")}
                    </p>
                    <h3 className="mt-1 text-xl font-black leading-tight">
                      {ui("자료와 작화만 넣고 최종 이미지까지", "Source + art direction to final images")}
                    </h3>
                    <p className="mt-2 text-[11px] font-bold leading-relaxed text-slate-600">
                      {quickPipelinePublicationFormat === "instatoon"
                        ? ui("교육/학습 · 인스타툰 · 입문자 · 한국어 · 4:5 카드 · 자료 길이에 맞춰 카드 수를 잡고 N편으로 나눠.", "Learning instatoon defaults, beginner audience, Korean, 4:5 cards, split into episodes by source length.")
                        : quickPipelinePublicationFormat === "webtoon"
                          ? ui("교육/학습 · 웹툰 · 입문자 · 보통 스크립트 · 한국어 · 2K · 자료 길이에 맞춰 스트립 수를 잡고 12스트립마다 N편으로 나눠.", "Learning webtoon defaults, beginner audience, normal script, Korean, 2K, split every 12 strips.")
                          : ui("교육/학습 · 학습만화 · 입문자 · 보통 스크립트 · 한국어 · 2K · 페이지 단위로 구성해.", "Learning comic defaults, beginner audience, normal script, Korean, 2K, page-based output.")}
                    </p>
                  </div>
                  <span className="w-fit border-2 border-blue-700 bg-white px-3 py-1 text-[10px] font-black uppercase text-blue-800">
                    {quickPipelinePublicationFormat === "instatoon"
                      ? ui(`${quickPipelineUnitsPerEpisode}카드마다 N편 · 총 36카드`, `${quickPipelineUnitsPerEpisode} cards/episode · 36 total`)
                      : quickPipelinePublicationFormat === "webtoon"
                        ? ui("1편 최대 12스트립 · 총 36스트립", "12 strips/episode · 36 total")
                        : ui("학습만화 최대 12페이지", "Learning comic max 12 pages")}
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-3">
                  <div>
                    <p className="mb-2 text-[10px] font-black uppercase text-slate-600">{ui("결과 형식", "Output format")}</p>
                    <div className="grid grid-cols-3 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setQuickPipelinePublicationFormat("webtoon");
                          setQuickPipelineSourceJobs((prev) => prev.map((job) => ({ ...job, publicationFormat: "webtoon" })));
                        }}
                        disabled={isQuickPipelineRunning}
                        className={`border-2 border-black px-4 py-3 text-xs font-black uppercase transition-colors ${
                          quickPipelinePublicationFormat === "webtoon"
                            ? "bg-green-600 text-white"
                            : "bg-white hover:bg-slate-100"
                        } ${isQuickPipelineRunning ? "cursor-not-allowed opacity-60" : ""}`}
                      >
                        {ui("웹툰", "Webtoon")}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setQuickPipelinePublicationFormat("instatoon");
                          setQuickPipelineSourceJobs((prev) => prev.map((job) => ({ ...job, publicationFormat: "instatoon" })));
                          setPublicationFormat("instatoon");
                        }}
                        disabled={isQuickPipelineRunning}
                        className={`border-2 border-black px-4 py-3 text-xs font-black uppercase transition-colors ${
                          quickPipelinePublicationFormat === "instatoon"
                            ? "bg-pink-600 text-white"
                            : "bg-white hover:bg-slate-100"
                        } ${isQuickPipelineRunning ? "cursor-not-allowed opacity-60" : ""}`}
                      >
                        {ui("인스타툰", "Instatoon")}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setQuickPipelinePublicationFormat("learning_comic");
                          setQuickPipelineSourceJobs((prev) => prev.map((job) => ({ ...job, publicationFormat: "learning_comic" })));
                        }}
                        disabled={isQuickPipelineRunning}
                        className={`border-2 border-black px-4 py-3 text-xs font-black uppercase transition-colors ${
                          quickPipelinePublicationFormat === "learning_comic"
                            ? "bg-black text-white"
                            : "bg-white hover:bg-slate-100"
                        } ${isQuickPipelineRunning ? "cursor-not-allowed opacity-60" : ""}`}
                      >
                        {ui("학습만화", "Learning Comic")}
                      </button>
                    </div>
                  </div>

                  <div>
                    <p className="mb-2 text-[10px] font-black uppercase text-slate-600">
                      {quickPipelineSourceFiles.length > 1 ? ui("자료 큐 순차 생성", "Sequential source queue") : ui("후보 큐 동시 생성", "Parallel candidate queues")}
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                      {Array.from({ length: QUICK_PIPELINE_MAX_QUEUE_COUNT }, (_, index) => index + 1).map((count) => (
                        <button
                          key={`quick-queue-count-${count}`}
                          type="button"
                          onClick={() => setQuickPipelineQueueCount(count)}
                          disabled={isQuickPipelineRunning || quickPipelineSourceFiles.length > 1}
                          className={`border-2 border-black px-4 py-3 text-xs font-black uppercase transition-colors ${
                            quickPipelineQueueCount === count
                              ? "bg-blue-600 text-white"
                              : "bg-white hover:bg-slate-100"
                          } ${isQuickPipelineRunning || quickPipelineSourceFiles.length > 1 ? "cursor-not-allowed opacity-60" : ""}`}
                        >
                          {count}{ui("큐", " Queue")}
                        </button>
                      ))}
                    </div>
                    <p className="mt-2 text-[10px] font-bold leading-relaxed text-slate-600">
                      {quickPipelineSourceFiles.length > 1
                        ? ui("여러 자료를 넣으면 첫 큐에서 만든 캐릭터를 고정하고, 1큐 완료 뒤 2큐, 2큐 완료 뒤 3큐 순서로 각각 저장해.", "With multiple sources, the first queue locks the cast, then queue 2 starts after queue 1, queue 3 after queue 2.")
                        : quickPipelineQueueCount > 1
                        ? ui("같은 자료로 여러 후보를 동시에 만들고, 완료된 큐를 골라서 결과 화면에 불러와.", "Generate multiple candidates from the same source, then load the completed queue you prefer.")
                        : ui("기본은 한 큐만 생성해.", "Default generates one queue.")}
                    </p>
                  </div>

                  <label className="block">
                    <span className="mb-1 block text-[10px] font-black uppercase text-slate-600">{ui("주제", "Topic")}</span>
                    <input
                      type="text"
                      value={topic}
                      onChange={(e) => {
                        setTopic(e.target.value);
                        clearResearchDigest();
                      }}
                      placeholder={ui("예: 로봇 부품을 쉽게 설명하기", "Example: explain robot parts simply")}
                      className="w-full border-2 border-black bg-white px-3 py-3 text-sm font-black outline-none focus:bg-yellow-50"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-1 block text-[10px] font-black uppercase text-slate-600">{ui("사용자 입력 및 선택자료 첨부", "User input and source material")}</span>
                    <textarea
                      value={researchReportText}
                      onChange={(e) => {
                        setResearchReportText(e.target.value);
                        clearResearchDigest();
                      }}
                      placeholder={ui("본문, 메모, 기사, 대본, 교재 내용을 붙여넣어줘.", "Paste notes, articles, transcripts, or lesson material.")}
                      className="h-32 w-full resize-y border-2 border-black bg-white p-3 font-mono text-[11px] outline-none focus:bg-yellow-50"
                    />
                  </label>

                  <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto_auto] md:items-end">
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-black uppercase text-slate-600">{ui("작화", "Art Direction")}</span>
                      <select
                        value={selectedPresetId}
                        onChange={(e) => {
                          const nextPresetId = e.target.value;
                          const nextPreset = stylePresets.find((preset) => preset.id === nextPresetId);
                          setSelectedPresetId(nextPresetId);
                          if (nextPreset?.category) setSelectedStyleCategory(nextPreset.category);
                          setFinalStyle(null);
                        }}
                        className="w-full border-2 border-black bg-white px-3 py-3 text-xs font-black outline-none focus:bg-yellow-50"
                      >
                        {stylePresets.map((preset) => (
                          <option key={`quick-style-${preset.id}`} value={preset.id}>
                            {preset.category ? `${preset.category} · ` : ""}{getStylePresetDisplayLabel(preset, uiLanguage)}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="flex cursor-pointer items-center justify-center gap-2 border-2 border-black bg-white px-4 py-3 text-[10px] font-black uppercase hover:bg-yellow-50">
                      <Upload size={14} /> {quickPipelineSourceFiles.length > 1 ? ui(`${quickPipelineSourceFiles.length}개 자료 큐`, `${quickPipelineSourceFiles.length} queued`) : researchReportFile ? ui("자료 변경", "Change source") : ui("PDF/TXT 여러개 첨부", "Attach PDFs/TXT")}
                      <input
                        type="file"
                        multiple
                        accept=".txt,.md,.json,.pdf,text/plain,application/json,application/pdf"
                        className="hidden"
                        onClick={(e) => {
                          (e.currentTarget as HTMLInputElement).value = "";
                        }}
                        onChange={(e) => void handleQuickSourceFilesChange(e.target.files)}
                      />
                    </label>

                    <label className="flex cursor-pointer items-center justify-center gap-2 border-2 border-black bg-white px-4 py-3 text-[10px] font-black uppercase hover:bg-yellow-50">
                      <Palette size={14} /> {styleReferenceImage ? ui("작화 참고 변경", "Change style ref") : ui("작화 참고", "Style ref")}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        className="hidden"
                        onClick={(e) => {
                          (e.currentTarget as HTMLInputElement).value = "";
                        }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          readImageFileAsCompressedDataUrl(file, { maxEdge: REFERENCE_IMAGE_MAX_EDGE, quality: REFERENCE_IMAGE_JPEG_QUALITY, maxLength: 6 * 1024 * 1024 })
                            .then((dataUrl) => {
                              setStyleReferenceImage(dataUrl);
                              setStyleReferenceError(null);
                              setFinalStyle(null);
                            })
                            .catch((err) => {
                              console.warn("Failed to read quick style reference", err);
                              setStyleReferenceError(ui("작화 참고 이미지를 읽지 못했어.", "Could not read the style reference image."));
                            });
                        }}
                      />
                    </label>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-[10px] font-bold text-slate-600">
                    {quickPipelineSourceFiles.length > 1 ? (
                      <span className="border-2 border-black bg-white px-2 py-1">
                        {ui("자료 큐", "Source queue")}: {quickPipelineSourceFiles.map((file, index) => `${index + 1}. ${file.name}`).join(" / ")}
                      </span>
                    ) : researchReportFile ? <span className="border-2 border-black bg-white px-2 py-1">{ui("자료", "Source")}: {researchReportFile.name}</span> : null}
                    {styleReferenceImage ? <span className="border-2 border-black bg-white px-2 py-1">{ui("작화 참고 이미지 적용됨", "Style reference applied")}</span> : null}
                    {styleReferenceError ? <span className="border-2 border-red-500 bg-red-50 px-2 py-1 text-red-700">{styleReferenceError}</span> : null}
                  </div>

                  {quickPipelineSourceJobs.length > 0 ? (
                    <div className="border-2 border-black bg-white p-4">
                      <div className="mb-3 flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                        <div>
                          <p className="text-[10px] font-black uppercase text-slate-700">{ui("작업 큐", "Job Queue")}</p>
                          <p className="mt-1 text-[10px] font-bold text-slate-500">
                            {ui("파일마다 주제와 결과형식을 따로 지정할 수 있어.", "Set a separate topic and output format for each file.")}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setQuickPipelineSourceFiles([]);
                            setQuickPipelineSourceJobs([]);
                            setResearchReportFile(null);
                          }}
                          disabled={isQuickPipelineRunning}
                          className="w-fit border-2 border-black bg-white px-3 py-2 text-[10px] font-black uppercase hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {ui("큐 비우기", "Clear queue")}
                        </button>
                      </div>
                      <div className="space-y-2">
                        {quickPipelineSourceJobs.map((job, index) => (
                          <div key={job.id} className="grid grid-cols-1 gap-2 border-2 border-slate-300 bg-slate-50 p-3 md:grid-cols-[56px_1fr_170px] md:items-center">
                            <div className="text-xs font-black text-blue-700">{index + 1}{ui("큐", "Q")}</div>
                            <div className="min-w-0">
                              <p className="mb-1 truncate text-[10px] font-black text-slate-500">{job.file.name}</p>
                              <input
                                type="text"
                                value={job.topic}
                                onChange={(e) => {
                                  const nextTopic = e.target.value;
                                  setQuickPipelineSourceJobs((prev) => prev.map((item) => item.id === job.id ? { ...item, topic: nextTopic } : item));
                                }}
                                disabled={isQuickPipelineRunning}
                                placeholder={ui("이 파일만의 주제명, 비우면 파일명/본문으로 추정", "Topic for this file; blank derives from file/content")}
                                className="w-full border-2 border-black bg-white px-3 py-2 text-[11px] font-black outline-none focus:bg-yellow-50 disabled:bg-slate-200"
                              />
                            </div>
                            <select
                              value={job.publicationFormat}
                              onChange={(e) => {
                                const nextFormat = e.target.value as QuickPipelinePublicationFormat;
                                setQuickPipelineSourceJobs((prev) => prev.map((item) => item.id === job.id ? { ...item, publicationFormat: nextFormat } : item));
                              }}
                              disabled={isQuickPipelineRunning}
                              className="w-full border-2 border-black bg-white px-3 py-2 text-[10px] font-black outline-none focus:bg-yellow-50 disabled:bg-slate-200"
                            >
                              <option value="webtoon">{ui("웹툰", "Webtoon")}</option>
                              <option value="instatoon">{ui("인스타툰", "Instatoon")}</option>
                              <option value="learning_comic">{ui("학습만화", "Learning Comic")}</option>
                            </select>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <button
                    type="button"
                    onClick={() => setQuickPipelineParallelAll((prev) => !prev)}
                    disabled={isQuickPipelineRunning}
                    className={`flex items-center justify-between gap-3 border-2 border-black px-4 py-3 text-left text-[10px] font-black uppercase transition-colors ${
                      quickPipelineParallelAll
                        ? "bg-emerald-600 text-white"
                        : "bg-white text-slate-800 hover:bg-slate-100"
                    } ${isQuickPipelineRunning ? "cursor-not-allowed opacity-60" : ""}`}
                    title={ui("간편 생성의 이미지를 한꺼번에 병렬 요청할지 설정", "Choose whether quick generation requests all images in parallel.")}
                  >
                    <span>
                      {ui("이미지 전체 병렬 생성", "Full parallel image generation")}
                      <span className="ml-2 opacity-80">{quickPipelineParallelAll ? "ON" : "OFF"}</span>
                    </span>
                    <span className="text-[10px] font-bold opacity-90">
                      {quickPipelineParallelAll
                        ? quickPipelinePublicationFormat === "instatoon"
                          ? ui("최대 36카드 동시 요청", "Up to 36 cards at once")
                          : quickPipelinePublicationFormat === "webtoon"
                          ? ui("최대 36스트립 동시 요청", "Up to 36 strips at once")
                          : ui("최대 12페이지 동시 요청", "Up to 12 pages at once")
                        : ui("안정 모드: 3장씩", "Stable: 3 at a time")}
                    </span>
                  </button>

                  {quickPipelineProgress ? (
                    <div className="border-2 border-black bg-white p-4">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <p className="text-[10px] font-black uppercase text-blue-700">
                            {quickStageLabel(quickPipelineProgress.stage)} · {quickPipelineProgress.message}
                          </p>
                          <p className="mt-1 text-[10px] font-bold text-slate-600">
                            {ui("전체", "Total")} {formatBusyDuration(quickPipelineElapsedSeconds, uiLanguage)} · {ui("현재 단계", "Stage")} {formatBusyDuration(quickPipelineStageElapsedSeconds, uiLanguage)} · {ui("시도", "Attempt")} {quickPipelineProgress.attempt}
                          </p>
                          {quickPipelineProgress.detail ? (
                            <p className="mt-1 text-[10px] font-bold text-slate-500">{quickPipelineProgress.detail}</p>
                          ) : null}
                        </div>
                        <strong className="text-2xl font-black italic">{quickPipelinePercent}%</strong>
                      </div>
                      <div className="mt-3 h-3 border-2 border-black bg-slate-100">
                        <div className="h-full bg-blue-600 transition-all duration-500" style={{ width: `${quickPipelinePercent}%` }} />
                      </div>
                    </div>
                  ) : null}

                  {quickPipelineQueueRuns.length > 0 ? (
                    <div className="border-2 border-black bg-white p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <p className="text-[10px] font-black uppercase text-slate-700">
                          {quickPipelineSourceJobs.length > 1 ? ui("자료 큐 진행", "Source queue progress") : ui("후보 큐 결과", "Candidate queue results")}
                        </p>
                        <span className="text-[10px] font-bold text-slate-500">
                          {quickPipelineQueueRuns.filter((run) => run.status === "success").length}/{quickPipelineQueueRuns.length} {ui("완료", "done")}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 gap-2">
                        {quickPipelineQueueRuns.map((run) => {
                          const isSelectedQueue = selectedQuickPipelineQueueId === run.id;
                          const isReadyQueue = run.status === "success" && run.plan;
                          const progressLabel = typeof run.completedPages === "number" && typeof run.totalPages === "number"
                            ? `${run.completedPages}/${run.totalPages}`
                            : quickStageLabel(run.stage);
                          return (
                            <div
                              key={run.id}
                              className={`flex flex-col gap-3 border-2 px-3 py-3 md:flex-row md:items-center md:justify-between ${
                                isSelectedQueue
                                  ? "border-blue-700 bg-blue-50"
                                  : run.status === "error"
                                    ? "border-red-400 bg-red-50"
                                    : run.status === "success"
                                      ? "border-emerald-500 bg-emerald-50"
                                      : "border-slate-300 bg-slate-50"
                              }`}
                            >
                              <div className="min-w-0">
                                <p className="text-xs font-black text-slate-900">
                                  {run.label} · {run.status === "success" ? ui("완료", "Done") : run.status === "error" ? ui("실패", "Failed") : quickStageLabel(run.stage)}
                                </p>
                                <p className="mt-1 text-[10px] font-bold text-slate-600">
                                  {progressLabel} · {run.message}
                                </p>
                                {run.error ? <p className="mt-1 text-[10px] font-bold text-red-700">{run.error}</p> : null}
                              </div>
                              <button
                                type="button"
                                onClick={() => loadQuickPipelineQueueResult(run)}
                                disabled={!isReadyQueue}
                                className={`shrink-0 border-2 border-black px-4 py-2 text-[10px] font-black uppercase ${
                                  isReadyQueue
                                    ? isSelectedQueue
                                      ? "bg-black text-white"
                                      : "bg-white hover:bg-blue-600 hover:text-white"
                                    : "cursor-not-allowed bg-slate-200 text-slate-400"
                                }`}
                              >
                                {isSelectedQueue ? ui("보는 중", "Loaded") : ui("이 큐 보기", "Load queue")}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {quickPipelineLogs.length > 0 ? (
                    <div className="border-2 border-black bg-white">
                      <button
                        type="button"
                        onClick={() => setQuickPipelineLogsOpen((prev) => !prev)}
                        className="flex w-full items-center justify-between px-4 py-3 text-left text-[10px] font-black uppercase"
                      >
                        <span>{ui("최근 간편 생성 기록", "Recent quick generation logs")}</span>
                        <span>{quickPipelineLogsOpen ? ui("접기", "Hide") : ui("보기", "Show")}</span>
                      </button>
                      {quickPipelineLogsOpen ? (
                        <div className="max-h-40 space-y-1 overflow-y-auto border-t-2 border-black p-3 text-[10px] font-bold text-slate-600">
                          {quickPipelineLogs.slice(0, 8).map((entry, index) => (
                            <div key={`quick-log-${entry.created_at || index}-${index}`} className="flex flex-wrap gap-2">
                              <span className="font-black text-slate-900">{quickStageLabel(entry.stage)}</span>
                              <span>{entry.status}</span>
                              <span>{entry.message}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  <button
                    type="button"
                    onClick={() => void handleRunQuickPipeline()}
                    disabled={!canRunQuickPipeline}
                    className="flex min-h-[64px] w-full items-center justify-center gap-3 border-4 border-black bg-blue-600 px-5 py-4 text-base font-black uppercase text-white shadow-lg transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-400"
                  >
                    {isQuickPipelineRunning ? <Plus size={18} /> : <Wand2 size={18} />}
                    {isQuickPipelineRunning
                      ? ui("대기리스트 추가", "Add to waitlist")
                      : quickPipelineSourceJobs.length > 1
                        ? ui(`${quickPipelineSourceJobs.length}개 자료 큐 순차 생성 시작`, `Start ${quickPipelineSourceJobs.length} source queues`)
                        : quickPipelineQueueCount > 1
                        ? ui(`${quickPipelineQueueCount}큐 간편 생성 시작`, `Start ${quickPipelineQueueCount} quick queues`)
                        : ui("간편 생성 시작", "Start quick generation")}
                  </button>
                </div>
              </div>
              )}

              {topicInputTab === "instatoon" && (
                <div className="mb-8 border-4 border-pink-700 bg-pink-50 p-5 md:p-6">
                  <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <p className="flex items-center gap-2 text-[10px] font-black uppercase text-pink-700">
                        <LayoutGrid size={14} /> {ui("인스타툰 자동생성", "Instatoon Autopilot")}
                      </p>
                      <h3 className="mt-1 text-xl font-black leading-tight">
                        {ui("자료를 4:5 캐러셀 카드로 바로 만들기", "Turn source material into 4:5 carousel cards")}
                      </h3>
                      <p className="mt-2 text-[11px] font-bold leading-relaxed text-slate-600">
                        {ui("교육/학습 · 입문자 · 한국어 · 카드뉴스형 가독성 · 캐릭터 AI 제안 · 이미지 품질 medium을 기본값으로 묶었어.", "Learning, beginner audience, Korean, card-news readability, AI cast suggestion, and medium image quality are bundled as defaults.")}
                      </p>
                    </div>
                    <span className="w-fit border-2 border-pink-700 bg-white px-3 py-1 text-[10px] font-black uppercase text-pink-800">
                      {ui(`4:5 · 최종 ${INSTATOON_EXPORT_WIDTH}x${INSTATOON_EXPORT_HEIGHT} · ${quickPipelineUnitsPerEpisode}카드마다 N편`, `4:5 · final ${INSTATOON_EXPORT_WIDTH}x${INSTATOON_EXPORT_HEIGHT} · split every ${quickPipelineUnitsPerEpisode} cards`)}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 gap-3">
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-black uppercase text-slate-600">{ui("주제", "Topic")}</span>
                      <input
                        type="text"
                        value={topic}
                        onChange={(e) => {
                          setTopic(e.target.value);
                          clearResearchDigest();
                        }}
                        placeholder={ui("예: 초보자를 위한 근저당 쉽게 이해하기", "Example: understanding liens for beginners")}
                        className="w-full border-2 border-black bg-white px-3 py-3 text-sm font-black outline-none focus:bg-yellow-50"
                      />
                    </label>

                    <label className="block">
                      <span className="mb-1 block text-[10px] font-black uppercase text-slate-600">{ui("사용자 입력 및 선택자료 첨부", "User input and source material")}</span>
                      <textarea
                        value={researchReportText}
                        onChange={(e) => {
                          setResearchReportText(e.target.value);
                          clearResearchDigest();
                        }}
                        placeholder={ui("카드로 바꿀 원문, 메모, 강의안, 기사 내용을 붙여넣어줘.", "Paste source text, notes, lesson material, or articles for carousel cards.")}
                        className="h-32 w-full resize-y border-2 border-black bg-white p-3 font-mono text-[11px] outline-none focus:bg-yellow-50"
                      />
                    </label>

                    <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto_auto] md:items-end">
                      <label className="block">
                        <span className="mb-1 block text-[10px] font-black uppercase text-slate-600">{ui("작화", "Art Direction")}</span>
                        <select
                          value={selectedPresetId}
                          onChange={(e) => {
                            const nextPresetId = e.target.value;
                            const nextPreset = stylePresets.find((preset) => preset.id === nextPresetId);
                            setSelectedPresetId(nextPresetId);
                            if (nextPreset?.category) setSelectedStyleCategory(nextPreset.category);
                            setFinalStyle(null);
                          }}
                          className="w-full border-2 border-black bg-white px-3 py-3 text-xs font-black outline-none focus:bg-yellow-50"
                        >
                          {stylePresets.map((preset) => (
                            <option key={`instatoon-style-${preset.id}`} value={preset.id}>
                              {preset.category ? `${preset.category} · ` : ""}{getStylePresetDisplayLabel(preset, uiLanguage)}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="flex cursor-pointer items-center justify-center gap-2 border-2 border-black bg-white px-4 py-3 text-[10px] font-black uppercase hover:bg-yellow-50">
                        <Upload size={14} /> {quickPipelineSourceFiles.length > 1 ? ui(`${quickPipelineSourceFiles.length}개 자료 큐`, `${quickPipelineSourceFiles.length} queued`) : researchReportFile ? ui("자료 변경", "Change source") : ui("PDF/TXT/MD 첨부", "Attach PDF/TXT/MD")}
                        <input
                          type="file"
                          multiple
                          accept=".txt,.md,.json,.pdf,text/plain,application/json,application/pdf"
                          className="hidden"
                          onClick={(e) => {
                            (e.currentTarget as HTMLInputElement).value = "";
                          }}
                          onChange={(e) => void handleQuickSourceFilesChange(e.target.files)}
                        />
                      </label>

                      <label className="flex cursor-pointer items-center justify-center gap-2 border-2 border-black bg-white px-4 py-3 text-[10px] font-black uppercase hover:bg-yellow-50">
                        <Palette size={14} /> {styleReferenceImage ? ui("작화 참고 변경", "Change style ref") : ui("작화 참고", "Style ref")}
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          className="hidden"
                          onClick={(e) => {
                            (e.currentTarget as HTMLInputElement).value = "";
                          }}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            readImageFileAsCompressedDataUrl(file, { maxEdge: REFERENCE_IMAGE_MAX_EDGE, quality: REFERENCE_IMAGE_JPEG_QUALITY, maxLength: 6 * 1024 * 1024 })
                              .then((dataUrl) => {
                                setStyleReferenceImage(dataUrl);
                                setStyleReferenceError(null);
                                setFinalStyle(null);
                              })
                              .catch((err) => {
                                console.warn("Failed to read instatoon style reference", err);
                                setStyleReferenceError(ui("작화 참고 이미지를 읽지 못했어.", "Could not read the style reference image."));
                              });
                          }}
                        />
                      </label>
                    </div>

                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                      <div className="border-2 border-black bg-white p-3">
                        <p className="mb-2 text-[10px] font-black uppercase text-slate-600">{ui("카드 수", "Card count")}</p>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => setPageCountMode("auto")}
                            disabled={isQuickPipelineRunning}
                            className={`border-2 border-black px-3 py-2 text-[10px] font-black uppercase ${pageCountMode === "auto" ? "bg-pink-600 text-white" : "bg-white hover:bg-slate-100"} disabled:opacity-60`}
                          >
                            {ui("자동", "Auto")}
                          </button>
                          <button
                            type="button"
                            onClick={() => setPageCountMode("manual")}
                            disabled={isQuickPipelineRunning}
                            className={`border-2 border-black px-3 py-2 text-[10px] font-black uppercase ${pageCountMode === "manual" ? "bg-black text-white" : "bg-white hover:bg-slate-100"} disabled:opacity-60`}
                          >
                            {ui("수동", "Manual")}
                          </button>
                        </div>
                      </div>
                      <label className="border-2 border-black bg-white p-3">
                        <span className="mb-2 block text-[10px] font-black uppercase text-slate-600">{ui("총 카드 수", "Total cards")}</span>
                        <input
                          type="number"
                          min={1}
                          max={QUICK_PIPELINE_MAX_TOTAL_STRIPS}
                          value={targetPageCount}
                          onChange={(e) => {
                            setPageCountMode("manual");
                            setTargetPageCount(clampQuickStripCount(Number(e.target.value)));
                          }}
                          disabled={isQuickPipelineRunning || pageCountMode === "auto"}
                          className="w-full border-2 border-black bg-white px-3 py-2 text-sm font-black outline-none focus:bg-yellow-50 disabled:bg-slate-200"
                        />
                      </label>
                      <label className="border-2 border-black bg-white p-3">
                        <span className="mb-2 block text-[10px] font-black uppercase text-slate-600">{ui("편당 카드 수", "Cards per episode")}</span>
                        <input
                          type="number"
                          min={1}
                          max={INSTATOON_MAX_CARDS_PER_EPISODE}
                          value={quickPipelineUnitsPerEpisode}
                          onChange={(e) => setQuickPipelineUnitsPerEpisode(getQuickEpisodeUnitLimit("instatoon", Number(e.target.value)))}
                          disabled={isQuickPipelineRunning}
                          className="w-full border-2 border-black bg-white px-3 py-2 text-sm font-black outline-none focus:bg-yellow-50 disabled:bg-slate-200"
                        />
                      </label>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-[10px] font-bold text-slate-600">
                      <span className="border-2 border-black bg-white px-2 py-1">{ui("결과 형식", "Format")}: {ui("인스타툰", "Instatoon")}</span>
                      <span className="border-2 border-black bg-white px-2 py-1">{ui("이미지", "Image")}: 4:5 / {INSTATOON_EXPORT_WIDTH}x{INSTATOON_EXPORT_HEIGHT}</span>
                      {quickPipelineSourceFiles.length > 1 ? (
                        <span className="border-2 border-black bg-white px-2 py-1">
                          {ui("자료 큐", "Source queue")}: {quickPipelineSourceFiles.map((file, index) => `${index + 1}. ${file.name}`).join(" / ")}
                        </span>
                      ) : researchReportFile ? <span className="border-2 border-black bg-white px-2 py-1">{ui("자료", "Source")}: {researchReportFile.name}</span> : null}
                    </div>

                    <button
                      type="button"
                      onClick={() => setQuickPipelineParallelAll((prev) => !prev)}
                      disabled={isQuickPipelineRunning}
                      className={`flex items-center justify-between gap-3 border-2 border-black px-4 py-3 text-left text-[10px] font-black uppercase transition-colors ${
                        quickPipelineParallelAll
                          ? "bg-emerald-600 text-white"
                          : "bg-white text-slate-800 hover:bg-slate-100"
                      } ${isQuickPipelineRunning ? "cursor-not-allowed opacity-60" : ""}`}
                    >
                      <span>
                        {ui("카드 이미지 전체 병렬 생성", "Generate card images in parallel")}
                        <span className="ml-2 opacity-80">{quickPipelineParallelAll ? "ON" : "OFF"}</span>
                      </span>
                      <span className="text-[10px] font-bold opacity-90">
                        {quickPipelineParallelAll ? ui("각 카드를 독립 생성", "Independent card requests") : ui("안정 모드: 3장씩", "Stable: 3 at a time")}
                      </span>
                    </button>

                    {quickPipelineProgress ? (
                      <div className="border-2 border-black bg-white p-4">
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <p className="text-[10px] font-black uppercase text-pink-700">
                              {quickStageLabel(quickPipelineProgress.stage)} · {quickPipelineProgress.message}
                            </p>
                            <p className="mt-1 text-[10px] font-bold text-slate-600">
                              {ui("전체", "Total")} {formatBusyDuration(quickPipelineElapsedSeconds, uiLanguage)} · {ui("현재 단계", "Stage")} {formatBusyDuration(quickPipelineStageElapsedSeconds, uiLanguage)} · {ui("시도", "Attempt")} {quickPipelineProgress.attempt}
                            </p>
                            {quickPipelineProgress.detail ? (
                              <p className="mt-1 text-[10px] font-bold text-slate-500">{quickPipelineProgress.detail}</p>
                            ) : null}
                          </div>
                          <strong className="text-2xl font-black italic">{quickPipelinePercent}%</strong>
                        </div>
                        <div className="mt-3 h-3 border-2 border-black bg-slate-100">
                          <div className="h-full bg-pink-600 transition-all duration-500" style={{ width: `${quickPipelinePercent}%` }} />
                        </div>
                      </div>
                    ) : null}

                    <button
                      type="button"
                      onClick={() => {
                        setQuickPipelinePublicationFormat("instatoon");
                        setQuickPipelineSourceJobs((prev) => prev.map((job) => ({ ...job, publicationFormat: "instatoon" })));
                        setPublicationFormat("instatoon");
                        void handleRunQuickPipeline();
                      }}
                      disabled={!canRunQuickPipeline}
                      className="flex min-h-[64px] w-full items-center justify-center gap-3 border-4 border-black bg-pink-600 px-5 py-4 text-base font-black uppercase text-white shadow-lg transition-colors hover:bg-pink-700 disabled:cursor-not-allowed disabled:bg-slate-400"
                    >
                      {isQuickPipelineRunning ? <Plus size={18} /> : <LayoutGrid size={18} />}
                      {isQuickPipelineRunning
                        ? ui("대기리스트 추가", "Add to waitlist")
                        : quickPipelineSourceJobs.length > 1
                          ? ui(`${quickPipelineSourceJobs.length}개 인스타툰 큐 순차 생성 시작`, `Start ${quickPipelineSourceJobs.length} instatoon queues`)
                          : ui("인스타툰 생성 시작", "Start instatoon generation")}
                    </button>
                  </div>
                </div>
              )}

              {topicInputTab === "style_samples" && (
                <div className="mb-8 border-4 border-violet-700 bg-violet-50 p-5 md:p-6">
                  <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <p className="flex items-center gap-2 text-[10px] font-black uppercase text-violet-800">
                        <Palette size={14} /> {ui("작화 프리셋 예시", "Art Style Samples")}
                      </p>
                      <h3 className="mt-1 text-xl font-black leading-tight">
                        {ui("전체 작화를 같은 장면으로 1장씩 비교", "Compare every art preset with the same scene")}
                      </h3>
                      <p className="mt-2 text-[11px] font-bold leading-relaxed text-slate-600">
                        {ui("콘티 없이 바로 이미지 API를 호출해. 버튼을 누르면 모든 작화 프리셋을 한꺼번에 병렬 요청해.", "This skips planning and calls the image API directly. One click sends every art preset in parallel.")}
                      </p>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center text-[10px] font-black uppercase">
                      <div className="border-2 border-black bg-white px-3 py-2">
                        <p className="text-slate-500">{ui("완료", "Done")}</p>
                        <p className="text-lg text-emerald-700">{styleSampleSuccessCount}</p>
                      </div>
                      <div className="border-2 border-black bg-white px-3 py-2">
                        <p className="text-slate-500">{ui("진행", "Running")}</p>
                        <p className="text-lg text-blue-700">{styleSampleRunningCount}</p>
                      </div>
                      <div className="border-2 border-black bg-white px-3 py-2">
                        <p className="text-slate-500">{ui("실패", "Failed")}</p>
                        <p className="text-lg text-red-700">{styleSampleErrorCount}</p>
                      </div>
                    </div>
                  </div>

                  <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-[1fr_auto] lg:items-end">
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-black uppercase text-slate-600">{ui("공통 샘플 장면", "Shared sample scene")}</span>
                      <input
                        type="text"
                        value={styleSamplePrompt}
                        onChange={(e) => setStyleSamplePrompt(e.target.value)}
                        disabled={isGeneratingStyleSamples}
                        className="w-full border-2 border-black bg-white px-3 py-3 text-sm font-black outline-none focus:bg-yellow-50 disabled:bg-slate-200"
                        placeholder={ui("예: 선생님과 학생이 로봇 부품을 설명하는 장면", "Example: a teacher and student explaining robot parts")}
                      />
                    </label>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <button
                        type="button"
                        onClick={() => void generateAllStyleSamples()}
                        disabled={!canGenerateStyleSamples}
                        className="flex min-h-[48px] items-center justify-center gap-2 border-4 border-black bg-violet-600 px-4 py-3 text-xs font-black uppercase text-white shadow-lg transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:bg-slate-400"
                      >
                        {isGeneratingStyleSamples ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                        {isGeneratingStyleSamples
                          ? ui(`${styleSampleSuccessCount + styleSampleErrorCount}/${stylePresets.length} 생성 중`, `${styleSampleSuccessCount + styleSampleErrorCount}/${stylePresets.length} generating`)
                          : ui(`전체 ${stylePresets.length}개`, `All ${stylePresets.length}`)}
                      </button>
                      <button
                        type="button"
                        onClick={() => void generateFailedStyleSamples()}
                        disabled={!canGenerateStyleSamples || styleSampleErrorCount === 0}
                        className="flex min-h-[48px] items-center justify-center gap-2 border-4 border-black bg-red-600 px-4 py-3 text-xs font-black uppercase text-white shadow-lg transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-slate-400"
                      >
                        <RotateCcw size={16} /> {ui(`실패 ${styleSampleErrorCount}개`, `${styleSampleErrorCount} failed`)}
                      </button>
                      <button
                        type="button"
                        onClick={() => void generateMissingStyleSamples()}
                        disabled={!canGenerateStyleSamples || styleSampleMissingCount === 0}
                        className="flex min-h-[48px] items-center justify-center gap-2 border-4 border-black bg-blue-600 px-4 py-3 text-xs font-black uppercase text-white shadow-lg transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-400"
                      >
                        <Plus size={16} /> {ui(`남은 ${styleSampleMissingCount}개`, `${styleSampleMissingCount} missing`)}
                      </button>
                    </div>
                  </div>
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-2 border-black bg-white px-3 py-2 text-[10px] font-bold text-slate-600">
                    <span>
                      {ui("저장 방식", "Storage")}: {ui("로컬 프로젝트 폴더에 저장하고 브라우저 저장소를 백업으로 사용함", "Saved to the local project folder with browser storage as backup")}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        void clearPersistedStyleSamples()
                          .then(() => {
                            setStyleSampleResults({});
                            void persistStyleSamplePrompt(styleSamplePrompt);
                          })
                          .catch((e) => {
                            console.warn("Failed to clear style samples:", e);
                            setSystemError(ui("작화 예시 저장본을 지우지 못했어.", "Could not clear saved style samples."));
                          });
                      }}
                      disabled={isGeneratingStyleSamples}
                      className="border-2 border-black bg-white px-3 py-1 text-[9px] font-black uppercase hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {ui("저장본 비우기", "Clear saved")}
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {stylePresets.map((preset) => {
                      const result = styleSampleResults[preset.id] || { presetId: preset.id, status: "idle" as StyleSampleStatus };
                      const label = getStylePresetDisplayLabel(preset, uiLanguage);
                      return (
                        <div key={`style-sample-${preset.id}`} className="overflow-hidden border-2 border-black bg-white">
                          <div className="flex items-start justify-between gap-2 border-b-2 border-black bg-white px-3 py-2">
                            <div className="min-w-0">
                              <p className="truncate text-[11px] font-black text-slate-900">{label}</p>
                              <p className="truncate text-[9px] font-bold uppercase text-slate-500">{preset.category || "Style"} · {preset.render_mode}</p>
                            </div>
                            <span className={`shrink-0 border-2 border-black px-2 py-1 text-[9px] font-black uppercase ${
                              result.status === "success"
                                ? "bg-emerald-600 text-white"
                                : result.status === "error"
                                  ? "bg-red-600 text-white"
                                  : result.status === "running"
                                    ? "bg-blue-600 text-white"
                                    : "bg-slate-100 text-slate-700"
                            }`}>
                              {result.status === "success" ? ui("완료", "Done") : result.status === "error" ? ui("실패", "Fail") : result.status === "running" ? ui("생성중", "Run") : ui("대기", "Idle")}
                            </span>
                          </div>
                          <div className="relative aspect-square bg-slate-100">
                            {result.status === "success" && result.imageUrl ? (
                              <img src={result.imageUrl} alt={label} className="h-full w-full object-cover" />
                            ) : result.status === "running" ? (
                              <div className="flex h-full flex-col items-center justify-center gap-3 text-violet-700">
                                <Loader2 size={28} className="animate-spin" />
                                <p className="text-[10px] font-black uppercase">{ui("생성 중", "Generating")}</p>
                              </div>
                            ) : result.status === "error" ? (
                              <div className="flex h-full items-center justify-center p-4 text-center text-[10px] font-bold text-red-700">
                                {result.error || ui("실패", "Failed")}
                              </div>
                            ) : (
                              <div className="flex h-full items-center justify-center p-4 text-center text-[10px] font-bold text-slate-500">
                                {ui("아직 생성 전", "Not generated yet")}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center justify-between gap-2 border-t-2 border-black px-3 py-2">
                            <button
                              type="button"
                              onClick={() => void generateOneStyleSample(preset)}
                              disabled={isGeneratingStyleSamples && result.status === "running"}
                              className="border-2 border-black bg-white px-3 py-1 text-[9px] font-black uppercase hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {ui("1개 재생성", "Regenerate")}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (!result.imageUrl) return;
                                const link = document.createElement("a");
                                link.href = result.imageUrl;
                                link.download = `style_sample_${preset.id}.png`;
                                link.click();
                              }}
                              disabled={!result.imageUrl}
                              className="border-2 border-black bg-white px-3 py-1 text-[9px] font-black uppercase hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {ui("다운로드", "Download")}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {topicInputTab === "status" && (
                <div className="space-y-6">
                  <div className="border-4 border-emerald-700 bg-emerald-50 p-5 md:p-6">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div>
                        <p className="flex items-center gap-2 text-[10px] font-black uppercase text-emerald-800">
                          <Monitor size={14} /> {ui("상태 확인", "Status Monitor")}
                        </p>
                        <h3 className="mt-1 text-xl font-black leading-tight">{ui("생성 큐와 저장 결과를 한 화면에서", "Queue and saved results in one place")}</h3>
                        <p className="mt-2 text-[11px] font-bold leading-relaxed text-slate-600">
                          {ui("진행 중인 자료 큐, 완료된 후보 큐, 최근 오류 로그를 여기서 확인해.", "Check running source queues, completed candidate queues, and recent error logs here.")}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void refreshQuickPipelineLogs()}
                        className="w-fit border-2 border-black bg-white px-4 py-3 text-[10px] font-black uppercase hover:bg-emerald-100"
                      >
                        {ui("기록 새로고침", "Refresh logs")}
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <div className="border-2 border-black bg-white p-4">
                      <p className="text-[10px] font-black uppercase text-slate-500">{ui("전체 큐", "Total queues")}</p>
                      <p className="mt-2 text-2xl font-black">{quickPipelineQueueRuns.length || quickPipelineSourceJobs.length || 0}</p>
                    </div>
                    <div className="border-2 border-black bg-white p-4">
                      <p className="text-[10px] font-black uppercase text-slate-500">{ui("진행 중", "Running")}</p>
                      <p className="mt-2 text-2xl font-black text-blue-700">{quickPipelineQueueRuns.filter((run) => run.status === "running").length}</p>
                    </div>
                    <div className="border-2 border-black bg-white p-4">
                      <p className="text-[10px] font-black uppercase text-slate-500">{ui("완료", "Done")}</p>
                      <p className="mt-2 text-2xl font-black text-emerald-700">{quickPipelineQueueRuns.filter((run) => run.status === "success").length}</p>
                    </div>
                    <div className="border-2 border-black bg-white p-4">
                      <p className="text-[10px] font-black uppercase text-slate-500">{ui("실패", "Failed")}</p>
                      <p className="mt-2 text-2xl font-black text-red-700">{quickPipelineQueueRuns.filter((run) => run.status === "error").length}</p>
                    </div>
                  </div>

                  {quickPipelineProgress ? (
                    <div className="border-2 border-black bg-white p-4">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <p className="text-[10px] font-black uppercase text-emerald-700">
                            {quickStageLabel(quickPipelineProgress.stage)} · {quickPipelineProgress.message}
                          </p>
                          <p className="mt-1 text-[10px] font-bold text-slate-600">
                            {ui("전체", "Total")} {formatBusyDuration(quickPipelineElapsedSeconds, uiLanguage)} · {ui("현재 단계", "Stage")} {formatBusyDuration(quickPipelineStageElapsedSeconds, uiLanguage)}
                          </p>
                          {quickPipelineProgress.detail ? (
                            <p className="mt-1 text-[10px] font-bold text-slate-500">{quickPipelineProgress.detail}</p>
                          ) : null}
                        </div>
                        <strong className="text-2xl font-black italic">{quickPipelinePercent}%</strong>
                      </div>
                      <div className="mt-3 h-3 border-2 border-black bg-slate-100">
                        <div className="h-full bg-emerald-600 transition-all duration-500" style={{ width: `${quickPipelinePercent}%` }} />
                      </div>
                    </div>
                  ) : null}

                  <div className="border-2 border-black bg-white p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <p className="text-[10px] font-black uppercase text-slate-700">{ui("큐리스트", "Queue List")}</p>
                      <span className="text-[10px] font-bold text-slate-500">
                        {quickPipelineQueueRuns.length > 0
                          ? ui("실행 기록 기준", "Runtime queue records")
                          : ui("대기 중인 작업 기준", "Pending job records")}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {quickPipelineQueueRuns.length > 0 ? (
                        quickPipelineQueueRuns.map((run) => {
                          const isSelectedQueue = selectedQuickPipelineQueueId === run.id;
                          const isReadyQueue = run.status === "success" && run.plan;
                          const progressLabel = typeof run.completedPages === "number" && typeof run.totalPages === "number"
                            ? `${run.completedPages}/${run.totalPages}`
                            : quickStageLabel(run.stage);
                          return (
                            <div
                              key={`status-${run.id}`}
                              className={`grid grid-cols-1 gap-3 border-2 p-3 md:grid-cols-[72px_1fr_120px_120px] md:items-center ${
                                isSelectedQueue
                                  ? "border-blue-700 bg-blue-50"
                                  : run.status === "error"
                                    ? "border-red-400 bg-red-50"
                                    : run.status === "success"
                                      ? "border-emerald-500 bg-emerald-50"
                                      : "border-slate-300 bg-slate-50"
                              }`}
                            >
                              <div className="text-xs font-black text-slate-900">{run.label}</div>
                              <div className="min-w-0">
                                <p className="truncate text-xs font-black text-slate-900">{run.message || ui("작업", "Job")}</p>
                                <p className="mt-1 text-[10px] font-bold text-slate-600">{quickStageLabel(run.stage)} · {progressLabel}</p>
                                {run.error ? <p className="mt-1 text-[10px] font-bold text-red-700">{run.error}</p> : null}
                              </div>
                              <span className={`w-fit border-2 border-black px-3 py-1 text-[10px] font-black uppercase ${
                                run.status === "success"
                                  ? "bg-emerald-600 text-white"
                                  : run.status === "error"
                                    ? "bg-red-600 text-white"
                                    : run.status === "running"
                                      ? "bg-blue-600 text-white"
                                      : "bg-white text-slate-700"
                              }`}>
                                {run.status === "success" ? ui("완료", "Done") : run.status === "error" ? ui("실패", "Failed") : run.status === "running" ? ui("진행", "Running") : ui("대기", "Pending")}
                              </span>
                              <button
                                type="button"
                                onClick={() => loadQuickPipelineQueueResult(run)}
                                disabled={!isReadyQueue}
                                className={`border-2 border-black px-4 py-2 text-[10px] font-black uppercase ${
                                  isReadyQueue
                                    ? isSelectedQueue
                                      ? "bg-black text-white"
                                      : "bg-white hover:bg-blue-600 hover:text-white"
                                    : "cursor-not-allowed bg-slate-200 text-slate-400"
                                }`}
                              >
                                {isSelectedQueue ? ui("보는 중", "Loaded") : ui("불러오기", "Load")}
                              </button>
                            </div>
                          );
                        })
                      ) : quickPipelineSourceJobs.length > 0 ? (
                        quickPipelineSourceJobs.map((job, index) => (
                          <div key={`pending-${job.id}`} className="grid grid-cols-1 gap-3 border-2 border-slate-300 bg-slate-50 p-3 md:grid-cols-[72px_1fr_120px] md:items-center">
                            <div className="text-xs font-black text-slate-900">{index + 1}{ui("큐", "Q")}</div>
                            <div className="min-w-0">
                              <p className="truncate text-xs font-black text-slate-900">{job.topic.trim() || job.file.name}</p>
                              <p className="mt-1 truncate text-[10px] font-bold text-slate-600">{job.file.name}</p>
                            </div>
                            <span className="w-fit border-2 border-black bg-white px-3 py-1 text-[10px] font-black uppercase">
                              {quickFormatLabel(job.publicationFormat)}
                            </span>
                          </div>
                        ))
                      ) : (
                        <div className="border-2 border-dashed border-slate-300 bg-slate-50 p-6 text-center text-[11px] font-bold text-slate-500">
                          {ui("아직 큐가 없어. 간편만화자동생성 탭에서 PDF/TXT를 첨부하면 여기에 표시돼.", "No queue yet. Attach PDFs/TXT in the Quick Comic Autopilot tab and they will appear here.")}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className="border-2 border-black bg-white p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <p className="text-[10px] font-black uppercase text-slate-700">{ui("최근 간편 생성 기록", "Recent quick generation logs")}</p>
                        <button
                          type="button"
                          onClick={() => setQuickPipelineLogsOpen((prev) => !prev)}
                          className="border-2 border-black bg-white px-3 py-1 text-[10px] font-black uppercase hover:bg-slate-100"
                        >
                          {quickPipelineLogsOpen ? ui("접기", "Hide") : ui("보기", "Show")}
                        </button>
                      </div>
                      {quickPipelineLogs.length > 0 ? (
                        <div className={`${quickPipelineLogsOpen ? "max-h-64" : "max-h-32"} space-y-1 overflow-y-auto text-[10px] font-bold text-slate-600`}>
                          {quickPipelineLogs.slice(0, quickPipelineLogsOpen ? 24 : 8).map((entry, index) => (
                            <div key={`status-log-${entry.created_at || index}-${index}`} className="grid grid-cols-[72px_72px_1fr] gap-2 border-b border-slate-200 py-1">
                              <span className="font-black text-slate-900">{quickStageLabel(entry.stage)}</span>
                              <span>{entry.status}</span>
                              <span className="truncate">{entry.message}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[11px] font-bold text-slate-500">{ui("아직 기록이 없어.", "No logs yet.")}</p>
                      )}
                    </div>

                    <div className="border-2 border-black bg-white p-4">
                      <p className="mb-3 text-[10px] font-black uppercase text-slate-700">{ui("저장된 최근 결과", "Recent saved results")}</p>
                      {savedProjects.length > 0 ? (
                        <div className="max-h-64 space-y-2 overflow-y-auto">
                          {savedProjects.slice(0, 8).map((project) => (
                            <div key={`status-project-${project.id}`} className="flex flex-col gap-2 border-2 border-slate-200 bg-slate-50 p-3 md:flex-row md:items-center md:justify-between">
                              <div className="min-w-0">
                                <p className="truncate text-xs font-black text-slate-900">{project.label}</p>
                                <p className="mt-1 text-[10px] font-bold text-slate-500">
                                  {(project.snapshot.pageResults || []).length}/{project.snapshot.seriesPlan?.pages?.length || 0} · {new Date(project.updated_at).toLocaleString()}
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={() => loadSavedProject(project.id)}
                                className="border-2 border-black bg-white px-3 py-2 text-[10px] font-black uppercase hover:bg-blue-600 hover:text-white"
                              >
                                {ui("불러오기", "Load")}
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[11px] font-bold text-slate-500">{ui("저장된 결과가 없어.", "No saved results.")}</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {topicInputTab === "advanced" && (<>
              <div className="mb-8 p-6 bg-slate-50 border-2 border-black">
                <p className="text-[10px] font-black uppercase text-slate-600 mb-3">{ui("작업 방식", "Workflow")}</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <button
                    type="button"
                    onClick={enterSingleMode}
                    className={`flex items-center gap-3 px-4 py-3 border-4 transition-all text-left ${productionMode === "single" ? "border-black bg-white" : "border-slate-300 bg-white hover:border-black"}`}
                  >
                    <div className={`${productionMode === "single" ? "bg-black text-white" : "bg-slate-100 text-slate-600"} p-2 rounded-lg`}>
                      <Sparkles size={18} />
                    </div>
                    <p className="min-w-0 text-sm font-black uppercase leading-tight">{ui("새 작업", "New Single Work")}</p>
                  </button>
                  <button
                    type="button"
                    onClick={enterNewLongformMode}
                    className={`flex items-center gap-3 px-4 py-3 border-4 transition-all text-left ${productionMode === "new_longform" ? "border-violet-700 bg-violet-50" : "border-slate-300 bg-white hover:border-violet-700"}`}
                  >
                    <div className={`${productionMode === "new_longform" ? "bg-violet-700 text-white" : "bg-violet-50 text-violet-700"} p-2 rounded-lg`}>
                      <Plus size={18} />
                    </div>
                    <p className="min-w-0 text-sm font-black uppercase leading-tight">{ui("새 장편 시작", "Start Longform")}</p>
                  </button>
                  <button
                    type="button"
                    onClick={enterLongformMode}
                    className={`flex items-center gap-3 px-4 py-3 border-4 transition-all text-left ${productionMode === "longform" ? "border-indigo-700 bg-indigo-50" : "border-slate-300 bg-white hover:border-indigo-700"}`}
                  >
                    <div className={`${productionMode === "longform" ? "bg-indigo-700 text-white" : "bg-indigo-50 text-indigo-700"} p-2 rounded-lg`}>
                      <BookOpen size={18} />
                    </div>
                    <p className="min-w-0 text-sm font-black uppercase leading-tight">{ui("장편 이어 만들기", "Continue Longform")}</p>
                  </button>
                </div>
              </div>

              {productionMode === "longform" && (
                <div className="mb-8 p-6 bg-indigo-50 border-2 border-black">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between mb-4">
                    <div>
                      <p className="text-xs font-black text-indigo-800 uppercase flex items-center gap-2">
                        <BookOpen size={16} /> {ui("장편 이어 만들기", "Continue Longform")}
                      </p>
                      <p className="mt-1 text-[10px] font-bold text-slate-600">
                        {activeLongformProject
                          ? ui(`${activeLongformProject.label} · 보관 캐릭터 ${activeLongformProject.snapshot.cast.length}명 · 저장 스타일 적용`, `${activeLongformProject.label} · ${activeLongformProject.snapshot.cast.length} saved characters · saved style applied`)
                          : ui("장편 프로젝트를 불러온 뒤, 아래에 이번 화 원고를 넣어.", "Load a longform project, then paste this episode's script below.")}
                      </p>
                    </div>
                    <span className="w-fit border-2 border-indigo-700 bg-white px-3 py-1 text-[10px] font-black text-indigo-800 uppercase">
                      {ui("스토리 모드", "Story Mode")}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-2">
                    <select
                      value={selectedLongformProjectId}
                      onChange={(e) => setSelectedLongformProjectId(e.target.value)}
                      className="w-full border-2 border-black bg-white px-3 py-2 text-xs font-black outline-none focus:bg-indigo-50"
                    >
                      <option value="">
                        {longformProjects.length > 0 ? ui("(장편 프로젝트 선택)", "(Select longform project)") : ui("(저장된 장편 없음)", "(No saved longform projects)")}
                      </option>
                      {longformProjects
                        .slice()
                        .sort((a, b) => b.updated_at - a.updated_at)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label} · {p.snapshot.cast.length}{ui("명", "")}
                          </option>
                        ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => selectedLongformProject && loadLongformProject(selectedLongformProject.id)}
                      disabled={!selectedLongformProject}
                      className="bg-indigo-700 text-white px-4 py-2 text-xs font-black border-2 border-black hover:bg-indigo-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      <FolderOpen size={14} /> {ui("장편 불러오기", "Load Longform")}
                    </button>
                    <button
                      type="button"
                      onClick={() => selectedLongformProject && deleteLongformProject(selectedLongformProject.id)}
                      disabled={!selectedLongformProject}
                      className="border-2 border-black bg-white px-4 py-2 text-xs font-black hover:bg-slate-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      <Trash2 size={14} /> {ui("삭제", "Delete")}
                    </button>
                  </div>
                </div>
              )}

              {productionMode === "single" && (
              <div className="mb-8 p-6 bg-slate-50 border-2 border-black">
                <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("제작 유형", "Creation Type")}</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => {
                      enterSingleMode();
                      setCreationType("educational");
                      setNarrativeRole(LEARNING_NARRATIVE_ROLE);
                      setPublicationFormat(getDefaultPublicationFormat("educational"));
                      setLayoutVariety(DEFAULT_LAYOUT_VARIETY);
                      if (comicMode !== LEARNING_COMIC_MODE) setComicMode(LEARNING_COMIC_MODE);
                    }}
                    className={`py-3 border-2 border-black font-black text-xs uppercase transition-colors ${creationType === "educational" ? 'bg-black text-white' : 'bg-white hover:bg-slate-100'}`}
                  >
                    {ui("교육/학습", "Learning")}
                  </button>
                  <button
                    onClick={() => {
                      enterSingleMode();
                      setCreationType("story");
                      setNarrativeRole(getDefaultNarrativeRole("story"));
                      setPublicationFormat(getDefaultPublicationFormat("story"));
                      setComicMode("pure_cinematic");
                      setLayoutVariety(DEFAULT_LAYOUT_VARIETY);
                    }}
                    className={`py-3 border-2 border-black font-black text-xs uppercase transition-colors ${creationType === "story" ? 'bg-violet-600 text-white border-violet-600' : 'bg-white hover:bg-slate-100'}`}
                  >
                    {ui("스토리/창작", "Story")}
                  </button>
                </div>
              </div>
              )}

              {productionMode === "new_longform" && (
                <div className="mb-8 p-6 bg-violet-50 border-2 border-black">
                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="text-xs font-black text-violet-800 uppercase flex items-center gap-2">
                        <Plus size={16} /> {ui("새 장편 1화", "New Longform Episode 1")}
                      </p>
                      <p className="mt-1 text-[10px] font-bold text-slate-600">
                        {ui("이 화면에서는 1화 원고와 스타일을 정하고, 캐릭터 설정 화면에서 장편 보관함으로 저장해.", "Set episode 1 script and style here, then save the cast as a longform library in character setup.")}
                      </p>
                    </div>
                    <span className="w-fit border-2 border-violet-700 bg-white px-3 py-1 text-[10px] font-black text-violet-800 uppercase">
                      {ui("스토리/창작", "Story")}
                    </span>
                  </div>
                </div>
              )}

              <div className="mb-8 p-6 bg-slate-50 border-2 border-black">
                <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("출판 형식", "Publication Format")}</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {getSelectablePublicationFormats(creationType).map((fmt) => {
                    const cfg = FORMAT_CONFIGS[fmt];
                    const isActive = publicationFormat === fmt;
                    const colorClass = fmt === "kling_i2v" && isActive
                      ? "bg-blue-600 text-white border-blue-600"
                      : fmt === "instatoon" && isActive
                        ? "bg-pink-600 text-white border-pink-600"
                      : fmt === "webtoon" && isActive
                        ? "bg-green-600 text-white border-green-600"
                        : fmt === "manga" && isActive
                          ? "bg-purple-600 text-white border-purple-600"
                          : isActive
                            ? "bg-black text-white"
                            : "bg-white hover:bg-slate-100";
                    return (
                      <button
                        key={fmt}
                        onClick={() => {
                          if (fmt === publicationFormat) return;
                          setPublicationFormat(fmt);
                          if (isLearningComic(fmt)) setLayoutVariety(DEFAULT_LAYOUT_VARIETY);
                          if (seriesPlan) {
                            setSeriesPlan(null);
                            setPageResults([]);
                            setPageErrors({});
                            setWebtoonEpisodeResult(null);
                            setIsBuildingWebtoonEpisode(false);
                            setPageRenderedAt({});
                            setPageRenderedImageSize({});
                            setPageRenderedEngineKey({});
                            setPageScriptEditedAt({});
                            setPageStyleOverrides({});
                            setPageStyleEditedAt({});
                          }
                        }}
                        className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${colorClass}`}
                      >
                        {formatLabel(uiLanguage, cfg.labelKo, cfg.label, cfg.labelKo || cfg.label)}
                      </button>
                    );
                  })}
                </div>
                {isI2VSelected ? (
                  <div className="mt-3">
                    <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("화면 비율", "Aspect Ratio")}</p>
                    <div className="grid grid-cols-3 gap-2">
                      {(["16:9", "9:16", "1:1"] as I2VAspectRatio[]).map((ratio) => (
                        <button
                          key={ratio}
                          onClick={() => setI2VAspectRatio(ratio)}
                          className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${i2vAspectRatio === ratio ? "bg-black text-white" : "bg-white hover:bg-slate-100"}`}
                        >
                          {ratio}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {isManga(publicationFormat) ? (
                  <div className="mt-3">
                    <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("색상 모드", "Color Mode")}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => setMangaColorMode("bw")}
                        className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${mangaColorMode === "bw" ? "bg-black text-white" : "bg-white hover:bg-slate-100"}`}
                      >
                        {ui("흑백", "B&W")}
                      </button>
                      <button
                        onClick={() => setMangaColorMode("color")}
                        className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${mangaColorMode === "color" ? "bg-purple-600 text-white border-purple-600" : "bg-white hover:bg-slate-100"}`}
                      >
                        {ui("컬러", "Color")}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              {creationType === "educational" && (<>
              <div className="mb-8 p-6 bg-slate-50 border-2 border-black">
                <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("독자 수준", "Audience")}</p>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                  <button
                    onClick={() => setAudienceLevel("kids")}
                    className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${audienceLevel === "kids" ? 'bg-black text-white' : 'bg-white hover:bg-slate-100'}`}
                  >
	                    {getAudienceLevelLabel("kids", uiLanguage)}
                  </button>
                  <button
                    onClick={() => setAudienceLevel("teen")}
                    className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${audienceLevel === "teen" ? 'bg-black text-white' : 'bg-white hover:bg-slate-100'}`}
                  >
	                    {getAudienceLevelLabel("teen", uiLanguage)}
                  </button>
                  <button
                    onClick={() => setAudienceLevel("beginner")}
                    className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${audienceLevel === "beginner" ? 'bg-black text-white' : 'bg-white hover:bg-slate-100'}`}
                  >
	                    {getAudienceLevelLabel("beginner", uiLanguage)}
                  </button>
                  <button
                    onClick={() => setAudienceLevel("intermediate")}
                    className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${audienceLevel === "intermediate" ? 'bg-black text-white' : 'bg-white hover:bg-slate-100'}`}
                  >
	                    {getAudienceLevelLabel("intermediate", uiLanguage)}
                  </button>
                  <button
                    onClick={() => setAudienceLevel("expert")}
                    className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${audienceLevel === "expert" ? 'bg-black text-white' : 'bg-white hover:bg-slate-100'}`}
                  >
	                    {getAudienceLevelLabel("expert", uiLanguage)}
                  </button>
                </div>
              </div>
              </>)}

              {creationType === "story" && (<>
              <div className="mb-8 p-6 bg-slate-50 border-2 border-black">
                <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("입력 형태", "Input Type")}</p>
                <div className="grid grid-cols-3 gap-2">
                  <button
	                    onClick={() => handleStoryInputTypeChange("script")}
                    className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${storyInputType === "script" ? 'bg-violet-600 text-white border-violet-600' : 'bg-white hover:bg-slate-100'}`}
                  >
                    {ui("대본/시나리오", "Script")}
                  </button>
                  <button
	                    onClick={() => handleStoryInputTypeChange("prose")}
                    className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${storyInputType === "prose" ? 'bg-violet-600 text-white border-violet-600' : 'bg-white hover:bg-slate-100'}`}
                  >
                    {ui("소설/산문", "Prose")}
                  </button>
                  <button
	                    onClick={() => handleStoryInputTypeChange("scenario")}
                    className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${storyInputType === "scenario" ? 'bg-violet-600 text-white border-violet-600' : 'bg-white hover:bg-slate-100'}`}
                  >
                    {ui("상황/설정", "Scenario")}
                  </button>
                </div>
              </div>

              <div className="mb-8">
	                <p className="text-sm font-bold text-slate-500 mb-4 uppercase">
	                  {storyInputType === "script"
	                    ? ui(`대본을 입력해줘 · 최소 ${STORY_MIN_INPUT_CHARS}자`, `Enter a script · at least ${STORY_MIN_INPUT_CHARS} chars`)
	                    : storyInputType === "prose"
	                      ? ui(`소설/산문 텍스트를 입력해줘 · 최소 ${STORY_MIN_INPUT_CHARS}자`, `Enter prose text · at least ${STORY_MIN_INPUT_CHARS} chars`)
	                      : ui(`어떤 상황/설정이야? · 최소 ${STORY_MIN_INPUT_CHARS}자`, `What is the situation or premise? · at least ${STORY_MIN_INPUT_CHARS} chars`)}
	                </p>
                <textarea
                  value={scriptText}
                  onChange={(e) => setScriptText(e.target.value)}
                  placeholder={storyInputType === "script"
                    ? ui("예:\n(장면: 어두운 골목길, 비가 내린다)\n\n지수: 여기서 기다리라고 했잖아.\n민호: (뒤돌아보며) 기다릴 시간이 없어.", "Example:\n(Scene: A dark alley in the rain.)\n\nJisoo: I told you to wait here.\nMinho: We don't have time to wait.")
                    : storyInputType === "prose"
                      ? ui("예:\n비가 쏟아지는 골목길에서 지수는 민호의 등을 바라보고 있었다...", "Example:\nIn the rain-soaked alley, Jisoo watched Minho's back...")
	                      : ui("예:\n고등학생 지수가 낡은 필름 카메라를 주운 뒤, 사진을 찍은 순간으로 10분 전 되돌아갈 수 있게 된다. 처음엔 시험과 친구 문제를 해결하려 하지만, 반복할수록 주변 사람들의 기억이 조금씩 어긋난다.", "Example:\nA high school student finds an old film camera and gains the ability to jump back ten minutes to the moment each photo was taken. At first she uses it to fix exams and friendships, but each reset slowly changes what others remember.")}
                  className="w-full border-4 border-black p-4 md:p-6 text-sm font-mono mb-2 outline-none focus:bg-violet-50 h-48 resize-y"
                />
                <div className="flex items-center justify-between">
	                  <p className={`text-[10px] font-bold ${scriptText.trim().length >= STORY_MIN_INPUT_CHARS ? "text-slate-400" : "text-violet-700"}`}>
	                    {scriptText.trim().length.toLocaleString()}/{STORY_MIN_INPUT_CHARS}{ui("자 최소", " chars min")}
	                  </p>
                  <label className="flex items-center gap-1 text-[10px] font-black uppercase bg-white border-2 border-black px-2 py-1 hover:bg-yellow-50 cursor-pointer">
                    <Upload size={12} /> {ui("파일 업로드", "Upload File")}
                    <input
                      type="file"
                      accept=".txt,.md,text/plain"
                      className="hidden"
                      onClick={(e) => { (e.currentTarget as HTMLInputElement).value = ""; }}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = () => { if (typeof reader.result === "string") setScriptText(reader.result); };
                        reader.readAsText(file);
                      }}
                    />
                  </label>
                </div>
                <div className="flex items-center gap-2 mt-3">
                  <button
                    onClick={handleAnalyzeStory}
	                    disabled={isStoryAnalyzing || scriptText.trim().length < STORY_MIN_INPUT_CHARS}
                    className={`px-4 py-2 text-xs font-black transition-colors flex items-center gap-2 disabled:opacity-50 ${storyAdaptationMode === "analyzed" && storyDigestText ? "bg-violet-700 text-white" : "bg-violet-600 text-white hover:bg-violet-700"}`}
                  >
                    {isStoryAnalyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles size={14} />}
		                    {ui("AI 각색", "AI Adapt")}
                  </button>
                  <button
                    onClick={handleUseStoryAsIs}
		                    disabled={!canUseStoryDirectly || isStoryAnalyzing || scriptText.trim().length < STORY_MIN_INPUT_CHARS}
	                    title={storyInputType === "scenario" ? ui("상황/설정은 AI 각색 후 진행할 수 있어.", "Scenario input needs AI adaptation first.") : undefined}
                    className={`px-4 py-2 text-xs font-black border-2 border-black transition-colors flex items-center gap-2 disabled:opacity-50 ${storyAdaptationMode === "direct" ? "bg-black text-white" : "bg-white text-black hover:bg-slate-100"}`}
                  >
                    <CheckCircle2 size={14} />
	                    {ui("이대로 사용", "Use As Is")}
                  </button>
                  {storyDigestText && (
                    <button
                      onClick={() => { setStoryAdaptationMode("analyzed"); setStoryDigestText(""); setStoryDigestWarnings([]); setStoryPageSuggestions(null); setStoryDigestError(null); }}
                      className="text-[10px] font-black text-slate-400 hover:text-red-500 uppercase"
                    >
	                      {ui("초기화", "Reset")}
                    </button>
                  )}
                </div>
                {storyAdaptationMode === "direct" && (
                  <p className="text-[10px] font-bold text-slate-500 mt-2">
                    {ui("원문을 바로 만화 스크립트로 넘겨. 스토리 브리프/페이지 아웃라인 압축은 건너뛰고, 페이지 수만 원문 길이로 자동 추정해.", "Uses the original text directly, skips story brief/page-outline compression, and only estimates page count from source length.")}
                  </p>
                )}
                {storyInputType === "scenario" && (
                  <p className="text-[10px] font-bold text-violet-700 mt-2">
                    {ui("상황/설정은 바로 사용하지 않고, AI 각색 후 다음 단계로 진행해.", "Scenario input must be adapted before continuing.")}
                  </p>
                )}
                {storyDigestError && (
	                  <p className="text-[10px] font-black text-red-600 mt-2">{ui("AI 각색 오류", "AI adaptation error")}: {storyDigestError}</p>
                )}
                {storyDigestWarnings.length > 0 && (
                  <div className="border-2 border-yellow-400 bg-yellow-50 p-3 mt-3">
                    <p className="text-[10px] font-black uppercase text-yellow-800 mb-1">{ui("경고", "Warnings")}</p>
                    <ul className="list-disc pl-4 text-[10px] font-bold text-yellow-900 space-y-1">
                      {storyDigestWarnings.slice(0, 6).map((w, idx) => (
                        <li key={idx}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {storyDigestText && (
                  <div className="mt-3">
                    <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("스토리 브리프", "Story Brief")}</p>
                    <textarea
                      value={storyDigestText}
                      onChange={(e) => setStoryDigestText(e.target.value)}
                      className="w-full border-2 border-black p-3 font-mono text-[10px] bg-white h-48 resize-y"
                    />
                  </div>
                )}
              </div>

              {productionMode === "longform" && (
              <div className="mb-8 p-6 bg-indigo-50 border-2 border-black">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between mb-4">
                  <div>
                    <p className="text-xs font-black text-indigo-800 uppercase flex items-center gap-2">
                      <BookOpen size={16} /> {ui("장편 프로젝트", "Longform Project")}
                    </p>
                    <p className="mt-1 text-[10px] font-bold text-slate-600">
                      {activeLongformProject
                        ? ui(`${activeLongformProject.label} · 보관 캐릭터 ${activeLongformProject.snapshot.cast.length}명`, `${activeLongformProject.label} · ${activeLongformProject.snapshot.cast.length} saved characters`)
                        : ui("캐릭터 보관함과 저장된 그림체를 불러와서 이번 화 출연진만 골라.", "Load a character library and saved style, then pick only this episode's cast.")}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => promptSaveLongformProject(!activeLongformProject)}
                    className="border-2 border-black bg-white px-3 py-2 text-[10px] font-black hover:bg-slate-100 flex items-center justify-center gap-2"
                  >
                    <Save size={14} /> {activeLongformProject ? ui("현재 설정 저장", "Save Current Setup") : ui("새 장편 저장", "Save New Longform")}
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-2 mb-4">
                  <select
                    value={selectedLongformProjectId}
                    onChange={(e) => setSelectedLongformProjectId(e.target.value)}
                    className="w-full border-2 border-black bg-white px-3 py-2 text-xs font-black outline-none focus:bg-indigo-50"
                  >
                    <option value="">
                      {longformProjects.length > 0 ? ui("(장편 프로젝트 선택)", "(Select longform project)") : ui("(저장된 장편 없음)", "(No saved longform projects)")}
                    </option>
                    {longformProjects
                      .slice()
                      .sort((a, b) => b.updated_at - a.updated_at)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label} · {p.snapshot.cast.length}{ui("명", "")}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => selectedLongformProject && loadLongformProject(selectedLongformProject.id)}
                    disabled={!selectedLongformProject}
                    className="bg-black text-white px-4 py-2 text-xs font-black border-2 border-black hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    <FolderOpen size={14} /> {ui("불러오기", "Load")}
                  </button>
                  <button
                    type="button"
                    onClick={() => selectedLongformProject && deleteLongformProject(selectedLongformProject.id)}
                    disabled={!selectedLongformProject}
                    className="border-2 border-black bg-white px-4 py-2 text-xs font-black hover:bg-slate-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    <Trash2 size={14} /> {ui("삭제", "Delete")}
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => void runEpisodeCastSelection()}
	                  disabled={!activeLongformProject || isSelectingEpisodeCast || scriptText.trim().length < STORY_MIN_INPUT_CHARS}
                  className="w-full bg-indigo-700 text-white px-4 py-3 text-xs font-black border-2 border-black hover:bg-indigo-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isSelectingEpisodeCast ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                  {isSelectingEpisodeCast ? ui("출연진 찾는 중", "Finding Cast") : ui("이번 화 출연진 자동 선택", "Auto-Select Episode Cast")}
                </button>

                {longformNotice && (
                  <div
                    className={`mt-4 border-2 p-3 text-[10px] font-bold whitespace-pre-wrap ${
                      longformNotice.kind === "error"
                        ? "border-red-500 bg-red-50 text-red-900"
                        : longformNotice.kind === "success"
                          ? "border-emerald-600 bg-emerald-50 text-emerald-900"
                          : "border-indigo-600 bg-white text-slate-800"
                    }`}
                  >
                    <p className="font-black">{longformNotice.message}</p>
                    {longformNotice.detail && (
                      <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed">{longformNotice.detail}</pre>
                    )}
                  </div>
                )}

                {episodeCastReview && activeLongformProject && (
                  <div className="mt-4 space-y-3">
                    <div className="grid grid-cols-3 gap-2">
                      <div className="border-2 border-black bg-white p-3">
                        <p className="text-[10px] font-black uppercase text-slate-500">{ui("기존 인물", "Existing")}</p>
                        <p className="text-xl font-black">{episodeCastReview.matched_existing_characters.length}</p>
                      </div>
                      <div className="border-2 border-black bg-white p-3">
                        <p className="text-[10px] font-black uppercase text-slate-500">{ui("확인 필요", "Possible")}</p>
                        <p className="text-xl font-black">{episodeCastReview.possible_matches.length}</p>
                      </div>
                      <div className="border-2 border-black bg-white p-3">
                        <p className="text-[10px] font-black uppercase text-slate-500">{ui("신규", "New")}</p>
                        <p className="text-xl font-black">{episodeCastReview.new_character_candidates.length}</p>
                      </div>
                    </div>

                    {episodeCastReview.matched_existing_characters.length > 0 && (
                      <div className="border-2 border-black bg-white p-3">
                        <p className="text-[10px] font-black uppercase text-emerald-700 mb-2">{ui("이번 화에 쓰일 기존 캐릭터", "Existing characters for this episode")}</p>
                        <div className="space-y-2">
                          {episodeCastReview.matched_existing_characters.slice(0, 8).map((match, idx) => {
                            const character = activeLongformCharactersById.get(match.character_id);
                            return (
                              <div key={`${match.character_id}-${idx}`} className="border border-slate-200 p-2 text-[10px] font-bold">
                                <p className="font-black">{character?.name || match.mentioned_as || match.character_id}</p>
                                <p className="text-slate-500">{match.evidence || ui("근거 없음", "No evidence")}</p>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {episodeCastReview.possible_matches.length > 0 && (
                      <div className="border-2 border-yellow-500 bg-yellow-50 p-3">
                        <p className="text-[10px] font-black uppercase text-yellow-800 mb-2">{ui("애매한 매칭", "Possible Matches")}</p>
                        <div className="space-y-2">
                          {episodeCastReview.possible_matches.slice(0, 5).map((match, idx) => (
                            <div key={`${match.mentioned_as}-${idx}`} className="border border-yellow-300 bg-white p-2 text-[10px] font-bold">
                              <p className="font-black">{match.mentioned_as || ui("이름 없는 인물", "Unnamed character")}</p>
                              <p className="text-slate-500">{match.reason || match.evidence}</p>
                              <select
                                value={episodePossibleMatchSelections[idx] || match.candidate_character_ids[0] || "__skip__"}
                                onChange={(e) => {
                                  const value = e.target.value;
                                  setEpisodePossibleMatchSelections((prev) => ({ ...prev, [idx]: value }));
                                }}
                                className="mt-2 w-full border-2 border-black bg-white px-2 py-2 text-[10px] font-black outline-none focus:bg-yellow-50"
                              >
                                <option value="__skip__">{ui("이번 화에서 제외", "Exclude from episode")}</option>
                                {match.candidate_character_ids.map((id) => {
                                  const character = activeLongformCharactersById.get(id);
                                  return (
                                    <option key={id} value={id}>
                                      {character?.name || id}
                                    </option>
                                  );
                                })}
                              </select>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {episodeCastReview.new_character_candidates.length > 0 && (
                      <div className="border-2 border-blue-500 bg-blue-50 p-3">
                        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between mb-2">
                          <p className="text-[10px] font-black uppercase text-blue-800">{ui("새로 만들 인물", "New Characters Needed")}</p>
                          <button
                            type="button"
                            onClick={addSelectedEpisodeNewCharactersToLibrary}
                            className="border-2 border-black bg-white px-3 py-2 text-[10px] font-black hover:bg-blue-100 flex items-center justify-center gap-2"
                          >
                            <Plus size={13} /> {ui("선택 신규 보관함 추가", "Add Selected to Library")}
                          </button>
                        </div>
                        <div className="space-y-2">
                          {episodeCastReview.new_character_candidates.slice(0, 6).map((candidate, idx) => (
                            <label key={`${candidate.name}-${idx}`} className="block border border-blue-200 bg-white p-2 text-[10px] font-bold cursor-pointer hover:bg-blue-50">
                              <div className="flex items-start gap-2">
                                <input
                                  type="checkbox"
                                  checked={episodeNewCharacterSelections[idx] !== false}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    setEpisodeNewCharacterSelections((prev) => ({ ...prev, [idx]: checked }));
                                  }}
                                  className="mt-0.5"
                                />
                                <div className="min-w-0">
                                  <p className="font-black">{candidate.name || ui("새 인물", "New character")}</p>
                                  <p className="text-slate-600">{candidate.appearance || candidate.visual_prompt}</p>
                                </div>
                              </div>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => applyEpisodeCastReview(true)}
                        className="bg-black text-white px-4 py-3 text-xs font-black border-2 border-black hover:bg-indigo-700 transition-colors flex items-center justify-center gap-2"
                      >
                        <CheckCircle2 size={14} /> {ui("신규 포함해서 적용", "Apply With New")}
                      </button>
                      <button
                        type="button"
                        onClick={() => applyEpisodeCastReview(false)}
                        className="border-2 border-black bg-white px-4 py-3 text-xs font-black hover:bg-slate-100 transition-colors flex items-center justify-center gap-2"
                      >
                        <UserCheck size={14} /> {ui("기존 인물만 적용", "Existing Only")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              )}

              <div className="mb-8 p-6 bg-slate-50 border-2 border-black">
                <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("연령 등급", "Age Rating")}</p>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => setAgeRating("all_ages")}
                    className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${ageRating === "all_ages" ? 'bg-black text-white' : 'bg-white hover:bg-slate-100'}`}
                  >
	                    {getAgeRatingLabel("all_ages", uiLanguage)}
                  </button>
                  <button
                    onClick={() => setAgeRating("teen")}
                    className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${ageRating === "teen" ? 'bg-black text-white' : 'bg-white hover:bg-slate-100'}`}
                  >
	                    {getAgeRatingLabel("teen", uiLanguage)}
                  </button>
                  <button
                    onClick={() => setAgeRating("mature")}
                    className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${ageRating === "mature" ? 'bg-black text-white' : 'bg-white hover:bg-slate-100'}`}
                  >
	                    {getAgeRatingLabel("mature", uiLanguage)}
                  </button>
                </div>
              </div>

              <div className="mb-8 p-6 bg-slate-50 border-2 border-black">
                <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("스토리 가드(실험)", "Story Guard (Experimental)")}</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setStoryAntiEducationGuardEnabled(true)}
                    className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${storyAntiEducationGuardEnabled ? 'bg-violet-600 text-white border-violet-600' : 'bg-white hover:bg-slate-100'}`}
                  >
                    {ui("가드 ON", "Guard On")}
                  </button>
                  <button
                    onClick={() => setStoryAntiEducationGuardEnabled(false)}
                    className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${!storyAntiEducationGuardEnabled ? 'bg-violet-600 text-white border-violet-600' : 'bg-white hover:bg-slate-100'}`}
                  >
                    {ui("가드 OFF", "Guard Off")}
                  </button>
                </div>
              </div>

              <div className="mb-8 p-6 bg-slate-50 border-2 border-black">
                <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("장르 힌트(선택)", "Genre Hint (Optional)")}</p>
                <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
                  {(["action", "romance", "horror", "comedy", "drama", "fantasy", "sci_fi", "slice_of_life", "mystery"] as StoryGenre[]).map((g) => (
                    <button
                      key={g}
                      onClick={() => setStoryGenre(storyGenre === g ? null : g)}
                      className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${storyGenre === g ? 'bg-violet-600 text-white border-violet-600' : 'bg-white hover:bg-slate-100'}`}
                    >
	                      {getStoryGenreLabel(g, uiLanguage)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mb-8 p-6 bg-slate-50 border-2 border-black">
                <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("페이싱", "Pacing")}</p>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => setPacingPreference("fast")}
                    className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${pacingPreference === "fast" ? 'bg-black text-white' : 'bg-white hover:bg-slate-100'}`}
                  >
                    {ui("빠르게", "Fast")}
                  </button>
                  <button
                    onClick={() => setPacingPreference("balanced")}
                    className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${pacingPreference === "balanced" ? 'bg-black text-white' : 'bg-white hover:bg-slate-100'}`}
                  >
                    {ui("균형", "Balanced")}
                  </button>
                  <button
                    onClick={() => setPacingPreference("slow")}
                    className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${pacingPreference === "slow" ? 'bg-black text-white' : 'bg-white hover:bg-slate-100'}`}
                  >
                    {ui("천천히", "Slow")}
                  </button>
                </div>
              </div>
              </>)}

              {creationType === "paper" && (
                <>
                  <div className="mb-8 p-6 bg-slate-50 border-2 border-black">
                    <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("독자 수준", "Audience")}</p>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                      {(["kids", "teen", "beginner", "intermediate", "expert"] as AudienceLevel[]).map((level) => (
                        <button
                          key={level}
                          onClick={() => setAudienceLevel(level)}
                          className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${audienceLevel === level ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white hover:bg-slate-100'}`}
                        >
	                          {getAudienceLevelLabel(level, uiLanguage)}
                        </button>
                      ))}
                    </div>
                  </div>

	                  <div className="mb-8 p-6 bg-slate-50 border-2 border-black">
	                    <p className="text-xs font-black text-slate-700 uppercase mb-4 flex items-center gap-2">
	                      <FileText size={14} /> {ui("논문 자료", "Paper Source")}
	                    </p>
	                    <div className="flex flex-col md:flex-row gap-2 mb-4">
	                      <input
	                        type="url"
	                        value={paperUrl}
	                        onChange={(e) => {
	                          setPaperUrl(e.target.value);
	                          setPaperBriefError(null);
	                        }}
	                        onKeyDown={(e) => {
	                          if (e.key === "Enter") void runPaperUrlAnalysis();
	                        }}
	                        placeholder={ui("논문 URL 붙여넣기 (arXiv, DOI, PubMed, 저널 페이지 등)", "Paste a paper URL (arXiv, DOI, PubMed, journal page, etc.)")}
	                        className="flex-1 border-2 border-black bg-white px-3 py-2 text-xs font-bold outline-none focus:bg-emerald-50"
	                      />
	                      <button
	                        onClick={() => { void runPaperUrlAnalysis(); }}
	                        disabled={isPaperAnalyzing || !paperUrl.trim()}
	                        className="bg-emerald-600 text-white px-4 py-2 text-xs font-black border-2 border-black hover:bg-emerald-700 transition-colors disabled:opacity-50"
	                      >
	                        {ui("AI 조사", "AI Research")}
	                      </button>
	                    </div>
	                    <div className="flex items-center justify-between gap-3 mb-3">
	                      <p className="text-[10px] font-black uppercase text-slate-500">{ui("또는 PDF 원문 업로드", "Or upload the PDF")}</p>
	                      <label className="flex items-center gap-1 text-[10px] font-black uppercase bg-white border-2 border-black px-2 py-1 hover:bg-emerald-50 cursor-pointer">
	                        <Upload size={12} /> {ui("PDF 업로드", "Upload PDF")}
                        <input
                          type="file"
                          accept=".pdf,application/pdf"
                          className="hidden"
                          onClick={(e) => { (e.currentTarget as HTMLInputElement).value = ""; }}
                          onChange={(e) => { void handlePaperFileChange(e.target.files?.[0] || null); }}
                        />
	                      </label>
	                    </div>
	                    {paperFile ? (
	                      <p className="text-[10px] font-bold text-slate-500 mb-3">
	                        {ui("업로드됨", "Uploaded")}: <span className="font-black">{paperFile.name}</span>
	                      </p>
	                    ) : paperUrl.trim() ? (
	                      <p className="text-[10px] font-bold text-slate-500 mb-3">
	                        {ui("URL", "URL")}: <span className="font-black break-all">{paperUrl.trim()}</span>
	                      </p>
	                    ) : (
	                      null
	                    )}

                    {isPaperAnalyzing && (
                      <div className="border-2 border-black bg-white p-4 flex items-center gap-3">
	                        <Loader2 className="w-4 h-4 animate-spin text-emerald-600" />
	                        <p className="text-[10px] font-black uppercase">{ui("논문 해설 원고 생성 중...", "Generating paper story...")}</p>
	                      </div>
	                    )}

                    {paperBriefError && (
                      <p className="text-[10px] font-black text-red-600">{paperBriefError}</p>
                    )}

                    {paperBrief && !isPaperAnalyzing && (
                      <div className="border-2 border-black bg-white p-4 space-y-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="bg-emerald-600 text-white px-2 py-0.5 text-[10px] font-black uppercase">
                            {ui("원고 검토", "Story Review")}
                          </span>
                        </div>

	                        <div>
	                          <p className="text-sm md:text-base font-black">{paperBrief.paper_title || ui("논문 해설 원고", "Paper Story")}</p>
	                        </div>

                        <div className="border-2 border-black bg-emerald-50 p-3">
                          <div className="flex items-center justify-between gap-3 mb-2">
                            <p className="text-[10px] font-black uppercase text-emerald-700">
                              {ui("해설 원고", "Explainer Story")}
                            </p>
                            <span className="text-[10px] font-black text-slate-500">
                              {ui("이 원고를 나눠서 페이지 수를 추천해", "Page count is based on this story")}
                            </span>
                          </div>
                          <textarea
                            value={paperBrief.explainer_story || ""}
                            onChange={(e) => setPaperBrief((prev) => prev ? { ...prev, explainer_story: e.target.value } : prev)}
                            className="w-full min-h-[180px] border-2 border-black bg-white p-3 text-[11px] font-bold leading-relaxed outline-none focus:bg-emerald-50"
                          />
                          {paperBrief.page_division_note && (
                            <p className="mt-2 text-[10px] font-bold text-slate-600">
                              {paperBrief.page_division_note}
                            </p>
                          )}
                        </div>

                        {(paperBrief.source_cues || []).length > 0 && (
                          <div className="border-2 border-black bg-slate-50 p-3">
                            <p className="text-[10px] font-black uppercase text-slate-600 mb-1">{ui("확인한 출처 단서", "Source Cues")}</p>
                            <div className="space-y-1 text-[10px] font-bold text-slate-700">
                              {paperBrief.source_cues.slice(0, 4).map((item, index) => (
                                <p key={index}>- {item}</p>
                              ))}
                            </div>
                          </div>
                        )}

                        {(paperBrief.public_reception_notes || []).length > 0 && (
                          <div className="border-2 border-black bg-white p-3">
                            <p className="text-[10px] font-black uppercase text-slate-600 mb-1">{ui("리뷰와 대중 반응", "Reviews & Public Reaction")}</p>
                            <div className="space-y-1 text-[10px] font-bold text-slate-700">
                              {paperBrief.public_reception_notes.slice(0, 4).map((item, index) => (
                                <p key={index}>- {item}</p>
                              ))}
                            </div>
                            <p className="mt-2 text-[10px] font-bold text-slate-500">
                              {ui("마지막 페이지에서 '이런 반응도 있었다' 정도로만 써.", "Used only as a light final-page reception note.")}
                            </p>
                          </div>
                        )}

                        {(paperBrief.warnings || []).length > 0 && (
                          <div className="border-2 border-yellow-400 bg-yellow-50 p-3">
                            <p className="text-[10px] font-black uppercase text-yellow-800 mb-1">{ui("경고", "Warnings")}</p>
                            <div className="space-y-1 text-[10px] font-bold text-yellow-900">
                              {paperBrief.warnings.slice(0, 4).map((item, index) => (
                                <p key={index}>- {item}</p>
                              ))}
                            </div>
                          </div>
                        )}

	                        <div className="flex items-center gap-2">
	                          <button
	                            onClick={() => {
	                              if (paperFile) void runPaperAnalysis(paperFile);
	                              else void runPaperUrlAnalysis();
	                            }}
	                            disabled={(!paperFile && !paperUrl.trim()) || isPaperAnalyzing}
	                            className="bg-white text-black px-4 py-2 text-xs font-black border-2 border-black hover:bg-slate-100 transition-colors disabled:opacity-50"
	                          >
                            {ui("재분석", "Re-analyze")}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}

              <div className="mb-8 p-6 bg-slate-50 border-2 border-black">
                <p className="text-[10px] font-black uppercase text-slate-600 mb-2">
                  {isPaperSelected ? ui("논문 톤", "Paper Tone") : creationType === "story" ? ui("스토리 톤", "Story Tone") : ui("톤", "Tone")}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setToneMode("normal")}
                    className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${toneMode === "normal" ? 'bg-black text-white' : 'bg-white hover:bg-slate-100'}`}
                  >
                    {ui("일반", "Normal")}
                  </button>
                  <button
                    onClick={() => setToneMode("gag")}
                    className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${toneMode === "gag" ? 'bg-yellow-300 text-black' : 'bg-white hover:bg-slate-100'}`}
                  >
                    {ui("개그", "Humor")}
                  </button>
                </div>
                {toneMode === "gag" && (
                  <div className="mt-3">
                    <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("개그 강도", "Humor Level")}</p>
                    <div className="grid grid-cols-3 gap-2">
                      <button
                        onClick={() => setToneLevel("low")}
                        className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${toneLevel === "low" ? 'bg-black text-white' : 'bg-white hover:bg-slate-100'}`}
                      >
                        {ui("약", "Low")}
                      </button>
                      <button
                        onClick={() => setToneLevel("medium")}
                        className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${toneLevel === "medium" ? 'bg-black text-white' : 'bg-white hover:bg-slate-100'}`}
                      >
                        {ui("중", "Medium")}
                      </button>
                      <button
                        onClick={() => setToneLevel("high")}
                        className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${toneLevel === "high" ? 'bg-black text-white' : 'bg-white hover:bg-slate-100'}`}
                      >
                        {ui("강", "High")}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {!isPaperSelected && (
              <div className="mb-8 p-6 bg-slate-50 border-2 border-black">
                <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("말투/제스처", "Tone & Gesture")}</p>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {DELIVERY_STYLE_PRESETS.map((p) => {
                    return (
                      <button
                        key={p.id}
                        onClick={() => setDeliveryStyleId(p.id)}
	                        title={getDeliveryStyleLabel(p.id, uiLanguage)}
                        className={`py-2 border-2 font-black text-[10px] uppercase transition-colors ${deliveryStyleId === p.id
                          ? "border-blue-600 bg-blue-50 text-blue-700"
                          : "border-black bg-white hover:bg-slate-100"
                        }`}
                      >
	                        {getDeliveryStyleLabel(p.id, uiLanguage)}
                      </button>
                    );
                  })}
                </div>
                {deliveryStyleId === "custom" && (
                  <div className="mt-3">
                    <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("커스텀 지시", "Custom Instruction")}</p>
                    <textarea
                      value={deliveryCustomInstruction}
                      onChange={(e) => setDeliveryCustomInstruction(e.target.value)}
                      placeholder={ui('예: "아주 건조한 사무적인 말투 + 손짓 최소화"', 'Example: "very dry office tone + minimal gestures"')}
                      className="w-full border-2 border-black p-3 font-mono text-[10px] bg-white h-24 resize-y"
                    />
                  </div>
                )}
              </div>
              )}

              {creationType === "educational" && (<>
              <p className="text-sm font-bold text-slate-500 mb-4 uppercase">
                {ui("무엇이 궁금해?", "What are you curious about?")}
              </p>
              <input
                type="text"
                value={topic}
                onChange={(e) => {
                  setTopic(e.target.value);
                  clearResearchDigest();
                }}
                aria-invalid={isTopicRequiredMissing}
                aria-describedby={isTopicRequiredMissing ? "topic-required-message" : undefined}
                placeholder={ui("예: as if 사용법, 광합성 원리", "Example: how to use 'as if', photosynthesis")}
                className={`w-full border-4 p-4 md:p-6 text-lg md:text-xl font-bold outline-none transition-colors ${
                  isTopicRequiredMissing
                    ? "border-red-600 bg-red-50 placeholder-red-300 focus:bg-red-50 focus:ring-4 focus:ring-red-100"
                    : "border-black bg-white focus:bg-yellow-50"
                } ${isTopicRequiredMissing ? "mb-2" : "mb-8"}`}
              />
              {isTopicRequiredMissing && (
                <p id="topic-required-message" className="mb-8 text-xs font-black text-red-600">
                  {ui("필수 입력 항목이야. 학습할 주제를 먼저 입력해줘.", "Required field. Enter the topic to learn first.")}
                </p>
              )}
              </>)}

              <div className="mb-8">
                {creationType === "educational" && (<>
                <div className="grid grid-cols-1 gap-3">
                  <button
                    type="button"
                    onClick={handleAnalyzeResearch}
                    disabled={isResearchAnalyzing || !(topic.trim() || researchReportText.trim() || researchReportFile)}
                    className="w-full min-h-[60px] bg-black text-white px-5 py-4 text-base font-black hover:bg-blue-700 transition-colors flex items-center justify-center gap-2 disabled:bg-slate-400 disabled:opacity-100 disabled:cursor-not-allowed"
                  >
                    {isResearchAnalyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Globe size={14} />}
                    {ui("AI로 핵심 정리하기", "Summarize with AI")}
                  </button>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="mr-1 text-[10px] font-black uppercase text-slate-500">{ui("선택 자료 추가", "Optional material")}</span>
                    <label className="flex items-center justify-center gap-1 text-[10px] font-black uppercase bg-white border-2 border-black px-3 py-2 hover:bg-yellow-50 cursor-pointer">
                      <Upload size={12} /> {ui("PDF/TXT", "PDF/TXT")}
                      <input
                        type="file"
                        accept=".txt,.md,.json,.pdf,text/plain,application/json,application/pdf"
                        className="hidden"
                        onClick={(e) => {
                          (e.currentTarget as HTMLInputElement).value = "";
                        }}
                        onChange={(e) => handleResearchFileChange(e.target.files?.[0] || null)}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => setIsManualMaterialOpen((prev) => !prev)}
                      className={`flex items-center justify-center gap-1 text-[10px] font-black uppercase border-2 border-black px-3 py-2 transition-colors ${
                        isManualMaterialOpen ? "bg-yellow-50" : "bg-white hover:bg-slate-100"
                      }`}
                    >
                      <FileText size={12} /> {ui("직접 입력", "Paste")}
                    </button>
                  </div>

                  {(researchReportFile || researchDigestText) && (
                    <div className="flex flex-wrap items-center gap-2">
                      {researchReportFile && (
                        <>
                          <p className="text-[10px] font-bold text-slate-500">
                            {ui("업로드됨", "Uploaded")}: <span className="font-black">{researchReportFile.name}</span>
                          </p>
                          <button
                            type="button"
                            onClick={() => handleResearchFileChange(null)}
                            className="text-[10px] font-black uppercase bg-white border-2 border-black px-2 py-1 hover:bg-slate-100"
                          >
                            {ui("파일 지우기", "Clear File")}
                          </button>
                        </>
                      )}
                      {researchDigestText && (
                        <button
                          type="button"
                          onClick={clearResearchDigest}
                          className="bg-white text-black px-3 py-1 text-[10px] font-black border-2 border-black hover:bg-slate-100 transition-colors"
                        >
                          {ui("초기화", "Reset")}
                        </button>
                      )}
                    </div>
                  )}

                  {isManualMaterialOpen && (
                    <div>
                      <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("자료 직접 입력", "Enter Material")}</p>
                      <textarea
                        value={researchReportText}
                        onChange={(e) => {
                          setResearchReportText(e.target.value);
                          clearResearchDigest();
                        }}
                        placeholder={ui("수업자료, 설명문, 기사, 유튜브 대본, 교재 내용을 붙여넣어줘.", "Paste class notes, articles, transcripts, or textbook text here.")}
                        className="w-full border-2 border-black p-3 font-mono text-[10px] bg-white h-36 resize-y"
                      />
                    </div>
                  )}

                  {researchDigestError && (
                    <p className="text-[10px] font-black text-red-600">{ui("해설 원고 생성 오류", "Story draft error")}: {researchDigestError}</p>
                  )}

                  {researchDigestWarnings.length > 0 && (
                    <div className="border-2 border-yellow-400 bg-yellow-50 p-3">
                      <p className="text-[10px] font-black uppercase text-yellow-800 mb-1">{ui("경고", "Warnings")}</p>
                      <ul className="list-disc pl-4 text-[10px] font-bold text-yellow-900 space-y-1">
                        {researchDigestWarnings.slice(0, 6).map((w, idx) => (
                          <li key={idx}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {researchDigestText && (
                    <div>
                      <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("소설형 해설 원고", "Story-style explainer")}</p>
                      <textarea
                        value={researchDigestText}
                        onChange={(e) => setResearchDigestText(e.target.value)}
                        className="w-full border-2 border-black p-3 font-mono text-[10px] bg-white h-40 resize-y"
                      />
                    </div>
                  )}
                </div>
                </>)}

                <div className={`${creationType === "educational" ? "mt-8 border-t-2 border-slate-200 pt-6" : ""} grid grid-cols-1 md:grid-cols-2 gap-4`}>
                  <div>
                    <p className="text-[10px] font-black uppercase text-slate-600 mb-2">
                      {isPaperSelected ? ui("길이", "Length") : ui("스크립트 상세도", "Script Detail")}
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                      <button
                        onClick={() => setScriptDetail("brief")}
                        className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${scriptDetail === "brief" ? "bg-black text-white" : "bg-white hover:bg-slate-100"}`}
                      >
                        {ui("간단히", "Brief")}
                      </button>
                      <button
                        onClick={() => setScriptDetail("normal")}
                        className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${scriptDetail === "normal" ? "bg-blue-600 text-white border-blue-600" : "bg-white hover:bg-slate-100"}`}
                      >
                        {ui("보통", "Normal")}
                      </button>
                      <button
                        onClick={() => setScriptDetail("detailed")}
                        className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${scriptDetail === "detailed" ? "bg-black text-white" : "bg-white hover:bg-slate-100"}`}
                      >
                        {ui("자세히", "Detailed")}
                      </button>
                    </div>
                  </div>

                  <div>
                    <p className="text-[10px] font-black uppercase text-slate-600 mb-2">
                      {isPaperSelected ? ui("해설 원고 기준 페이지 수", "Page Count From Story") : ui("페이지 수", "Page Count")}
                    </p>
                    <>
                      <div className="grid grid-cols-2 gap-2 mb-2">
                        <button
                          onClick={() => setPageCountMode("auto")}
                          className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${pageCountMode === "auto" ? "bg-black text-white" : "bg-white hover:bg-slate-100"}`}
                        >
                          {ui("자동", "Auto")}
                        </button>
                        <button
                          onClick={() => setPageCountMode("manual")}
                          className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${pageCountMode === "manual" ? "bg-blue-600 text-white border-blue-600" : "bg-white hover:bg-slate-100"}`}
                        >
                          {ui("수동", "Manual")}
                        </button>
                      </div>

                      {pageCountMode === "manual" ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={1}
                            max={MAX_PAGE_COUNT}
                            step={1}
                            value={targetPageCount}
                            onChange={(e) => {
                              const next = Number.parseInt(e.target.value || "1", 10);
                              setTargetPageCount(clampPageCount(Number.isFinite(next) ? next : 1));
                            }}
                            className="w-20 px-3 py-2 text-xs font-black border-2 border-black bg-white outline-none focus:bg-yellow-50"
                            aria-label="Target page count"
                          />
                          <span className="text-[10px] font-black uppercase text-slate-500">P</span>
                        </div>
                      ) : (
                        <p className="text-[10px] font-bold text-slate-500">
                          {creationType === "paper" && !paperBrief ? (
                            <>{ui("대기", "Waiting")}: <span className="font-black">{ui("해설 원고 생성 후 자동 추천", "auto after explainer story")}</span></>
                          ) : creationType === "story" && storyAdaptationMode !== "direct" && !storyPageSuggestions ? (
                            <>{ui("대기", "Waiting")}: <span className="font-black">{ui("AI 각색 후 자동 결정", "auto after AI adaptation")}</span></>
                          ) : creationType === "educational" && !pageSuggestions ? (
                            <>{ui("대기", "Waiting")}: <span className="font-black">{ui("AI 해설 원고 후 자동 추천", "auto after AI explainer")}</span></>
                          ) : (
                            <>{ui("추천", "Recommended")}: <span className="font-black">{targetPageCount}P</span></>
                          )}
                        </p>
                      )}
                    </>
                  </div>
                </div>
              </div>

              <div className={`grid grid-cols-1 ${isLearningComicSelected ? "md:grid-cols-3" : "md:grid-cols-2"} gap-8 mb-8`}>
                {isLearningComicSelected ? (
                  <div>
                    <p className="text-xs font-black text-slate-400 mb-3 uppercase flex items-center gap-2"><LayoutGrid size={14} /> {ui("레이아웃", "Layout Type")}</p>
                    <div className="grid grid-cols-3 gap-2">
                      {["low", "medium", "high"].map((v) => (
                        <button key={v} onClick={() => setLayoutVariety(v as LayoutVariety)} className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${layoutVariety === v ? 'bg-black text-white' : 'bg-white hover:bg-slate-100'}`}>
                          {v === 'low' ? ui('단순', 'Simple') : v === 'medium' ? ui('다이내믹', 'Dynamic') : ui('프로 · 추천', 'Pro · Recommended')}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div>
                  <p className="text-xs font-black text-slate-400 mb-3 uppercase flex items-center gap-2"><Layers size={14} /> {ui("해상도", "Resolution")}</p>
                  <div className="grid grid-cols-3 gap-2">
                    {IMAGE_SIZE_OPTIONS.map((s) => (
                      <button key={s} onClick={() => handleImageSizeChange(s)} className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${imageSize === s ? 'bg-blue-600 text-white border-blue-600' : 'bg-white hover:bg-slate-100'}`}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-xs font-black text-slate-400 mb-3 uppercase flex items-center gap-2"><Globe size={14} /> {ui("결과물 언어", "Output Language")}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setLanguage("ko")}
                      className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${language === "ko" ? "bg-black text-white" : "bg-white hover:bg-slate-100"
                        }`}
                    >
	                      {ui("한국어", "Korean")}
                    </button>
                    <button
                      onClick={() => setLanguage("en")}
                      className={`py-2 border-2 border-black font-black text-[10px] uppercase transition-colors ${language === "en" ? "bg-black text-white" : "bg-white hover:bg-slate-100"
                        }`}
                    >
                      English
                    </button>
                  </div>
                </div>
              </div>

              <div className="mb-8 p-6 bg-slate-50 border-2 border-black">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
	                  <div>
	                    <p className="text-[10px] font-black uppercase text-slate-600 mb-1">{ui("플래너 모델", "Planner Model")}</p>
	                    <p className="text-xs font-black text-slate-800">{getCodexTextModelLabel(geminiTextModel)} · Codex OAuth</p>
	                    {localApiAvailable && !geminiApiConfigured && (
	                      <p className="text-[10px] font-black text-red-600 mt-2">
	                        {ui("Codex OAuth가 준비되지 않아서 플랜 생성을 시작할 수 없어.", "Codex OAuth is not ready, so plan generation cannot start.")}
	                      </p>
	                    )}
	                    {!localApiAvailable && (
	                      <p className="text-[10px] font-black text-red-600 mt-2">
	                        {ui("로컬 서버가 연결되지 않아서 최종 플랜 생성을 시작할 수 없어.", "Local server is not connected, so plan generation cannot start.")}
	                      </p>
                    )}
                  </div>
                  <div className="md:min-w-[260px]">
                    <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("추론 강도", "Reasoning Effort")}</p>
                    <div className="grid grid-cols-3 gap-2">
                      <button
                        onClick={() => setGeminiReasoningEffort("low")}
                        className={`py-2 border-2 font-black text-[10px] uppercase transition-colors ${geminiReasoningEffort === "low" ? "border-black bg-black text-white" : "border-black bg-white hover:bg-slate-100"}`}
                      >
                        low
                      </button>
                      <button
                        onClick={() => setGeminiReasoningEffort("medium")}
                        className={`py-2 border-2 font-black text-[10px] uppercase transition-colors ${geminiReasoningEffort === "medium" ? "border-black bg-black text-white" : "border-black bg-white hover:bg-slate-100"}`}
                      >
                        medium
                      </button>
                      <button
                        onClick={() => setGeminiReasoningEffort("high")}
                        className={`py-2 border-2 font-black text-[10px] uppercase transition-colors ${geminiReasoningEffort === "high" ? "border-black bg-black text-white" : "border-black bg-white hover:bg-slate-100"}`}
                      >
                        high
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <button
                onClick={() => setStatus(AppStatus.STYLE_SELECT)}
                disabled={!canProceedMissionSetup}
                className="w-full py-6 font-black text-lg md:text-xl bg-black text-white hover:bg-blue-600 transition-all uppercase italic shadow-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
              >
                <Palette className="w-6 h-6" /> {ui("다음: 그림체 선택", "Next: Choose Art Style")} <ArrowRight />
              </button>
              </>)}
            </div>
          </div>
        )}

        {status === AppStatus.PLANNING && (
          <div className="relative flex flex-col items-center justify-center py-24 md:py-32 bg-white border-4 border-black comic-shadow max-w-xl mx-auto">
            <div className="absolute top-4 left-4">
              <PreviousStepButton />
            </div>
            <Loader2 className="animate-spin w-16 h-16 text-blue-600 mb-6" />
            <p className="font-black text-xl md:text-2xl uppercase italic tracking-tighter">
              {isQuickPipelineRunning && quickPipelineProgress
                ? quickPipelineProgress.message
                : busyPhase === "translating" ? ui("언어 재생성 중...", "Regenerating Language...") : ui("AI 분석 중...", "AI Deep-Dive Analyzing...")}
            </p>
            <p className="text-xs font-bold text-slate-400 mt-2 uppercase text-center px-4">
              {isQuickPipelineRunning && quickPipelineProgress
                ? `${quickStageLabel(quickPipelineProgress.stage)} · ${quickPipelineProgress.detail || ui("간편 파이프라인을 순서대로 실행 중이야.", "Running the quick pipeline step by step.")}`
                : busyPhase === "translating"
                ? ui("같은 플랜을 유지한 채 텍스트 언어만 바꾸는 중이야.", "Changing only the text language while keeping the same plan.")
                : creationType === "paper"
                  ? ui("논문 구조를 읽고 설명 만화용 페이지 흐름으로 재구성하는 중이야.", "Reading the paper structure and rebuilding it as an explanatory comic flow.")
                  : ui("주제를 조사하고 주인공의 역할을 설계 중이야.", "Researching the topic and designing the protagonist role.")}
            </p>
            <div className="mt-8 w-[min(420px,calc(100%-48px))] border-2 border-black bg-slate-50 p-4 text-left">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-[10px] font-black uppercase text-blue-600">
                    {isQuickPipelineRunning && quickPipelineProgress ? quickStageLabel(quickPipelineProgress.stage) : planningProgressDetail.label}
                  </p>
                  <p className="mt-1 text-[11px] font-black text-slate-700">
                    {isQuickPipelineRunning && quickPipelineProgress
                      ? `${ui("전체", "Total")} ${formatBusyDuration(quickPipelineElapsedSeconds, uiLanguage)} · ${ui("현재 단계", "Stage")} ${formatBusyDuration(quickPipelineStageElapsedSeconds, uiLanguage)} · ${ui("시도", "Attempt")} ${quickPipelineProgress.attempt}`
                      : `${ui("경과", "Elapsed")} ${formatBusyDuration(planningElapsedSeconds, uiLanguage)} · ${planningProgressDetail.remainingLabel}`}
                  </p>
                </div>
                <strong className="text-2xl font-black italic text-black">
                  {isQuickPipelineRunning && quickPipelineProgress ? quickPipelinePercent : planningProgressDetail.percent}%
                </strong>
              </div>
              <div className="mt-3 h-3 border-2 border-black bg-white">
                <div
                  className="h-full bg-blue-600 transition-all duration-700"
                  style={{ width: `${isQuickPipelineRunning && quickPipelineProgress ? quickPipelinePercent : planningProgressDetail.percent}%` }}
                />
              </div>
              <p className="mt-3 text-[10px] font-bold leading-relaxed text-slate-500">
                {isQuickPipelineRunning && quickPipelineProgress
                  ? ui("자료 정리, 캐릭터 제안, 콘티 생성, 이미지 생성을 한 번에 묶어서 진행 중이야. 오류가 나면 해당 단계만 한 번 다시 시도해.", "Digest, cast, plan, and images are running as one pipeline. Failed stages retry once.")
                  : planningProgressDetail.helper}
              </p>
            </div>
          </div>
        )}

        {status === AppStatus.PLAN_REVIEW && seriesPlan && (
          <div className="bg-white border-4 border-black p-6 md:p-10 comic-shadow animate-fade-in max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-4">
                <div className="bg-black text-white p-2">
                  <Monitor size={20} />
                </div>
                <h2 className="text-2xl md:text-3xl font-black uppercase">{ui("04. 내러티브 플랜", "04. Narrative Plan")}</h2>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDevPromptCheckOpen(true)}
                  className="border-2 border-black bg-white hover:bg-yellow-100 px-3 py-2 text-[10px] font-black uppercase flex items-center gap-2"
                  title={ui("프롬프트/결과를 복사해 디버깅에 사용", "Copy prompts/results for debugging")}
                >
                  <Copy size={14} /> {ui("프롬프트 체크", "Prompt Check")}
                </button>
                <PreviousStepButton />
              </div>
            </div>

            <div className="mb-8 p-6 bg-yellow-50 border-4 border-black rotate-1">
              <h4 className="flex items-center gap-2 text-sm font-black uppercase text-blue-600 mb-2">
                <Lightbulb size={18} /> {ui("핵심 인사이트", "The Core Insight")}
              </h4>
              <p className="text-lg font-black leading-tight">
                {seriesPlan.plan_meta.rationale_short}
              </p>
              <div className="mt-4 inline-block bg-blue-600 text-white px-2 py-1 text-[10px] font-black uppercase">
                {ui("역할", "Role")}: {narrativeRole === "narrator" ? ui("가이드/관찰자", "Guide/Observer") : ui("배우/수행자", "Actor/Performer")}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <div className="inline-block bg-black text-white px-2 py-1 text-[10px] font-black uppercase">
                  {ui("독자", "Audience")}: {audienceLevel}
                </div>
                <div className="inline-block bg-white text-black border-2 border-black px-2 py-1 text-[10px] font-black uppercase">
                  {ui("결과물 언어", "Output Language")}: {seriesPlan.series_spec.series.language === "en" ? "EN" : "KO"}
                </div>
                <div className="inline-block bg-white text-black border-2 border-black px-2 py-1 text-[10px] font-black uppercase">
	                  {ui("말투", "Tone")}: {getDeliveryStyleLabel(deliveryStyleId, uiLanguage)}
                </div>
              </div>
            </div>

            <div className="mb-10 bg-blue-50 border-2 border-blue-200 p-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h4 className="text-sm font-black text-blue-800 uppercase flex items-center gap-2 mb-1">
                    <Settings2 size={16} /> {ui("페이지 길이", "Page Length")}
                  </h4>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex bg-white border-2 border-black overflow-hidden">
                    <button
                      onClick={() => switchPlanLanguage("ko")}
                      className={`px-3 py-2 text-[10px] font-black uppercase border-r last:border-r-0 transition-colors ${seriesPlan.series_spec.series.language === "ko" ? "bg-black text-white" : "hover:bg-slate-100"
                        }`}
                      title={ui("한국어로 재생성", "Regenerate in Korean")}
                    >
                      KO
                    </button>
                    <button
                      onClick={() => switchPlanLanguage("en")}
                      className={`px-3 py-2 text-[10px] font-black uppercase transition-colors ${seriesPlan.series_spec.series.language === "en" ? "bg-black text-white" : "hover:bg-slate-100"
                        }`}
                      title={ui("영어로 재생성", "Regenerate in English")}
                    >
                      EN
                    </button>
                  </div>
                  <div className="flex bg-white border-2 border-black overflow-hidden">
                    {[1, 2, 3, 4].map(n => (
                      <button
                        key={n}
                        onClick={() => setTargetPageCount(n)}
                        className={`px-4 py-2 text-xs font-black border-r last:border-r-0 transition-colors ${targetPageCount === n ? 'bg-blue-600 text-white' : 'hover:bg-slate-100'}`}
                      >
                        {n}P
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={MAX_PAGE_COUNT}
                      step={1}
                      value={targetPageCount}
                      onChange={(e) => {
                        const next = Number.parseInt(e.target.value || "1", 10);
                        setTargetPageCount(clampPageCount(Number.isFinite(next) ? next : 1));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleGeneratePlan();
                      }}
                      className="w-20 px-3 py-2 text-xs font-black border-2 border-black bg-white outline-none focus:bg-yellow-50"
                      aria-label="Target page count"
                    />
                    <span className="text-[10px] font-black uppercase text-slate-500">P</span>
                  </div>
                  <button onClick={handleGeneratePlan} className="bg-black text-white px-4 py-2 text-xs font-black hover:bg-blue-700 transition-colors flex items-center gap-2">{ui("다시 플랜", "Replan")} <RotateCcw size={12} /></button>
                </div>
              </div>
            </div>

            <div className="space-y-4 mb-8 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
              {seriesPlan.pages.map((p, i) => (
                <div key={i} className="bg-slate-50 border-2 border-black p-5 flex justify-between items-center group hover:bg-white transition-colors">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="bg-blue-600 text-white px-2 py-0.5 text-[10px] font-black italic uppercase">{unitLabel} {p.page.index}</span>
                      <h3 className="text-base md:text-lg font-black inline-block truncate max-w-[22rem]">{p.page.chapter_title}</h3>
                      {pageScriptEditedAt[p.page.index] ? (
                        <span className="bg-yellow-200 text-black border-2 border-black px-2 py-0.5 text-[9px] font-black uppercase">
                          {ui("수정됨", "Edited")}
                        </span>
                      ) : null}
                      {pageStyleOverrides[p.page.index] ? (
                        <span className="bg-purple-200 text-black border-2 border-black px-2 py-0.5 text-[9px] font-black uppercase">
                          {ui("스타일", "Style")}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openPageEditAction(p.page.index)}
                      className="border-2 border-black bg-white hover:bg-yellow-100 px-3 py-1 text-[10px] font-black uppercase"
                      title={isI2VSelected ? ui("이 프레임 수정", "Edit this frame") : ui("이 페이지 수정", "Edit this page")}
                    >
                      {ui("수정", "Edit")}
                    </button>
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                      <ChevronRight className="text-blue-600" />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <button onClick={() => setStatus(AppStatus.READY_TO_GENERATE)} className="w-full bg-black text-white py-6 font-black text-xl hover:bg-blue-600 transition-colors uppercase italic shadow-2xl flex items-center justify-center gap-3">
              {isI2VSelected ? ui("프레임 생성", "Generate Frames") : ui("최종 만화 생성", "Generate Final Comic")} <ArrowRight />
            </button>
          </div>
        )}

        {(status === AppStatus.READY_TO_GENERATE || status === AppStatus.GENERATING_PANELS) && (
          <div className="space-y-12 animate-fade-in">
            <div className="space-y-4">
              <div className="bg-white border-4 border-black p-4 md:p-6 sticky top-4 md:top-6 z-50 comic-shadow">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <PreviousStepButton className="mb-2" />
                    <p className="text-[10px] font-black uppercase text-blue-700 mb-1">
                      {isI2VSelected ? ui("프레임 생성", "Frame Generation") : ui("이미지 생성", "Image Generation")}
                    </p>
                    <p className="text-lg md:text-2xl font-black italic tracking-tight truncate">{seriesPlan?.series_spec.series.title}</p>
                    <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-black text-slate-600">
                      {seriesPlan && (
                        <span className="border-2 border-black bg-slate-50 px-2 py-1">
                          {ui("진행", "Progress")}: {generatedProgressLabel}
                        </span>
                      )}
                      <span className="border-2 border-black bg-slate-50 px-2 py-1">
                        {imageSizeSummary} · {imageQualitySummary}
                      </span>
	                      <span className="border-2 border-black bg-slate-50 px-2 py-1">
	                        {readerModeSummary}
	                      </span>
	                      {generationPhaseMessage ? (
	                        <span className="border-2 border-blue-500 bg-blue-50 px-2 py-1 text-blue-700">
	                          {generationPhaseMessage}
	                        </span>
	                      ) : null}
	                      {failedUnitCount > 0 ? (
	                        <span className="border-2 border-red-500 bg-red-50 px-2 py-1 text-red-700">
	                          {failedUnitCount} {isI2VSelected ? ui("프레임 실패", "frame failed") : ui("페이지 실패", "page failed")}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                  {nextPendingPage && (
                    <button
                      type="button"
                      onClick={() => generatePage(nextPendingPage.page.index, undefined, undefined, { allowConcurrent: true })}
                      disabled={isPageGenerating(nextPendingPage.page.index) || autoGeneratePages}
                      className={`px-4 py-3 border-2 border-black text-[10px] md:text-xs font-black uppercase flex items-center gap-2 ${isPageGenerating(nextPendingPage.page.index) || autoGeneratePages ? "bg-slate-200 text-slate-400 cursor-not-allowed" : "bg-blue-600 text-white hover:bg-blue-700"}`}
                    >
                      {isPageGenerating(nextPendingPage.page.index) ? <Loader2 className="animate-spin" size={14} /> : <Sparkles size={14} />}
                      {autoGeneratePages ? ui("자동 생성 중", "Auto running") : `${ui("다음 생성", "Generate next")} ${unitLabel} ${nextPendingPage.page.index}`}
	                    </button>
	                  )}
	                  {isAnyPageGenerating && (
	                    <button
	                      type="button"
	                      onClick={cancelInFlightGeneration}
	                      className="px-4 py-3 border-2 border-red-600 bg-red-50 text-red-700 text-[10px] md:text-xs font-black uppercase hover:bg-red-100"
	                    >
	                      {ui("요청 취소", "Cancel requests")}
	                    </button>
	                  )}
	                  {seriesPlan && (
	                    <button
                      type="button"
                      onClick={() => {
                        if (autoGeneratePages) {
                          setAutoGeneratePages(false);
                          return;
                        }
                        setRegenerateAllPages(false);
                        setRegenerateCursor(1);
                        setAutoGeneratePages(true);
                      }}
                      disabled={pageResults.length >= seriesPlan.pages.length}
                      className={`px-4 py-3 border-2 border-black text-[10px] md:text-xs font-black uppercase ${autoGeneratePages ? "bg-blue-600 text-white" : pageResults.length >= seriesPlan.pages.length ? "bg-slate-200 text-slate-400 cursor-not-allowed" : "bg-white hover:bg-slate-100"}`}
	                    >
	                      {autoGeneratePages
	                        ? ui("자동 생성 끄기", "Stop auto")
	                        : canParallelAutoGeneratePages
	                          ? ui("남은 페이지 병렬 생성", "Generate remaining in parallel")
	                          : ui("남은 페이지 자동 생성", "Auto-generate remaining")}
	                    </button>
                  )}
                  {seriesPlan && (
                    <button
                      type="button"
                      onClick={downloadAllPagesAsZip}
                      disabled={pageResults.length === 0 || isDownloadingZip}
                      className={`px-4 py-3 border-2 border-black text-[10px] md:text-xs font-black uppercase flex items-center gap-2 ${pageResults.length === 0 || isDownloadingZip ? "bg-slate-200 text-slate-400 cursor-not-allowed" : "bg-white hover:bg-slate-100"}`}
                    >
                      {isDownloadingZip ? <Loader2 className="animate-spin" size={14} /> : <Download size={14} />}
                      {ui("ZIP 다운로드", "Download ZIP")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setGenerationSettingsOpen((prev) => !prev)}
                    className={`px-4 py-3 border-2 border-black text-[10px] md:text-xs font-black uppercase flex items-center gap-2 ${generationSettingsOpen ? "bg-black text-white" : "bg-white hover:bg-slate-100"}`}
                  >
                    <Settings2 size={14} />
                    {generationSettingsOpen ? ui("설정 접기", "Hide settings") : ui("생성 설정", "Generation settings")}
                  </button>
                  </div>
                </div>

              </div>

              {generationSettingsOpen && (
                <div className="bg-white border-4 border-black p-4 md:p-6 comic-shadow">
                  <div className="mb-5 border-b-2 border-black pb-4">
                    <p className="text-[10px] font-black uppercase text-blue-700 flex items-center gap-2">
                      <Settings2 size={14} /> {ui("생성 설정", "Generation settings")}
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
                    {seriesPlan && (
                      <div className="border-2 border-black bg-slate-50 p-3">
                        <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("결과 언어", "Output language")}</p>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            onClick={() => switchPlanLanguage("ko")}
                            disabled={status === AppStatus.GENERATING_PANELS}
                            className={`py-2 border-2 border-black text-[10px] font-black uppercase ${seriesPlan.series_spec.series.language === "ko" ? "bg-black text-white" : "bg-white hover:bg-slate-100"} ${status === AppStatus.GENERATING_PANELS ? "opacity-50 cursor-not-allowed" : ""}`}
                          >
	                            {ui("한국어", "Korean")}
                          </button>
                          <button
                            onClick={() => switchPlanLanguage("en")}
                            disabled={status === AppStatus.GENERATING_PANELS}
                            className={`py-2 border-2 border-black text-[10px] font-black uppercase ${seriesPlan.series_spec.series.language === "en" ? "bg-black text-white" : "bg-white hover:bg-slate-100"} ${status === AppStatus.GENERATING_PANELS ? "opacity-50 cursor-not-allowed" : ""}`}
                          >
                            English
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="border-2 border-black bg-slate-50 p-3">
                      <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("해상도", "Resolution")}</p>
                      <div className="grid grid-cols-3 gap-2">
                        {IMAGE_SIZE_OPTIONS.map((size) => (
                          <button
                            key={`ready-size-${size}`}
                            type="button"
                            onClick={() => handleImageSizeChange(size)}
                            disabled={status === AppStatus.GENERATING_PANELS}
                            className={`py-2 border-2 border-black text-[10px] font-black uppercase ${imageSize === size ? "bg-blue-600 text-white" : "bg-white hover:bg-slate-100"} ${status === AppStatus.GENERATING_PANELS ? "cursor-not-allowed opacity-50" : ""}`}
                            title={ui(`${size} 출력 해상도로 변경`, `Switch to ${size} output resolution`)}
                          >
                            {size === "1K" ? ui("1K 빠름", "1K fast") : size === "2K" ? ui("2K 선명", "2K sharp") : ui("4K 고해상도", "4K high-res")}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="border-2 border-black bg-slate-50 p-3">
                      <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("이미지 품질", "Image quality")}</p>
                      <div className="grid grid-cols-3 gap-2">
                        {(["low", "medium", "high"] as CodexImageQuality[]).map((quality) => (
                          <button
                            key={`codex-quality-${quality}`}
                            type="button"
                            onClick={() => handleCodexImageQualityChange(quality)}
                            disabled={status === AppStatus.GENERATING_PANELS}
                            className={`py-2 border-2 border-black text-[10px] font-black uppercase ${codexImageQuality === quality ? "bg-emerald-600 text-white" : "bg-white hover:bg-slate-100"} ${status === AppStatus.GENERATING_PANELS ? "cursor-not-allowed opacity-50" : ""}`}
                          >
                            {quality === "low" ? ui("빠르게", "fast") : quality === "high" ? ui("높게", "high") : ui("보통", "normal")}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="border-2 border-black bg-slate-50 p-3">
                      <p className="text-[10px] font-black uppercase text-slate-600 mb-2">{ui("보기 방식", "Viewing mode")}</p>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setOutputReaderMode("visual")}
                          className={`py-2 border-2 border-black text-[10px] font-black uppercase ${outputReaderMode === "visual" ? "bg-black text-white" : "bg-white hover:bg-slate-100"}`}
                        >
                          {ui("이미지만", "Images")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setOutputReaderMode("visual_plus_script")}
                          className={`py-2 border-2 border-black text-[10px] font-black uppercase ${outputReaderMode === "visual_plus_script" ? "bg-blue-600 text-white" : "bg-white hover:bg-slate-100"}`}
                        >
                          {ui("장면 텍스트", "Scene text")}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-4">
                    <div className="border-2 border-black bg-white p-3 lg:col-span-2">
                      <p className="text-[10px] font-black uppercase text-slate-600 mb-1">{ui("이미지 생성 방식", "Image generation")}</p>
                      <p className="text-xs font-black text-slate-800 mt-2">{currentImageEngineLabel}</p>
                    </div>

                    {seriesPlan && (
                      <button
                        type="button"
                        onClick={() => setUseCrossPageStyleConsistency((prev) => !prev)}
                        className={`border-2 border-black p-3 text-left text-[10px] font-black uppercase ${useCrossPageStyleConsistency ? "bg-emerald-600 text-white border-emerald-700" : "bg-white hover:bg-slate-100"}`}
                        title={ui("이전 생성 페이지를 스타일 일관성 참고 이미지로 자동 첨부할지 설정", "Use previous pages as style consistency references")}
                      >
                        <span className="block">{ui("앞 페이지 그림체 이어가기", "Continue page style")}</span>
                        <span className="mt-1 block text-[10px] font-bold opacity-80">{useCrossPageStyleConsistency ? "ON" : "OFF"}</span>
                      </button>
                    )}

                    {seriesPlan && (
                      <button
                        type="button"
                        onClick={() => {
                          if (regenerateAllPages) {
                            cancelInFlightGeneration();
                            return;
                          }
                          setSystemError(null);
                          setAutoGeneratePages(false);
                          setRegenerateCursor(1);
                          setRegenerateAllPages(true);
                        }}
                        className={`border-2 border-black p-3 text-left text-[10px] font-black uppercase ${regenerateAllPages ? "bg-red-600 text-white" : "bg-white hover:bg-slate-100"}`}
                      >
                        <span className="block">{regenerateAllPages ? ui("전체 다시 그리기 중지", "Stop redraw all") : ui("전체 다시 그리기", "Redraw all")}</span>
                        <span className="mt-1 block text-[10px] font-bold opacity-80">
                          {Math.min(Math.max(regenerateCursor - 1, 0), seriesPlan.pages.length)}/{seriesPlan.pages.length}
                        </span>
                      </button>
                    )}

                    {seriesPlan && (
                      <button
                        type="button"
                        onClick={exportCodexHandoffZip}
                        disabled={isExportingCodexHandoff}
                        className={`border-2 border-black p-3 text-left text-[10px] font-black uppercase ${isExportingCodexHandoff ? "bg-slate-200 text-slate-400 cursor-not-allowed" : "bg-white hover:bg-slate-100"}`}
                        title={ui("Codex 앱에서 생성할 수 있는 프롬프트/레퍼런스 묶음을 ZIP으로 내보내기", "Export a prompt/reference ZIP for use in Codex")}
                      >
                        <span className="flex items-center gap-2">{isExportingCodexHandoff ? <Loader2 className="animate-spin" size={14} /> : <FileText size={14} />} {ui("Codex 전달 묶음", "Codex handoff")}</span>
                      </button>
                    )}
                  </div>
                </div>
              )}

            </div>

            <div className="border-2 border-black bg-yellow-50 px-4 py-3 text-[10px] font-bold text-slate-600">
              <span className="font-black text-slate-900">{ui("현재 설정", "Current settings")}: </span>
              {imageSizeSummary} · {imageQualitySummary} · {currentImageEngineLabel}
            </div>

            {failedUnitCount > 0 ? (
              <div className="border-4 border-red-500 bg-red-50 p-4 md:p-5">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <p className="text-xs font-black uppercase text-red-700 flex items-center gap-2">
                      <AlertTriangle size={15} /> {isI2VSelected ? ui("일부 프레임 생성 실패", "Some frames failed") : ui("일부 페이지 생성 실패", "Some pages failed")}
                    </p>
                    <p className="mt-2 text-[10px] font-bold text-red-800">
                      {ui("이미 만든 결과는 유지했어. 실패한 항목만 다시 생성하거나 건너뛰고 계속 만들 수 있어.", "Existing results are preserved. Redraw only the failed item or skip ahead.")}
                    </p>
                  </div>
                  {pageResults.length > 0 ? (
                    <button
                      type="button"
                      onClick={downloadAllPagesAsZip}
                      disabled={isDownloadingZip}
                      className={`px-4 py-2 border-2 border-black text-[10px] font-black uppercase flex items-center gap-2 ${isDownloadingZip ? "bg-slate-200 text-slate-400 cursor-not-allowed" : "bg-white hover:bg-slate-100"}`}
                    >
                      {isDownloadingZip ? <Loader2 className="animate-spin" size={14} /> : <Download size={14} />}
                      {ui("현재까지 ZIP", "ZIP so far")}
                    </button>
                  ) : null}
                </div>
                <div className="mt-3 space-y-2">
                  {pageErrorEntries.map((entry) => (
                    <div key={`page_error_banner_${entry.pageIndex}`} className="border-2 border-red-300 bg-white p-3 text-left">
                      <p className="text-[10px] font-black uppercase text-red-700">
                        {unitLabel} {entry.pageIndex}
                      </p>
                      <p className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap text-[10px] font-bold text-slate-700">{entry.message}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="bg-white border-4 border-black p-4 md:p-6 comic-shadow">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between mb-4">
                <div>
                  <p className="text-[10px] font-black uppercase text-blue-700 flex items-center gap-2">
                    <UserCheck size={14} /> {ui("캐릭터 일관성 참고 이미지(선택)", "Character Consistency References (Optional)")}
                  </p>
                </div>
                <p className="text-[10px] font-black uppercase text-slate-500">
                  {ui("캐릭터당 최대", "Max")} {MAX_REF_IMAGES_PER_CHARACTER}
                </p>
              </div>

              {cast.length === 0 ? (
                <div className="border-2 border-black bg-slate-50 p-3">
                  <p className="text-[10px] font-bold text-slate-500">{ui("등록된 캐릭터가 없어. 캐릭터 설정 단계에서 먼저 추가해줘.", "No characters registered. Add them in Character Setup first.")}</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
	                  {cast.map((c) => {
	                    const roleLabel = c.role === "protagonist" ? ui("주연", "PROTAGONIST") : ui("조연", "SUPPORTING");
	                    const displayName = String(c.name || "").trim() || (c.role === "protagonist" ? ui("주인공", "Protagonist") : ui("조연", "Supporting"));
	                    const inputId = `ready-cast-img-${c.id}`;

	                    return (
	                      <div key={`${c.id}_ready_refs`} className="border-2 border-black bg-slate-50 p-3">
	                        <div className="flex items-center justify-between gap-2 mb-2">
	                          <p className="text-[10px] font-black uppercase text-slate-700 truncate">
	                            {roleLabel} · {displayName}
	                          </p>
	                        </div>

	                        {renderCharacterReferenceControls(c, {
	                          inputId,
	                          displayName,
	                          altFallback: "character",
	                          panelClassName: "bg-transparent",
	                          titleClassName: "sr-only",
	                          countClassName: "text-[10px] font-bold text-slate-500",
	                          uploadDisabled: status === AppStatus.GENERATING_PANELS,
	                          compact: true
	                        })}
	                      </div>
	                    );
	                  })}
                </div>
              )}
            </div>

            {isWebtoonSelected ? (
              <div className="space-y-6">
                <div className="bg-white border-4 border-black p-4 md:p-6 comic-shadow">
                  <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                    <div>
                      <p className="text-[10px] font-black uppercase text-emerald-700">{ui("웹툰 리더", "Webtoon Reader")}</p>
                      <h4 className="text-xl md:text-2xl font-black uppercase italic mt-1">{ui("연속 세로 리더", "Continuous Scroll Reader")}</h4>
                      <p className="mt-2 text-[10px] md:text-xs font-bold text-slate-500">
                        {generatedPageCount}/{seriesPlan?.pages.length || 0}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {nextPendingPage ? (
                        <button
                          type="button"
                          onClick={() => generatePage(nextPendingPage.page.index, undefined, undefined, { allowConcurrent: true })}
                          disabled={isPageGenerating(nextPendingPage.page.index) || autoGeneratePages}
                          className={`px-4 py-3 border-2 border-black text-[10px] md:text-xs font-black uppercase ${isPageGenerating(nextPendingPage.page.index) || autoGeneratePages ? "bg-slate-200 text-slate-400 cursor-not-allowed" : "bg-blue-600 text-white hover:bg-blue-700"}`}
                        >
                          {autoGeneratePages ? ui("자동 대기 중...", "Auto Queue...") : `${ui("생성", "Generate")} ${unitLabel} ${nextPendingPage.page.index}`}
                        </button>
                      ) : (
                        <div className="px-4 py-3 border-2 border-black bg-emerald-50 text-[10px] md:text-xs font-black uppercase text-emerald-700">
                          {ui("모든 페이지 준비됨", "All Pages Ready")}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="bg-white border-4 border-black p-4 md:p-6 comic-shadow">
                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between mb-4">
                    <p className="text-[10px] font-black uppercase text-slate-500">{ui("페이지 컨트롤", "Page Controls")}</p>
                    <p className="text-[10px] font-black uppercase text-slate-500">
                      Segments {webtoonEpisodeResult?.segment_urls.length || 0}
                      {webtoonEpisodeResult ? ` · ${webtoonEpisodeResult.total_height_estimate.toLocaleString()}px` : ""}
                    </p>
                  </div>
                  <div className="space-y-3">
                    {seriesPlan?.pages.map((p) => {
	                      const res = pageResultsMap.get(p.page.index);
	                      const isCur = isPageGenerating(p.page.index);
	                      const pageError = pageErrors[p.page.index] || "";
	                      const nextAfterFailedPage = pageError
	                        ? seriesPlan?.pages.find((candidate) => candidate.page.index > p.page.index && !pageResultsMap.has(candidate.page.index) && !pageErrors[candidate.page.index]) || null
	                        : null;
	                      const nextAfterFailedGenerating = nextAfterFailedPage ? isPageGenerating(nextAfterFailedPage.page.index) : false;
	                      const editedAt = pageScriptEditedAt[p.page.index] || 0;
                      const styleEditedAt = pageStyleEditedAt[p.page.index] || 0;
                      const renderedAt = pageRenderedAt[p.page.index] || 0;
                      const renderedImageSize = pageRenderedImageSize[p.page.index] || null;
                      const renderedEngineKey = pageRenderedEngineKey[p.page.index] || null;
                      const renderedEngineLabel = getImageEngineChipLabelFromKey(renderedEngineKey);
                      const needsResolutionRedraw = Boolean(res) && Boolean(renderedImageSize) && renderedImageSize !== imageSize;
                      const needsEngineRedraw = Boolean(res) && Boolean(renderedEngineKey) && renderedEngineKey !== currentImageEngineKey;
                      const needsRedraw =
                        Boolean(res) &&
                        (editedAt > renderedAt || styleEditedAt > renderedAt || globalStyleEditedAt > renderedAt || needsResolutionRedraw || needsEngineRedraw);
                      const scrollRole = p.layout.scroll?.segment_role || "beat";

                      return (
                        <div key={`webtoon_row_${p.page.index}`} className="border-2 border-black bg-slate-50 p-3 md:p-4">
                          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="bg-black text-white px-2 py-0.5 text-[10px] font-black uppercase italic">{unitLabel} {p.page.index}</span>
                                <span className="border-2 border-black bg-white px-2 py-0.5 text-[10px] font-black uppercase text-slate-600">{scrollRole}</span>
                                {pageScriptEditedAt[p.page.index] ? (
                                  <span className="bg-yellow-200 text-black border-2 border-black px-2 py-0.5 text-[9px] font-black uppercase">{ui("수정됨", "Edited")}</span>
                                ) : null}
                                {pageStyleOverrides[p.page.index] ? (
                                  <span className="bg-purple-200 text-black border-2 border-black px-2 py-0.5 text-[9px] font-black uppercase">{ui("스타일", "Style")}</span>
                                ) : null}
	                                {needsRedraw ? (
	                                  <span className="bg-red-500 text-white border-2 border-black px-2 py-0.5 text-[9px] font-black uppercase">{ui("재생성 필요", "Redraw")}</span>
	                                ) : null}
	                                {pageError ? (
	                                  <span className="bg-red-50 text-red-700 border-2 border-red-500 px-2 py-0.5 text-[9px] font-black uppercase">{ui("실패", "Failed")}</span>
	                                ) : null}
                                {renderedImageSize ? (
                                  <span className={`border-2 border-black px-2 py-0.5 text-[9px] font-black uppercase ${needsResolutionRedraw ? "bg-amber-200 text-black" : "bg-white text-slate-700"}`}>
                                    {renderedImageSize}
                                  </span>
                                ) : null}
                                {renderedEngineLabel ? (
                                  <span className={`border-2 border-black px-2 py-0.5 text-[9px] font-black uppercase ${needsEngineRedraw ? "bg-emerald-200 text-black" : "bg-white text-slate-700"}`}>
                                    {renderedEngineLabel}
                                  </span>
                                ) : null}
                              </div>
                              <p className="mt-2 text-sm md:text-base font-black text-slate-800 truncate">{p.page.chapter_title}</p>
                              <p className="mt-1 text-[10px] font-bold text-slate-500 uppercase">
                                {ui("뒤 여백", "Gap After")} {p.layout.scroll?.gap_after_px || 0}px
                              </p>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => openPageEditAction(p.page.index)}
                                className="min-h-[44px] px-4 py-2 border-2 border-black bg-white text-[10px] font-black uppercase hover:bg-yellow-100"
                                title={ui("이 페이지 수정", "Edit this page")}
                              >
                                {ui("수정", "Edit")}
                              </button>
                              {res ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => downloadImage(res.composed_image_url, p.page.index)}
                                    className="min-h-[44px] px-4 py-2 border-2 border-black bg-white text-[10px] font-black uppercase hover:bg-blue-50 flex items-center gap-2"
                                  >
                                    <Download size={12} /> {ui("다운로드", "Download")}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => generatePage(p.page.index, undefined, undefined, { allowConcurrent: true })}
                                    disabled={isCur || autoGeneratePages}
                                    className={`min-h-[44px] px-4 py-2 border-2 border-black text-[10px] font-black uppercase ${isCur || autoGeneratePages ? "bg-slate-200 text-slate-400 cursor-not-allowed" : "bg-white hover:bg-yellow-100"}`}
                                  >
                                    {isCur ? ui("재생성 중...", "Redrawing...") : ui("재생성", "Redraw")}
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => generatePage(p.page.index, undefined, undefined, { allowConcurrent: true })}
                                  disabled={isCur || autoGeneratePages}
                                  className={`min-h-[44px] px-4 py-2 border-2 border-black text-[10px] font-black uppercase flex items-center gap-2 ${isCur || autoGeneratePages ? "bg-slate-200 text-slate-400 cursor-not-allowed" : "bg-blue-600 text-white hover:bg-blue-700"}`}
                                >
                                  {isCur ? <Loader2 className="animate-spin" size={12} /> : null}
                                  {isCur ? ui("생성 중...", "Generating...") : autoGeneratePages ? ui("자동 대기 중...", "Auto Queue...") : ui("페이지 생성", "Generate Page")}
                                </button>
                              )}
                            </div>
	                          </div>

	                          {pageError ? (
	                            <div className="mt-3 border-2 border-red-400 bg-red-50 p-3">
	                              <p className="text-[10px] font-black uppercase text-red-700 flex items-center gap-2">
	                                <AlertTriangle size={12} /> {unitLabel} {p.page.index} {ui("생성 실패", "generation failed")}
	                              </p>
	                              <p className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap text-[10px] font-bold text-slate-700">{pageError}</p>
	                              <div className="mt-3 flex flex-wrap gap-2">
	                                <button
	                                  type="button"
	                                  onClick={() => generatePage(p.page.index, undefined, undefined, { allowConcurrent: true })}
	                                  disabled={isCur || autoGeneratePages}
	                                  className={`px-3 py-2 border-2 border-black text-[10px] font-black uppercase ${isCur || autoGeneratePages ? "bg-slate-200 text-slate-400 cursor-not-allowed" : "bg-red-600 text-white hover:bg-red-700"}`}
	                                >
	                                  {ui("이 항목 다시 생성", "Retry this item")}
	                                </button>
	                                {nextAfterFailedPage ? (
	                                  <button
	                                    type="button"
	                                    onClick={() => generatePage(nextAfterFailedPage.page.index, undefined, undefined, { allowConcurrent: true })}
	                                    disabled={nextAfterFailedGenerating || autoGeneratePages}
	                                    className={`px-3 py-2 border-2 border-black text-[10px] font-black uppercase ${nextAfterFailedGenerating || autoGeneratePages ? "bg-slate-200 text-slate-400 cursor-not-allowed" : "bg-white hover:bg-slate-100"}`}
	                                  >
	                                    {ui("건너뛰고 다음", "Skip to next")} {unitLabel} {nextAfterFailedPage.page.index}
	                                  </button>
	                                ) : null}
	                              </div>
	                            </div>
	                          ) : null}

	                          {showNarrativeText ? (
                            <div className="mt-3 border-t-2 border-dashed border-black pt-3">
                              <PageNarrativePreview page={p} compact uiLanguage={uiLanguage} isI2V={isI2VSelected} />
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="bg-white border-4 border-black comic-shadow overflow-hidden">
                  <div className="border-b-4 border-black bg-black px-4 py-3 text-white flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="text-[10px] font-black uppercase text-emerald-300">{ui("회차 출력", "Episode Output")}</p>
                      <p className="text-sm md:text-base font-black uppercase italic">{ui("연속 세로 리더", "Continuous Scroll Reader")}</p>
                    </div>
                    <p className="text-[10px] font-black uppercase text-slate-200">
                      {generatedPageCount}/{seriesPlan?.pages.length || 0} pages · {webtoonEpisodeResult?.segment_urls.length || 0} segments
                    </p>
                  </div>

	                  {generatedPageCount === 0 ? (
	                    <div className="p-8 md:p-12 bg-slate-50 text-center">
	                      <p className="text-sm font-black uppercase text-slate-700">{ui("웹툰 리더 대기 중", "Webtoon Reader Waiting")}</p>
	                      {nextPendingPage ? (
                        <button
                          type="button"
                          onClick={() => generatePage(nextPendingPage.page.index, undefined, undefined, { allowConcurrent: true })}
	                          disabled={isPageGenerating(nextPendingPage.page.index) || autoGeneratePages}
	                          className={`mt-6 px-8 py-4 border-4 border-black font-black uppercase italic shadow-lg ${isPageGenerating(nextPendingPage.page.index) || autoGeneratePages ? "bg-slate-300 text-slate-600 cursor-not-allowed" : "bg-blue-600 text-white hover:bg-blue-700"}`}
                        >
                          {autoGeneratePages ? ui("자동 대기 중...", "Auto Queue...") : `${ui("생성", "Generate")} ${unitLabel} ${nextPendingPage.page.index}`}
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <div className="bg-[#f4f4f4] px-3 py-4 md:px-6 md:py-6">
                      <div className="mx-auto max-w-[860px] rounded-[28px] border-4 border-black bg-white p-3 md:p-4">
                        {isBuildingWebtoonEpisode && (
                          <div className="mb-4 border-2 border-black bg-yellow-50 px-4 py-3 text-[10px] font-black uppercase text-slate-600">
                            {ui("세로 리더를 다시 조립하는 중...", "Rebuilding vertical reader...")}
                          </div>
                        )}
                        {webtoonEpisodeResult ? (
                          <div className="space-y-0 overflow-hidden rounded-[18px] border-2 border-black bg-white">
                            {webtoonEpisodeResult.segment_urls.map((segmentUrl, segmentIndex) => (
                              <div key={`webtoon_segment_${segmentIndex}`} className="relative border-b-2 border-black last:border-b-0">
                                <div className="absolute left-3 top-3 z-10 border-2 border-black bg-white/90 px-2 py-1 text-[9px] font-black uppercase">
                                  Segment {segmentIndex + 1} · {webtoonEpisodeResult.source_page_indices[segmentIndex]?.join(", ")}
                                </div>
                                <img
                                  src={segmentUrl}
                                  alt={`Webtoon segment ${segmentIndex + 1}`}
                                  className="block w-full h-auto"
                                />
                              </div>
                            ))}
                          </div>
                        ) : rawWebtoonFallbackSegments.length > 0 ? (
                          <div className="space-y-3">
                            <div className="border-2 border-black bg-amber-50 px-4 py-3 text-[10px] font-black uppercase text-amber-800">
                              {ui("리더 조립이 늦어져서 페이지 원본을 먼저 보여주는 중", "Reader assembly is delayed, showing raw page images first.")}
                            </div>
                            <div className="space-y-0 overflow-hidden rounded-[18px] border-2 border-black bg-white">
                              {rawWebtoonFallbackSegments.map((segment, segmentIndex) => (
                                <div key={`webtoon_fallback_${segment.pageIndex}`} className="relative border-b-2 border-black last:border-b-0">
                                  <div className="absolute left-3 top-3 z-10 border-2 border-black bg-white/90 px-2 py-1 text-[9px] font-black uppercase">
                                    Page {segment.pageIndex}
                                  </div>
                                  <img
                                    src={segment.url}
                                    alt={`Webtoon page ${segment.pageIndex}`}
                                    className="block w-full h-auto"
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <div className="border-2 border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center">
                            <p className="text-sm font-black uppercase text-slate-600">{ui("리더 조립 대기 중", "Reader Assembly Waiting")}</p>
                            <p className="mt-2 text-[10px] font-bold text-slate-500">{ui("생성된 페이지를 세로 웹툰으로 이어붙이는 중이야.", "Combining generated pages into a vertical webtoon.")}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <>
                {isManga(publicationFormat) && (
                  <div className="flex items-center gap-2 mb-4 text-xs font-black text-slate-500 uppercase">
                    <ChevronLeft size={14} /> {ui("오른쪽에서 왼쪽으로 읽기", "Read Right to Left")}
                  </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-10">
                  {seriesPlan?.pages.map((p, idx) => {
	                    const res = pageResultsMap.get(p.page.index);
	                    const isCur = isPageGenerating(p.page.index);
	                    const isRedrawing = Boolean(res) && isCur;
	                    const pageError = pageErrors[p.page.index] || "";
	                    const nextAfterFailedPage = pageError
	                      ? seriesPlan?.pages.find((candidate) => candidate.page.index > p.page.index && !pageResultsMap.has(candidate.page.index) && !pageErrors[candidate.page.index]) || null
	                      : null;
	                    const nextAfterFailedGenerating = nextAfterFailedPage ? isPageGenerating(nextAfterFailedPage.page.index) : false;
	                    const editedAt = pageScriptEditedAt[p.page.index] || 0;
                    const styleEditedAt = pageStyleEditedAt[p.page.index] || 0;
                    const hasStyleOverride = Boolean(pageStyleOverrides[p.page.index]);
                    const renderedAt = pageRenderedAt[p.page.index] || 0;
                    const renderedImageSize = pageRenderedImageSize[p.page.index] || null;
                    const renderedEngineKey = pageRenderedEngineKey[p.page.index] || null;
                    const renderedEngineLabel = getImageEngineChipLabelFromKey(renderedEngineKey);
                    const needsResolutionRedraw = Boolean(res) && Boolean(renderedImageSize) && renderedImageSize !== imageSize;
                    const needsEngineRedraw = Boolean(res) && Boolean(renderedEngineKey) && renderedEngineKey !== currentImageEngineKey;
                    const needsRedraw =
                      Boolean(res) &&
                      (editedAt > renderedAt || styleEditedAt > renderedAt || globalStyleEditedAt > renderedAt || needsResolutionRedraw || needsEngineRedraw);
                    const klingPromptPack =
                      isI2VSelected && seriesPlan
                        ? buildKlingI2VPromptPack({ series: seriesPlan.series_spec, page: p })
                        : null;
                    const seedancePromptPack =
                      isI2VSelected && seriesPlan
                        ? buildSeedanceRunwayPromptPack({ series: seriesPlan.series_spec, page: p })
                        : null;

                    return (
                      <div key={idx} className="bg-white border-4 border-black comic-shadow flex flex-col group transition-transform hover:-translate-y-2">
                        <div className="bg-black text-white p-3 text-xs font-black flex justify-between items-center">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="uppercase italic">{unitLabel} {p.page.index}</span>
                            {pageScriptEditedAt[p.page.index] ? (
                              <span className="bg-yellow-200 text-black border-2 border-black px-2 py-0.5 text-[9px] font-black uppercase">
                                {ui("수정됨", "Edited")}
                              </span>
                            ) : null}
                            {hasStyleOverride ? (
                              <span className="bg-purple-200 text-black border-2 border-black px-2 py-0.5 text-[9px] font-black uppercase">
                                {ui("스타일", "Style")}
                              </span>
                            ) : null}
	                            {needsRedraw ? (
	                              <span className="bg-red-500 text-white border-2 border-black px-2 py-0.5 text-[9px] font-black uppercase">
	                                {ui("재생성 필요", "Redraw")}
	                              </span>
	                            ) : null}
	                            {pageError ? (
	                              <span className="bg-red-50 text-red-700 border-2 border-red-500 px-2 py-0.5 text-[9px] font-black uppercase">
	                                {ui("실패", "Failed")}
	                              </span>
	                            ) : null}
                            {renderedImageSize ? (
                              <span className={`border-2 border-black px-2 py-0.5 text-[9px] font-black uppercase ${needsResolutionRedraw ? "bg-amber-200 text-black" : "bg-white text-slate-700"}`}>
                                {renderedImageSize}
                              </span>
                            ) : null}
                            {renderedEngineLabel ? (
                              <span className={`border-2 border-black px-2 py-0.5 text-[9px] font-black uppercase ${needsEngineRedraw ? "bg-emerald-200 text-black" : "bg-white text-slate-700"}`}>
                                {renderedEngineLabel}
                              </span>
                            ) : null}
                          </div>

                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => openPageEditAction(p.page.index)}
                              className="px-2 py-0.5 text-[9px] bg-white text-black hover:bg-yellow-100 border-2 border-black"
                              title={isI2VSelected ? ui("이 프레임 수정", "Edit this frame") : ui("이 페이지 수정", "Edit this page")}
                            >
                              {ui("수정", "Edit")}
                            </button>
                            {res && (
                              <>
                                <button onClick={() => downloadImage(res.composed_image_url, p.page.index)} className="bg-blue-500 text-white px-2 py-0.5 text-[9px] hover:bg-blue-400"><Download size={10} /></button>
	                                <button
	                                  onClick={() => generatePage(p.page.index, undefined, undefined, { allowConcurrent: true })}
	                                  disabled={isCur || autoGeneratePages}
	                                  className={`px-2 py-0.5 text-[9px] ${isCur || autoGeneratePages ? "bg-slate-200 text-slate-400 cursor-not-allowed" : "bg-white text-black hover:bg-yellow-400"
	                                    }`}
                                  title={isCur ? ui("재생성 중...", "Redrawing...") : isI2VSelected ? ui("이 프레임 재생성", "Redraw this frame") : ui("이 페이지 재생성", "Redraw this page")}
                                >
                                  {isCur ? (
                                    <span className="flex items-center gap-1">
                                      <Loader2 className="animate-spin" size={10} />
                                      {ui("재생성 중", "Redrawing")}
                                    </span>
                                  ) : (
	                                    ui("재생성", "Redraw")
	                                  )}
	                                </button>
	                                {pageError && nextAfterFailedPage ? (
	                                  <button
	                                    type="button"
	                                    onClick={() => generatePage(nextAfterFailedPage.page.index, undefined, undefined, { allowConcurrent: true })}
	                                    disabled={nextAfterFailedGenerating || autoGeneratePages}
	                                    className={`px-2 py-0.5 text-[9px] ${nextAfterFailedGenerating || autoGeneratePages ? "bg-slate-200 text-slate-400 cursor-not-allowed" : "bg-white text-black hover:bg-slate-200"}`}
	                                    title={`${ui("건너뛰고 다음", "Skip to next")} ${unitLabel} ${nextAfterFailedPage.page.index}`}
	                                  >
	                                    {ui("다음", "Next")}
	                                  </button>
	                                ) : null}
	                              </>
	                            )}
                          </div>
                        </div>
                        <div className={`relative ${previewAspectClass} bg-slate-100 overflow-hidden`}>
                          {res ? (
                            <>
                              <img src={res.composed_image_url} className={`w-full h-full ${isKlingI2VFormat(publicationFormat) ? 'object-cover' : 'object-contain'}`} />
                              {isRedrawing && (
                                <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center bg-white/70 backdrop-blur-sm">
                                  <Loader2 className="animate-spin text-blue-600 w-12 h-12 mb-4" />
                                  <p className="text-sm font-black uppercase text-blue-600">{isI2VSelected ? ui("프레임 재생성 중...", "Re-drawing Frame...") : ui("페이지 재생성 중...", "Re-drawing Page...")}</p>
                                  <p className="text-[10px] font-bold text-slate-500 mt-2 uppercase">{ui("재생성 중...", "Redrawing...")}</p>
                                </div>
                              )}
	                              {(needsResolutionRedraw || needsEngineRedraw) && !isRedrawing ? (
	                                <div className="absolute left-3 bottom-3 border-2 border-black bg-amber-200 px-2 py-1 text-[9px] font-black uppercase text-black">
	                                  {needsResolutionRedraw ? `${renderedImageSize} -> ${imageSize}` : renderedEngineLabel} {ui("재생성 필요", "redraw needed")}
	                                </div>
	                              ) : null}
	                              {pageError && !isRedrawing ? (
	                                <div className="absolute inset-x-3 top-3 border-2 border-red-500 bg-red-50 p-3 text-left shadow-lg">
	                                  <p className="text-[10px] font-black uppercase text-red-700 flex items-center gap-2">
	                                    <AlertTriangle size={12} /> {ui("재생성 실패", "Redraw failed")}
	                                  </p>
	                                  <p className="mt-1 line-clamp-3 text-[10px] font-bold text-slate-700">{pageError}</p>
	                                </div>
	                              ) : null}
	                            </>
	                          ) : (
	                            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
                              {isCur ? (
                                <div className="flex flex-col items-center">
                                  <Loader2 className="animate-spin text-blue-600 w-12 h-12 mb-4" />
                                  <p className="text-sm font-black uppercase text-blue-600">{isI2VSelected ? ui("프레임 생성 중...", "Drawing Frame...") : ui("페이지 생성 중...", "Drawing Panels...")}</p>
                                  <p className="text-[10px] font-bold text-slate-400 mt-2 uppercase">
                                    {ui("렌더링", "Rendering")} {seriesPlan?.series_spec.series.language === "en" ? "English" : "Hangul"}
                                  </p>
                                </div>
	                              ) : (
	                                <div className="flex flex-col items-center gap-3">
	                                  {pageError ? (
	                                    <div className="border-2 border-red-500 bg-red-50 p-3 text-left">
	                                      <p className="text-[10px] font-black uppercase text-red-700 flex items-center gap-2">
	                                        <AlertTriangle size={12} /> {ui("생성 실패", "Generation failed")}
	                                      </p>
	                                      <p className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap text-[10px] font-bold text-slate-700">{pageError}</p>
	                                    </div>
	                                  ) : null}
	                                  <button
	                                    onClick={() => generatePage(p.page.index, undefined, undefined, { allowConcurrent: true })}
	                                    disabled={isCur || autoGeneratePages}
	                                    className={`px-8 py-4 border-4 border-black font-black uppercase italic shadow-lg transition-transform ${isCur || autoGeneratePages ? "bg-slate-300 text-slate-600 cursor-not-allowed" : pageError ? "bg-red-600 text-white hover:bg-red-700" : "bg-blue-600 text-white hover:scale-110"
	                                      }`}
	                                  >
	                                    {autoGeneratePages ? ui("자동 대기 중...", "Auto Queue...") : pageError ? ui("다시 생성", "Retry") : isI2VSelected ? ui("프레임 생성", "Generate Frame") : ui("페이지 생성", "Generate Page")}
	                                  </button>
	                                  {pageError && nextAfterFailedPage ? (
	                                    <button
	                                      type="button"
	                                      onClick={() => generatePage(nextAfterFailedPage.page.index, undefined, undefined, { allowConcurrent: true })}
	                                      disabled={nextAfterFailedGenerating || autoGeneratePages}
	                                      className={`px-4 py-2 border-2 border-black text-[10px] font-black uppercase ${nextAfterFailedGenerating || autoGeneratePages ? "bg-slate-200 text-slate-400 cursor-not-allowed" : "bg-white hover:bg-slate-100"}`}
	                                    >
	                                      {ui("건너뛰고 다음", "Skip to next")} {unitLabel} {nextAfterFailedPage.page.index}
	                                    </button>
	                                  ) : null}
	                                </div>
	                              )}
	                            </div>
	                          )}
                        </div>
                        <div className={`p-4 border-t-2 border-black bg-slate-50 ${showNarrativeText ? "" : "min-h-[80px]"}`}>
                          <p className="text-xs font-bold leading-tight line-clamp-3 italic text-slate-700">"{p.page.chapter_title}"</p>
                          {showNarrativeText ? (
                            <div className="mt-3">
                              <PageNarrativePreview page={p} compact uiLanguage={uiLanguage} isI2V={isI2VSelected} />
                            </div>
                          ) : null}
                          {klingPromptPack ? (
                            <div className="mt-3 border-2 border-black bg-white p-3 space-y-2">
                              <p className="text-[10px] font-black uppercase text-blue-700">Kling 3.0 Prompt Pack</p>
                              <div>
                                <div className="flex items-center justify-between mb-1">
                                  <p className="text-[9px] font-black uppercase text-slate-600">Prompt</p>
                                  <button
                                    type="button"
                                    onClick={() => copyText(klingPromptPack.prompt)}
                                    className="text-[9px] font-black uppercase border-2 border-black px-2 py-0.5 bg-white hover:bg-yellow-50 flex items-center gap-1"
                                  >
                                    <Copy size={10} /> {ui("프롬프트 복사", "Copy Prompt")}
                                  </button>
                                </div>
                                <textarea
                                  readOnly
                                  value={klingPromptPack.prompt}
                                  className="w-full border-2 border-black p-2 text-[10px] font-mono bg-white h-28 resize-y"
                                />
                              </div>
                              <div>
                                <div className="flex items-center justify-between mb-1">
                                  <p className="text-[9px] font-black uppercase text-slate-600">Negative Prompt</p>
                                  <button
                                    type="button"
                                    onClick={() => copyText(klingPromptPack.negativePrompt)}
                                    className="text-[9px] font-black uppercase border-2 border-black px-2 py-0.5 bg-white hover:bg-yellow-50 flex items-center gap-1"
                                  >
                                    <Copy size={10} /> {ui("네거티브 복사", "Copy Negative")}
                                  </button>
                                </div>
                                <textarea
                                  readOnly
                                  value={klingPromptPack.negativePrompt}
                                  className="w-full border-2 border-black p-2 text-[10px] font-mono bg-white h-20 resize-y"
                                />
                              </div>
                              <div>
                                <p className="text-[9px] font-black uppercase text-slate-600 mb-1">{ui("Kling 적용방법", "How to Use in Kling")}</p>
                                <textarea
                                  readOnly
                                  value={klingPromptPack.settingsHint}
                                  className="w-full border-2 border-black p-2 text-[10px] font-mono bg-slate-50 h-24 resize-y"
                                />
                              </div>
                            </div>
                          ) : null}
                          {seedancePromptPack ? (
                            <div className="mt-3 border-2 border-black bg-white p-3 space-y-2">
                              <p className="text-[10px] font-black uppercase text-emerald-700">Seedance 2.0 / Runway Prompt Pack</p>
                              <div>
                                <div className="flex items-center justify-between mb-1">
                                  <p className="text-[9px] font-black uppercase text-slate-600">Seedance Prompt</p>
                                  <button
                                    type="button"
                                    onClick={() => copyText(seedancePromptPack.prompt)}
                                    className="text-[9px] font-black uppercase border-2 border-black px-2 py-0.5 bg-white hover:bg-emerald-50 flex items-center gap-1"
                                  >
                                    <Copy size={10} /> {ui("씨댄스 복사", "Copy Seedance")}
                                  </button>
                                </div>
                                <textarea
                                  readOnly
                                  value={seedancePromptPack.prompt}
                                  className="w-full border-2 border-black p-2 text-[10px] font-mono bg-white h-36 resize-y"
                                />
                              </div>
                              <div>
                                <div className="flex items-center justify-between mb-1">
                                  <p className="text-[9px] font-black uppercase text-slate-600">{ui("Runway 적용방법", "Runway Workflow")}</p>
                                  <button
                                    type="button"
                                    onClick={() => copyText(seedancePromptPack.runwayHint)}
                                    className="text-[9px] font-black uppercase border-2 border-black px-2 py-0.5 bg-white hover:bg-emerald-50 flex items-center gap-1"
                                  >
                                    <Copy size={10} /> {ui("방법 복사", "Copy Workflow")}
                                  </button>
                                </div>
                                <textarea
                                  readOnly
                                  value={seedancePromptPack.runwayHint}
                                  className="w-full border-2 border-black p-2 text-[10px] font-mono bg-slate-50 h-28 resize-y"
                                />
                              </div>
                              <div>
                                <div className="flex items-center justify-between mb-1">
                                  <p className="text-[9px] font-black uppercase text-slate-600">{ui("체크리스트", "Checklist")}</p>
                                  <button
                                    type="button"
                                    onClick={() => copyText(seedancePromptPack.checklist)}
                                    className="text-[9px] font-black uppercase border-2 border-black px-2 py-0.5 bg-white hover:bg-emerald-50 flex items-center gap-1"
                                  >
                                    <Copy size={10} /> {ui("체크 복사", "Copy Checklist")}
                                  </button>
                                </div>
                                <textarea
                                  readOnly
                                  value={seedancePromptPack.checklist}
                                  className="w-full border-2 border-black p-2 text-[10px] font-mono bg-slate-50 h-28 resize-y"
                                />
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {seriesPlan?.plan_meta.grounding_sources && seriesPlan.plan_meta.grounding_sources.length > 0 && (
              <div className="bg-white border-4 border-black p-6 md:p-8 comic-shadow">
                <h4 className="text-lg font-black uppercase mb-6 flex items-center gap-3">
                  <Globe className="text-blue-600" /> {ui("참고 자료", "References")}
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {seriesPlan.plan_meta.grounding_sources.map((s, idx) => (
                    <a key={idx} href={s.uri} target="_blank" rel="noopener noreferrer" className="flex flex-col p-4 bg-slate-50 border-2 border-slate-100 hover:border-black transition-all">
                      <span className="text-xs font-black text-gray-800 line-clamp-1 mb-1">{s.title}</span>
                      <span className="text-[9px] text-blue-500 underline truncate">{s.uri}</span>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {status === AppStatus.ERROR && (
          <div className="bg-red-50 border-4 border-red-500 p-8 md:p-12 text-center max-w-lg mx-auto">
            <div className="flex justify-start mb-4">
              <PreviousStepButton />
            </div>
            <h2 className="text-xl md:text-2xl font-black text-red-600 uppercase mb-4">{ui("시스템 오류", "System Failure")}</h2>
            <p className="text-sm font-bold mb-8">{ui("주제를 더 구체적으로 적거나 다른 스타일을 시도해봐.", "Try a more specific topic or a different style.")}</p>
            {systemError && (
              <pre className="text-left text-[10px] whitespace-pre-wrap bg-white border-2 border-red-400 p-3 mb-6 overflow-auto max-h-48">{systemError}</pre>
            )}
            <button onClick={() => setStatus(AppStatus.STYLE_SELECT)} className="bg-black text-white px-10 py-4 font-black">{ui("다시 시도", "Retry")}</button>
          </div>
        )}
      </div>
      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: #f1f1f1; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #000; border-radius: 2px; }
        @keyframes fade-in {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-in { animation: fade-in 0.5s ease-out forwards; }
      `}</style>
    </div>
  );
};

export default App;
