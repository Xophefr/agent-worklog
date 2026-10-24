// npm test : lecture des deux sources, fusion, écriture d'une session, cohérence,
// enregistrement du tableau (patch.mjs et serveur), relevé de code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
import { estLance, loadConfig } from "./config.mjs";
import { AGENTS, SKILL, agentsFromSkill } from "./sync-agents.mjs";
import { summarize } from "./resume.mjs";
import { createAccueil } from "./accueil.mjs";
import { addProject, loadRegistry, registryFile, removeProject, saveRegistry, slugId } from "./registre.mjs";
import { analyser, lireInterdits, verifierDepot } from "./verrou.mjs";
import { abandonner, avecVerrou, conflitsEnAttente, enAttente, enfiler, garderCopie, lireCopie, mettreDeCote, objetsTouches, rafraichirVerrou } from "./attente.mjs";

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
  writeFileSync(join(p1, "tracker.config.json"), JSON.stringify({ projet: "Équipe Pro" }));
  const file = registryFile({ AGENT_WORKLOG_HOME: home });
  assert.deepEqual(loadRegistry(file), { projets: [] });
  assert.equal(slugId("Équipe  Pro!"), "equipe-pro");
  const reg = loadRegistry(file);
  const e = addProject(reg, p1);
  assert.equal(e.id, "equipe-pro");
  assert.equal(e.type, "fichiers");
  assert.equal(addProject(reg, p1.replaceAll("/", "\\") + "\\").id, "equipe-pro");
  assert.equal(reg.projets.length, 1);
  writeFileSync(join(p2, "tracker.config.json"), JSON.stringify({ projet: "Equipe pro" }));
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
  assert.equal(existsSync(join(dir, "scripts", "worklog", "attente.mjs")), true, "attente.mjs est importé par client.mjs");
  for (const f of ["bff.mjs", "operations.mjs", "export-md.mjs", "accueil.mjs", "verrou.mjs"]) assert.equal(existsSync(join(dir, "scripts", "worklog", f)), false, f);
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
  // Titre tiré du début de la cellule, qui contient déjà du gras (backlog réel).
  const cel = "Grille du 5 octobre (note §10). **Plans en base** : migration";
  creerTache(d, { chantier: "CH-01", titre: cel, constat: cel, id: "API-09" });
  // Marque de décision écrite dans l'attendu (backlog réel d'un projet) : le titre n'en reçoit pas une seconde.
  creerTache(d, { chantier: "CH-01", titre: "Lien manquant", constat: "Lien manquant", attendu: "à trancher DÉCISION", decision: true, id: "API-10" });
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
  // Décision attendue sans marque dans le texte : la marque s'ajoute à l'attendu (c'est ainsi que le mode fichiers la lit).
  assert.equal(relu.items.find((i) => i.id === "API-04").attendu, "a | b DÉCISION");
  assert.equal(relu.items.find((i) => i.id === "API-10").attendu, "à trancher DÉCISION");
  const j = parseJournal(md.chantiers);
  assert.equal(j.consigne, "Ajout seul.");
  assert.equal(j.entrees[0].texte, "OUVERT. a | b");
});

