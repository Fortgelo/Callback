"use strict";
/* ===== Callback — suivi de candidatures 3D/VFX, app autonome (Google Sheet + Gmail + clé Anthropic) =====
   Sécurité : aucune fonction d'envoi de mail dans ce code. Gmail = lecture + création de brouillons. */

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const SCOPES = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose";
const COLS = { statut: "A", offre: "B", nom: "C", envoye: "D", dateEnvoi: "E", type: "F", contact: "G", site: "H", lieu: "I", relance: "J", dateRelance: "K", contactNom: "L", notes: "M", echange: "N" };
const STATUTS = ["À envoyer", "en attente", "En cours", "Entretien", "Accepté", "Refusé"];
const OFFRES = ["Généraliste 3D", "VFX", "Motion design", "Archviz", "Jeu vidéo", "Animation", "Pub / Agence", "Autre"];
const norm = s => String(s || "").trim().toLowerCase();
const label = s => { const t = String(s || "").trim(); return t ? t[0].toUpperCase() + t.slice(1) : "—"; };

/* ---------- Réglages ---------- */
const DEFAULT_CFG = { clientId: "", sheetId: "1Ad4UM8kgDshI3R-UFiEdExA_obPknI3byVynrY2GtVY", tab: "Feuille 1", apiKey: "", model: "claude-haiku-5-5", days: 14, nom: "Angelo Teixeira", liens: "", signature: "", tpl: {} };
const TPL = {
  fr: `Bonjour {prenom},

Je m'appelle {nom} et je suis 3D Généraliste.
Je travaille depuis 3 ans et j'ai participé à diverses productions : des documentaires et des publicités (France TV, DIOR, Nissan, Renault, Vichy, Cdiscount...).

J'aime beaucoup les projets de {entreprise}, je souhaitais donc prendre un premier contact avec vous.
Si vous recherchez un généraliste 3D ou du compositing, je suis disponible en freelance :)

{liens}`,
  en: `Hi {prenom} !

My name is {nom} and I'm a 3D Generalist based in Paris.

I've been working in the industry for 3 years, mainly on documentaries and commercials for clients such as DIOR, France TV, Nissan, Renault, Vichy, Cdiscount....

I really like the projects of {entreprise}, so I wanted to reach out and introduce myself.

If you're ever looking for a 3D Generalist/Compositing, I'm currently available for freelance work :)

{liens}`,
  relance_fr: `Bonjour {prenom},

Je me permets de revenir vers vous suite à mon message du {date}.
Je reste disponible en freelance si {entreprise} recherche un généraliste 3D ou du compositing, et je serais ravi d'échanger avec vous.

Belle journée,`,
  relance_en: `Hi {prenom} !

Just following up on my message from {date}.
I'm still available for freelance work as a 3D Generalist / Compositor, and I'd love to chat if {entreprise} has a need.

Best,`
};
const getTpl = k => (cfg.tpl && cfg.tpl[k]) || TPL[k];
let cfg = { ...DEFAULT_CFG, ...JSON.parse(localStorage.getItem("cand_cfg") || "{}") };
const saveCfg = () => localStorage.setItem("cand_cfg", JSON.stringify(cfg));

let items = [], tab = "Toutes", open = null, demo = false, me = "";

/* ---------- Dates ---------- */
function parseFR(s) {
  s = String(s || "").trim(); if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); if (!m) return "";
  const y = m[3].length === 2 ? "20" + m[3] : m[3];
  return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}
const toFR = iso => iso ? iso.split("-").reverse().join("/") : "";
const todayISO = () => new Date().toISOString().slice(0, 10);
const daysSince = iso => iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 864e5) : null;
const needsRelance = it => norm(it.statut) === "en attente" && it.dateEnvoi && daysSince(it.dateRelance || it.dateEnvoi) >= cfg.days;

