// Claude translation client. Calls the Anthropic Messages API directly from
// the browser (CORS is allowed via the anthropic-dangerous-direct-browser-access
// header) with the API key stored in the document's babel:meta tab.

import { splitSentencesHtml, planSentenceUpdates, stripTags, sanitizeInlineHtml } from "./core.js";

export const DEFAULT_MODEL = "claude-sonnet-5";

// USD per million tokens (input, output), for the cost counter.
const PRICING_PER_MTOK = {
  "claude-sonnet-5": [3.0, 15.0],
  "claude-sonnet-4-6": [3.0, 15.0],
  "claude-opus-4-8": [5.0, 25.0],
  "claude-haiku-4-5": [1.0, 5.0],
};

export function costOf(model, inputTokens, outputTokens) {
  const [pin, pout] = PRICING_PER_MTOK[model] || [5.0, 25.0];
  return (inputTokens * pin + outputTokens * pout) / 1e6;
}

async function callClaude(apiKey, model, prompt, spent) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Claude API: ${data.error?.message || res.statusText}`);
  }
  spent.input += data.usage?.input_tokens || 0;
  spent.output += data.usage?.output_tokens || 0;
  spent.calls += 1;
  if (data.stop_reason === "refusal") throw new Error("translation request was refused");
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

async function translateSentence(cfg, sentence, sourceParagraph, targetParagraph,
                                 sourceName, targetName, context, spent) {
  const prompt = `Translate ONE SENTENCE from ${sourceName} to ${targetName}.

The sentence is inline HTML from a rich-text document. Preserve the HTML tags
(<strong>, <em>, <u>, <s>, <code>, <a>, <br>) around the corresponding words in
the translation; translate only the text. Keep equivalent end punctuation.

Document context before the paragraph: ${context.before || "(start of document)"}
Full paragraph (${sourceName}): ${stripTags(sourceParagraph)}
Document context after the paragraph: ${context.after || "(end of document)"}
${targetParagraph ? `Current paragraph translation (${targetName}), the sentence must fit into it: ${targetParagraph}` : ""}

SENTENCE TO TRANSLATE: ${sentence}

Reply with ONLY the translated sentence as inline HTML — no quotes, no explanation.`;
  return callClaude(cfg.apiKey, cfg.model || DEFAULT_MODEL, prompt, spent);
}

export async function translateBlockTo(cfg, sourceHtml, prevHtml, existing,
                                       sourceName, targetName, context, spent) {
  // Translate a block sentence by sentence, reusing unchanged sentences. When
  // the existing translation aligns with the previous source text, only the
  // edited sentences are sent to the model; the rest rides along as context.
  let ops = planSentenceUpdates(prevHtml, sourceHtml, existing);
  if (ops === null) ops = splitSentencesHtml(sourceHtml).map((s) => ["translate", s]);

  const todo = ops.filter(([op]) => op === "translate").map(([, s]) => s);
  if (!todo.length) return ops.map(([, s]) => s).join("");

  const translated = await Promise.all(todo.map((s) =>
    translateSentence(cfg, s, sourceHtml, existing, sourceName, targetName, context, spent)));
  let k = 0;
  const parts = [];
  for (const [op, s] of ops) {
    if (op === "keep") parts.push(s);
    else {
      const trailingWs = s.match(/\s*$/)[0];
      parts.push(sanitizeInlineHtml(translated[k++]) + trailingWs);
    }
  }
  return parts.join("");
}

export function translateSentenceTo(cfg, sentenceHtml, paraSrcPlain, tgtParaPlain,
                                    sourceName, targetName, context, spent) {
  // v3 entry point: one sentence, with its paragraph (both languages) as
  // context. tgtParaPlain is the current target paragraph the sentence must
  // fit into (may be empty for fresh inserts).
  return translateSentence(cfg, sentenceHtml, paraSrcPlain, tgtParaPlain || null,
    sourceName, targetName, context, spent);
}

export async function mergeParagraphs(cfg, base, ours, theirs, languageName, spent) {
  // Two people edited the same paragraph simultaneously: three-way merge.
  const prompt = `Two collaborators edited the same paragraph of a document at the same time,
starting from the same original. Merge BOTH sets of changes into one coherent
paragraph in ${languageName}. Keep every change that doesn't conflict; where
the same words were changed differently, prefer the phrasing that reads best
while keeping both collaborators' meaning. The text is inline HTML — preserve
formatting tags (<strong>, <em>, <u>, <s>, <code>, <a>, <br>).

ORIGINAL PARAGRAPH:
${base}

COLLABORATOR A's VERSION:
${ours}

COLLABORATOR B's VERSION:
${theirs}

Reply with ONLY the merged paragraph as inline HTML — no quotes, no explanation.`;
  return callClaude(cfg.apiKey, cfg.model || DEFAULT_MODEL, prompt, spent);
}

export async function verifyApiKey(apiKey) {
  // One tiny request to confirm the key works before storing it in the doc.
  const spent = { input: 0, output: 0, calls: 0 };
  await callClaude(apiKey, "claude-haiku-4-5", "Reply with the single word: ok", spent);
  return true;
}
