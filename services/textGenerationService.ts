import { postJson } from "./localApi";

export const CODEX_TEXT_MODEL = "gpt-5.5";

const getCodexTextModel = (): string => {
  const preferred = (import.meta as any).env?.VITE_CODEX_TEXT_MODEL as unknown;
  if (typeof preferred === "string" && preferred.trim()) return preferred.trim();
  const nodePreferred = typeof process !== "undefined" ? process.env?.VITE_CODEX_TEXT_MODEL : undefined;
  if (typeof nodePreferred === "string" && nodePreferred.trim()) return nodePreferred.trim();
  const plannerModel = (import.meta as any).env?.VITE_CODEX_PLANNER_MODEL as unknown;
  if (typeof plannerModel === "string" && plannerModel.trim()) return plannerModel.trim();
  const nodePlannerModel = typeof process !== "undefined" ? process.env?.VITE_CODEX_PLANNER_MODEL : undefined;
  if (typeof nodePlannerModel === "string" && nodePlannerModel.trim()) return nodePlannerModel.trim();
  return CODEX_TEXT_MODEL;
};

const resolveCodexTextModel = (model: unknown): string => {
  const requested = typeof model === "string" ? model.trim() : "";
  return requested.startsWith("gpt-") ? requested : getCodexTextModel();
};

export const withCodexTextModel = (request: any): any => ({
  ...request,
  model: resolveCodexTextModel(request?.model)
});

export const generateCodexContent = async <T = any>(request: any): Promise<T> => {
  return await postJson<T>("/api/codex/generate-content", {
    request: withCodexTextModel(request)
  }, {
    timeoutMs: 8 * 60_000,
    retries: 0,
    retryDelayMs: 1500
  });
};

// Backward-compatible name for existing planner/research services.
export const generateGeminiContent = async <T = any>(request: any): Promise<T> => {
  return await generateCodexContent<T>(request);
};
