// Pure story/shot planning rules for the "story" route (AI-animated narrated shorts).
// No I/O here so the validator and prompts are unit-testable.

export const SCENE_SECONDS = 5; // one image-to-video generation per scene
export const SCENES = 4;
export const STORY_BUDGET_USD = 3;

/** Persisted user calibration. Bump `version` whenever rules change so feedback maps to a version. */
export const STORY_CALIBRATION = {
  version: "story-v2-2026-11-16",
  look: "GTA V gameplay screenshot look: third-person game camera, ordinary midday daylight, hard realistic shadows, game-engine materials, realistic adult proportions, Los Santos streets with palms and power lines",
  avoid: "glossy cinematic grading, neon, golden-hour gloss, toy/diorama/Pixar look, on-screen text, captions, watermarks, AI or 'inspired' labels, logos made up as text",
  allowed: "recognizable GTA V franchise elements (Los Santos, LSPD cruisers, Franklin-like protagonist, in-game vehicle styles) — always generated, never claimed as real game footage or textures",
  learned: [
    "Prior calibration (job a9f5a49a 'The garage was a mistake'): a clear cause→consequence story with a delayed payoff worked; narrator must be loud and dominant.",
    "User preferences: GTA V gameplay look with recognizable franchise elements; English narration; a meaningful causal hook and payoff; never burn an 'inspired'/AI label into the video.",
    "Rejected concepts: generic pigeon, fries/food-chase or shopping-cart gags and childish characters — never use them unless the request explicitly asks.",
    "Defects to prevent: hero car gaining a police light bar, door shown open after it closed, car changing model between shots, static shots with no subject motion.",
  ],
} as const;

export const COST_USD: Record<string, number> = {
  "fal-ai/kokoro/american-english": 0.01, "fal-ai/nano-banana": 0.04, "fal-ai/nano-banana/edit": 0.04,
  "fal-ai/kling-video/v2.5-turbo/pro/image-to-video": 0.35, "fal-ai/mmaudio-v2/text-to-audio": 0.01,
  "fal-ai/ffmpeg-api/metadata": 0.005, "fal-ai/ffmpeg-api/compose": 0.02, "fal-ai/workflow-utilities/scale-video": 0.02,
  "fal-ai/workflow-utilities/auto-subtitle": 0.03, "fal-ai/whisper": 0,
};
export const estimateCost = (model: string) => COST_USD[model] ?? 0.02;

export type State = Record<string, string>;
export type Scene = {
  purpose: string; where: string; who: string[]; action: string; camera: string;
  start_state: State; end_state: State; changes: { key: string; by: string }[];
  props: string; narration: string; narration_support: string[]; sound: string;
  sound_events: { t: number; event: string }[]; reveals_payoff: boolean;
};
export type Candidate = { id: string; synopsis: string; goal: string; obstacle: string; action: string; consequence: string; hook_promise: string; hook_visual: string; payoff: string; withheld: string; reason: string };
export type StoryPlan = {
  candidates: Candidate[]; selected_id: string; selection_reason: string; title: string; caption: string; hashtags: string[];
  anchors: Record<string, { id: string; description: string }>; scenes: Scene[]; payoff_terms: string[];
};

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

export function normalizePlan(raw: any): StoryPlan {
  const str = (v: unknown) => String(v ?? "").trim();
  const state = (v: any): State => Object.fromEntries(Object.entries(v && typeof v === "object" ? v : {}).map(([k, x]) => [str(k), norm(x)]));
  return {
    candidates: (Array.isArray(raw?.candidates) ? raw.candidates : []).map((c: any) => ({ id: str(c.id), synopsis: str(c.synopsis), goal: str(c.goal), obstacle: str(c.obstacle), action: str(c.action), consequence: str(c.consequence), hook_promise: str(c.hook_promise), hook_visual: str(c.hook_visual), payoff: str(c.payoff), withheld: str(c.withheld), reason: str(c.reason) })),
    selected_id: str(raw?.selected_id), selection_reason: str(raw?.selection_reason), title: str(raw?.title), caption: str(raw?.caption),
    hashtags: (Array.isArray(raw?.hashtags) ? raw.hashtags : []).map(str).slice(0, 6),
    anchors: Object.fromEntries(Object.entries(raw?.anchors && typeof raw.anchors === "object" ? raw.anchors : {}).filter(([, a]: any) => a && a.description).map(([k, a]: any) => [k, { id: str(a.id || k), description: str(a.description) }])),
    scenes: (Array.isArray(raw?.scenes) ? raw.scenes : []).map((s: any) => ({
      purpose: str(s.purpose), where: str(s.where), who: (Array.isArray(s.who) ? s.who : []).map(str), action: str(s.action), camera: str(s.camera),
      start_state: state(s.start_state), end_state: state(s.end_state),
      changes: (Array.isArray(s.changes) ? s.changes : []).map((c: any) => ({ key: str(c.key), by: str(c.by) })),
      props: str(s.props), narration: str(s.narration), narration_support: (Array.isArray(s.narration_support) ? s.narration_support : []).map(str),
      sound: str(s.sound), sound_events: (Array.isArray(s.sound_events) ? s.sound_events : []).map((e: any) => ({ t: Number(e.t) || 0, event: str(e.event) })),
      reveals_payoff: s.reveals_payoff === true,
    })),
    payoff_terms: (Array.isArray(raw?.payoff_terms) ? raw.payoff_terms : []).map(norm).filter(Boolean),
  };
}