/* ---------- Authentification Google ---------- */
let token = "", tokenExp = 0, tokenClient = null;
function loadGsi() {
  return new Promise((res, rej) => {
    if (window.google?.accounts?.oauth2) return res();
    const s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client";
    s.onload = res; s.onerror = () => rej(new Error("Impossible de charger Google Identity")); document.head.appendChild(s);
  });
}
async function connect() {
  if (!cfg.clientId) { openSettings(); throw new Error("Renseigne d'abord le Client ID Google dans les réglages."); }
  await loadGsi();
  return new Promise((res, rej) => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId, scope: SCOPES,
      callback: r => {
        if (r.error) return rej(new Error(r.error_description || r.error));
        token = r.access_token; tokenExp = Date.now() + (r.expires_in - 60) * 1000;
        localStorage.setItem("cand_auth", "1"); res();
      },
      error_callback: e => rej(new Error(e.message || e.type || "Connexion annulée"))
    });
    tokenClient.requestAccessToken({ prompt: localStorage.getItem("cand_auth") ? "" : "consent" });
  });
}
const authed = () => demo || (token && Date.now() < tokenExp);
async function gfetch(url, opts = {}) {
  if (!authed()) { const e = new Error("Session Google expirée : clique sur « Se connecter à Google »."); e.auth = true; throw e; }
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + token, "Content-Type": "application/json" } });
  if (r.status === 401) { token = ""; const e = new Error("Session Google expirée : clique sur « Se connecter à Google »."); e.auth = true; throw e; }
  if (!r.ok) throw new Error(`Google ${r.status} : ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}

/* ---------- Backend : Google Sheet ---------- */
const rowToItem = (r, row) => ({
  row, statut: r[0] || "", offre: r[1] || "", nom: (r[2] || "").trim(), envoye: /true/i.test(r[3] || ""),
  dateEnvoi: parseFR(r[4]), type: r[5] || "", contact: r[6] || "", site: r[7] || "", lieu: r[8] || "",
  relance: /true/i.test(r[9] || ""), dateRelance: parseFR(r[10]), contactNom: r[11] || "", notes: r[12] || "", echange: r[13] || ""
});
const cellValue = (k, v) => k === "envoye" || k === "relance" ? (v ? "TRUE" : "FALSE") : (k === "dateEnvoi" || k === "dateRelance") ? toFR(v) : (v ?? "");
const range = r => encodeURIComponent(`'${cfg.tab}'!${r}`);
const SHEETS = () => `https://sheets.googleapis.com/v4/spreadsheets/${cfg.sheetId}`;

const SheetBackend = {
  async load() {
    const d = await gfetch(`${SHEETS()}/values/${range("A1:N1500")}?valueRenderOption=FORMATTED_VALUE`);
    const v = d.values || [];
    const head = v[0] || [];
    if (!head[11] && !head[12] && !head[13]) {
      const meta = await gfetch(`${SHEETS()}?fields=sheets.properties`);
      const p = (meta.sheets || []).map(x => x.properties).find(x => x.title === cfg.tab);
      if (p && p.gridProperties.columnCount < 14) {
        await gfetch(`${SHEETS()}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: [{ appendDimension: { sheetId: p.sheetId, dimension: "COLUMNS", length: 14 - p.gridProperties.columnCount } }] }) });
      }
      await gfetch(`${SHEETS()}/values/${range("L1:N1")}?valueInputOption=USER_ENTERED`, { method: "PUT", body: JSON.stringify({ values: [["Nom du contact", "Notes", "Dernier échange"]] }) });
    }
    return v.slice(1).map((r, i) => rowToItem(r, i + 2)).filter(x => x.nom);
  },
  async set(it, changes) {
    const data = Object.entries(changes).map(([k, val]) => ({ range: `'${cfg.tab}'!${COLS[k]}${it.row}`, values: [[cellValue(k, val)]] }));
    await gfetch(`${SHEETS()}/values:batchUpdate`, { method: "POST", body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }) });
  },
  async add(it) {
    const next = Math.max(1, ...items.map(x => x.row)) + 1;
    it.row = next;
    const vals = Object.keys(COLS).map(k => cellValue(k, it[k]));
    await gfetch(`${SHEETS()}/values/${range(`A${next}:N${next}`)}?valueInputOption=USER_ENTERED`, { method: "PUT", body: JSON.stringify({ values: [vals] }) });
    return it;
  }
};
/* ---------- Backend : démo (sans Google) ---------- */
const DemoBackend = {
  async load() {
    const mk = (row, nom, statut, d, contact, extra = {}) => ({ row, nom, statut, offre: "Généraliste 3D", envoye: statut !== "À envoyer", dateEnvoi: d, type: contact.startsWith("http") ? "Formulaire (site web)" : "Mail (spontanée)", contact, site: "https://example.com", lieu: "Paris", relance: false, dateRelance: "", contactNom: "", notes: "", echange: "", ...extra });
    return [mk(2, "Pôle nord studio", "en attente", "2026-01-20", "contact@exemple.fr"), mk(3, "Onirim", "en attente", "2026-11-20", "contact@exemple.com"),
      mk(4, "NOID", "Entretien", "2026-01-28", "https://exemple.com/contact"), mk(5, "elium", "Refusé", "2026-01-20", "mail@exemple.studio"),
      mk(6, "SwanSide", "Accepté", "2026-02-06", "contact@exemple.fr"), mk(7, "Mikros", "À envoyer", "", "jobs@exemple.com", { envoye: false })];
  },
  async set() {}, async add(it) { it.row = Math.max(1, ...items.map(x => x.row)) + 1; return it; }
};
const backend = () => demo ? DemoBackend : SheetBackend;

async function loadAll() {
  try { items = await backend().load(); render(); }
  catch (e) {
    render();
    const hint = /403|404/.test(e.message) ? " → Le compte Google connecté n'a pas accès à ce Sheet, ou l'ID du Sheet dans Réglages est faux. Partage le Sheet avec ce compte, ou colle l'ID d'un Sheet auquel il a accès." : "";
    banner(`<b>Impossible de lire le Sheet.</b> ${esc(e.message)}${hint}`);
  }
}
async function change(it, changes) {
  Object.assign(it, changes);
  render();
  try { await backend().set(it, changes); }
  catch (e) { banner(`<b>Modification non enregistrée dans le Sheet.</b> ${esc(e.message)}`); }
}

/* ---------- Gmail : lecture + brouillons uniquement ---------- */
const GM = "https://gmail.googleapis.com/gmail/v1/users/me";
const GENERIC = /(gmail|outlook|hotmail|yahoo|icloud|orange|free|wanadoo|live)\./i;
function domainOf(it) {
  const m = (it.contact || "").match(/@([^\s>]+)/); if (m && !GENERIC.test(m[1])) return m[1].toLowerCase();
  try { return new URL(it.site).hostname.replace(/^www\./, ""); } catch { return ""; }
}
async function myAddress() { if (!me) me = (await gfetch(`${GM}/profile`)).emailAddress.toLowerCase(); return me; }
async function searchThreads(it) {
  const d = domainOf(it), parts = [`"${it.nom}"`]; if (d) parts.unshift(`from:${d}`, `to:${d}`);
  const q = `in:anywhere (${parts.join(" OR ")})`;
  const l = await gfetch(`${GM}/threads?q=${encodeURIComponent(q)}&maxResults=6`);
  const out = [];
  for (const t of l.threads || []) {
    const th = await gfetch(`${GM}/threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
    out.push(th);
  }
  return out;
}
const hdr = (m, n) => (m.payload?.headers || []).find(h => h.name.toLowerCase() === n.toLowerCase())?.value || "";
function analyse(threads) {
  let sent = null, reply = null;
  for (const t of threads) for (const m of t.messages || []) {
    const ts = +m.internalDate, isSent = (m.labelIds || []).includes("SENT");
    if (isSent && (!sent || ts < sent.ts)) sent = { ts, subject: hdr(m, "Subject"), threadId: t.id, to: hdr(m, "To") };
    if (!isSent && (!reply || ts > reply.ts)) reply = { ts, from: hdr(m, "From"), subject: hdr(m, "Subject"), snippet: m.snippet || "", threadId: t.id };
  }
  return { sent, reply };
}
const isoOf = ts => new Date(ts).toISOString().slice(0, 10);

async function checkOne(it) {
  const th = await searchThreads(it);
  return { it, threads: th, ...analyse(th) };
}
function proposalHtml(r) {
  const it = r.it; let h = `<div class="prop"><b>${esc(it.nom)}</b> — ${r.threads.length} échange(s)<br>`;
  if (r.sent) h += `Mail envoyé le ${toFR(isoOf(r.sent.ts))} (« ${esc(r.sent.subject)} »). `;
  if (r.reply) h += `<br>Dernière réponse (${toFR(isoOf(r.reply.ts))}) de ${esc(r.reply.from)} : <i>${esc(r.reply.snippet.slice(0, 160))}</i>`;
  h += `<div class="row" style="margin-top:6px">`;
  if (r.sent && (!it.envoye || !it.dateEnvoi)) h += `<button data-a="applySent" data-r="${it.row}">Marquer envoyé le ${toFR(isoOf(r.sent.ts))}</button>`;
  if (r.reply) h += ["Entretien", "En cours", "Refusé"].map(s => `<button data-a="applyStatus" data-r="${it.row}" data-s="${s}">→ ${s}</button>`).join("");
  return h + `</div></div>`;
}
let lastResults = {};
function showProposals(el, results) {
  lastResults = Object.fromEntries(results.map(r => [r.it.row, r]));
  el.innerHTML = results.length ? results.map(proposalHtml).join("") : '<p class="note">Rien de nouveau dans Gmail.</p>';
}
function mimeHeader(s) { return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(unescape(encodeURIComponent(s)))}?=`; }
const b64url = s => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function createDraft({ to, subject, body, threadId, html }) {
  const bodyB64 = btoa(unescape(encodeURIComponent(body))).replace(/(.{76})/g, "$1\r\n");
  const raw = b64url([`To: ${to}`, `Subject: ${mimeHeader(subject)}`, "MIME-Version: 1.0", `Content-Type: text/${html ? "html" : "plain"}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", bodyB64].join("\r\n"));
  const message = { raw }; if (threadId) message.threadId = threadId;
  return gfetch(`${GM}/drafts`, { method: "POST", body: JSON.stringify({ message }) });
}

/* ---------- IA : API Anthropic (clé de l'utilisateur) ---------- */
async function askClaude(prompt, { web = false, max = 1500 } = {}) {
  if (!cfg.apiKey) throw new Error("Ajoute ta clé API Anthropic dans les réglages pour utiliser l'IA.");
  const body = { model: cfg.model, max_tokens: max, messages: [{ role: "user", content: prompt }] };
  if (web) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }];
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status} : ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return (d.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}
function parseJSON(t) {
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("Réponse de l'IA illisible.");
  return JSON.parse(t.slice(a, b + 1));
}

/* ---------- Rendu ---------- */
function banner(html) { $("#banner").innerHTML = html || ""; }
function render() {
  $("#authState").textContent = demo ? "mode démo" : authed() ? "connecté à Google" : "non connecté";
  $("#authState").className = "pill " + (demo ? "warn" : authed() ? "good" : "");
  const n = f => items.filter(f).length;
  $("#stats").innerHTML = [["Entreprises", items.length], ["Envoyées", n(i => i.envoye)], ["En attente", n(i => norm(i.statut) === "en attente")], ["À relancer", n(needsRelance)],
    ["Entretiens / en cours", n(i => ["entretien", "accepté", "en cours"].includes(norm(i.statut)))], ["Refus", n(i => norm(i.statut) === "refusé")]]
    .map(([l, v]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");
  const tabs = ["Toutes", "À relancer", ...STATUTS];
  $("#tabs").innerHTML = tabs.map(t => `<button data-t="${esc(t)}" class="${t === tab ? "on" : ""}">${label(t)}</button>`).join("");
  const q = norm($("#q").value);
  let list = items.filter(i => !q || norm(i.nom).includes(q));
  if (tab === "À relancer") list = list.filter(needsRelance); else if (tab !== "Toutes") list = list.filter(i => norm(i.statut) === norm(tab));
  list.sort((a, b) => (b.dateEnvoi || "").localeCompare(a.dateEnvoi || ""));
  $("#list").innerHTML = list.length ? list.map(rowHtml).join("") : '<p class="note">Aucune ligne.</p>';
}
function statusClass(s) { s = norm(s); return s === "refusé" ? "bad" : ["entretien", "accepté"].includes(s) ? "good" : ["en attente", "en cours"].includes(s) ? "blue" : ""; }
function rowHtml(it) {
  let h = `<div class="item"><div class="head" data-o="${it.row}"><span class="n">${esc(it.nom)}</span>
    ${needsRelance(it) ? '<span class="pill warn">à relancer</span>' : ""}<span class="pill">${esc(it.offre || "—")}</span>
    <span class="pill">${toFR(it.dateEnvoi) || "—"}</span><span class="pill ${statusClass(it.statut)}">${esc(label(it.statut))}</span></div>`;
  if (open === it.row) {
    const inp = (k, lab, type = "text") => `<div><label>${lab}</label><input type="${type}" data-f="${k}" value="${esc(it[k])}"></div>`;
    h += `<div class="det" data-r="${it.row}">
      <div><label>Statut</label><select data-f="statut">${[...new Set([...STATUTS, it.statut].filter(Boolean))].map(s => `<option value="${esc(s)}" ${norm(s) === norm(it.statut) ? "selected" : ""}>${esc(label(s))}</option>`).join("")}</select></div>
      <div><label>Offre</label><select data-f="offre">${[...new Set([...OFFRES, it.offre].filter(Boolean))].map(s => `<option ${s === it.offre ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></div>
      ${inp("dateEnvoi", "Date d'envoi", "date")}${inp("dateRelance", "Dernière relance", "date")}
      ${inp("contact", "Contact (mail ou lien du formulaire)")}${inp("contactNom", "Nom du contact")}${inp("site", "Site web")}${inp("lieu", "Lieu")}
      <div class="full"><label>Notes</label><input data-f="notes" value="${esc(it.notes)}"></div>
      <div class="full row"><button data-a="mail">Préparer le mail</button>${needsRelance(it) ? '<button data-a="relance">Préparer la relance</button>' : ""}
        <button data-a="gmail">Vérifier dans Gmail</button><button data-a="relanced">J'ai relancé aujourd'hui</button></div>
      <div class="full" id="box-${it.row}"></div></div>`;
  }
  return h + "</div>";
}

/* ---------- Événements ---------- */
$("#tabs").addEventListener("click", e => { if (e.target.dataset.t) { tab = e.target.dataset.t; render(); } });
$("#q").addEventListener("input", render);
$("#list").addEventListener("change", e => {
  const f = e.target.dataset.f; if (!f) return;
  const it = items.find(x => x.row == e.target.closest(".det").dataset.r);
  const ch = { [f]: e.target.value };
  if (f === "statut" && norm(e.target.value) !== "à envoyer" && !it.envoye) { ch.envoye = true; if (!it.dateEnvoi) ch.dateEnvoi = todayISO(); }
  change(it, ch);
});
document.addEventListener("click", async e => {
  const t = e.target; if (!(t instanceof HTMLElement)) return;
  const head = t.closest(".head"); if (head) { open = open === +head.dataset.o ? null : +head.dataset.o; render(); return; }
  const a = t.dataset.a; if (!a) return;
  try {
    if (a === "applySent") { const r = lastResults[t.dataset.r]; await change(r.it, { envoye: true, dateEnvoi: isoOf(r.sent.ts), statut: norm(r.it.statut) === "à envoyer" || !r.it.statut ? "en attente" : r.it.statut, echange: `Mail du ${toFR(isoOf(r.sent.ts))}` }); t.disabled = true; t.textContent = "Appliqué"; return; }
    if (a === "applyStatus") { const r = lastResults[t.dataset.r]; await change(r.it, { statut: t.dataset.s, echange: `Réponse du ${toFR(isoOf(r.reply.ts))}` }); t.disabled = true; t.textContent = "Appliqué"; return; }
    const it = items.find(x => x.row == t.closest(".det")?.dataset.r); if (!it) return;
    const box = $("#box-" + it.row);
    if (a === "relanced") await change(it, { relance: true, dateRelance: todayISO() });
    if (a === "gmail") { box.innerHTML = '<p class="note">Recherche dans Gmail…</p>'; showProposals(box, [await checkOne(it)]); }
    if (a === "mail" || a === "relance") await mailBox(it, box, a === "relance");
  } catch (err) { const b = t.closest(".det")?.querySelector(".full:last-child") || $("#banner"); b.innerHTML = `<p class="err">${esc(err.message)}</p>`; }
});
$("#btnConnect").onclick = async () => { try { await connect(); banner(""); await loadAll(); } catch (e) { banner(`<b>Connexion impossible.</b> ${esc(e.message)}`); } };
$("#btnSync").onclick = async () => {
  const out = $("#syncOut"), todo = items.filter(i => ["en attente", "à envoyer", ""].includes(norm(i.statut)));
  if (demo) { out.innerHTML = '<p class="warn">Indisponible en mode démo.</p>'; return; }
  $("#btnSync").disabled = true; const res = [];
  try {
    for (let k = 0; k < todo.length; k++) {
      out.innerHTML = `<p class="note">Gmail : ${k + 1}/${todo.length} — ${esc(todo[k].nom)}…</p>`;
      const r = await checkOne(todo[k]);
      if ((r.sent && (!r.it.envoye || !r.it.dateEnvoi)) || r.reply) res.push(r);
    }
    showProposals(out, res);
  } catch (e) { out.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  $("#btnSync").disabled = false;
};

/* ---------- Ajouter une entreprise ---------- */
$("#btnAdd").onclick = async () => {
  const name = $("#newName").value.trim(), out = $("#addOut"); if (!name) return;
  const dup = items.find(i => norm(i.nom) === norm(name));
  if (dup) { out.innerHTML = `<p class="warn">« ${esc(dup.nom)} » est déjà dans la liste.</p>`; open = dup.row; tab = "Toutes"; render(); return; }
  out.innerHTML = '<p class="note">Analyse en cours…</p>'; $("#btnAdd").disabled = true;
  let info = { site: "", lieu: "", offre: "Généraliste 3D", contact: "", type: "Mail (spontanée)", notes: "" }, gm = "";
  try {
    if (!demo && authed()) { const th = await searchThreads({ nom: name, contact: "", site: "" }); if (th.length) gm = `<p class="warn">Gmail contient déjà ${th.length} échange(s) avec « ${esc(name)} » : vérifie avant d'écrire.</p>`; }
    if (cfg.apiKey) {
      const t = await askClaude(`Entreprise : "${name}" (studio/agence 3D, VFX, motion, pub ou jeu vidéo, probablement en France). Cherche sur le web et réponds par un JSON seul : {"site":"url officielle","lieu":"ville","offre":une valeur parmi ${JSON.stringify(OFFRES)},"contact":"adresse mail de contact/recrutement VUE sur leur site ou, à défaut, l'url de leur formulaire de contact, sinon ''","type":"Mail (spontanée)" ou "Formulaire (site web)","notes":"1 phrase sur leur activité"}. N'invente jamais une adresse mail : laisse '' si tu ne l'as pas vue.`, { web: true });
      info = { ...info, ...parseJSON(t) };
    } else gm += '<p class="note">Sans clé API, la fiche est à remplir à la main.</p>';
  } catch (e) { gm += `<p class="err">${esc(e.message)}</p>`; }
  const id = "p" + Date.now(), f = (k, l) => `<div><label>${l}</label><input id="${id}${k}" value="${esc(info[k] || "")}"></div>`;
  out.innerHTML = `${gm}<div class="prop"><div class="det">${f("site", "Site")}${f("lieu", "Lieu")}${f("offre", "Offre")}${f("contact", "Contact (mail ou formulaire)")}${f("type", "Type de candidature")}<div class="full"><label>Notes</label><input id="${id}notes" value="${esc(info.notes || "")}"></div></div>
    <p class="note">Vérifie ces infos avant de les enregistrer (l'IA peut se tromper).</p><button class="pri" id="${id}ok">Ajouter au Sheet</button></div>`;
  $(`#${id}ok`).onclick = async () => {
    const g = k => $(`#${id}${k}`).value.trim();
    const it = { statut: "À envoyer", nom: name, offre: g("offre"), envoye: false, dateEnvoi: "", type: g("type"), contact: g("contact"), site: g("site"), lieu: g("lieu"), relance: false, dateRelance: "", contactNom: "", notes: g("notes"), echange: "" };
    try { await backend().add(it); items.push(it); open = it.row; tab = "Toutes"; $("#newName").value = ""; out.innerHTML = `<p class="note">« ${esc(name)} » ajoutée (ligne ${it.row}).</p>`; render(); }
    catch (e) { out.innerHTML += `<p class="err">${esc(e.message)}</p>`; }
  };
  $("#btnAdd").disabled = false;
};

/* ---------- Mail / relance : brouillon seulement ---------- */
const FR_HINT = /paris|lyon|marseille|bordeaux|lille|nantes|toulouse|montpellier|rennes|strasbourg|annecy|angoul|nice|france|\.fr\b/i;
const linkify = t => esc(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/(^|[\s>])([\w.+-]+@[\w-]+\.[\w.-]+)/g, '$1<a href="mailto:$2">$2</a>');
const FONT = "font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#000;line-height:1.5";
function liensTexte(lang) {
  return (cfg.liens || "").split("\n").map(l => l.trim()).filter(Boolean).map(l => { const [a, ...b] = l.split("|"); return b.length ? `${a.trim()}${lang === "fr" ? " : " : ": "}${b.join("|").trim()}` : l; }).join("\n");
}
function fillTpl(key, lang, it) {
  const prenom = (it.contactNom || "").trim().split(/\s+/)[0] || "";
  const t = getTpl(key).replace(/ ?\{prenom\}/g, prenom ? " " + prenom : "").replace(/\{nom\}/g, cfg.nom).replace(/\{entreprise\}/g, it.nom)
    .replace(/\{date\}/g, toFR(it.dateEnvoi) || "…").replace(/\{liens\}/g, liensTexte(lang));
  return t.replace(/\n{3,}/g, "\n\n").trim();
}
function toHtml(body) {
  const sig = (cfg.signature || "").split("\n").map(l => l.trim()).filter(Boolean);
  const sigHtml = sig.length ? `<br><br><div style="font-family:Arial,Helvetica,sans-serif;color:#888;font-size:12px;line-height:1.5"><b style="font-size:13px">${esc(sig[0])}</b>${sig.slice(1).map(l => "<br>" + linkify(l)).join("")}</div>` : "";
  return `<div style="${FONT}">${body.split("\n").map(l => linkify(l)).join("<br>")}</div>${sigHtml}`;
}
async function mailBox(it, box, isRelance) {
  const guess = FR_HINT.test(`${it.lieu} ${it.contact}`) ? "fr" : "en";
  const draw = lang => {
    const subj = isRelance ? (lang === "fr" ? "Re : 3D/VFX" : "Re: 3D/VFX") : "3D/VFX";
    const body = fillTpl((isRelance ? "relance_" : "") + lang, lang, it);
    const canDraft = /@/.test(it.contact) && !demo;
    box.innerHTML = `<div class="row"><label class="note">Langue</label><select id="dLang"><option value="fr" ${lang === "fr" ? "selected" : ""}>Français</option><option value="en" ${lang === "en" ? "selected" : ""}>English</option></select></div>
      <label class="note">Objet</label><input id="dObj" style="width:100%" value="${esc(subj)}"><label class="note">Corps (la signature des Réglages est ajoutée automatiquement)</label><textarea id="dBody" rows="12">${esc(body)}</textarea>
      <div class="safe">Rien ne part d'ici : ce bouton crée un brouillon dans ton Gmail, que tu envoies toi-même.</div>
      <div class="row"><button class="pri" id="dGo" ${canDraft ? "" : "disabled"}>Créer le brouillon Gmail</button><button id="dCopy">Copier</button><span id="dMsg" class="note">${canDraft ? "" : "Il faut une adresse mail dans « Contact » (et être connecté)."}</span></div>`;
    $("#dLang").onchange = e => draw(e.target.value);
    $("#dCopy").onclick = () => navigator.clipboard.writeText($("#dObj").value + "\n\n" + $("#dBody").value + "\n\n" + (cfg.signature || "")).then(() => $("#dMsg").textContent = "Copié.", () => $("#dMsg").textContent = "Copie refusée : sélectionne le texte à la main.");
    $("#dGo").onclick = async () => {
      try {
        await createDraft({ to: it.contact.match(/[^\s<>,;]+@[^\s<>,;]+/)[0], subject: $("#dObj").value, body: toHtml($("#dBody").value), html: true });
        $("#dMsg").innerHTML = 'Brouillon créé. <a href="https://mail.google.com/mail/u/0/#drafts" target="_blank" rel="noopener">Ouvrir Gmail</a> — une fois envoyé, passe la ligne en « en attente ».';
      } catch (e) { $("#dMsg").textContent = "Échec : " + e.message; }
    };
  };
  draw(guess);
}

/* ---------- Réglages ---------- */
function openSettings() {
  $("#sClient").value = cfg.clientId; $("#sSheet").value = cfg.sheetId; $("#sTab").value = cfg.tab; $("#sKey").value = cfg.apiKey; $("#sModel").value = cfg.model;
  $("#sDays").value = cfg.days; $("#sNom").value = cfg.nom; $("#sLiens").value = cfg.liens; $("#sSig").value = cfg.signature; ["fr","en","relance_fr","relance_en"].forEach(k => $("#t_" + k).value = getTpl(k)); $("#dlgSettings").showModal();
}
$("#btnSettings").onclick = openSettings;
$("#fSettings").addEventListener("submit", e => {
  if (e.submitter?.value !== "save") return;
  cfg = { clientId: $("#sClient").value.trim(), sheetId: $("#sSheet").value.trim(), tab: $("#sTab").value.trim() || "Feuille 1", apiKey: $("#sKey").value.trim(), model: $("#sModel").value.trim() || "claude-haiku-5-5",
    days: +$("#sDays").value || 14, nom: $("#sNom").value.trim(), liens: $("#sLiens").value.trim(), signature: $("#sSig").value.trim(), tpl: Object.fromEntries(["fr","en","relance_fr","relance_en"].map(k => [k, $("#t_" + k).value]).filter(([k, v]) => v.trim() && v.trim() !== TPL[k].trim())) };
  saveCfg(); render();
});
$("#btnDemo").onclick = async () => { $("#dlgSettings").close(); demo = true; banner('<b>Mode démo</b> : données fictives, rien n\'est écrit nulle part.'); await loadAll(); };

/* ---------- Démarrage ---------- */
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
render();
if (location.hash === "#demo") { demo = true; banner('<b>Mode démo</b> : données fictives, rien n\'est écrit nulle part.'); loadAll(); }
else if (!cfg.clientId) banner("Bienvenue ! Ouvre <b>Réglages</b> et renseigne ton Client ID Google pour connecter ton Sheet et Gmail (ou teste le mode démo).");
else banner("Clique sur <b>Se connecter à Google</b> pour charger ton Sheet.");