// ---------- mode base : suite de contrat, sur chaque base de test fournie ----------
// WORKLOG_TEST_REEL (facultatif) : chemin d'un chantiers.json réel pour le test d'import volumineux.
// Les URL viennent de l'environnement ou de ~/.agent-worklog/test-bases.env (jamais affichées).
// Les tables wl_* de ces bases sont effacées à chaque passage : des bases dédiées aux tests.
function basesDeTest() {
  const env = { ...process.env };
  const f = join(homedir(), ".agent-worklog", "test-bases.env");
  if (existsSync(f)) for (const l of readFileSync(f, "utf8").split(/\r?\n/)) { const m = l.match(/^\s*(WORKLOG_TEST_\w+)\s*=\s*(.+?)\s*$/); if (m && !env[m[1]]) env[m[1]] = m[2]; }
  return { bases: [["PostgreSQL", env.WORKLOG_TEST_PG], ["MySQL", env.WORKLOG_TEST_MYSQL]].filter(([, u]) => u), reel: env.WORKLOG_TEST_REEL };
}
const { bases: BASES, reel: REEL } = basesDeTest();
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
    const reel = REEL; // chemin d'un chantiers.json réel (facultatif), réglé dans test-bases.env
    const src = reel && existsSync(reel) ? JSON.parse(readFileSync(reel, "utf8")) : build();
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
  test(`base ${nom} : uid idempotent, garde par version et par date`, async (t) => {
    const base = await baseNeuve(url);
    t.after(() => base.fermer());
    const depot = creerDepot(base);
    await importer(depot, { id: "p", nom: "P", data: build() }, { nom: "import", type: "session" });
    const op = (d) => modifierTache(d, "API-01", { statut: "fait" });
    const r1 = await depot.ecrire("p", S1, op, { uid: "u-00000001" });
    assert.equal(r1.deja, undefined);
    const r2 = await depot.ecrire("p", S1, op, { uid: "u-00000001" });
    assert.equal(r2.deja, true);
    assert.equal(r2.resultat, null);
    assert.deepEqual(r2.changements, []);
    assert.equal(r2.version, r1.version);
    assert.equal((await depot.historique("p", "tache", "API-01")).filter((l) => l.champ === "statut").length, 1);
    const v = r1.version;
    await depot.ecrire("p", MOI, (d) => modifierTache(d, "API-01", { note: "vu" }));           // autre auteur, autre champ
    await depot.ecrire("p", S1, (d) => modifierTache(d, "API-01", { statut: "a_verifier" }), { garde: { version: v } }); // pas de conflit
    await depot.ecrire("p", MOI, (d) => modifierTache(d, "API-02", { statut: "fait" }));
    const avant = (await depot.lire("p")).meta.version;
    await assert.rejects(depot.ecrire("p", S1, (d) => modifierTache(d, "API-02", { statut: "en_cours" }), { garde: { version: v }, uid: "u-00000002" }),
      (e) => e.code === 409 && e.details.conflits[0].champ === "statut" && e.details.conflits[0].auteur === "moi"
        && e.details.conflits[0].voulu === "en_cours" && e.details.conflits[0].enBase === "fait" && e.details.conflits[0].objet_id === "API-02");
    // conflit : transaction annulée, uid non retenu
    assert.equal((await depot.lire("p")).meta.version, avant);
    assert.equal((await depot.lire("p")).items.find((i) => i.id === "API-02").statut, "fait");
    const r3 = await depot.ecrire("p", S1, (d) => modifierTache(d, "API-02", { statut: "en_cours" }), { uid: "u-00000002" });
    assert.equal(r3.deja, undefined);
    // ses propres écritures ne sont pas un conflit
    await depot.ecrire("p", S1, (d) => modifierTache(d, "API-03", { statut: "fait" }));
    await depot.ecrire("p", S1, (d) => modifierTache(d, "API-03", { statut: "a_verifier" }), { garde: { version: v } });
    // garde par date (session sans version connue) : une modification d'avant la date n'est pas un conflit
    const depuis = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    await depot.ecrire("p", S1, (d) => modifierTache(d, "API-02", { note: "après" }), { garde: { depuis } });
    // … mais une modification d'un autre auteur après la date en est un
    await depot.ecrire("p", MOI, (d) => modifierTache(d, "API-02", { note: "autre" }));
    await assert.rejects(depot.ecrire("p", S1, (d) => modifierTache(d, "API-02", { note: "encore" }), { garde: { depuis: "2000-01-01T00:00:00Z" } }),
      (e) => e.code === 409 && e.details.conflits[0].champ === "note" && e.details.conflits[0].auteur === "moi");
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
    const cree = await appel("/api/projets", { corps: { id: "a", nom: "Alpha" }, auteur: "Dupont" });
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
    await op("a", "modifierTache", { id: "API-01", champs: { statut: "fait" } }, { auteur: "Dupont" });
    const r2 = await (await op("a", "session", { statuts: [["API-01", "en_cours"]], suivis: [["API-01", "reprise"]] }, { jeton: ja, session: "s2" })).json();
    const st = r2.changements.find((c) => c.champ === "statut");
    assert.deepEqual([st.avant, st.apres, st.auteurAvant.nom, st.auteurAvant.type], ["fait", "en_cours", "Dupont", "interface"]);
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

    // uid : forme refusée (400), rejeu sans seconde écriture (deja) ; garde : conflit (409) avec son détail.
    const opu = (corps) => appel("/api/p/a/operation", { jeton: ja, corps: { op: "modifierTache", session: "s3", ...corps } });
    assert.equal((await opu({ args: { id: "API-01", champs: { note: "x" } }, uid: "court" })).status, 400);
    assert.equal((await opu({ args: { id: "API-01", champs: { note: "x" } }, uid: "a/b-00000000" })).status, 400);
    assert.equal((await opu({ args: { id: "API-01", champs: { note: "x" } }, uid: 12345678 })).status, 400);
    const u1 = await opu({ args: { id: "API-01", champs: { note: "x" } }, uid: "op-0000000001" });
    assert.equal(u1.status, 200);
    const vu = (await u1.json()).version;
    const u2 = await opu({ args: { id: "API-01", champs: { note: "x" } }, uid: "op-0000000001" });
    assert.equal(u2.status, 200);
    const u2j = await u2.json();
    assert.equal(u2j.deja, true);
    assert.equal(u2j.version, vu);
    await op("a", "modifierTache", { id: "API-01", champs: { note: "y" } }, { auteur: "Dupont" });
    const cf = await opu({ args: { id: "API-01", champs: { note: "z" } }, uid: "op-0000000002", garde: { version: vu } });
    assert.equal(cf.status, 409);
    const cfj = await cf.json();
    assert.equal(cfj.ok, false);
    assert.deepEqual([cfj.conflits[0].objet, cfj.conflits[0].objet_id, cfj.conflits[0].champ, cfj.conflits[0].voulu, cfj.conflits[0].enBase, cfj.conflits[0].auteur],
      ["tache", "API-01", "note", "z", "y", "Dupont"]);
    assert.ok(cfj.conflits[0].quand);

    await op("a", "specs", { specs: [{ chemin: "docs/chantiers/CH-01_api.md", texte: SPEC }] }, { jeton: ja, session: "s1" });
    await op("a", "modifierChantier", { id: "CH-01", champs: { doc: "`docs/chantiers/CH-01_api.md`" } }, { jeton: ja, session: "s1" });
    await op("a", "specs", { specs: [{ chemin: "docs/chantiers/CH-01_api.md", texte: SPEC }] }, { jeton: ja, session: "s1" });
    assert.equal((await (await appel("/p/a/chantiers.json")).json()).chantiers[0].lots.length, 2);
    assert.equal((await (await appel("/api/p/a/spec?chemin=docs/chantiers/CH-01_api.md")).json()).texte, SPEC);

    const ex = await (await appel("/api/p/a/export")).json();
    assert.match(ex.chantiers, /CH-01/);
    assert.match(ex.backlog, /API-01/);
    // Statuts, priorités, rangs, notes, lots choisis vivent dans chantiers.json en mode fichiers : l'export le donne aussi.
    assert.equal(ex.json.items.find((i) => i.id === "API-01").statut, "en_cours");
    assert.equal(ex.json.meta.mode, undefined);

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

for (const [nom, url] of BASES) {
  test(`commande en mode base (${nom}) : import, specs, session, lecture, création, clôture, journal, export, gel des .md, BFF arrêté`, async (t) => {
    const { execFile } = await import("node:child_process");
    const base = await baseNeuve(url);
    t.after(() => base.fermer());
    const depot = creerDepot(base);
    const srv = createBff({ depot, uiDir: join(ROOT, "docs", "tracker") }).listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    t.after(() => { if (srv.listening) srv.close(); });
    const bff = `http://localhost:${srv.address().port}`;
    const tmp = mkdtempSync(join(tmpdir(), "wl-cli-"));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const home = join(tmp, "home");
    const dir = join(tmp, "proj");
    mkdirSync(join(dir, "docs", "chantiers"), { recursive: true });
    mkdirSync(home);
    writeFileSync(join(dir, "tracker.config.json"), JSON.stringify({ projet: "Démo Base" }));
    writeFileSync(join(dir, "docs", "CHANTIERS.md"), CHANTIERS.replace("## Journal\n| CH-99 | ne doit pas être lu |", "## Journal\n\nAjout seul.\n\n| date | session | chantier | ce qui a bougé | commits | docs |\n|---|---|---|---|---|---|\n| 2026-10-01 | s0 | tous | init | — | — |"));
    writeFileSync(join(dir, "docs", "chantiers", "backlog.md"), BACKLOG);
    writeFileSync(join(dir, "docs", "chantiers", "CH-01_api.md"), SPEC);
    const ji = await depot.creerJeton(null, "interface");
    writeFileSync(join(home, "bff-lies.json"), JSON.stringify({ [bff]: ji }));
    const run = (...a) => new Promise((ok) => execFile(process.execPath, [join(ROOT, "scripts", "worklog", "chantiers-tracker.mjs"), "--root", dir, ...a],
      { env: { ...process.env, AGENT_WORKLOG_HOME: home, WORKLOG_TOKEN: "" }, encoding: "utf8" }, (e, stdout, stderr) => ok({ code: e ? e.code : 0, out: stdout + stderr })));
    const lire = async () => (await fetch(`${bff}/p/demo-base/chantiers.json`, { headers: { Authorization: `Bearer ${ji}` } })).json();

    let r = await run("--importer", "--bff", bff);
    assert.equal(r.code, 0, r.out);
    const cfg = JSON.parse(readFileSync(join(dir, "tracker.config.json"), "utf8"));
    assert.deepEqual([cfg.mode, cfg.bff, cfg.projetBase], ["base", bff, "demo-base"]);
    assert.ok(JSON.parse(readFileSync(join(home, "jetons.json"), "utf8"))[`${new URL(bff).origin}|demo-base`]);
    // Le jeton ne part pas vers une autre adresse écrite dans le réglage du dépôt.
    writeFileSync(join(dir, "tracker.config.json"), JSON.stringify({ ...cfg, bff: "http://127.0.0.2:9" }));
    const fuite = await run("taches");
    assert.equal(fuite.code, 2);
    assert.match(fuite.out, /aucun jeton/);
    writeFileSync(join(dir, "tracker.config.json"), JSON.stringify(cfg));
    assert.equal((await lire()).items.length, 4);

    r = await run();
    assert.equal(r.code, 0, r.out);
    assert.equal((await lire()).chantiers.find((c) => c.id === "CH-01").lots.length, 2);
    assert.match(readFileSync(join(dir, "docs", "CHANTIERS.md"), "utf8").split("\n")[0], /Gelé le/);
    await run();
    assert.equal(readFileSync(join(dir, "docs", "CHANTIERS.md"), "utf8").split("Gelé le").length, 2); // une seule fois

    await fetch(`${bff}/api/p/demo-base/operation`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ji}`, "X-Worklog-Auteur": "Dupont" }, body: JSON.stringify({ op: "modifierTache", args: { id: "API-01", champs: { statut: "fait" } } }) });
    r = await run("--session", "s1", "--statut", "API-01=en_cours", "--suivi", "API-01=reprise");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /API-01.*était « fait ».*Dupont/);
    assert.equal((await lire()).items.find((i) => i.id === "API-01").statut, "en_cours");
    assert.equal((await run("--statut", "API-01=fait")).code, 2); // sans --session

    r = await run("voir", "CH-01");
    assert.match(r.out, /CH-01/);
    assert.match(r.out, /API-01/);
    assert.match(r.out, /Lots/);
    r = await run("taches");
    assert.match(r.out, /API-02/);

    r = await run("--session", "s1", "tache", "ajouter", "CH-01", "--titre", "Cache", "--attendu", "rapide");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /API-04/);
    r = await run("--session", "s1", "tache", "maj", "API-04", "--priorite", "P0", "--statut", "en_cours");
    assert.equal(r.code, 0, r.out);
    r = await run("--session", "s1", "chantier", "ajouter", "--titre", "Écrans 2", "--etat", "en cours");
    assert.match(r.out, /CH-03/);
    r = await run("--session", "s1", "chantier", "clore", "CH-02", "--preuve", "commit x", "--reste", "rien");
    assert.equal(r.code, 0, r.out);
    r = await run("--session", "s1", "journal", "OUVERT. Reprise", "--chantier", "CH-01");
    assert.equal(r.code, 0, r.out);
    const d = await lire();
    assert.deepEqual([d.items.find((i) => i.id === "API-04").priorite, d.chantiers.find((c) => c.id === "CH-02").colonne, d.journal.entrees.length], ["P0", "clos", 2]);
    assert.equal((await run("--session", "s1", "tache", "maj", "API-04", "--statut", "fini")).code, 1);

    r = await run("--exporter");
    assert.equal(r.code, 0, r.out);
    const exp = readdirSync(join(dir, "docs")).find((n) => n.startsWith("export-"));
    assert.match(readFileSync(join(dir, "docs", exp, "backlog.md"), "utf8"), /API-04/);
    assert.equal(JSON.parse(readFileSync(join(dir, "docs", exp, "chantiers.json"), "utf8")).items.find((i) => i.id === "API-04").priorite, "P0");

    // Review Focus 3 : BFF injoignable -> écriture en attente sur le poste (code 75), message clair, .md intacts.
    const avant = readFileSync(join(dir, "docs", "CHANTIERS.md"), "utf8");
    await new Promise((ok) => srv.close(ok));
    r = await run("--session", "s1", "--statut", "API-01=fait");
    assert.equal(r.code, 75, r.out);
    assert.match(r.out, /EN ATTENTE : serveur injoignable.*PAS encore en base/);
    r = await run("--exporter");
    assert.equal(r.code, 1);
    assert.match(r.out, /BFF injoignable/);
    assert.equal(readFileSync(join(dir, "docs", "CHANTIERS.md"), "utf8"), avant);
    rmSync(join(home, "jetons.json"));
    r = await run("taches");
    assert.equal(r.code, 2);
    assert.match(r.out, /jeton/);
  });
}

for (const [nom, url] of BASES) {
  test(`sessions hors ligne (${nom}) : attente, rejeu, conflit tranché, copie, rejeu interrompu, rejeu concurrent`, async (t) => {
    const { execFile } = await import("node:child_process");
    const base = await baseNeuve(url);
    t.after(() => base.fermer());
    const depot = creerDepot(base);
    const ui = join(ROOT, "docs", "tracker");
    let srv = createBff({ depot, uiDir: ui }).listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const port = srv.address().port;
    t.after(() => { srv.closeAllConnections(); if (srv.listening) srv.close(); });
    const arreter = async () => { srv.closeAllConnections(); if (srv.listening) await new Promise((ok) => srv.close(ok)); };
    const relancer = async (d = depot) => {
      srv = createBff({ depot: d, uiDir: ui }).listen(port, "127.0.0.1");
      await new Promise((r) => srv.once("listening", r));
    };
    const bff = `http://localhost:${port}`;
    const tmp = mkdtempSync(join(tmpdir(), "wl-hl-"));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const home = join(tmp, "home");
    const dir = join(tmp, "proj");
    mkdirSync(join(dir, "docs", "chantiers"), { recursive: true });
    mkdirSync(home);
    writeFileSync(join(dir, "tracker.config.json"), JSON.stringify({ projet: "Démo Base" }));
    writeFileSync(join(dir, "docs", "CHANTIERS.md"), CHANTIERS);
    writeFileSync(join(dir, "docs", "chantiers", "backlog.md"), BACKLOG);
    const ji = await depot.creerJeton(null, "interface");
    writeFileSync(join(home, "bff-lies.json"), JSON.stringify({ [bff]: ji }));
    const runEnv = (env, ...a) => new Promise((ok) => execFile(process.execPath, [join(ROOT, "scripts", "worklog", "chantiers-tracker.mjs"), "--root", dir, ...a],
      { env: { ...process.env, AGENT_WORKLOG_HOME: home, WORKLOG_TOKEN: "", WORKLOG_DELAI_BFF: "5000", ...env }, encoding: "utf8" }, (e, stdout, stderr) => ok({ code: e ? e.code : 0, out: stdout + stderr })));
    const run = (...a) => runEnv({}, ...a);
    const lire = async () => (await fetch(`${bff}/p/demo-base/chantiers.json`, { headers: { Authorization: `Bearer ${ji}` } })).json();
    const tache = async (id) => (await lire()).items.find((i) => i.id === id);
    const fichiersFile = () => readdirSync(join(home, "attente")).filter((n) => n.endsWith(".json"));
    const fichiersConflits = () => (existsSync(join(home, "attente", "conflits")) ? readdirSync(join(home, "attente", "conflits")).filter((n) => n.endsWith(".json")) : []);
    const lignes = async (objet, id, champ, apres) => (await depot.historique("demo-base", objet, id)).filter((l) => l.champ === champ && l.apres === apres).length;

    let r = await run("--importer", "--bff", bff);
    assert.equal(r.code, 0, r.out);
    r = await run("taches");                                            // copie gardée sur le poste
    assert.equal(r.code, 0, r.out);
    await arreter();
    r = await run("--session", "s1", "--statut", "API-01=fait");
    assert.equal(r.code, 75, r.out);
    assert.match(r.out, /EN ATTENTE.*PAS encore en base/);
    r = await run("--session", "s1", "tache", "ajouter", "CH-01", "--titre", "Hors ligne");
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /--id/);
    r = await run("--session", "s1", "tache", "maj", "API-02", "--statut", "en_cours");
    assert.equal(r.code, 75, r.out);
    assert.match(r.out, /\(2 en attente\)/);
    r = await run("voir", "CH-01");
    assert.equal(r.code, 75, r.out);
    assert.match(r.out, /copie du .* serveur injoignable/);
    assert.match(r.out, /API-02/);
    r = await run("attente");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /En attente : 2/);
    const jp = JSON.parse(readFileSync(join(home, "jetons.json"), "utf8"))[`${new URL(bff).origin}|demo-base`];
    for (const f of readdirSync(join(home, "attente")).filter((n) => n.endsWith(".json"))) assert.ok(!readFileSync(join(home, "attente", f), "utf8").includes(jp));

    await relancer();
    await fetch(`${bff}/api/p/demo-base/operation`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ji}`, "X-Worklog-Auteur": "Dupont" }, body: JSON.stringify({ op: "modifierTache", args: { id: "API-02", champs: { statut: "fait" } } }) });
    r = await run("taches");
    assert.equal(r.code, 0, r.out);
    assert.equal((await tache("API-01")).statut, "fait");              // passé
    assert.equal((await tache("API-02")).statut, "fait");              // conflit : pas écrasé
    assert.match(r.out, /CONFLIT .*API-02.*statut.*Dupont/);
    const uid = r.out.match(/CONFLIT (\S+)/)[1];
    assert.equal((await run("attente", "appliquer", uid)).code, 2);   // sans --session
    r = await run("--session", "s1", "attente", "appliquer", uid);
    assert.equal(r.code, 0, r.out);
    assert.equal((await tache("API-02")).statut, "en_cours");
    r = await run("attente");
    assert.doesNotMatch(r.out, /CONFLIT/);
    assert.match(r.out, /En attente : 0/);

    // Rejeu interrompu : le BFF garde la première écriture puis tombe avant de répondre ; après relance, chaque opération une seule fois.
    await arreter();
    for (const [id, note] of [["API-01", "i1"], ["API-03", "i2"], ["API-02", "i3"]]) assert.equal((await run("--session", "s1", "tache", "maj", id, "--note", note)).code, 75);
    let coupe = false;
    await relancer({ ...depot, ecrire: async (...a) => {
      const res = await depot.ecrire(...a);
      if (a[3]?.uid && !coupe) { coupe = true; srv.closeAllConnections(); srv.close(); }
      return res;
    } });
    r = await run("taches");
    assert.equal(r.code, 75, r.out);                                    // copie : le BFF est tombé pendant le rejeu
    assert.ok(coupe);
    assert.equal(await lignes("tache", "API-01", "note", "i1"), 1);
    await arreter();
    await relancer();
    r = await run("taches");
    assert.equal(r.code, 0, r.out);
    for (const [id, note] of [["API-01", "i1"], ["API-03", "i2"], ["API-02", "i3"]]) assert.equal(await lignes("tache", id, "note", note), 1, `${id} ${note}`);
    assert.doesNotMatch(r.out, /CONFLIT/);

    // Rejeu concurrent : deux commandes en même temps, trois opérations en attente -> chacune une seule fois.
    await arreter();
    for (const [id, note] of [["API-01", "c1"], ["API-03", "c2"], ["API-02", "c3"]]) assert.equal((await run("--session", "s1", "tache", "maj", id, "--note", note)).code, 75);
    await relancer();
    // Jeton refusé (401) : le rejeu s'arrête, la file reste entière, rien n'est mis de côté, la raison est dite.
    r = await runEnv({ WORKLOG_TOKEN: "faux-jeton" }, "taches");
    assert.match(r.out, /3 en attente \(le BFF a répondu 401/);
    assert.equal(fichiersFile().length, 3);
    assert.equal(fichiersConflits().length, 0);
    const [a, b] = await Promise.all([run("taches"), run("--session", "s2", "tache", "maj", "API-03", "--priorite", "P0")]);
    assert.equal(a.code, 0, a.out);
    assert.equal(b.code, 0, b.out);
    for (const [id, note] of [["API-01", "c1"], ["API-03", "c2"], ["API-02", "c3"]]) assert.equal(await lignes("tache", id, "note", note), 1, `${id} ${note}`);
    assert.equal((await tache("API-03")).priorite, "P0");
    assert.match((await run("attente")).out, /En attente : 0/);

    // Version de la copie : celle de la dernière lecture, jamais avancée par une écriture de la session.
    const operation = (corps) => fetch(`${bff}/api/p/demo-base/operation`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ji}`, "X-Worklog-Auteur": "Dupont" }, body: JSON.stringify(corps) });
    assert.equal((await run("taches")).code, 0);                       // copie à vN
    await operation({ op: "modifierTache", args: { id: "API-02", champs: { statut: "a_verifier" } } });
    r = await run("--session", "s1", "tache", "maj", "API-01", "--note", "en ligne");
    assert.equal(r.code, 0, r.out);
    await arreter();
    assert.equal((await run("--session", "s1", "tache", "maj", "API-02", "--statut", "en_cours")).code, 75);
    await relancer();
    r = await run("taches");
    assert.match(r.out, /CONFLIT .*API-02 statut.*Dupont/);
    assert.equal((await tache("API-02")).statut, "a_verifier");
    // attente appliquer : uid tiré de celui de l'entrée, un second envoi répond « déjà en base ».
    const uid2 = r.out.match(/CONFLIT (\S+)/)[1];
    r = await run("--session", "s1", "attente", "appliquer", uid2);
    assert.equal(r.code, 0, r.out);
    assert.equal((await tache("API-02")).statut, "en_cours");
    const encore = await (await operation({ op: "modifierTache", args: { id: "API-02", champs: { statut: "en_cours" } }, uid: `${uid2}-t` })).json();
    assert.equal(encore.deja, true);

    // Création sans --id dont la réponse arrive après le délai : gardée avec son uid, créée une seule fois au rejeu.
    await arreter();
    await relancer({ ...depot, ecrire: async (...a) => { const res = await depot.ecrire(...a); await new Promise((ok) => setTimeout(ok, 4000)); return res; } });
    r = await runEnv({ WORKLOG_DELAI_BFF: "2000" }, "--session", "s1", "tache", "ajouter", "CH-01", "--titre", "Lente");
    assert.equal(r.code, 75, r.out);
    assert.match(r.out, /la création a peut-être déjà été faite/);
    const lentes = async () => (await depot.lire("demo-base")).items.filter((i) => i.titre === "Lente").length;
    assert.equal(await lentes(), 1);                                   // écrite par le BFF, réponse perdue
    await arreter();
    await relancer();
    r = await run("taches");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /rejoué creerTache.*déjà en base/);
    assert.match(r.out, /créée/);
    assert.equal(await lentes(), 1);
    assert.match((await run("attente")).out, /En attente : 0/);
  });
}

