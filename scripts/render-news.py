#!/usr/bin/env python3
"""Repeatable render: python3 scripts/render-news.py [plan.json]. Downloads clips (cached in /tmp), renders frames with PIL, muxes loudnormed voice.
Clips play at native 30fps, speed 1.0; an insert never exceeds its source length (asserted); no loops."""
import json, subprocess, sys, os, math, urllib.request
from PIL import Image, ImageDraw, ImageFont, ImageFilter
P = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "scripts/news-render/plan.json"))
O = P["output"]; W, H, FPS = O["w"], O["h"], O["fps"]
FONT = subprocess.run(["fc-match", "-f", "%{file}", "DejaVu Sans Condensed:bold"], capture_output=True, text=True).stdout
F = lambda s: ImageFont.truetype(FONT, s)
LIME, WHITE, BG = (190, 242, 62), (255, 255, 255), (22, 24, 26)
CACHE = "/tmp/news-render-src"; os.makedirs(CACHE, exist_ok=True)

def clip_frames(name, n, allow_partial=False):
    cx = P.get("crop_x", {}).get(name, 0.5)
    local_path = f"public/gta6-media/c-{name}.mp4"
    path = local_path if os.path.exists(local_path) else f"{CACHE}/{name}.mp4"
    if not os.path.exists(path): urllib.request.urlretrieve(P["clip_sources"][name], path)
    fr = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-count_frames", "-show_entries", "stream=nb_read_frames,r_frame_rate", "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip().split(",")
    assert fr[0] == f"{FPS}/1", f"{name}: source fps {fr[0]} != {FPS} (would need resampling)"
    available = int(fr[1])
    if allow_partial:
        n = min(n, available)
    else:
        assert n <= available, f"{name}: insert {n} frames > source {fr[1]} — refuse to slow down or loop"
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}:(iw-{W})*{cx}:(ih-{H})/2", "-frames:v", str(n), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
    sz = W * H * 3; return [Image.frombytes("RGB", (W, H), raw[i*sz:(i+1)*sz]) for i in range(n)]

def caption(d, text, y=H*0.70, size=64):
    # |word| = lime accent; wraps on spaces
    words = text.split(" "); f = F(size); lines, cur = [], []
    for w in words:
        if d.textlength(" ".join(cur + [w]).replace("|", ""), font=f) > W - 80 and cur: lines.append(cur); cur = []
        cur.append(w)
    lines.append(cur)
    for li, ln in enumerate(lines):
        tw = d.textlength(" ".join(ln).replace("|", ""), font=f); x = (W - tw) / 2; yy = y + li * size * 1.15
        for w in ln:
            hl = w.startswith("|") or w.endswith("|"); w2 = w.replace("|", "")
            d.text((x, yy), w2, font=f, fill=LIME if hl else WHITE, stroke_width=6, stroke_fill=(0, 0, 0))
            x += d.textlength(w2 + " ", font=f)

def wrap(d, text, f, maxw):
    out, cur = [], ""
    for w in text.split():
        if d.textlength((cur + " " + w).strip(), font=f) > maxw: out.append(cur); cur = w
        else: cur = (cur + " " + w).strip()
    return out + [cur]

_BG = {}
def bg(p, seg=None, underlay=None):
    # Use moving footage as the canvas for information overlays.
    # No frame repetition or slowed footage: each insert consumes native 30 fps.
    if underlay is not None:
        im = Image.blend(underlay.copy(), Image.new("RGB", (W, H), (0, 0, 0)), 0.48)
        return im, ImageDraw.Draw(im)
    src = seg.get("bg") if seg else None
    if src:
        if src not in _BG:
            b = Image.open(src).convert("RGB"); s0 = max(W / b.width, H / b.height) * 1.12
            _BG[src] = b.resize((int(b.width * s0), int(b.height * s0)), Image.LANCZOS).filter(ImageFilter.GaussianBlur(2))
        b = _BG[src]; z = 1 + 0.06 * p; bw, bh = int(W * 1.06 / z), int(H * 1.06 / z)
        x0, y0 = (b.width - bw) // 2, (b.height - bh) // 2
        im = Image.blend(b.crop((x0, y0, x0 + bw, y0 + bh)).resize((W, H)), Image.new("RGB", (W, H), (0, 0, 0)), 0.62)
        return im, ImageDraw.Draw(im)
    im = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(im)
    for i in range(0, H, 40): d.line([(0, i + int(p*40) % 40), (W, i + int(p*40) % 40)], fill=(30, 33, 36), width=1)
    return im, d

