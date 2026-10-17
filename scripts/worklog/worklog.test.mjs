// npm test : lecture des deux sources, fusion, écriture d'une session, cohérence,
// enregistrement du tableau (patch.mjs et serveur), relevé de code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applySession, incoherences, lotIds, marqueRe, merge, parseBacklog, parseChantiers, parseLots, specRe } from "./chantiers-tracker.mjs";
import { applyPatch } from "./patch.mjs";
import { countCases, isTest } from "./code-stats.mjs";
import { createTracker } from "./serve.mjs";
import { loadConfig } from "./config.mjs";

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