for (const [nom, url] of BASES) {
  test(`accueil et mode base (${nom}) : cartes des deux modes, relais signé, passage en base, installation, BFF arrêté`, async (t) => {
    const { execFile } = await import("node:child_process");
    const base = await baseNeuve(url);
    t.after(() => base.fermer());
    const depot = creerDepot(base);
    const bffSrv = createBff({ depot, uiDir: join(ROOT, "docs", "tracker") }).listen(0, "127.0.0.1");
    await new Promise((r) => bffSrv.once("listening", r));
    t.after(() => { if (bffSrv.listening) bffSrv.close(); });
    const bff = `http://localhost:${bffSrv.address().port}`;
    const tmp = mkdtempSync(join(tmpdir(), "wl-accb-"));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const home = join(tmp, "home");
    mkdirSync(home);
    const ji = await depot.creerJeton(null, "interface");
    writeFileSync(join(home, "bff-lies.json"), JSON.stringify({ [bff]: ji }));
    writeFileSync(join(home, "auteur"), "Dupont\n");
    const projetMd = (nomP) => {
      const d = join(tmp, nomP);
      mkdirSync(join(d, "docs", "chantiers"), { recursive: true });
      writeFileSync(join(d, "tracker.config.json"), JSON.stringify({ projet: nomP }));
      writeFileSync(join(d, "docs", "CHANTIERS.md"), CHANTIERS);
      writeFileSync(join(d, "docs", "chantiers", "backlog.md"), BACKLOG);
      mkdirSync(join(d, "docs", "tracker"), { recursive: true });
      writeFileSync(join(d, "docs", "tracker", "chantiers.json"), JSON.stringify(build()));
      cpSync(join(ROOT, "scripts", "worklog"), join(d, "scripts", "worklog"), { recursive: true, filter: (s) => !s.includes("node_modules") });
      return d;
    };
    const a = projetMd("Alpha");
    const c = projetMd("Gamma");
    await depot.creerProjet({ id: "beta", nom: "Beta" }, { nom: "x", type: "interface" });
    const registry = join(home, "projets.json");
    const reg = { projets: [] };
    addProject(reg, a);
    addProject(reg, c);
    reg.projets.push({ id: "beta", type: "base", bff, projet: "beta" });
    saveRegistry(registry, reg);
    const acc = createAccueil({ registry, uiDir: join(ROOT, "docs", "tracker"), outil: "2.0.0" }).listen(0, "127.0.0.1");
    await new Promise((r) => acc.once("listening", r));
    t.after(() => acc.close());
    const A = `http://localhost:${acc.address().port}`;
    const post = (u, body, h = {}) => fetch(A + u, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(body) });

    let liste = await (await fetch(`${A}/api/projets`)).json();
    assert.equal(liste.projets.find((p) => p.id === "alpha").resume.nom, "Alpha");
    assert.equal(liste.projets.find((p) => p.id === "beta").resume.nom, "Beta");
    const db = await (await fetch(`${A}/p/beta/chantiers.json`)).json();
    assert.equal(db.meta.mode, "base");
    assert.equal(db.meta.accueil.url, "/");
    const op = await post("/p/beta/api/operation", { op: "creerChantier", args: { titre: "Relayé" } });
    assert.equal(op.status, 200, await op.clone().text());
    const h = await depot.historique("beta", "chantier", "CH-01");
    assert.deepEqual([h[0].auteur, h[0].type_auteur], ["Dupont", "interface"]);
    assert.equal((await post("/p/beta/api/operation", { op: "creerChantier", args: { titre: "x" } }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await post("/p/beta/save.php", { patch: { chantiers: [{ id: "CH-01", set: { note: "n" }, base: { note: "" } }] } })).status, 200);
    assert.equal((await (await fetch(`${A}/p/beta/api/historique?objet=chantier&id=CH-01`)).json()).lignes[0].champ, "note");

    // Passage en base d'un projet en mode fichiers : import, puis relais.
    const pass = await post("/api/projets/passer-en-base", { id: "gamma" });
    assert.equal(pass.status, 200, await pass.clone().text());
    assert.equal(JSON.parse(readFileSync(join(c, "tracker.config.json"), "utf8")).mode, "base");
    assert.equal((await (await fetch(`${A}/p/gamma/chantiers.json`)).json()).meta.mode, "base");

    // Installation en mode base d'un dossier neuf.
    const neuf = join(tmp, "Delta");
    mkdirSync(neuf);
    const inst = await new Promise((ok) => execFile(process.execPath, [join(ROOT, "scripts", "worklog", "install.mjs"), neuf, "--mode", "base", "--bff", bff], { env: { ...process.env, AGENT_WORKLOG_HOME: home }, encoding: "utf8" }, (e, o, s) => ok({ code: e ? e.code : 0, out: o + s })));
    assert.equal(inst.code, 0, inst.out);
    assert.equal(JSON.parse(readFileSync(join(neuf, "tracker.config.json"), "utf8")).mode, "base");
    assert.ok((await depot.projets()).some((p) => p.id === "delta"));

    // Review Focus 3 : BFF arrêté -> carte d'erreur, les autres intactes.
    // Deux autres projets en base : epsilon lu (avec une tâche à lui) avant la coupure, zeta jamais lu (pas de copie).
    await depot.creerProjet({ id: "epsilon", nom: "Epsilon" }, { nom: "x", type: "interface" });
    await depot.creerProjet({ id: "zeta", nom: "Zeta" }, { nom: "x", type: "interface" });
    const reg2 = JSON.parse(readFileSync(registry, "utf8"));
    reg2.projets.push({ id: "epsilon", type: "base", bff, projet: "epsilon" }, { id: "zeta", type: "base", bff, projet: "zeta" });
    writeFileSync(registry, JSON.stringify(reg2));
    assert.equal((await post("/p/epsilon/api/operation", { op: "creerTache", args: { id: "API-01", titre: "Propre à epsilon", domaine: "API" } })).status, 200);
    assert.equal((await (await fetch(`${A}/p/epsilon/chantiers.json`)).json()).items.length, 1);
    const portBff = bffSrv.address().port;
    const erreurs = [];
    const consoleErreur = console.error;
    console.error = (...m) => { erreurs.push(m.join(" ")); };
    t.after(() => { console.error = consoleErreur; });
    await new Promise((r) => bffSrv.close(r));
    liste = await (await fetch(`${A}/api/projets`)).json();
    assert.match(liste.projets.find((p) => p.id === "beta").erreur, /serveur injoignable/);
    assert.equal(liste.projets.find((p) => p.id === "alpha").resume.nom, "Alpha");
    // Hors ligne : la dernière copie lue est servie en lecture seule, les écritures sont refusées.
    const hl = await (await fetch(`${A}/p/beta/chantiers.json`)).json();
    assert.ok(hl.meta.horsLigne && hl.meta.horsLigne.depuis);
    assert.equal(hl.items.length, db.items.length);
    assert.equal(hl.meta.accueil.url, "/");
    const w = await post("/p/beta/api/operation", { op: "modifierTache", args: { id: "API-01", champs: { statut: "fait" } } });
    assert.equal(w.status, 502);
    assert.match((await w.json()).error, /serveur injoignable/);
    const ws = await post("/p/beta/save.php", { patch: { chantiers: [] } });
    assert.equal(ws.status, 502);
    // Chaque projet sert sa propre copie.
    const he = await (await fetch(`${A}/p/epsilon/chantiers.json`)).json();
    assert.ok(he.meta.horsLigne);
    assert.deepEqual(he.items.map((i) => i.id), ["API-01"]);
    assert.notDeepEqual(he.items.map((i) => i.id), hl.items.map((i) => i.id));
    assert.equal((await fetch(`${A}/p/zeta/chantiers.json`)).status, 502);
    assert.deepEqual(erreurs, [], "aucune erreur levée en servant la copie");
    console.error = consoleErreur;
    // Retour du BFF : la lecture suivante n'est plus hors ligne.
    const bff2 = createBff({ depot, uiDir: join(ROOT, "docs", "tracker") }).listen(portBff, "127.0.0.1");
    await new Promise((r) => bff2.once("listening", r));
    t.after(() => { if (bff2.listening) bff2.close(); });
    const back = await (await fetch(`${A}/p/beta/chantiers.json`)).json();
    assert.equal(back.meta.horsLigne, undefined);
    assert.equal(back.meta.mode, "base");
  });
}

