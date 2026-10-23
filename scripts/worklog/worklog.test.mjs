// npm test : lecture des deux sources, fusion, écriture d'une session, cohérence,
// enregistrement du tableau (patch.mjs et serveur), relevé de code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applySession, incoherences, lotIds, marqueRe, merge, parseBacklog, parseChantiers, parseLots, rattachementsParDefaut, specRe } from "./chantiers-tracker.mjs";
import { applyPatch } from "./patch.mjs";
import { countCases, isTest } from "./code-stats.mjs";
import { createTracker } from "./serve.mjs";
import { loadConfig } from "./config.mjs";
import { AGENTS, SKILL, agentsFromSkill } from "./sync-agents.mjs";
import { summarize } from "./resume.mjs";
import { createAccueil } from "./accueil.mjs";
import { addProject, loadRegistry, registryFile, removeProject, saveRegistry, slugId } from "./registre.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CHANTIERS = `## Chantiers ouverts
| id | chantier | état | prochaine action | décisions en attente | doc de reprise | MAJ |
|---|---|---|---|---|---|---|
| CH-01 | API publique | en cours | routes | — | \`docs/chantiers/CH-01_api.md\` | 2026-01-02 |
| CH-02 | Écrans | pas commencé | maquettes | — | — | 2026-01-02 |
## Chantiers clos
| id | chantier | clos le | preuve | ce qui en reste |
|---|---|---|---|---|
| CH-00 | Socle | 2026-01-01 | commit abc | rien |
## Journal
| CH-99 | ne doit pas être lu |`;

const BACKLOG = `## CH-01 · API publique
| id | P | tâche | attendu |
|---|---|---|---|
| API-01 | P1 | **Route de lecture.** GET /items | test vert |
| API-02 | P0 | **Pagination.** decision attendue sur la taille | test vert |
| API-03 | P2 | Limite de débit | 429 au-delà |
## CH-02 · Écrans
| UI-01 | P1 | **Liste.** | écran |`;

const SPEC = `# CH-01\n## Découpage\n1. **Lecture** (API-01, 02)\n2. Limites : API-03\n## Reprise\n3. pas un lot`;

const build = (old = {}) => merge(old, parseChantiers(CHANTIERS), parseBacklog(BACKLOG), (n) => (n === "CH-01_api.md" ? SPEC : null), { specs: "docs/chantiers", projet: "Démo", ui: { marque: "DÉCISION" } });

test("CHANTIERS.md : ouverts, clos, journal ignoré", () => {
  const cs = parseChantiers(CHANTIERS);
  assert.deepEqual(cs.map((c) => [c.id, c.colonne]), [["CH-01", "en_cours"], ["CH-02", "pas_commence"], ["CH-00", "clos"]]);
});

test("backlog : titre, chantier de la section, marque de décision sans accent", () => {
  const its = parseBacklog(BACKLOG);
  assert.equal(its.length, 4);
  assert.equal(its[0].titre, "Route de lecture");
  assert.equal(its[0].chantier_backlog, "CH-01");
  assert.equal(its[1].decision, true);
  assert.equal(its[3].chantier_backlog, "CH-02");
  assert.ok(marqueRe("DÉCISION").test("Decision"));
  assert.ok(marqueRe("ARBITRAGE").test("[arbitrage]"));
  // ui.marqueCasse : la casse compte, les accents non
  assert.ok(marqueRe("DÉCISION", true).test("DECISION : taille de page"));
  assert.ok(marqueRe("DÉCISION", true).test("DÉCISION"));
  assert.ok(!marqueRe("DÉCISION", true).test("la décision du 4 octobre"));
});

