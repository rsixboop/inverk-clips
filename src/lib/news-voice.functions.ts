import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { FAL, falConfigured, falPoll, falSubmit, providerMedia } from "@/lib/providers/fal";

// Paid (~$0.01): one fal Kokoro TTS submit. The client stores the request ID and never resubmits on unknown outcome.
export const submitNewsVoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ text: z.string().min(10).max(1200) }).parse(d))
  .handler(async ({ data }) => {
    if (!falConfigured()) throw new Error("FAL_KEY не настроен");
    return { requestId: await falSubmit(FAL.tts, { prompt: data.text, voice: "am_michael", speed: 1 }) };
  });

export const pollNewsVoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ requestId: z.string().regex(/^[\w-]{8,80}$/) }).parse(d))
  .handler(async ({ data }) => {
    const r = await falPoll(FAL.tts, data.requestId);
    if (r.state !== "done") return { state: "processing" as const, url: null };
    const url = providerMedia(r.result);
    if (!/^https:\/\/[^/]*fal\.media\//.test(url)) throw new Error("fal вернул неожиданный адрес аудио");
    return { state: "done" as const, url };
  });
