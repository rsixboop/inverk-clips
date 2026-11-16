// "story" route stages: plan → narrator-first voice → reference-grounded frames (vision QC) →
// image-to-video shots (end-frame QC) → SFX → in-Worker narrator-first mix → shared compose/scale/captions/finalize.
// Every paid call goes through submitTask (barrier + per-job spend cap); retries are bounded to one per asset.
import { FAL, endFramesInput, providerMedia, scaleInput } from "@/lib/providers/fal";
import { ProviderError } from "@/lib/providers/http";
import { decodeWav, encodeWav16, mixNarratorFirst, wavDuration } from "@/lib/wav";
import { inspectMp4 } from "@/lib/mp4-inspect";
import { muxClipsWithPcm } from "@/lib/mp4-mux";
import { type Ctx, P, fail, log, patch, pollTask, setPlan, submitTask } from "./pipeline.server";
import {
  SCENES, SCENE_SECONDS, SHOT_NEGATIVE, STORY_CALIBRATION, alignVoice, anchorText, framePrompt, normalizePlan,
  planInstructions, qcChecks, shotPrompt, validatePlan, type StoryPlan,
} from "./story-plan";

const MAX_REPAIRS = 2, MAX_ASSET_RETRIES = 1, VOICE = "am_michael";
const story = (c: Ctx) => P(c.job).story as StoryPlan;
const cur = (c: Ctx) => Number(P(c.job).cur ?? 0);
const retry = (c: Ctx) => Number(P(c.job).retry ?? 0);
const canRetry = (c: Ctx, usd: number) => retry(c) < MAX_ASSET_RETRIES && Number(P(c.job).spend_usd ?? 0) + usd <= Number(P(c.job).budget_usd ?? 0);
const setIdx = (arr: any[] | undefined, i: number, v: any) => { const a = [...(arr ?? [])]; a[i] = v; return a; };

async function vision(c: Ctx, checks: string[], images: string[], extra = "") {
  const j = await c.deps.ai("You are a strict visual QA checker for video frames. Judge only what is visible. Return JSON only.",
    `Check each item against the image(s)${extra}. Items:\n${checks.map((x, i) => `${i}. ${x}`).join("\n")}\nReturn {checks:[{i, pass:boolean, note (short)}]}.`, images);
  const res = checks.map((item, i) => { const r = (j.checks ?? []).find((x: any) => Number(x.i) === i); return { item, pass: r?.pass === true, note: String(r?.note ?? "no answer") }; });
  return { pass: res.every((r) => r.pass), checks: res };
}

/** Poll a task; when the model produced no media (fal `no_media_generated`), use the asset's single bounded
 * retry with a new key and a compact prompt instead of failing the whole job. Returns null when handled/pending. */
async function pollAsset(c: Ctx, key: string, kind: "frame" | "shot", usd: number) {
  try { return await pollTask(c, key); }
  catch (e) {
    if (!(e instanceof ProviderError) || e.kind !== "no_media") throw e;
    if (!canRetry(c, usd)) { await fail(c, c.job.stage, `${e.message} Повтор для этого ${kind === "frame" ? "кадра" : "шота"} уже использован или превышен лимит расходов.`); return null; }
    await setPlan(c, { retry: retry(c) + 1, compact_prompt: true }, { stage: `${kind}_submit`, attempts: 0 });
    await log(c, c.job.stage, `${key}: модель не вернула результат (no_media_generated) — один повтор с упрощённым запросом`, "warn");
    return null;
  }
}

