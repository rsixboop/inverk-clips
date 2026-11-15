import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AppShell } from "@/components/studio/AppShell";
import { providerStatus } from "@/lib/jobs.functions";

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [
    { title: "Настройки — Inverk Clips" }, { name: "description", content: "Подключённые сервисы и первый ролик." },
    { property: "og:title", content: "Настройки — Inverk Clips" }, { property: "og:description", content: "Подключённые сервисы." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: () => <AppShell>{() => <Settings />}</AppShell>,
});

const PROVIDERS = [
  { id: "ai", secret: "встроено", name: "Lovable AI", what: "Поисковые запросы, оценка футажа, сценарий по найденным источникам, выбор клипа Vizard.", url: "" },
  { id: "tavily", secret: "TAVILY_API_KEY", name: "Tavily — веб-поиск фактов", what: "Обязателен для режимов «По нише» и «Смешанный». Бесплатный тариф есть.", url: "https://app.tavily.com" },
  { id: "pexels", secret: "PEXELS_API_KEY", name: "Pexels — стоковый футаж", what: "Бесплатный ключ. Общие кадры (город, машины); геймплей GTA не заменяет.", url: "https://www.pexels.com/api/" },
  { id: "shotstack", secret: "SHOTSTACK_API_KEY", name: "Shotstack — сборка, ИИ-озвучка, субтитры", what: "Нужен для «По нише», «Смешанный» и «По ссылке → Сборка». Sandbox ставит водяной знак; SHOTSTACK_ENV=v1 — продакшен. Озвучка списывает их кредиты.", url: "https://dashboard.shotstack.io" },
  { id: "vizard", secret: "VIZARD_API_KEY", name: "Vizard — ИИ-нарезка по ссылке", what: "Только «По ссылке → ИИ-нарезка». Платно (минуты аккаунта), обработка от минут до десятков минут. YouTube, запись Twitch, прямой MP4, файл.", url: "https://vizard.ai" },
] as const;

const MODES = [
  { name: "По ссылке → ИИ-нарезка (самый короткий путь к первому MP4)", need: ["vizard"] },
  { name: "По ссылке → Сборка своего файла", need: ["shotstack"] },
  { name: "По нише (без своего видео)", need: ["tavily", "pexels", "shotstack"] },
  { name: "Смешанный (своё видео + факты)", need: ["tavily", "shotstack"] },
] as const;

function Settings() {
  const fn = useServerFn(providerStatus);
  const s = useQuery({ queryKey: ["providers"], queryFn: () => fn() }).data as Record<string, any> | undefined;
  const ok = (id: string) => s?.[id];
  return (
    <div className="max-w-3xl space-y-4">
      <div className="panel overflow-hidden">
        <div className="border-b border-border px-4 py-3"><h1 className="text-base font-bold">Первый ролик: что подключить</h1></div>
        {MODES.map((m) => (
          <div key={m.name} className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5 text-sm">
            <span>{m.name}</span>
            <span className="flex gap-1">{m.need.map((n) => <span key={n} className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${ok(n) ? "bg-primary/15 text-primary" : "bg-warning/15 text-warning"}`}>{PROVIDERS.find((p) => p.id === n)!.secret}</span>)}</span>
          </div>
        ))}
        <div className="px-4 py-3 text-xs text-muted-foreground">
          Как добавить ключ: в редакторе Lovable откройте <b>Project Settings → Secrets</b>, нажмите «Add secret», введите точное имя (например <span className="font-mono">VIZARD_API_KEY</span>) и значение. Не вставляйте ключи в чат или в поля этого приложения — они хранятся только на сервере.
        </div>
      </div>
      <div className="panel overflow-hidden">
        <div className="border-b border-border px-4 py-3"><h2 className="text-sm font-bold">Сервисы</h2></div>
        {PROVIDERS.map((p) => (
          <div key={p.id} className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
            <div><div className="text-sm font-medium">{p.name} <span className="font-mono text-[11px] text-muted-foreground">{p.secret}</span></div>
              <div className="text-xs text-muted-foreground">{p.what} {p.url && <a href={p.url} target="_blank" rel="noreferrer noopener" className="text-info underline">получить ключ</a>}</div></div>
            <span className={`shrink-0 rounded px-2 py-0.5 text-[11px] ${ok(p.id) ? "bg-primary/15 text-primary" : "bg-warning/15 text-warning"}`}>{s === undefined ? "…" : ok(p.id) ? "подключено" : "не подключено"}</span>
          </div>
        ))}
        <div className="flex justify-between px-4 py-3"><div><div className="text-sm font-medium">Публикация в TikTok</div><div className="text-xs text-muted-foreground">Не реализовано. Ролики не публикуются.</div></div><span className="h-fit rounded bg-warning/15 px-2 py-0.5 text-[11px] text-warning">не подключено</span></div>
      </div>
      <div className="panel space-y-1 p-4 text-xs text-muted-foreground">
        <div className="label-xs">Фоновая обработка</div>
        <p>Пока вкладка открыта, задачи продвигаются каждые ~5 с. После закрытия вкладки их продвигает фоновый планировщик раз в 2 минуты — но только у опубликованного приложения. В закрытом предпросмотре без публикации работа идёт лишь при открытой вкладке.</p>
        <div className="label-xs pt-2">Не поддерживается</div>
        <p>Запись прямых эфиров, каналы как источник видео (только ориентир), обход DRM/логинов, публикация в соцсети, мульти-аккаунты (только модель данных).</p>
      </div>
    </div>
  );
}
