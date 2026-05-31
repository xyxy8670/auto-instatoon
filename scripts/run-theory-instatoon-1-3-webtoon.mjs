import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.cwd();
const API_BASE = process.env.LOCAL_API_BASE || "http://127.0.0.1:8787";
const ARTICLE_DIR = "/Users/kimseohyeong/플스포/쓰레드/ps4_ps4pro/20260519_231337_19c266b49a1000oce/articles";
const ARCHIVE_PATH = path.join(ROOT, "local-project-archive", "projects.json");
const STYLE_ID = "kwebtoon_serialized_panel";
const CARD_COUNT = Number.parseInt(process.env.CARD_COUNT || "8", 10);
const IMAGE_SIZE = "1600x2000";
const IMAGE_QUALITY = "high";
const IMAGE_MODEL = process.env.CODEX_IMAGE_MODEL || "gpt-5.5";
const TEXT_MODEL = process.env.CODEX_TEXT_MODEL || "gpt-5.4-mini";
const VARIANT = process.env.INSTATOON_VARIANT || "native";
const IS_GAG_MEME = VARIANT === "gag_meme";
const LABEL_PREFIX = IS_GAG_MEME ? "인스타툰 네이티브 4x5 개그밈" : "인스타툰 네이티브 4x5";
const ACTIVE_ARCHIVE_MAX_BYTES = 420 * 1024 * 1024;
const RUN_ID = `theory_instatoon_1_3_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
const OUT_DIR = path.join(ROOT, "local-project-archive", RUN_ID);
const PROJECT_DUMP_DIR = path.join(ROOT, "local-project-archive", "theory_instatoon_1_3_projects");
const RUN_LOG = path.join(OUT_DIR, "run.jsonl");

const LESSONS = [
  { lesson: 1, file: "260218215940235ej.md" },
  { lesson: 2, file: "260304213530925vz.md" },
  { lesson: 3, file: "260311223513066fx.md" }
];

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(PROJECT_DUMP_DIR, { recursive: true });

const stylePresets = JSON.parse(fs.readFileSync(path.join(ROOT, "style_presets.json"), "utf8"));
const templates = JSON.parse(fs.readFileSync(path.join(ROOT, "layout_templates.json"), "utf8"));
const sharedCastRaw = JSON.parse(fs.readFileSync(path.join(ROOT, "local-project-archive", "theory_1_5_queue", "shared_cast_from_1.json"), "utf8"));
const sharedCast = typeof sharedCastRaw === "string" ? JSON.parse(sharedCastRaw) : sharedCastRaw;

const log = (entry) => {
  const line = JSON.stringify({ created_at: new Date().toISOString(), ...entry });
  fs.appendFileSync(RUN_LOG, `${line}\n`);
  console.log(line);
};

const postJson = async (url, body, timeoutMs = 10 * 60_000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-Id": crypto.randomUUID() },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Keep raw text for error reporting.
    }
    if (!res.ok) throw new Error(json?.error?.message || text || `HTTP ${res.status}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
};

const sanitizeName = (value) =>
  String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120) || "instatoon";

const dataUrlToPngFile = (dataUrl, filePath) => {
  const match = /^data:image\/png;base64,(.+)$/s.exec(String(dataUrl || ""));
  if (!match) throw new Error("Expected PNG data URL.");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(match[1], "base64"));
};

const parseJsonFromText = (text) => {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Text response did not contain JSON.");
    return JSON.parse(match[0]);
  }
};

const getStyle = () => {
  const preset = stylePresets.find((item) => item.id === STYLE_ID);
  if (!preset) throw new Error(`Missing style preset: ${STYLE_ID}`);
  return {
    preset_id: preset.id,
    preset_label: preset.label,
    style_prompt: preset.style_prompt,
    negative_style_prompt: preset.negative_style_prompt,
    user_style_prompt: null,
    render_mode: preset.render_mode
  };
};

const getTemplate = (id) => {
  const template = templates.find((item) => item.id === id);
  if (!template) throw new Error(`Missing template: ${id}`);
  return template;
};

const readArchiveProjects = () => {
  if (!fs.existsSync(ARCHIVE_PATH)) return [];
  const raw = JSON.parse(fs.readFileSync(ARCHIVE_PATH, "utf8"));
  return Array.isArray(raw) ? raw : Array.isArray(raw.projects) ? raw.projects : [];
};

