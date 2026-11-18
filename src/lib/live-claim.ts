// Columns the recorder receives per claimed highlight. The recorder (public/recorder/recorder.py) gates on
// `chatters`, so it MUST be projected here; scripts/live-recorder/test_recorder.py parses this list.
export const CLAIM_COLUMNS = "id,monitor_id,start_at,end_at,peak_at,offset_s,attempts,score,chatters,emotes,trigger,reason";
