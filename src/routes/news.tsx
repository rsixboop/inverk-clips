import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { pollNewsVoice, submitNewsVoice } from "@/lib/news-voice.functions";
import { AppShell } from "@/components/studio/AppShell";
import { CATALOG, findAsset, pickAssets } from "@/lib/news-catalog";
import { MEDIA_LIBRARY, NEWS_SOURCE, PILOT, pilotValid, totalSeconds, type Shot } from "@/lib/news-pilot";

export const Route = createFileRoute("/news")({
  head: () => ({ meta: [
    { title: "GTA VI News — Inverk Clips" }, { name: "description", content: "Редактор новостного ролика по официальным материалам Rockstar." },
    { property: "og:title", content: "GTA VI News — Inverk Clips" }, { property: "og:description", content: "Раскадровка из своих файлов и официального источника." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: () => <AppShell>{() => <News />}</AppShell>,
});

type Media = { url: string; video: boolean; name: string; state: "loading" | "ok" | "error"; err?: string | undefined } | null;
const W = 1080, H = 1920;

function wrap(ctx: CanvasRenderingContext2D, text: string, max: number) {
  const out: string[] = []; let line = "";
  for (const w of text.split(" ")) { const t = line ? line + " " + w : w; if (ctx.measureText(t).width > max && line) { out.push(line); line = w; } else line = t; }
  return [...out, line];
}

function News() {
  const [shots, setShots] = useState<Shot[]>(PILOT);
  const [media, setMedia] = useState<Media[]>(() => pickAssets(PILOT).map((id) => { const a = findAsset(id); return a ? { url: `/api/rockstar-media/${a.id}`, video: false, name: `Rockstar: ${a.title}`, state: "loading" } : null; }));
  const [allowed, setAllowed] = useState(false);
  const [status, setStatus] = useState("");
  const [out, setOut] = useState<{ url: string; ext: string } | null>(null);
  const [voice, setVoice] = useState<{ url: string; name: string } | null>(null);
  const audio = useRef<{ el: HTMLAudioElement; ctx: AudioContext; dest: MediaStreamAudioDestinationNode } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const els = useRef<(HTMLImageElement | HTMLVideoElement | null)[]>([]);
  const [tts, setTts] = useState<{ busy: boolean; msg: string }>({ busy: false, msg: "" });
  const submitFn = useServerFn(submitNewsVoice), pollFn = useServerFn(pollNewsVoice);
  async function genVoice() {
    const text = shots.map((s) => s.text).join(" ");
    let h = 0; for (const c of text) h = (h * 31 + c.charCodeAt(0)) | 0;
    const key = `news-tts:${h}`;
    setTts({ busy: true, msg: "" });
    let id = localStorage.getItem(key);
    if (id === "pending") { setTts({ busy: false, msg: "Прошлая отправка этого текста завершилась с неизвестным исходом — повтор заблокирован, чтобы не платить дважды. Проверьте fal или измените текст." }); return; }
    try {
      if (!id) {
        localStorage.setItem(key, "pending");
        try { id = (await submitFn({ data: { text } })).requestId; }
        catch (e) { if (e instanceof Error && /не настроен|Unauthorized|validation/i.test(e.message)) localStorage.removeItem(key); throw e; }
        localStorage.setItem(key, id);
      }
      for (let i = 0; i < 60; i++) {
        setTts({ busy: true, msg: `Ожидание fal, запрос ${id}…` });
        const r = await pollFn({ data: { requestId: id } });
        if (r.state === "done" && r.url) { const resp = await fetch(r.url); if (!resp.ok) throw new Error(`Не удалось получить готовую озвучку: HTTP ${resp.status}`); const blob = await resp.blob(); if (!blob.size || blob.size > 10 * 1024 * 1024) throw new Error("Некорректный размер аудио"); setVoice({ url: URL.createObjectURL(blob), name: `fal Kokoro (${id})` }); setTts({ busy: false, msg: `Озвучка готова, запрос ${id}` }); return; }
        await new Promise((res) => setTimeout(res, 3000));
      }
      setTts({ busy: false, msg: `fal ещё не ответил (запрос ${id}). Нажмите снова — будет только проверка, без новой оплаты.` });
    } catch (e) { setTts({ busy: false, msg: `Ошибка${id && id !== "pending" ? ` (запрос ${id})` : ""}: ${e instanceof Error ? e.message : String(e)}` }); }
  }
  const ready = allowed && media.every((m) => m?.state === "ok") && pilotValid(shots);

  useEffect(() => { els.current = media.map((m) => { if (!m) return null;
    if (m.video) { const v = document.createElement("video"); v.src = m.url; v.muted = true; v.playsInline = true; return v; }
    const i = new Image(); i.src = m.url; return i; }); }, [media.map((m) => m?.url).join("|")]);
  const setState = (url: string, state: "ok" | "error", err?: string) => setMedia((ms) => ms.map((x) => (x && x.url === url && x.state === "loading" ? { ...x, state, err } : x)));
  useEffect(() => { media.forEach((m) => { if (!m || m.state !== "loading") return;
    if (m.url.startsWith("blob:")) { setState(m.url, "ok"); return; }
    fetch(m.url).then(async (r) => { if (!r.ok) setState(m.url, "error", await r.text()); else { const i = new Image(); i.onload = () => setState(m.url, "ok"); i.onerror = () => setState(m.url, "error", "не декодируется"); i.src = m.url; } })
      .catch(() => setState(m.url, "error", "сеть")); }); }, [media]);
  const autoPick = () => setMedia((m) => pickAssets(shots).map((id, k) => { const a = findAsset(id); return a ? { url: `/api/rockstar-media/${a.id}`, video: false, name: `Rockstar: ${a.title}`, state: "loading" } : m[k] ?? null; }));
  const pickCatalog = (i: number, id: string) => { const a = findAsset(id); if (a) setMedia((m) => m.map((x, k) => (k === i ? { url: `/api/rockstar-media/${a.id}`, video: false, name: `Rockstar: ${a.title}`, state: "loading" } : x))); };

  function draw(i: number) {
    const ctx = canvas.current!.getContext("2d")!, el = els.current[i];
    ctx.fillStyle = "#111"; ctx.fillRect(0, 0, W, H);
    if (el) { const sw = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth, sh = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
      if (sw && sh) { const s = Math.max(W / sw, H / sh); ctx.drawImage(el, (W - sw * s) / 2, (H - sh * s) / 2, sw * s, sh * s); } }
    ctx.font = "bold 64px sans-serif"; ctx.textAlign = "center";
    const lines = wrap(ctx, shots[i]!.text, W - 160), y0 = H - 520;
    ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(60, y0 - 80, W - 120, lines.length * 80 + 60);
    ctx.fillStyle = "#fff"; lines.forEach((l, k) => ctx.fillText(l, W / 2, y0 + k * 80));
    ctx.font = "32px sans-serif"; ctx.fillText("Source: Rockstar Newswire", W / 2, H - 140);
  }

  function voiceNode() {
    if (!voice) return null;
    if (!audio.current) {
      const el = new Audio(); el.crossOrigin = "anonymous"; const ctx = new AudioContext(); const src = ctx.createMediaElementSource(el); const dest = ctx.createMediaStreamDestination();
      src.connect(dest); src.connect(ctx.destination); audio.current = { el, ctx, dest };
    }
    if (audio.current.el.src !== voice.url) audio.current.el.src = voice.url;
    return audio.current;
  }

  async function play(record: boolean) {
    setOut(null);
    const a = voiceNode();
    if (a) { await a.ctx.resume(); a.el.currentTime = 0; }
    let rec: MediaRecorder | null = null; const chunks: Blob[] = [];
    let type = "";
    if (record) {
      type = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
      if (!type) { setStatus("Браузер не умеет записывать видео — экспорт недоступен."); return; }
      const stream = canvas.current!.captureStream(30);
      if (a) a.dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
      rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8e6 });
      rec.ondataavailable = (e) => chunks.push(e.data); rec.start();
    }
    if (a) await a.el.play().catch(() => setStatus("Не удалось воспроизвести озвучку"));
    for (let i = 0; i < shots.length; i++) {
      setStatus(`${record ? "Запись" : "Предпросмотр"}: шот ${i + 1}/4`);
      const el = els.current[i]; if (el instanceof HTMLVideoElement) { el.currentTime = 0; await el.play().catch(() => {}); }
      const end = performance.now() + shots[i]!.seconds * 1000;
      while (performance.now() < end) { draw(i); await new Promise((r) => requestAnimationFrame(r)); }
      if (el instanceof HTMLVideoElement) el.pause();
    }
    if (a) a.el.pause();
    if (rec) { await new Promise<void>((r) => { rec!.onstop = () => r(); rec!.stop(); });
      const ext = type.includes("mp4") ? "mp4" : "webm";
      setOut({ url: URL.createObjectURL(new Blob(chunks, { type })), ext });
      const snd = a ? "с озвучкой" : "без звука";
      setStatus(ext === "mp4" ? `Готово: MP4 ${snd}.` : `Готово: WebM ${snd} (этот браузер не записывает MP4).`);
    } else setStatus("Предпросмотр завершён.");
  }

  const upd = (i: number, p: Partial<Shot>) => setShots((s) => s.map((x, k) => (k === i ? { ...x, ...p } : x)));
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <div className="panel p-4 space-y-3">
        <h1 className="text-base font-bold">GTA VI: 30 FPS? — пилот</h1>
        <p className="text-xs text-muted-foreground">Тезисы только из <a className="text-primary underline" href={NEWS_SOURCE} target="_blank" rel="noreferrer">официальной статьи Rockstar</a>. Материалы скачайте сами из <a className="text-primary underline" href={MEDIA_LIBRARY} target="_blank" rel="noreferrer">медиатеки Rockstar</a> и загрузите ниже. Файлы остаются в вашем браузере.</p>
        <button onClick={autoPick} className="h-7 rounded-md border border-border px-2 text-xs">Подобрать кадры автоматически</button>
        <p className="font-mono text-xs">Длительность: {totalSeconds(shots)} с {pilotValid(shots) ? "" : "— нужно 18–23 с"}</p>
        {shots.map((s, i) => (
          <div key={i} className="rounded-md border border-border p-3 space-y-2 text-sm">
            <div className="flex items-center gap-2"><b>Шот {i + 1}</b>
              <input type="number" min={2} max={10} step={0.5} value={s.seconds} onChange={(e) => upd(i, { seconds: Number(e.target.value) })} className="h-7 w-16 rounded border border-input bg-muted px-1 text-xs" /> с</div>
            <textarea value={s.text} onChange={(e) => upd(i, { text: e.target.value })} rows={2} className="w-full rounded border border-input bg-muted p-2 text-xs" />
            <div className="text-xs text-muted-foreground">Материал: {s.material}</div>
            <input type="file" accept="video/mp4,image/*" className="text-xs" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return;
              setMedia((m) => m.map((x, k) => (k === i ? { url: URL.createObjectURL(f), video: f.type.startsWith("video"), name: f.name, state: "ok" } : x))); }} />
            <select className="h-7 rounded border border-input bg-muted text-xs" value="" onChange={(e) => pickCatalog(i, e.target.value)}><option value="">Скриншот Rockstar…</option>{CATALOG.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}</select>
            {media[i]?.state === "ok" && !media[i]!.video && <img src={media[i]!.url} alt={media[i]!.name} className="h-24 rounded object-cover" />}
            {media[i] && <div className={`text-xs ${media[i]!.state === "error" ? "text-destructive" : "text-muted-foreground"}`}>{media[i]!.name} — {media[i]!.state === "ok" ? "загружено" : media[i]!.state === "loading" ? "загрузка…" : `ошибка: ${media[i]!.err}`}</div>}
          </div>
        ))}
        <label className="flex gap-2 text-xs"><input type="checkbox" checked={allowed} onChange={(e) => setAllowed(e.target.checked)} />Я подтверждаю, что имею право использовать загруженные материалы (свои файлы или разрешённые официальные медиа Rockstar).</label>
        <div className="space-y-1 text-xs"><b>Озвучка (MP3/WAV)</b> — запишите текст шотов выше по-английски и загрузите файл:
          <input type="file" accept="audio/mpeg,audio/wav,audio/*" className="block text-xs" onChange={(e) => { const f = e.target.files?.[0]; if (f) setVoice({ url: URL.createObjectURL(f), name: f.name }); }} />
          <button disabled={tts.busy} onClick={genVoice} className="h-7 rounded-md border border-border px-2 disabled:opacity-50">{tts.busy ? "Генерация…" : "Сгенерировать озвучку (~$0.01 fal)"}</button>
          <div className="text-muted-foreground">Платно: списывается с баланса fal.ai. Повторно не отправляется.</div>
          {tts.msg && <div className="break-all">{tts.msg}</div>}
          <div className="text-muted-foreground">{voice ? `Загружено: ${voice.name}` : "Озвучка не загружена — экспорт будет без звука."}</div></div>
      </div>
      <div className="panel p-3 space-y-2">
        <canvas ref={canvas} width={W} height={H} className="aspect-[9/16] w-full rounded bg-muted" />
        <button disabled={!media.some(Boolean)} onClick={() => play(false)} className="h-8 w-full rounded-md border border-border text-xs disabled:opacity-50">Предпросмотр раскадровки</button>
        <button disabled={!ready} onClick={() => play(true)} className="h-8 w-full rounded-md bg-primary text-xs text-primary-foreground disabled:opacity-50">{voice ? "Экспорт видео с озвучкой" : "Экспорт видео (без звука)"}</button>
        {!ready && <p className="text-[11px] text-muted-foreground">Для экспорта: все 4 медиа загружены, подтверждение прав, 18–23 с.</p>}
        <p className="text-xs">{status}</p>
        {out && <a href={out.url} download={`gta6-30fps${voice ? "" : "-no-sound"}.${out.ext}`} className="block text-xs text-primary underline">Скачать .{out.ext}</a>}
      </div>
    </div>
  );
}
