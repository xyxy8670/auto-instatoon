import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.cwd();
const API_BASE = process.env.LOCAL_API_BASE || "http://127.0.0.1:8787";
const ARCHIVE_PATH = path.join(ROOT, "local-project-archive", "projects.json");
const STYLE_ID = process.env.STYLE_ID || "kwebtoon_serialized_panel";
const IMAGE_SIZE = process.env.IMAGE_SIZE || "1600x2000";
const IMAGE_QUALITY = process.env.IMAGE_QUALITY || "high";
const IMAGE_MODEL = process.env.CODEX_IMAGE_MODEL || "gpt-5.5";
const LABEL = "인스타툰 네이티브 4x5 개그밈 · AI 서버 수혜주 · 커패시터와 삼성전기";
const RUN_ID = `ai_server_capacitor_instatoon_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
const OUT_DIR = path.join(ROOT, "local-project-archive", RUN_ID);
const PROJECT_DUMP_DIR = path.join(ROOT, "local-project-archive", "ai_server_capacitor_instatoon_projects");
const RUN_LOG = path.join(OUT_DIR, "run.jsonl");
const ACTIVE_ARCHIVE_MAX_BYTES = 420 * 1024 * 1024;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(PROJECT_DUMP_DIR, { recursive: true });

const stylePresets = JSON.parse(fs.readFileSync(path.join(ROOT, "style_presets.json"), "utf8"));
const templates = JSON.parse(fs.readFileSync(path.join(ROOT, "layout_templates.json"), "utf8"));

const cast = [
  {
    name: "쿼식이",
    role: "해맑은 주식 관심러",
    appearance:
      "작고 둥근 쿼카 캐릭터. 밝은 갈색 털, 동그란 눈, 과장된 리액션, 작은 후드티, 스마트폰과 확대경을 자주 들고 다닌다. GPU와 HBM만 외치다가 핵심을 놓치는 역할."
  },
  {
    name: "골선생",
    role: "전기와 부품을 아는 냉정한 해골 해설자",
    appearance:
      "마른 해골 캐릭터. 검은 후드 카디건, 얇은 안경, 죽은 눈의 무표정, 작은 지휘봉과 회로도 판을 들고 있다. 말은 짧고 건조하지만 팩트로 뼈를 때리는 역할."
  }
];

const sourceText = `
주제: AI 서버 수혜주를 GPU/HBM만 보지 말고 커패시터, MLCC, 실리콘 커패시터까지 내려와서 보자는 투자 공부용 인스타툰.

자료 1: 삼성전기 기사
제목: 삼성전기 'AI반도체 소자' 新빅테크 뚫었다
핵심: 삼성전기가 고밀도 에너지 저장을 위한 반도체 소자인 실리콘 커패시터를 미국 빅테크에 공급하는 계약을 체결했다고 20일 발표했다. 실리콘 커패시터는 AI 반도체의 필수 부품 중 하나로 볼 수 있다.

자료 2: 삼성전기 6개월 차트
종목: 삼성전기, KRX 009150
가격: 1,194,000 KRW
6개월 등락: +976,500.00, +448.97%
시각적 흐름: 2026년 2월 이후 우상향, 5월 쪽에서 급격히 상승하는 붉은 라인 차트.

자료 3: 삼화콘덴서 6개월 차트
종목: 삼화콘덴서, KRX 001820
가격: 78,900 KRW
6개월 등락: +50,600.00, +178.80%
시각적 흐름: 2026년 2월 이후 단계적 급등, 5월 말에 다시 튀는 붉은 라인 차트.