test("opérations : verrou par champ d'un formulaire (valeur de départ)", () => {
  const d = build();
  const ok = modifierTache(d, "API-01", { attendu: "200", note: "a" }, { attendu: d.items[0].attendu, note: "" });
  assert.deepEqual(ok.conflits, []);
  // Quelqu'un change la note entre-temps ; le formulaire ouvert avant enregistre note ET priorité.
  modifierTache(d, "API-01", { note: "b" });
  const r = modifierTache(d, "API-01", { note: "mienne", priorite: "P0" }, { note: "a", priorite: "P1" });
  assert.deepEqual(r.conflits, [{ champ: "note", valeur: "b" }]);
  const t = d.items.find((i) => i.id === "API-01");
  assert.deepEqual([t.note, t.priorite], ["b", "P0"]);
  const c = modifierChantier(d, "CH-01", { titre: "Nouveau" }, { titre: "Autre chose" });
  assert.deepEqual(c.conflits.map((x) => x.champ), ["titre"]);
  assert.equal(d.chantiers.find((x) => x.id === "CH-01").titre, "API publique");
});

for (const [nom, url] of BASES) {
  test(`BFF ${nom} : import d'un gros projet (plus de 2 Mo), réponse 413 au-delà de la limite`, async (t) => {
    const base = await baseNeuve(url);
    t.after(() => base.fermer());
    const depot = creerDepot(base);
    const srv = createBff({ depot, uiDir: join(ROOT, "docs", "tracker"), maxCorps: 8_000_000 }).listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    t.after(() => srv.close());
    const ji = await depot.creerJeton(null, "interface");
    const gros = build();
    gros.items[0].constat = "x".repeat(3_000_000);
    const post = (corps) => fetch(`http://localhost:${srv.address().port}/api/import`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ji}` }, body: JSON.stringify(corps) });
    const r = await post({ id: "gros", nom: "Gros", data: gros });
    assert.equal(r.status, 200, await r.clone().text());
    gros.items[0].constat = "x".repeat(9_000_000);
    const trop = await post({ id: "trop", nom: "Trop", data: gros });
    assert.equal(trop.status, 413);
    assert.match((await trop.json()).error, /trop grande/);
  });
}

for (const [nom, url] of BASES) {
  test(`revue 2.0.0 (${nom}) : réglages réservés à l'interface, adresse avec /, chemins confinés, BFF qui ne répond pas`, async (t) => {
    const { execFile } = await import("node:child_process");
    const { createServer } = await import("node:http");
    const base = await baseNeuve(url);
    t.after(() => base.fermer());
    const depot = creerDepot(base);
    const srv = createBff({ depot, uiDir: join(ROOT, "docs", "tracker") }).listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    t.after(() => { if (srv.listening) srv.close(); });
    const bff = `http://localhost:${srv.address().port}`;
    const ji = await depot.creerJeton(null, "interface");
    await depot.creerProjet({ id: "p", nom: "P" }, { nom: "x", type: "interface" });
    const jp = await depot.creerJeton("p", "poste");
    const op = (jeton, corps) => fetch(`${bff}/api/p/p/operation`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${jeton}` }, body: JSON.stringify(corps) });
    assert.equal((await op(jp, { op: "reglages", args: { md: "retirer" }, session: "s1" })).status, 403);
    assert.equal((await op(ji, { op: "reglages", args: { md: "garder" } })).status, 200);

    const tmp = mkdtempSync(join(tmpdir(), "wl-rev2-"));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const home = join(tmp, "home");
    mkdirSync(home);
    writeFileSync(join(home, "bff-lies.json"), JSON.stringify({ [new URL(bff).origin]: ji }));
    const dir = join(tmp, "proj");
    mkdirSync(join(dir, "docs", "chantiers"), { recursive: true });
    writeFileSync(join(tmp, "dehors.md"), "à garder");
    writeFileSync(join(dir, "tracker.config.json"), JSON.stringify({ projet: "Proj", chantiers: "../dehors.md" }));
    writeFileSync(join(dir, "docs", "chantiers", "backlog.md"), BACKLOG);
    const run = (env, ...a) => new Promise((ok) => execFile(process.execPath, [join(ROOT, "scripts", "worklog", "chantiers-tracker.mjs"), "--root", dir, ...a],
      { env: { ...process.env, AGENT_WORKLOG_HOME: home, WORKLOG_TOKEN: "", ...env }, encoding: "utf8" }, (e, o, s) => ok({ code: e ? e.code : 0, out: o + s })));
    // Chemin du réglage qui sort du projet : --retirer-md refuse, le fichier du dehors reste.
    let r = await run({}, "--importer", "--bff", `${bff}/`, "--retirer-md");
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /hors du projet/);
    assert.equal(readFileSync(join(tmp, "dehors.md"), "utf8"), "à garder");
    // Adresse donnée avec une barre finale : le jeton d'interface (gardé par origine) est trouvé.
    writeFileSync(join(dir, "tracker.config.json"), JSON.stringify({ projet: "Proj" }));
    writeFileSync(join(dir, "docs", "CHANTIERS.md"), CHANTIERS);
    r = await run({}, "--importer", "--bff", `${bff}/`);
    assert.equal(r.code, 0, r.out);

    // BFF qui accepte la connexion et ne répond jamais : erreur dans le délai, pas d'attente sans fin.
    const muet = createServer(() => {}).listen(0, "127.0.0.1");
    await new Promise((ok) => muet.once("listening", ok));
    t.after(() => muet.close());
    const adresse = `http://localhost:${muet.address().port}`;
    const cfg = JSON.parse(readFileSync(join(dir, "tracker.config.json"), "utf8"));
    writeFileSync(join(dir, "tracker.config.json"), JSON.stringify({ ...cfg, bff: adresse }));
    writeFileSync(join(home, "jetons.json"), JSON.stringify({ [`${new URL(adresse).origin}|${cfg.projetBase}`]: "x" }));
    const debut = Date.now();
    r = await run({ WORKLOG_DELAI_BFF: "800" }, "taches");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /serveur injoignable, aucune copie de/);
    assert.ok(Date.now() - debut < 8000);
    const registry = join(home, "projets.json");
    saveRegistry(registry, { projets: [{ id: "m", type: "base", bff: adresse, projet: "m" }, ] });
    writeFileSync(join(home, "bff-lies.json"), JSON.stringify({ [new URL(adresse).origin]: "x" }));
    process.env.WORKLOG_DELAI_BFF = "800";
    t.after(() => { delete process.env.WORKLOG_DELAI_BFF; });
    const acc = createAccueil({ registry, uiDir: join(ROOT, "docs", "tracker"), outil: "2.0.0" }).listen(0, "127.0.0.1");
    await new Promise((ok) => acc.once("listening", ok));
    t.after(() => acc.close());
    const liste = await (await fetch(`http://localhost:${acc.address().port}/api/projets`)).json();
    assert.match(liste.projets[0].erreur, /serveur injoignable/);
  });
}

