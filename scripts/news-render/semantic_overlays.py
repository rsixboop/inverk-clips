"""Optional narration-timed RGBA object states, shared JSON contract with Studio."""
from pathlib import Path
from PIL import Image

def validate_cues(cues, duration):
    if not isinstance(cues, list):
        raise ValueError("overlay_cues must be a list (empty is valid)")
    for cue in cues:
        if not cue.get("purpose") or not cue.get("speech"):
            raise ValueError("Every cue needs purpose and exact speech anchor")
        times = [cue.get(k) for k in ("start", "action", "after", "end")]
        if any(not isinstance(t, (int, float)) for t in times) or not (0 <= times[0] < times[1] < times[2] < times[3] <= duration):
            raise ValueError("Cue requires start < action < after < end within narration")
        if not all(cue.get(k) for k in ("before", "active", "result")):
            raise ValueError("Cue needs three transparent illustrated states")
        box = cue.get("box", [])
        if len(box) != 4 or any(not isinstance(v, (int, float)) or not 0 <= v <= 1 for v in box) or box[2] <= 0 or box[3] <= 0 or box[0]+box[2]>1 or box[1]+box[3]>1:
            raise ValueError("Cue box must fit normalized frame")
        region=cue.get("fill_region",[0,0,1,1])
        if len(region)!=4 or any(not isinstance(v,(int,float)) or not 0<=v<=1 for v in region) or region[0]>=region[2] or region[1]>=region[3]:
            raise ValueError("Invalid illustrated fill region")
    return cues

def cue_state(cue, time):
    if time < cue["start"] or time >= cue["end"]:
        return None
    if time < cue["action"]:
        return "before", 0.0
    if time < cue["after"]:
        return "active", (time-cue["action"])/(cue["after"]-cue["action"])
    return "result", 1.0

def load_states(cues, root):
    states = {}
    for cue in cues:
        for name in ("before", "active", "result"):
            path = cue[name]
            if path not in states:
                file = (root / path.lstrip("/")).resolve()
                if not file.is_relative_to(root.resolve()):
                    raise ValueError("Asset outside library")
                with Image.open(file) as im:
                    if im.mode != "RGBA" or im.getextrema()[3][0] == 255:
                        raise ValueError("Cue asset must have real transparency")
                    states[path] = im.copy()
    return states

def composite(frame, cues, states, time):
    frame = frame.convert("RGBA")
    for cue in cues:
        state = cue_state(cue, time)
        if state is None:
            continue
        name, progress = state
        x,y,w,h = cue["box"]
        size = (round(frame.width*w), round(frame.height*h))
        image = states[cue[name]].resize(size, Image.Resampling.LANCZOS)
        # Active is a deterministic reveal of illustrated state, not AI text/fill.
        if name == "active":
            base = states[cue["before"]].resize(size, Image.Resampling.LANCZOS)
            region = cue.get("fill_region", [0,0,1,1])
            left,top,right,bottom = [round(v*size[i%2]) for i,v in enumerate(region)]
            width = round((right-left)*progress)
            base.paste(image.crop((left,top,left+width,bottom)), (left,top))
            image = base
        frame.alpha_composite(image, (round(frame.width*x),round(frame.height*y)))
    return frame.convert("RGB")