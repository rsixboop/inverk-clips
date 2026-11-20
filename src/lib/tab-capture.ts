// "Следить и клипать вкладку": Chrome tab-only capture (getDisplayMedia, video + tab audio) into a rolling
// fragmented-MP4 buffer; deduped live_highlights of one monitor are cut (20 s before / 15 s after) and
// uploaded as real MP4s. Module singleton so capture survives in-app navigation; timers run in a Worker
// so a background tab is not throttled. Browser-only: every entry point is called from handlers/effects.
import { supabase } from "@/integrations/supabase/client";
import { Fmp4Buffer, clipWindow } from "@/lib/fmp4-cut";

export type ClipLog = { id: string; at: number; text: string; ok: boolean };
export type CaptureState = {
  phase: "idle" | "picking" | "capturing" | "stopped" | "error";
  monitorId: string | null; message: string; warnings: string[];
  audioTrack: string | null; audioLevel: number; audioHeardAt: number | null;
  bufferedS: number; bufferMB: number; keyframes: number; startedAt: number | null; mime: string; surface: string; hidden: boolean;
  log: ClipLog[];
};
const KEY = "inverk-tab-capture";
const KEEP_S = 150, MIME = ["video/mp4;codecs=avc1.42E01F,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4;codecs=avc1,opus", "video/mp4;codecs=vp9,opus"];
let state: CaptureState = { phase: "idle", monitorId: null, message: "", warnings: [], audioTrack: null, audioLevel: 0, audioHeardAt: null, bufferedS: 0, bufferMB: 0, keyframes: 0, startedAt: null, mime: "", surface: "", hidden: false, log: [] };
const subs = new Set<() => void>();
const set = (p: Partial<CaptureState>) => { state = { ...state, ...p }; subs.forEach((f) => f()); };
export const subscribe = (f: () => void) => { subs.add(f); return () => subs.delete(f); };
export const getState = () => state;
export const getServerState = () => state;

let stream: MediaStream | null = null, rec: MediaRecorder | null = null, buf: Fmp4Buffer | null = null, wallStart = 0, delayS = 0;
let audioCtx: AudioContext | null = null, analyser: AnalyserNode | null = null, timer: Worker | null = null, busy = false;
const tried = new Set<string>();
type Api = { claim: (id: string) => Promise<any>; finish: (d: any) => Promise<any> };
let api: Api | null = null;

function warn(w: string) { if (!state.warnings.includes(w)) set({ warnings: [...state.warnings, w] }); }
function addLog(id: string, text: string, ok: boolean) { set({ log: [{ id, at: Date.now(), text, ok }, ...state.log].slice(0, 30) }); }

/** Called once from an effect: reports a capture that died with the page (reload or tab discard). */
export function initCaptureWatch() {
  if (typeof window === "undefined") return;
  try {
    const prev = localStorage.getItem(KEY);
    if (prev && state.phase === "idle") {
      const discarded = (document as any).wasDiscarded === true;
      set({ phase: "stopped", message: discarded ? "Захват прервался: Chrome выгрузил вкладку приложения из памяти (tab discarded). Буфер потерян — запустите заново." : "Захват прервался: страница приложения была перезагружена или закрыта. Буфер потерян — запустите заново." });
      localStorage.removeItem(KEY);
    }
  } catch { /* storage blocked */ }
  document.addEventListener("visibilitychange", () => { if (state.phase === "capturing") set({ hidden: document.hidden }); });
  document.addEventListener("resume", () => { if (state.phase === "capturing") warn("Chrome замораживал эту вкладку — часть буфера могла пропасть"); });
}