const writeArchiveWithProject = (project) => {
  fs.writeFileSync(path.join(PROJECT_DUMP_DIR, `${sanitizeName(project.label)}.json`), JSON.stringify(project));
  const current = readArchiveProjects();
  const deduped = current.filter((item) => item.label !== project.label);
  const prioritized = [
    project,
    ...deduped.filter((item) => String(item.label || "").startsWith("인스타툰 네이티브 4x5 개그밈 · 이론편")),
    ...deduped.filter((item) => String(item.label || "").startsWith("인스타툰 네이티브 4x5 · 이론편")),
    ...deduped.filter((item) => String(item.label || "").startsWith("인스타툰 4x5 · 이론편")),
    ...deduped.filter((item) => String(item.label || "").startsWith("웹툰풍 재생성 · ")),
    ...deduped.filter((item) => String(item.label || "").includes("경매 1강 인스타툰")),
    ...deduped
  ];
  const selected = [];
  const seen = new Set();
  for (const item of prioritized) {
    const key = item.id || item.label;
    if (seen.has(key)) continue;
    seen.add(key);
    const body = JSON.stringify({ version: 1, updated_at: new Date().toISOString(), projects: [...selected, item] });
    if (Buffer.byteLength(body) > ACTIVE_ARCHIVE_MAX_BYTES && selected.length > 0) continue;
    selected.push(item);
  }
  fs.writeFileSync(ARCHIVE_PATH, JSON.stringify({ version: 1, updated_at: new Date().toISOString(), projects: selected }, null, 2));
  log({ stage: "archive", status: "saved", label: project.label, active_projects: selected.length });
};

const getTitleFromSource = (sourceText, fallback) => {
  return sourceText
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^#\s*/, ""))
    .find(Boolean) || fallback;
};

const buildCardPlan = async ({ title, sourceText, lesson }) => {
  log({ stage: "plan", status: "started", lesson, cards: CARD_COUNT, title });
  const prompt = `
아래 원문을 인스타툰 4:5 캐러셀 ${CARD_COUNT}장으로 바꿔줘.

주제: ${title}
대상: 경매 입문자
톤: ${IS_GAG_MEME ? "쉽고 웃긴 학습 인스타툰. 민지의 과장 리액션, 현실 밈 감성, 한 박자 늦은 드립, 뇌정지/동공지진/현실 부정 같은 표현을 적절히 활용. 단, 특정 저작물 캐릭터/유명인/상표 밈을 직접 복제하지 말고 일반적인 인터넷 밈 문법으로만 표현." : "쉽고 친근한 학습 인스타툰."} 투자 권유 금지. 확정 수익 표현 금지.
캐릭터: 민지(초보 학습자)와 멘토(차분한 경매 설명자)를 모든 카드에 일관되게 사용.
작화 방향: 처음부터 4:5 화면에 맞춰 설계된 한국 웹툰형 인스타툰. 기존 세로 웹툰을 잘라낸 느낌 금지. 카드뉴스처럼 보이지 않게, 말풍선과 작은 나레이션 박스 중심.

규칙:
- 1번 카드는 후킹이 있지만 표지/포스터처럼 과하게 만들지 말고, 4:5 카드 안에서 자연스럽게 시작하는 웹툰 장면으로 구성.
- 중간 카드는 카드당 핵심 메시지 1개.
- 각 카드는 1~3컷만. 과밀 금지.
- ${IS_GAG_MEME ? "각 카드에는 개념 이해를 방해하지 않는 짧은 개그 포인트를 1개 정도 넣어라. 예: 민지의 과장 표정, 멘토의 침착한 받아치기, 작은 효과선, '내 통장 살려', '뇌정지', '잠깐만요' 같은 짧은 밈풍 표현. 너무 유행어 과다 사용 금지." : "개념 설명을 우선하고 과한 장식은 피한다."}
- 마지막 카드는 요약 + 저장/다음 강 유도.
- visible_text는 이미지에 들어갈 짧은 한국어 텍스트만 넣어라.
- JSON만 반환.

반환 형식:
{
  "title": "string",
  "cards": [
    {
      "index": 1,
      "title": "짧은 카드 제목",
      "visible_text": ["이미지에 들어갈 짧은 문구"],
      "visual": "카드의 그림 장면 설명",
      "dialogue": ["짧은 대사"],
      "takeaway": "핵심 정리 한 줄"
    }
  ]
}

원문:
${sourceText}
`.trim();

  const response = await postJson("/api/codex/generate-content", {
    request: {
      model: TEXT_MODEL,
      contents: { parts: [{ text: prompt }] },
      config: {
        responseMimeType: "application/json",
        reasoningEffort: "low",
        maxOutputTokens: 9000
      }
    }
  }, 10 * 60_000);
  const plan = parseJsonFromText(response?.text || response?.candidates?.[0]?.content?.parts?.[0]?.text || "");
  if (!Array.isArray(plan.cards) || plan.cards.length === 0) throw new Error("Plan did not include cards.");
  plan.cards = plan.cards.slice(0, CARD_COUNT).map((card, index) => ({ ...card, index: index + 1 }));
  log({ stage: "plan", status: "success", lesson, cards: plan.cards.length, title: plan.title });
  return plan;
};

