import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.cwd();
const API_BASE = process.env.LOCAL_API_BASE || "http://127.0.0.1:8787";
const SOURCE_FILE = "/Users/kimseohyeong/플스포/쓰레드/ps4_ps4pro/20260519_231337_19c266b49a1000oce/articles/260218215940235ej.md";
const STYLE_IDS = (process.env.STYLE_IDS || "kwebtoon_minimal_line,kwebtoon_crayon_child,ghibli_fantasy_art")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const CARD_COUNT = Number.parseInt(process.env.CARD_COUNT || "8", 10);
const IMAGE_SIZE = "1600x2000";
const IMAGE_QUALITY = "high";
const IMAGE_MODEL = process.env.CODEX_IMAGE_MODEL || "gpt-5.5";
const TEXT_MODEL = process.env.CODEX_TEXT_MODEL || "gpt-5.4-mini";
const RUN_ID = `instatoon_auction_lesson1_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
const OUT_DIR = path.join(ROOT, "local-project-archive", RUN_ID);
const RUN_LOG = path.join(OUT_DIR, "run.jsonl");

fs.mkdirSync(OUT_DIR, { recursive: true });

const stylePresets = JSON.parse(fs.readFileSync(path.join(ROOT, "style_presets.json"), "utf8"));
const templates = JSON.parse(fs.readFileSync(path.join(ROOT, "layout_templates.json"), "utf8"));
const sourceText = fs.readFileSync(SOURCE_FILE, "utf8");

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
      // keep raw text below
    }
    if (!res.ok) {
      throw new Error(json?.error?.message || text || `HTTP ${res.status}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
};

const getJson = async (url) => {
  const res = await fetch(`${API_BASE}${url}`);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }
  if (!res.ok) throw new Error(json?.error?.message || text || `HTTP ${res.status}`);
  return json;
};

const dataUrlToPngFile = (dataUrl, filePath) => {
  const match = /^data:image\/png;base64,(.+)$/s.exec(dataUrl);
  if (!match) throw new Error("Expected PNG data URL.");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(match[1], "base64"));
};

const sanitizeName = (value) =>
  String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80) || "instatoon";

const getTemplate = (id) => {
  const template = templates.find((item) => item.id === id);
  if (!template) throw new Error(`Missing template: ${id}`);
  return template;
};