export async function startTabCapture(monitorId: string, opts: { delayS: number; api: Api }) {
  if (state.phase === "capturing" || state.phase === "picking") throw new Error("Захват уже идёт");
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Браузер не поддерживает захват вкладки — нужен Chrome на компьютере");
  const mime = MIME.find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error("Этот браузер не умеет писать MP4 — нужен Chrome 126 или новее");
  api = opts.api; delayS = opts.delayS; tried.clear();
  set({ phase: "picking", monitorId, message: "Выберите вкладку с эфиром и включите «Поделиться звуком вкладки»", warnings: [], log: [], bufferedS: 0, bufferMB: 0, keyframes: 0, audioTrack: null, audioHeardAt: null });
  let s: MediaStream;
  try {
    s = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser", frameRate: 30, width: { max: 1920 }, height: { max: 1080 } } as MediaTrackConstraints,
      audio: { suppressLocalAudioPlayback: false } as MediaTrackConstraints,
      preferCurrentTab: false, selfBrowserSurface: "exclude", surfaceSwitching: "include", systemAudio: "exclude", monitorTypeSurfaces: "exclude",
    } as DisplayMediaStreamOptions);
  } catch (e) {
    set({ phase: "error", message: (e as Error).name === "NotAllowedError" ? "Выбор вкладки отменён" : `Захват не начался: ${(e as Error).message}` });
    return;
  }
  const v = s.getVideoTracks()[0]; const a = s.getAudioTracks()[0];
  const surface = (v?.getSettings() as any)?.displaySurface ?? "unknown";
  const fail = (msg: string) => { s.getTracks().forEach((t) => t.stop()); set({ phase: "error", message: msg }); };
  if (surface !== "browser") return fail(`Выбрано «${surface === "monitor" ? "весь экран" : surface === "window" ? "окно" : surface}». Разрешена только вкладка Chrome — запустите снова и выберите вкладку.`);
  if (!a) return fail("Нет звука вкладки: в окне выбора включите «Также поделиться звуком вкладки». Без оригинального звука клипы не делаются.");
  stream = s; buf = new Fmp4Buffer();
  audioCtx = new AudioContext(); analyser = audioCtx.createAnalyser(); analyser.fftSize = 2048;
  audioCtx.createMediaStreamSource(new MediaStream([a])).connect(analyser); // analysis only, not routed to speakers
  v!.addEventListener("ended", () => stopTabCapture("Захват остановлен: доступ к вкладке закрыт (кнопка Chrome «Остановить доступ» или вкладка закрыта)."));
  a.addEventListener("ended", () => { warn("Звуковая дорожка вкладки завершилась — новые клипы будут без звука и не будут приняты"); });
  a.addEventListener("mute", () => warn("Звук вкладки приостановлен браузером"));
  rec = new MediaRecorder(s, { mimeType: mime, videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 128_000, videoKeyFrameIntervalDuration: 2000 } as MediaRecorderOptions);
  rec.ondataavailable = async (e) => { if (!e.data.size || !buf) return; try { buf.push(new Uint8Array(await e.data.arrayBuffer())); } catch (err) { stopTabCapture(`Буфер повреждён: ${(err as Error).message}`); } };
  rec.onerror = () => stopTabCapture("Запись вкладки прервана ошибкой браузера");
  rec.onstart = () => { wallStart = Date.now(); };
  wallStart = Date.now(); rec.start(1000);
  set({ phase: "capturing", message: "Идёт захват вкладки", audioTrack: a.label || "звук вкладки", startedAt: Date.now(), mime, surface, hidden: document.hidden });
  if (!mime.includes("mp4a")) warn(`Браузер пишет MP4 как ${mime.split("=")[1]} (не H.264+AAC): играет в браузерах, но для TikTok может понадобиться перекодирование`);
  try { localStorage.setItem(KEY, JSON.stringify({ monitorId, at: Date.now() })); } catch { /* ignore */ }
  timer = new Worker(URL.createObjectURL(new Blob(["setInterval(()=>postMessage(0),2000)"], { type: "text/javascript" })));
  timer.onmessage = () => { void tickCapture(); };
}