// Verrou du dépôt public : les chaînes piégées sont construites à l'exécution
// pour que ce fichier passe lui-même le verrou.
test("verrou : formes génériques refusées, exemples admis", () => {
  const ip = ["10", "4", "5", "6"].join(".");
  const cle = "-----BEGIN " + "OPENSSH PRIVATE KEY-----";
  const cnx = "postgres://u:" + "secret" + "@h/db";
  const chemin = "C:" + "\\Users\\quelquun\\x";
  const motifs = (t) => analyser(t, { chemin: "x.md" }).map((r) => r.motif);
  assert.deepEqual(motifs(`a ${ip} b`), ["ip"]);
  assert.deepEqual(motifs(cle), ["cle-privee"]);
  assert.deepEqual(motifs(cnx), ["connexion"]);
  assert.deepEqual(motifs(chemin), ["chemin-poste"]);
  assert.deepEqual(motifs("contact " + "a" + "@" + "exemple-reel.fr"), ["email"]);
  const jeton = "A".repeat(43);
  assert.deepEqual(motifs("Authorization: Bearer " + jeton), ["jeton"]);
  assert.deepEqual(motifs('{"x": "' + jeton + '"}'), ["jeton"]);
  for (const ok of ["127.0.0.1:4180", "192.0.2.10", "0.0.0.0", "postgres://worklog:<mot de passe>@localhost:5432/worklog", "v2.0.0", "1.2.3", "personne@example.com"]) assert.deepEqual(motifs(ok), [], ok);
});
test("verrou : spécifications de paquet, SCP git et URL à chemin ne sont pas des emails ou des mots de passe", () => {
  const motifs = (t) => analyser(t, { chemin: "x.md" }).map((r) => r.motif);
  for (const ok of ["npm i pkg@3.24.6", "dep: lib@1.2.3-beta.1", "git" + "@" + "github.com:org/depot.git", "http://localhost:4180/x" + "@" + "y", "http://localhost:4180/a@b"]) assert.deepEqual(motifs(ok), [], ok);
  assert.deepEqual(motifs("postgres://u:" + "secret" + "@h/db"), ["connexion"]);
  assert.deepEqual(motifs("postgres://u:" + "pa/ss" + "@h/db"), ["connexion"]);
  assert.deepEqual(motifs("redis://:" + "secret" + "@h:6379"), ["connexion"]);
  for (const ko of ["x" + "@" + "hote-reel.fr:mot", "u" + "@" + "societe.com:25", "mail bob" + "@" + "societe.com:merci"]) assert.deepEqual(motifs(ko), ["email"], ko);
  for (const ok of ["redis://:<mot de passe>@h:6379", "postgres://u:***@h/db", "postgres://u:<secret>@h/db"]) assert.deepEqual(motifs(ok), [], ok);
  assert.deepEqual(motifs("contact " + "a" + "@" + "exemple-reel.fr"), ["email"]);
});
test("verrou : le dépôt passe le verrou (formes génériques et liste personnelle du poste)", () => {
  const maison = process.env.AGENT_WORKLOG_HOME || join(homedir(), ".agent-worklog");
  const refus = verifierDepot(ROOT, { interdits: lireInterdits(maison) });
  assert.deepEqual(refus.map((r) => `${r.chemin}:${r.ligne} ${r.motif.startsWith("interdit:") ? "interdit" : r.motif}`), []);
});
test("verrou : la racine est celle de git, et un crochet existant n'est pas écrasé", () => {
  const dep = mkdtempSync(join(tmpdir(), "wl-verrou-racine-"));
  const env = { ...process.env, AGENT_WORKLOG_HOME: mkdtempSync(join(tmpdir(), "wl-verrou-home-")) };
  const git = (...a) => spawnSync("git", a, { cwd: dep, encoding: "utf8" });
  git("init", "-q");
  mkdirSync(join(dep, "sous"), { recursive: true });
  writeFileSync(join(dep, "a.md"), "contact " + "a" + "@" + "exemple-reel.fr\n");
  git("add", "a.md");
  const verrou = join(ROOT, "scripts", "worklog", "verrou.mjs");
  // Depuis un sous-dossier, tout le dépôt est lu (et non le seul dossier courant).
  const r = spawnSync(process.execPath, [verrou], { cwd: join(dep, "sous"), encoding: "utf8", env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a\.md:1 email/);
  // Un crochet étranger est gardé : refus net, contenu intact.
  mkdirSync(join(dep, ".git", "hooks"), { recursive: true });
  writeFileSync(join(dep, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho autre\n");
  const inst = spawnSync(process.execPath, [verrou, "installer"], { cwd: dep, encoding: "utf8", env });
  assert.equal(inst.status, 1);
  assert.match(inst.stderr, /pre-commit/);
  assert.equal(readFileSync(join(dep, ".git", "hooks", "pre-commit"), "utf8"), "#!/bin/sh\necho autre\n");
});
test("verrou : liste personnelle sans casse, hors du dépôt", () => {
  const maison = mkdtempSync(join(tmpdir(), "wl-verrou-"));
  writeFileSync(join(maison, "interdits.txt"), "# noms\nAcmeCorp\n\n");
  const interdits = lireInterdits(maison);
  assert.deepEqual(interdits, ["AcmeCorp"]);
  const trouve = analyser("chez acmecorp.fr", { chemin: "a.md", interdits });
  assert.deepEqual(trouve.map((r) => r.motif), ["interdit:#1"]);
  assert.ok(!JSON.stringify(trouve).toLowerCase().includes("acme")); // le mot n'est jamais rapporté
  assert.deepEqual(lireInterdits(join(maison, "absent")), []);
});
test("verrou : exceptions étroites (LICENSE, URL du dépôt)", () => {
  assert.deepEqual(analyser("Copyright (c) 2026 Nom", { chemin: "LICENSE", interdits: ["Nom"] }), []);
  assert.equal(analyser("Nom ailleurs", { chemin: "README.md", interdits: ["Nom"] }).length, 1);
});
test("verrou : un commit piégé est refusé par le crochet", () => {
  const dep = mkdtempSync(join(tmpdir(), "wl-verrou-git-"));
  const maison = mkdtempSync(join(tmpdir(), "wl-verrou-home-"));
  const env = { ...process.env, AGENT_WORKLOG_HOME: maison };
  const git = (...a) => spawnSync("git", a, { cwd: dep, encoding: "utf8", env });
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  mkdirSync(join(dep, "scripts", "worklog"), { recursive: true });
  cpSync(join(ROOT, "scripts", "worklog", "verrou.mjs"), join(dep, "scripts", "worklog", "verrou.mjs"));
  const inst = spawnSync(process.execPath, ["scripts/worklog/verrou.mjs", "installer"], { cwd: dep, encoding: "utf8", env });
  assert.equal(inst.status, 0, inst.stderr);
  writeFileSync(join(dep, "a.md"), "serveur " + ["10", "4", "5", "6"].join(".") + "\n");
  git("add", "a.md");
  const refus = git("commit", "-m", "piege");
  assert.notEqual(refus.status, 0);
  assert.match(refus.stderr, /verrou/);
  writeFileSync(join(dep, "a.md"), "serveur local\n");
  git("add", "a.md");
  const ok = git("commit", "-m", "propre");
  assert.equal(ok.status, 0, ok.stderr);
  rmSync(dep, { recursive: true, force: true });
});
test("verrou : un secret ajouté puis retiré avant l'envoi est refusé au push", () => {
  const dep = mkdtempSync(join(tmpdir(), "wl-verrou-push-"));
  const distant = mkdtempSync(join(tmpdir(), "wl-verrou-bare-"));
  const maison = mkdtempSync(join(tmpdir(), "wl-verrou-home-"));
  const env = { ...process.env, AGENT_WORKLOG_HOME: maison };
  const git = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8", env });
  git(distant, "init", "-q", "--bare");
  git(dep, "init", "-q");
  git(dep, "config", "user.name", "Test");
  git(dep, "config", "user.email", "test@example.com");
  git(dep, "remote", "add", "origin", distant);
  mkdirSync(join(dep, "scripts", "worklog"), { recursive: true });
  cpSync(join(ROOT, "scripts", "worklog", "verrou.mjs"), join(dep, "scripts", "worklog", "verrou.mjs"));
  assert.equal(spawnSync(process.execPath, ["scripts/worklog/verrou.mjs", "installer"], { cwd: dep, encoding: "utf8", env }).status, 0);
  writeFileSync(join(dep, "a.md"), "serveur " + ["10", "4", "5", "6"].join(".") + "\n");
  git(dep, "add", "a.md");
  assert.equal(git(dep, "commit", "--no-verify", "-m", "A").status, 0);
  writeFileSync(join(dep, "a.md"), "serveur local\n");
  git(dep, "add", "a.md");
  assert.equal(git(dep, "commit", "--no-verify", "-m", "B").status, 0);
  const push = git(dep, "push", "origin", "HEAD:refs/heads/main");
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /verrou/);
  assert.match(push.stderr, /ip/);
  rmSync(dep, { recursive: true, force: true });
  rmSync(distant, { recursive: true, force: true });
});
test("verrou : une erreur git refuse au lieu de laisser passer", () => {
  const vide = mkdtempSync(join(tmpdir(), "wl-verrou-nogit-"));
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "worklog", "verrou.mjs"), "--indexes"], { cwd: vide, encoding: "utf8", env: { ...process.env, AGENT_WORKLOG_HOME: mkdtempSync(join(tmpdir(), "wl-verrou-home-")), GIT_CEILING_DIRECTORIES: tmpdir() } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /vérification impossible/);
  rmSync(vide, { recursive: true, force: true });
});
test("verrou : un secret introduit par un commit de fusion est refusé au push", () => {
  const dep = mkdtempSync(join(tmpdir(), "wl-verrou-merge-"));
  const distant = mkdtempSync(join(tmpdir(), "wl-verrou-bare-"));
  const env = { ...process.env, AGENT_WORKLOG_HOME: mkdtempSync(join(tmpdir(), "wl-verrou-home-")) };
  const git = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8", env });
  git(distant, "init", "-q", "--bare");
  git(dep, "init", "-q", "-b", "main");
  git(dep, "config", "user.name", "Test");
  git(dep, "config", "user.email", "test@example.com");
  git(dep, "remote", "add", "origin", distant);
  mkdirSync(join(dep, "scripts", "worklog"), { recursive: true });
  cpSync(join(ROOT, "scripts", "worklog", "verrou.mjs"), join(dep, "scripts", "worklog", "verrou.mjs"));
  assert.equal(spawnSync(process.execPath, ["scripts/worklog/verrou.mjs", "installer"], { cwd: dep, encoding: "utf8", env }).status, 0);
  writeFileSync(join(dep, "a.md"), "a\n");
  git(dep, "add", "a.md");
  assert.equal(git(dep, "commit", "-m", "base").status, 0);
  git(dep, "checkout", "-q", "-b", "cote");
  writeFileSync(join(dep, "b.md"), "b\n");
  git(dep, "add", "b.md");
  assert.equal(git(dep, "commit", "-m", "cote").status, 0);
  git(dep, "checkout", "-q", "main");
  writeFileSync(join(dep, "c.md"), "c\n");
  git(dep, "add", "c.md");
  assert.equal(git(dep, "commit", "-m", "principal").status, 0);
  git(dep, "merge", "--no-ff", "--no-commit", "cote");
  writeFileSync(join(dep, "d.md"), "serveur " + ["10", "4", "5", "6"].join(".") + "\n");
  git(dep, "add", "d.md");
  assert.equal(git(dep, "commit", "--no-verify", "-m", "fusion").status, 0);
  const push = git(dep, "push", "origin", "main");
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /d\.md/);
  rmSync(dep, { recursive: true, force: true });
  rmSync(distant, { recursive: true, force: true });
});

