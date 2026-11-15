export const STAGES = [
  { key: "validate", label: "Проверка источника" },
  { key: "plan", label: "План и сценарий (ИИ)" },
  { key: "render_submit", label: "Отправка в рендер" },
  { key: "render_wait", label: "Рендер: озвучка, нарезка, субтитры" },
  { key: "finalize", label: "Проверка и сохранение MP4" },
] as const;
export const STATUS: Record<string, { label: string; tone: "muted" | "primary" | "warning" | "destructive" | "info" }> = {
  queued: { label: "В очереди", tone: "muted" }, running: { label: "В работе", tone: "info" }, review: { label: "Ждёт проверки", tone: "warning" },
  paused: { label: "Пауза", tone: "warning" }, blocked: { label: "Заблокировано", tone: "warning" }, failed: { label: "Ошибка", tone: "destructive" },
  cancelled: { label: "Отменено", tone: "muted" }, succeeded: { label: "Готово", tone: "primary" },
};
export const ACTIVE = ["queued", "running"];
export const MODES = [{ key: "niche", label: "По нише" }, { key: "link", label: "По ссылке" }, { key: "mixed", label: "Смешанный" }] as const;
export const LANGS = [{ key: "en", label: "English" }, { key: "ru", label: "Русский" }, { key: "uk", label: "Українська" }] as const;
export const PERMISSIONS = [{ key: "owned", label: "Моё видео" }, { key: "licensed", label: "Лицензия" }, { key: "permitted", label: "Есть разрешение" }, { key: "unknown", label: "Не указано" }] as const;