test("backlog : tâche en titre ou en paragraphe, id à chiffres, annexe ignorée, rattachement du réglage", () => {
  const its = parseBacklog(`## 4. Chantiers par domaine
### 4.2 Recherche \`RCH\`
#### RCH-01 : indexer les pages \`P1\` [ARBITRAGE]
**I18N-04** \`P2\` : traduire les pages, ${"long ".repeat(40)}fin
| RCH-02 | P0 | ${"x".repeat(200)} | attendu |
## Annexe A : revue
| RCH-09 | P1 | citée seulement | — |`, marqueRe("[ARBITRAGE]"));
  assert.deepEqual(its.map((i) => i.id), ["RCH-01", "I18N-04", "RCH-02"]);
  assert.equal(its[0].titre, "indexer les pages");
  assert.equal(its[0].decision, true);
  assert.equal(its[1].decision, false);
  assert.equal(its[0].section, "Recherche");
  assert.equal(its[1].domaine, "I18N");
  assert.equal(its[2].titre.length, 160);
  assert.equal(its[2].constat.length, 200);  // le texte entier n'est pas perdu
  const d = rattachementsParDefaut({ "CH-07": "RCH-01 RCH-02", "CH-08": ["I18N-04"] });
  assert.equal(d.get("RCH-02"), "CH-07");
  assert.equal(d.get("I18N-04"), "CH-08");
});

test("lots lus dans la spec et rattachés", () => {
  assert.deepEqual(parseLots(SPEC).map((l) => l.id), ["1", "2"]);
  assert.deepEqual(lotIds("API-01 à 03", "API"), ["API-01", "API-02", "API-03"]);
  assert.ok(specRe("docs/specs").test("`docs/specs/CH-12_x.md`"));
  const d = build();
  assert.equal(d.items.find((i) => i.id === "API-02").lot_spec, "1");
  assert.equal(d.items.find((i) => i.id === "API-03").lot_spec, "2");
  assert.equal(d.meta.projet, "Démo");
});

test("fusion : ce que pilote le tableau survit au passage suivant", () => {
  const d1 = build();
  d1.items[0].statut = "fait"; d1.items[0].note = "vu"; d1.chantiers[0].priorite = "P0";
  const d2 = build(d1);
  assert.equal(d2.items[0].statut, "fait");
  assert.equal(d2.items[0].note, "vu");
  assert.equal(d2.chantiers[0].priorite, "P0");
  assert.equal(d2.meta.version, d1.meta.version + 1);
});

test("session : tout ou rien, suivi daté", () => {
  const d = build();
  assert.throws(() => applySession(d, { statuts: [["API-01", "en_cours"], ["XXX-01", "fait"]] }, "s", "2026-01-03"));
  assert.equal(d.items[0].statut, "a_faire");
  applySession(d, { statuts: [["API-01", "en_cours"]], suivis: [["API-01", "route écrite"]] }, "lot-1", "2026-01-03");
  assert.equal(d.items[0].suivi, "2026-01-03 · lot-1 · en_cours : route écrite");
  assert.throws(() => applySession(d, { statuts: [["API-01", "termine"]] }, "s", "j"), /hors vocabulaire/);
});

test("incohérences : chantier en cours sans tâche qui bouge, pas commencé qui avance", () => {
  const d = build();
  assert.ok(incoherences(d).some((t) => t.startsWith("CH-01")));
  // controle.enCoursSpecSeulement : un chantier sans spec (antérieur au suivi) n'est pas tenu par ses tâches
  const opts = { specs: "docs/chantiers", enCoursSpecSeulement: true };
  assert.ok(incoherences(d, opts).some((t) => t.startsWith("CH-01")));
  d.chantiers.find((c) => c.id === "CH-01").doc = "`docs/plans/ancien.md`";
  assert.ok(!incoherences(d, opts).some((t) => t.startsWith("CH-01")));
  assert.ok(incoherences(d).some((t) => t.startsWith("CH-01")));
  d.items.find((i) => i.id === "UI-01").statut = "en_cours";
  assert.ok(incoherences(d).some((t) => t.startsWith("CH-02")));
});

