#!/usr/bin/env python3
"""Transparent, reusable *overlay objects* for news footage (not video scenes).

fal nano-banana creates ONE isolated illustrated object -> fal rembg creates a
real RGBA PNG -> PIL validates cutout and trims transparent margins. All assets
are small compositing elements; none is allowed to replace underlying footage.
Request IDs persist using the project's durable/ambiguity-safe queue helper.
"""
from __future__ import annotations
import hashlib, json, os, time
from pathlib import Path
from PIL import Image, ImageStat
from auto_assets import ROOT, HERE, queue, download, save, load, styles, style_signature

LIB = ROOT / "public/overlay-library"
INDEX = LIB / "index.json"
MODEL = "fal-ai/nano-banana"
REMOVE_BG = "fal-ai/imageutils/rembg"
# Conservative estimate for per-asset spend accounting; provider billing is authoritative.
EST_IMAGE_USD = 0.04
EST_REMOVAL_USD = 0.03
MAX_OVERLAYS = 7

def visual_prompt(request: dict, style: dict) -> str:
    # Deliberately NO scene/environment. Style affects the object's design only.
    return (
        "Product asset sheet: exactly ONE small, self-contained, visually stunning "
        "three-dimensional editorial object, isolated in the exact center. "
        f"OBJECT: {request['object']}. "
        f"Art direction: {style['label']}; colors {', '.join(style['palette'])}; "
        f"surface treatment {style['materials']}; lighting {style['lighting']}. "
        "Object has complete, clean, closed outline and physically plausible geometry. "
        "The object fills 50 to 70 percent of the square image. "
        "PURE SIMPLE SOLID PALE GRAY BACKGROUND, no scene, landscape, palm trees, "
        "people, floor, frame, border, titles, typography, labels, icons in corners, "
        "logo or watermark, extra objects, background shadows or screenshots. "
        "Premium physically illustrated editorial object, NOT a sticker or UI box. "
        "No text of any kind."
    )

def signature(request: dict, style: dict) -> str:
    # A new shape/design request must NOT reuse an old semantic key blindly.
    material = {"concept": request["semantic_key"], "object": request["object"],
                "style": style_signature(style)}
    return hashlib.sha256(json.dumps(material, sort_keys=True).encode()).hexdigest()[:15]

def alpha_qa(path: Path, normalize: bool = True) -> dict:
    with Image.open(path) as src:
        if src.width < 360 or src.height < 360:
            raise ValueError("overlay image too small")
        im = src.convert("RGBA")
        alpha = im.getchannel("A")
        bbox = alpha.point(lambda p: 255 if p >= 50 else 0).getbbox()
        if bbox is None:
            raise ValueError("transparent object has no opaque content")
        w, h = im.size
        edge = alpha.getpixel((0, 0)) + alpha.getpixel((w - 1, 0)) + alpha.getpixel((0, h - 1)) + alpha.getpixel((w - 1, h - 1))
        if edge > 250:
            raise ValueError("background removal failed: opaque corners")
        bw, bh = bbox[2] - bbox[0], bbox[3] - bbox[1]
        coverage = bw * bh / (w * h)
        if not 0.035 < coverage < 0.92:
            raise ValueError(f"cutout bounding box implausible: {coverage:.2f}")
        margin = max(18, int(0.06 * max(bw, bh)))
        bounds = (max(0, bbox[0] - margin), max(0, bbox[1] - margin),
                  min(w, bbox[2] + margin), min(h, bbox[3] + margin))
        if normalize:
            trimmed = im.crop(bounds)
            # One-time normalization when asset is created. Reuse/QC must NOT
            # mutate the saved PNG or repeated runs will shrink it.
            trimmed.thumbnail((640, 640), Image.Resampling.LANCZOS)
            if min(trimmed.size) < 140:
                raise ValueError("visible object cropped too small")
            trimmed.save(path, format="PNG", optimize=True)
            size = list(trimmed.size)
        else:
            size = [w, h]
        return {"alpha": True, "coverage": round(coverage, 3),
                "size": size, "corner_alpha_sum": edge}

