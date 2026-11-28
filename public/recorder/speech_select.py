"""Speech-based moment selection from the rolling buffer (scaffold, not wired yet).

Pipeline (planned):
  1. transcribe each finalized ~10s buffer segment in background -> Utterance list
  2. stitch_utterances(): merge phrases cut at segment boundaries
  3. every ~60s score_windows() over the recent dialogue (cheap heuristics here;
     later an LLM judge replaces/extends `heuristic_score`)
  4. pick_cut(): from setup (question/trigger) to reaction, padded, bounded.
Pure functions only, so the recorder can call them without new dependencies.
"""
from dataclasses import dataclass, field
from typing import Callable, List, Optional

@dataclass
class Utterance:
    start: float  # stream-relative seconds
    end: float
    text: str

@dataclass
class Window:
    start: float
    end: float
    utterances: List[Utterance] = field(default_factory=list)
    score: float = 0.0
    reasons: List[str] = field(default_factory=list)

REACTION = ("wow", "what", "no way", "omg", "holy", "lol", "ахах", "что", "капец", "жесть", "блин", "офиг")
TRIGGER = ("?", "look", "watch", "смотри", "гляди", "давай")

def stitch_utterances(items: List[Utterance], gap: float = 0.4) -> List[Utterance]:
    """Join phrases split by segment boundaries (small gap, no sentence end)."""
    out: List[Utterance] = []
    for u in sorted(items, key=lambda x: x.start):
        if not u.text.strip():
            continue
        if out and u.start - out[-1].end <= gap and not out[-1].text.rstrip().endswith((".", "!", "?")):
            p = out[-1]
            out[-1] = Utterance(p.start, max(p.end, u.end), f"{p.text.rstrip()} {u.text.strip()}")
        else:
            out.append(Utterance(u.start, u.end, u.text.strip()))
    return out

def heuristic_score(w: Window) -> None:
    text = " ".join(u.text.lower() for u in w.utterances)
    span = max(w.end - w.start, 1e-6)
    talk = sum(u.end - u.start for u in w.utterances) / span
    trig = sum(text.count(t) for t in TRIGGER)
    react = sum(text.count(r) for r in REACTION)
    w.score = min(talk, 1.0) * 0.3 + min(trig, 3) * 0.15 + min(react, 4) * 0.15
    if trig: w.reasons.append(f"trigger x{trig}")
    if react: w.reasons.append(f"reaction x{react}")
    if talk < 0.2: w.reasons.append("mostly silent")

def score_windows(utts: List[Utterance], size: float = 30.0, step: float = 10.0,
                  scorer: Callable[[Window], None] = heuristic_score) -> List[Window]:
    if not utts:
        return []
    t, last, out = utts[0].start, utts[-1].end, []
    while t < last:
        w = Window(t, t + size, [u for u in utts if u.end > t and u.start < t + size])
        if w.utterances:
            scorer(w)
            out.append(w)
        t += step
    return sorted(out, key=lambda w: w.score, reverse=True)

def pick_cut(w: Window, min_score: float = 0.6, pre: float = 3.0, post: float = 4.0,
             max_len: float = 60.0, buffer_start: float = 0.0) -> Optional[tuple]:
    """Return (start, end) from first utterance (setup) to last (reaction), or None."""
    if w.score < min_score or not w.utterances:
        return None
    s = max(buffer_start, w.utterances[0].start - pre)
    e = min(w.utterances[-1].end + post, s + max_len)
    return (s, e)


def unseen_dialogue(window, history):
    """Return one fresh dialogue run with at most one preceding setup line."""
    lines, keys = [], []
    setup = None
    for u in window.utterances:
        key = (round(u.start, 1), round(u.end, 1), " ".join(u.text.casefold().split()))
        state = history.get(key)
        if state:
            if keys:
                break
            setup = u if state == "reviewed" else None
            continue
        if not keys and setup and u.start - setup.end <= 5:
            lines.append(setup)
        lines.append(u)
        keys.append(key)
    return lines, keys