export function stopTabCapture(reason = "Захват остановлен пользователем") {
  try { if (rec && rec.state !== "inactive") rec.stop(); } catch { /* stopped */ }
  stream?.getTracks().forEach((t) => t.stop()); timer?.terminate(); void audioCtx?.close();
  stream = null; rec = null; timer = null; audioCtx = null; analyser = null; buf = null;
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  if (state.phase === "capturing" || state.phase === "picking") set({ phase: "stopped", message: reason, bufferedS: 0, bufferMB: 0 });
}

function measureAudio() {
  if (!analyser) return;
  const d = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(d);
  let sum = 0; for (const x of d) sum += x * x; const rms = Math.sqrt(sum / d.length);
  set({ audioLevel: rms, ...(rms > 0.003 ? { audioHeardAt: Date.now() } : {}) });
}

async function tickCapture() {
  if (!buf || state.phase !== "capturing") return;
  measureAudio();
  buf.prune(KEEP_S);
  const keyframes = buf.frags.filter((f) => f.key).length;
  set({ bufferedS: Math.max(0, buf.bufferedTo - buf.bufferedFrom), bufferMB: buf.bytes() / 1048576, keyframes });
  if (buf.bufferedTo > 30 && keyframes < 2) warn("Браузер не ставит ключевые кадры — точная нарезка невозможна");
  if (busy || !api || !state.monitorId) return;
  busy = true;
  try {
    const { data } = await supabase.from("live_highlights").select("id,start_at,end_at,status").eq("monitor_id", state.monitorId).in("status", ["timestamp_only", "awaiting_media"])
      .gte("end_at", new Date((state.startedAt ?? Date.now()) - 60_000).toISOString()).order("start_at").limit(10);
    for (const h of data ?? []) { if (!tried.has(h.id) && buf) await exportOne(h); }
  } catch (e) { warn(`Не удалось получить хайлайты: ${(e as Error).message}`); }
  finally { busy = false; }
}

async function exportOne(h: { id: string; start_at: string; end_at: string }) {
  if (!buf || !api) return;
  const w = clipWindow(Date.parse(h.start_at), Date.parse(h.end_at), delayS);
  const from = (w.from - wallStart) / 1000, to = (w.to - wallStart) / 1000;
  if (to <= buf.bufferedFrom + 5) { tried.add(h.id); addLog(h.id, "момент раньше начала буфера — клип невозможен", false); return; }
  if (buf.bufferedTo < to) return; // wait until 15 s after the spike are buffered
  const cut = buf.cut(from, to);
  if (!cut) return;
  tried.add(h.id);
  const c = await api.claim(h.id);
  if (c.skip) { addLog(h.id, `уже обработан (${c.skip})`, true); return; }
  const fail = (error: string, final = false) => api!.finish({ data: { id: h.id, claim: c.claim, ok: false, prev: c.prev, error, final } }).catch(() => {});
  if (!state.audioHeardAt || Date.now() - state.audioHeardAt > (to - from + 10) * 1000) warn("За время клипа звук вкладки был тихим — проверьте, что в эфире есть звук");
  const up = await supabase.storage.from("outputs").uploadToSignedUrl(c.path, c.token, new Blob([cut.bytes as BlobPart], { type: "video/mp4" }), { contentType: "video/mp4", upsert: true });
  if (up.error) { await fail(`загрузка не удалась: ${up.error.message}`); tried.delete(h.id); addLog(h.id, `загрузка не удалась, повтор: ${up.error.message}`, false); return; }
  try {
    await api.finish({ data: { id: h.id, claim: c.claim, ok: true, prev: c.prev, duration_s: cut.end - cut.start } });
    addLog(h.id, `MP4 ${(cut.end - cut.start).toFixed(1)} с, ${(cut.bytes.byteLength / 1048576).toFixed(1)} МБ${cut.preRollShort ? " (до всплеска меньше 20 с — буфер начался позже)" : ""}`, true);
  } catch (e) { await fail((e as Error).message, true); addLog(h.id, (e as Error).message, false); }
}
