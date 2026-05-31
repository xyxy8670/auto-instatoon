import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const API_URL = "http://127.0.0.1:8787/api/codex/generate-image";
const ARCHIVE_URL_BASE = "http://127.0.0.1:8787/archive-assets";
const runId = `ai_capacitor_instatoon_4x5_5styles_${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}`;
const runDir = path.join(root, "local-project-archive", runId);
const archivePath = path.join(root, "local-project-archive", "projects.json");
const presets = JSON.parse(fs.readFileSync(path.join(root, "style_presets.json"), "utf8"));

const timestamp = Date.now();
const dialogueCraftRules = [
  "Each Instagram card has one job only: cover, question, answer, proof, comparison, or next question.",
  "Do not answer a question on the same card unless the card is explicitly an answer card.",
  "Leave curiosity at the end of many cards so the reader wants to swipe.",
  "Tori asks one plain beginner question at a time. Booki answers in one short line on the next beat.",
  "Do not make characters read the card copy. Put data in captions/evidence cards; keep speech as reaction or conflict.",
  "Avoid stiff explanation endings such as 중요해, 봐야 해, 흐름이다.",
  "Use one short Korean speech bubble or caption box by default. Use two only on evidence or closing cards."
].join(" ");
const cards = [
  {
    index: 1,
    title: "반도체 다음에 볼 것",
    role: "hook",
    scene: "인스타 4:5 표지 카드. AI 서버와 반도체 칩을 배경으로, 네덜란드 드워프 토끼 토리가 반도체 칩만 확대경으로 보고 있다. 거북이 북이가 작은 MLCC 부품을 손에 들고 뒤에서 등장한다.",
    text: ["캡션: 반도체 다음, MLCC 봐야 합니다"]
  },
  {
    index: 2,
    title: "첫 질문",
    role: "question",
    scene: "책상 위에 MLCC라고 적힌 아주 작은 부품 하나가 놓여 있다. 토리는 너무 작아서 확대경을 들이대고, 북이는 대답하지 않고 기다린다. 기사나 차트는 넣지 않는다.",
    text: ["토리: MLCC가 뭔데요?"]
  },
  {
    index: 3,
    title: "쌀알 같은 부품",
    role: "answer",
    scene: "쌀알만 한 MLCC 부품이 출렁이는 전기 흐름을 잡아주는 장면. 토리는 쌀알과 부품을 번갈아 보며 헷갈린다. 기사나 차트는 넣지 않는다.",
    text: ["북이: 쌀알만 한 전기 안정장치."]
  },
  {
    index: 4,
    title: "꼭 필요한 이유",
    role: "question",
    scene: "AI 서버 랙 앞에서 토리가 작은 MLCC를 손바닥에 올려놓고 의심스러운 표정으로 바라본다. 북이는 뒤에서 전기 흐름 보드를 펼치려 한다. 기사나 차트는 넣지 않는다.",
    text: ["토리: 그게 꼭 필요해요?"]
  },
  {
    index: 5,
    title: "전기를 많이 먹는 서버",
    role: "answer",
    scene: "AI 서버가 전기를 많이 먹는 모습을 단순하고 재밌게 표현한다. 전기 게이지가 올라가고, MLCC가 그 앞에서 흔들림을 잡는 장면. 기사나 차트는 넣지 않는다.",
    text: ["북이: AI 서버는 전기를 너무 많이 먹거든."]
  },
  {
    index: 6,
    title: "누가 만드나",
    role: "question",
    scene: "토리가 작은 부품에 이름표를 붙이려 한다. 빈 이름표가 크게 보이고, 북이는 아직 회사명을 말하지 않는다. 기사나 차트는 넣지 않는다.",
    text: ["토리: 요거는 누가 만드는데요?"]
  },
  {
    index: 7,
    title: "삼성전기",
    role: "article_evidence",
    scene: "이 카드에만 삼성전기 실리콘 커패시터 계약 기사 근거를 크게 넣는다. 기사 화면은 간단한 신문/모니터 형태로 재구성한다. 차트는 넣지 않는다. 기사 안 숫자는 반드시 계약 규모 1조5570억 원, 기간 2027.01.01~2028.12.31, 매출 대비 13.8%만 쓴다.",
    text: ["북이: 삼성전기.", "캡션: 실리콘 커패시터 1조5570억 원 계약"]
  },
  {
    index: 8,
    title: "다른 커패시터",
    role: "comparison_question",
    scene: "MLCC와 실리콘 커패시터가 각각 기판 위와 칩 가까이에 놓인 단순 비교 그림. 토리가 두 부품을 번갈아 보며 헷갈린다. 기사나 차트는 넣지 않는다.",
    text: ["토리: MLCC랑 실리콘 커패시터는 같은 거예요?"]
  },
  {
    index: 9,
    title: "붙는 위치가 다르다",
    role: "comparison_answer",
    scene: "MLCC는 기판 위에서 전기를 잡고, 실리콘 커패시터는 AI 칩 패키지 가까이 붙는다는 비교 그림. 차트와 기사 화면은 넣지 않는다.",
    text: ["북이: 역할은 비슷한데, 붙는 위치가 달라."]
  },
  {
    index: 10,
    title: "차트와 다음 질문",
    role: "chart_evidence",
    scene: "이 카드에만 삼성전기와 삼화콘덴서 6개월 차트 근거를 두 개의 깔끔한 카드로 넣는다. 토리는 차트를 보고 놀라고, 북이는 다음 장이 있을 것처럼 밸류체인 지도를 살짝 펼친다. 기사 화면은 넣지 않는다.",
    text: ["토리: 벌써 움직였네요?", "북이: 그럼 다음은 주변 부품이야."]
  }
];