/** Deterministic checks run BEFORE any paid generation. Returns human-readable issues (empty = valid). */
export function validatePlan(p: StoryPlan, opts: { allowNeon?: boolean } = {}): string[] {
  const issues: string[] = [];
  if (p.candidates.length < 2) issues.push("Need at least 2 story candidates to choose from.");
  const sel = p.candidates.find((c) => c.id === p.selected_id);
  if (!sel) issues.push("selected_id does not match a candidate.");
  else for (const f of ["goal", "obstacle", "action", "consequence", "hook_promise", "hook_visual", "payoff", "withheld"] as const)
    if (!sel[f]) issues.push(`Selected candidate is missing "${f}".`);
  if (!p.title) issues.push("Missing title.");
  if (p.scenes.length !== SCENES) { issues.push(`Need exactly ${SCENES} scenes, got ${p.scenes.length}.`); return issues; }
  const anchorIds = new Set(Object.keys(p.anchors));
  if (!anchorIds.size) issues.push("No continuity anchors (actor/outfit/vehicle/location).");
  const keys = new Set<string>();
  p.scenes.forEach((s) => { Object.keys(s.start_state).forEach((k) => keys.add(k)); Object.keys(s.end_state).forEach((k) => keys.add(k)); });
  p.scenes.forEach((s, i) => {
    const n = i + 1;
    if (!s.action) issues.push(`Scene ${n}: no action.`);
    const actionCount = s.action.split(/\bthen\b|;|,\s*and\b|\band then\b/i).filter((x) => x.trim()).length;
    if (actionCount > 2 || s.changes.length > 2) issues.push(`Scene ${n}: too many actions for ${SCENE_SECONDS}s — keep one clear physical action.`);
    for (const id of s.who) if (!anchorIds.has(id)) issues.push(`Scene ${n}: "${id}" is not a continuity anchor.`);
    for (const k of keys) {
      if (!(k in s.start_state) || !(k in s.end_state)) issues.push(`Scene ${n}: state "${k}" must be specified at start and end.`);
      const a = s.start_state[k], b = s.end_state[k];
      if (a !== undefined && b !== undefined && a !== b && !s.changes.some((c) => c.key === k && c.by))
        issues.push(`Scene ${n}: "${k}" changes ${a} → ${b} with no on-screen action causing it.`);
    }
    const prev = p.scenes[i - 1];
    if (prev) for (const k of keys) {
      const was = prev.end_state[k], now = s.start_state[k];
      if (was !== undefined && now !== undefined && was !== now) issues.push(`Scene ${n}: "${k}" jumps from ${was} to ${now} across the cut (contradiction).`);
    }
    if (s.narration) {
      if (!s.narration_support.length) issues.push(`Scene ${n}: narration is not tied to anything visible.`);
      for (const ref of s.narration_support) if (ref !== "action" && !(ref in s.start_state) && !(ref in s.end_state)) issues.push(`Scene ${n}: narration support "${ref}" is not shown in this scene.`);
    }
    const max = i === SCENES - 1 ? 8 : 12;
    if (words(s.narration) > max) issues.push(`Scene ${n}: narration too long (${words(s.narration)} words, max ${max}).`);
    if (i < SCENES - 1) {
      if (s.reveals_payoff) issues.push(`Scene ${n}: reveals the payoff before the final scene.`);
      const t = p.payoff_terms.find((w) => norm(s.narration).includes(w));
      if (t) issues.push(`Scene ${n}: narration says "${t}" which gives the payoff away early.`);
    } else if (!s.reveals_payoff) issues.push("Final scene must deliver the payoff.");
    if (!opts.allowNeon && /\bneon|pixar|toy|diorama|golden hour\b/i.test(`${s.where} ${s.camera} ${s.props}`)) issues.push(`Scene ${n}: style conflicts with calibration (no neon/toy/golden-hour gloss).`);
  });
  if (!p.payoff_terms.length) issues.push("payoff_terms must list words that would reveal the payoff.");
  return [...new Set(issues)];
}