const buildSeriesPlan = ({ title, lesson, cardPlan, style, sourceFile }) => {
  const pages = cardPlan.cards.map((card, index) => {
    const templateId = index === 0
      ? "instatoon_cover"
      : index === cardPlan.cards.length - 1
        ? "instatoon_focus_2"
        : index % 2 === 0
          ? "instatoon_card_3"
          : "instatoon_focus_2";
    const template = getTemplate(templateId);
    return {
      page: {
        index: index + 1,
        chapter_title: `${index + 1}. ${card.title || `카드 ${index + 1}`}`
      },
      layout: {
        template_id: templateId,
        canvas: { w: 1080, h: 1350 },
        gutter_px: 18,
        border_px: 3,
        border_radius_px: 0,
        background_color: "#FFFFFF",
        template_panels: template.panels
      },
      panels: template.panels.map((panel, panelIndex) => ({
        index: panelIndex + 1,
        scene: `${card.visual || ""}\n핵심 텍스트: ${(card.visible_text || []).join(" / ")}\n정리: ${card.takeaway || ""}`.trim(),
        acting: IS_GAG_MEME
          ? "민지는 초보 학습자답게 과장된 리액션과 밈풍 표정을 보여주고, 멘토는 차분하게 받아치며 경매 개념을 풀어준다. 웃기지만 개념은 정확한 대화 장면."
          : "민지는 초보 학습자답게 질문하고, 멘토는 차분하게 경매 개념을 풀어준다. 자연스러운 대화 장면.",
        dialogues: Array.isArray(card.dialogue) ? card.dialogue.slice(0, 2) : [],
        camera: panelIndex === 0 ? "native 4:5 webtoon-card medium shot, composed for this canvas" : "supporting close-up or document detail composed for 4:5 card",
        mood: IS_GAG_MEME ? "friendly, comedic, meme-aware, beginner-friendly" : "friendly, clear, beginner-friendly",
        render: {
          target_aspect_ratio: panel.target_aspect_ratio || "4:5",
          safe_area_hint: "mobile-readable Korean speech bubbles, wide margins"
        }
      }))
    };
  });

  return {
    series_spec: {
      series: {
        title: `${LABEL_PREFIX} · 이론편 ${lesson}강 · ${title.replace(/^\[.*?\]\s*/, "")}`,
        language: "ko",
        audience_level: "beginner",
        page_count: pages.length
      },
      anchors: {
        protagonist: {
          appearance: sharedCast[0]?.appearance || "경매를 처음 배우는 초보 학습자 민지.",
          role: "narrator",
          reference_images: { main: "", pack: [] }
        },
        cast: sharedCast,
        tone_mode: IS_GAG_MEME ? "gag" : "normal",
        tone_level: IS_GAG_MEME ? "high" : "medium",
        style
      },
      constraints: {
        comic_mode: "learning",
        output_mode: "comic",
        publication_format: "instatoon",
        manga_color_mode: "color",
        i2v_aspect_ratio: "1:1",
        text_strategy: "embed_in_image",
        layout_variety: "high",
        image_size: "2K",
        image_provider: "codex",
        codex_image_quality: IMAGE_QUALITY,
        character_consistency_mode: "strict",
        creation_type: "educational"
      }
    },
    pages,
    plan_meta: {
      generated_by: "scripts/run-theory-instatoon-1-3-webtoon.mjs",
      source_file_name: path.basename(sourceFile),
      run_id: RUN_ID,
      instatoon: true,
      source_card_plan: cardPlan
    }
  };
};