const cast = [
  {
    id: "tori",
    role: "protagonist",
    name: "토리",
    appearance: "작은 네덜란드 드워프 토끼. 부드러운 회색빛 흰 털, 작은 후드티, 스마트폰. 겁이 조금 많고 솔직한 입문자.",
    persona: "초보 투자자의 빠른 결론, 조급함, 솔직한 당황을 맡는다. 어려운 말을 들으면 바로 쉽게 풀어달라고 묻는다.",
    catchphrase: "쉽게 말하면요?",
    catchphrase_frequency: "sometimes",
    reference_images: []
  },
  {
    id: "booki",
    role: "supporting",
    name: "북이",
    appearance: "작고 차분한 거북이. 둥근 등껍질, 작은 안경, 자료판과 포인터. 느리지만 안정적인 선생님.",
    persona: "토리의 성급한 결론을 느리게 바로잡는다. 복잡한 시장 이야기를 쉬운 말과 짧은 건조한 한마디로 설명한다.",
    catchphrase: "천천히 보면 쉬워.",
    catchphrase_frequency: "rare",
    reference_images: []
  }
];

const dcWebtoonStyle = {
  id: "dc_korean_serialized_webtoon",
  category: "Webtoon",
  label: "아까 보낸 웹툰작화버전",
  style_prompt: [
    "Korean commercial serialized webtoon episode panel style.",
    "It should feel like an ordinary panel from the middle of a real vertically scrolling Korean webtoon episode, adapted into an Instagram 4:5 carousel card.",
    "Use functional storytelling composition, casual camera angles, slightly awkward crops, mid-conversation reaction shot feeling, practical mobile readability, lightweight digital linework, simplified faces, simple hands, grouped hair masses, soft flat cel shading, muted dusty colors, gray-beige calm palette, simple readable background, low information density, fast serialization feeling.",
    "Do not make a poster, cover, splash art, promotional illustration, Instagram art poster, YouTube thumbnail, cinematic key visual, glossy anime illustration, photoreal image, or infographic-heavy slide."
  ].join(" ")
};

const styleIds = ["manga_2000s_slice", "photoreal_polaroid_instant", "isometric_3d_room", "kwebtoon_clean_pastel"];
const styles = [
  dcWebtoonStyle,
  ...styleIds.map((id) => presets.find((preset) => preset.id === id)).filter(Boolean)
];

