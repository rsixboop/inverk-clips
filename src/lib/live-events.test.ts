import { describe, expect, it } from "vitest";
import { canScan, decideEvent, eventScore, normalizeEvent, rememberEvent } from "./live-events";
const now = Date.parse("2026-11-18T15:00:00Z");
describe("gameplay event highlights", () => {
  const club = normalizeEvent({ kind: "novel_interaction", label: "Enters nightclub and talks to bouncer NPC", confidence: 0.86, setup: "walks to club door", payoff: "bouncer lets him in" });
  it("quiet interaction is kept with zero chatters", () => {
    const d = decideEvent(club, {}, now); expect(d.keep).toBe(true); expect(d.reason).toContain("nightclub");
    expect(eventScore(0.86, 0)).toBe(0.86); expect(eventScore(0.86, 100)).toBe(1.86);
  });
  it("routine driving or menu is rejected", () => {
    expect(decideEvent(normalizeEvent({ kind: "routine", label: "driving on highway", confidence: 0.95 }), {}, now).keep).toBe(false);
    expect(decideEvent(normalizeEvent({ kind: "bogus", confidence: 1 }), {}, now).keep).toBe(false);
  });
  it("low confidence is rejected", () => { expect(decideEvent({ ...club, confidence: 0.6 }, {}, now).keep).toBe(false); });
  it("repeat of the same event within 10 minutes is rejected, later allowed", () => {
    const s = rememberEvent({}, club.label, new Date(now - 60_000).toISOString());
    const again = normalizeEvent({ kind: "novel_interaction", label: "Talks to the nightclub bouncer NPC again", confidence: 0.9 });
    expect(decideEvent(again, s, now).keep).toBe(false);
    expect(decideEvent(again, s, now + 11 * 60_000).keep).toBe(true);
  });
  it("budget caps scans per channel and across channels", () => {
    expect(canScan({ scan_at: new Date(now - 10_000).toISOString() }, [], now).ok).toBe(false);
    const t = new Date(now - 20_000).toISOString();
    expect(canScan({}, [t, t, t], now)).toEqual({ ok: false, why: "budget" });
    expect(canScan({}, [t, t], now).ok).toBe(true);
  });
});
