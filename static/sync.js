// Babbel Docs sync engine — everything between the editor and the Google Doc.
//
// Written as one self-contained state machine, applying the lessons from the
// project's history:
//
//   TRUTH    The doc is the database. The model {languages, apiKey, usage,
//            blocks} is re-derived from the language tabs on every pull
//            (deriveModel); per-block state lives in the range names
//            babel:<id>:<ownHash>:<srcHash> (own = consistency vs outside
//            edits, src = translation staleness, own==src = source language).
//   WRITES   One serialized write chain. Every batch is conditioned on the
//            snapshot's revisionId; on conflict, rebuild from a fresh
//            snapshot and retry with backoff. Never compute indices against
//            a stale snapshot; never toast a conflict that a retry can fix.
//   PULLS    Poll Drive metadata every 500ms (cheap; locks ride along) and
//            gate content pulls on the Docs revisionId — probed every tick
//            while there is activity, slower when idle. Commit version
//            markers only after a successful pull. Never fold tab text into
//            the model while local edits are unsent or queued.
//   CONFLICT If the tab already holds someone else's version of a paragraph
//            we are about to write (vs the base we started editing from),
//            three-way merge the two versions with Claude instead of
//            clobbering (purple highlight), then retranslate.
//   LOCKS    Invisible Drive appProperties lock_<blockId> = clientId:ts:spec,
//            taken at edit time so other clients highlight the affected
//            sentences before the content even lands; TTL 2 min; released
//            when translation finishes or the block disappears.
//   UI STATE Per-block marks are computed in exactly one place (buildMarks):
//            green "editing" = local edit held while typing (translation
//            fires ~1s after the last keystroke), blue "out" = translating
//            outward, yellow "in" = incoming replacement, purple "merged" =
//            simultaneous edits merged, ins = insert placeholders.
//
// The engine knows nothing about ProseMirror. The app hands it editor blocks
// (editorChanged) and receives render blocks + marks back through callbacks.

import * as G from "./gdocs.js";
import * as D from "./docmodel.js";
import * as T from "./translate.js";
import {
  LANGUAGE_CATALOG, newId, sanitizeInlineHtml, stripTags,
  mergeBlocks, renderBlocks, blockContext, diffSentenceIndices, sentencePlainOffsets,
} from "./core.js";

const LOCK_TTL_MS = 2 * 60 * 1000;
const LONG_BLOCK_CHARS = 900;
const sigOf = (b) => `${b.type}|${JSON.stringify(b.attrs || {})}`;

