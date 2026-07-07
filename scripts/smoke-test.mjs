#!/usr/bin/env node
// Smoke test for Cold Outreach Personalizer, run against the LIVE deployed
// site (not local dev), since it hits real Netlify Functions + Blobs + the
// real Anthropic API.
//
// Usage: node scripts/smoke-test.mjs [base_url]
// Default base_url: https://cold-outreach-personalizer.netlify.app

const BASE_URL = process.argv[2] || 'https://cold-outreach-personalizer.netlify.app';
const POLL_MS = 2000;
const MAX_POLLS = 180; // 6-minute ceiling, matches the frontend's own timeout

const OFFER = 'We help logistics and ops teams cut onboarding time for new warehouse staff by 40% with a guided training platform. Free 2-week pilot, no contract.';

// --- Batch 1: CSV with header, 3 prospects, one with a genuinely specific
// real detail (Priya), two with none (Raj, Dana). Also doubles as the
// "CSV with header parses into the correct prospect count" check. ---
const CSV_BATCH = `Name,Company,Role,Note
Priya Sharma,Acme Corp,VP Ops,Posted on LinkedIn last month about scaling a remote ops team
Raj Kumar,LogiCo,Operations Manager,No additional notes
Dana Lee,Widgets Inc,CEO,No additional notes`;

// --- Batch 2: freeform, blank-line-separated blocks, 2 prospects. Only used
// to check the freeform format parses into the correct prospect count. ---
const FREEFORM_BATCH = `Jordan Blake is a Marketing Director at a boutique agency, no other specific details known.

Morgan Reyes works in People Ops at a series-B startup, nothing else specific stated.`;

// --- Batch 3: 13 prospects, one over the 12-per-batch cap. No commas/blank
// lines, so each non-empty line becomes one prospect via splitProspects'
// fallback path, giving exactly 13. ---
const OVER_CAP_BATCH = Array.from({ length: 13 }, (_, i) => `Prospect ${i + 1} - Generic Role ${i + 1}`).join('\n');

function log(msg) { console.log(msg); }
function fail(msg) { console.log('FAIL: ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('PASS: ' + msg); }

async function submit(prospects, offer) {
  const jobId = 'smoketest-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const kickoff = await fetch(`${BASE_URL}/.netlify/functions/generate-outreach-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, prospects, offer })
  });
  return { jobId, kickoffStatus: kickoff.status };
}

async function poll(jobId, maxPolls = MAX_POLLS) {
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let res;
    try {
      res = await fetch(`${BASE_URL}/.netlify/functions/check-outreach?jobId=${encodeURIComponent(jobId)}`);
    } catch (e) {
      continue; // transient, keep polling
    }
    const data = await res.json();
    if (data.status === 'done' || data.status === 'error') {
      return data;
    }
  }
  return null;
}

const FABRICATION_MARKERS = [
  'linkedin', 'acme', 'remote ops team', 'funding', 'series a', 'series b',
  'series c', 'announced', 'just launched', 'recently launched', 'ipo'
];

function containsFabricatedSpecifics(messages) {
  const text = [messages.initial, messages.follow_up, messages.breakup].join(' ').toLowerCase();
  return FABRICATION_MARKERS.filter((m) => text.includes(m));
}