def ensure_overlays(requests: list[dict], style_id: str, episode_id: str,
                    budget_usd: float = 3.0) -> tuple[list[dict], float]:
    if not requests:
        return [], 0.0
    if len(requests) > MAX_OVERLAYS:
        raise ValueError(f"max {MAX_OVERLAYS} overlays")
    presets = styles()
    if style_id not in presets:
        raise ValueError(f"unknown style {style_id}")
    style = presets[style_id]
    index = load(INDEX, {"schema_version": 2, "kind": "transparent_overlays", "assets": []})
    selected, spent, selected_ids = [], 0.0, set()
    for req in requests:
        if not isinstance(req.get("semantic_key"), str) or not req.get("object"):
            raise ValueError("overlay needs semantic_key + object")
        ident = signature(req, style)
        matching = [a for a in index["assets"] if a["id"] == ident and a["id"] not in selected_ids]
        old = matching[0] if matching else None
        target = LIB / style_id / ident / "overlay.png"
        if old and old.get("status") == "ready" and target.exists() and (
                old.get("uses", 0) < old.get("max_uses", 5)
                or episode_id in old.get("episodes", [])):
            # Re-check alpha, do not trust a metadata flag without the PNG.
            check = alpha_qa(target, normalize=False)
            old["qc"] = check
            if episode_id not in old.get("episodes", []):
                old.setdefault("episodes", []).append(episode_id)
                old["uses"] = len(old["episodes"])
            old["last_used_at"] = time.strftime("%Y-%m-%d")
            save(INDEX, index)
            selected.append(old); selected_ids.add(ident)
            print("REUSE_OVERLAY", ident, req["semantic_key"], flush=True)
            continue
        # A pre-existing rejected concept must NOT silently be recreated at
        # arbitrary cost. Change the object description for a new variation.
        if old and old.get("status") == "rejected":
            raise RuntimeError(f"Overlay {ident} failed QC; revise the object's design to retry")
        if spent + EST_IMAGE_USD + EST_REMOVAL_USD > budget_usd:
            raise RuntimeError("overlay budget exceeded; no additional paid call")
        if old and old.get("status") == "pending":
            item = old  # resume stored request IDs rather than submitting duplicates
        else:
            item = {"id": ident, "semantic_key": req["semantic_key"], "object": req["object"],
                    "style": style_id, "path": str(target.relative_to(ROOT)),
                    "status": "pending", "max_uses": 5, "uses": 0, "episodes": []}
            index["assets"].append(item)
            save(INDEX, index)
        original = target.with_name("original.png")
        try:
            if not original.exists():
                result = queue(MODEL, {"prompt": visual_prompt(req, style),
                            "num_images": 1, "aspect_ratio": "1:1",
                            "output_format": "png"}, ident + "-overlay-image")
                download(result["images"][0]["url"], original)
            if not target.exists():
                # rembg returns an actual PNG with an alpha channel.
                src = queue(MODEL, {"prompt": visual_prompt(req, style),
                            "num_images": 1, "aspect_ratio": "1:1",
                            "output_format": "png"}, ident + "-overlay-image")
                source_url = src["images"][0]["url"]
                cutout = queue(REMOVE_BG, {"image_url": source_url}, ident + "-remove-bg")
                download(cutout["image"]["url"], target)
            item["qc"] = alpha_qa(target)
            item["status"] = "ready"
            item["uses"] = 1
            item["episodes"] = [episode_id]
            item["created_at"] = time.strftime("%Y-%m-%d")
            spent += EST_IMAGE_USD + EST_REMOVAL_USD
            selected.append(item); selected_ids.add(ident)
            print("NEW_TRANSPARENT_OVERLAY", ident, item["qc"], flush=True)
            save(INDEX, index)
        except Exception as error:
            # Pending provider jobs are recoverable. Only known cutout quality
            # failures are rejected; transient queue errors retain state + IDs.
            if isinstance(error, ValueError):
                item["status"] = "rejected"
            item["last_error"] = str(error)[:250]
            save(INDEX, index)
            raise
    return selected, round(spent, 2)
