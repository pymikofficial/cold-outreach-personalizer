# Cold Outreach Personalizer

Paste a prospect list (CSV pasted from a spreadsheet, or a freeform list, one prospect per paragraph) plus a description of your offer. Get back a personalized 3-touch email sequence (initial, follow-up, breakup) for every prospect in the batch, generated one Claude call per prospect.

**Live:** [cold-outreach-personalizer.netlify.app](https://cold-outreach-personalizer.netlify.app)

## The headache

A $1.47M CAD pipeline, 2,314 contacts, processed one prospect at a time by hand: read the lead, find a real detail, write an opener, repeat. And generic-sounding cold outreach is a real credibility risk in the other direction too, the moment it fabricates a detail that isn't true ("saw your recent Series B" when there wasn't one), the whole message reads as a template with a mail-merge field, and the prospect knows it. Both failure modes, manual grind and confident fabrication, are the problem this tool goes after.

## The machinery

Single-page frontend, two Netlify Functions, Netlify Blobs for job state. Same base pattern as prior cosmik.work tools, with one structural difference and one different guardrail technique.

1. Frontend generates a `jobId` and POSTs the prospect list + offer to `generate-outreach-background.js`. Netlify auto-responds 202 for `-background` suffixed functions, so a 12-prospect batch never hits the ~10s synchronous timeout.
2. The background function parses the input into individual prospects (`splitProspects`, handles CSV-with-header, CSV-without-header, TSV, and freeform blank-line-separated blocks), then runs the daily rate-limit check and the offer PII scrub.
3. **Sequential fan-out**: it loops through every prospect ONE AT A TIME, one Claude API call per prospect, collecting results into an array. Deliberately not parallelized, sequential keeps rate-limit accounting simple and avoids hammering the API with a burst of 12 concurrent requests.
4. Frontend polls `check-outreach.js` every 2 seconds, up to 180 times (6-minute ceiling, longer than prior single-document tools, since a 12-prospect batch takes meaningfully longer than one call).

### The honesty guardrail (the point of this build, and why it's different from prior tools)

Earlier cosmik.work tools (Meeting Minutes Extractor, Executive Briefing Generator) used a **two-call drafter + auditor** pattern: one call writes a draft, a second call checks it against the source. This tool intentionally does something different: a **single-call self-report**.

Each per-prospect call is instructed to never invent a specific fact about that prospect, full stop, and to honestly report `"grounded": true/false` on whether it found a real personalizable detail in the input or had to fall back to a generic-but-relevant opener based only on role/industry. There's no second call cross-checking the first, the same call that writes the email also grades its own factual footing, and that self-grade is shown openly per prospect in the UI, plus a batch summary line ("9 of 12 personalized with a real detail, 3 used a generic opener").

This is a genuinely different guardrail shape, not a repeat of the auditor pattern: it trades a second LLM call (cost, latency) for an explicit instruction that being honestly generic beats a fabricated specific claim, every time.

### Other guardrails

- **Daily rate limit counted in prospects, not requests**: a single 12-prospect batch can consume far more API budget than one request in a single-document tool, so the cap (100/day) counts total prospects processed, not batches submitted.
- **Hard cap of 12 prospects per batch**: submissions over the cap are rejected with a clear error, never silently truncated, so nobody's 13th prospect quietly vanishes.
- **Per-prospect error isolation**: if one prospect's Claude call returns malformed JSON, that prospect gets a clear fallback entry (`_error: true`, flagged in the UI) instead of the failure taking down the other 11 prospects' results.
- **Offer-only PII scrub**: emails and phone numbers are stripped from the *offer* text before it reaches the AI. Prospect info is sent as-is, unscrubbed, because it's the actual content being personalized against, not incidental noise. This is a meaningfully different privacy story than earlier tools that scrub the whole input, and the UI says so plainly rather than implying blanket scrubbing that doesn't actually happen here.
- **Input caps**: 40,000 characters for the prospect list, 4,000 for the offer.

## Environment variables (all three required)

| Variable | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | Shared Anthropic API key (reused across cosmik.work tools) |
| `NETLIFY_SITE_ID` | This site's ID, from Project details |
| `NETLIFY_BLOBS_TOKEN` | Netlify Personal Access Token (shared) |

Note: `getStore()` must be called with explicit `siteID` and `token`. Relying on ambient environment configuration throws `"The environment has not been configured to use Netlify Blobs"` in this deployment setup.

## Run it locally

1. Clone this repo.
2. `npm install`
3. `netlify dev` (with the three env vars set)

## Smoke test

`node scripts/smoke-test.mjs` runs against the live site and verifies:
- A 3-prospect batch (one with a genuinely specific real detail, one with none) comes back with the specific prospect marked `grounded: true` and the generic one marked `grounded: false`, checking the actual field, not just eyeballing the copy.
- A 13-prospect batch (over the 12 cap) is rejected with a clean `error` status mentioning the limit, not a crash or partial run.
- Both supported input formats, CSV-with-header and freeform paragraph blocks, parse into the correct prospect count.

Built by [Soumik Chatterjee](https://cosmik.work).
