import { useEffect, useState, useSyncExternalStore } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { captureClaim, captureFinish } from "@/lib/live.functions";
import { getServerState, getState, initCaptureWatch, startTabCapture, stopTabCapture, subscribe } from "@/lib/tab-capture";

let watched = false;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** "Следить и клипать вкладку" controls + honest capture status for one YouTube monitor. */
export function TabCapture({ monitorId }: { monitorId: string }) {
  const st = useSyncExternalStore(subscribe, getState, getServerState);
  const claim = useServerFn(captureClaim), finish = useServerFn(captureFinish);
  const [rights, setRights] = useState(false); const [delay, setDelay] = useState(0);
  useEffect(() => { if (!watched) { watched = true; initCaptureWatch(); } }, []);
  const mine = st.monitorId === monitorId;
  const otherBusy = !mine && (st.phase === "capturing" || st.phase === "picking");
  const audioOk = st.audioHeardAt && Date.now() - st.audioHeardAt < 15_000;
  async function start() {
    try { await startTabCapture(monitorId, { delayS: delay, api: { claim: (id) => claim({ data: { id } }), finish: (d) => finish(d) } }); } catch (e) { toast.error((e as Error).message); }
  }
  return (
    <div className="mt-2 rounded-md border border-border bg-muted/40 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <b>Следить и клипать вкладку</b>
        {mine && st.phase === "capturing" ? <button onClick={() => stopTabCapture()} className="rounded border border-border px-2">Остановить захват</button>
          : <>
            <label className="flex items-center gap-1"><input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} />мой эфир или есть разрешение на нарезку</label>
            <label className="flex items-center gap-1">задержка зрителя, с<input type="number" min={0} max={60} value={delay} onChange={(e) => setDelay(Math.max(0, Math.min(60, Number(e.target.value) || 0)))} className="h-6 w-14 rounded border border-input bg-muted px-1" /></label>
            <button disabled={!rights || otherBusy} onClick={start} className="rounded bg-primary px-2 py-0.5 font-semibold text-primary-foreground disabled:opacity-50">Выбрать вкладку Chrome</button>
          </>}
      </div>
      <p className="mt-1 text-muted-foreground">Только вкладка Chrome со звуком вкладки (без экрана, окна и микрофона). Держится последние ~2,5 мин; к каждому всплеску чата режется 20 с до и 15 с после, MP4 с оригинальным звуком уходит в Библиотеку. Можно работать в других вкладках и программах — эту вкладку приложения не закрывайте.</p>
      {otherBusy && <p className="text-warning">Сейчас захват идёт для другого монитора.</p>}
      {mine && st.phase !== "idle" && (
        <div className="mt-1 space-y-0.5 font-mono text-[11px]">
          <div className={st.phase === "capturing" ? "text-primary" : st.phase === "picking" ? "" : "text-warning"}>{st.phase === "capturing" ? "● идёт захват" : st.phase === "picking" ? "выбор вкладки…" : "■ захват не идёт"} · {st.message}</div>
          {st.phase === "capturing" && <>
            <div>буфер {fmt(st.bufferedS)} · {st.bufferMB.toFixed(1)} МБ · ключевых кадров {st.keyframes} · {st.mime.split(";")[0]} · вкладка приложения {st.hidden ? "в фоне" : "открыта"}</div>
            <div className={audioOk ? "" : "text-warning"}>звук: «{st.audioTrack}» · {audioOk ? `есть сигнал (${(20 * Math.log10(Math.max(st.audioLevel, 1e-6))).toFixed(0)} dBFS)` : "дорожка есть, но тишина — проверьте звук в эфире"}</div>
          </>}
          {st.warnings.map((w) => <div key={w} className="text-warning">⚠ {w}</div>)}
          {st.log.map((l) => <div key={l.id + l.at} className={l.ok ? "" : "text-warning"}>{new Date(l.at).toLocaleTimeString("ru")} · {l.text}</div>)}
        </div>)}
    </div>
  );
}