const log = async (entry) => {
  const line = JSON.stringify({ created_at: new Date().toISOString(), ...entry });
  console.log(line);
  await fsp.appendFile(path.join(runDir, "run.jsonl"), `${line}\n`, "utf8");
};

const safeName = (value) =>
  String(value)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);

const dataUrlToBuffer = (dataUrl) => Buffer.from(String(dataUrl).split(",")[1] || "", "base64");

const archiveAssetUrl = (filePath) => {
  const rel = path.relative(path.join(root, "local-project-archive"), filePath).split(path.sep).map(encodeURIComponent).join("/");
  return `${ARCHIVE_URL_BASE}/${rel}`;
};

const resizeToInstagram = (rawFile, finalFile) => {
  const result = spawnSync("sips", ["-z", "1350", "1080", rawFile, "--out", finalFile], { encoding: "utf8" });
  if (result.status !== 0) {
    fs.copyFileSync(rawFile, finalFile);
    return false;
  }
  return true;
};

const promptFor = (style, card) => {
  const evidenceRule = card.role === "article_evidence"
    ? "This is the ONLY article evidence card. Include the Samsung Electro-Mechanics silicon capacitor contract article/news evidence. Do NOT include stock charts."
    : card.role === "chart_evidence"
      ? "This is the ONLY stock chart evidence card. Include Samsung Electro-Mechanics +448.97% and Samwha Capacitor +178.80% six-month chart cards. Do NOT include article/news evidence."
      : "Do NOT include Samsung Electro-Mechanics article screenshots, stock charts, stock prices, +448.97%, +178.80%, or repeated evidence panels on this card.";

  return [
    "Create ONE Instagram carousel comic card.",
    "Canvas/composition: strict 4:5 portrait ratio, designed for 1080x1350 Instagram feed card. Do not create a long vertical webtoon page.",
    "Korean text only. Keep text very short and readable. Use at most two total speech bubbles or caption boxes.",
    "One idea only on this card. No repeated evidence from other cards.",
    evidenceRule,
    "Characters must be consistent: 토리 is a small Dutch dwarf rabbit in a hoodie, beginner investor. 북이 is a calm small turtle with glasses and a pointer. Do not use a quokka. Do not use a skeleton.",
    "Natural simple Korean. Avoid awkward meme lines, stiff GPT wording, overexplaining, buy/sell recommendation, target price, and investment advice.",
    `Dialogue craft rules: ${dialogueCraftRules}`,
    `Card ${card.index}/10: ${card.title}`,
    `Scene: ${card.scene}`,
    `Text to place exactly or very close: ${card.text.join(" / ")}`,
    "Core message: AI server bottleneck is not only GPU/HBM. As AI chips grow, near-chip power stabilization parts such as silicon capacitors and MLCC can become important.",
    `Art style: ${style.label}. ${style.style_prompt || ""}`,
    style.negative_style_prompt ? `Avoid style mistakes: ${style.negative_style_prompt}` : ""
  ].filter(Boolean).join("\n");
};

const generateImage = async (prompt, style, card, attempt) => {
  await log({ stage: "image", status: "started", style: style.label, card: card.index, attempt });
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Request-Id": `instatoon_${style.id}_${card.index}_${attempt}_${crypto.randomUUID().slice(0, 8)}`
    },
    body: JSON.stringify({
      prompt,
      model: "gpt-5.5",
      size: "1088x1360",
      quality: "high",
      moderation: "low"
    })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.image_data_url) {
    throw new Error(json?.error?.message || `HTTP ${response.status}`);
  }
  return json.image_data_url;
};

const runPool = async (items, limit, worker) => {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  });
  await Promise.all(workers);
};

