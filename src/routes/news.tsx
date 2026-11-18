import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { pollNewsVoice, submitNewsVoice } from "@/lib/news-voice.functions";
import { AppShell } from "@/components/studio/AppShell";
import { CATALOG, CLIPS, findAsset, findClip, isCatalogUrl, mediaUrl, pickAssets } from "@/lib/news-catalog";
import { findGtaNews, findNewswire, scriptFromArticle } from "@/lib/news-script.functions";
import { planTimeline } from "@/lib/news-timeline";
import { drawOverlayCues, loadOverlayImages, validateOverlayCues } from "@/lib/news-overlays";
import { Button } from "@/components/ui/button";
import { alignNewsSpeech, resolveNewsOverlay } from "@/lib/news-overlay.functions";
import { timeOverlayIntent, type SpeechWord } from "@/lib/news-overlay-plan";
import { MEDIA_LIBRARY, NEWS_SOURCE, PILOT, pilotValid, totalSeconds, type Shot } from "@/lib/news-pilot";

export const Route = createFileRoute("/news")({
  head: () => ({ meta: [
    { title: "GTA VI News — Inverk Clips" }, { name: "description", content: "Редактор новостного ролика по официальным материалам Rockstar." },
    { property: "og:title", content: "GTA VI News — Inverk Clips" }, { property: "og:description", content: "Раскадровка из своих файлов и официального источника." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: () => <AppShell>{() => <News />}</AppShell>,
});

type Media = { url: string; video: boolean; name: string; state: "loading" | "ok" | "error"; err?: string | undefined; duration?: number } | null;
const W = 1080, H = 1920;

function wrap(ctx: CanvasRenderingContext2D, text: string, max: number) {
  const out: string[] = []; let line = "";
  for (const w of text.split(" ")) { const t = line ? line + " " + w : w; if (ctx.measureText(t).width > max && line) { out.push(line); line = w; } else line = t; }
  return [...out, line];
}

function News() {
  const [shots, setShots] = useState<Shot[]>(PILOT);
  const [language,setLanguage]=useState<"EN"|"RU"|"UK">("EN");
  const [overlayBusy,setOverlayBusy]=useState(false);
  const [overlayMessage,setOverlayMessage]=useState("");
  const [speechWords,setSpeechWords]=useState<SpeechWord[]>([]);
  const overlayFn=useServerFn(resolveNewsOverlay),alignFn=useServerFn(alignNewsSpeech);
  const preparedCues=useRef<NonNullable<Shot["overlay_cues"]>[]>([]);
  const [angle, setAngle] = useState("");
  const [media, setMedia] = useState<Media[]>(() => pickAssets(PILOT).map((id) => { const a = findAsset(id); return a ? { url: mediaUrl(a.id), video: false, name: `Rockstar: ${a.title}`, state: "loading" } : null; }));
  const [source, setSource] = useState(NEWS_SOURCE);
  const [found, setFound] = useState<{ title: string; url: string; date: string }[]>([]);
  const [news, setNews] = useState<{ title: string; url: string; snippet: string; date: string; official: boolean }[]>([]);
  const newsFn = useServerFn(findGtaNews);
  const searchNews = async () => { setNw({ busy: true, msg: "Ищу новости GTA VI за 7 дней…" }); try { const r = await newsFn(); setNews(r.items); setNw({ busy: false, msg: r.error }); } catch (e) { setNw({ busy: false, msg: (e as Error).message }); } };
  const [nw, setNw] = useState({ busy: false, msg: "" });
  const [approved, setApproved] = useState(true);
  const findFn = useServerFn(findNewswire), scriptFn = useServerFn(scriptFromArticle);
  const search = async () => { setNw({ busy: true, msg: "Ищу на Rockstar Newswire…" }); try { const r = await findFn(); setFound(r.items); setNw({ busy: false, msg: r.error }); } catch (e) { setNw({ busy: false, msg: (e as Error).message }); } };
  const makeScript = async () => { setNw({ busy: true, msg: "Читаю статью и пишу сценарий…" }); try { const r = await scriptFn({ data: { url: source,language } });
    const ns: Shot[] = r.shots.map((x) => ({ text: x.text, seconds: x.seconds, material: `Факт: «${x.fact}»`, caption: x.caption, fact: x.fact, brief: x.brief, role: x.role, overlay_cues: x.overlay_cues ?? [],overlay_intents:x.overlay_intents ?? [] })); setShots(ns); setAngle(r.angle); setApproved(false); setVoice(null);setSpeechWords([]);setOverlayMessage(r.shots.flatMap(x=>x.overlay_warnings ?? []).join("; "));
    setMedia((m) => pickAssets(ns).map((id, k) => { const a = ns[k]!.role === "evidence" ? undefined : findAsset(id); return a ? { url: mediaUrl(a.id), video: false, name: `Rockstar: ${a.title}`, state: "loading" } : null; }));
    setNw({ busy: false, msg: "Сценарий готов. Проверьте и утвердите перед озвучкой." }); } catch (e) { setNw({ busy: false, msg: (e as Error).message }); } };
  const [allowed, setAllowed] = useState(false);
  const [status, setStatus] = useState("");
  const [out, setOut] = useState<{ url: string; ext: string } | null>(null);
  const [voice, setVoice] = useState<{ url: string; name: string } | null>(null);
  const audio = useRef<{ el: HTMLAudioElement; ctx: AudioContext; dest: MediaStreamAudioDestinationNode } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const els = useRef<(HTMLImageElement | HTMLVideoElement | null)[]>([]);
  const overlayImages = useRef(new Map<string, HTMLImageElement>());
  const [tts, setTts] = useState<{ busy: boolean; msg: string }>({ busy: false, msg: "" });
  const submitFn = useServerFn(submitNewsVoice), pollFn = useServerFn(pollNewsVoice);
  async function genVoice() {
    const text = shots.map((s) => s.text).join(" ");
    let h = 0; for (const c of text) h = (h * 31 + c.charCodeAt(0)) | 0;
    const key = `news-tts:am_fenrir-v1:${h}`; // Include voice in dedupe key: old Michael audio must not be reused.
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
  const [voiceSec, setVoiceSec] = useState<number | null>(null);
  useEffect(() => { setVoiceSec(null); if (!voice) return; const el = new Audio(); el.onloadedmetadata = () => setVoiceSec(Number.isFinite(el.duration) ? el.duration : null); el.src = voice.url; }, [voice?.url]);
  const plan = planTimeline(shots, media.map((m) => (m ? { video: m.video, catalog: m.name.startsWith("Rockstar"), duration: m.duration } : null)), voiceSec);
  const recRef = useRef<MediaRecorder | null>(null);
  const busyRef = useRef(false); const [busy, setBusy] = useState(false);
  const ready = approved && allowed && media.every((m) => m?.state === "ok") && pilotValid(shots) && !plan.errors.length && (!voice || voiceSec != null) && !busy && !overlayBusy;
  async function prepareObjects() {
    if(overlayBusy)return;setOverlayBusy(true);
    const messages:string[]=[];
    try{
      const intents=shots.flatMap(s=>s.overlay_intents ?? []);
      if(!intents.length){setOverlayMessage("Сценарий не требует объектов");return;}
      const audioBytes=voice?new Uint8Array(await (await fetch(voice.url)).arrayBuffer()):new Uint8Array();
      const digest=await crypto.subtle.digest("SHA-256",new Uint8Array([...new TextEncoder().encode(shots.map(s=>s.text).join(" ")),...audioBytes]));
      const batch=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,"0")).join("");
      let words=speechWords;
      if(!words.length && voice){
        let response=await alignFn({data:{batch}});
        if(response.status==="need_audio"){
          let binary="";audioBytes.forEach(v=>binary+=String.fromCharCode(v));
          const mime=voice.name.toLowerCase().endsWith(".mp3")?"audio/mpeg" as const:voice.name.toLowerCase().endsWith(".m4a")?"audio/mp4" as const:"audio/wav" as const;
          response=await alignFn({data:{batch,audio:btoa(binary),mime}});
        }
        for(let attempt=0;response.status==="pending" && attempt<90;attempt++) {setOverlayMessage("Сопоставляю фразы с озвучкой…");await new Promise(r=>setTimeout(r,2000));response=await alignFn({data:{batch}});}
        if(response.status==="done"){words=response.words;setSpeechWords(words);}else messages.push("Нет надёжных таймкодов — объекты пропущены");
      }
      const updated:Shot[]=[];
      for(let i=0;i<shots.length;i++){
        const s=shots[i];if(!s)continue;
        const offset=plan.seconds.slice(0,i).reduce((a,b)=>a+b,0),length=plan.seconds[i] ?? s.seconds;
        const localWords=words.map(w=>({...w,start:w.start-offset,end:w.end-offset}));
        const cues=[...(s.overlay_cues ?? [])];
        for(const intent of s.overlay_intents ?? []){
          const timed=timeOverlayIntent(intent,localWords,length);
          if(!timed){messages.push(`Шот ${i+1}: фраза не сопоставлена, объект пропущен`);continue;}
          let response=await overlayFn({data:{batch,narration:s.text,intent}});
          for(let attempt=0;response.status==="pending" && attempt<150;attempt++) {setOverlayMessage(response.message);await new Promise(r=>setTimeout(r,2000));response=await overlayFn({data:{batch,narration:s.text,intent}});}
          if(response.status==="done"){
            const [before,active,result]=response.paths;
            if(before&&active&&result && !cues.some(c=>c.speech===timed.speech))cues.push({...timed,before,active,result,...(response.key==="builtin:download-vault"?{fill_region:[.108,.455,.85,.67] as [number,number,number,number]}:{})});
          }else messages.push(response.message);
        }
        updated.push({...s,overlay_cues:cues,speech_words:localWords});
      }
      setShots(updated);setOverlayMessage(messages.join("; ") || "Объекты готовы · сохранены в кэше");
    }catch(error){setOverlayMessage(`Объекты пропущены: ${(error as Error).message}`);}finally{setOverlayBusy(false);}
  }

  useEffect(() => { els.current = media.map((m) => { if (!m) return null;
    if (m.video) { const v = document.createElement("video"); v.src = m.url; v.muted = true; v.playsInline = true; return v; }
    const i = new Image(); i.src = m.url; return i; }); }, [media.map((m) => m?.url).join("|")]);
  const setState = (url: string, state: "ok" | "error", err?: string) => setMedia((ms) => ms.map((x) => (x && x.url === url && x.state === "loading" ? { ...x, state, err } : x)));
  useEffect(() => { media.forEach((m) => { if (!m || m.state !== "loading") return;
    if (m.url.startsWith("blob:")) { if (!m.video) { setState(m.url, "ok"); return; } const v = document.createElement("video"); v.muted = true; const src = m.url;
      v.onloadedmetadata = () => setMedia((ms) => ms.map((x) => (x && x.url === src ? { ...x, state: "ok", duration: v.duration } : x))); v.onerror = () => setState(src, "error", "видео не декодируется"); v.src = src; return; }
    if (m.video) { const src = m.url; fetch(src).then(async (r) => { if (!r.ok) throw new Error(await r.text());
        const b = await r.blob(); const u = URL.createObjectURL(b); const v = document.createElement("video"); v.muted = true;
        v.onloadeddata = () => setMedia((ms) => ms.map((x) => (x && x.url === src ? { ...x, url: u, state: "ok", duration: v.duration } : x)));
        v.onerror = () => setState(src, "error", "видео не декодируется"); v.src = u; })
      .catch((e) => setState(src, "error", e instanceof Error && e.message ? e.message : "сеть")); return; }
    fetch(m.url).then(async (r) => { if (!r.ok) setState(m.url, "error", await r.text()); else { const i = new Image(); i.onload = () => setState(m.url, "ok"); i.onerror = () => setState(m.url, "error", "не декодируется"); i.src = m.url; } })
      .catch(() => setState(m.url, "error", "сеть")); }); }, [media]);
  const autoPick = () => setMedia((m) => pickAssets(shots).map((id, k) => { const a = shots[k]!.role === "evidence" ? undefined : findAsset(id); return a ? { url: mediaUrl(a.id), video: false, name: `Rockstar: ${a.title}`, state: "loading" } : m[k] && !isCatalogUrl(m[k]!.url) ? m[k]! : null; }));
  const pickCatalog = (i: number, id: string) => { const a = findAsset(id); if (a) setMedia((m) => m.map((x, k) => (k === i ? { url: mediaUrl(a.id), video: false, name: `Rockstar: ${a.title}`, state: "loading" } : x))); };

  const pickClip = (i: number, id: string) => { const c = findClip(id); if (c) setMedia((m) => m.map((x, k) => (k === i ? { url: mediaUrl(c.id), video: true, name: `Rockstar видео: ${c.title}`, state: "loading" } : x))); };
  function draw(i: number, progress = 0, cut = 0, speechTime = 0) {
    const ctx = canvas.current!.getContext("2d")!, el = els.current[i];
    ctx.fillStyle = "#111"; ctx.fillRect(0, 0, W, H);
    if (el) { const sw = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth, sh = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
      if (sw && sh) { const s = Math.max(W / sw, H / sh) * (1.045 + (cut % 3) * 0.027 + 0.035 * progress); const dx = (W - sw * s) / 2 + (cut % 2 ? 1 : -1) * (progress - 0.5) * 22; ctx.drawImage(el, dx, (H - sh * s) / 2, sw * s, sh * s); } }
    const label = shots[i]!.caption?.trim();
    if (label) {
      ctx.font = "bold 64px sans-serif"; ctx.textAlign = "center";
      const lines = wrap(ctx, label, W - 160), y0 = H - 520;
      ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(60, y0 - 80, W - 120, lines.length * 80 + 60);
      ctx.fillStyle = "#fff"; lines.forEach((l, k) => ctx.fillText(l, W / 2, y0 + k * 80));
    }
    // A source attribution belongs on evidence frames only, not on every cut.
    if (shots[i]!.role === "evidence") {
      ctx.textAlign = "center"; ctx.font = "32px sans-serif"; ctx.fillStyle = "#fff";
      ctx.fillText("Source: Rockstar Newswire", W / 2, H - 140);
    }
    drawOverlayCues(ctx, preparedCues.current[i] ?? [], overlayImages.current, speechTime);
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
    if (busyRef.current) return; busyRef.current = true; setBusy(true);
    try { await playInner(record); } catch (e) {
      if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
      audio.current?.el.pause(); els.current.forEach((el) => { if (el instanceof HTMLVideoElement) el.pause(); }); setStatus(`Остановлено: ${e instanceof Error ? e.message : String(e)}`); } finally { recRef.current = null; busyRef.current = false; setBusy(false); }
  }
  async function decodeAll(strict: boolean) {
    await Promise.all(els.current.map((el, i) => { if (!el) { if (strict) throw new Error(`шот ${i + 1}: нет материала`); return; }
      if (el instanceof HTMLImageElement) return el.decode().catch(() => { throw new Error(`шот ${i + 1}: картинка не декодируется`); });
      if (el.readyState >= 2) return;
      return new Promise<void>((res, rej) => { el.onloadeddata = () => res(); el.onerror = () => rej(new Error(`шот ${i + 1}: видео не декодируется`)); el.load(); setTimeout(() => rej(new Error(`шот ${i + 1}: видео не загрузилось за 15 с`)), 15000); }); }));
  }
  async function playInner(record: boolean) {
    setOut(null);
    if (record && plan.errors.length) throw new Error(plan.errors.join("; "));
    setStatus("Жду декодирования всех материалов…"); await decodeAll(record);
    preparedCues.current=[];overlayImages.current=new Map();
    for(const [i,s] of shots.entries()){
      const usable:NonNullable<Shot["overlay_cues"]>=[];
      for(const cue of s.overlay_cues ?? []){
        try{
          if(!s.text.includes(cue.speech))continue;
          validateOverlayCues([cue],plan.seconds[i] ?? s.seconds);
          const images=await loadOverlayImages([cue]);images.forEach((image,path)=>overlayImages.current.set(path,image));usable.push(cue);
        }catch{setOverlayMessage("Непригодные состояния пропущены; исходный видеоряд сохранён");}
      }
      preparedCues.current.push(usable);
    }
    draw(0, 0); // first frame is on the canvas before recording/audio start
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
      rec.ondataavailable = (e) => chunks.push(e.data); recRef.current = rec; rec.start();
    }
    if (a) { try { await a.el.play(); } catch (e) { rec?.stop(); throw new Error(`озвучка не воспроизводится (${(e as Error).message}) — немой ролик не сохраняю`); } }
    for (let i = 0; i < shots.length; i++) {
      setStatus(`${record ? "Запись" : "Предпросмотр"}: шот ${i + 1}/${shots.length}`);
      const el = els.current[i]; if (el instanceof HTMLVideoElement) { el.currentTime = 0; try { await el.play(); } catch (e) { rec?.stop(); a?.el.pause(); throw new Error(`шот ${i + 1}: видео не воспроизводится (${(e as Error).message})`); } }
      const cuts = plan.beats.filter((b) => b.shot === i);
      const segmentStart = performance.now();
      for (const beat of cuts) {
        // Absolute deadlines within a shot avoid cumulative RAF/scheduling drift.
        const from = segmentStart + (beat.start - cuts[0]!.start) * 1000;
        const to = segmentStart + (beat.end - cuts[0]!.start) * 1000;
        while (performance.now() < to) {
          const progress = Math.max(0, Math.min(1, (performance.now() - from) / (beat.seconds * 1000)));
          draw(i, progress, beat.cut, a ? Math.max(0,a.el.currentTime - (cuts[0]?.start ?? 0)) : (performance.now()-segmentStart)/1000);
          await new Promise((r) => requestAnimationFrame(r));
        }
      }
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

  const upd = (i: number, p: Partial<Shot>) => { setShots((s) => s.map((x, k) => (k === i ? { ...x, ...p,...(p.text?{overlay_intents:[],overlay_cues:[]}: {}) } : x))); setApproved(false); setVoice(null);setSpeechWords([]); };
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <div className="panel p-4 space-y-3">
        <h1 className="text-base font-bold">GTA VI: 30 FPS? — пилот</h1>
        <p className="text-xs text-muted-foreground">Тезисы только из <a className="text-primary underline" href={source} target="_blank" rel="noreferrer">официальной статьи Rockstar</a>. Материалы скачайте сами из <a className="text-primary underline" href={MEDIA_LIBRARY} target="_blank" rel="noreferrer">медиатеки Rockstar</a> и загрузите ниже. Файлы остаются в вашем браузере.</p>
        <div className="rounded-md border border-border p-2 space-y-2 text-xs">
          <button disabled={nw.busy} onClick={searchNews} className="mr-2 h-7 rounded-md border border-border px-2">Найти новости GTA VI</button>
          {news.map((f) => <label key={f.url} className={`block rounded border p-2 ${source === f.url ? "border-primary" : "border-border"}`}><input type="radio" className="mr-1" checked={source === f.url} onChange={() => setSource(f.url)} /><b>{f.title}</b> {f.date && <span className="text-muted-foreground">{f.date}</span>}
            {!f.official && <span className="ml-1 text-destructive">проверить первоисточник</span>}<p className="text-muted-foreground">{f.snippet}</p><a href={f.url} target="_blank" rel="noreferrer" className="break-all text-primary underline">{f.url}</a></label>)}
          <p>Источник: <a href={source} target="_blank" rel="noreferrer" className="break-all text-primary underline">{source}</a> — тексты шотов ниже редактируйте вручную; сценарий по сниппету не создаётся.</p>
          {angle && <p>Угол подачи: <b>{angle}</b></p>}
          <button disabled={nw.busy} onClick={search} className="h-7 rounded-md border border-border px-2">Только Rockstar Newswire</button>
          {found.map((f) => <label key={f.url} className="flex gap-2"><input type="radio" checked={source === f.url} onChange={() => setSource(f.url)} />{f.title} {f.date && <span className="text-muted-foreground">{f.date}</span>}</label>)}
          <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="https://www.rockstargames.com/newswire/article/…" className="h-7 w-full rounded border border-input bg-muted px-2" />
          <button disabled={nw.busy} onClick={makeScript} className="h-7 rounded-md bg-primary px-2 text-primary-foreground">Сценарий</button>
          <select aria-label="Язык сценария" value={language} onChange={e=>setLanguage(e.target.value as "EN"|"RU"|"UK")} className="h-7 border border-input bg-muted text-xs"><option>EN</option><option>RU</option><option>UK</option></select>
          {nw.msg && <p className="text-muted-foreground">{nw.msg}</p>}
          {!approved && <button onClick={() => setApproved(true)} className="h-7 rounded-md border border-primary px-2 text-primary">Утвердить сценарий</button>}
        </div>
        <button onClick={autoPick} className="h-7 rounded-md border border-border px-2 text-xs">Подобрать кадры автоматически</button>
        <p className="font-mono text-xs">Длительность: {totalSeconds(shots)} с {pilotValid(shots) ? "" : "— нужно 18–23 с"}{voiceSec != null && ` · по озвучке: ${plan.total.toFixed(1)} с`} · монтажных акцентов: {plan.beats.length}</p>
        {plan.errors.map((e) => <p key={e} className="text-xs text-destructive">{e}</p>)}
        {shots.map((s, i) => (
          <div key={i} className="rounded-md border border-border p-3 space-y-2 text-sm">
            <div className="flex items-center gap-2"><b>Шот {i + 1}</b>
              <input type="number" min={2} max={10} step={0.5} value={s.seconds} onChange={(e) => upd(i, { seconds: Number(e.target.value) })} className="h-7 w-16 rounded border border-input bg-muted px-1 text-xs" /> с</div>
            <textarea value={s.text} onChange={(e) => upd(i, { text: e.target.value })} rows={2} className="w-full rounded border border-input bg-muted p-2 text-xs" />
            <input value={s.caption ?? ""} placeholder="Экранная подпись (пусто = без заголовка)" onChange={(e) => upd(i, { caption: e.target.value })} className="w-full rounded border border-input bg-muted p-1 text-xs" />
            <details className="text-xs">
              <summary>Смысловые объекты · {s.overlay_cues?.length ?? 0}</summary>
              {(s.overlay_intents ?? []).map((intent,k)=><p key={k}>{intent.purpose} · «{intent.phrase}» · {intent.before} → {intent.action} → {intent.after}</p>)}
              {(s.overlay_cues ?? []).map((c,k) => <div key={k} className="py-1"><b>{c.purpose}</b> · «{c.speech}» · {c.start} → {c.action} → {c.after} → {c.end} с <Button size="sm" variant="ghost" onClick={() => upd(i,{overlay_cues: (s.overlay_cues ?? []).filter((_,j)=>j!==k)})}>Удалить</Button></div>)}
              <input aria-label={`Смысловые объекты шота ${i+1}`} type="file" accept="application/json" onChange={async e => { const f=e.target.files?.[0]; if (!f) return; try { const input=JSON.parse(await f.text()); upd(i,{overlay_cues:validateOverlayCues(input,plan.seconds[i] ?? s.seconds)}); } catch(error) { setStatus((error as Error).message); } }} />
            </details>
            <div className="text-xs text-muted-foreground">Материал: {s.material}</div>
            {s.brief && <div className="text-xs text-muted-foreground">Визуал: {s.brief} · <b>{s.role === "evidence" ? "доказательство" : "иллюстрация (не доказательство)"}</b></div>}
            <input type="file" accept="video/mp4,image/*" className="text-xs" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return;
              setMedia((m) => m.map((x, k) => (k === i ? { url: URL.createObjectURL(f), video: f.type.startsWith("video"), name: f.name, state: "ok" } : x))); }} />
            <select className="h-7 rounded border border-input bg-muted text-xs" value="" onChange={(e) => pickCatalog(i, e.target.value)}><option value="">Скриншот Rockstar…</option>{CATALOG.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}</select>
            <select className="h-7 rounded border border-input bg-muted text-xs" value="" onChange={(e) => pickClip(i, e.target.value)}><option value="">Видеофутаж Rockstar…</option>{CLIPS.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select>
            {media[i]?.state === "ok" && media[i]!.video && <video src={media[i]!.url} muted loop autoPlay playsInline className="h-24 rounded object-cover" />}
            {media[i]?.state === "ok" && !media[i]!.video && <img src={media[i]!.url} alt={media[i]!.name} className="h-24 rounded object-cover" />}
            {media[i] && <div className={`text-xs ${media[i]!.state === "error" ? "text-destructive" : "text-muted-foreground"}`}>{media[i]!.name} — {media[i]!.state === "ok" ? "загружено" : media[i]!.state === "loading" ? "загрузка…" : `ошибка: ${media[i]!.err}`}</div>}
          </div>
        ))}
        <label className="flex gap-2 text-xs"><input type="checkbox" checked={allowed} onChange={(e) => setAllowed(e.target.checked)} />Я подтверждаю, что имею право использовать загруженные материалы (свои файлы или разрешённые официальные медиа Rockstar).</label>
        <div className="space-y-1 text-xs"><b>Озвучка (MP3/WAV)</b> — запишите текст шотов выше по-английски и загрузите файл:
          <input type="file" accept="audio/mpeg,audio/wav,audio/*" className="block text-xs" onChange={(e) => { const f = e.target.files?.[0]; if (f) setVoice({ url: URL.createObjectURL(f), name: f.name }); }} />
          <button disabled={tts.busy || !approved} onClick={genVoice} className="h-7 rounded-md border border-border px-2 disabled:opacity-50">{tts.busy ? "Генерация…" : "Сгенерировать озвучку (~$0.01 fal)"}</button>
          <div className="text-muted-foreground">Платно: списывается с баланса fal.ai. Повторно не отправляется.</div>
          {tts.msg && <div className="break-all">{tts.msg}</div>}
          <div className="text-muted-foreground">{voice ? `Загружено: ${voice.name}` : "Озвучка не загружена — экспорт будет без звука."}</div></div>
        <Button variant="outline" size="sm" disabled={overlayBusy || !approved || !voice} onClick={prepareObjects}>Подготовить смысловые объекты · лимит $1 fal</Button>
        <p className="text-xs text-muted-foreground">{overlayMessage}</p>
      </div>
      <div className="panel p-3 space-y-2">
        <div className="border-b border-border pb-2 space-y-1">
          <b className="text-xs">212 GB · загрузка ≠ ранний доступ</b>
          <video aria-label="Semantic download lock example" controls playsInline preload="metadata" src="/gta6_212gb_semantic.mp4" className="w-full rounded bg-muted" />
          <a href="/gta6_212gb_semantic.mp4" download className="block text-xs text-primary underline">Скачать MP4 · смысловой объект</a>
        </div>
        <div className="rounded-md border border-primary/40 p-2 space-y-1">
          <b className="text-xs">Новый выпуск · Леонида за пределами Vice City · 4 прозрачных AI-ассета</b>
          <video controls playsInline preload="metadata" src="/gta6_leonida_overlay_news.mp4" className="w-full rounded bg-muted" />
          <a href="/gta6_leonida_overlay_news.mp4" download="gta6_leonida_overlay_news.mp4" className="block text-xs text-primary underline">Скачать новый MP4</a>
          <p className="text-[11px] text-muted-foreground">Отдельные объекты с прозрачностью накладываются поверх официальных GTA VI скриншотов; они не заменяют исходный видеоряд. <a href="/gta6_212gb_news.mp4" target="_blank" rel="noreferrer" className="underline">Предыдущий новостной ролик</a></p>
        </div>
        <p className="text-[11px] text-muted-foreground">Для сравнения: <a href="/gta6_cloud_v2.mp4" target="_blank" rel="noreferrer" className="underline">V2</a> · <a href="/gta6_cloud_v3.mp4" target="_blank" rel="noreferrer" className="underline">V3</a> · <a href="/gta6_cloud_v4.mp4" target="_blank" rel="noreferrer" className="underline">V4</a></p>
        <canvas ref={canvas} width={W} height={H} className="aspect-[9/16] w-full rounded bg-muted" />
        <p className="text-[11px] text-muted-foreground">Ниже — отдельный редактор раскадровки. Готовый ролик находится выше.</p>
        <button disabled={busy || !media.some(Boolean)} onClick={() => play(false)} className="h-8 w-full rounded-md border border-border text-xs disabled:opacity-50">Предпросмотр раскадровки</button>
        <button disabled={!ready} onClick={() => play(true)} className="h-8 w-full rounded-md bg-primary text-xs text-primary-foreground disabled:opacity-50">{voice ? "Экспорт видео с озвучкой" : "Экспорт видео (без звука)"}</button>
        {!ready && <p className="text-[11px] text-muted-foreground">Для экспорта: все 4 медиа загружены, подтверждение прав, 18–23 с.</p>}
        <p className="text-xs">{status}</p>
        {out && <a href={out.url} download={`gta6-30fps${voice ? "" : "-no-sound"}.${out.ext}`} className="block text-xs text-primary underline">Скачать .{out.ext}</a>}
      </div>
    </div>
  );
}