const buildImagePrompt = ({ title, lesson, card, style }) => `
Create ONE native 4:5 portrait image for an Instagram carousel. Compose the scene from scratch for this exact 4:5 canvas.
Generated size: ${IMAGE_SIZE}. This is lesson ${lesson}, card ${card.index} of ${CARD_COUNT}.
Topic: ${title}
Tone variant: ${IS_GAG_MEME ? "comedic educational instatoon with tasteful Korean internet meme energy" : "friendly educational instatoon"}

Recurring characters:
- 민지: ${sharedCast[0]?.appearance || "초보 학습자"}
- 멘토: ${sharedCast[1]?.appearance || "차분한 경매 설명자"}

Use this content only as short speech-bubble or small narration-box material:
${[...(card.dialogue || []), ...(card.visible_text || []), card.takeaway || ""].filter(Boolean).map((line) => `- ${line}`).join("\n")}

Visual scene: ${card.visual || ""}

Style preset: ${style.preset_label}
Style rules: ${style.style_prompt}
Negative style rules: ${style.negative_style_prompt || "blurry, unreadable text, watermark"}

Composition rules:
- Output must be exactly 4:5 portrait, suitable for Instagram carousel.
- Compose natively for the 4:5 canvas from the beginning. Do NOT crop, slice, trim, or adapt a taller webtoon page.
- Every panel, character, speech bubble, narration box, and margin must be intentionally placed inside the 4:5 frame.
- Do NOT make card news. No giant headline typography, infographic blocks, poster title design, presentation-slide layout, or social-media template design.
- Make it feel like a Korean webtoon-style Instagram carousel that was originally designed for 4:5.
- Use 1 to 3 ordinary webtoon panels with plain gutters, speech bubbles, small narration boxes, casual camera angles, mid-conversation framing, and understated backgrounds.
- ${IS_GAG_MEME ? "Add one tasteful gag or meme-style reaction per card when natural: exaggerated shocked face, tiny sweat drop, deadpan mentor reply, mini reaction inset, comic pause, light speed lines, or short generic Korean meme-like phrase. Do not copy specific copyrighted meme characters, celebrity faces, logos, or exact famous meme images." : "Keep the humor understated unless the script explicitly asks for a gag."}
- Keep 민지 and 멘토 visually consistent with the descriptions across all cards.
- Keep Korean text short and readable. Put text in speech bubbles or small webtoon narration boxes only.
- No investment recommendation, no guaranteed profit wording.
- No watermark, no app UI, no mock browser chrome.
`.trim();

const generateImageWithRetry = async ({ lesson, title, card, style, outDir }) => {
  const prompt = buildImagePrompt({ title, lesson, card, style });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      log({ stage: "image", status: "started", lesson, card: card.index, attempt });
      const response = await postJson("/api/codex/generate-image", {
        prompt,
        model: IMAGE_MODEL,
        size: IMAGE_SIZE,
        quality: IMAGE_QUALITY,
        moderation: "low"
      }, 12 * 60_000);
      if (!response?.image_data_url) throw new Error("Image response was empty.");
      const outFile = path.join(outDir, `slide_${String(card.index).padStart(2, "0")}.png`);
      dataUrlToPngFile(response.image_data_url, outFile);
      log({ stage: "image", status: "success", lesson, card: card.index, attempt, file: outFile });
      return { page_index: card.index, composed_image_url: response.image_data_url };
    } catch (e) {
      const message = String(e?.message || e || "image failed");
      log({ stage: "image", status: attempt < 2 ? "retrying" : "error", lesson, card: card.index, attempt, message });
      if (attempt >= 2) throw e;
    }
  }
};

