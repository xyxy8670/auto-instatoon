import { PageSpec, SeriesSpec } from "../types";

const normalizeLine = (value: string): string => {
  return String(value || "").replace(/\s+/g, " ").trim();
};

const resolveDefaultSpeaker = (series: SeriesSpec): string => {
  const cast = Array.isArray(series.anchors.cast) ? series.anchors.cast : [];
  const protagonist = cast.find((c) => c?.role === "protagonist");
  const castName = normalizeLine(String(protagonist?.name || ""));
  if (castName) return castName;
  return "main character";
};

const resolveToneByMood = (mood: string): string => {
  const m = String(mood || "").toLowerCase();
  if (!m) return "natural";
  if (/긴장|tense|suspense|urgent|압박|불안/.test(m)) return "tense, restrained";
  if (/차분|calm|soft|gentle|고요/.test(m)) return "calm, intimate";
  if (/슬픔|sad|grief|상실/.test(m)) return "sad, quiet";
  if (/분노|anger|furious|격앙/.test(m)) return "angry, controlled";
  if (/기쁨|happy|joy|bright|희망/.test(m)) return "bright, warm";
  return "natural";
};

const parseDialogueLine = (
  line: string,
  defaultSpeaker: string
): { speaker: string; text: string } | null => {
  const raw = normalizeLine(line);
  if (!raw) return null;
  const matched = raw.match(/^([^:：]{1,40})[:：]\s*(.+)$/);
  if (matched) {
    const speaker = normalizeLine(matched[1]) || defaultSpeaker;
    const text = normalizeLine(matched[2]);
    if (!text) return null;
    return { speaker, text };
  }
  return { speaker: defaultSpeaker, text: raw };
};

const buildDialogueBlock = (series: SeriesSpec, page: PageSpec): string => {
  const panel = page.panels[0];
  const defaultSpeaker = resolveDefaultSpeaker(series);
  const moodTone = resolveToneByMood(String(panel?.mood || ""));
  const dialogueLines = Array.isArray(panel?.dialogues) ? panel.dialogues : [];
  const normalizedDialogues = dialogueLines
    .map((line) => parseDialogueLine(line, defaultSpeaker))
    .filter((v): v is { speaker: string; text: string } => Boolean(v))
    .slice(0, 2);

  if (normalizedDialogues.length === 0) {
    return "No spoken dialogue. Use only subtle ambient sound and natural movement.";
  }

  return normalizedDialogues
    .map((item, index) => {
      const label = normalizedDialogues.length === 1 ? "Dialogue" : `Dialogue ${index + 1}`;
      return `${label}: ${item.speaker} says in Korean with a ${moodTone} tone: "${item.text}"`;
    })
    .join("\n");
};

export const buildSeedanceRunwayPromptPack = (input: {
  series: SeriesSpec;
  page: PageSpec;
}): { prompt: string; runwayHint: string; checklist: string } => {
  const { series, page } = input;
  const panel = page.panels[0];
  const aspectRatio = series.constraints?.i2v_aspect_ratio || "16:9";
  const dialogueBlock = buildDialogueBlock(series, page);

  const scene = normalizeLine(String(panel?.scene || "")) || "Continue the current scene from the uploaded frame.";
  const acting = normalizeLine(String(panel?.acting || "")) || "Subtle realistic performance with natural facial expression and body motion.";
  const camera = normalizeLine(String(panel?.camera || "")) || "Stable cinematic camera, slow push-in, shallow depth of field.";
  const mood = normalizeLine(String(panel?.mood || "")) || "Natural cinematic lighting and coherent atmosphere.";
  const startPose = normalizeLine(String(panel?.start_pose || "")) || normalizeLine(String(panel?.acting || "")) || "Preserve the exact first-frame pose.";
  const motion = normalizeLine(String(panel?.motion_continuation || "")) || "Continue naturally from the first-frame pose with smooth micro-motion.";
  const continuityIn = normalizeLine(String(panel?.i2v_continuity_in || "")) || "Use the uploaded image as the exact inherited starting state.";
  const continuityOut =
    normalizeLine(String(panel?.i2v_continuity_out || "")) ||
    normalizeLine(String(panel?.motion_continuation || "")) ||
    "End with a clear pose, gaze direction, object position, emotional state, and camera direction for the next clip.";

  const prompt = [
    "Use Image 1 as the first frame and main visual reference. Preserve the character identity, outfit, background, composition, and color palette from Image 1.",
    "Generate one coherent Seedance 2.0 video clip for Runway. Treat this as a connected shot in a longer sequence, not a standalone random scene.",
    "",
    "Reference roles:",
    "- Image 1: first frame, character identity, outfit, environment, composition, and color palette.",
    "- If an extra image is uploaded, use it only as a secondary style or environment reference when explicitly named.",
    "- If an extra video is uploaded, use it only for camera movement, pacing, or motion rhythm; do not copy its subject unless explicitly requested.",
    "",
    "Timeline:",
    `0-2s: Start from the uploaded frame. ${continuityIn} First-frame pose: ${startPose}`,
    `2-4s: ${scene} ${acting}`,
    `4-5s: ${motion} Finish with continuity-out state: ${continuityOut}`,
    "",
    "Camera / visual direction:",
    `${camera}`,
    `${mood}`,
    "Smooth natural motion, realistic physics, stable anatomy, coherent hands and face, consistent clothing details, no sudden scene reset.",
    "",
    "Audio / speech direction:",
    dialogueBlock,
    "Speech only if dialogue is listed. Do not render subtitles, captions, speech bubbles, or visible UI text.",
    "",
    "Safety / moderation context:",
    "Original characters only. Avoid public figures, copyrighted characters, brand logos, real-person likeness requests, minors in sensitive contexts, graphic violence, and sexualized framing."
  ].join("\n");

  const runwayHint = [
    "Runway Seedance 2.0 recommended workflow:",
    "1) Mode: Start / End frames for exact first-frame control, or References if you add multiple assets.",
    "2) Upload this page image as Image 1.",
    `3) Aspect Ratio: ${aspectRatio}.`,
    "4) First pass: 720p Explore Mode, 5s duration, to test motion cheaply.",
    "5) If the motion works: rerun as 10-15s or switch to 1080p Credits Mode only for final candidates.",
    "6) If moderation blocks it, change the prompt or input image before retrying. Do not repeatedly rerun the same blocked input."
  ].join("\n");

  const checklist = [
    "Seedance prompt checklist:",
    "- Asset jobs are explicit: Image 1 first frame; extra assets have narrow roles.",
    "- One clip has one main action; avoid stacking too many events.",
    "- Timeline is short and physical, not a vague story paragraph.",
    "- Positive wording is used: stable anatomy, natural hand motion, coherent details.",
    "- No on-screen Korean text/subtitles unless you intentionally want text rendered.",
    "- For long videos, chain clips by using the previous final frame as the next Image 1."
  ].join("\n");

  return {
    prompt,
    runwayHint,
    checklist
  };
};
