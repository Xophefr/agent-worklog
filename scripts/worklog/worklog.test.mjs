// npm test : lecture des deux sources, fusion, écriture d'une session, cohérence,
// enregistrement du tableau (patch.mjs et serveur), relevé de code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applySession, incoherences, lotIds, marqueRe, merge, parseBacklog, parseChantiers, parseJournal, parseLots, rattachementsParDefaut, specRe } from "./chantiers-tracker.mjs";
import { exportMd } from "./export-md.mjs";
import { ouvrirBase } from "./base/connexion.mjs";
import { migrer, TABLES } from "./base/schema.mjs";
import { creerDepot, importer } from "./base/depot.mjs";
import { createBff } from "./bff.mjs";
import { homedir } from "node:os";
import { ajouterJournal, cloreChantier, creerChantier, creerTache, modifierChantier, modifierTache, poserLots } from "./operations.mjs";
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

  assert.equal((await post("/api/projets", { dossier: "relatif" })).status, 400);
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

test("install.mjs inscrit le projet à l'accueil, une seule fois", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "wl-inst-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dir = join(tmp, "Mon Projet");
  mkdirSync(dir);
  const home = join(tmp, "home");
  const run = () => spawnSync(process.execPath, [join(ROOT, "scripts", "worklog", "install.mjs"), dir], { env: { ...process.env, AGENT_WORKLOG_HOME: home }, encoding: "utf8" });
  const r1 = run();
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, /inscrit\s+accueil : mon-projet/);
  const r2 = run();
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /gardé\s+accueil : mon-projet/);
  const reg = loadRegistry(registryFile({ AGENT_WORKLOG_HOME: home }));
  assert.deepEqual(reg.projets.map((p) => p.id), ["mon-projet"]);
  // Le BFF et ce qui ne sert qu'à lui restent dans agent-worklog : aucun projet n'a de dépendance.
  for (const f of ["bff.mjs", "operations.mjs", "export-md.mjs", "accueil.mjs"]) assert.equal(existsSync(join(dir, "scripts", "worklog", f)), false, f);
  assert.equal(existsSync(join(dir, "scripts", "worklog", "base")), false);
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies, undefined);
});

test("revue 1.4.0 : registre vide, fichiers en bac à sable, hôte local, chemin relatif refusé", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "wl-rev-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const registry = join(tmp, "home", "projets.json");
  mkdirSync(join(tmp, "home"));
  writeFileSync(registry, "  \n");
  assert.deepEqual(loadRegistry(registry), { projets: [] });

  const dir = join(tmp, "Un");
  mkdirSync(join(dir, "docs", "tracker"), { recursive: true });
  writeFileSync(join(dir, "tracker.config.json"), JSON.stringify({ projet: "Un" }));
  writeFileSync(join(dir, "docs", "tracker", "chantiers.json"), JSON.stringify(build()));
  writeFileSync(join(dir, "docs", "evil.html"), "<script>1</script>");
  const reg = { projets: [] };
  addProject(reg, dir);
  saveRegistry(registry, reg);
  assert.throws(() => addProject(reg, "   "), /chemin absolu attendu/);
  assert.throws(() => addProject(reg, "relatif/projet"), /chemin absolu attendu/);

  const srv = createAccueil({ registry, uiDir: join(ROOT, "docs", "tracker"), outil: "1.4.0" }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  t.after(() => srv.close());
  const port = srv.address().port;
  const evil = await fetch(`http://localhost:${port}/p/un/fichiers/docs/evil.html`);
  assert.equal(evil.status, 200);
  assert.match(evil.headers.get("content-security-policy") || "", /sandbox/);
  assert.equal((await fetch(`http://localhost:${port}/p/un/`)).headers.get("content-security-policy"), null);
  const { request } = await import("node:http");
  const status = await new Promise((ok) => request({ host: "127.0.0.1", port, path: "/p/un/fichiers/tracker.config.json", headers: { Host: "evil.example" } }, (r) => { r.resume(); ok(r.statusCode); }).end());
  assert.equal(status, 403);
});