const buildSeriesPlan = (style) => ({
  title: `AI 서버 커패시터 숨은 뷰 · ${style.label}`,
  logline: "GPU/HBM만 보던 AI 서버 수혜주 관점을 칩 옆 전력 안정화 부품으로 확장하는 인스타툰",
  anchors: {
    style: {
      id: style.id,
      label: style.label,
      style_prompt: style.style_prompt || "",
      negative_style_prompt: style.negative_style_prompt || ""
    }
  },
  pages: cards.map((card) => ({
    page: {
      index: card.index,
      chapter_title: `${card.index}. ${card.title}`
    },
    layout: {
      template_id: "instatoon_single_card",
      canvas: { w: 1080, h: 1350 },
      gutter_px: 16,
      border_px: 3,
      border_radius_px: 0,
      background_color: "#FFFFFF",
      template_panels: []
    },
    panels: [
      {
        index: 1,
        scene: card.scene,
        acting: "인스타 4:5 카드 한 장에 핵심 메시지 하나만 담는다. 말풍선과 캡션은 합쳐서 최대 2개.",
        dialogues: card.text.map((line) => {
          const [speaker, ...rest] = line.split(":");
          return rest.length
            ? { speaker: speaker.trim(), text: rest.join(":").trim() }
            : { speaker: "캡션", text: line.trim() };
        }),
        camera: "Instagram 4:5 carousel card composition",
        mood: "easy educational comic, calm, light",
        render: {
          style: style.style_prompt || style.label,
          text_policy: "short Korean text only"
        }
      }
    ]
  }))
});

const buildSnapshot = (style, pageResults, pageErrors) => ({
  topic: "AI 서버 커패시터 숨은 뷰",
  questionType: "explain",
  comicMode: "learning",
  outputMode: "comic",
  publicationFormat: "instatoon",
  mangaColorMode: "color",
  i2vAspectRatio: "9:16",
  toneMode: "normal",
  toneLevel: "medium",
  introStyle: "standard",
  language: "ko",
  audienceLevel: "beginner",
  deliveryStyleId: "standard",
  deliveryCustomInstruction: "쉬운 한국어, 말풍선 적게, 어색한 밈 금지",
  geminiReasoningEffort: "medium",
  layoutVariety: "medium",
  imageSize: "2K",
  imageProvider: "codex",
  codexImageQuality: "high",
  scriptDetail: "normal",
  pageCountMode: "manual",
  targetPageCount: 10,
  narrativeRole: "actor",
  characterConsistencyMode: "loose",
  useCrossPageStyleConsistency: false,
  researchMode: "user",
  researchDigestText: "삼성전기 실리콘 커패시터 공급계약, AI 서버 전력 안정화 부품, MLCC/실리콘 커패시터 차이, 삼성전기/삼화콘덴서 6개월 흐름을 근거로 삼되 매수 추천은 하지 않는다.",
  cast,
  productReferenceImages: [],
  selectedPresetId: style.id,
  selectedStyleCategory: style.category || "Webtoon",
  finalStyle: {
    id: style.id,
    label: style.label,
    style_prompt: style.style_prompt || "",
    negative_style_prompt: style.negative_style_prompt || ""
  },
  seriesPlan: buildSeriesPlan(style),
  pageResults,
  pageErrors,
  pageRenderedAt: Object.fromEntries(pageResults.map((result) => [result.page_index, timestamp])),
  pageRenderedImageSize: Object.fromEntries(pageResults.map((result) => [result.page_index, "2K"])),
  pageRenderedEngineKey: Object.fromEntries(pageResults.map((result) => [result.page_index, "codex:gpt-5.5:high:instatoon-4x5"])),
  pageScriptEditedAt: {},
  pageStyleOverrides: {},
  pageStyleEditedAt: {},
  globalStyleEditedAt: 0,
  creationType: "educational",
  scriptText: cards.map((card) => `${card.index}. ${card.title}\n${card.text.join("\n")}`).join("\n\n"),
  storyInputType: "scenario",
  storyAdaptationMode: "direct",
  ageRating: "all_ages",
  storyGenre: "slice_of_life",
  pacingPreference: "balanced",
  storyAntiEducationGuardEnabled: true,
  storyDigestText: "인스타 4:5 카드뉴스형 학습만화. 기사 근거는 4장, 차트 근거는 9장에만 배치."
});