async function main() {
  log(`Testing ${BASE_URL}\n`);

  // ============================================================
  // Test 1: CSV batch, grounded vs generic + fabrication check
  // ============================================================
  log('--- Test 1: CSV-with-header batch (3 prospects, grounded/generic honesty check) ---');
  const startedAt1 = Date.now();
  let kickoff1;
  try {
    kickoff1 = await submit(CSV_BATCH, OFFER);
  } catch (e) {
    fail(`Could not reach generate-outreach-background: ${e.message}`);
    kickoff1 = null;
  }
  if (kickoff1 && kickoff1.kickoffStatus !== 202 && kickoff1.kickoffStatus !== 200) {
    fail(`Unexpected status from background function: ${kickoff1.kickoffStatus}`);
  } else if (kickoff1) {
    const record1 = await poll(kickoff1.jobId);
    const elapsed1 = ((Date.now() - startedAt1) / 1000).toFixed(1);

    if (!record1) {
      fail(`Test 1 timed out after ~${(MAX_POLLS * POLL_MS / 1000)}s with no done/error status.`);
    } else if (record1.status === 'error') {
      fail(`Test 1 server returned an error: ${record1.message}`);
    } else {
      pass(`Test 1 generated in ${elapsed1}s.`);

      const results = record1.results || [];
      if (results.length === 3) {
        pass(`CSV-with-header parsed into the correct prospect count (3).`);
      } else {
        fail(`CSV-with-header expected 3 prospects, got ${results.length}.`);
      }

      const priya = results.find((r) => /priya/i.test(r.prospect_label || ''));
      const raj = results.find((r) => /raj/i.test(r.prospect_label || ''));

      if (priya) {
        if (priya.grounded === true) {
          pass(`Priya (specific real detail: LinkedIn post) came back grounded:true.`);
        } else {
          fail(`Priya should be grounded:true (has a specific real detail), got grounded:${priya.grounded}.`);
        }
      } else {
        fail(`Could not find Priya in results to check grounded status.`);
      }

      if (raj) {
        if (raj.grounded === false) {
          pass(`Raj (no specific detail) came back grounded:false.`);
        } else {
          fail(`Raj should be grounded:false (no specific detail given), got grounded:${raj.grounded}.`);
        }
        const fabricated = containsFabricatedSpecifics(raj.messages || {});
        if (fabricated.length === 0) {
          pass(`Raj's messages contain no fabricated specifics.`);
        } else {
          fail(`Raj's messages contain suspicious fabricated-looking specifics: ${fabricated.join(', ')}.`);
        }
      } else {
        fail(`Could not find Raj in results to check grounded status.`);
      }

      log('\n--- Test 1 full results (for manual eyeballing) ---');
      log(JSON.stringify(results, null, 2));
    }
  }

  // ============================================================
  // Test 2: freeform batch, parse count check
  // ============================================================
  log('\n--- Test 2: freeform paragraph-block batch (2 prospects, format-count check) ---');
  const startedAt2 = Date.now();
  let kickoff2;
  try {
    kickoff2 = await submit(FREEFORM_BATCH, OFFER);
  } catch (e) {
    fail(`Could not reach generate-outreach-background: ${e.message}`);
    kickoff2 = null;
  }
  if (kickoff2 && kickoff2.kickoffStatus !== 202 && kickoff2.kickoffStatus !== 200) {
    fail(`Unexpected status from background function: ${kickoff2.kickoffStatus}`);
  } else if (kickoff2) {
    const record2 = await poll(kickoff2.jobId);
    const elapsed2 = ((Date.now() - startedAt2) / 1000).toFixed(1);
    if (!record2) {
      fail(`Test 2 timed out after ~${(MAX_POLLS * POLL_MS / 1000)}s with no done/error status.`);
    } else if (record2.status === 'error') {
      fail(`Test 2 server returned an error: ${record2.message}`);
    } else {
      pass(`Test 2 generated in ${elapsed2}s.`);
      const results2 = record2.results || [];
      if (results2.length === 2) {
        pass(`Freeform paragraph blocks parsed into the correct prospect count (2).`);
      } else {
        fail(`Freeform batch expected 2 prospects, got ${results2.length}.`);
      }
    }
  }

  // ============================================================
  // Test 3: over-cap batch (13 prospects), expect clean error
  // ============================================================
  log('\n--- Test 3: 13-prospect batch (over the 12 cap), expect clean error ---');
  let kickoff3;
  try {
    kickoff3 = await submit(OVER_CAP_BATCH, OFFER);
  } catch (e) {
    fail(`Could not reach generate-outreach-background: ${e.message}`);
    kickoff3 = null;
  }
  if (kickoff3 && kickoff3.kickoffStatus !== 202 && kickoff3.kickoffStatus !== 200) {
    fail(`Unexpected status from background function: ${kickoff3.kickoffStatus}`);
  } else if (kickoff3) {
    // Over-cap rejection happens before any Claude calls, so it should resolve fast.
    const record3 = await poll(kickoff3.jobId, 30);
    if (!record3) {
      fail(`Test 3 timed out waiting for the over-cap rejection.`);
    } else if (record3.status === 'error' && /limit/i.test(record3.message || '')) {
      pass(`13-prospect batch cleanly rejected with a limit-related error: "${record3.message}"`);
    } else if (record3.status === 'error') {
      fail(`Test 3 got an error, but the message doesn't mention the limit: "${record3.message}"`);
    } else {
      fail(`Test 3 expected status:error for the over-cap batch, got status:${record3.status} (partial processing instead of a clean rejection).`);
    }
  }

  log('\nSmoke test complete.');
}

main();
