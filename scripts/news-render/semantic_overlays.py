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
        if cue.get("fill_dir","right") not in ("right","up"):
            raise ValueError("fill_dir must be right or up")
        for layer in cue.get("layers",[]):
            keys=layer.get("keys",[])
            if not layer.get("src") or len(keys)<1 or any(len(k)!=5 or not all(isinstance(v,(int,float)) for v in k) for k in keys) or any(a[0]>=b[0] for a,b in zip(keys,keys[1:])):
                raise ValueError("Layer needs src and ordered [t,dx,dy,scale,alpha] keys")
            if cue["after"]+keys[-1][0]>cue["end"]:
                raise ValueError("Layer motion must settle before cue end")
    return cues

def settle(p):
    """easeOutBack: arrives, overshoots slightly, settles (visible at phone size)."""
    c=1.9; p-=1
    return 1+(c+1)*p**3+c*p**2

def layer_pose(layer, rel):
    """Pose at seconds relative to cue['after']: (dx,dy,scale,alpha)."""
    keys=layer["keys"]
    if rel<=keys[0][0]: return tuple(keys[0][1:])
    for a,b in zip(keys,keys[1:]):
        if rel<b[0]:
            p=(rel-a[0])/(b[0]-a[0]); e=settle(p) if layer.get("ease","settle")=="settle" else p
            return tuple(a[i]+(b[i]-a[i])*(min(p,1) if i==4 else e) for i in range(1,5))
    return tuple(keys[-1][1:])

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
        for path in [cue[n] for n in ("before","active","result")]+[l["src"] for l in cue.get("layers",[])]:
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
            if cue.get("fill_dir")=="up":
                h0=round((bottom-top)*progress)
                base.alpha_composite(image.crop((left,bottom-h0,right,bottom)), (left,bottom-h0))
            else:
                width = round((right-left)*progress)
                base.alpha_composite(image.crop((left,top,left+width,bottom)), (left,top))
            image = base
        ox,oy=round(frame.width*x),round(frame.height*y)
        frame.alpha_composite(image, (ox,oy))
        for layer in cue.get("layers",[]):
            dx,dy,scale,alpha=layer_pose(layer,time-cue["after"])
            if alpha<=0.01: continue
            im=states[layer["src"]]
            lw,lh=max(1,round(size[0]*scale)),max(1,round(size[1]*scale))
            im=im.resize((lw,lh),Image.Resampling.LANCZOS)
            if alpha<1: im.putalpha(im.getchannel("A").point(lambda v:int(v*alpha)))
            frame.alpha_composite(im,(ox+round(dx*size[0]+(size[0]-lw)/2),oy+round(dy*size[1]+(size[1]-lh)/2)))
    return frame.convert("RGB")