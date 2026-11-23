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
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function gfetch(url, opts = {}, attempt = 0) {
  if (!authed()) { const e = new Error("Session Google expirée : clique sur « Se connecter à Google »."); e.auth = true; throw e; }
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + token, "Content-Type": "application/json" } });
  if (r.status === 401) { token = ""; const e = new Error("Session Google expirée : clique sur « Se connecter à Google »."); e.auth = true; throw e; }
  if (!r.ok) {
    const txt = await r.text();
    if ((r.status === 429 || (r.status === 403 && /quota|rate/i.test(txt))) && attempt < 5) { onWait(attempt + 1); await sleep(20000); return gfetch(url, opts, attempt + 1); }
    throw new Error(`Google ${r.status} : ${txt.slice(0, 200)}`);
  }
  return r.status === 204 ? null : r.json();
}
let onWait = () => {};

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
  const l = await gfetch(`${GM}/threads?q=${encodeURIComponent(q)}&maxResults=4`);
  const out = [];
  for (const t of l.threads || []) {
    const th = await gfetch(`${GM}/threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
    out.push(th);
  }
  return out;
}
const decodeEnt = t => { const x = document.createElement("textarea"); x.innerHTML = t; return x.value; };
const AUTO = /no-?reply|notify|notification|mailer-daemon|newsletter|donotreply|do-not-reply|bounce|postmaster/i;
const hdr = (m, n) => (m.payload?.headers || []).find(h => h.name.toLowerCase() === n.toLowerCase())?.value || "";
function analyse(threads) {
  let sent = null, reply = null;
  for (const t of threads) for (const m of t.messages || []) {
    const ts = +m.internalDate, isSent = (m.labelIds || []).includes("SENT");
    if (isSent && (!sent || ts < sent.ts)) sent = { ts, subject: hdr(m, "Subject"), threadId: t.id, to: hdr(m, "To") };
    if (!isSent && !AUTO.test(hdr(m, "From")) && (!reply || ts > reply.ts)) reply = { ts, from: hdr(m, "From"), subject: hdr(m, "Subject"), snippet: decodeEnt(m.snippet || ""), threadId: t.id };
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

/* ---------- Gmail : entreprises contactées mais absentes du Sheet ---------- */
const normK = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
async function findNew() {
  const mine = await myAddress(), q = 'in:sent (subject:3D OR subject:VFX OR subject:candidature OR subject:generalist OR subject:généraliste)';
  const ids = []; let pt = "";
  for (let p = 0; p < 4; p++) {
    const l = await gfetch(`${GM}/messages?q=${encodeURIComponent(q)}&maxResults=100${pt ? "&pageToken=" + pt : ""}`);
    ids.push(...(l.messages || [])); pt = l.nextPageToken; if (!pt) break;
  }
  const msgs = [];
  for (let i = 0; i < ids.length; i += 5) {
    await sleep(500);
    const part = await Promise.all(ids.slice(i, i + 5).map(m => gfetch(`${GM}/messages/${m.id}?format=metadata&metadataHeaders=To&metadataHeaders=Subject`)));
    msgs.push(...part);
  }
  const known = new Set(items.map(domainOf).filter(Boolean)), names = items.map(i => normK(i.nom)).filter(n => n.length >= 3);
  const groups = {};
  for (const m of msgs) {
    const subj = hdr(m, "Subject"); if (/^\s*(re|tr|fwd?)\s*:/i.test(subj)) continue;
    const addr = (hdr(m, "To").match(/[^\s<>,;"]+@[^\s<>,;"]+/g) || []).map(a => a.toLowerCase()).find(a => a !== mine); if (!addr || AUTO.test(addr)) continue;
    const dom = addr.split("@")[1], key = GENERIC.test(dom) ? addr : dom;
    if (known.has(dom)) continue;
    const label = normK(dom.split(".").slice(0, -1).pop());
    if (names.some(n => label.includes(n) || (label.length >= 4 && n.includes(label)))) continue;
    const ts = +m.internalDate, g = groups[key] ||= { key, addr, dom, first: ts, last: ts, subject: subj, n: 0 };
    g.n++; g.first = Math.min(g.first, ts); g.last = Math.max(g.last, ts);
  }
  return Object.values(groups).sort((a, b) => b.first - a.first).map(g => {
    const base = GENERIC.test(g.dom) ? g.addr.split("@")[0] : g.dom.split(".").slice(0, -1).pop();
    return { ...g, name: base ? base[0].toUpperCase() + base.slice(1) : g.dom };
  });
}
let newFound = [];
function newHtml(list) {
  newFound = list;
  if (!list.length) return '<p class="note">Aucune entreprise contactée en dehors de ton Sheet.</p>';
  return `<p class="note"><b>${list.length} entreprise(s) contactée(s) par mail mais absente(s) du Sheet.</b> Corrige le nom si besoin, puis ajoute.</p>` + list.map((g, i) =>
    `<div class="prop"><div class="row"><input data-nn="${i}" value="${esc(g.name)}" style="flex:1;min-width:140px"><button class="pri" data-a="addNew" data-i="${i}">Ajouter au Sheet</button></div>
     <div class="note">${esc(g.addr)} — 1er mail le ${toFR(isoOf(g.first))}${g.n > 1 ? ` (${g.n} mails)` : ""} — « ${esc(g.subject)} »</div></div>`).join("");
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
    .map(([l, v]) => `<div class="stat ${{ "Envoyées": "g", "Entretiens / en cours": "g", "À relancer": "w", "Refus": "r" }[l] || ""}"><b>${v}</b><span>${l}</span></div>`).join("");
  renderDash(); renderMain();
}

/* ---------- Vues : liste, tableau, tableau de bord, carte ---------- */
let view = localStorage.getItem("cand_view") || "liste", sortBy = "relance", fVille = "", fType = "", mapOpen = false;
const sorters = {
  relance: (a, b) => { const ra = needsRelance(a), rb = needsRelance(b); if (ra !== rb) return ra ? -1 : 1;
    if (ra) return (a.dateRelance || a.dateEnvoi).localeCompare(b.dateRelance || b.dateEnvoi); return (b.dateEnvoi || "").localeCompare(a.dateEnvoi || ""); },
  recent: (a, b) => (b.dateEnvoi || "").localeCompare(a.dateEnvoi || ""),
  ancien: (a, b) => (a.dateEnvoi || "9").localeCompare(b.dateEnvoi || "9"),
  nom: (a, b) => a.nom.localeCompare(b.nom, "fr")
};
const colOf = it => STATUTS.find(s => norm(s) === norm(it.statut)) || "À envoyer";
const ageOf = it => it.dateEnvoi ? daysSince(it.dateRelance || it.dateEnvoi) : null;
const ageTxt = it => { const d = ageOf(it); return d == null ? "" : d === 0 ? "aujourd'hui" : `il y a ${d} j`; };
function logo(it) {
  const d = demo ? "" : domainOf(it);
  return d ? `<img class="logo" loading="lazy" alt="" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=64" onerror="this.style.visibility='hidden'">` : '<span class="logo"></span>';
}
function moveTo(it, s) {
  const ch = { statut: s };
  if (norm(s) !== "à envoyer" && !it.envoye) { ch.envoye = true; if (!it.dateEnvoi) ch.dateEnvoi = todayISO(); }
  return change(it, ch);
}
function filtered() {
  const q = norm($("#q").value);
  return items.filter(i => (!q || norm(i.nom).includes(q)) && (!fVille || norm(i.lieu) === norm(fVille)) && (!fType || (fType === "mail" ? /mail/i.test(i.type) : /formul/i.test(i.type))));
}
function renderMain() {
  document.querySelectorAll("#viewSeg button").forEach(b => b.classList.toggle("on", b.dataset.v === view));
  const villes = [...new Set(items.map(i => (i.lieu || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
  $("#fVille").innerHTML = '<option value="">Toutes les villes</option>' + villes.map(v => `<option ${norm(v) === norm(fVille) ? "selected" : ""}>${esc(v)}</option>`).join("");
  $("#fSort").value = sortBy; $("#fType").value = fType;
  $("#fSort").style.display = view === "liste" ? "" : "none";
  $("#tabs").style.display = view === "liste" ? "" : "none";
  let list = filtered();
  if (view === "tableau") { $("#list").innerHTML = boardHtml(list.sort(sorters.relance)); return; }
  const tabs = ["Toutes", "À relancer", ...STATUTS];
  $("#tabs").innerHTML = tabs.map(t => `<button data-t="${esc(t)}" class="${t === tab ? "on" : ""}">${label(t)}</button>`).join("");
  if (tab === "À relancer") list = list.filter(needsRelance); else if (tab !== "Toutes") list = list.filter(i => norm(i.statut) === norm(tab));
  list.sort(sorters[sortBy] || sorters.relance);
  $("#list").innerHTML = list.length ? list.map(rowHtml).join("") : '<p class="note">Aucune ligne.</p>';
}
function boardHtml(list) {
  return `<div class="board">${STATUTS.map(s => {
    const col = list.filter(i => colOf(i) === s);
    return `<div class="col ${statusClass(s)}" data-col="${esc(s)}"><div class="colh"><b>${esc(label(s))}</b><span class="pill">${col.length}</span></div><div class="cards">${col.map(it =>
      `<div class="kcard ${statusClass(s)}" draggable="true" data-k="${it.row}"><div class="kt">${logo(it)}<b>${esc(it.nom)}</b></div>
        <div class="note">${esc(it.lieu || "")}${it.lieu && ageTxt(it) ? " · " : ""}${ageTxt(it)}</div>${needsRelance(it) ? '<span class="pill warn">à relancer</span>' : ""}
        <select class="ksel" data-ks="${it.row}">${STATUTS.map(x => `<option value="${esc(x)}" ${x === s ? "selected" : ""}>${esc(label(x))}</option>`).join("")}</select></div>`).join("")}</div></div>`;
  }).join("")}</div>`;
}

const CITIES = [["Paris", 2.35, 48.86], ["Lyon", 4.83, 45.76], ["Marseille", 5.37, 43.3], ["Toulouse", 1.44, 43.6], ["Bordeaux", -0.58, 44.84], ["Nantes", -1.55, 47.22], ["Lille", 3.06, 50.63],
  ["Montpellier", 3.88, 43.61], ["Rennes", -1.68, 48.11], ["Strasbourg", 7.75, 48.58], ["Angoulême", 0.16, 45.65], ["Annecy", 6.13, 45.9], ["Nice", 7.26, 43.7], ["Grenoble", 5.72, 45.19],
  ["Rouen", 1.1, 49.44], ["Reims", 4.03, 49.26], ["Dijon", 5.04, 47.32], ["Angers", -0.56, 47.47], ["Tours", 0.69, 47.39], ["Caen", -0.37, 49.18], ["Brest", -4.49, 48.39], ["Lorient", -3.37, 47.75],
  ["Metz", 6.18, 49.12], ["Nancy", 6.18, 48.69], ["Clermont-Ferrand", 3.08, 45.78], ["Limoges", 1.26, 45.83], ["Poitiers", 0.34, 46.58], ["Orléans", 1.9, 47.9], ["Avignon", 4.81, 43.95],
  ["Aix-en-Provence", 5.45, 43.53], ["Valence", 4.89, 44.93], ["Perpignan", 2.9, 42.7], ["Nîmes", 4.36, 43.84], ["Le Mans", 0.2, 48.0], ["Biarritz", -1.56, 43.48], ["Cannes", 7.02, 43.55],
  ["Toulon", 5.93, 43.12], ["La Rochelle", -1.15, 46.16], ["Saint-Étienne", 4.39, 45.44], ["Amiens", 2.3, 49.89], ["Mulhouse", 7.34, 47.75], ["Besançon", 6.02, 47.24], ["Roubaix", 3.17, 50.69], ["Valenciennes", 3.52, 50.36]];
const PARIS_SUB = /montreuil|saintdenis|boulogne|issy|levallois|vincennes|montrouge|pantin|ivry|clichy|nanterre|courbevoie|puteaux|saintouen|aubervilliers|malakoff|vanves|bagnolet|massy|creteil|versailles|neuilly|ledesmaison/;
function cityOf(it) {
  const n = normK(it.lieu); if (!n) return null;
  if (n.includes("villeurbanne")) return CITIES[1];
  const c = CITIES.find(c => n.includes(normK(c[0])));
  return c || (PARIS_SUB.test(n) || /^(75|92|93|94)/.test(n) ? CITIES[0] : null);
}
const FRANCE = [[2.5, 51.05], [1.85, 50.95], [1.6, 50.7], [1.55, 50.2], [1.1, 49.9], [0.1, 49.5], [-0.4, 49.35], [-1.6, 49.65], [-1.85, 49.0], [-1.5, 48.65], [-2.0, 48.65], [-3.4, 48.8], [-4.8, 48.4], [-4.4, 47.9],
  [-3.4, 47.7], [-3.0, 47.5], [-2.2, 47.25], [-2.2, 46.9], [-1.2, 46.15], [-1.05, 45.6], [-1.2, 44.6], [-1.55, 43.5], [-1.75, 43.35], [-0.7, 42.9], [0.7, 42.8], [1.7, 42.5], [3.1, 42.45], [3.0, 42.7], [3.1, 43.15],
  [3.7, 43.4], [4.5, 43.4], [5.3, 43.3], [5.9, 43.1], [7.0, 43.55], [7.5, 43.78], [7.0, 44.2], [6.7, 44.9], [7.0, 45.9], [6.8, 46.4], [6.1, 46.2], [6.5, 46.6], [7.0, 47.3], [7.55, 47.6], [7.6, 48.1], [8.2, 49.0],
  [6.9, 49.2], [6.1, 49.5], [5.8, 49.5], [4.8, 50.1], [3.6, 50.4], [2.9, 50.7]];
const px = (lon, lat) => [((lon + 5.5) * 27.5).toFixed(1), ((51.3 - lat) * 40).toFixed(1)];
function mapHtml() {
  const counts = new Map(), other = {};
  for (const it of items) {
    const c = cityOf(it);
    if (c) counts.set(c, (counts.get(c) || 0) + 1); else if ((it.lieu || "").trim()) other[it.lieu.trim()] = (other[it.lieu.trim()] || 0) + 1;
  }
  const path = FRANCE.map((p, i) => (i ? "L" : "M") + px(...p).join(",")).join("") + "Z";
  const dots = [...counts].sort((a, b) => b[1] - a[1]).map(([c, n]) => { const [x, y] = px(c[1], c[2]), r = 4 + Math.sqrt(n) * 2.2;
    return `<g><circle cx="${x}" cy="${y}" r="${r.toFixed(1)}" class="dot"><title>${esc(c[0])} : ${n}</title></circle>${n > 1 ? `<text x="${x}" y="${(+y + 3.5).toFixed(1)}" text-anchor="middle" class="dn">${n}</text>` : ""}</g>`; }).join("");
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, n]) => `<div class="mrow"><span>${esc(c[0])}</span><b>${n}</b></div>`).join("");
  const oth = Object.entries(other).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${esc(k)} (${n})`).join(", ");
  return `<div class="mapw"><svg viewBox="-10 -10 400 380" class="fr"><path d="${path}" class="frp"/>${dots}</svg><div class="mapl">${top}${oth ? `<p class="note">Hors carte : ${oth}</p>` : ""}</div></div>`;
}
function renderDash() {
  const todo = items.filter(needsRelance).sort(sorters.relance).slice(0, 5);
  const sent = items.filter(i => i.envoye).length, resp = items.filter(i => ["entretien", "en cours", "accepté", "refusé"].includes(norm(i.statut))).length;
  const now = new Date(), months = [];
  for (let k = 11; k >= 0; k--) { const d = new Date(now.getFullYear(), now.getMonth() - k, 1); months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, lab: d.toLocaleDateString("fr-FR", { month: "short" }).replace(".", ""), n: 0 }); }
  for (const it of items) { const m = months.find(x => it.dateEnvoi && it.dateEnvoi.startsWith(x.key)); if (m) m.n++; }
  const max = Math.max(1, ...months.map(m => m.n));
  const bars = months.map((m, i) => { const h = Math.round(m.n / max * 58), x = i * 25 + 4;
    return `<g><rect x="${x}" y="${80 - h}" width="18" height="${h}" rx="3" class="bar"><title>${m.lab} : ${m.n}</title></rect>${m.n ? `<text x="${x + 9}" y="${76 - h}" text-anchor="middle" class="bn">${m.n}</text>` : ""}<text x="${x + 9}" y="94" text-anchor="middle" class="bl">${esc(m.lab)}</text></g>`; }).join("");
  $("#dash").innerHTML = `<div class="dash">
    <div class="dblock"><h3>À faire aujourd'hui</h3>${todo.length ? todo.map(it => `<div class="trow"><span class="n">${logo(it)}${esc(it.nom)}</span><span class="note">${ageTxt(it)}</span><button data-a="todo" data-r="${it.row}">Préparer la relance</button></div>`).join("") : '<p class="note">Aucune relance en retard.</p>'}</div>
    <div class="dblock"><h3>Envois par mois</h3><svg viewBox="0 0 304 100" class="chart">${bars}</svg></div>
    <div class="dblock"><h3>Réponses</h3><div class="big">${sent ? Math.round(resp / sent * 100) : 0}<small>%</small></div><p class="note">${resp} réponse(s) pour ${sent} envoi(s) (entretien, en cours, accepté ou refus)</p></div>
  </div><details id="mapDet" ${mapOpen ? "open" : ""}><summary>Carte de France</summary>${mapHtml()}</details>`;
  $("#mapDet").addEventListener("toggle", e => mapOpen = e.target.open);
}
function statusClass(s) { s = norm(s); return s === "refusé" ? "bad" : ["entretien", "accepté"].includes(s) ? "good" : ["en attente", "en cours"].includes(s) ? "blue" : ""; }
function rowHtml(it) {
  let h = `<div class="item ${statusClass(it.statut)}"><div class="head" data-o="${it.row}"><span class="n">${logo(it)}${esc(it.nom)}</span>
    ${needsRelance(it) ? `<span class="pill warn">à relancer · ${ageTxt(it)}</span>` : ""}${it.lieu ? `<span class="pill">${esc(it.lieu)}</span>` : ""}<span class="pill">${esc(it.offre || "—")}</span>
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
$("#viewSeg").addEventListener("click", e => { const v = e.target.dataset.v; if (!v) return; view = v; localStorage.setItem("cand_view", v); render(); });
$("#fSort").onchange = e => { sortBy = e.target.value; render(); };
$("#fVille").onchange = e => { fVille = e.target.value; render(); };
$("#fType").onchange = e => { fType = e.target.value; render(); };
$("#list").addEventListener("change", e => { const r = e.target.dataset.ks; if (!r) return; moveTo(items.find(x => x.row == r), e.target.value); });
$("#list").addEventListener("dragstart", e => { const k = e.target.closest?.(".kcard"); if (!k) return; e.dataTransfer.setData("text/plain", k.dataset.k); e.dataTransfer.effectAllowed = "move"; k.classList.add("drag"); });
$("#list").addEventListener("dragend", e => { e.target.classList?.remove("drag"); document.querySelectorAll(".col.over").forEach(c => c.classList.remove("over")); });
$("#list").addEventListener("dragover", e => { const c = e.target.closest?.(".col"); if (!c) return; e.preventDefault(); document.querySelectorAll(".col.over").forEach(x => x !== c && x.classList.remove("over")); c.classList.add("over"); });
$("#list").addEventListener("drop", e => {
  const c = e.target.closest?.(".col"); if (!c) return; e.preventDefault();
  const it = items.find(x => x.row == e.dataTransfer.getData("text/plain")); if (it && colOf(it) !== c.dataset.col) moveTo(it, c.dataset.col); else render();
});
const fsBtn = $("#btnFs"), FS_IN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>', FS_OUT = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/></svg>';
fsBtn.innerHTML = FS_IN;
if (!document.documentElement.requestFullscreen) fsBtn.style.display = "none";
fsBtn.onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {});
document.addEventListener("fullscreenchange", () => { const f = !!document.fullscreenElement; fsBtn.innerHTML = f ? FS_OUT : FS_IN; fsBtn.title = f ? "Quitter le plein écran" : "Plein écran"; });
$("#list").addEventListener("change", e => {
  const f = e.target.dataset.f; if (!f) return;
  const it = items.find(x => x.row == e.target.closest(".det").dataset.r);
  const ch = { [f]: e.target.value };
  if (f === "statut" && norm(e.target.value) !== "à envoyer" && !it.envoye) { ch.envoye = true; if (!it.dateEnvoi) ch.dateEnvoi = todayISO(); }
  change(it, ch);
});
document.addEventListener("click", async e => {
  const t = e.target; if (!(t instanceof HTMLElement)) return;
  const kc = t.closest(".kcard"); if (kc && !t.closest("select")) { view = "liste"; tab = "Toutes"; open = +kc.dataset.k; render(); document.getElementById("box-" + open)?.scrollIntoView({ block: "center" }); return; }
  const head = t.closest(".head"); if (head) { open = open === +head.dataset.o ? null : +head.dataset.o; render(); return; }
  const a = t.dataset.a; if (!a) return;
  try {
    if (a === "addNew") {
      const g = newFound[+t.dataset.i], nm = document.querySelector(`[data-nn="${t.dataset.i}"]`).value.trim() || g.name;
      if (items.some(x => norm(x.nom) === norm(nm))) { t.textContent = "Déjà dans la liste"; t.disabled = true; return; }
      const it = { statut: "en attente", nom: nm, offre: "Généraliste 3D", envoye: true, dateEnvoi: isoOf(g.first), type: "Mail (spontanée)", contact: g.addr, site: GENERIC.test(g.dom) ? "" : "https://" + g.dom, lieu: "", relance: false, dateRelance: "", contactNom: "", notes: "", echange: `Mail du ${toFR(isoOf(g.first))}` };
      t.disabled = true; t.textContent = "Ajout…";
      await backend().add(it); items.push(it); render(); t.textContent = "Ajouté"; return;
    }
    if (a === "applySent") { const r = lastResults[t.dataset.r]; await change(r.it, { envoye: true, dateEnvoi: isoOf(r.sent.ts), statut: norm(r.it.statut) === "à envoyer" || !r.it.statut ? "en attente" : r.it.statut, echange: `Mail du ${toFR(isoOf(r.sent.ts))}` }); t.disabled = true; t.textContent = "Appliqué"; return; }
    if (a === "applyStatus") { const r = lastResults[t.dataset.r]; await change(r.it, { statut: t.dataset.s, echange: `Réponse du ${toFR(isoOf(r.reply.ts))}` }); t.disabled = true; t.textContent = "Appliqué"; return; }
    if (a === "todo") {
      const it = items.find(x => x.row == t.dataset.r); if (!it) return;
      view = "liste"; tab = "Toutes"; fVille = ""; fType = ""; $("#q").value = ""; open = it.row; render();
      const box = $("#box-" + it.row); box?.scrollIntoView({ block: "center" }); await mailBox(it, box, true); return;
    }
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
  $("#btnSync").disabled = true; const res = []; onWait = n => { out.insertAdjacentHTML("afterbegin", `<p class="note">Gmail demande de ralentir : pause de 20 s (essai ${n}/5)…</p>`); };
  try {
    for (let k = 0; k < todo.length; k++) {
      out.innerHTML = `<p class="note">Gmail : ${k + 1}/${todo.length} — ${esc(todo[k].nom)}…</p>`;
      const r = await checkOne(todo[k]); await sleep(900);
      if ((r.sent && (!r.it.envoye || !r.it.dateEnvoi)) || r.reply) res.push(r);
    }
    showProposals(out, res);
    out.insertAdjacentHTML("beforeend", '<p class="note">Recherche des entreprises contactées hors Sheet…</p>');
    const fresh = await findNew();
    out.lastElementChild.remove();
    out.insertAdjacentHTML("beforeend", newHtml(fresh));
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
