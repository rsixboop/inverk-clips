export const STAGES = [
  { key: "validate", label: "Проверка источника" },
  { key: "research", label: "Веб-поиск фактов (Tavily)" },
  { key: "discover", label: "Разрешённый футаж из библиотеки" },
  { key: "plan", label: "Сценарий с источниками" },
  { key: "image_submit", label: "Иллюстрация: Atlas Cloud" },
  { key: "image_wait", label: "Ожидание иллюстрации" },
  { key: "tts_submit", label: "Озвучка: Atlas Cloud" },
  { key: "tts_wait", label: "Ожидание озвучки" },
  { key: "audio_metadata_submit", label: "Длительность озвучки" },
  { key: "audio_metadata_wait", label: "Проверка длины звука" },
  { key: "render_submit", label: "Нарезка: fal.ai" },
  { key: "render_wait", label: "Ожидание нарезки" },
  { key: "compose_submit", label: "Сборка кадров и звука" },
  { key: "compose_wait", label: "Ожидание сборки" },
  { key: "scale_submit", label: "Вертикальный H.264 1080×1920" },
  { key: "scale_wait", label: "Ожидание кадрирования" },
  { key: "captions_submit", label: "Субтитры: fal.ai" },
  { key: "captions_wait", label: "Ожидание субтитров" },
  { key: "finalize", label: "Проверка и сохранение MP4" },
] as const;
export const CLIP_STAGES = [STAGES[0],
  { key: "metadata_submit", label: "Метаданные и кадры" },
  { key: "metadata_wait", label: "Проверка исходника" },
  { key: "transcript_submit", label: "Речь и таймкоды: fal.ai" },
  { key: "transcript_wait", label: "Ожидание транскрипта" },
  { key: "moment_select", label: "Выбор моментов по содержанию" },
  ...STAGES.slice(6),
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
export const STORY_STAGES = [STAGES[0],
  { key: "story_plan", label: "Сюжет: кандидаты, выбор, проверка плана (держите вкладку открытой ~1–3 мин)" },
  { key: "voice_submit", label: "Диктор: fal Kokoro" }, { key: "voice_wait", label: "Замер длительности голоса" }, { key: "voice_align", label: "Привязка сцен к голосу" },
  { key: "frame_submit", label: "Опорные кадры: fal Nano Banana" }, { key: "frame_wait", label: "Проверка кадров (непрерывность)" },
  { key: "shot_submit", label: "Анимация: fal Kling 2.5 Pro" }, { key: "shot_wait", label: "Ожидание анимации" },
  { key: "shot_check_submit", label: "Конечный кадр шота" }, { key: "shot_check_wait", label: "Проверка действия" },
  { key: "sfx_submit", label: "Звуки: fal MMAudio" }, { key: "sfx_wait", label: "Ожидание звуков" },
  { key: "mix", label: "Микс: голос поверх приглушённых эффектов" },
  { key: "shot_scale_submit", label: "Шоты → 1080×1920: fal scale-video" }, { key: "shot_scale_wait", label: "Ожидание кадрирования шотов" },
  { key: "remux", label: "Склейка шотов и голоса (в приложении)" },
  ...STAGES.slice(15),
] as const;
export const stagesFor = (route: string) => (route === "clip" ? CLIP_STAGES : route === "story" ? STORY_STAGES : STAGES) as readonly { key: string; label: string }[];