export function createEngine(ui) {
  // ui: { onRender(blocks, marks), onMarks(marks), onStatus(kind, text),
  //       onUsage(usage), onLanguages(languages, lang), onTranslating(bool),
  //       onToast(msg, isError), onAuthExpired(), onSetupNeeded(),
  //       hasUnsentEdits() }

  // --- State -------------------------------------------------------------------
  let docId = null;
  let docName = "";
  let canEdit = false;
  let lang = null;
  let model = null;             // {languages, apiKey, model, usage, blocks}
  let docSnapshot = null;
  let lastVersion = null;
  let lastRevision = null;
  let pollTick = 0;
  let pollTimer = null;
  let lastActivityAt = 0;
  let running = false;

  let lastRendered = new Map(); // blockId -> {html, sig} last handed to the editor
  let skippedRemote = false;

  let writeChain = Promise.resolve();
  let writing = false;
  let queuedWrites = 0;

  const clientId = newId();
  let lockedBlocks = new Set();      // blocks other clients are translating
  const heldLocks = new Set();       // locks we hold
  const heldBlocks = new Set();      // local edits held while typing (green)
  const translateTimers = new Map();
  const prevHtmlById = new Map();    // pre-edit source html (sentence diffing)
  const sentenceState = new Map();   // blockId -> {n, d, ins}
  const editBase = new Map();        // blockId -> html the local edit started from
  const mergedBlocks = new Set();    // just merged by Claude (purple)
  const warnedLong = new Set();

  const langName = (code) => model?.languages.find((l) => l.code === code)?.name || code;
  const langTab = (code) => {
    const entry = model?.languages.find((l) => l.code === code);
    return entry && docSnapshot ? D.tabById(docSnapshot, entry.tabId) : null;
  };

  function toast(msg, isError) { ui.onToast(msg, isError); }

  // --- UI state: computed in exactly one place ------------------------------------

  function buildMarks(rendered) {
    const blockById = new Map(model.blocks.map((b) => [b.id, b]));
    const map = new Map();
    for (const rb of rendered) {
      const blk = blockById.get(rb.id);
      if (mergedBlocks.has(rb.id)) { map.set(rb.id, { kind: "merged", all: true }); continue; }
      const active = lockedBlocks.has(rb.id) || !!rb.pending || !!blk?.pending?.length;
      if (!active || !blk) continue;
      const st = sentenceState.get(rb.id);
      const offsets = () => sentencePlainOffsets(rb.html);
      if (lang === blk.source) {
        const kind = heldBlocks.has(rb.id) ? "editing" : "out";
        if (st?.n?.length) {
          const off = offsets();
          map.set(rb.id, { kind, sents: st.n.filter((i) => i < off.length).map((i) => off[i]) });
        } else {
          map.set(rb.id, { kind, all: true });
        }
      } else if ((blk.pending || []).includes(lang) || lockedBlocks.has(rb.id)) {
        if (st && (st.d?.length || st.ins?.length)) {
          const off = offsets();
          map.set(rb.id, {
            kind: "in",
            sents: (st.d || []).filter((i) => i < off.length).map((i) => off[i]),
            ins: (st.ins || []).map((i) => (i < off.length ? off[i][0] : (off[off.length - 1]?.[1] ?? 0))),
          });
        } else {
          map.set(rb.id, { kind: "in", all: true });
        }
      }
    }
    return map;
  }

  function anyTranslating() {
    if (!model) return false;
    const ids = new Set(model.blocks.map((b) => b.id));
    for (const id of lockedBlocks) if (ids.has(id)) return true;
    return model.blocks.some((b) => b.pending?.length);
  }

  function notifyMarks() {
    if (!model) return;
    ui.onMarks(buildMarks(renderBlocks(model, lang)));
    ui.onTranslating(anyTranslating());
    ui.onUsage(model.usage);
  }

  function notifyRender() {
    if (!model) return;
    if (ui.hasUnsentEdits()) { skippedRemote = true; notifyMarks(); return; }
    const rendered = renderBlocks(model, lang);
    lastRendered = new Map(rendered.map((b) => [b.id, { html: b.html, sig: sigOf(b) }]));
    ui.onRender(rendered, buildMarks(rendered));
    ui.onTranslating(anyTranslating());
    ui.onUsage(model.usage);
  }

  // --- Snapshots & meta -------------------------------------------------------------

  async function refreshSnapshot() {
    docSnapshot = await G.getDocument(docId);
    lastRevision = docSnapshot.revisionId;
    const meta = await G.getFileMeta(docId);
    lastVersion = meta.version;
    docName = meta.name;
  }

  const metaConfig = () => ({
    babel: 2,
    model: model.model,
    apiKey: model.apiKey,
    languages: model.languages,
    usage: model.usage,
  });

  function rangeNameFor(block, code) {
    const html = block.content[code] ?? block.content[block.source] ?? Object.values(block.content)[0] ?? "";
    const own = D.blockHash(block.type, block.attrs, html);
    let src;
    if (code === block.source) src = own;
    else if (block.pending?.includes(code)) src = D.STALE_HASH;
    else src = D.blockHash(block.type, block.attrs, block.content[block.source] ?? "");
    return D.rangeName(block.id, own, src);
  }

  // --- Writes: one serialized chain, revision-conditioned, conflict-merging ----------

  function buildWriteRequests(tabPlans, metaChanged) {
    const requests = [];
    const blockById = new Map(model.blocks.map((b) => [b.id, b]));
    for (const [code, plan] of Object.entries(tabPlans || {})) {
      const tab = langTab(code);
      if (!tab) continue;
      const rendered = renderBlocks(model, code);
      const nameFor = (rb) => rangeNameFor(blockById.get(rb.id), code);
      if (plan === "full") {
        requests.push(...D.fullTabRewriteRequests(tab, rendered, nameFor));
      } else {
        const parsed = D.parseLanguageTab(tab);
        const spans = parsed.spans;
        const oldNameById = new Map(parsed.blocks.filter((b) => b.id).map((b) => [b.id, b.name]));
        const targets = rendered
          .filter((b) => plan.has(b.id) && spans.has(b.id))
          .sort((a, b) => spans.get(b.id)[0] - spans.get(a.id)[0]); // bottom-up
        const missing = [...plan].some((id) => !spans.get(id) && rendered.some((b) => b.id === id));
        if (missing) {
          requests.push(...D.fullTabRewriteRequests(tab, rendered, nameFor));
        } else {
          for (const b of targets) {
            requests.push(...D.singleBlockRewriteRequests(
              tab, b, spans.get(b.id), nameFor(b), [oldNameById.get(b.id)].filter(Boolean)));
          }
        }
      }
    }
    if (metaChanged) {
      const metaTab = D.findMetaTab(docSnapshot);
      if (metaTab) requests.push(...D.metaRewriteRequests(metaTab, metaConfig()));
    }
    return requests;
  }

  async function resolveConflicts(tabPlans) {
    // Simultaneous edits to the same paragraph in the same language: the tab
    // already holds THEIR version while we are about to write OURS. Merge
    // with Claude against the base we both started from.
    if (!model?.apiKey) return;
    for (const [code, plan] of Object.entries(tabPlans || {})) {
      if (plan === "full" || !plan?.size) continue;
      const tab = langTab(code);
      if (!tab) continue;
      const tabHtml = new Map(D.parseLanguageTab(tab).blocks.filter((b) => b.id).map((b) => [b.id, b.html]));
      for (const id of plan) {
        const base = editBase.get(id);
        const block = model.blocks.find((b) => b.id === id);
        const theirs = tabHtml.get(id);
        const ours = block?.content[code];
        if (base === undefined || !block || theirs === undefined || ours === undefined) continue;
        if (theirs === base || theirs === ours || !stripTags(theirs).trim()) continue;
        mergedBlocks.add(id);
        notifyMarks();
        const spent = { input: 0, output: 0, calls: 0 };
        const cfg = { apiKey: model.apiKey, model: model.model || T.DEFAULT_MODEL };
        try {
          const merged = await T.mergeParagraphs(cfg, base, ours, theirs, langName(code), spent);
          addUsage(spent, cfg.model);
          block.content[code] = sanitizeInlineHtml(merged);
          block.source = code;
          block.prev_html = base;
          block.pending = model.languages.map((l) => l.code).filter((c) => c !== code);
          scheduleTranslate(id, 400);
          if (lang === code) notifyRender();
          toast("Merged simultaneous edits to a paragraph");
        } catch (err) {
          console.error(err);
          toast(`Couldn't merge simultaneous edits: ${err.message}`, true);
        }
        setTimeout(() => { mergedBlocks.delete(id); notifyMarks(); }, 5000);
      }
    }
  }

  function queueWrite(tabPlans, metaChanged) {
    queuedWrites += 1;
    writeChain = writeChain.then(async () => {
      if (!model) return;
      writing = true;
      ui.onStatus("busy", "Saving…");
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            await resolveConflicts(tabPlans);
            const requests = buildWriteRequests(tabPlans, metaChanged);
            if (requests.length) {
              await G.batchUpdate(docId, requests, docSnapshot.revisionId);
              await refreshSnapshot();
            }
            break;
          } catch (err) {
            if (err.authExpired || attempt >= 4) throw err;
            await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
            await refreshSnapshot(); // doc moved under us — rebuild and retry
          }
        }
        // Our edits are canonical now; future edits get a fresh conflict base.
        for (const plan of Object.values(tabPlans || {})) {
          if (plan instanceof Set) for (const id of plan) editBase.delete(id);
          else if (plan === "full") editBase.clear();
        }
        ui.onStatus("on", "Synced");
      } catch (err) {
        console.error(err);
        if (err.authExpired) {
          ui.onStatus("off", "Signed out");
          ui.onAuthExpired();
        } else {
          ui.onStatus("off", "Save failed");
          toast(`Save failed: ${err.message}`, true);
        }
        lastVersion = null; // re-pull on the next poll to converge
        lastRevision = null;
      } finally {
        writing = false;
        queuedWrites -= 1;
      }
    });
    return writeChain;
  }

  // --- Model derivation & pulls ----------------------------------------------------

  function deriveModel(doc, meta) {
    const perLang = [];
    for (const l of meta.languages) {
      const tab = D.tabById(doc, l.tabId);
      if (tab) perLang.push({ code: l.code, ...D.parseLanguageTab(tab) });
    }
    if (!perLang.length) return { blocks: [], repairs: false };

    const dirtyOf = (pl) => pl.blocks.some((b) => !b.id || b.own !== b.hash);
    const base = perLang.find(dirtyOf) || perLang[0];
    for (const b of base.blocks) if (!b.id) b.id = newId();

    const byLang = new Map(perLang.map((pl) =>
      [pl.code, new Map(pl.blocks.filter((b) => b.id).map((b) => [b.id, b]))]));

    const blocks = [];
    for (const bb of base.blocks) {
      const entries = new Map();
      for (const pl of perLang) {
        const e = pl === base ? bb : byLang.get(pl.code).get(bb.id);
        if (e) entries.set(pl.code, e);
      }
      let source = null;
      for (const [code, e] of entries) if (!e.own || e.own !== e.hash) { source = code; break; } // edited wins
      if (!source) {
        // Among tabs claiming source (own==src), prefer the one the other
        // tabs' srcHashes actually point at — resolves transient dual claims.
        let bestScore = -1;
        for (const [code, e] of entries) {
          if (!e.own || e.own !== e.src) continue;
          let score = 0;
          for (const [c2, e2] of entries) if (c2 !== code && e2.src === e.hash) score++;
          if (score > bestScore) { bestScore = score; source = code; }
        }
      }
      if (!source) source = base.code;
      const srcEntry = entries.get(source) || bb;
      const shared = srcEntry.type === "code" || !stripTags(srcEntry.html).trim();
      const content = {}, pending = [];
      for (const l of meta.languages) {
        const e = entries.get(l.code);
        if (e) content[l.code] = e.html;
        if (l.code === source || shared) continue;
        if (!e || e.src !== srcEntry.hash) pending.push(l.code);
      }
      blocks.push({ id: bb.id, type: srcEntry.type, attrs: srcEntry.attrs, content, source, pending });
    }

    const baseOrder = base.blocks.map((b) => b.id).join(",");
    const structural = perLang.some((pl) =>
      pl !== base && pl.blocks.map((b) => b.id).filter(Boolean).join(",") !== baseOrder);
    return { blocks, repairs: perLang.some(dirtyOf) || structural };
  }

  async function pullDoc() {
    const doc = await G.getDocument(docId);
    docSnapshot = doc;
    lastRevision = doc.revisionId;
    const metaTab = D.findMetaTab(doc);
    const meta = metaTab ? D.parseMeta(metaTab) : null;
    if (!meta || meta.babel !== 2) {
      stopPolling();
      ui.onSetupNeeded();
      return;
    }
    const { blocks, repairs } = deriveModel(doc, meta);
    model = { ...meta, blocks };
    model.usage = model.usage || { input_tokens: 0, output_tokens: 0, calls: 0, cost_usd: 0 };

    if (!model.languages.some((l) => l.code === lang)) {
      lang = model.languages[0]?.code;
    }
    // Defer repairs while another client is mid-flight (its locks are live) —
    // competing full rewrites are what turn into revision-conflict storms.
    if (repairs && canEdit && !queuedWrites && !ui.hasUnsentEdits() && !lockedBlocks.size) {
      const plans = {};
      for (const l of model.languages) plans[l.code] = "full";
      queueWrite(plans, false);
    }
    // Pick up stale blocks (external edit, dead translator, new language) —
    // slowly, and never ones another client is already on: the editing
    // client schedules its own work at ~1s and should win.
    if (canEdit && model.apiKey && !queuedWrites) {
      for (const b of model.blocks) {
        if (b.pending?.length && !lockedBlocks.has(b.id) && !heldLocks.has(b.id)) {
          scheduleTranslate(b.id, 4000);
        }
      }
    }
    ui.onLanguages(model.languages, lang);
    notifyRender();
  }

  // --- Polling ---------------------------------------------------------------------

  function stopPolling() { clearTimeout(pollTimer); }

  async function pollLoop() {
    clearTimeout(pollTimer);
    if (!running) return;
    try {
      if (!writing && !queuedWrites && model) {
        const meta = await G.getFileMeta(docId);
        scanLocks(meta.appProperties); // lock highlights ride the 500ms poll
        // Drive version bumps on any change (incl. lock patches); revisionId
        // only on content changes. Probe every tick while active, 2s idle.
        const active = lockedBlocks.size || heldLocks.size ||
          Date.now() - lastActivityAt < 15000;
        if (meta.version !== lastVersion) {
          lastActivityAt = Date.now();
          docName = meta.name;
          if ((await G.getRevisionId(docId)) !== lastRevision) await pullDoc();
          lastVersion = meta.version; // commit only after a successful pull
        } else if (active || pollTick % 4 === 3) {
          if ((await G.getRevisionId(docId)) !== lastRevision) await pullDoc();
        }
        ui.onStatus("on", "Synced");
      }
    } catch (err) {
      console.error(err);
      if (err.authExpired) {
        ui.onStatus("off", "Signed out");
        ui.onAuthExpired();
        return; // paused until resumeAfterSignIn()
      }
      ui.onStatus("off", "Reconnecting…");
    }
    pollTick += 1;
    pollTimer = setTimeout(pollLoop, 500);
  }

  // --- Locks (invisible Drive appProperties) -----------------------------------------

  const lockKey = (blockId) => `lock_${blockId}`;

  function parseLockVal(v) {
    if (!v) return null;
    const [c, t, spec] = String(v).split(":");
    const out = { c, t: Number(t) || 0, st: null };
    const m = spec && spec.match(/^n([\d,]*);d([\d,]*);i([\d,]*)$/);
    if (m) {
      const nums = (s) => s ? s.split(",").map(Number) : [];
      out.st = { n: nums(m[1]), d: nums(m[2]), ins: nums(m[3]) };
    }
    return out;
  }

  function encodeLockSpec(st) {
    if (!st) return "";
    const spec = `n${st.n.join(",")};d${st.d.join(",")};i${st.ins.join(",")}`;
    return spec.length <= 80 ? `:${spec}` : ""; // appProperties values cap ~124 bytes
  }

  async function acquireLock(blockId) {
    if (heldLocks.has(blockId)) return true; // taken at edit time
    const key = lockKey(blockId);
    const pre = parseLockVal((await G.getFileMeta(docId)).appProperties?.[key]);
    if (pre && pre.c !== clientId && Date.now() - pre.t < LOCK_TTL_MS) return false;
    await G.setAppProperties(docId, { [key]: `${clientId}:${Date.now()}` });
    const post = parseLockVal((await G.getFileMeta(docId)).appProperties?.[key]);
    if (post?.c !== clientId) return false;
    heldLocks.add(blockId);
    return true;
  }

  async function releaseLock(blockId) {
    heldLocks.delete(blockId);
    await G.setAppProperties(docId, { [lockKey(blockId)]: null }).catch(() => {});
  }

  function scanLocks(appProperties) {
    const fresh = new Set();
    const staleKeys = {};
    const now = Date.now();
    for (const [k, v] of Object.entries(appProperties || {})) {
      if (!k.startsWith("lock_")) continue;
      const l = parseLockVal(v);
      if (l && now - l.t < LOCK_TTL_MS) {
        if (l.c !== clientId) {
          const blockId = k.slice(5);
          fresh.add(blockId);
          if (l.st && !prevHtmlById.has(blockId)) sentenceState.set(blockId, l.st);
        }
      } else if (canEdit) {
        staleKeys[k] = null;
      }
    }
    if (Object.keys(staleKeys).length) G.setAppProperties(docId, staleKeys).catch(() => {});
    const changed = fresh.size !== lockedBlocks.size || [...fresh].some((b) => !lockedBlocks.has(b));
    lockedBlocks = fresh;
    if (changed) {
      lastActivityAt = Date.now();
      notifyMarks();
    }
  }

  // --- Local edits -------------------------------------------------------------------

  function editorChanged(blocks) {
    // `blocks` = docToBlocks(editor). Merge into the model, plan writes,
    // hold + arm translations, and hand back fresh marks.
    if (!model || !canEdit) return;
    let changed = false;
    const payload = blocks.map((b) => {
      const prev = lastRendered.get(b.id);
      const sig = sigOf(b);
      if (prev && prev.html === b.html) {
        if (prev.sig !== sig) changed = true;
        prev.sig = sig;
        return { id: b.id, type: b.type, attrs: b.attrs };
      }
      changed = true;
      if (prev && !editBase.has(b.id)) editBase.set(b.id, prev.html); // conflict base
      lastRendered.set(b.id, { html: b.html, sig });
      return b;
    });
    const removed = lastRendered.size !== blocks.length;
    if (!(changed || removed || skippedRemote)) return;
    skippedRemote = false;
    const ids = new Set(blocks.map((b) => b.id));
    for (const id of [...lastRendered.keys()]) {
      if (!ids.has(id)) {
        // A dirty block that got deleted must not pin its lock (and the
        // other clients' "Translating…" badge) until the TTL.
        lastRendered.delete(id);
        clearTimeout(translateTimers.get(id));
        translateTimers.delete(id);
        heldBlocks.delete(id);
        editBase.delete(id);
        if (heldLocks.has(id)) releaseLock(id);
      }
    }

    const beforeOrder = model.blocks.map((b) => b.id).join(",");
    const beforeSigs = new Map(model.blocks.map((b) => [b.id, sigOf(b)]));
    const oldSourceById = new Map(model.blocks.map((b) => [b.id, b.source]));
    const dirty = mergeBlocks(model, payload, lang);

    // Sentence-level info: pre-edit source text (for diff translation) and
    // which sentences changed (for everyone's highlights, via the lock spec).
    for (const id of dirty) {
      const b = model.blocks.find((x) => x.id === id);
      if (b?.prev_html && !prevHtmlById.has(id)) prevHtmlById.set(id, b.prev_html);
      const info = diffSentenceIndices(prevHtmlById.get(id), b?.content[b.source]);
      if (info) sentenceState.set(id, info);
      else sentenceState.delete(id);
    }

    // Structure changes (type/attrs/reorder) show in every tab: full rewrite.
    const structureChanged =
      model.blocks.map((b) => b.id).join(",") !== beforeOrder ||
      model.blocks.some((b) => beforeSigs.has(b.id) && beforeSigs.get(b.id) !== sigOf(b));
    const plans = {};
    if (structureChanged) {
      for (const l of model.languages) plans[l.code] = "full";
    } else {
      plans[lang] = new Set(dirty);
      // Revoke the old source tab's own==src claim atomically when the
      // source language flips, so no client ever sees two source claims.
      for (const id of dirty) {
        const old = oldSourceById.get(id);
        if (old && old !== lang) (plans[old] = plans[old] || new Set()).add(id);
      }
    }

    // Locks first (other clients highlight within 500ms), then hold + arm,
    // then paint — so the first paint already shows green.
    if (dirty.length) {
      const lockProps = {};
      for (const id of dirty) {
        lockProps[lockKey(id)] = `${clientId}:${Date.now()}${encodeLockSpec(sentenceState.get(id))}`;
        heldLocks.add(id);
      }
      G.setAppProperties(docId, lockProps).catch(() => {});
    }
    for (const id of dirty) {
      heldBlocks.add(id);
      scheduleTranslate(id, 800);
      const b = model.blocks.find((x) => x.id === id);
      const len = stripTags(b?.content[lang] || "").length;
      if (len > LONG_BLOCK_CHARS && !warnedLong.has(id)) {
        warnedLong.add(id);
        toast("This paragraph is getting long — Babbel syncs, merges and translates whole paragraphs, so consider splitting it.", true);
      } else if (len < LONG_BLOCK_CHARS / 2) {
        warnedLong.delete(id);
      }
    }
    lastActivityAt = Date.now();
    notifyMarks();
    queueWrite(plans, false);
  }

  // --- Translation ---------------------------------------------------------------------

  function addUsage(spent, modelId) {
    model.usage.input_tokens += spent.input;
    model.usage.output_tokens += spent.output;
    model.usage.calls += spent.calls;
    model.usage.cost_usd += T.costOf(modelId, spent.input, spent.output);
  }

  function scheduleTranslate(blockId, delay = 1000) {
    if (!canEdit) return;
    if (!model?.apiKey) { toast("No Anthropic API key in babel:meta — translations are paused", true); return; }
    clearTimeout(translateTimers.get(blockId));
    translateTimers.set(blockId, setTimeout(() => {
      translateTimers.delete(blockId);
      heldBlocks.delete(blockId);
      notifyMarks(); // green (held while writing) -> blue (translating)
      translateBlock(blockId).catch((err) => {
        console.error(err);
        toast(`Translation failed: ${err.message}`, true);
      });
    }, delay));
  }

  async function translateBlock(blockId) {
    const block = model?.blocks.find((b) => b.id === blockId);
    if (!block || !block.pending?.length) return;
    if (!(await acquireLock(blockId))) return; // another client is on it
    try {
      const source = block.source;
      const sourceHtml = block.content[source];
      const targets = [...block.pending];
      const context = blockContext(model, blockId, source);
      const spent = { input: 0, output: 0, calls: 0 };
      const cfg = { apiKey: model.apiKey, model: model.model || T.DEFAULT_MODEL };
      const prevHtml = prevHtmlById.get(blockId) ?? block.prev_html;

      const results = await Promise.allSettled(targets.map((t) =>
        T.translateBlockTo(cfg, sourceHtml, prevHtml, block.content[t],
          langName(source), langName(t), context, spent)));

      addUsage(spent, cfg.model); // cost counts even if results get discarded

      const cur = model.blocks.find((b) => b.id === blockId);
      if (!cur || cur.content[cur.source] !== sourceHtml) {
        queueWrite({}, true);
        ui.onUsage(model.usage);
        return; // re-edited meanwhile: discard, the new edit rescheduled us
      }
      const errors = [];
      const changedTabs = {};
      targets.forEach((t, i) => {
        const r = results[i];
        if (r.status === "rejected") {
          errors.push(`${langName(t)}: ${r.reason?.message || r.reason}`);
        } else {
          cur.content[t] = sanitizeInlineHtml(r.value);
          cur.pending = (cur.pending || []).filter((p) => p !== t);
          changedTabs[t] = new Set([blockId]);
        }
      });
      if (!cur.pending?.length) {
        delete cur.prev_html;
        prevHtmlById.delete(blockId);
        sentenceState.delete(blockId);
      }
      queueWrite(changedTabs, true); // meta carries the updated usage/cost
      notifyRender();
      if (errors.length) toast(`Some translations failed and will retry on the next edit (${errors[0]})`, true);
    } finally {
      await releaseLock(blockId);
    }
  }

  // --- Setup & languages -----------------------------------------------------------------

  async function setupDocument({ code, name, apiKey }) {
    const doc = await G.getDocument(docId);
    const firstTab = D.flattenTabs(doc)[0];
    const parsed = D.parseLanguageTab(firstTab);
    model = {
      babel: 2,
      model: T.DEFAULT_MODEL,
      apiKey,
      languages: [{ code, name, tabId: firstTab.tabProperties.tabId }],
      usage: { input_tokens: 0, output_tokens: 0, calls: 0, cost_usd: 0 },
      blocks: parsed.blocks.map((b) => ({
        id: b.id || newId(),
        type: b.type,
        attrs: b.attrs,
        content: { [code]: sanitizeInlineHtml(b.html) },
        source: code,
        pending: [],
      })),
    };
    const existingMeta = D.findMetaTab(doc);
    const metaTabId = existingMeta
      ? existingMeta.tabProperties.tabId
      : await G.addTab(docId, D.META_TAB_TITLE);
    const fresh = await G.getDocument(docId);
    const langTabFresh = D.tabById(fresh, firstTab.tabProperties.tabId);
    const metaTabFresh = D.tabById(fresh, metaTabId);
    const blockById = new Map(model.blocks.map((b) => [b.id, b]));
    await G.batchUpdate(docId, [
      { updateDocumentTabProperties: {
        tabProperties: { tabId: firstTab.tabProperties.tabId, title: name }, fields: "title" } },
      ...D.fullTabRewriteRequests(langTabFresh, renderBlocks(model, code),
        (rb) => rangeNameFor(blockById.get(rb.id), code)),
      ...D.metaRewriteRequests(metaTabFresh, metaConfig()),
    ]);
    lang = code;
    await start();
  }

  async function addLanguage(raw) {
    if (!model || !canEdit) return;
    const entry = LANGUAGE_CATALOG.find(
      (l) => l.name.toLowerCase() === raw.toLowerCase() || l.code === raw.toLowerCase());
    const code = entry?.code || raw.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 8);
    const name = entry?.name || raw;
    if (!code || !name) return;
    if (model.languages.some((l) => l.code === code)) { toast("Language already added", true); return; }
    toast(`Adding ${name}…`);

    const dirty = [];
    queuedWrites += 1;
    writeChain = writeChain.then(async () => {
      writing = true;
      try {
        const tabId = await G.addTab(docId, name);
        await refreshSnapshot();
        model.languages.push({ code, name, tabId });
        for (const b of model.blocks) {
          if (b.type === "code" || !stripTags(b.content[b.source] || "").trim()) {
            b.content[code] = b.content[b.source] || "";
          } else if (!(code in b.content)) {
            b.pending = b.pending || [];
            if (!b.pending.includes(code)) b.pending.push(code);
            dirty.push(b.id);
          }
        }
        const tab = D.tabById(docSnapshot, tabId);
        const blockById = new Map(model.blocks.map((b) => [b.id, b]));
        const requests = [
          ...D.fullTabRewriteRequests(tab, renderBlocks(model, code),
            (rb) => rangeNameFor(blockById.get(rb.id), code)),
          ...D.metaRewriteRequests(D.findMetaTab(docSnapshot), metaConfig()),
        ];
        await G.batchUpdate(docId, requests, docSnapshot.revisionId);
        await refreshSnapshot();
      } finally {
        writing = false;
        queuedWrites -= 1;
      }
    }).then(() => {
      ui.onLanguages(model.languages, lang);
      notifyMarks();
      toast(`Added ${name} — translating existing content…`);
      dirty.forEach((id, i) => setTimeout(() => scheduleTranslate(id), i * 400));
    }).catch((err) => {
      queuedWrites = Math.max(0, queuedWrites - 1);
      toast(`Couldn't add language: ${err.message}`, true);
    });
  }

  // --- Lifecycle --------------------------------------------------------------------------

  async function open(id, preferredLang) {
    docId = id;
    const meta = await G.getFileMeta(docId);
    docName = meta.name;
    canEdit = !!meta.capabilities?.canEdit;
    lastVersion = meta.version;
    lang = preferredLang || null;
    return { docName, canEdit };
  }

  async function start() {
    running = true;
    await pullDoc();
    if (model) {
      if (!lang || !model.languages.some((l) => l.code === lang)) lang = model.languages[0]?.code;
      ui.onLanguages(model.languages, lang);
      notifyRender();
      pollLoop();
    }
  }

  function setLanguage(code) {
    lang = code;
    lastRendered = new Map();
    if (model) {
      ui.onLanguages(model.languages, lang);
      notifyRender();
    }
  }

  function resumeAfterSignIn() {
    lastVersion = null;
    lastRevision = null;
    running = true;
    pollLoop();
  }

  function close() {
    running = false;
    stopPolling();
    for (const t of translateTimers.values()) clearTimeout(t);
    translateTimers.clear();
    heldBlocks.clear();
    heldLocks.clear();
    editBase.clear();
    mergedBlocks.clear();
    warnedLong.clear();
    sentenceState.clear();
    prevHtmlById.clear();
    lockedBlocks = new Set();
    lastRendered = new Map();
    model = null;
    docId = null;
    docSnapshot = null;
    lastVersion = null;
    lastRevision = null;
  }

  function poke() { if (running && model) pollLoop(); }

  return {
    open, start, close, setLanguage, editorChanged, addLanguage, setupDocument,
    resumeAfterSignIn, poke,
    get lang() { return lang; },
    get docId() { return docId; },
    get docName() { return docName; },
    get canEdit() { return canEdit; },
    get languages() { return model?.languages || []; },
    get hasModel() { return !!model; },
  };
}