def render(seg, k, n, underlay=None):
    p = k / max(1, n - 1); kind = seg["kind"]
    if kind == "title":
        im, d = bg(p, seg, underlay)
        for i, l in enumerate(seg["lines"]):
            s = 118 if i == 0 else 110; pop = min(1, (k - i * 8) / 6) if k >= i * 8 else (0 if i else 1)
            if pop <= 0: continue
            f = F(int(s * (0.85 + 0.15 * pop))); tw = d.textlength(l, font=f)
            d.text(((W - tw) / 2, 380 + i * 175), l, font=f, fill=LIME if i == 2 else WHITE, stroke_width=4, stroke_fill=(0, 0, 0))
        d.rectangle([60, 300, 60 + int((W - 120) * min(1, p * 2)), 312], fill=LIME)
        return im
    if kind == "quote":
        im, d = bg(p, seg, underlay); f = F(49); x0 = 70 + int(16 * (1 - min(1, p * 6)))
        # Compact lower-third proof label: retain readable source but don't
        # replace the whole video with an oversized static quotation slide.
        d.rounded_rectangle([40, 665, W - 40, 1170], 24, fill=(27, 30, 33), outline=LIME, width=4)
        d.text((x0, 688), "OFFICIAL SOURCE", font=F(34), fill=LIME)
        for i, l in enumerate(wrap(d, seg["quote"], f, W - 160)[:5]): d.text((x0 + 3, 755 + i * 69), l, font=f, fill=WHITE)
        d.text((x0, 1100), seg["source"], font=F(32), fill=LIME); return im
    if kind == "diagram":
        im, d = bg(p, seg, underlay); cx = W // 2
        d.ellipse([cx - 170, 250, cx + 170, 470], fill=(50, 54, 58), outline=LIME, width=5); d.text((cx - 95, 330), "CLOUD", font=F(60), fill=WHITE)
        d.text((cx - 175, 480), "Series S settings", font=F(38), fill=LIME)
        d.rounded_rectangle([cx - 200, 780, cx + 200, 920], 18, fill=(50, 54, 58), outline=WHITE, width=4); d.text((cx - 150, 820), "XBOX ONE", font=F(64), fill=WHITE)
        d.line([(cx, 540), (cx, 770)], fill=WHITE, width=6); d.polygon([(cx - 22, 745), (cx + 22, 745), (cx, 775)], fill=WHITE)
        for j in range(3):
            yy = 540 + ((p * 2 + j / 3) % 1) * 220; d.ellipse([cx - 14, yy - 14, cx + 14, yy + 14], fill=LIME)
        caption(d, seg["caption"], y=1020); return im
    if kind == "bars":
        im, d = bg(p, seg, underlay)
        for j in range(5):
            on = (k // 6 + j) % 5 < 3; h = 70 + j * 70
            d.rectangle([150 + j * 90, 800 - h, 210 + j * 90, 800], fill=LIME if on else (70, 74, 78))
        caption(d, seg["caption"], y=950); return im
    if kind == "end":
        im, d = bg(p, seg, underlay)
        for i, l in enumerate(seg["lines"]):
            f = F(78 if i != 1 else 70); tw = d.textlength(l, font=f); off = int(30 * max(0, 1 - k / 8 + i * 0.3))
            d.text(((W - tw) / 2, 330 + i * 120 + off), l, font=f, fill=LIME if i == 1 else WHITE, stroke_width=4, stroke_fill=(0, 0, 0))
        f = F(34)
        for i, l in enumerate(wrap(d, seg["note"], f, W - 120)): d.text((60, 820 + i * 46), l, font=f, fill=WHITE)
        d.text((60, 1120), "Sources: Xbox Wire, Rockstar Newswire", font=F(28), fill=(170, 175, 180))
        return im
    raise ValueError(kind)

def render_beat(seg, k, n, underlay=None):
    """V4: b-roll first. Short factual labels stay over footage; never cover the
    screen with a standalone quote/card. Every beat has an explicit cut boundary."""
    p = k / max(n - 1, 1)
    if underlay is not None:
        im = underlay.copy()
    else:
        # Distinct photo per beat, lightly animated rather than a static freeze.
        im, _ = bg(p, seg, None)
    # Text only occupies the lower third; top two-thirds show the scene.
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for row in range(16):
        y0 = H - 440 + row * 26
        alpha = int(12 + row * 8)
        draw.rectangle([0, y0, W, min(H, y0 + 27)], fill=(10, 13, 15, min(170, alpha)))
    draw.rounded_rectangle([42, 76, 244, 121], radius=12, fill=(8, 10, 12, 180))
    draw.text((58, 83), "GTA VI NEWS", font=F(25), fill=LIME)
    label = seg.get("caption", "")
    # Drop the legacy |highlight| delimiters for concise editorial typography.
    label = label.replace("|", "").strip()
    font = F(70 if len(label) < 26 else 59)
    lines = wrap(draw, label, font, W - 90)[:3]
    yy = H - 335 - 74 * (len(lines) - 1)
    for line in lines:
        draw.text((W / 2 - draw.textlength(line, font=font)/2, yy), line, font=font,
                  fill=WHITE, stroke_fill=(0, 0, 0, 195), stroke_width=2)
        yy += 80
    source = seg.get("source_label")
    if source:
        draw.text((48, H - 52), source, font=F(28), fill=(208, 214, 220, 255))
    return Image.alpha_composite(im.convert("RGBA"), overlay).convert("RGB")

# V2-based editorial cut: footage and official screenshots stay full-screen,
# short overlays only at factual beats. It deliberately does not use cards.
_CINEMA = {}
def cinema_frame(seg, k, n, motion=None):
    p = k / max(1, n - 1)
    if motion is not None:
        im = motion.copy()
    else:
        path = seg["bg"]
        if path not in _CINEMA:
            _CINEMA[path] = Image.open(path).convert("RGB")
        source = _CINEMA[path]
        # Source images stay proportional; focus is selected per official screenshot.
        s = max(W / source.width, H / source.height) * (1.04 + 0.045 * p)
        rw, rh = math.ceil(source.width * s), math.ceil(source.height * s)
        target = source.resize((rw, rh), Image.Resampling.BICUBIC)
        focus = min(1.0, max(0.0, float(seg.get("focus_x", 0.5))))
        x = round((rw - W) * min(1.0, max(0.0, focus + 0.035 * (p - 0.5))))
        y = round((rh - H) / 2)
        im = target.crop((x, y, x + W, y + H))
    label = seg.get("caption", "").strip()
    source_label = seg.get("source_label", "").strip()
    if not label and not source_label: return im
    # Light bottom fade for reading; no opaque slide or centered title card.
    fade = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(fade)
    for y in range(H - 485, H):
        alpha = round(175 * ((y - (H - 485)) / 485) ** 1.2)
        d.line([(0, y), (W, y)], fill=(0, 0, 0, alpha), width=1)
    if label:
        f = F(59 if len(label) >= 23 else 67)
        lines = wrap(d, label, f, W - 100)[:2]
        for j, line in enumerate(lines):
            d.text((48, H - 270 + 77 * j), line, font=f, fill=WHITE, stroke_width=2, stroke_fill=(10, 10, 10, 110))
        d.line([(48, H - 294), (140, H - 294)], fill=LIME, width=6)
    if source_label:
        d.text((48, H - 72), source_label, font=F(30), fill=LIME)
    return Image.alpha_composite(im.convert("RGBA"), fade).convert("RGB")

def supporting_frames(seg, n):
    names = seg.get("underlay_clips") or []
    if not names:
        return [None] * n
    out = []
    for idx, name in enumerate(names):
        target = round(n * (idx + 1) / len(names))
        count = target - len(out)
        if count <= 0:
            continue
        try:
            # Every visual beat is real source footage at native speed.
            frames = clip_frames(name, count)
        except (AssertionError, OSError, ValueError) as e:
            print(f"underlay {name} not usable ({e}); animated image fallback", file=sys.stderr)
            frames = [None] * count
        out.extend(frames)
    assert len(out) == n
    return out

def main():
    enc = subprocess.Popen(["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
        "-i", P["voice"]["file"], "-filter_complex", f"[1:a]atrim=0:{O['end']},afade=t=out:st={O['end']-0.25}:d=0.25,loudnorm={P['voice']['loudnorm']},aresample=48000[a]",
        "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "27", "-maxrate", "2600k", "-bufsize", "3900k", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-t", str(O["end"]), O["file"]], stdin=subprocess.PIPE)
    total = 0
    for seg in P["segments"]:
        a = round(seg["t"][0] * FPS); b = round(seg["t"][1] * FPS); n = b - a; assert a == total, f"gap at {seg['t']}"
        if seg["kind"] == "cinematic":
            frames = []
            if seg.get("clip"):
                try:
                    frames = clip_frames(seg["clip"], n, allow_partial=True)
                    if len(frames) < n:
                        print(f"cinematic {seg['clip']}: {len(frames)}/{n} native frames, animated photo for remaining {n-len(frames)}", file=sys.stderr)
                except (AssertionError, OSError, ValueError) as e:
                    print(f"cinematic clip {seg['clip']} unavailable ({e}); official still fallback", file=sys.stderr)
            for k in range(n):
                enc.stdin.write(cinema_frame(seg, k, n, frames[k] if k < len(frames) else None).tobytes())
        elif seg["kind"] == "beat":
            underlays = supporting_frames(seg, n)
            for k in range(n):
                enc.stdin.write(render_beat(seg, k, n, underlays[k]).tobytes())
        elif seg["kind"] == "clip":
            for im in clip_frames(seg["clip"], n): d = ImageDraw.Draw(im); caption(d, seg["caption"]); d.text((24, 24), "Official Rockstar clip", font=F(26), fill=WHITE, stroke_width=2, stroke_fill=(0, 0, 0)); enc.stdin.write(im.tobytes())
        else:
            underlays = supporting_frames(seg, n)
            for k in range(n):
                enc.stdin.write(render(seg, k, n, underlays[k]).tobytes())
        total = b
    enc.stdin.close(); assert enc.wait() == 0; print("wrote", O["file"], total, "frames")
main()
