import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  FileText,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Sparkles,
  Wand2
} from "lucide-react";
import { ApiRequestError, getJson, postJson } from "./services/localApi";

type Health = {
  codex_oauth_autostart?: boolean;
  codex_oauth_port?: number;
  codex_oauth_url?: string;
  codex_image_model?: string;
  codex_text_model?: string;
};

type OAuthStatus = {
  status?: "ready" | "auth_required" | "starting" | "offline" | string;
  models?: string[];
};

type Tone = "clear" | "warm" | "sharp" | "funny";
type VisualStyle = "serialized" | "clean" | "marker" | "finance";
type Stage = "idle" | "planning" | "planned" | "generating" | "done" | "error";
type CardStatus = "idle" | "queued" | "generating" | "done" | "error";

type ToonCard = {
  id: string;
  index: number;
  headline: string;
  scene: string;
  dialogue: string;
  caption: string;
  visualPrompt: string;
  status: CardStatus;
  imageUrl?: string;
  error?: string;
};

type PlanResult = {
  title: string;
  audience: string;
  thesis: string;
  cards: Array<{
    headline: string;
    scene: string;
    dialogue: string;
    caption: string;
    visualPrompt: string;
  }>;
};

const CARD_IMAGE_SIZE = "1088x1360";
const MAX_PARALLEL_IMAGES = 2;

const toneLabels: Record<Tone, string> = {
  clear: "깔끔",
  warm: "따뜻",
  sharp: "날카롭게",
  funny: "가볍게"
};

const styleLabels: Record<VisualStyle, string> = {
  serialized: "연재 웹툰",
  clean: "클린 파스텔",
  marker: "마커 스케치",
  finance: "금융 카드툰"
};

const stylePrompts: Record<VisualStyle, string> = {
  serialized:
    "Korean serialized webtoon mid-episode panel style, practical mobile readability, clean linework, restrained colors, speech bubbles, casual cropped framing, not a poster, not an ad.",
  clean:
    "Clean Korean webtoon card style, smooth pastel colors, crisp linework, bright readability, simple symbolic backgrounds, polished but not glossy.",
  marker:
    "Loose marker sketch comic style, expressive lines, warm paper texture, simple faces, handmade education note feeling, readable Korean speech bubbles.",
  finance:
    "Modern finance explainer comic style, clean charts as background props, office and phone UI motifs, crisp Korean labels, calm professional palette, friendly characters."
};

const jsonSchema = {
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

const initialTopic =
  "청년이 경제 뉴스를 읽을 때 가장 먼저 봐야 할 3가지: 금리, 환율, 실적을 인스타툰으로 설명";

const pickText = (error: unknown) => {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error || "알 수 없는 오류가 발생했어요.");
};

const parsePlan = (text: string): PlanResult => {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1];
  const parsed = JSON.parse(fenced || trimmed);
  if (!parsed || !Array.isArray(parsed.cards)) throw new Error("콘티 JSON 형식이 맞지 않습니다.");
  return {
    title: String(parsed.title || "Untitled Instatoon").trim(),
    audience: String(parsed.audience || "general").trim(),
    thesis: String(parsed.thesis || "").trim(),
    cards: parsed.cards.map((card: any) => ({
      headline: String(card.headline || "").trim(),
      scene: String(card.scene || "").trim(),
      dialogue: String(card.dialogue || "").trim(),
      caption: String(card.caption || "").trim(),
      visualPrompt: String(card.visualPrompt || "").trim()
    }))
  };
};

const buildPlanPrompt = (params: {
  topic: string;
  cardCount: number;
  tone: Tone;
  style: VisualStyle;
}) => `
Create a Korean Instagram carousel comic storyboard.

Topic:
${params.topic}

Requirements:
- exactly ${params.cardCount} cards
- format: 4:5 instatoon cards
- tone: ${toneLabels[params.tone]}
- visual style: ${styleLabels[params.style]}
- each card must have one clear visual situation, short Korean dialogue, and one caption
- make it useful for a creator who wants to publish quickly
- avoid long paragraphs and generic motivational copy
- keep every Korean text short enough to fit inside a mobile card

Return only JSON that matches the schema.
`;

const buildImagePrompt = (card: ToonCard, plan: PlanResult, style: VisualStyle) => `
Create one finished Korean instatoon card image.

Canvas:
- ${CARD_IMAGE_SIZE}px, vertical 4:5 Instagram carousel card
- finished image, no watermark, no UI frame

Series:
- title: ${plan.title}
- thesis: ${plan.thesis}

Card ${card.index}:
- headline text: "${card.headline}"
- scene: ${card.scene}
- dialogue text: "${card.dialogue}"
- caption text: "${card.caption}"
- visual direction: ${card.visualPrompt}

Style:
${stylePrompts[style]}

Composition rules:
- Korean text must be readable and short
- use speech bubbles or compact caption boxes
- no tiny text blocks
- no brand logos
- no photorealism
- the card should look like a post-ready Instagram comic card
`;