export function planInstructions() {
  const c = STORY_CALIBRATION;
  return `You are a short-form story editor for 18-22s vertical videos made of ${SCENES} AI-animated shots of ${SCENE_SECONDS}s each with a narrator.
Invent 3 compact story candidates, then select the strongest by causality (goal → obstacle → action → consequence), a hook that is VISUALLY evident in the first 2 seconds, and a payoff that answers the hook and is withheld until the final scene. Comedy is optional; do not default to garages.
Visual calibration (${c.version}): ${c.look}. Avoid: ${c.avoid}. Allowed: ${c.allowed}.
Lessons: ${c.learned.join(" ")}
Shot rules: each scene = ONE clear physical action with substantial visible subject motion, filmable by an image-to-video model from one start frame. Specify full world state (same keys in every scene, short lowercase values, e.g. car: "outside at curb", door: "open") at start and end; any change needs a 'changes' entry naming the on-screen action. State must not jump across cuts. Narration lines are short spoken English (scenes 1-3 ≤12 words, final ≤8 words), each tied to visible state keys or "action". No text or labels inside frames. Never claim real gameplay.
Return JSON: {candidates:[{id,synopsis,goal,obstacle,action,consequence,hook_promise,hook_visual,payoff,withheld,reason}], selected_id, selection_reason, title, caption (<=150 chars), hashtags[], anchors:{actor:{id,description},outfit:{id,description},vehicle?:{id,description},location:{id,description}}, scenes:[{purpose,where,who:[anchor keys],action,camera,start_state,end_state,changes:[{key,by}],props,narration,narration_support:[keys or "action"],sound (sound effects only, no music/speech),sound_events:[{t,event}],reveals_payoff}], payoff_terms:[words that would spoil the payoff]}. Reasons must be brief statements, not deliberation.`;
}

export function anchorText(p: StoryPlan) {
  return Object.entries(p.anchors).map(([k, a]) => `${k} (${a.id}): ${a.description}`).join("; ");
}
const stateText = (s: State) => Object.entries(s).map(([k, v]) => `${k}: ${v}`).join(", ");

export function framePrompt(p: StoryPlan, i: number, first: boolean, compact = false) {
  const s = p.scenes[i]!;
  // Compact form after a no-output refusal: short, non-repetitive, no long anchor/negative lists.
  if (compact) return `Same person, outfit, vehicle and street as the reference image, new moment. ${s.where}. ${stateText(s.start_state)}. ${s.camera}. Third-person video game screenshot, ordinary daylight, vertical 9:16.`;
  const keep = first ? "" : "Keep EXACTLY the same person, outfit, vehicle model/colour/roof and location as the reference image. ";
  return `${keep}${STORY_CALIBRATION.look}. Vertical 9:16 frame. ${s.where}. Shows: ${s.who.map((w) => p.anchors[w]?.description ?? w).join("; ")}. Situation at the start of the shot: ${stateText(s.start_state)}. ${s.props ? "Props: " + s.props + ". " : ""}Camera: ${s.camera}. No text, no captions, no watermark, no labels.`;
}
export function shotPrompt(p: StoryPlan, i: number) {
  const s = p.scenes[i]!;
  return `${s.action}. Single continuous ${SCENE_SECONDS}-second shot, ${s.camera}, clear physical motion, game-engine realism in ordinary daylight. Ends with: ${stateText(s.end_state)}.`;
}
export const SHOT_NEGATIVE = "text, captions, watermark, logo text, morphing, extra limbs, warped car, light bar on civilian car, scene cut, blur, low quality, neon, toy";

export function qcChecks(p: StoryPlan, i: number, which: "start" | "end") {
  const s = p.scenes[i]!; const st = which === "start" ? s.start_state : s.end_state;
  return [...Object.entries(st).map(([k, v]) => `${k} is ${v}`), ...s.who.map((w) => `${w} matches: ${p.anchors[w]?.description ?? w}`), "no on-screen text, captions or watermark", "ordinary daylight game-like look (not neon, toy or glossy cinematic)"];
}

/** Narrator-first timing: where each line sits and whether it fits its scene. */
export function alignVoice(durations: number[]) {
  const lead = (i: number) => (i === 0 ? 0.1 : 0.25);
  const slots = durations.map((d, i) => {
    const start = i * SCENE_SECONDS + lead(i);
    const limit = i === SCENES - 1 ? 2.9 : SCENE_SECONDS - lead(i) - 0.15; // final line leaves ~2s of silent reveal
    return { scene: i, start, end: start + d, duration: d, fits: d > 0 && d <= limit, limit };
  });
  return { slots, ok: slots.length === SCENES && slots.every((s) => s.fits), total: SCENES * SCENE_SECONDS };
}