test("patch : verrou par champ, validation, détachement voulu", () => {
  const d = build();
  const r = applyPatch(d, { items: [
    { id: "API-01", set: { statut: "fait" }, base: { statut: "a_faire" } },
    { id: "API-02", set: { statut: "fait" }, base: { statut: "en_cours" } },   // le fichier a changé : conflit
    { id: "API-03", set: { statut: "n_importe" }, base: {} },                   // refusé
    { id: "UI-01", set: { chantier: null }, base: { chantier: "CH-02" } },
  ] });
  assert.equal(r.written, 2);
  assert.deepEqual(r.conflicts.map((c) => c.id), ["API-02"]);
  assert.equal(d.items.find((i) => i.id === "API-03").statut, "a_faire");
  assert.equal(d.items.find((i) => i.id === "UI-01").detache, true);
  assert.equal(build(d).items.find((i) => i.id === "UI-01").chantier, null); // pas rattaché de nouveau
});

test("relevé de code : fichiers de test et cas comptés", () => {
  assert.ok(isTest("src/a.test.ts") && isTest("tests/helpers.py") && isTest("pkg/x_test.go") && isTest("test_api.py"));
  assert.ok(!isTest("src/latest.ts"));
  assert.equal(countCases("a.test.js", "it('a', () => {}); test.each([])('b', () => {})"), 2);
  assert.equal(countCases("test_x.py", "def test_a():\n    pass\nasync def test_b():\n"), 2);
});