export async function storyStep(c: Ctx): Promise<boolean> {
  const { job, deps } = c, plan = P(job), t = deps.now();
  switch (job.stage) {
    case "story_plan": {
      const issues: string[] = plan.story_issues ?? [];
      const user = `Language: English narration. Request: ${job.prompt}${plan.feedback?.length ? `\nUser feedback on earlier videos: ${plan.feedback.join(" | ")}` : ""}${issues.length ? `\nYour previous plan failed validation. Fix ALL of these and return a complete plan:\n- ${issues.join("\n- ")}\nPrevious plan: ${JSON.stringify(plan.story_draft).slice(0, 12000)}` : ""}`;
      const sp = normalizePlan(await deps.ai(planInstructions(), user));
      const found = validatePlan(sp, { allowNeon: /neon/i.test(job.prompt), prompt: job.prompt });
      const repairs = Number(plan.story_repairs ?? 0);
      if (found.length) {
        if (repairs >= MAX_REPAIRS) { await fail(c, "story_plan", `План не прошёл проверку после ${repairs} исправлений: ${found.slice(0, 4).join(" ")}`); return true; }
        await setPlan(c, { story_draft: sp, story_issues: found, story_repairs: repairs + 1 });
        await log(c, "story_plan", `Проверка плана: ${found.length} проблем, исправляю (${repairs + 1}/${MAX_REPAIRS}): ${found.slice(0, 3).join(" ")}`, "warn", deps.now() - t);
        return true;
      }
      const sel = sp.candidates.find((x) => x.id === sp.selected_id)!;
      await setPlan(c, { story: sp, story_issues: [], story_draft: null, title: sp.title, calibration_version: STORY_CALIBRATION.version, anchors_text: anchorText(sp),
        story_summary: { synopsis: sel.synopsis, hook_promise: sel.hook_promise, hook_visual: sel.hook_visual, payoff: sel.payoff, withheld: sel.withheld, reason: sp.selection_reason, candidates: sp.candidates.map((x) => ({ id: x.id, synopsis: x.synopsis, reason: x.reason })) },
        references: { real_reference_images: [], note: "No licensed real game reference images supplied; every frame is model-generated from text and the job's own first frame." },
        cur: 0, retry: 0, voices: [], frames: [], shots: [], sfx: [] },
        { script: sp.scenes.map((s) => s.narration).join(" "), caption: `${sp.caption}\n\n${sp.hashtags.map((h) => "#" + h.replace(/^#/, "")).join(" ")}`, stage: "voice_submit", attempts: 0 });
      await log(c, "story_plan", `История выбрана: «${sp.title}» — ${sel.synopsis}`, "info", deps.now() - t);
      return true;
    }
    case "voice_submit": {
      const i = cur(c), s = story(c).scenes[i]!, speed = Number(plan.voice_speed?.[i] ?? 1);
      await submitTask(c, `voice${i}_s${Math.round(speed * 100)}`, "fal", FAL.tts, { prompt: s.narration, voice: VOICE, speed }, "voice_wait"); return true;
    }
    case "voice_wait": {
      const i = cur(c), speed = Number(plan.voice_speed?.[i] ?? 1);
      const r = await pollTask(c, `voice${i}_s${Math.round(speed * 100)}`); if (!r) return true;
      const url = providerMedia(r["audio"]?.url);
      const duration = wavDuration(await deps.fetchMedia(url));
      if (!(duration > 0.3)) { await fail(c, "voice_wait", `Озвучка строки ${i + 1} пустая — тихий голос не принимается`); return true; }
      const voices = setIdx(plan.voices, i, { url, duration, speed, text: story(c).scenes[i]!.narration });
      let next = -1; for (let k = 0; k < SCENES; k++) if (!voices[k]) { next = k; break; }
      await setPlan(c, { voices, cur: Math.max(0, next) }, { stage: next >= 0 ? "voice_submit" : "voice_align" });
      return true;
    }
    case "voice_align": {
      const a = alignVoice((plan.voices ?? []).map((v: any) => Number(v?.duration)));
      const bad = a.slots.find((s) => !s.fits);
      if (!bad) {
        await setPlan(c, { voice_timing: a, cur: 0, retry: 0 }, { stage: "frame_submit" });
        await log(c, "voice_align", `Голос: ${a.slots.map((s) => s.duration.toFixed(1)).join(" / ")} с, все строки помещаются в сцены, финал оставляет паузу`);
        return true;
      }
      const speed = Number(plan.voice_speed?.[bad.scene] ?? 1);
      if (speed < 1.15) {
        await setPlan(c, { voice_speed: setIdx(plan.voice_speed, bad.scene, speed + 0.1), voices: setIdx(plan.voices, bad.scene, null), cur: bad.scene }, { stage: "voice_submit" });
        await log(c, "voice_align", `Строка ${bad.scene + 1}: ${bad.duration.toFixed(1)} с > ${bad.limit.toFixed(1)} с — озвучиваю чуть быстрее`, "warn"); return true;
      }
      const repairs = Number(plan.story_repairs ?? 0);
      if (repairs >= MAX_REPAIRS) { await fail(c, "voice_align", `Строка ${bad.scene + 1} не помещается в сцену (${bad.duration.toFixed(1)} с)`); return true; }
      await setPlan(c, { story_draft: story(c), story_issues: [`Scene ${bad.scene + 1} narration lasts ${bad.duration.toFixed(1)}s spoken; it must fit ${bad.limit.toFixed(1)}s — shorten it.`], story_repairs: repairs + 1, voices: [], voice_speed: [] }, { stage: "story_plan" });
      return true;
    }
    case "frame_submit": {
      const i = cur(c), r = retry(c), sp = story(c), compact = plan.compact_prompt === true, fix = plan.frame_fix && !compact ? ` Fix: ${plan.frame_fix}.` : "";
      const ref = plan.frames?.[0]?.url;
      if (i === 0 && r === 0) await submitTask(c, `frame0_r0`, "fal", FAL.image, { prompt: framePrompt(sp, 0, true), aspect_ratio: "9:16", num_images: 1, output_format: "png" }, "frame_wait");
      else await submitTask(c, `frame${i}_r${r}`, "fal", FAL.imageEdit, { prompt: framePrompt(sp, i, false, compact) + fix, image_urls: [i === 0 ? plan.frame_prev : ref].filter(Boolean), aspect_ratio: "9:16", num_images: 1, output_format: "png" }, "frame_wait");
      return true;
    }
    case "frame_wait": {
      const i = cur(c), r = retry(c);
      const res = await pollAsset(c, `frame${i}_r${r}`, "frame", 0.04); if (!res) return true;
      const url = providerMedia(res["images"]?.[0]?.url);
      const qc = await vision(c, qcChecks(story(c), i, "start"), [url]);
      if (!qc.pass && canRetry(c, 0.04)) {
        await setPlan(c, { retry: r + 1, compact_prompt: false, frame_fix: qc.checks.filter((x) => !x.pass).map((x) => `${x.item} (${x.note})`).join("; "), frame_prev: url, frame_qc_log: [...(plan.frame_qc_log ?? []), { i, r, url, qc }] }, { stage: "frame_submit" });
        await log(c, "frame_wait", `Кадр ${i + 1}: не прошёл проверку (${qc.checks.filter((x) => !x.pass).map((x) => x.item).join(", ")}) — одна правка`, "warn"); return true;
      }
      const frames = setIdx(plan.frames, i, { url, qc, retries: r, defects: qc.checks.filter((x) => !x.pass).map((x) => x.item) });
      await setPlan(c, { frames, cur: i + 1 < SCENES ? i + 1 : 0, retry: 0, frame_fix: null, compact_prompt: false }, { stage: i + 1 < SCENES ? "frame_submit" : "shot_submit" });
      await log(c, "frame_wait", `Кадр ${i + 1}: ${qc.pass ? "проверка пройдена" : "принят с дефектами: " + frames[i].defects.join(", ")}`, qc.pass ? "info" : "warn");
      return true;
    }
    case "shot_submit": {
      const i = cur(c), r = retry(c), sp = story(c), emph = r ? ` The main subject must clearly perform the action: ${sp.scenes[i]!.action}.` : "";
      await submitTask(c, `shot${i}_r${r}`, "fal", FAL.i2v, { prompt: shotPrompt(sp, i) + emph, image_url: plan.frames[i].url, duration: String(SCENE_SECONDS), negative_prompt: SHOT_NEGATIVE, cfg_scale: 0.5 }, "shot_wait");
      return true;
    }
    case "shot_wait": {
      const i = cur(c), r = retry(c), res = await pollAsset(c, `shot${i}_r${r}`, "shot", 0.35); if (!res) return true;
      await setPlan(c, { shot_candidate: providerMedia(res["video"]?.url) }, { stage: "shot_check_submit" }); return true;
    }
    // End frame via permitted workflow-utilities/extract-nth-frame; duration read in-Worker from the MP4 itself
    // (fal-ai/ffmpeg-api/metadata is access-denied for this account).
    case "shot_check_submit": await submitTask(c, `shotframes${cur(c)}_r${retry(c)}`, "fal", FAL.frames, endFramesInput(plan.shot_candidate), "shot_check_wait"); return true;
    case "shot_check_wait": {
      const i = cur(c), r = retry(c), res = await pollTask(c, `shotframes${i}_r${r}`); if (!res) return true;
      const imgs: any[] = Array.isArray(res["images"]) ? res["images"] : [], last = imgs.at(-1)?.url;
      const end = typeof last === "string" ? providerMedia(last) : null;
      const duration = Number(inspectMp4(await deps.fetchMedia(plan.shot_candidate)).durationS);
      if (!end || !(duration >= SCENE_SECONDS - 0.3)) throw new Error(`Шот ${i + 1}: нет конечного кадра или длительность ${duration}`);
      const qc = await vision(c, [...qcChecks(story(c), i, "end"), `the subject visibly performed: ${story(c).scenes[i]!.action} (compare first image = start, second = end)`], [plan.frames[i].url, end], " (image 1 = shot start, image 2 = shot end)");
      if (!qc.pass && canRetry(c, 0.36)) {
        await setPlan(c, { retry: r + 1, shot_qc_log: [...(plan.shot_qc_log ?? []), { i, r, url: plan.shot_candidate, qc }] }, { stage: "shot_submit" });
        await log(c, "shot_check_wait", `Шот ${i + 1}: действие/конечное состояние не совпало (${qc.checks.filter((x) => !x.pass).map((x) => x.item).join(", ")}) — одна перегенерация`, "warn"); return true;
      }
      const shots = setIdx(plan.shots, i, { url: plan.shot_candidate, duration, end_frame: end, qc, retries: r, defects: qc.checks.filter((x) => !x.pass).map((x) => x.item) });
      await setPlan(c, { shots, shot_candidate: null, cur: i + 1 < SCENES ? i + 1 : 0, retry: 0 }, { stage: i + 1 < SCENES ? "shot_submit" : "sfx_submit" });
      await log(c, "shot_check_wait", `Шот ${i + 1}: ${qc.pass ? "действие и конечное состояние подтверждены" : "принят с дефектами: " + shots[i].defects.join(", ")}`, qc.pass ? "info" : "warn");
      return true;
    }
    case "sfx_submit": {
      const i = cur(c), s = story(c).scenes[i]!;
      await submitTask(c, `sfx${i}`, "fal", FAL.sfx, { prompt: `${s.sound}. ${s.sound_events.map((e) => `${e.event} at ${e.t}s`).join(", ")}`, duration: SCENE_SECONDS, negative_prompt: "music, speech, voice, singing, melody, hum, tone" }, "sfx_wait");
      return true;
    }
    case "sfx_wait": {
      const i = cur(c), res = await pollTask(c, `sfx${i}`); if (!res) return true;
      const sfx = setIdx(plan.sfx, i, { url: providerMedia(res["audio"]?.url) });
      await setPlan(c, { sfx, cur: i + 1 < SCENES ? i + 1 : 0 }, { stage: i + 1 < SCENES ? "sfx_submit" : "mix" }); return true;
    }
    case "mix": {
      const timing = plan.voice_timing;
      const voice = await Promise.all((plan.voices as any[]).map(async (v, i) => ({ pcm: decodeWav(await deps.fetchMedia(v.url)), at: timing.slots[i].start })));
      const sfx = await Promise.all((plan.sfx as any[]).map(async (s, i) => ({ pcm: decodeWav(await deps.fetchMedia(s.url)), at: i * SCENE_SECONDS })));
      const m = mixNarratorFirst(voice, sfx, SCENES * SCENE_SECONDS);
      if (m.stats.voiceRmsDb < -35) { await fail(c, "mix", "Голос диктора слишком тихий или отсутствует — сборка остановлена"); return true; }
      const path = `${job.user_id}/${job.id}/mix_r${job.render_attempt}.wav`;
      await c.store.uploadAsset(path, encodeWav16(m.samples, m.rate), "audio/wav");
      await setPlan(c, { audio_url: await c.store.signAsset(path), mix_path: path, mix_stats: m.stats, speech_duration: SCENES * SCENE_SECONDS, cur: 0 }, { stage: "shot_scale_submit" });
      await log(c, "mix", `Микс: голос ${m.stats.voiceRmsDb.toFixed(1)} dB, эффекты под голосом ${m.stats.sfxUnderVoiceDb.toFixed(1)} dB, пик ${m.stats.peakDb.toFixed(1)} dBFS`);
      return true;
    }
    // Renderer without fal-ai/ffmpeg-api (denied): each shot → identical 1080×1920 H.264 via permitted
    // scale-video, then an in-Worker remux joins them with the PCM mix; the shared scale step turns PCM into AAC.
    case "shot_scale_submit": { const i = cur(c); await submitTask(c, `shotscale${i}`, "fal", FAL.scale, scaleInput(plan.shots[i].url), "shot_scale_wait"); return true; }
    case "shot_scale_wait": {
      const i = cur(c), res = await pollTask(c, `shotscale${i}`); if (!res) return true;
      const shots = setIdx(plan.shots, i, { ...plan.shots[i], scaled_url: providerMedia(res["video"]?.url) });
      await setPlan(c, { shots, cur: i + 1 < SCENES ? i + 1 : 0 }, { stage: i + 1 < SCENES ? "shot_scale_submit" : "remux" }); return true;
    }
    case "remux": {
      const clips: Uint8Array[] = [];
      for (const sh of plan.shots as any[]) clips.push(await deps.fetchMedia(sh.scaled_url));
      const mix = decodeWav(await c.store.downloadAsset(plan.mix_path));
      const mov = muxClipsWithPcm(clips, { samples: mix.channels[0]!, rate: mix.rate });
      const path = `${job.user_id}/${job.id}/assembled_r${job.render_attempt}.mov`;
      await c.store.uploadAsset(path, mov, "video/quicktime");
      await setPlan(c, { composed_url: await c.store.signAsset(path), assembled_path: path }, { stage: "scale_submit" });
      await log(c, "remux", `Склейка: ${clips.length} шота + голос, ${(mov.byteLength / 1048576).toFixed(1)} МБ (без перекодирования, в приложении)`, "info", deps.now() - t);
      return true;
    }
  }
  return false;
}

/** Narration check on the subtitle transcription: share of script words heard. */
export function narrationCoverage(script: string, heard: string) {
  const w = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter((x) => x.length > 2);
  const h = new Set(w(heard)), s = w(script);
  return s.length ? s.filter((x) => h.has(x)).length / s.length : 0;
}