test("accueil : nouveau projet (dossier créé, modèles, données) ou projet existant (inscrit, ou suivi installé sans rien écraser)", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "wl-modes-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const registry = join(tmp, "home", "projets.json");
  const srv = createAccueil({ registry, uiDir: join(ROOT, "docs", "tracker"), outil: "1.5.0" }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  t.after(() => srv.close());
  const base = `http://localhost:${srv.address().port}`;
  const post = (body) => fetch(`${base}/api/projets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const neuf = join(tmp, "neuf", "sous-dossier");
  const r1 = await post({ mode: "nouveau", dossier: neuf, nom: "Mon Neuf" });
  assert.equal(r1.status, 200, await r1.clone().text());
  assert.equal((await r1.json()).projet.id, "mon-neuf");
  assert.equal(JSON.parse(readFileSync(join(neuf, "tracker.config.json"), "utf8")).projet, "Mon Neuf");
  readFileSync(join(neuf, "docs", "CHANTIERS.md"), "utf8");
  readFileSync(join(neuf, "docs", "tracker", "chantiers.json"), "utf8");
  const liste = await (await fetch(`${base}/api/projets`)).json();
  assert.equal(liste.projets[0].erreur, undefined);
  assert.equal(liste.projets[0].resume.nom, "Mon Neuf");
  const r2 = await post({ mode: "nouveau", dossier: neuf, nom: "Encore" });
  assert.equal(r2.status, 400);
  assert.match((await r2.json()).error, /déjà suivi/);

  const code = join(tmp, "code");
  mkdirSync(code);
  writeFileSync(join(code, "README.md"), "mon code");
  const r3 = await post({ mode: "existant", dossier: code });
  assert.equal(r3.status, 200, await r3.clone().text());
  assert.equal(readFileSync(join(code, "README.md"), "utf8"), "mon code");
  readFileSync(join(code, "tracker.config.json"), "utf8");

  const suivi = join(tmp, "suivi");
  mkdirSync(suivi);
  writeFileSync(join(suivi, "tracker.config.json"), JSON.stringify({ projet: "Déjà Suivi" }));
  const r4 = await post({ mode: "existant", dossier: suivi });
  assert.equal(r4.status, 200);
  assert.equal((await r4.json()).projet.id, "deja-suivi");
  assert.throws(() => readFileSync(join(suivi, "scripts", "worklog", "VERSION")), /ENOENT/);

  const r5 = await post({ mode: "existant", dossier: join(tmp, "absent") });
  assert.equal(r5.status, 400);
  assert.match((await r5.json()).error, /n'existe pas/);
  assert.equal(loadRegistry(registry).projets.length, 3);
});

test("journal : consigne, entrées du tableau, ligne libre gardée", () => {
  const md = `## Chantiers ouverts\n| CH-01 | x | en cours | a | — | — | 2026-01-01 |\n## Journal\n\nAjout seul, une ligne par session.\n\n| date | session | chantier | ce qui a bougé | commits | docs touchés |\n|---|---|---|---|---|---|\n| 2026-10-20 | s1 | CH-01 | OUVERT. Début | \`abc\` | — |\n| 2026-10-21 | s2 | tous | FERMÉ. Fin \\| suite | — | spec |\nune note libre\n`;
  const j = parseJournal(md);
  assert.equal(j.consigne, "Ajout seul, une ligne par session.");
  assert.equal(j.entrees.length, 3);
  assert.deepEqual(j.entrees[0], { date: "2026-10-20", session: "s1", chantiers: "CH-01", texte: "OUVERT. Début", commits: "`abc`", docs: "—" });
  assert.equal(j.entrees[1].texte, "FERMÉ. Fin | suite");
  assert.deepEqual(j.entrees[2], { brut: "une note libre" });
  assert.deepEqual(parseJournal("## Chantiers ouverts\n"), { consigne: "", entrees: [] });
});

test("opérations : créer, modifier, clore, journal, lots", () => {
  const d = build();
  assert.equal(creerChantier(d, { titre: "Cache" }), "CH-03");
  assert.equal(d.chantiers.find((c) => c.id === "CH-03").colonne, "pas_commence");
  assert.throws(() => creerChantier(d, { id: "CH-01", titre: "x" }), /déjà pris/);
  assert.throws(() => creerChantier(d, {}), /titre/);
  modifierChantier(d, "CH-02", { etat: "en cours", note: "go" });
  assert.equal(d.chantiers.find((c) => c.id === "CH-02").colonne, "en_cours");
  assert.throws(() => modifierChantier(d, "CH-02", { colonne: "x" }), /non modifiable/);
  assert.throws(() => modifierChantier(d, "CH-99", { note: "x" }), /inconnu/);
  cloreChantier(d, "CH-02", { preuve: "commit abc", reste: "rien", le: "2026-10-23" });
  const c2 = d.chantiers.find((c) => c.id === "CH-02");
  assert.deepEqual([c2.colonne, c2.clos_le, c2.preuve], ["clos", "2026-10-23", "commit abc"]);
  cloreChantier(d, "CH-03", { preuve: "—", reste: "—", le: "2026-10-23", abandon: true });
  assert.equal(d.chantiers.find((c) => c.id === "CH-03").colonne, "abandonne");

  assert.equal(creerTache(d, { chantier: "CH-01", titre: "Cache des listes" }), "API-04");
  assert.equal(creerTache(d, { chantier: "CH-01", titre: "Écran", domaine: "UI" }), "UI-02");
  const t = d.items.find((i) => i.id === "API-04");
  assert.deepEqual([t.statut, t.priorite, t.chantier, t.decision], ["a_faire", "P2", "CH-01", false]);
  assert.throws(() => creerTache(d, { chantier: "CH-77", titre: "x" }), /chantier inconnu/);
  modifierTache(d, "API-01", { statut: "fait", attendu: "200" });
  assert.equal(d.items.find((i) => i.id === "API-01").statut, "fait");
  assert.throws(() => modifierTache(d, "API-01", { statut: "fini" }), /statut/);
  assert.throws(() => modifierTache(d, "API-01", { suivi: "x" }), /non modifiable/);

  ajouterJournal(d, { date: "2026-10-23", session: "s1", chantiers: "CH-01", texte: "OUVERT." });
  assert.equal(d.journal.entrees.length, 1);

  d.chantiers.find((c) => c.id === "CH-01").lots = [];
  d.items.forEach((i) => { i.lot_spec = null; });
  poserLots(d, [{ chemin: "docs/chantiers/CH-01_api.md", texte: SPEC }]);
  assert.equal(d.chantiers.find((c) => c.id === "CH-01").lots.length, 2);
  assert.equal(d.items.find((i) => i.id === "API-01").lot_spec, "1");
  assert.equal(d.items.find((i) => i.id === "API-03").lot_spec, "2");
});

test("export Markdown : relu par le mode fichiers sans perte", () => {
  const d = build();
  cloreChantier(d, "CH-02", { preuve: "—", reste: "—", le: "2026-10-23", abandon: true });
  creerTache(d, { chantier: "CH-01", titre: "Barre | dans le titre", constat: "ligne 1\nligne 2", attendu: "a | b", decision: true });
  creerTache(d, { titre: "Orpheline", domaine: "DOC" });
  ajouterJournal(d, { date: "2026-10-23", session: "s1", chantiers: "CH-01", texte: "OUVERT. a | b" });
  d.journal.consigne = "Ajout seul.";
  const md = exportMd(d);
  const relu = merge({}, parseChantiers(md.chantiers), parseBacklog(md.backlog), () => null, {});
  const cle = (x) => [x.id, x.titre, x.colonne].join("~");
  assert.deepEqual(relu.chantiers.map(cle).sort(), d.chantiers.map((c) => cle({ ...c, titre: c.colonne === "abandonne" ? relu.chantiers.find((r) => r.id === c.id).titre : c.titre })).sort());
  assert.match(relu.chantiers.find((c) => c.id === "CH-02").titre, /ABANDONN/);
  for (const t of d.items) {
    const r = relu.items.find((i) => i.id === t.id);
    assert.ok(r, t.id);
    assert.deepEqual([r.titre, r.chantier, r.priorite, r.decision], [t.titre, t.chantier, t.priorite, t.decision], t.id);
  }
  assert.equal(relu.items.find((i) => i.id === "API-04").attendu, "a | b");
  const j = parseJournal(md.chantiers);
  assert.equal(j.consigne, "Ajout seul.");
  assert.equal(j.entrees[0].texte, "OUVERT. a | b");
});

// ---------- mode base : suite de contrat, sur chaque base de test fournie ----------
// Les URL viennent de l'environnement ou de ~/.agent-worklog/test-bases.env (jamais affichées).
// Les tables wl_* de ces bases sont effacées à chaque passage : des bases dédiées aux tests.
function basesDeTest() {
  const env = { ...process.env };
  const f = join(homedir(), ".agent-worklog", "test-bases.env");
  if (existsSync(f)) for (const l of readFileSync(f, "utf8").split(/\r?\n/)) { const m = l.match(/^\s*(WORKLOG_TEST_\w+)\s*=\s*(.+?)\s*$/); if (m && !env[m[1]]) env[m[1]] = m[2]; }
  return [["PostgreSQL", env.WORKLOG_TEST_PG], ["MySQL", env.WORKLOG_TEST_MYSQL]].filter(([, u]) => u);
}
const BASES = basesDeTest();
if (!BASES.length) test("mode base : aucune base de test (WORKLOG_TEST_PG / WORKLOG_TEST_MYSQL), suite de contrat sautée", { skip: true }, () => {});

async function baseNeuve(url) {
  const base = await ouvrirBase(url);
  for (const t of TABLES) await base.requete(`DROP TABLE IF EXISTS ${t}`);
  await migrer(base);
  return base;
}
const MOI = { nom: "moi", type: "interface" };
const S1 = { nom: "s1", type: "session" };

for (const [nom, url] of BASES) {
  test(`base ${nom} : migration, projet, écriture tracée, conflit, concurrence, textes, jetons`, async (t) => {
    const base = await baseNeuve(url);
    t.after(() => base.fermer());
    await migrer(base); // deux fois : sans erreur
    const depot = creerDepot(base);
    await depot.creerProjet({ id: "demo", nom: "Démo", ui: { accent: "#123456" } }, MOI);
    assert.deepEqual((await depot.projets()).map((p) => p.id), ["demo"]);

    const r = await depot.ecrire("demo", S1, (d) => creerChantier(d, { titre: "API" }));
    assert.equal(r.resultat, "CH-01");
    await depot.ecrire("demo", S1, (d) => creerTache(d, { chantier: "CH-01", titre: "Lire", domaine: "API" }));
    let d = await depot.lire("demo");
    assert.equal(d.meta.mode, "base");
    assert.equal(d.meta.projet, "Démo");
    assert.equal(d.items[0].id, "API-01");
    assert.ok(d.meta.version > 0);

    const m = await depot.ecrire("demo", MOI, (x) => modifierTache(x, "API-01", { statut: "fait" }));
    assert.deepEqual(m.changements.map((c) => [c.champ, c.avant, c.apres]), [["statut", "a_faire", "fait"]]);
    const m2 = await depot.ecrire("demo", S1, (x) => modifierTache(x, "API-01", { statut: "en_cours" }));
    assert.equal(m2.changements[0].auteurAvant.nom, "moi");
    assert.equal(m2.changements[0].auteurAvant.type, "interface");
    const h = await depot.historique("demo", "tache", "API-01");
    assert.deepEqual(h.slice(0, 2).map((l) => [l.champ, l.avant, l.apres, l.auteur, l.type_auteur]), [["statut", "fait", "en_cours", "s1", "session"], ["statut", "a_faire", "fait", "moi", "interface"]]);

    const p = await depot.ecrire("demo", MOI, (x) => applyPatch(x, { items: [{ id: "API-01", set: { statut: "fait" }, base: { statut: "a_faire" } }] }));
    assert.equal(p.resultat.conflicts.length, 1);
    assert.equal(p.changements.length, 0);
    assert.equal((await depot.lire("demo")).items[0].statut, "en_cours");

    // Review Focus 1 : 20 écritures concurrentes, toutes gardées (verrou du projet).
    await Promise.all(Array.from({ length: 20 }, (_, k) => depot.ecrire("demo", S1, (x) => {
      const c = x.chantiers.find((y) => y.id === "CH-01");
      modifierChantier(x, "CH-01", { note: `${c.note || ""}[${k}]` });
    })));
    const note = (await depot.lire("demo")).chantiers[0].note;
    for (let k = 0; k < 20; k++) assert.ok(note.includes(`[${k}]`), `écriture ${k} perdue`);

    // Review Focus 2 : texte long et caractères spéciaux.
    const bs = String.fromCharCode(92);
    const long = `'${bs}|😀\n`.repeat(4000);
    await depot.ecrire("demo", MOI, (x) => modifierTache(x, "API-01", { constat: long }));
    assert.equal((await depot.lire("demo")).items[0].constat, long);

    await depot.ecrire("demo", S1, (x) => ajouterJournal(x, { date: "2026-10-23", session: "s1", texte: "OUVERT." }));
    assert.equal((await depot.lire("demo")).journal.entrees.length, 1);

    const j = await depot.creerJeton("demo", "poste");
    assert.deepEqual(await depot.verifierJeton(j), { projetId: "demo" });
    const ji = await depot.creerJeton(null, "interface");
    assert.deepEqual(await depot.verifierJeton(ji), { projetId: null });
    assert.equal(await depot.verifierJeton("faux"), null);
  });
}

for (const [nom, url] of BASES) {
  test(`base ${nom} : import sans perte, refus d'un second import, remplacement tracé`, async (t) => {
    const base = await baseNeuve(url);
    t.after(() => base.fermer());
    const depot = creerDepot(base);
    const reel = "E:/wamp64/www/chatbot_faq/docs/tracker/chantiers.json";
    const src = existsSync(reel) ? JSON.parse(readFileSync(reel, "utf8")) : build();
    const journal = { consigne: "Ajout seul.", entrees: [{ date: "2026-10-01", session: "s0", chantiers: "tous", texte: "init", commits: "—", docs: "—" }] };
    const quoi = { id: "repli", nom: "Repli", ui: { accent: "#7fae2a" }, data: src, journal, textes: { chantiersMd: "# brut", backlogMd: "# brut aussi" }, specs: [{ chemin: "docs/chantiers/CH-01_api.md", texte: SPEC }] };
    await importer(depot, quoi, { nom: "import", type: "session" });
    const d = await depot.lire("repli");
    assert.deepEqual(d.chantiers, src.chantiers);
    assert.deepEqual(d.items, src.items);
    assert.deepEqual(d.journal, journal);
    assert.equal(d.textes.backlogMd, "# brut aussi");
    assert.equal(d.specs.length, 1);
    await assert.rejects(importer(depot, quoi, { nom: "import", type: "session" }), /existe déjà en base/);
    const autre = structuredClone(src);
    autre.items[0].note = "changée";
    autre.items.pop();
    await importer(depot, { ...quoi, data: autre }, { nom: "import", type: "session" }, { remplacer: true });
    const d2 = await depot.lire("repli");
    assert.equal(d2.items.length, src.items.length - 1);
    assert.equal(d2.items[0].note, "changée");
    const h = await depot.historique("repli", "tache", src.items[0].id);
    assert.equal(h[0].champ, "note");
    assert.equal(h[0].apres, "changée");
  });
}

for (const [nom, url] of BASES) {
  test(`BFF ${nom} : jetons, opérations, auteur remplacé, conflit, historique, export, import`, async (t) => {
    const base = await baseNeuve(url);
    t.after(() => base.fermer());
    const depot = creerDepot(base);
    const srv = createBff({ depot, uiDir: join(ROOT, "docs", "tracker"), outil: "2.0.0" }).listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    t.after(() => srv.close());
    const b = `http://localhost:${srv.address().port}`;
    const ji = await depot.creerJeton(null, "interface");
    const appel = (chemin, { jeton = ji, corps, auteur, host } = {}) => {
      const headers = { "Content-Type": "application/json" };
      if (jeton) headers.Authorization = `Bearer ${jeton}`;
      if (auteur) headers["X-Worklog-Auteur"] = encodeURIComponent(auteur);
      if (host) headers.Host = host;
      return fetch(b + chemin, corps === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(corps) });
    };

    assert.equal((await appel("/api/projets", { jeton: null })).status, 401);
    const cree = await appel("/api/projets", { corps: { id: "a", nom: "Alpha" }, auteur: "Xophe" });
    assert.equal(cree.status, 200);
    const ja = (await cree.json()).jeton;
    await appel("/api/projets", { corps: { id: "b", nom: "Beta" } });
    assert.equal((await appel("/p/b/chantiers.json", { jeton: ja })).status, 403);
    assert.equal((await appel("/p/a/chantiers.json", { jeton: "faux" })).status, 401);

    const op = (projet, o, args, opts = {}) => appel(`/api/p/${projet}/operation`, { corps: { op: o, args, session: opts.session }, ...opts });
    assert.equal((await op("a", "creerChantier", { titre: "API" }, { jeton: ja })).status, 400); // session manquante
    const r1 = await (await op("a", "creerChantier", { titre: "API" }, { jeton: ja, session: "s1" })).json();
    assert.equal(r1.resultat, "CH-01");
    await op("a", "creerTache", { chantier: "CH-01", titre: "Lire", domaine: "API" }, { jeton: ja, session: "s1" });
    await op("a", "modifierTache", { id: "API-01", champs: { statut: "fait" } }, { auteur: "Xophe" });
    const r2 = await (await op("a", "session", { statuts: [["API-01", "en_cours"]], suivis: [["API-01", "reprise"]] }, { jeton: ja, session: "s2" })).json();
    const st = r2.changements.find((c) => c.champ === "statut");
    assert.deepEqual([st.avant, st.apres, st.auteurAvant.nom, st.auteurAvant.type], ["fait", "en_cours", "Xophe", "interface"]);
    assert.equal((await op("a", "modifierTache", { id: "API-01", champs: { statut: "fini" } }, { jeton: ja, session: "s2" })).status, 400);

    const data = await (await appel("/p/a/chantiers.json")).json();
    assert.equal(data.meta.mode, "base");
    assert.equal(data.items[0].statut, "en_cours");
    assert.equal(data.specs, undefined);
    const patch = await appel("/p/a/save.php", { corps: { patch: { items: [{ id: "API-01", set: { statut: "fait" }, base: { statut: "a_faire" } }] } } });
    assert.equal((await patch.json()).conflicts.length, 1);

    const h = await (await appel("/api/p/a/historique?objet=tache&id=API-01")).json();
    assert.equal(h.lignes[0].auteur, "s2");
    const { request } = await import("node:http");
    const hote = await new Promise((ok) => request({ host: "127.0.0.1", port: srv.address().port, path: "/api/p/a/historique?objet=tache&id=API-01", headers: { Host: "evil.example", Authorization: `Bearer ${ji}` } }, (r) => { r.resume(); ok(r.statusCode); }).end());
    assert.equal(hote, 403);

    await op("a", "specs", { specs: [{ chemin: "docs/chantiers/CH-01_api.md", texte: SPEC }] }, { jeton: ja, session: "s1" });
    await op("a", "modifierChantier", { id: "CH-01", champs: { doc: "`docs/chantiers/CH-01_api.md`" } }, { jeton: ja, session: "s1" });
    await op("a", "specs", { specs: [{ chemin: "docs/chantiers/CH-01_api.md", texte: SPEC }] }, { jeton: ja, session: "s1" });
    assert.equal((await (await appel("/p/a/chantiers.json")).json()).chantiers[0].lots.length, 2);
    assert.equal((await (await appel("/api/p/a/spec?chemin=docs/chantiers/CH-01_api.md")).json()).texte, SPEC);

    const ex = await (await appel("/api/p/a/export")).json();
    assert.match(ex.chantiers, /CH-01/);
    assert.match(ex.backlog, /API-01/);

    const imp = await appel("/api/import", { corps: { id: "c", nom: "Gamma", data: build(), journal: { consigne: "", entrees: [] }, textes: {}, specs: [] } });
    assert.equal(imp.status, 200);
    const jc = (await imp.json()).jeton;
    assert.equal((await appel("/p/c/chantiers.json", { jeton: jc })).status, 200);
    assert.equal((await appel("/api/import", { jeton: ja, corps: { id: "d", nom: "D", data: build() } })).status, 403);
    const liste = await (await appel("/api/projets")).json();
    assert.deepEqual(liste.projets.map((p) => p.id), ["a", "b", "c"]);
    assert.equal(liste.projets[2].resume.taches.base, 4);
  });
}