test("attente : ordre, jamais de jeton, conflits, verrou, copies", async () => {
  const m = mkdtempSync(join(tmpdir(), "wl-att-"));
  const p = { bff: "http://localhost:4180", projet: "demo" };
  const a = enfiler(m, { ...p, session: "s1", op: "modifierTache", args: { id: "API-01", champs: { statut: "fait" } }, garde: { version: 3 } });
  const b = enfiler(m, { ...p, session: "s1", op: "ajouterJournal", args: { texte: "x" }, garde: { version: 3 } });
  assert.equal(b.enAttente, 2);
  assert.deepEqual(enAttente(m, p).map((o) => o.uid), [a.uid, b.uid]);
  assert.ok(!readdirSync(join(m, "attente"), { withFileTypes: true }).filter((e) => e.isFile()).some((e) => /jeton|Bearer/.test(readFileSync(join(m, "attente", e.name), "utf8"))));
  mettreDeCote(m, a.uid, { raison: "conflit", conflits: [{ champ: "statut" }] });
  assert.deepEqual(enAttente(m, p).map((o) => o.uid), [b.uid]);
  assert.equal(conflitsEnAttente(m, p)[0].raison, "conflit");
  abandonner(m, a.uid);
  assert.equal(conflitsEnAttente(m, p).length, 0);
  assert.deepEqual(objetsTouches("session", { statuts: { "API-01": "fait" }, suivis: { "API-02": "x" } }).sort(), ["API-01", "API-02"]);
  const trace = [];
  const tache = (n) => async () => { trace.push(`debut ${n}`); await new Promise((r) => setTimeout(r, 50)); trace.push(`fin ${n}`); return n; };
  const [x, y] = await Promise.all([avecVerrou(m, tache("un")), avecVerrou(m, tache("deux"))]);
  assert.deepEqual([x, y].sort(), ["deux", "un"]);
  assert.match(trace.join(","), /^debut (un|deux),fin \1,debut (un|deux),fin \2$/); // jamais en même temps
  // Verrou libéré après usage : un nouvel appel sans attente obtient le verrou.
  assert.equal(await avecVerrou(m, async () => "x", { attendre: 0 }), "x");
  assert.equal(await avecVerrou(m, async () => "y", { attendre: 0 }), "y");
  garderCopie(m, p, { meta: { version: 7 }, chantiers: [], items: [] });
  assert.equal(lireCopie(m, p).version, 7);
  assert.deepEqual(lireCopie(m, p).data.meta, { version: 7 });
  assert.equal(lireCopie(m, { ...p, projet: "autre" }), null);
  rmSync(m, { recursive: true, force: true });
});