주의: 특정 종목 매수 추천이 아니라 산업 흐름 공부용이다.
`.trim();

const cards = [
  {
    index: 1,
    title: "GPU만 보면 뼈 맞는다",
    visible_text: ["AI 서버 수혜주", "GPU만 보면 뼈 맞는다"],
    dialogue: ["쿼식이: AI 서버? 엔비디아! HBM! 끝!", "골선생: 그렇게 보면 계좌도 끝난다."],
    visual:
      "AI 서버실 앞. 쿼식이가 GPU 로고 없는 커다란 칩만 확대경으로 보며 환호한다. 뒤에서 골선생이 작은 커패시터 부품을 들고 조용히 등장한다. 첫 장이지만 포스터가 아니라 웹툰 한 장면처럼 자연스럽게 시작.",
    takeaway: "AI 서버 수혜는 GPU만으로 끝나지 않는다."
  },
  {
    index: 2,
    title: "다들 먼저 보는 것",
    visible_text: ["GPU", "HBM", "전력기기"],
    dialogue: ["쿼식이: 이 세 개면 국룰 아님?", "골선생: 국룰은 맞는데, 그게 전부는 아니다."],
    visual:
      "쿼식이가 GPU, HBM, 전력기기 팻말을 세 개 들고 개선장군처럼 서 있다. 골선생은 옆에서 작은 부품 상자를 열어 보여준다. 상자 안에는 커패시터들이 조용히 빛난다.",
    takeaway: "큰 부품 말고 작은 안정화 부품도 같이 봐야 한다."
  },
  {
    index: 3,
    title: "작지만 중요한 애들",
    visible_text: ["전기 안정화", "커패시터"],
    dialogue: ["쿼식이: 이 쌀알 같은 게요?", "골선생: 작다고 얕보면 전기가 먼저 삐진다."],
    visual:
      "전기 흐름이 파도처럼 출렁이고, 작은 커패시터 캐릭터들이 밧줄로 전기 파도를 붙잡는다. 쿼식이는 '이게 뭐야' 표정으로 얼어 있다.",
    takeaway: "커패시터는 전기를 안정적으로 잡아주는 부품이다."
  },
  {
    index: 4,
    title: "기사 근거",
    visible_text: ["삼성전기", "AI반도체 소자", "실리콘 커패시터 계약"],
    dialogue: ["쿼식이: 커패시터가 기사 주인공이 됐다고요?", "골선생: 조연인 줄 알았는데 엔딩 크레딧 맨 위다."],
    visual:
      "웹툰 속 태블릿 화면에 뉴스 기사 카드가 크게 보인다. 기사 카드에는 '삼성전기 AI반도체 소자 新빅테크 뚫었다', '실리콘 커패시터 공급 계약'이라는 문구와 반도체 패키지 이미지풍 썸네일이 들어간다. 쿼식이는 눈이 커지고 골선생은 태블릿을 가리킨다.",
    takeaway: "삼성전기의 실리콘 커패시터 계약이 핵심 근거다."
  },
  {
    index: 5,
    title: "MLCC 쉽게 설명",
    visible_text: ["MLCC = 전기한테 '진정해' 하는 부품"],
    dialogue: ["쿼식이: 쉽게요.", "골선생: 전기한테 '야 진정해' 하는 부품."],
    visual:
      "전기 캐릭터가 롤러코스터처럼 튀고, MLCC 캐릭터가 안전벨트를 채워준다. 쿼식이는 '회로계 상담사?'라는 표정으로 메모한다.",
    takeaway: "MLCC는 전자제품 안에서 전기를 안정시키는 대표 부품이다."
  },
  {
    index: 6,
    title: "실리콘 커패시터의 위치",
    visible_text: ["GPU와 HBM 가까이", "칩 패키지 안쪽"],
    dialogue: ["쿼식이: VIP석이네?", "골선생: 전기 안정화계의 1열 직관."],
    visual:
      "GPU와 HBM이 무대 위 스타처럼 있고, 실리콘 커패시터가 바로 앞 VIP석에서 전기를 잡아준다. 기존 MLCC는 조금 떨어진 기판 위에서 일한다. 차이를 만화적으로 보여준다.",
    takeaway: "실리콘 커패시터는 칩 가까이에서 전력 안정화를 돕는다."
  },
  {
    index: 7,
    title: "왜 가까워져야 하냐",
    visible_text: ["AI 칩은 커지고", "전력 소모는 늘어난다"],
    dialogue: ["쿼식이: 점점 뜨거운 도시락 되는 거네요?", "골선생: 그래서 바로 옆에서 잡아야 한다."],
    visual:
      "AI 칩이 점점 커지고 열기와 전력 게이지가 상승한다. 쿼식이가 작은 소화기를 들고 허둥대고, 골선생은 회로도에서 '전력 안정화'를 체크한다.",
    takeaway: "전력 소모가 커질수록 빠른 안정화 부품이 중요해진다."
  },
  {
    index: 8,
    title: "차트 근거",
    visible_text: ["삼성전기 +448.97%", "삼화콘덴서 +178.80%", "지난 6개월"],
    dialogue: ["쿼식이: 차트가 갑자기 출근했는데요?", "골선생: AI 알람 듣고 일어난 그림이다."],
    visual:
      "한 카드 안에 두 개의 깔끔한 차트 패널. 위쪽은 삼성전기 KRX 009150, 1,194,000 KRW, +448.97% 지난 6개월, 붉은 선이 5월에 급등. 아래쪽은 삼화콘덴서 KRX 001820, 78,900 KRW, +178.80% 지난 6개월, 붉은 선이 계단식 상승. 쿼식이와 골선생이 차트 옆에서 리액션한다.",
    takeaway: "시장은 커패시터 관련 흐름을 다시 보기 시작했다."
  },
  {
    index: 9,
    title: "투자 포인트",
    visible_text: ["GPU", "HBM", "전력 안정화 부품"],
    dialogue: ["쿼식이: 결국 밑단까지 봐야겠네요?", "골선생: 칩만 보면 반쪽이다."],
    visual:
      "AI 서버 밸류체인 사다리. 맨 위에는 GPU와 HBM, 중간에는 전력기기, 아래에는 MLCC와 실리콘 커패시터가 있다. 쿼식이가 사다리 아래를 보고 뒤늦게 깨닫는다.",
    takeaway: "AI 서버 수혜는 칩에서 전력 안정화 부품으로 내려온다."
  },
  {
    index: 10,
    title: "엔딩",
    visible_text: ["매수 추천 아님", "산업 흐름 공부용", "AI도 전기 앞에서는 겸손하다"],
    dialogue: ["쿼식이: AI도 전기 앞에서는 겸손하네요.", "골선생: 드디어 뼈에 새겼군."],
    visual:
      "쿼식이가 커패시터에게 작은 왕관을 씌운다. 골선생은 '저장' 도장을 찍는다. 아래에는 투자 권유가 아니라 산업 흐름 공부라는 작은 주의 문구가 있다.",
    takeaway: "산업 흐름을 공부하되 매수 추천으로 받아들이면 안 된다."
  }
];

const log = (entry) => {
  const line = JSON.stringify({ created_at: new Date().toISOString(), ...entry });
  fs.appendFileSync(RUN_LOG, `${line}\n`);
  console.log(line);
};

const postJson = async (url, body, timeoutMs = 12 * 60_000) => {
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
      // keep raw text
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
    .slice(0, 140) || "instatoon";

const dataUrlToPngFile = (dataUrl, filePath) => {
  const match = /^data:image\/png;base64,(.+)$/s.exec(String(dataUrl || ""));
  if (!match) throw new Error("Expected PNG data URL.");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(match[1], "base64"));
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
    ...deduped.filter((item) => String(item.label || "").startsWith("인스타툰 네이티브 4x5 개그밈")),
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

const buildSeriesPlan = (style) => {
  const pages = cards.map((card, index) => {
    const templateId = index === 0
      ? "instatoon_cover"
      : index === cards.length - 1
        ? "instatoon_focus_2"
        : index % 2 === 0
          ? "instatoon_card_3"
          : "instatoon_focus_2";
    const template = getTemplate(templateId);
    return {
      page: {
        index: index + 1,
        chapter_title: `${index + 1}. ${card.title}`
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
        scene: `${card.visual}\n핵심 텍스트: ${card.visible_text.join(" / ")}\n정리: ${card.takeaway}`,
        acting:
          "쿼식이는 해맑게 오해하고 과장 리액션을 한다. 골선생은 무표정하게 짧고 건조한 팩트로 받아친다. 살짝 센 밈 감성은 있지만 정보 전달을 방해하지 않는다.",
        dialogues: card.dialogue,
        camera: panelIndex === 0 ? "native 4:5 instatoon medium shot" : "supporting close-up or data-detail panel",
        mood: "comedic, educational, deadpan, meme-aware, beginner-friendly",
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
        title: LABEL,
        language: "ko",
        audience_level: "beginner",
        page_count: pages.length
      },
      anchors: {
        protagonist: {
          appearance: cast[0].appearance,
          role: "narrator",
          reference_images: { main: "", pack: [] }
        },
        cast,
        tone_mode: "gag",
        tone_level: "high",
        style
      },
      constraints: {
        comic_mode: "learning",
        output_mode: "comic",
        publication_format: "instatoon",
        manga_color_mode: "color",
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
      generated_by: "scripts/run-ai-server-capacitor-instatoon.mjs",
      run_id: RUN_ID,
      source_card_plan: { title: LABEL, cards }
    }
  };
};

const buildImagePrompt = ({ card, style }) => `
Create ONE native 4:5 portrait Korean webtoon-style Instagram carousel image.
Generated size: ${IMAGE_SIZE}. This is card ${card.index} of ${cards.length}.
Topic: AI server beneficiaries, capacitors, MLCC, silicon capacitors, Samsung Electro-Mechanics.
Tone: comedic educational instatoon with tasteful Korean internet meme energy. Not a poster, not a card-news slide.

