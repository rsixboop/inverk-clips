export const operations: Record<string,string> = {
  inspectClip: 'Describe real sampled frames of a ready MP4. Input {id: clip UUID, source: live for live_highlights or local for local_candidates}. Returns timestamped visual description without audio.',
  "tickJobs": "{}",
  "providerStatus": "{}",
  "createJob": "z.object({\n  idempotencyKey: z.string().min(8).max(64), mode: z.enum([\"niche\", \"link\", \"mixed\"]), prompt: z.string().max(2000),\n  language: z.enum([\"en\", \"ru\", \"uk\"]), targetSeconds: z.number().int().min(10).max(90), audioMode: z.enum([\"voiceover\", \"original\"]),\n  reviewBeforeRender: z.boolean(), approveSources: z.boolean(), route: z.enum([\"compose\", \"clip\", \"story\"]), nicheId: z.string().uuid().nullable(), sourceId: z.string().uuid().nullable(),\n})",
  "jobAction": "z.object({ jobId: z.string().uuid(), action: z.enum([\"cancel\", \"pause\", \"resume\", \"retry\", \"regenerate\", \"approve\", \"rerender\"]), confirmResubmit: z.boolean().optional() })",
  "selectCandidates": "(d: unknown) => z.object({ jobId: z.string().uuid(), selected: z.array(z.number().int().min(0).max(50)).max(50) }).parse(d)",
  "pickClip": "(d: unknown) => z.object({ jobId: z.string().uuid(), index: z.number().int().min(0).max(50) }).parse(d)",
  "getOutputUrl": "(d: unknown) => z.object({ jobId: z.string().uuid(), download: z.boolean() }).parse(d)",
  "addUrlSource": "z.object({ url: z.string().max(2000), permission: z.enum([\"owned\", \"licensed\", \"permitted\", \"unknown\"]), note: z.string().max(500) })",
  "saveStoryFeedback": "(d: unknown) => z.object({ jobId: z.string().uuid(), text: z.string().min(2).max(1000) }).parse(d)",
  "setJobBudget": "(d: unknown) => z.object({ jobId: z.string().uuid(), budgetUsd: z.number().finite() }).parse(d)",
  "liveStatus": "{}",
  "addMonitor": "z.object({ input: z.string().min(2).max(300), media_mode: z.enum([\"timestamp_only\", \"recorder\", \"recording_url\"]), recording_url: z.string().max(1000).optional(), rights: z.boolean() })",
  "setMediaMode": "(d: unknown) => z.object({ id: z.string().uuid(), media_mode: z.enum([\"timestamp_only\", \"recorder\"]), rights: z.boolean() }).parse(d)",
  "monitorAction": "(d: unknown) => z.object({ id: z.string().uuid(), action: z.enum([\"start\", \"stop\"]) }).parse(d)",
  "tickLive": "{}",
  "highlightUrl": "(d: unknown) => z.object({ id: z.string().uuid() }).parse(d)",
  "candidateUrl": "(d: unknown) => z.object({ id: z.string().uuid() }).parse(d)",
  "resolveNewsOverlay": "input=>z.object({batch:z.string().regex(/^[a-f0-9]{64}$/),narration:z.string().max(140),intent:z.unknown()}).parse(input)",
  "alignNewsSpeech": "input=>z.object({batch:z.string().regex(/^[a-f0-9]{64}$/),audio:z.string().max(8_000_000).optional(),mime:z.enum([\"audio/wav\",\"audio/mpeg\",\"audio/mp4\"]).default(\"audio/wav\")}).parse(input)",
  "findNewswire": "{}",
  "scriptFromArticle": "(d) => z.object({ url: z.string().max(300).refine(isNewswireUrl, \"Только https://www.rockstargames.com/newswire/article/…\"),language:z.enum([\"EN\",\"RU\",\"UK\"]).default(\"EN\") }).parse(d)",
  "findGtaNews": "{}",
  "submitNewsVoice": "(d) => z.object({ text: z.string().min(10).max(1200) }).parse(d)",
  "pollNewsVoice": "(d) => z.object({ requestId: z.string().regex(/^[\\w-]{8,80}$/) }).parse(d)",
  "enqueueVpsOp": "(d: unknown) => z.object({ agent_id: z.string().uuid(), op: z.string(), args: z.unknown(), idem_key: z.string().min(8).max(120) }).parse(d)"
};
export const fields: Record<string,string> = {
  "job_events": "id,job_id,user_id,stage,level,message,duration_ms,created_at",
  "jobs": "id,user_id,mode,prompt,language,target_seconds,audio_mode,review_before_render,niche_id,source_id,status,stage,failed_stage,script,caption,error,render_id,render_attempt,attempts,next_attempt_at,lock_until,output_path,output_mime,output_bytes,output_url_expires,created_at,updated_at,finished_at,route,provider_project_id,approve_sources,submit_state,deadline_at,workflow_version",
  "live_highlights": "id,monitor_id,user_id,start_at,end_at,peak_at,offset_s,score,chatters,emotes,status,detail,attempts,job_id,output_path,created_at,updated_at,trigger,reason",
  "live_monitors": "id,user_id,platform,input,channel_id,channel_title,live_video_id,live_chat_id,status,status_detail,media_mode,rights_confirmed,next_poll_at,last_poll_at,stream_started_at,messages_seen,created_at,stopped_at,recorder_state",
  "local_candidates": "id,user_id,channel,status,window_info,score,reason,captions,caption_note,output_path,job_id,review,detail,created_at,updated_at",
  "local_footage": "id,user_id,channel,rel_path,session,file_name,size_bytes,duration_s,start_at,aligned,status,detail,updated_at",
  "niches": "id,user_id,name,description,default_language,created_at",
  "posting_queue": "id,user_id,job_id,account_id,status,created_at",
  "social_accounts": "id,user_id,platform,handle,status,created_at",
  "sources": "id,user_id,kind,url,storage_path,title,mime,bytes,duration_s,permission,permission_note,status,status_note,created_at,provider,license,preview_url,attribution,external_id",
  "vps_agents": "id"
};
export const editable: Record<string,string> = {
  "niches": "name,description,default_language",
  "sources": "title,permission,permission_note",
  "jobs": "caption,script",
  "local_candidates": "review",
  "social_accounts": "platform,handle"
};