test("attente : verrou périmé repris, délai dépassé, verrou d'un autre jamais retiré", async () => {
  const m = mkdtempSync(join(tmpdir(), "wl-ver-"));
  mkdirSync(join(m, "attente"), { recursive: true });
  const verrou = join(m, "attente", ".verrou");
  // Détenu et récent : on attend, puis null.
  writeFileSync(verrou, "autre");
  const t0 = Date.now();
  assert.equal(await avecVerrou(m, async () => "x", { attendre: 250 }), null);
  assert.ok(Date.now() - t0 >= 200);
  assert.equal(readFileSync(verrou, "utf8"), "autre");
  // Périmé (plus de 120 s) : repris, et plusieurs candidats ne s'exécutent pas ensemble.
  const vieux = new Date(Date.now() - 200000);
  utimesSync(verrou, vieux, vieux);
  const trace = [];
  const tache = (n) => async () => { trace.push(`debut ${n}`); await new Promise((r) => setTimeout(r, 50)); trace.push(`fin ${n}`); return n; };
  const rendus = await Promise.all([avecVerrou(m, tache("a")), avecVerrou(m, tache("b")), avecVerrou(m, tache("c"))]);
  assert.deepEqual(rendus.sort(), ["a", "b", "c"]);
  assert.match(trace.join(","), /^debut (.),fin \1,debut (.),fin \2,debut (.),fin \3$/);
  assert.equal(existsSync(verrou), false);
  assert.deepEqual(readdirSync(join(m, "attente")).filter((n) => n.includes("perime")), []); // rien ne traîne
  // Reste d'un verrou emporté, périmé, laissé par un processus interrompu : nettoyé à la prise du verrou.
  const reste = join(m, "attente", ".verrou.00000000-0000-0000-0000-000000000000.perime");
  writeFileSync(reste, "jeton-oublie");
  utimesSync(reste, vieux, vieux);
  assert.equal(await avecVerrou(m, async () => "ok"), "ok");
  assert.deepEqual(readdirSync(join(m, "attente")).filter((n) => n.includes("perime")), []);
  // Rafraîchi pendant un long rejeu : un verrou de plus de 120 s n'est plus vu comme périmé.
  await avecVerrou(m, async (rafraichir) => {
    const t = new Date(Date.now() - 200000);
    utimesSync(verrou, t, t);
    assert.equal(await avecVerrou(m, async () => "pris", { attendre: 0 }), "pris"); // périmé : repris
    writeFileSync(verrou, "x"); // le verrou repris est celui du second ; le nôtre n'existe plus
    assert.equal(rafraichir(), false); // pas notre jeton : jamais touché
  });
  const jeton = "mon-jeton";
  writeFileSync(verrou, jeton);
  const vieux2 = new Date(Date.now() - 200000);
  utimesSync(verrou, vieux2, vieux2);
  assert.equal(rafraichirVerrou(m, "autre"), false);
  assert.ok(Date.now() - statSync(verrou).mtimeMs > 120000);
  assert.equal(rafraichirVerrou(m, jeton), true);
  assert.ok(Date.now() - statSync(verrou).mtimeMs < 5000);
  assert.equal(await avecVerrou(m, async () => "x", { attendre: 0 }), null); // frais : plus repris
  rmSync(verrou, { force: true });
  // Verrou remplacé pendant l'exécution : le détenteur d'origine ne supprime pas celui du nouveau.
  await avecVerrou(m, async () => { writeFileSync(verrou, "nouveau-detenteur"); });
  assert.equal(readFileSync(verrou, "utf8"), "nouveau-detenteur");
  rmSync(m, { recursive: true, force: true });
});

