// Cold Outreach Personalizer ~ background function.
// Sequential per-prospect fan-out: one Claude call per prospect (not one call
// for the whole batch), each self-reporting grounded:true/false as an honesty
// guardrail instead of a second auditor call.

const { getStore } = require('@netlify/blobs');

// getStore MUST receive explicit siteID and token in this account's setup,
// or it throws "The environment has not been configured to use Netlify Blobs".
const BLOBS_CONFIG = {
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN
};

const MAX_PROSPECTS_PER_BATCH = 12;
const DAILY_PROSPECT_CAP = 100;
const DAILY_PROSPECT_CAP_PER_IP = 30;
const MAX_INPUT_CHARS = 40000;
const MAX_OFFER_CHARS = 4000;
const JOB_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;

function clientIp(event) {
  return (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
}

exports.handler = async (event) => {
  const store = getStore({ name: 'outreach', ...BLOBS_CONFIG });
  let jobId = null;

  try {
    const body = JSON.parse(event.body || '{}');
    jobId = typeof body.jobId === 'string' && JOB_ID_RE.test(body.jobId) ? body.jobId : null;
    const rawInput = (body.prospects || '').slice(0, MAX_INPUT_CHARS);
    const offer = (body.offer || '').slice(0, MAX_OFFER_CHARS);

    if (!jobId || !rawInput.trim() || !offer.trim()) {
      return;
    }

    await store.setJSON(jobId, { status: 'pending' });

    const prospects = splitProspects(rawInput);

    if (prospects.length === 0) {
      await store.setJSON(jobId, { status: 'error', message: 'No prospects could be parsed from your input. Check the format and try again.' });
      return;
    }
    if (prospects.length > MAX_PROSPECTS_PER_BATCH) {
      await store.setJSON(jobId, { status: 'error', message: `Found ${prospects.length} prospects, the limit is ${MAX_PROSPECTS_PER_BATCH} per batch. Split into smaller batches.` });
      return;
    }

    // --- Guardrail: daily total-prospects rate limit (global + per-IP) ---
    const today = new Date().toISOString().slice(0, 10);
    const limitStore = getStore({ name: 'rate-limits', ...BLOBS_CONFIG });
    const counterKey = `outreach-${today}`;
    const ip = clientIp(event);
    const ipCounterKey = `outreach-${today}-ip-${ip}`;
    let countSoFar = 0;
    let ipCountSoFar = 0;
    try {
      const existing = await limitStore.get(counterKey);
      countSoFar = existing ? parseInt(existing, 10) : 0;
      const ipExisting = await limitStore.get(ipCounterKey);
      ipCountSoFar = ipExisting ? parseInt(ipExisting, 10) : 0;
    } catch (e) {
      countSoFar = 0;
      ipCountSoFar = 0;
    }
    if (countSoFar + prospects.length > DAILY_PROSPECT_CAP) {
      await store.setJSON(jobId, { status: 'error', message: "Today's free processing limit has been reached. Come back tomorrow." });
      return;
    }
    if (ipCountSoFar + prospects.length > DAILY_PROSPECT_CAP_PER_IP) {
      await store.setJSON(jobId, { status: 'error', message: "You've hit today's per-user processing limit. Come back tomorrow." });
      return;
    }

    // --- PII scrub on the offer text only (prospect data is legitimate content, not noise) ---
    const { scrubbed: scrubbedOffer, scrubCounts } = scrubPII(offer);

    // --- Sequential per-prospect generation ---
    const results = [];
    for (const p of prospects) {
      const prompt = PROSPECT_PROMPT
        .replace('{{OFFER}}', scrubbedOffer)
        .replace('{{PROSPECT}}', p);
      try {
        const raw = await callClaude([{ role: 'user', content: prompt }]);
        const parsed = parseModelJSON(raw);
        results.push(parsed);
      } catch (e) {
        // One bad prospect must not kill the whole batch.
        results.push({
          prospect_label: 'Unknown (generation error)',
          grounded: false,
          personalization_note: 'This prospect failed to generate. Try resubmitting just this one.',
          messages: { initial: '', follow_up: '', breakup: '' },
          _error: true
        });
      }
    }

    await limitStore.set(counterKey, String(countSoFar + prospects.length));
    await limitStore.set(ipCounterKey, String(ipCountSoFar + prospects.length));

    const summary = {
      total: results.length,
      grounded: results.filter((r) => r.grounded).length,
      generic: results.filter((r) => !r.grounded).length,
      errors: results.filter((r) => r._error).length
    };

    await store.setJSON(jobId, {
      status: 'done',
      results,
      summary,
      offerScrubCounts: scrubCounts
    });
  } catch (err) {
    console.error('generate-outreach error:', err);
    if (jobId) {
      try {
        await store.setJSON(jobId, { status: 'error', message: 'Generation failed. Try again in a minute.' });
      } catch (e) {}
    }
  }
};

// ---------------------------------------------------------------------------

function splitProspects(raw) {
  const lines = raw.split(/\r?\n/);
  const nonEmpty = lines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (nonEmpty.length === 0) return [];

  const sample = nonEmpty.slice(0, Math.min(5, nonEmpty.length));
  const commaCounts = sample.map((l) => (l.match(/,/g) || []).length);
  const tabCounts = sample.map((l) => (l.match(/\t/g) || []).length);

  function consistent(counts) {
    if (counts.length < 2) return false;
    const first = counts[0];
    if (first < 1) return false;
    return counts.every((c) => c === first);
  }

  let delimiter = null;
  if (consistent(commaCounts)) delimiter = ',';
  else if (consistent(tabCounts)) delimiter = '\t';

  if (delimiter) {
    const rows = nonEmpty.map((l) => l.split(delimiter).map((c) => c.trim()));
    const firstRowLooksLikeHeader =
      rows[0].every((c) => c.length < 30) &&
      /name|company|role|title|context|note|email/i.test(rows[0].join(' '));
    let header = null;
    let dataRows = rows;
    if (firstRowLooksLikeHeader) {
      header = rows[0];
      dataRows = rows.slice(1);
    }
    return dataRows.map((row) => {
      if (header) {
        return header.map((h, i) => `${h}: ${row[i] || ''}`).join(', ');
      }
      return row.join(', ');
    });
  }

  const blocks = raw.split(/\n\s*\n/).map((b) => b.trim()).filter((b) => b.length > 0);
  if (blocks.length > 1) return blocks;

  return nonEmpty;
}

function scrubPII(text) {
  const scrubCounts = { emails: 0, phones: 0 };

  let out = text.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    () => { scrubCounts.emails++; return '[email removed]'; }
  );

  out = out.replace(
    /(?<![A-Za-z0-9-])(\+?\d[\d\s()./-]{6,}\d)(?![A-Za-z0-9])/g,
    (match) => {
      const digits = match.replace(/\D/g, '');
      const seps = (match.match(/[/-]/g) || []).length;
      const looksLikeDate = digits.length === 8 && seps === 2;
      if (digits.length >= 8 && digits.length <= 15 && !looksLikeDate) {
        scrubCounts.phones++;
        return '[phone removed]';
      }
      return match;
    }
  );

  return { scrubbed: out, scrubCounts };
}