const readArchive = () => {
  if (!fs.existsSync(archivePath)) return { version: 1, updated_at: new Date().toISOString(), projects: [] };
  const parsed = JSON.parse(fs.readFileSync(archivePath, "utf8"));
  return {
    version: parsed.version || 1,
    updated_at: parsed.updated_at || new Date().toISOString(),
    projects: Array.isArray(parsed.projects) ? parsed.projects : []
  };
};

const writeArchive = (newProjects) => {
  const archive = readArchive();
  const ids = new Set(newProjects.map((project) => project.id));
  const projects = [...newProjects, ...archive.projects.filter((project) => !ids.has(project.id))];
  const payload = { version: 1, updated_at: new Date().toISOString(), projects };
  const tmp = `${archivePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, archivePath);
};

await fsp.mkdir(runDir, { recursive: true });
await log({ stage: "batch", status: "started", runId, styles: styles.map((style) => style.label), cards: cards.length });

const savedProjects = [];
for (const style of styles) {
  const styleDir = path.join(runDir, safeName(style.label));
  await fsp.mkdir(styleDir, { recursive: true });
  await log({ stage: "style", status: "started", style: style.label, cards: cards.length });

  const pageResults = [];
  const pageErrors = {};

  await runPool(cards, 4, async (card) => {
    const finalFile = path.join(styleDir, `slide_${String(card.index).padStart(2, "0")}.png`);
    const rawFile = path.join(styleDir, `raw_${String(card.index).padStart(2, "0")}.png`);
    const promptFile = path.join(styleDir, `prompt_${String(card.index).padStart(2, "0")}.txt`);
    const prompt = promptFor(style, card);
    await fsp.writeFile(promptFile, prompt, "utf8");

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const dataUrl = await generateImage(prompt, style, card, attempt);
        await fsp.writeFile(rawFile, dataUrlToBuffer(dataUrl));
        const resized = resizeToInstagram(rawFile, finalFile);
        pageResults.push({
          page_index: card.index,
          composed_image_url: archiveAssetUrl(finalFile)
        });
        await log({ stage: "image", status: "success", style: style.label, card: card.index, attempt, resized, file: finalFile });
        return;
      } catch (error) {
        if (attempt < 2) {
          await log({ stage: "image", status: "retrying", style: style.label, card: card.index, attempt, message: String(error.message || error) });
        } else {
          pageErrors[card.index] = String(error.message || error);
          await log({ stage: "image", status: "failed", style: style.label, card: card.index, attempt, message: String(error.message || error) });
        }
      }
    }
  });

  pageResults.sort((a, b) => a.page_index - b.page_index);
  const now = Date.now();
  const project = {
    id: crypto.randomUUID(),
    label: `인스타툰 4:5 · ${style.label} · AI 서버 커패시터 숨은 뷰`,
    created_at: now,
    updated_at: now,
    last_opened_at: now,
    snapshot: buildSnapshot(style, pageResults, pageErrors)
  };
  await fsp.writeFile(path.join(styleDir, "project.json"), JSON.stringify(project, null, 2), "utf8");
  await fsp.writeFile(path.join(styleDir, "project-summary.json"), JSON.stringify({
    label: project.label,
    runId,
    style: style.label,
    expected_cards: 10,
    generated_cards: pageResults.length,
    errors: pageErrors,
    files: pageResults.map((result) => ({
      page_index: result.page_index,
      file: `slide_${String(result.page_index).padStart(2, "0")}.png`,
      url: result.composed_image_url
    }))
  }, null, 2), "utf8");
  savedProjects.push(project);
  await log({ stage: "style", status: "saved", style: style.label, images: pageResults.length, errors: Object.keys(pageErrors).length });
}

writeArchive(savedProjects);
await log({ stage: "batch", status: "done", runDir, projects: savedProjects.length });
console.log(JSON.stringify({ ok: true, runDir, projects: savedProjects.map((project) => project.label) }, null, 2));