Recurring characters:
- 쿼식이: ${cast[0].appearance}
- 골선생: ${cast[1].appearance}

Required short Korean text, use only as speech bubbles or small narration boxes:
${[...card.dialogue, ...card.visible_text, card.takeaway].filter(Boolean).map((line) => `- ${line}`).join("\n")}

Visual scene:
${card.visual}

Important data-card fidelity:
- For article card, recreate a clear in-comic news-card based on the supplied facts: "삼성전기 'AI반도체 소자' 新빅테크 뚫었다", "실리콘 커패시터 공급 계약". Do not pretend it is a browser screenshot; make it a readable evidence card inside the comic.
- For chart card, draw two simplified red 6-month line charts inside the comic: Samsung Electro-Mechanics KRX 009150, 1,194,000 KRW, +448.97%; Samhwa Capacitor KRX 001820, 78,900 KRW, +178.80%. The chart shapes should rise sharply toward May 2026.

Style preset: ${style.preset_label}
Style rules: ${style.style_prompt}
Negative style rules: ${style.negative_style_prompt || "blurry, unreadable text, watermark"}

Composition rules:
- Output must be exactly 4:5 portrait, suitable for Instagram carousel.
- Compose natively for the 4:5 canvas from the beginning. Do NOT crop, slice, trim, or adapt a taller webtoon page.
- Use 1 to 3 ordinary webtoon panels with plain gutters, speech bubbles, small narration boxes, casual camera angles, mid-conversation framing, and understated backgrounds.
- Keep 쿼식이 and 골선생 visually consistent across all cards.
- Add one tasteful gag or meme-style reaction: exaggerated shocked quokka face, deadpan skeleton reply, tiny sweat drop, comic pause, light speed lines, or short generic Korean meme-like phrase.
- Keep Korean text short and readable. Avoid too much tiny text.
- No investment recommendation, no guaranteed profit wording.
- No real company logos, watermark, app UI, or mock browser chrome.
`.trim();

const generateImageWithRetry = async ({ card, style }) => {
  const prompt = buildImagePrompt({ card, style });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      log({ stage: "image", status: "started", card: card.index, attempt });
      const response = await postJson("/api/codex/generate-image", {
        prompt,
        model: IMAGE_MODEL,
        size: IMAGE_SIZE,
        quality: IMAGE_QUALITY,
        moderation: "low"
      });
      if (!response?.image_data_url) throw new Error("Image response was empty.");
      const outFile = path.join(OUT_DIR, `slide_${String(card.index).padStart(2, "0")}.png`);
      dataUrlToPngFile(response.image_data_url, outFile);
      log({ stage: "image", status: "success", card: card.index, attempt, file: outFile });
      return { page_index: card.index, composed_image_url: response.image_data_url };
    } catch (e) {
      const message = String(e?.message || e || "image failed");
      log({ stage: "image", status: attempt < 2 ? "retrying" : "error", card: card.index, attempt, message });
      if (attempt >= 2) throw e;
    }
  }
};

const saveProject = ({ style, styleId, plan, results, errors }) => {
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
    label: LABEL,
    created_at: now,
    updated_at: now,
    last_opened_at: now,
    snapshot: {
      topic: "AI 서버 수혜주, 커패시터, 삼성전기",
      questionType: "explain",
      comicMode: "learning",
      outputMode: "comic",
      publicationFormat: "instatoon",
      mangaColorMode: "color",
      toneMode: "gag",
      toneLevel: "high",
      language: "ko",
      audienceLevel: "beginner",
      deliveryStyleId: "standard",
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
      researchMode: "direct_input",
      researchDigestText: sourceText,
      cast,
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
      storyDigestText: sourceText,
      paperBrief: null
    }
  };
  writeArchiveWithProject(project);
  log({ stage: "save", status: "success", label: LABEL, images: results.length, errors: Object.keys(errors).length });
};

const main = async () => {
  log({ stage: "run", status: "started", run_id: RUN_ID, out_dir: OUT_DIR, cards: cards.length });
  const style = getStyle();
  const plan = buildSeriesPlan(style);
  fs.writeFileSync(path.join(OUT_DIR, "card-plan.json"), JSON.stringify({ title: LABEL, cards }, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "series-plan.json"), JSON.stringify(plan, null, 2));

  const images = await Promise.allSettled(cards.map((card) => generateImageWithRetry({ card, style })));
  const results = [];
  const errors = {};
  images.forEach((result, index) => {
    const pageIndex = index + 1;
    if (result.status === "fulfilled" && result.value) results.push(result.value);
    else errors[pageIndex] = String(result.reason?.message || result.reason || "image failed");
  });
  results.sort((a, b) => a.page_index - b.page_index);
  saveProject({ style, styleId: STYLE_ID, plan, results, errors });
  fs.writeFileSync(path.join(OUT_DIR, "project-summary.json"), JSON.stringify({
    label: LABEL,
    results: results.map((item) => ({ page_index: item.page_index })),
    errors
  }, null, 2));
  log({ stage: "run", status: "complete", run_id: RUN_ID, out_dir: OUT_DIR });
};

main().catch((e) => {
  log({ stage: "fatal", status: "error", message: String(e?.stack || e?.message || e) });
  process.exitCode = 1;
});
