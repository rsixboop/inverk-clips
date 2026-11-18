"""Two separate fal illustrations (game case, closed padlock) -> rembg RGBA.
Durable IDs via auto_assets.queue; existing files are reused, never resubmitted."""
from auto_assets import ROOT, queue, download
from overlay_assets import MODEL, REMOVE_BG, alpha_qa
OUT=ROOT/"public/overlay-library/clean-tech/case-lock"
BG="Isolated in the exact center on a PURE FLAT PALE GRAY background, no scene, no floor, no shadow, no extra objects. No text, letters, numbers, logos or watermark anywhere."
ASSETS={
 "case":"Premium 3D illustration of ONE compact upright dark charcoal video game box case standing vertically, seen in slight 3/4 perspective showing the thin spine edge. Glossy front cover with painterly key art: neon pink-orange tropical sunset over a palm-lined coastal city skyline, cinematic. Thin lime-green accent line on the spine. Realistic plastic case with rounded corners, crisp edges, fills 60 percent of the image height. "+BG,
 "lock":"Premium 3D illustration of ONE chunky heavy padlock, CLOSED and LOCKED, rendered in 3/4 perspective. Solid brushed gunmetal steel body with subtle lime-green edge highlight and a keyhole; thick polished chrome U-shaped shackle with BOTH legs clearly inserted and seated inside the top of the body. Coherent physically correct geometry, single lock. "+BG,
}
for name,prompt in ASSETS.items():
    target=OUT/f"{name}.png"
    if target.exists(): print("REUSE",name); continue
    src=queue(MODEL,{"prompt":prompt,"num_images":1,"aspect_ratio":"3:4" if name=="case" else "1:1","output_format":"png"},f"case-lock-v1-{name}-image")
    download(src["images"][0]["url"],OUT/f"{name}-original.png")
    cut=queue(REMOVE_BG,{"image_url":src["images"][0]["url"]},f"case-lock-v1-{name}-rembg")
    download(cut["image"]["url"],target); print(name,alpha_qa(target))
