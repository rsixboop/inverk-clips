import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AppShell } from "@/components/studio/AppShell";
import { providerStatus } from "@/lib/jobs.functions";

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [
    { title: "Настройки — Inverk Clips" }, { name: "description", content: "Подключённые сервисы и аккаунты." },
    { property: "og:title", content: "Настройки — Inverk Clips" }, { property: "og:description", content: "Подключённые сервисы." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: () => <AppShell>{() => <Settings />}</AppShell>,
});

function Row({ name, ok, desc, okText = "подключено", noText = "не подключено" }: { name: string; ok: boolean | undefined; desc: string; okText?: string; noText?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
      <div><div className="text-sm font-medium">{name}</div><div className="text-xs text-muted-foreground">{desc}</div></div>
      <span className={`shrink-0 rounded px-2 py-0.5 text-[11px] ${ok ? "bg-primary/15 text-primary" : "bg-warning/15 text-warning"}`}>{ok === undefined ? "…" : ok ? okText : noText}</span>
    </div>
  );
}
function Settings() {
  const fn = useServerFn(providerStatus);
  const s = useQuery({ queryKey: ["providers"], queryFn: () => fn() }).data;
  return (
    <div className="max-w-3xl space-y-4">
      <div className="panel overflow-hidden">
        <div className="border-b border-border px-4 py-3"><h1 className="text-base font-bold">Сервисы</h1></div>
        <Row name="ИИ-планирование (Lovable AI)" ok={s?.ai} desc="Сценарий, подпись, выбор фрагмента по длительности. Без веб-поиска и без анализа кадров/транскрипта." />
        <Row name={`Рендер + озвучка + субтитры (Shotstack, ${s?.shotstackEnv === "v1" ? "production" : "sandbox"})`} ok={s?.shotstack}
          desc="Секрет SHOTSTACK_API_KEY. Необязательно SHOTSTACK_ENV=v1 для продакшена (sandbox ставит водяной знак). Озвучка ElevenLabs через Shotstack оплачивается их кредитами." />
        <Row name="Подпись вебхуков" ok={s?.webhookSigning} desc="Защищает обратный вызов рендерера." />
        <Row name="Публикация в TikTok" ok={s?.tiktok} desc="Не реализовано в этой версии. Ролики не публикуются автоматически." />
      </div>
      <div className="panel p-4 text-xs text-muted-foreground space-y-1">
        <div className="label-xs">Не поддерживается сейчас</div>
        <p>Скачивание с YouTube/Twitch, запись стримов, автопоиск лицензированного футажа, веб-проверка фактов, мульти-аккаунты (только модель данных).</p>
      </div>
    </div>
  );
}