async function callClaude(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Anthropic API ' + res.status + ': ' + errText.slice(0, 300));
  }

  const data = await res.json();
  return data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function parseModelJSON(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('Model did not return JSON.');
  }
  return JSON.parse(clean.slice(start, end + 1));
}

const PROSPECT_PROMPT = `You are writing a personalized 3-touch cold outreach sequence for one prospect, based on real information about them and a description of what's being offered.

Respond with ONLY a JSON object, no preamble, no markdown fences, in exactly this shape:
{
  "prospect_label": "Best guess at the prospect's name and/or company, extracted from the input, for display purposes",
  "grounded": true or false,
  "personalization_note": "One line: either the specific real detail used to personalize (e.g. 'referenced their recent hiring push'), or 'No specific detail available, used a role-based generic opener' if nothing specific was found",
  "messages": {
    "initial": "First outreach email",
    "follow_up": "Follow-up email if no response",
    "breakup": "Final breakup/close-the-loop email"
  }
}

CRITICAL RULE: Only reference a specific fact, event, or detail about this prospect if it is LITERALLY stated in the prospect info below. Never invent, assume, or guess specific details (do not claim to have seen a recent launch, funding round, or post unless the input explicitly says so). If the input gives no specific personalizable detail, write a solid, relevant but generic opener based only on their stated role/industry, and set "grounded" to false. Being honestly generic is always better than a fabricated specific claim.

<offer>
{{OFFER}}
</offer>

<prospect_info>
{{PROSPECT}}
</prospect_info>`;

module.exports.splitProspects = splitProspects;
module.exports.scrubPII = scrubPII;
module.exports.parseModelJSON = parseModelJSON;
