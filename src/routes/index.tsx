import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/studio/AppShell";
import { Studio } from "@/components/studio/Studio";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [
    { title: "Студия — Inverk Clips" }, { name: "description", content: "Создание вертикальных роликов 1080×1920 из запроса и футажа." },
    { property: "og:title", content: "Студия — Inverk Clips" }, { property: "og:description", content: "Создание вертикальных роликов из запроса и футажа." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: () => <AppShell>{(uid) => <Studio userId={uid} />}</AppShell>,
});