const saveProject = ({ title, sourceText, style, styleId, plan, results, errors }) => {
  const now = Date.now();
  const pageRenderedAt = {};
  const pageRenderedImageSize = {};
  const pageRenderedEngineKey = {};
  for (const result of results) {
    pageRenderedAt[result.page_index] = now;
    pageRenderedImageSize[result.page_index] = "2K";
    pageRenderedEngineKey[result.page_index] = `codex:${IMAGE_MODEL}:${IMAGE_QUALITY}`;
  }
  const label = plan.series_spec.series.title;
  const project = {
    id: crypto.randomUUID(),
    label,
    created_at: now,
    updated_at: now,
    last_opened_at: now,
    snapshot: {
      topic: title,
      questionType: "explain",
      comicMode: "learning",
      outputMode: "comic",
      publicationFormat: "instatoon",
      mangaColorMode: "color",
      i2vAspectRatio: "1:1",
      toneMode: IS_GAG_MEME ? "gag" : "normal",
      toneLevel: IS_GAG_MEME ? "high" : "medium",
      introStyle: "standard",
      language: "ko",
      audienceLevel: "beginner",
      deliveryStyleId: "standard",
      deliveryCustomInstruction: "",
      geminiReasoningEffort: "low",
      layoutVariety: "high",
      imageSize: "2K",
      imageProvider: "codex",
      codexImageQuality: IMAGE_QUALITY,
      scriptDetail: "normal",
      pageCountMode: "manual",
      targetPageCount: plan.pages.length,
      narrativeRole: "narrator",
      characterConsistencyMode: "strict",
      useCrossPageStyleConsistency: false,
      researchMode: "auto_digest",
      researchDigestText: sourceText,
      cast: sharedCast,
      productReferenceImages: [],
      selectedPresetId: styleId,
      selectedStyleCategory: stylePresets.find((item) => item.id === styleId)?.category || "Webtoon",
      finalStyle: style,
      seriesPlan: plan,
      pageResults: results,
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
    }
  };
  writeArchiveWithProject(project);
  log({ stage: "save", status: "success", label, images: results.length, errors: Object.keys(errors).length });
};

const main = async () => {
  log({ stage: "run", status: "started", run_id: RUN_ID, out_dir: OUT_DIR, lessons: LESSONS.map((item) => item.lesson), cards: CARD_COUNT });
  const style = getStyle();
  for (const lessonItem of LESSONS) {
    const sourceFile = path.join(ARTICLE_DIR, lessonItem.file);
    const sourceText = fs.readFileSync(sourceFile, "utf8");
    const title = getTitleFromSource(sourceText, `이론편 ${lessonItem.lesson}강`);
    const existing = readArchiveProjects().find((project) =>
      String(project.label || "").startsWith(`${LABEL_PREFIX} · 이론편 ${lessonItem.lesson}강`) &&
      (project.snapshot?.pageResults?.length || 0) >= CARD_COUNT
    );
    if (existing) {
      log({ stage: "skip", status: "exists", lesson: lessonItem.lesson, label: existing.label, variant: VARIANT });
      continue;
    }

    const lessonDir = path.join(OUT_DIR, `lesson_${String(lessonItem.lesson).padStart(2, "0")}_${sanitizeName(title)}`);
    fs.mkdirSync(lessonDir, { recursive: true });
    const cardPlan = await buildCardPlan({ title, sourceText, lesson: lessonItem.lesson });
    fs.writeFileSync(path.join(lessonDir, "card-plan.json"), JSON.stringify(cardPlan, null, 2));
    const plan = buildSeriesPlan({ title, lesson: lessonItem.lesson, cardPlan, style, sourceFile });
    fs.writeFileSync(path.join(lessonDir, "series-plan.json"), JSON.stringify(plan, null, 2));

    const images = await Promise.allSettled(cardPlan.cards.map((card) =>
      generateImageWithRetry({ lesson: lessonItem.lesson, title, card, style, outDir: lessonDir })
    ));
    const results = [];
    const errors = {};
    images.forEach((result, index) => {
      const pageIndex = index + 1;
      if (result.status === "fulfilled" && result.value) results.push(result.value);
      else errors[pageIndex] = String(result.reason?.message || result.reason || "image failed");
    });
    results.sort((a, b) => a.page_index - b.page_index);
    saveProject({ title, sourceText, style, styleId: STYLE_ID, plan, results, errors });
    fs.writeFileSync(path.join(lessonDir, "project-summary.json"), JSON.stringify({
      label: plan.series_spec.series.title,
      results: results.map((item) => ({ page_index: item.page_index })),
      errors
    }, null, 2));
  }
  log({ stage: "run", status: "complete", run_id: RUN_ID, out_dir: OUT_DIR });
};

main().catch((e) => {
  log({ stage: "fatal", status: "error", message: String(e?.stack || e?.message || e) });
  process.exitCode = 1;
});
