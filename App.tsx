import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  FileText,
  Image as ImageIcon,
  LayoutGrid,
  Loader2,
  PenLine,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Wand2
} from "lucide-react";

type Health = {
  app?: string;
  local_api?: string;
  oauth_port?: number;
  oauth_url?: string;
  text_model?: string;
  image_model?: string;
  image_size?: string;
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

const MAX_PARALLEL_IMAGES = 2;

const toneOptions: Array<{ value: Tone; label: string; hint: string }> = [
  { value: "clear", label: "명료하게", hint: "군더더기 없이 바로 이해" },
  { value: "warm", label: "다정하게", hint: "초보자도 편하게 읽힘" },
  { value: "sharp", label: "날카롭게", hint: "핵심 통찰을 먼저 제시" },
  { value: "funny", label: "가볍게", hint: "짧은 드립과 리듬감" }
];

const styleOptions: Array<{ value: VisualStyle; label: string; hint: string }> = [
  { value: "serialized", label: "연재형 웹툰", hint: "캐릭터와 컷 흐름 중심" },
  { value: "clean", label: "클린 카드툰", hint: "밝고 정돈된 설명형" },
  { value: "marker", label: "마커 노트", hint: "손그림 느낌의 교육형" },
  { value: "finance", label: "금융 해설", hint: "차트와 숫자를 깔끔하게" }
];

const statusLabels: Record<string, string> = {
  ready: "Codex 준비됨",
  auth_required: "로그인 필요",
  starting: "연결 확인 중",
  offline: "API 대기"
};

const cardStatusLabels: Record<CardStatus, string> = {
  idle: "대기",
  queued: "예약",
  generating: "제작 중",
  done: "완료",
  error: "오류"
};

const initialTopic =
  "청년이 경제 뉴스를 읽을 때 가장 먼저 봐야 할 3가지: 금리, 환율, 실적을 인스타툰으로 설명";

const pickText = (error: unknown) => {
  if (error instanceof Error) return error.message;
  return String(error || "알 수 없는 오류가 발생했어요.");
};

const requestJson = async <T,>(url: string, options: RequestInit = {}): Promise<T> => {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `요청 실패 (${response.status})`);
  return data as T;
};

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

const styleLabel = (value: VisualStyle) => styleOptions.find((item) => item.value === value)?.label || value;

const LogoMark = ({ compact = false }: { compact?: boolean }) => (
  <div className={compact ? "logo-mark logo-mark-sm" : "logo-mark"} aria-hidden="true">
    <svg viewBox="0 0 80 80" role="img">
      <rect x="9" y="13" width="46" height="58" rx="11" fill="#111111" />
      <rect x="21" y="8" width="48" height="58" rx="12" fill="#ff735c" stroke="#111111" strokeWidth="4" />
      <rect x="29" y="18" width="31" height="9" rx="4.5" fill="#ffffff" />
      <path d="M31 44c7-13 23-12 27 0 3 10-8 18-19 13" fill="none" stroke="#111111" strokeWidth="5" strokeLinecap="round" />
      <circle cx="33" cy="38" r="4" fill="#18a999" stroke="#111111" strokeWidth="3" />
      <path d="M55 9l3-7 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z" fill="#ffe15a" stroke="#111111" strokeWidth="3" />
    </svg>
  </div>
);

