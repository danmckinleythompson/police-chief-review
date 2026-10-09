"use strict";

// This file is the entire static application. Imported records never leave the
// browser. The optional Python server explicitly injects its local API token.
const DECISIONS = Object.freeze({accept_original: "Keep original", correct_original: "Use proposed correction", insufficient_evidence: "Too little information"});
const REVIEW_TYPE = "nonblinded_development_feedback";
const DB_NAME = "chief-tenure-proposal-review-v1";
const MAX_BYTES = 20 * 1024 * 1024;
const state = {db: null, bundle: null, cases: [], index: 0, mode: "browser", token: "", current: null, dirty: false, pending: null, timer: null, busy: false, records: new Map(), generation: 0};

function requireValue(condition, message) { if (!condition) throw new Error(message); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (isObject(value)) return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
async function fingerprint(value) {
  const bytes = new TextEncoder().encode(canonical(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
function validateBundle(bundle) {
  requireValue(isObject(bundle) && bundle.schema_version === "1.0", "This case file needs schema_version 1.0.");
  requireValue(bundle.review_type === REVIEW_TYPE, "This app accepts only nonblinded development feedback packets.");
  requireValue(typeof bundle.bundle_id === "string" && bundle.bundle_id.length > 0 && bundle.bundle_id.length <= 300, "Missing or invalid bundle ID.");
  requireValue(Array.isArray(bundle.cases) && bundle.cases.length <= 10000, "Invalid case list.");
  const seen = new Set();
  for (const item of bundle.cases) {
    requireValue(isObject(item) && typeof item.case_id === "string" && item.case_id.length > 0 && item.case_id.length <= 300 && !seen.has(item.case_id), "Case IDs must be unique, nonempty strings.");
    requireValue(typeof item.agency_id === "string" && isObject(item.original) && isObject(item.proposal) && Array.isArray(item.evidence), "Each case needs its agency, original assertion, proposal, and evidence list.");
    requireValue(Object.hasOwn(DECISIONS, item.proposal.decision), "Unknown proposed decision.");
    requireValue(item.evidence.every(isObject), "Evidence entries must be objects.");
    seen.add(item.case_id);
  }
  return bundle;
}
function validateResponse(value) {
  const keys = ["judgment", "note", "corrected_name", "corrected_year"];
  requireValue(isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), "Answers can contain only judgment, note, suggested name, and suggested year.");
  requireValue(["", "agree", "dispute", "skip"].includes(value.judgment), "Choose agree, dispute, or skip.");
  requireValue(typeof value.note === "string" && value.note.length <= 10000, "The note is too long.");
  requireValue(typeof value.corrected_name === "string" && value.corrected_name.length <= 300, "The suggested name is too long.");
  requireValue(typeof value.corrected_year === "string" && /^(?:[12]\d{3})?$/.test(value.corrected_year), "A suggested year must be four digits between 1000 and 2999, or blank.");
  requireValue(value.judgment === "dispute" || (!value.corrected_name && !value.corrected_year), "Suggested corrections belong to a dispute.");
  return value;
}
function blankResponse() { return {judgment: "", note: "", corrected_name: "", corrected_year: ""}; }
function safeURL(value) {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch (_) { return null; }
}
function printable(value) {
  if (value === undefined || value === null || value === "") return "Not specified";
  if (Array.isArray(value)) return value.length ? value.map(printable).join(" · ") : "Not specified";
  if (isObject(value)) return Object.entries(value).map(([key, item]) => key.replaceAll("_", " ") + ": " + printable(item)).join("; ");
  return String(value);
}
function year(value) { const match = String(value || "").match(/^\d{4}/); return match ? match[0] : "unknown"; }
function windowLabel(after, by) {
  if (!after && !by) return "Unknown";
  return [after ? "after " + year(after) : "lower bound unknown", by ? "by " + year(by) : "upper bound unknown"].join(" · ");
}
function answerKey(bundleId, itemFingerprint) { return JSON.stringify([bundleId, itemFingerprint]); }
function node(tag, text, className) { const result = document.createElement(tag); if (text !== undefined) result.textContent = text; if (className) result.className = className; return result; }
function byId(id) { return document.getElementById(id); }
function showNotice(message) { byId("notice").textContent = message; byId("notice").hidden = !message; }
function setSaveStatus(message, error = false) { byId("save-status").textContent = message; byId("save-status").classList.toggle("error", error); byId("retry-save").hidden = !error; byId("export-draft").hidden = !error; }
function addDetail(list, label, value) { list.append(node("dt", label), node("dd", printable(value))); }
function lockEditing(locked) {
  state.busy = locked;
  byId("response").disabled = locked;
  for (const id of ["note", "corrected-name", "corrected-year"]) byId(id).disabled = locked;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("meta"); db.createObjectStore("answers", {keyPath: "key"}); db.createObjectStore("history", {keyPath: "history_key"});
    };
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(new Error("Browser storage is unavailable. Use a regular browser window with site storage enabled."));
    request.onblocked = () => reject(new Error("Close another older review tab and reload to open browser storage."));
  });
}
function readStore(store, key) {
  return new Promise((resolve, reject) => { const request = state.db.transaction(store).objectStore(store).get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function putMeta(key, value) {
  return new Promise((resolve, reject) => { const tx = state.db.transaction("meta", "readwrite"); tx.objectStore("meta").put(value, key); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error("Local storage write aborted.")); });
}
function saveBrowserAnswer(item, expected, response) {
  validateResponse(response);
  const key = answerKey(state.bundle.bundle_id, item.fingerprint);
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(["answers", "history"], "readwrite");
    const answers = tx.objectStore("answers"); const request = answers.get(key);
    let result; let failure;
    request.onsuccess = () => {
      const old = request.result;
      if (old && canonical(old.response) === canonical(response)) { result = old; return; }
      if ((old ? old.revision : 0) !== expected) { failure = new Error("Another tab saved a newer answer. Your draft is still here; export it, then reload before continuing."); tx.abort(); return; }
      result = {key, bundle_id: state.bundle.bundle_id, case_id: item.case_id, case_fingerprint: item.fingerprint, revision: expected + 1, saved_at: new Date().toISOString(), response: {...response}};
      answers.put(result);
      tx.objectStore("history").add({...result, history_key: JSON.stringify([key, result.revision])});
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(failure || tx.error || new Error("Browser save failed."));
    tx.onabort = () => reject(failure || tx.error || new Error("Browser save failed. Export your draft before closing."));
  });
}
async function api(path, payload) {
  requireValue(state.token && location.hostname === "127.0.0.1", "The API is available only through the local review server.");
  const options = {headers: {"X-Review-Token": state.token}, cache: "no-store"};
  if (payload !== undefined) { options.method = "POST"; options.headers["Content-Type"] = "application/json"; options.body = JSON.stringify(payload); }
  const response = await fetch(path, options); const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Local server request failed.");
  return result;
}
async function installBundle(bundle, mode) {
  validateBundle(bundle);
  const cases = await Promise.all(bundle.cases.map(async item => ({...item, fingerprint: await fingerprint(item)})));
  if (mode === "browser") await putMeta("last_bundle", bundle);
  state.bundle = bundle; state.cases = cases; state.mode = mode; state.index = 0; state.current = null; state.records = new Map();
  if (mode === "server") {
    const result = await api("/api/answers");
    for (const record of result.answers) state.records.set(record.case_fingerprint, record);
  } else {
    for (const item of cases) { const record = await readStore("answers", answerKey(bundle.bundle_id, item.fingerprint)); if (record) state.records.set(item.fingerprint, record); }
  }
  byId("storage-status").textContent = mode === "server" ? "Autosave: local SQLite database" : "Autosave: this browser and device";
  byId("privacy").textContent = mode === "server" ? "Answers are saved by your local server in the project’s proposal-review directory. There are no analytics or external uploads. Opening a source visits its publisher." : "Private files and answers stay in this browser. There are no analytics or uploads. Opening a source link visits that publisher.";
  byId("export").disabled = false; byId("answers-file").disabled = false;
  byId("workspace").hidden = !cases.length; byId("empty").hidden = !!cases.length;
  if (!cases.length) { byId("empty").replaceChildren(node("h2", "No proposals are ready yet"), node("p", "Keep this case file locally. Open an updated file when research proposals are available.")); setSaveStatus("No cases to review"); return; }
  const resume = mode === "browser" ? await readStore("meta", "position:" + bundle.bundle_id) : null;
  const resumeIndex = cases.findIndex(item => item.fingerprint === resume);
  if (resumeIndex >= 0) state.index = resumeIndex;
  renderNavigation(); renderCase();
}
function renderNavigation() {
  const select = byId("case-select"); select.replaceChildren();
  state.cases.forEach((item, index) => {
    const answer = state.records.get(item.fingerprint); const judgment = answer ? answer.response.judgment : "";
    const option = node("option", `${index + 1}. ${printable(item.municipality)}, ${printable(item.state)}${judgment ? " · " + judgment : ""}`); option.value = String(index); select.append(option);
  });
  select.value = String(state.index);
  byId("previous").disabled = state.index === 0; byId("next").disabled = state.index === state.cases.length - 1;
  const reviewed = [...state.records.values()].filter(record => ["agree", "dispute"].includes(record.response.judgment)).length;
  const skipped = [...state.records.values()].filter(record => record.response.judgment === "skip").length;
  byId("progress").textContent = `${state.index + 1} of ${state.cases.length} · ${reviewed} reviewed${skipped ? " · " + skipped + " skipped" : ""}`;
}
function renderCase() {
  const item = state.cases[state.index]; const record = state.records.get(item.fingerprint);
  state.current = {item, revision: record ? record.revision : 0, response: record ? {...record.response} : blankResponse()}; state.dirty = false;
  byId("agency").textContent = `${printable(item.municipality)}, ${printable(item.state)}`;
  byId("case-subtitle").textContent = `${item.agency_id} · ${item.case_id}`;
  byId("original-name").textContent = printable(item.original.candidate_name);
  const original = byId("original-details"); original.replaceChildren();
  addDetail(original, "Directory editions (not proven service years)", item.original.observed_years);
  addDetail(original, "Listed role", item.original.role_candidates);
  addDetail(original, "Directory page references", item.original.source_page_references);
  renderEvidence(item.evidence);
  byId("stage").textContent = item.provenance && item.provenance.stage === "pending" ? "Research proposal — not yet a validated correction" : "Research proposal · development review";
  byId("proposal-decision").textContent = DECISIONS[item.proposal.decision];
  byId("proposal-summary").textContent = printable(item.proposal.summary);
  const rationale = item.proposal.rationale || item.proposal.adjudication_notes;
  byId("proposal-rationale").hidden = !rationale;
  byId("proposal-rationale").textContent = rationale ? printable(rationale) : "";
  const proposal = byId("proposal-details"); proposal.replaceChildren();
  addDetail(proposal, "Proposed name", item.proposal.canonical_name);
  addDetail(proposal, "Role", item.proposal.role_status);
  addDetail(proposal, "Appointment bounds (years)", windowLabel(item.proposal.appointment_after, item.proposal.appointment_by));
  addDetail(proposal, "Departure bounds (years)", windowLabel(item.proposal.departure_after, item.proposal.departure_by));
  const limitations = byId("limitations"); limitations.replaceChildren();
  const values = Array.isArray(item.proposal.limitations) ? item.proposal.limitations : item.proposal.limitations ? [item.proposal.limitations] : [];
  for (const value of values) limitations.append(node("li", printable(value)));
  if (item.proposal.decision === "accept_original") limitations.append(node("li", "Keeping the original entry does not verify service in every listed directory year."));
  document.querySelectorAll('input[name="judgment"]').forEach(input => { input.checked = input.value === state.current.response.judgment; });
  byId("note").value = state.current.response.note; byId("corrected-name").value = state.current.response.corrected_name; byId("corrected-year").value = state.current.response.corrected_year;
  byId("corrections").hidden = state.current.response.judgment !== "dispute";
  setSaveStatus(record ? "Saved · revision " + record.revision : "Not reviewed yet");
}
function renderEvidence(evidence) {
  const target = byId("evidence"); target.replaceChildren();
  if (!evidence.length) { target.append(node("p", "No supporting source has been attached. A failed search does not establish that someone never served.", "muted")); return; }
  for (const source of evidence) {
    const block = node("article", undefined, "source"); const link = safeURL(source.source_url);
    const title = printable(source.source_title || source.source_publisher || source.source_url || "Untitled source");
    if (link) { const anchor = node("a", title + " ↗"); anchor.href = link; anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; anchor.referrerPolicy = "no-referrer"; block.append(anchor); }
    else block.append(node("span", title));
    block.append(node("p", [source.source_publisher, source.source_publication_date].filter(Boolean).join(" · "), "source-meta"));
    block.append(node("blockquote", printable(source.evidence_quote)));
    if (source.notes) block.append(node("p", printable(source.notes), "muted"));
    const details = node("details"); details.append(node("summary", "Source details")); const list = node("dl");
    for (const [label, key] of [["Evidence ID", "evidence_id"], ["Claim", "claim_type"], ["Support", "support_direction"], ["Date precision", "date_precision"], ["Event from", "event_date_lower"], ["Event through", "event_date_upper"], ["Accessed", "access_date"]]) addDetail(list, label, source[key]);
    details.append(list); block.append(details); target.append(block);
  }
}
function captureResponse() {
  if (!state.current || state.busy) return;
  const selected = document.querySelector('input[name="judgment"]:checked');
  const judgment = selected ? selected.value : "";
  state.current.response = {judgment, note: byId("note").value, corrected_name: judgment === "dispute" ? byId("corrected-name").value : "", corrected_year: judgment === "dispute" ? byId("corrected-year").value : ""};
  if (judgment !== "dispute") { byId("corrected-name").value = ""; byId("corrected-year").value = ""; }
  byId("corrections").hidden = judgment !== "dispute";
  state.generation += 1; state.dirty = true; setSaveStatus("Saving…");
  clearTimeout(state.timer); state.timer = setTimeout(() => flushSave().catch(() => {}), 350);
}
async function flushSave() {
  clearTimeout(state.timer);
  if (state.pending) { await state.pending; if (state.dirty) return flushSave(); return; }
  if (!state.dirty || !state.current) return;
  const active = state.current; const generation = state.generation; const response = {...active.response};
  state.pending = (async () => {
    validateResponse(response);
    const result = state.mode === "server" ? await api("/api/save", {case_id: active.item.case_id, case_fingerprint: active.item.fingerprint, expected_revision: active.revision, response}) : await saveBrowserAnswer(active.item, active.revision, response);
    active.revision = result.revision; state.records.set(active.item.fingerprint, result);
    if (state.generation === generation) { state.dirty = false; setSaveStatus("Saved · revision " + result.revision); }
    renderNavigation();
  })();
  try { await state.pending; } catch (error) { setSaveStatus("Not saved — " + error.message, true); throw error; } finally { state.pending = null; }
  if (state.dirty) return flushSave();
}
async function navigate(index) {
  if (state.busy || !state.current || index < 0 || index >= state.cases.length) return;
  lockEditing(true);
  try {
    await flushSave(); state.index = index; renderNavigation(); renderCase();
    if (state.mode === "browser") await putMeta("position:" + state.bundle.bundle_id, state.current.item.fingerprint);
    window.scrollTo({top: 0, behavior: "smooth"});
  } catch (error) { byId("case-select").value = String(state.index); showNotice("Navigation paused so your draft is not lost. " + error.message); } finally { lockEditing(false); }
}
function download(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2) + "\n"], {type: "application/json"}); const url = URL.createObjectURL(blob);
  const anchor = node("a"); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function exportAnswers() {
  try {
    await flushSave();
    let history;
    if (state.mode === "server") history = (await api("/api/export")).history;
    else history = await new Promise((resolve, reject) => { const request = state.db.transaction("history").objectStore("history").getAll(); request.onsuccess = () => resolve(request.result.filter(record => record.bundle_id === state.bundle.bundle_id && state.cases.some(item => item.fingerprint === record.case_fingerprint))); request.onerror = () => reject(request.error); });
    download({schema_version: "1.0", review_type: REVIEW_TYPE, bundle_id: state.bundle.bundle_id, exported_at: new Date().toISOString(), answers: [...state.records.values()], history}, "chief_tenure_proposal_answers.json");
    showNotice("Answer backup exported. Keep the downloaded JSON with your private case file.");
  } catch (error) { showNotice("Export paused: " + error.message + " Use Export unsaved draft if needed."); }
}
function exportDraft() {
  if (!state.current) return;
  download({schema_version: "1.0", review_type: REVIEW_TYPE, bundle_id: state.bundle.bundle_id, unsaved_draft: true, case_id: state.current.item.case_id, case_fingerprint: state.current.item.fingerprint, response: state.current.response}, "chief_tenure_unsaved_draft.json");
}
async function readFile(input) {
  const file = input.files[0]; requireValue(file && file.size <= MAX_BYTES, "Select a JSON file smaller than 20 MB.");
  try { return JSON.parse(await file.text()); } catch (_) { throw new Error("The selected file is not valid JSON."); }
}
async function importBundle() {
  if (state.busy) { byId("bundle-file").value = ""; return; }
  lockEditing(true);
  try { await flushSave(); const bundle = validateBundle(await readFile(byId("bundle-file"))); await installBundle(bundle, "browser"); showNotice("Case file opened locally. Answers are tied to this bundle and each exact case: changed evidence starts a fresh review, while old answers remain in storage."); }
  catch (error) { showNotice(error.message); }
  finally { byId("bundle-file").value = ""; lockEditing(false); }
}
async function restoreAnswers() {
  if (state.busy) { byId("answers-file").value = ""; return; }
  lockEditing(true);
  try {
    await flushSave(); const backup = await readFile(byId("answers-file"));
    requireValue(isObject(backup) && backup.schema_version === "1.0" && backup.review_type === REVIEW_TYPE && backup.bundle_id === state.bundle.bundle_id && Array.isArray(backup.answers), "This answer backup does not match the open case bundle.");
    const prepared = []; const seen = new Set();
    for (const answer of backup.answers) {
      requireValue(isObject(answer), "Invalid answer in backup."); const item = state.cases.find(candidate => candidate.case_id === answer.case_id && candidate.fingerprint === answer.case_fingerprint);
      requireValue(item && !seen.has(item.fingerprint), "Backup contains a duplicate, changed, or unknown case. Open its matching case file first.");
      validateResponse(answer.response); seen.add(item.fingerprint);
      const existing = state.records.get(item.fingerprint);
      requireValue(!existing || canonical(existing.response) === canonical(answer.response), "A saved answer differs from this backup. No answers were restored; keep both exports for reconciliation.");
      if (!existing) prepared.push({item, answer});
    }
    for (const {item, answer} of prepared) {
      const saved = state.mode === "server" ? await api("/api/save", {case_id: item.case_id, case_fingerprint: item.fingerprint, expected_revision: 0, response: answer.response}) : await saveBrowserAnswer(item, 0, answer.response);
      state.records.set(item.fingerprint, saved);
    }
    renderNavigation(); renderCase(); showNotice(`${prepared.length} answers restored as new revisions. The backup file retains its original revision history.`);
  } catch (error) { showNotice(error.message); } finally { byId("answers-file").value = ""; lockEditing(false); }
}
async function start() {
  byId("bundle-file").addEventListener("change", importBundle); byId("answers-file").addEventListener("change", restoreAnswers);
  byId("export").addEventListener("click", exportAnswers); byId("export-draft").addEventListener("click", exportDraft); byId("retry-save").addEventListener("click", () => flushSave().catch(() => {}));
  byId("previous").addEventListener("click", () => navigate(state.index - 1)); byId("next").addEventListener("click", () => navigate(state.index + 1)); byId("case-select").addEventListener("change", event => navigate(Number(event.target.value)));
  document.querySelectorAll('input[name="judgment"]').forEach(input => input.addEventListener("change", captureResponse));
  for (const id of ["note", "corrected-name", "corrected-year"]) byId(id).addEventListener("input", captureResponse);
  window.addEventListener("beforeunload", event => { if (state.dirty || state.pending) { event.preventDefault(); event.returnValue = ""; } });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSave().catch(() => {}); });
  try {
    state.token = document.querySelector('meta[name="review-local-token"]').content;
    try { state.db = await openDatabase(); } catch (error) { if (!state.token) throw error; byId("bundle-file").disabled = true; }
    if (state.token) await installBundle((await api("/api/bootstrap")).bundle, "server");
    else {
      byId("storage-status").textContent = "Private browser storage ready";
      const bundle = await readStore("meta", "last_bundle"); if (bundle) await installBundle(bundle, "browser");
    }
  } catch (error) { showNotice(error.message); byId("storage-status").textContent = "Storage unavailable — do not start reviewing"; byId("bundle-file").disabled = true; }
}
if (typeof document !== "undefined") start();
if (typeof module !== "undefined") module.exports = {validateBundle, validateResponse, canonical, fingerprint, safeURL, answerKey, windowLabel};
