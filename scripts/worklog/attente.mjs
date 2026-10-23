// File d'attente du poste (mode base) : quand le BFF est injoignable, une écriture n'est pas perdue, elle
// attend ici, dans l'ordre, et se rejoue à la prochaine commande. Module local, sans réseau, sans
// dépendance (node:fs et node:crypto seulement). Tout vit sous <maison>/attente/ :
//   <horodatage ms>-<compteur>-<uid>.json   une opération en attente (jamais de jeton dedans)
//   conflits/                               opérations mises de côté, à trancher par un humain
//   .verrou                                 un seul rejeu à la fois sur le poste
// Le verrou limite les rejeux simultanés sans le garantir à la milliseconde près (reprise d'un verrou périmé) :
// un double rejeu dans cette fenêtre étroite est rendu inoffensif par l'uid que le BFF retient.
// et les dernières données lues du BFF dans <maison>/copies/<cleProjet>.json.
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const VERROU_PERIME_MS = 120000;

const dossier = (maison) => join(maison, "attente");
const dossierConflits = (maison) => join(maison, "attente", "conflits");
const creer = (d) => { mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
const lireJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const attendreMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Écriture atomique : fichier temporaire dans le même dossier, puis renommage.
function ecrire(fichier, objet) {
  const tmp = `${fichier}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(objet, null, 2), { mode: 0o600 });
  renameSync(tmp, fichier);
}

const origine = (bff) => { try { return new URL(bff).origin; } catch { return String(bff); } };

// Nom de fichier sûr tiré de l'origine du BFF et du projet : 127.0.0.1_4180--demo.
// Attention : la clé ne voit que hôte:port et projet. Changer l'adresse du BFF en gardant le même hôte:port
// derrière une autre base exige d'abord une file d'attente vide et des copies effacées, sinon une opération
// ou une copie de l'ancienne base serait prise pour celle de la nouvelle.
export function cleProjet(bff, projet) {
  let hote = String(bff);
  try { const u = new URL(bff); hote = u.port ? `${u.hostname}_${u.port}` : u.hostname; } catch { /* origine illisible : on nettoie telle quelle */ }
  return `${hote}--${projet}`.replace(/[^A-Za-z0-9._-]/g, "_");
}

// Fichiers d'opérations d'un dossier, dans l'ordre (le nom est triable).
function fichiersOps(d) {
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".json")).sort();
}

// Une opération a au moins un uid et un nom d'opération ; tout autre JSON est un fichier illisible.
const estOperation = (o) => o !== null && typeof o === "object" && !Array.isArray(o) && typeof o.uid === "string" && typeof o.op === "string";

const memeProjet = (op, { bff, projet }) => op && origine(op.bff) === origine(bff) && op.projet === projet;

// Un fichier d'attente illisible n'est jamais perdu en silence : il part dans conflits/ avec son texte brut.
function ecarterIllisible(maison, fichier, brut) {
  const uid = fichier.replace(/\.json$/, ""); // retrouvable par abandonner()
  ecrire(join(creer(dossierConflits(maison)), fichier), { uid, fichier, illisible: true, raison: "fichier illisible", conflits: [], brut, le: new Date().toISOString() });
  unlinkSync(join(dossier(maison), fichier));
}

// `maison` non nul : dossier d'attente (les fichiers illisibles sont écartés) ; sinon dossier des conflits.
function lister(d, cible, maison = null) {
  const rendu = [];
  for (const fichier of fichiersOps(d)) {
    let brut;
    try { brut = readFileSync(join(d, fichier), "utf8"); } catch { continue; }
    let op = null;
    try { op = JSON.parse(brut); } catch { /* illisible */ }
    if (!estOperation(op) && (maison || !op?.illisible)) {
      if (maison) { try { ecarterIllisible(maison, fichier, brut); } catch { /* sera revu à la prochaine lecture */ } }
      continue;
    }
    if (op.illisible || memeProjet(op, cible)) rendu.push({ ...op, fichier });
  }
  return rendu;
}

function trouver(d, uid) {
  return fichiersOps(d).find((f) => f === `${uid}.json` || f.endsWith(`-${uid}.json`)) ?? null;
}

// Rang suivant d'après les noms déjà présents (et non un compteur du processus) : deux sessions qui
// enfilent dans la même milliseconde gardent leur ordre d'arrivée, au mieux.
function prochainRang(d) {
  let ms = Date.now(), n = 0;
  for (const f of fichiersOps(d)) {
    const m = f.match(/^(\d+)-(\d{4})-/);
    if (!m) continue;
    const [fm, fn] = [Number(m[1]), Number(m[2])];
    if (fm > ms || (fm === ms && fn >= n)) { ms = fm; n = fn + 1; }
  }
  if (n > 9999) { ms += 1; n = 0; }
  return { ms, n };
}

export function enfiler(maison, { bff, projet, session, op, args, garde }) {
  const d = creer(dossier(maison));
  const uid = randomUUID().replaceAll("-", "");
  const { ms, n } = prochainRang(d);
  const fichier = `${ms}-${String(n).padStart(4, "0")}-${uid}.json`;
  ecrire(join(d, fichier), { uid, bff, projet, session, op, args, garde, quand: new Date().toISOString() });
  return { uid, enAttente: lister(d, { bff, projet }, maison).length };
}

export function enAttente(maison, cible) {
  return lister(dossier(maison), cible, maison).map(({ uid, fichier, quand, session, op, args, garde }) => ({ uid, fichier, quand, session, op, args, garde }));
}

export function retirer(maison, uid) {
  const f = trouver(dossier(maison), uid);
  if (f) unlinkSync(join(dossier(maison), f));
}

// Déplace l'opération dans attente/conflits/ avec la raison, les conflits relevés et la date.
export function mettreDeCote(maison, uid, { raison, conflits = [] }) {
  const f = trouver(dossier(maison), uid);
  if (!f) return;
  const op = lireJson(join(dossier(maison), f));
  if (!op) return;
  ecrire(join(creer(dossierConflits(maison)), f), { ...op, raison, conflits, le: new Date().toISOString() });
  unlinkSync(join(dossier(maison), f));
}

export function conflitsEnAttente(maison, cible) {
  return lister(dossierConflits(maison), cible);
}

export function abandonner(maison, uid) {
  const f = trouver(dossierConflits(maison), uid);
  if (f) unlinkSync(join(dossierConflits(maison), f));
}

// Un seul rejeu à la fois : on attend le verrou (plutôt que de passer devant, ce qui enverrait une écriture
// avant des opérations plus anciennes). null si le verrou reste pris au-delà de `attendre` ms.
export async function avecVerrou(maison, fn, { attendre = 30000 } = {}) {
  const fichier = join(creer(dossier(maison)), ".verrou");
  const jeton = `${process.pid}-${randomUUID()}`; // identifie le détenteur : on ne retire que son propre verrou
  const etat = { pris: null }; // verrou d'un autre emporté par erreur, à remettre
  const fin = Date.now() + attendre;
  nettoyerPerimes(dirname(fichier));
  for (;;) {
    try {
      writeFileSync(fichier, jeton, { flag: "wx", mode: 0o600 });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (reprendreSiPerime(fichier, etat)) continue;
      if (Date.now() >= fin) { remettre(fichier, etat); abandonnerPris(etat); return null; }
      await attendreMs(100);
    }
  }
  try {
    // `fn` reçoit un rappel à appeler après chaque étape d'un long rejeu : sans lui, un verrou tenu plus de 120 s
    // serait pris pour périmé par un autre processus.
    return await fn(() => rafraichirVerrou(maison, jeton));
  } finally {
    // Le verrou a pu être repris par un autre (périmé) : n'est retiré que celui qui porte notre jeton.
    try { if (readFileSync(fichier, "utf8") === jeton) unlinkSync(fichier); } catch { /* absent : normal */ }
    remettre(fichier, etat); // après avoir libéré le nôtre, sinon il bloquerait la remise
    abandonnerPris(etat); // personne ne pourra plus réessayer : on ne laisse rien traîner
  }
}

// Renouvelle l'horodatage du verrou, seulement s'il porte encore notre jeton (jamais celui d'un autre).
export function rafraichirVerrou(maison, jeton) {
  const fichier = join(dossier(maison), ".verrou");
  try {
    if (readFileSync(fichier, "utf8") !== jeton) return false;
    const t = new Date();
    utimesSync(fichier, t, t);
    return true;
  } catch { return false; }
}

// Fichier emporté qui n'a pu être remis et que plus personne ne remettra : supprimé (l'uid du BFF couvre le reste).
function abandonnerPris(etat) {
  if (!etat.pris) return;
  try { unlinkSync(etat.pris); } catch { /* déjà parti */ }
  etat.pris = null;
}

// Restes de verrous emportés (.verrou.<uuid>.perime) de plus de 120 s, laissés par un processus interrompu.
function nettoyerPerimes(d) {
  try {
    for (const n of readdirSync(d)) {
      if (!n.startsWith(".verrou.") || !n.endsWith(".perime")) continue;
      try { if (perime(join(d, n))) unlinkSync(join(d, n)); } catch { /* déjà parti */ }
    }
  } catch { /* dossier illisible : sans conséquence ici */ }
}

const perime = (f) => Date.now() - statSync(f).mtimeMs > VERROU_PERIME_MS;

// Remet en place un verrou emporté par erreur. Impossible si .verrou existe déjà (son détenteur n'y retrouvera
// pas son jeton et le tiendra pour normal) : le fichier emporté n'est alors supprimé que s'il est périmé,
// sinon on le garde pour un nouvel essai au tour suivant. Une autre erreur est laissée à l'appelant (attente).
function remettre(fichier, etat) {
  if (!etat.pris) return;
  try {
    linkSync(etat.pris, fichier);
    unlinkSync(etat.pris);
    etat.pris = null;
  } catch (e) {
    if (e.code === "ENOENT") { etat.pris = null; return; }
    if (e.code !== "EEXIST") return;
    try { if (perime(etat.pris)) { unlinkSync(etat.pris); etat.pris = null; } } catch (e2) { if (e2.code === "ENOENT") etat.pris = null; }
  }
}

// Vrai si on peut réessayer tout de suite : verrou disparu, ou périmé et retiré par nous. Le retrait passe par un
// renommage vers un nom unique, puis on vérifie que le fichier emporté porte bien le jeton vu périmé. Ce n'est
// pas atomique : un autre candidat peut emporter un verrou neuf entre notre lecture et notre renommage ; on le
// remet (remettre) et un double rejeu dans cette fenêtre étroite reste couvert par l'uid du BFF.
function reprendreSiPerime(fichier, etat) {
  if (etat.pris) { remettre(fichier, etat); return false; }
  let jetonVu;
  try {
    if (!perime(fichier)) return false;
    jetonVu = readFileSync(fichier, "utf8");
  } catch (e) { return e.code === "ENOENT"; }
  const pris = `${fichier}.${randomUUID()}.perime`;
  try { renameSync(fichier, pris); } catch (e) { return e.code === "ENOENT"; }
  try {
    if (readFileSync(pris, "utf8") === jetonVu) { unlinkSync(pris); return true; }
  } catch (e) { if (e.code === "ENOENT") return true; }
  etat.pris = pris; // ce n'était pas le verrou périmé : on le remet
  remettre(fichier, etat);
  return false;
}

// Ids des objets qu'une opération modifie (pour repérer un conflit avec l'historique du BFF).
export function objetsTouches(op, args) {
  if (["modifierTache", "modifierChantier", "cloreChantier", "creerTache", "creerChantier"].includes(op)) return [args?.id];
  if (op === "session") return [...new Set(["statuts", "suivis", "lots", "rattachements"].flatMap((k) => Object.keys(args?.[k] ?? {})))];
  return [];
}

// Dernière lecture du BFF pour ce projet, pour travailler hors ligne.
const fichierCopie = (maison, cible) => join(maison, "copies", `${cleProjet(cible.bff, cible.projet)}.json`);

export function garderCopie(maison, cible, data) {
  creer(join(maison, "copies"));
  ecrire(fichierCopie(maison, cible), { quand: new Date().toISOString(), version: data?.meta?.version ?? null, data });
}

// La version de la copie est celle de la dernière lecture complète : jamais avancée par une écriture.
export function lireCopie(maison, cible) {
  return lireJson(fichierCopie(maison, cible));
}