const StatusPill = ({ status }: { status: OAuthStatus["status"] }) => {
  const ready = status === "ready";
  const label = statusLabels[String(status || "offline")] || "상태 확인";
  return (
    <span className={`status-pill ${ready ? "status-pill-ready" : "status-pill-warn"}`}>
      {ready ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
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
  const [selectedCardId, setSelectedCardId] = useState("");
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
        requestJson<Health>("/api/health"),
        requestJson<OAuthStatus>("/api/oauth/status")
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
      const nextPlan = await requestJson<PlanResult>("/api/instatoon/plan", {
        method: "POST",
        body: JSON.stringify({ brief: topic, cardCount, tone, style })
      });
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
      const response = await requestJson<{ imageUrl?: string }>("/api/instatoon/image", {
        method: "POST",
        body: JSON.stringify({
          title: activePlan.title,
          thesis: activePlan.thesis,
          style,
          quality,
          card
        })
      });
      if (!response.imageUrl) throw new Error("이미지 데이터가 비어 있습니다.");
      updateCard(card.id, { status: "done", imageUrl: response.imageUrl });
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
    const currentCards = cards.map((card) => ({ ...card, status: card.status === "done" ? card.status : ("queued" as CardStatus) }));
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
    await navigator.clipboard.writeText(
      [
        `제목: ${plan.title}`,
        `카드 ${card.index}: ${card.headline}`,
        `장면: ${card.scene}`,
        `대사: ${card.dialogue}`,
        `캡션: ${card.caption}`,
        `비주얼: ${card.visualPrompt}`,
        `스타일: ${styleLabel(style)}`
      ].join("\n")
    );
  };

  const downloadImage = (card: ToonCard) => {
    if (!card.imageUrl) return;
    const link = document.createElement("a");
    link.href = card.imageUrl;
    link.download = `instatoon-card-${String(card.index).padStart(2, "0")}.png`;
    link.click();
  };

  return (
    <main className="app-shell min-h-screen text-[#191713]">
      <header className="topbar">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <LogoMark />
            <div>
              <p className="text-xs font-black uppercase text-[#ff5f4d]">Codex 제작실</p>
              <h1 className="text-2xl font-black tracking-normal sm:text-3xl">Auto InstaToon</h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={oauth.status} />
            <span className="soft-chip">
              <ImageIcon size={15} />
              {health?.image_size || "4:5"}
            </span>
            <button onClick={refreshStatus} className="icon-button" aria-label="연결 상태 새로고침">
              <RefreshCw size={16} />
            </button>
          </div>
        </div>
      </header>

      <section className="mx-auto grid max-w-[1500px] gap-5 px-5 py-5 xl:grid-cols-[380px_minmax(0,1fr)_360px]">
        <aside className="space-y-4">
          <section className="panel">
            <div className="section-title">
              <PenLine size={17} />
              <span>원고</span>
            </div>
            <textarea
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              className="brief-input"
              placeholder="무슨 내용을 인스타툰으로 만들지 적어주세요."
            />
            <div className="mt-4 grid grid-cols-[1fr_120px] gap-3">
              <label className="field-label">
                카드 수
                <div className="mt-2 flex items-center gap-3">
                  <input
                    type="range"
                    min={3}
                    max={12}
                    value={cardCount}
                    onChange={(event) => setCardCount(Number(event.target.value))}
                    className="w-full accent-[#ff5f4d]"
                  />
                  <strong className="counter-pill">{cardCount}</strong>
                </div>
              </label>
              <label className="field-label">
                품질
                <select value={quality} onChange={(event) => setQuality(event.target.value as "medium" | "high")} className="select-input">
                  <option value="high">높음</option>
                  <option value="medium">보통</option>
                </select>
              </label>
            </div>
          </section>

          <section className="panel">
            <div className="section-title">
              <SlidersHorizontal size={17} />
              <span>연출</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {toneOptions.map((item) => (
                <button key={item.value} onClick={() => setTone(item.value)} className={`choice ${tone === item.value ? "choice-active" : ""}`}>
                  <strong>{item.label}</strong>
                  <span>{item.hint}</span>
                </button>
              ))}
            </div>
            <div className="mt-4 grid gap-2">
              {styleOptions.map((item) => (
                <button key={item.value} onClick={() => setStyle(item.value)} className={`style-choice ${style === item.value ? "style-choice-active" : ""}`}>
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.hint}</small>
                  </span>
                  <CheckCircle2 size={17} />
                </button>
              ))}
            </div>
          </section>

          <button
            onClick={generatePlan}
            disabled={!ready || !topic.trim() || stage === "planning" || stage === "generating"}
            className="primary-action"
          >
            {stage === "planning" ? <Loader2 className="animate-spin" size={19} /> : <Wand2 size={19} />}
            카드 설계하기
          </button>
        </aside>

        <section className="workspace">
          <div className="workspace-head">
            <div>
              <div className="section-title mb-2">
                <LayoutGrid size={17} />
                <span>카드 보드</span>
              </div>
              <h2>{plan?.title || "아이디어를 인스타툰 카드로 정리합니다"}</h2>
              <p>{plan?.thesis || "왼쪽에 원고를 넣고 카드 설계를 누르면 카드별 장면, 대사, 캡션이 만들어집니다."}</p>
            </div>
            <button
              onClick={generateImages}
              disabled={!ready || !plan || cards.length === 0 || stage === "generating" || stage === "planning"}
              className="render-action"
            >
              {stage === "generating" ? <Loader2 className="animate-spin" size={18} /> : <Sparkles size={18} />}
              이미지 렌더
            </button>
          </div>

          <div className="progress-track" aria-label={`진행률 ${progress}%`}>
            <div style={{ width: `${progress}%` }} />
          </div>

          {error ? (
            <div className="error-box">
              <AlertTriangle size={18} />
              <span>{error}</span>
            </div>
          ) : null}

          <div className="cards-grid">
            {cards.length === 0 ? (
              <div className="empty-state">
                <LogoMark compact />
                <strong>아직 만든 카드가 없습니다</strong>
                <span>원고와 연출을 정한 뒤 카드 설계를 시작하세요.</span>
              </div>
            ) : (
              cards.map((card) => (
                <button
                  key={card.id}
                  onClick={() => setSelectedCardId(card.id)}
                  className={`toon-card ${selectedCard?.id === card.id ? "toon-card-selected" : ""}`}
                >
                  <div className="card-canvas">
                    {card.imageUrl ? (
                      <img src={card.imageUrl} alt={card.headline} />
                    ) : (
                      <div className="card-placeholder">
                        {card.status === "generating" ? (
                          <Loader2 className="animate-spin text-[#ff5f4d]" size={30} />
                        ) : (
                          <>
                            <span>#{String(card.index).padStart(2, "0")}</span>
                            <small>{cardStatusLabels[card.status]}</small>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="card-copy">
                    <div>
                      <span>카드 {card.index}</span>
                      <em className={card.status === "done" ? "done" : card.status === "error" ? "bad" : ""}>
                        {cardStatusLabels[card.status]}
                      </em>
                    </div>
                    <strong>{card.headline}</strong>
                  </div>
                </button>
              ))
            )}
          </div>
        </section>

        <aside className="space-y-4">
          <section className="panel">
            <div className="section-title">
              <FileText size={17} />
              <span>카드 상세</span>
            </div>
            {selectedCard ? (
              <div className="detail-stack">
                <h3>
                  <span>#{selectedCard.index}</span>
                  {selectedCard.headline}
                </h3>
                <div className="detail-block">
                  <span>장면</span>
                  <p>{selectedCard.scene}</p>
                </div>
                <div className="detail-block">
                  <span>대사</span>
                  <p>{selectedCard.dialogue}</p>
                </div>
                <div className="detail-block">
                  <span>캡션</span>
                  <p>{selectedCard.caption}</p>
                </div>
                {selectedCard.error ? <div className="mini-error">{selectedCard.error}</div> : null}
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => void copyPrompt(selectedCard)} className="secondary-action">
                    <Copy size={15} />
                    복사
                  </button>
                  <button onClick={() => downloadImage(selectedCard)} disabled={!selectedCard.imageUrl} className="secondary-action">
                    <Download size={15} />
                    저장
                  </button>
                </div>
              </div>
            ) : (
              <p className="muted-copy">카드를 만들면 상세 내용이 여기에 표시됩니다.</p>
            )}
          </section>

          <section className="panel">
            <div className="section-title">
              <ShieldCheck size={17} />
              <span>연결 상태</span>
            </div>
            <dl className="system-list">
              <div>
                <dt>로컬 API</dt>
                <dd>{health ? "정상" : "확인 중"}</dd>
              </div>
              <div>
                <dt>Codex</dt>
                <dd>{statusLabels[String(oauth.status || "offline")] || "확인 중"}</dd>
              </div>
              <div>
                <dt>텍스트 모델</dt>
                <dd>{health?.text_model || "-"}</dd>
              </div>
              <div>
                <dt>이미지 모델</dt>
                <dd>{health?.image_model || "-"}</dd>
              </div>
              <div>
                <dt>OAuth 포트</dt>
                <dd>{health?.oauth_port || "-"}</dd>
              </div>
            </dl>
          </section>
        </aside>
      </section>
    </main>
  );
};

export default App;