test("serveur : sert le tableau, écrit un patch, refuse le reste", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "worklog-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(ROOT, "docs", "tracker"), join(dir, "docs", "tracker"), { recursive: true });
  writeFileSync(join(dir, ".env"), "SECRET=1");
  const data = build();
  writeFileSync(join(dir, "docs", "tracker", "chantiers.json"), JSON.stringify(data));
  const srv = createTracker(dir, loadConfig(dir)).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  t.after(() => srv.close());
  const base = `http://localhost:${srv.address().port}`;

  assert.equal((await fetch(`${base}/docs/tracker/`)).status, 200);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/docs/../.env`)).status, 404);

  const post = (body, headers = {}) => fetch(`${base}/docs/tracker/save.php`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
  const patch = JSON.stringify({ patch: { items: [{ id: "API-01", set: { statut: "fait" }, base: { statut: "a_faire" } }] } });
  assert.equal((await post(patch, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post(patch, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  const ok = await post(patch);
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.equal(j.version, data.meta.version + 1);
  const saved = JSON.parse(readFileSync(join(dir, "docs", "tracker", "chantiers.json"), "utf8"));
  assert.equal(saved.items.find((i) => i.id === "API-01").statut, "fait");
});

test("AGENTS.md (Codex) est à jour avec le skill Claude Code", () => {
  assert.equal(readFileSync(AGENTS, "utf8"), agentsFromSkill(readFileSync(SKILL, "utf8")), "lancer npm run agents:sync");
});

test("export Excel : archive zip lisible, CRC justes, texte échappé, en-tête figé et filtré", () => {
  const { workbook, crc32 } = createRequire(import.meta.url)("../../docs/tracker/xlsx.js");
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  const bytes = workbook([{ nom: "Tâches", colonnes: [{ titre: "ID" }, { titre: "Rang" }], lignes: [["A<&>\u0001B", 3], ["", null]] }]);
  const v = new DataView(bytes.buffer), dec = new TextDecoder();
  const files = {};
  for (let at = 0; v.getUint32(at, true) === 0x04034b50;) {
    const size = v.getUint32(at + 18, true), n = v.getUint16(at + 26, true);
    const name = dec.decode(bytes.subarray(at + 30, at + 30 + n)), data = bytes.subarray(at + 30 + n, at + 30 + n + size);
    assert.equal(crc32(data), v.getUint32(at + 14, true), name);
    files[name] = dec.decode(data);
    at += 30 + n + size;
  }
  assert.deepEqual(Object.keys(files).sort(), ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
  const s = files["xl/worksheets/sheet1.xml"];
  assert.match(s, /<t xml:space="preserve">A&lt;&amp;&gt;B<\/t>/);
  assert.match(s, /<c r="B2" s="2"><v>3<\/v><\/c>/);
  assert.match(s, /<row r="3"><\/row>/);
  assert.match(s, /state="frozen"/);
  assert.match(s, /<autoFilter ref="A1:B3"\/>/);
  assert.match(files["xl/workbook.xml"], /<sheet name="Tâches"/);
});

test("registre : id, ajout, doublon, retrait, fichier cassé", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wl-home-"));
  const p1 = mkdtempSync(join(tmpdir(), "wl-p1-"));
  const p2 = mkdtempSync(join(tmpdir(), "wl-p2-"));
  t.after(() => [home, p1, p2].forEach((d) => rmSync(d, { recursive: true, force: true })));
  writeFileSync(join(p1, "tracker.config.json"), JSON.stringify({ projet: "Réplycite Pro" }));
  const file = registryFile({ AGENT_WORKLOG_HOME: home });
  assert.deepEqual(loadRegistry(file), { projets: [] });
  assert.equal(slugId("Réplycite  Pro!"), "replycite-pro");
  const reg = loadRegistry(file);
  const e = addProject(reg, p1);
  assert.equal(e.id, "replycite-pro");
  assert.equal(e.type, "fichiers");
  assert.equal(addProject(reg, p1.replaceAll("/", "\\") + "\\").id, "replycite-pro");
  assert.equal(reg.projets.length, 1);
  writeFileSync(join(p2, "tracker.config.json"), JSON.stringify({ projet: "Replycite pro" }));
  assert.throws(() => addProject(reg, p2), /id déjà pris/);
  assert.equal(addProject(reg, p2, { id: "autre" }).id, "autre");
  assert.throws(() => addProject(reg, home), /pas de tracker.config.json/);
  saveRegistry(file, reg);
  assert.equal(loadRegistry(file).projets.length, 2);
  assert.equal(removeProject(reg, "autre"), true);
  assert.equal(removeProject(reg, "autre"), false);
  writeFileSync(file, "{cassé");
  assert.throws(() => loadRegistry(file), /illisible/);
});

test("résumé d'un projet : avancement, décisions, activité des 7 derniers jours, version", () => {
  const d = build();
  const it = (id) => d.items.find((i) => i.id === id);
  Object.assign(it("API-01"), { statut: "fait", suivi: "2026-10-20 · s1 · fait" });
  Object.assign(it("API-03"), { statut: "abandonne", suivi: "2026-10-01 · s0 · abandonne" });
  delete it("UI-01").decision;
  const r = summarize(d, { today: "2026-10-23", version: "1.3.0", outil: "1.4.0" });
  assert.equal(r.nom, "Démo");
  assert.equal(r.taches.base, 3);
  assert.equal(r.taches.fait, 1);
  assert.equal(r.taches.pct, 33);
  assert.equal(r.decisions, 1);
  assert.equal(r.chantiers.ouverts, 2);
  assert.equal(r.chantiers.en_cours, 1);
  assert.equal(r.bouges7j, 1);
  assert.equal(r.derniere, "2026-10-20");
  assert.equal(r.aJour, false);
  assert.equal(summarize(d, { today: "2026-10-27", version: "1.4.0", outil: "1.4.0" }).bouges7j, 0);
  const vide = summarize({ meta: {}, chantiers: [], items: [] }, { today: "2026-10-23", version: null, outil: "1.4.0" });
  assert.equal(vide.taches.pct, 0);
  assert.equal(vide.derniere, null);
});

test("accueil : liste, sert un projet, écrit dans le bon, refuse le reste", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "wl-acc-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const projet = (nom, version) => {
    const dir = join(tmp, nom);
    mkdirSync(join(dir, "docs", "tracker"), { recursive: true });
    writeFileSync(join(dir, "tracker.config.json"), JSON.stringify({ projet: nom }));
    writeFileSync(join(dir, "docs", "tracker", "chantiers.json"), JSON.stringify(build()));
    writeFileSync(join(dir, ".env"), "SECRET=1");
    if (version) { mkdirSync(join(dir, "scripts", "worklog"), { recursive: true }); writeFileSync(join(dir, "scripts", "worklog", "VERSION"), version + "\n"); }
    return dir;
  };
  const a = projet("Alpha", "1.3.0");
  const b = projet("Beta", null);
  const g = projet("Gamma", null);
  const registry = join(tmp, "home", "projets.json");
  const reg = { projets: [] };
  [a, b, g].forEach((d) => addProject(reg, d));
  saveRegistry(registry, reg);
  rmSync(g, { recursive: true, force: true });

  const srv = createAccueil({ registry, uiDir: join(ROOT, "docs", "tracker"), outil: "1.4.0", today: () => "2026-10-23" }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  t.after(() => srv.close());
  const base = `http://localhost:${srv.address().port}`;
  const json = (u) => fetch(base + u).then((r) => r.json());

  const liste = await json("/api/projets");
  assert.equal(liste.outil, "1.4.0");
  assert.deepEqual(liste.projets.map((p) => p.id), ["alpha", "beta", "gamma"]);
  assert.equal(liste.projets[2].erreur, "dossier introuvable");
  assert.equal(liste.projets[0].resume.nom, "Alpha");
  assert.equal(liste.projets[0].resume.version, "1.3.0");
  assert.equal(liste.projets[0].resume.aJour, false);

  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/p/alpha/`)).status, 200);
  assert.equal((await fetch(`${base}/p/alpha`, { redirect: "manual" })).status, 301);
  const data = await json("/p/alpha/chantiers.json");
  assert.equal(data.meta.accueil.url, "/");
  assert.deepEqual(data.meta.accueil.projets.map((p) => p.id), ["alpha", "beta", "gamma"]);
  assert.equal(data.meta.ui.racine, "fichiers/");
  assert.equal((await fetch(`${base}/p/alpha/fichiers/tracker.config.json`)).status, 200);
  assert.equal((await fetch(`${base}/p/alpha/fichiers/.env`)).status, 404);
  assert.equal((await fetch(`${base}/p/alpha/fichiers/%2e%2e/Beta/tracker.config.json`)).status, 404);
  assert.equal((await fetch(`${base}/p/zzz/`)).status, 404);

  const post = (u, body, headers = {}) => fetch(base + u, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const patch = (id, statut) => ({ patch: { items: [{ id, set: { statut }, base: { statut: "a_faire" } }] } });
  const [ra, rb] = await Promise.all([post("/p/alpha/save.php", patch("API-01", "fait")), post("/p/beta/save.php", patch("API-02", "en_cours"))]);
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 200);
  const lire = (d) => JSON.parse(readFileSync(join(d, "docs", "tracker", "chantiers.json"), "utf8")).items;
  assert.equal(lire(a).find((i) => i.id === "API-01").statut, "fait");
  assert.equal(lire(a).find((i) => i.id === "API-02").statut, "a_faire");
  assert.equal(lire(b).find((i) => i.id === "API-02").statut, "en_cours");
  assert.equal(lire(b).find((i) => i.id === "API-01").statut, "a_faire");
  assert.equal((await post("/p/alpha/save.php", patch("API-03", "fait"), { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await post("/p/alpha/save.php", patch("API-03", "fait"), { "Content-Type": "text/plain" })).status, 415);

  assert.equal((await post("/api/projets", { dossier: tmp })).status, 400);
  const d = projet("Delta", null);
  const ajout = await post("/api/projets", { dossier: d });
  assert.equal(ajout.status, 200);
  assert.equal((await ajout.json()).projet.id, "delta");
  assert.equal((await post("/api/projets/retirer", { id: "delta" })).status, 200);
  assert.equal((await post("/api/projets/retirer", { id: "delta" })).status, 404);
  assert.equal(loadRegistry(registry).projets.length, 3);

  writeFileSync(registry, "{x");
  const casse = await fetch(`${base}/api/projets`);
  assert.equal(casse.status, 500);
  assert.equal((await casse.json()).ok, false);
  assert.equal(readFileSync(registry, "utf8"), "{x");
});
