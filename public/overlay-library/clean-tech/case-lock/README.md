# Game case + padlock (built-in Studio asset `builtin:case-lock`)
case.png and lock.png: two separate fal nano-banana illustrations + fal rembg cutouts
(request records in scripts/news-render/.asset-requests, keys case-lock-v1-*). Not Rockstar art.
before/active/result (case, preload glow) and lock-body/lock-shackle motion layers are offline
derivatives: `python3 scripts/news-render/prepare_case_lock_states.py`.
Demo: `env -u FAL_KEY python3 scripts/news-render/render_semantic_example.py scripts/news-render/size212/case-lock-cues.json`
-> public/gta6_212gb_case_lock.mp4 (original frames/cuts, AAC copied, old baked bar healed).