const selectStyle = (styleId) => {
  const preset = stylePresets.find((item) => item.id === styleId);
  if (!preset) throw new Error(`Missing style preset: ${styleId}`);
  return {
    preset_id: preset.id,
    preset_label: preset.label,
    style_prompt: preset.style_prompt,
    negative_style_prompt: preset.negative_style_prompt,
    user_style_prompt: null,
    render_mode: preset.render_mode
  };
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

const buildCardPlan = async () => {
  log({ stage: "plan", status: "started", cards: CARD_COUNT });
  const prompt = `
아래 원문을 인스타툰 4:5 캐러셀 ${CARD_COUNT}장으로 바꿔줘.

주제: 경매 1강 - 경매로 어떻게 돈을 벌어요?
대상: 경매 입문자
톤: 쉽고 친근한 학습 인스타툰. 투자 권유 금지. 확정 수익 표현 금지.

규칙:
- 1번 카드는 강한 후킹/표지.
- 중간 카드는 카드당 핵심 메시지 1개.
- 각 카드에는 1~3컷만. 과밀 금지.
- 마지막 카드는 요약 + 저장/다음 강 유도.
- 각 카드의 visible_text는 이미지에 들어갈 짧은 한국어 텍스트만 넣어라.
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
  fs.writeFileSync(path.join(OUT_DIR, "card-plan.json"), JSON.stringify(plan, null, 2));
  log({ stage: "plan", status: "success", cards: plan.cards.length, title: plan.title });
  return plan;
};

const buildSeriesPlan = (cardPlan, style) => {
  const pages = cardPlan.cards.map((card, index) => {
    const templateId = index === 0 ? "instatoon_cover" : index === cardPlan.cards.length - 1 ? "instatoon_focus_2" : index % 2 === 0 ? "instatoon_card_3" : "instatoon_focus_2";
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
        acting: "친절한 경매 멘토와 초보 수강생이 대화하며 개념을 쉽게 이해한다.",
        dialogues: Array.isArray(card.dialogue) ? card.dialogue.slice(0, 2) : [],
        camera: panelIndex === 0 ? "clean medium shot, readable card layout" : "supporting close-up or simple diagram",
        mood: "friendly, clear, beginner-friendly",
        render: {
          target_aspect_ratio: panel.target_aspect_ratio || "4:5",
          safe_area_hint: "large mobile-readable Korean text, wide margins"
        }
      }))
    };
  });

  return {
    series_spec: {
      series: {
        title: cardPlan.title || "경매 1강 인스타툰",
        language: "ko",
        audience_level: "beginner",
        page_count: pages.length
      },
      anchors: {
        protagonist: {
          appearance: "친절한 경매 멘토 셀프쌤. 차분하고 믿음직한 설명자.",
          role: "narrator",
          reference_images: { main: "", pack: [] }
        },
        cast: [
          {
            id: "mentor-self",
            role: "protagonist",
            name: "셀프쌤",
            appearance: "친절한 경매 멘토. 깔끔한 셔츠, 차분한 표정, 초보자에게 쉽게 설명하는 분위기.",
            persona: "경매를 어렵지 않게 풀어주는 실전 멘토",
            catchphrase: "오늘도 경매공부 성공!",
            catchphrase_frequency: "sometimes",
            reference_images: []
          },
          {
            id: "beginner-student",
            role: "supporting",
            name: "초보 수강생",
            appearance: "경매가 처음이라 궁금한 것이 많은 입문자. 노트와 스마트폰을 들고 있다.",
            persona: "질문을 통해 독자의 궁금증을 대신 묻는 캐릭터",
            catchphrase: "아, 그렇게 보면 쉽네요!",
            catchphrase_frequency: "rare",
            reference_images: []
          }
        ],
        tone_mode: "normal",
        tone_level: "medium",
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
        character_consistency_mode: "loose",
        creation_type: "educational"
      }
    },
    pages,
    plan_meta: {
      generated_by: "scripts/run-instatoon-auction-lesson1-styles.mjs",
      source_file_name: path.basename(SOURCE_FILE),
      run_id: RUN_ID,
      instatoon: true,
      quick_episode_split: {
        unit_label: "card",
        max_units_per_episode: 12,
        episode_count: 1,
        total_units: pages.length,
        episodes: [{ episode: 1, start_unit: 1, end_unit: pages.length, unit_count: pages.length }]
      },
      source_card_plan: cardPlan
    }
  };
};

const buildImagePrompt = (card, style, cardCount) => {
  const isSerializedPanel = style.preset_id === "kwebtoon_serialized_panel";
  if (isSerializedPanel) {
    return `
Create ONE 4:5 portrait image for an Instagram carousel, but it must visually feel like ordinary Korean serialized webtoon panels cropped from the middle of an actual episode.
Generated size: ${IMAGE_SIZE}. This is card ${card.index} of ${cardCount}.
Topic: 경매 1강 - 경매로 어떻게 돈을 벌어요?

Use this content only as short speech-bubble or small narration-box material:
${[...(card.dialogue || []), ...(card.visible_text || []), card.takeaway || ""].filter(Boolean).map((line) => `- ${line}`).join("\n")}

Visual scene: ${card.visual || ""}

Style preset: ${style.preset_label}
Style rules: ${style.style_prompt}
Negative style rules: ${style.negative_style_prompt || "blurry, unreadable text, watermark"}

Composition rules:
- Do NOT make card news. Do NOT use giant headline typography, infographic blocks, poster title design, presentation-slide layout, or social-media template design.
- Make it feel like a casual screenshot from the middle of a Korean webtoon episode.
- Use 1 to 3 ordinary webtoon panels with plain gutters, speech bubbles, small narration boxes, casual camera angles, mid-conversation framing, and understated backgrounds.
- Characters should not pose for the viewer. Use functional story staging, reaction shots, ordinary crops, and mobile-readable bubbles.
- Keep Korean text short and readable. Put text in speech bubbles or small webtoon narration boxes only.
- No investment recommendation, no guaranteed profit wording.
- No watermark, no app UI, no mock browser chrome.
`.trim();
  }

  return `
Create ONE finished Instagram carousel instatoon card.
Format: 4:5 portrait feed card, generated at ${IMAGE_SIZE}. This is card ${card.index} of ${cardCount}.
Topic: 경매 1강 - 경매로 어떻게 돈을 벌어요?

Card title: ${card.title || ""}
Visible Korean text to render clearly:
${(card.visible_text || []).map((line) => `- ${line}`).join("\n")}
Dialogue:
${(card.dialogue || []).map((line) => `- ${line}`).join("\n")}
Takeaway: ${card.takeaway || ""}
Visual scene: ${card.visual || ""}

Style preset: ${style.preset_label}
Style rules: ${style.style_prompt}
Negative style rules: ${style.negative_style_prompt || "blurry, unreadable text, watermark"}

Composition rules:
- This must look like an Instagram carousel card, not a long vertical webtoon strip.
- Use 1 to 3 clean comic/news-card beats only.
- Prioritize large readable Korean headline/body text.
- Keep safe margins. Do not cover faces with text.
- No investment recommendation, no guaranteed profit wording.
- No watermark, no app UI, no mock browser chrome.
`.trim();
};

const generateImageWithRetry = async (styleId, style, card, cardCount) => {
  const prompt = buildImagePrompt(card, style, cardCount);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      log({ stage: "image", status: "started", style: style.preset_label, card: card.index, attempt });
      const response = await postJson("/api/codex/generate-image", {
        prompt,
        model: IMAGE_MODEL,
        size: IMAGE_SIZE,
        quality: IMAGE_QUALITY,
        moderation: "low"
      }, 12 * 60_000);
      if (!response?.image_data_url) throw new Error("Image response was empty.");
      const outFile = path.join(OUT_DIR, sanitizeName(style.preset_label), `slide_${String(card.index).padStart(2, "0")}.png`);
      dataUrlToPngFile(response.image_data_url, outFile);
      log({ stage: "image", status: "success", style: style.preset_label, card: card.index, attempt, file: outFile });
      return { page_index: card.index, composed_image_url: response.image_data_url };
    } catch (e) {
      const message = String(e?.message || e || "image failed");
      log({ stage: "image", status: attempt < 2 ? "retrying" : "error", style: style.preset_label, card: card.index, attempt, message });
      if (attempt >= 2) throw e;
    }
  }
};

const loadArchive = async () => {
  const data = await getJson("/api/project-archive");
  return Array.isArray(data?.projects) ? data.projects : [];
};

const saveArchive = async (projects) => {
  await postJson("/api/project-archive", { projects }, 10 * 60_000);
};

const saveProject = async ({ label, styleId, style, plan, results, errors }) => {
  const now = Date.now();
  const pageRenderedAt = {};
  const pageRenderedImageSize = {};
  const pageRenderedEngineKey = {};
  for (const result of results) {
    pageRenderedAt[result.page_index] = now;
    pageRenderedImageSize[result.page_index] = "2K";
    pageRenderedEngineKey[result.page_index] = `codex:${IMAGE_MODEL}:${IMAGE_QUALITY}`;
  }

  const project = {
    id: crypto.randomUUID(),
    label,
    created_at: now,
    updated_at: now,
    last_opened_at: now,
    snapshot: {
      topic: "경매 1강 - 경매로 어떻게 돈을 벌어요?",
      questionType: "explain",
      comicMode: "learning",
      outputMode: "comic",
      publicationFormat: "instatoon",
      mangaColorMode: "color",
      i2vAspectRatio: "1:1",
      toneMode: "normal",
      toneLevel: "medium",
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
      characterConsistencyMode: "loose",
      useCrossPageStyleConsistency: false,
      researchMode: "auto_digest",
      researchDigestText: sourceText,
      cast: plan.series_spec.anchors.cast,
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

  const current = await loadArchive();
  const deduped = current.filter((item) => item.label !== label);
  await saveArchive([project, ...deduped].slice(0, 200));
  log({ stage: "archive", status: "success", label, images: results.length, errors: Object.keys(errors).length });
};

const main = async () => {
  log({ stage: "run", status: "started", run_id: RUN_ID, out_dir: OUT_DIR });
  const cardPlan = await buildCardPlan();
  const styleJobs = STYLE_IDS.map((styleId) => {
    const style = selectStyle(styleId);
    const plan = buildSeriesPlan(cardPlan, style);
    const label = `경매 1강 인스타툰 · ${style.preset_label}`;
    return { styleId, style, plan, label };
  });

  const styleResults = await Promise.all(styleJobs.map(async (job) => {
    const images = await Promise.allSettled(cardPlan.cards.map((card) => generateImageWithRetry(job.styleId, job.style, card, cardPlan.cards.length)));
    const results = [];
    const errors = {};
    images.forEach((result, index) => {
      const pageIndex = index + 1;
      if (result.status === "fulfilled" && result.value) results.push(result.value);
      else errors[pageIndex] = String(result.reason?.message || result.reason || "image failed");
    });
    results.sort((a, b) => a.page_index - b.page_index);
    await saveProject({ ...job, results, errors });
    fs.writeFileSync(path.join(OUT_DIR, sanitizeName(job.style.preset_label), "project-summary.json"), JSON.stringify({
      label: job.label,
      style: job.style,
      results: results.map((item) => ({ page_index: item.page_index })),
      errors
    }, null, 2));
    return { label: job.label, results: results.length, errors: Object.keys(errors).length };
  }));

  log({ stage: "run", status: "complete", run_id: RUN_ID, out_dir: OUT_DIR, styleResults });
};

main().catch((e) => {
  log({ stage: "fatal", status: "error", message: String(e?.stack || e?.message || e) });
  process.exitCode = 1;
});