test("attente : projets isolés, ordre entre sessions, fichier illisible signalé", () => {
  const m = mkdtempSync(join(tmpdir(), "wl-iso-"));
  const p = { bff: "http://localhost:4180", projet: "demo" };
  const autreBff = { bff: "http://localhost:4181", projet: "demo" };
  const autreProjet = { bff: "http://localhost:4180", projet: "autre" };
  const a = enfiler(m, { ...p, session: "s", op: "ajouterJournal", args: {}, garde: null });
  enfiler(m, { ...autreBff, session: "s", op: "ajouterJournal", args: {}, garde: null });
  enfiler(m, { ...autreProjet, session: "s", op: "ajouterJournal", args: {}, garde: null });
  assert.deepEqual(enAttente(m, p).map((o) => o.uid), [a.uid]);
  assert.equal(enAttente(m, autreBff).length, 1);
  assert.equal(enAttente(m, autreProjet).length, 1);
  mettreDeCote(m, a.uid, { raison: "r" });
  assert.equal(conflitsEnAttente(m, autreBff).length, 0);
  assert.equal(conflitsEnAttente(m, autreProjet).length, 0);
  assert.equal(conflitsEnAttente(m, p).length, 1);
  // Un fichier laissé par une autre session (rang plus avancé) : le suivant passe après lui.
  const avance = `${Date.now() + 100000}-0007-${"a".repeat(32)}.json`;
  writeFileSync(join(m, "attente", avance), JSON.stringify({ uid: "a".repeat(32), ...p, op: "ajouterJournal", args: {}, garde: null }));
  const b = enfiler(m, { ...p, session: "s", op: "ajouterJournal", args: {}, garde: null });
  assert.deepEqual(enAttente(m, p).map((o) => o.uid), ["a".repeat(32), b.uid]);
  // Fichier illisible : écarté dans conflits/ avec son texte, jamais perdu.
  writeFileSync(join(m, "attente", `1-0000-${"b".repeat(32)}.json`), "{pas du json");
  assert.deepEqual(enAttente(m, p).map((o) => o.uid), ["a".repeat(32), b.uid]);
  const ill = conflitsEnAttente(m, p).find((c) => c.illisible);
  assert.equal(ill.raison, "fichier illisible");
  assert.equal(ill.brut, "{pas du json");
  assert.equal(existsSync(join(m, "attente", `1-0000-${"b".repeat(32)}.json`)), false);
  // Du JSON valide qui n'est pas une opération est aussi écarté ; abandonner() retrouve ces fichiers.
  writeFileSync(join(m, "attente", `2-0000-${"c".repeat(32)}.json`), "[]");
  writeFileSync(join(m, "attente", `3-0000-${"d".repeat(32)}.json`), JSON.stringify({ x: 1 }));
  writeFileSync(join(m, "attente", `4-0000-${"e".repeat(32)}.json`), JSON.stringify("texte"));
  assert.deepEqual(enAttente(m, p).map((o) => o.uid), ["a".repeat(32), b.uid]);
  const illisibles = conflitsEnAttente(m, p).filter((c) => c.illisible);
  // Un objet marqué illisible mais qui n'est pas une opération, déposé dans l'attente, est écarté lui aussi.
  writeFileSync(join(m, "attente", `5-0000-${"f".repeat(32)}.json`), JSON.stringify({ illisible: true }));
  assert.deepEqual(enAttente(m, p).map((o) => o.uid), ["a".repeat(32), b.uid]);
  assert.equal(existsSync(join(m, "attente", `5-0000-${"f".repeat(32)}.json`)), false);
  assert.equal(illisibles.length, 4);
  for (const c of conflitsEnAttente(m, p).filter((x) => x.illisible)) abandonner(m, c.uid);
  assert.equal(conflitsEnAttente(m, p).filter((c) => c.illisible).length, 0);
  rmSync(m, { recursive: true, force: true });
});

test("lancement par un lien symbolique : le script s'exécute (garde d'entrée sur chemins réels)", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "wl-lien-"));
  const lien = join(tmp, "current");
  try {
    symlinkSync(join(ROOT, "scripts"), lien, process.platform === "win32" ? "junction" : "dir");
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    if (e.code === "EPERM" || e.code === "EACCES") return t.skip("lien symbolique impossible ici");
    throw e;
  }
  try {
    const vide = mkdtempSync(join(tmpdir(), "wl-vide-"));
    const r = spawnSync(process.execPath, [join(lien, "worklog", "chantiers-tracker.mjs"), "--root", vide], { encoding: "utf8" });
    rmSync(vide, { recursive: true, force: true });
    // Sans la garde sur chemins réels, le script sortirait en silence avec le code 0.
    assert.equal(r.status, 2);
    assert.match(r.stderr, /introuvable/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("estLance : chemin réel, repli sur resolve si le fichier n'existe pas", () => {
  const fichier = fileURLToPath(import.meta.url);
  assert.equal(estLance(import.meta.url, fichier), true);
  assert.equal(estLance(import.meta.url, null), false);
  assert.equal(estLance(import.meta.url, join(tmpdir(), "absent-xyz.mjs")), false);
});

test("heures affichées à l'heure locale du poste (AAAA-MM-JJ HH:MM)", () => {
  const code = `import { date } from ${JSON.stringify(pathToFileURL(join(ROOT, "scripts", "worklog", "client.mjs")).href)};
console.log(date("2026-10-24T14:30:00Z")); console.log(date("2026-01-15T14:30:00.123Z")); console.log(date("n'importe quoi")); console.log(date(null) === "");`;
  const lancer = (tz) => spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { ...process.env, TZ: tz } }).stdout.trim().split("\n");
  assert.deepEqual(lancer("Europe/Paris"), ["2026-10-24 16:30", "2026-01-15 15:30", "n'importe quoi", "true"]);
  assert.deepEqual(lancer("UTC"), ["2026-10-24 14:30", "2026-01-15 14:30", "n'importe quoi", "true"]);
});