const makeCards = (plan: PlanResult): ToonCard[] =>
  plan.cards.map((card, index) => ({
    id: `${Date.now()}-${index}`,
    index: index + 1,
    headline: card.headline,
    scene: card.scene,
    dialogue: card.dialogue,
    caption: card.caption,
    visualPrompt: card.visualPrompt,
    status: "idle"
  }));

const StatusPill = ({ status }: { status: OAuthStatus["status"] }) => {
  const ready = status === "ready";
  const label = ready ? "Codex 연결됨" : status === "auth_required" ? "로그인 확인 필요" : status === "starting" ? "연결 중" : "오프라인";
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-black ${ready ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
      {ready ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
      {label}
    </span>
  );
};

const App: React.FC = () => {
  const [health, setHealth] = useState<Health | null>(null);
  const [oauth, setOauth] = useState<OAuthStatus>({ status: "starting", models: [] });
  const [topic, setTopic] = useState(initialTopic);
  const [cardCount, setCardCount] = useState(6);
  const [tone, setTone] = useState<Tone>("clear");
  const [style, setStyle] = useState<VisualStyle>("serialized");
  const [quality, setQuality] = useState<"medium" | "high">("high");
  const [stage, setStage] = useState<Stage>("idle");
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [cards, setCards] = useState<ToonCard[]>([]);
  const [selectedCardId, setSelectedCardId] = useState<string>("");
  const [error, setError] = useState("");

  const selectedCard = useMemo(
    () => cards.find((card) => card.id === selectedCardId) || cards[0] || null,
    [cards, selectedCardId]
  );

  const ready = oauth.status === "ready";
  const completedCount = cards.filter((card) => card.status === "done").length;
  const progress = cards.length ? Math.round((completedCount / cards.length) * 100) : 0;

  const refreshStatus = useCallback(async () => {
    try {
      const [nextHealth, nextOauth] = await Promise.all([
        getJson<Health>("/api/health", { timeoutMs: 5000 }),
        getJson<OAuthStatus>("/api/oauth/status", { timeoutMs: 5000 })
      ]);
      setHealth(nextHealth);
      setOauth(nextOauth);
    } catch (e) {
      setOauth({ status: "offline", models: [] });
      setError(pickText(e));
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 15_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  const generatePlan = async () => {
    setError("");
    setStage("planning");
    setPlan(null);
    setCards([]);
    try {
      const response = await postJson<{ text?: string }>("/api/codex/generate-content", {
        model: health?.codex_text_model || "gpt-5.5",
        contents: { parts: [{ text: buildPlanPrompt({ topic, cardCount, tone, style }) }] },
        config: {
          systemInstruction:
            "You are a Korean instatoon creative director. Return concise production-ready JSON only.",
          responseMimeType: "application/json",
          responseJsonSchema: jsonSchema,
          reasoningEffort: "medium"
        }
      }, { timeoutMs: 10 * 60_000, retries: 1 });
      const nextPlan = parsePlan(response.text || "");
      const nextCards = makeCards({ ...nextPlan, cards: nextPlan.cards.slice(0, cardCount) });
      setPlan(nextPlan);
      setCards(nextCards);
      setSelectedCardId(nextCards[0]?.id || "");
      setStage("planned");
    } catch (e) {
      setError(pickText(e));
      setStage("error");
    }
  };

  const updateCard = (id: string, patch: Partial<ToonCard>) => {
    setCards((prev) => prev.map((card) => (card.id === id ? { ...card, ...patch } : card)));
  };

  const generateOneImage = async (card: ToonCard, activePlan: PlanResult) => {
    updateCard(card.id, { status: "generating", error: "" });
    try {
      const response = await postJson<{ image_data_url?: string }>("/api/codex/generate-image", {
        prompt: buildImagePrompt(card, activePlan, style),
        size: CARD_IMAGE_SIZE,
        quality,
        moderation: "low",
        model: health?.codex_image_model || "gpt-5.5"
      }, { timeoutMs: 10 * 60_000, retries: 1 });
      if (!response.image_data_url) throw new Error("이미지 데이터가 비어 있습니다.");
      updateCard(card.id, { status: "done", imageUrl: response.image_data_url });
    } catch (e) {
      updateCard(card.id, { status: "error", error: pickText(e) });
    }
  };

  const generateImages = async () => {
    if (!plan || cards.length === 0) return;
    setError("");
    setStage("generating");
    setCards((prev) => prev.map((card) => (card.status === "done" ? card : { ...card, status: "queued", error: "" })));

    let cursor = 0;
    const currentCards = cards.map((card) => ({ ...card, status: card.status === "done" ? card.status : "queued" as CardStatus }));
    const workers = Array.from({ length: Math.min(MAX_PARALLEL_IMAGES, currentCards.length) }, async () => {
      while (cursor < currentCards.length) {
        const card = currentCards[cursor];
        cursor += 1;
        if (card.status === "done") continue;
        await generateOneImage(card, plan);
      }
    });
    await Promise.all(workers);
    setStage("done");
  };

  const copyPrompt = async (card: ToonCard) => {
    if (!plan) return;
    await navigator.clipboard.writeText(buildImagePrompt(card, plan, style));
  };

  const downloadImage = (card: ToonCard) => {
    if (!card.imageUrl) return;
    const link = document.createElement("a");
    link.href = card.imageUrl;
    link.download = `instatoon-card-${String(card.index).padStart(2, "0")}.png`;
    link.click();
  };

  return (
    <main className="min-h-screen bg-[#f4f1ea] text-stone-950">
      <section className="border-b border-stone-950/10 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-5 px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-pink-600 text-white shadow-[4px_4px_0_#111]">
              <Sparkles size={22} />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-normal">InstaToon Studio</h1>
              <p className="text-sm font-bold text-stone-500">Codex-powered carousel comic workstation</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={oauth.status} />
            <button onClick={refreshStatus} className="inline-flex items-center gap-2 rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs font-black hover:bg-stone-50">
              <RefreshCw size={14} /> 상태
            </button>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-5 px-5 py-5 lg:grid-cols-[390px_1fr_360px]">
        <aside className="space-y-4">
          <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-black uppercase text-stone-500">Brief</h2>
              <span className="rounded-full bg-stone-100 px-2 py-1 text-[11px] font-black text-stone-600">{cardCount} cards</span>
            </div>
            <textarea
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              className="min-h-44 w-full resize-y rounded-xl border border-stone-200 bg-stone-50 p-3 text-sm font-bold leading-6 outline-none focus:border-pink-500 focus:bg-white"
            />
            <div className="mt-4 grid grid-cols-2 gap-3">
              <label className="text-xs font-black text-stone-500">
                카드 수
                <input
                  type="range"
                  min={3}
                  max={12}
                  value={cardCount}
                  onChange={(event) => setCardCount(Number(event.target.value))}
                  className="mt-2 w-full accent-pink-600"
                />
              </label>
              <label className="text-xs font-black text-stone-500">
                품질
                <select value={quality} onChange={(event) => setQuality(event.target.value as "medium" | "high")} className="mt-2 w-full rounded-xl border border-stone-200 bg-white p-2 text-sm text-stone-900">
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                </select>
              </label>
            </div>
          </div>

          <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
            <h2 className="mb-3 text-sm font-black uppercase text-stone-500">Direction</h2>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(toneLabels) as Tone[]).map((item) => (
                <button key={item} onClick={() => setTone(item)} className={`rounded-xl border px-3 py-2 text-sm font-black ${tone === item ? "border-pink-600 bg-pink-600 text-white" : "border-stone-200 bg-white hover:bg-stone-50"}`}>
                  {toneLabels[item]}
                </button>
              ))}
            </div>
            <div className="mt-4 grid gap-2">
              {(Object.keys(styleLabels) as VisualStyle[]).map((item) => (
                <button key={item} onClick={() => setStyle(item)} className={`rounded-xl border px-3 py-2 text-left text-sm font-black ${style === item ? "border-stone-950 bg-stone-950 text-white" : "border-stone-200 bg-white hover:bg-stone-50"}`}>
                  {styleLabels[item]}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={generatePlan}
            disabled={!ready || !topic.trim() || stage === "planning" || stage === "generating"}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-stone-950 px-4 py-4 text-sm font-black text-white shadow-[5px_5px_0_#db2777] disabled:cursor-not-allowed disabled:bg-stone-300 disabled:shadow-none"
          >
            {stage === "planning" ? <Loader2 className="animate-spin" size={18} /> : <Wand2 size={18} />}
            콘티 만들기
          </button>
        </aside>

        <section className="min-h-[680px] rounded-3xl border border-stone-200 bg-white p-4 shadow-sm">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-black">{plan?.title || "제작 보드"}</h2>
              <p className="text-sm font-bold text-stone-500">{plan?.thesis || "콘티를 만들면 카드가 여기에 정렬됩니다."}</p>
            </div>
            <button
              onClick={generateImages}
              disabled={!ready || !plan || cards.length === 0 || stage === "generating" || stage === "planning"}
              className="inline-flex items-center gap-2 rounded-2xl bg-pink-600 px-4 py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:bg-stone-300"
            >
              {stage === "generating" ? <Loader2 className="animate-spin" size={18} /> : <ImageIcon size={18} />}
              이미지 생성
            </button>
          </div>

          <div className="mb-4 h-2 overflow-hidden rounded-full bg-stone-100">
            <div className="h-full rounded-full bg-pink-600 transition-all" style={{ width: `${progress}%` }} />
          </div>

          {error ? (
            <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700">{error}</div>
          ) : null}

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {cards.length === 0 ? (
              <div className="col-span-full grid min-h-96 place-items-center rounded-2xl border border-dashed border-stone-300 bg-stone-50 text-center">
                <div>
                  <FileText className="mx-auto mb-3 text-stone-400" size={38} />
                  <p className="text-sm font-black text-stone-500">대기 중</p>
                </div>
              </div>
            ) : cards.map((card) => (
              <button
                key={card.id}
                onClick={() => setSelectedCardId(card.id)}
                className={`overflow-hidden rounded-2xl border text-left transition ${selectedCard?.id === card.id ? "border-pink-600 ring-4 ring-pink-100" : "border-stone-200 hover:border-stone-400"}`}
              >
                <div className="aspect-[4/5] bg-stone-100">
                  {card.imageUrl ? (
                    <img src={card.imageUrl} alt={card.headline} className="h-full w-full object-cover" />
                  ) : (
                    <div className="grid h-full place-items-center p-4 text-center">
                      {card.status === "generating" ? <Loader2 className="animate-spin text-pink-600" size={28} /> : <span className="text-xs font-black text-stone-400">CARD {card.index}</span>}
                    </div>
                  )}
                </div>
                <div className="p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="rounded-full bg-stone-100 px-2 py-1 text-[11px] font-black">#{card.index}</span>
                    <span className={`text-[11px] font-black ${card.status === "done" ? "text-emerald-600" : card.status === "error" ? "text-red-600" : "text-stone-500"}`}>{card.status}</span>
                  </div>
                  <p className="line-clamp-2 text-sm font-black">{card.headline}</p>
                </div>
              </button>
            ))}
          </div>
        </section>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
            <h2 className="mb-3 text-sm font-black uppercase text-stone-500">Selected Card</h2>
            {selectedCard ? (
              <div className="space-y-3">
                <p className="text-xl font-black">#{selectedCard.index} {selectedCard.headline}</p>
                <div className="rounded-xl bg-stone-50 p-3">
                  <p className="text-xs font-black uppercase text-stone-400">Scene</p>
                  <p className="mt-1 text-sm font-bold leading-6">{selectedCard.scene}</p>
                </div>
                <div className="rounded-xl bg-stone-50 p-3">
                  <p className="text-xs font-black uppercase text-stone-400">Dialogue</p>
                  <p className="mt-1 text-sm font-bold leading-6">{selectedCard.dialogue}</p>
                </div>
                <div className="rounded-xl bg-stone-50 p-3">
                  <p className="text-xs font-black uppercase text-stone-400">Caption</p>
                  <p className="mt-1 text-sm font-bold leading-6">{selectedCard.caption}</p>
                </div>
                {selectedCard.error ? <p className="rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700">{selectedCard.error}</p> : null}
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => void copyPrompt(selectedCard)} className="inline-flex items-center justify-center gap-2 rounded-xl border border-stone-200 px-3 py-2 text-xs font-black hover:bg-stone-50">
                    <Copy size={14} /> 프롬프트
                  </button>
                  <button onClick={() => downloadImage(selectedCard)} disabled={!selectedCard.imageUrl} className="inline-flex items-center justify-center gap-2 rounded-xl border border-stone-200 px-3 py-2 text-xs font-black hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40">
                    <Download size={14} /> PNG
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm font-bold text-stone-500">카드를 선택하세요.</p>
            )}
          </div>

          <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
            <h2 className="mb-3 text-sm font-black uppercase text-stone-500">System</h2>
            <dl className="space-y-2 text-sm font-bold">
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500">API</dt>
                <dd>{health ? "online" : "checking"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500">OAuth</dt>
                <dd>{oauth.status || "unknown"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500">Text</dt>
                <dd className="truncate">{health?.codex_text_model || "-"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500">Image</dt>
                <dd className="truncate">{health?.codex_image_model || "-"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500">Port</dt>
                <dd>{health?.codex_oauth_port || "-"}</dd>
              </div>
            </dl>
          </div>
        </aside>
      </section>
    </main>
  );
};

export default App;
