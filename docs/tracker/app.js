/* Tableau de suivi des chantiers.
 * Lit chantiers.json (construit par scripts/worklog/chantiers-tracker.mjs, npm run chantiers) ;
 * son reglage (nom du projet, couleur, mot de la decision) arrive dans meta.ui. N'enregistre, via save.php
 * (WAMP, PHP) ou scripts/worklog/serve.mjs (npm run tracker), qui parlent le meme protocole,
 * que ce que le tableau pilote : priorite / rang / note des chantiers, statut / priorite /
 * rattachement / lot / note des taches. L'etat d'un chantier vient de docs/CHANTIERS.md ;
 * ses lots viennent de la section « Decoupage » de sa spec (une tache y est
 * rattachee quand la ligne du lot la nomme, `lot_spec`) ; le choix fait ici (`lot`) prime.
 * Accessibilite : chaque chantier s'ouvre par un vrai lien, le glisser-deposer a son
 * equivalent clavier (boutons Monter / Descendre), le panneau est une boite de dialogue
 * modale (le reste de la page est rendu inerte, le focus revient au declencheur).
 */
(() => {
  'use strict';
  const PRIOS = ['P0', 'P1', 'P2', 'P3'];
  const COLS = { pas_commence: 'Pas commencé', en_cours: 'En cours', bloque: 'Bloqué (décision)', termine: 'Terminé', clos: 'Clos', abandonne: 'Abandonné' };
  const STATUTS = { a_faire: 'À faire', en_cours: 'En cours', a_verifier: 'À vérifier', fait: 'Fait', abandonne: 'Abandonné' };
  const OPEN = (c) => !['termine', 'clos', 'abandonne'].includes(c.colonne);
  const NEW_WIN = '<span class="sr"> (nouvelle fenêtre)</span>';

  const $ = (s, r = document) => r.querySelector(s);
  // Plusieurs tableaux sur le meme serveur (localhost/projet-a, localhost/projet-b) : un
  // stockage par chemin, sinon les filtres de l'un s'appliqueraient a l'autre.
  const KEY = 'worklog:' + location.pathname + ':';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(KEY + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
  };

  let data = null;
  let view = store.get('view', 'prio');
  let sort = store.get('sort', { k: 'id', d: 1 });
  let saveTimer = null;
  let saving = false;
  // Ce que CETTE page a modifie, et la valeur que le fichier portait au chargement.
  // On n'envoie que ca (voir save.php) : une charge complete, envoyee par une page
  // ouverte depuis une heure, reecrirait avec des valeurs perimees les statuts que
  // `npm run chantiers` vient d'ecrire pour une session.
  const dirty = { chantiers: new Map(), items: new Map() };   // id -> Set(champs)
  let base = { chantiers: new Map(), items: new Map() };      // id -> {champ: valeur au chargement}
  let pollTimer = null;
  let opener = null;
  const byId = () => Object.fromEntries(data.chantiers.map((c) => [c.id, c]));

  // ---------- utilitaires ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const md = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\s][^*]*)\*/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    // Une cellule de tableau Markdown n'a pas de retour a la ligne : `<br>` est la
    // convention (GitHub la rend aussi). esc() l'a echappe, on ne rend que lui.
    .replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  const plain = (s) => String(s ?? '').replace(/[`*~]/g, '');
  const pill = (cls, txt, sr = '') => `<span class="pill ${esc(cls)}">${sr ? `<span class="sr">${esc(sr)} </span>` : ''}${esc(txt)}</span>`;
  const prio = (p) => pill(p, p, 'priorité');
  const itemsOf = (cid) => data.items.filter((i) => i.chantier === cid);
  const lotsOf = (cid) => (byId()[cid] && byId()[cid].lots) || [];
  const effLot = (i) => i.lot || i.lot_spec || null;
  const LOT_ETATS = { fait: 'Fait', en_cours: 'En cours', a_faire: 'À faire', vide: 'Aucune tâche' };
  function lotEtat(its) {  // calcule, jamais saisi : un lot est ce que disent ses taches
    const live = its.filter((i) => i.statut !== 'abandonne');
    if (!live.length) return 'vide';
    if (live.every((i) => i.statut === 'fait')) return 'fait';
    return live.some((i) => i.statut !== 'a_faire') ? 'en_cours' : 'a_faire';
  }
  const lotLabel = (l) => `Lot ${l.id} · ${l.titre}`;
  const lotsOuverts = new Set();  // lots faits rouverts a la main (memoire de la page seulement)
  const options = (map, cur) => Object.entries(map).map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const prioOptions = (cur) => PRIOS.map((p) => `<option${p === cur ? ' selected' : ''}>${p}</option>`).join('');

  function progress(cid) {
    const its = itemsOf(cid);
    const n = { total: its.length, fait: 0, en_cours: 0, a_verifier: 0, abandonne: 0 };
    its.forEach((i) => { if (n[i.statut] !== undefined) n[i.statut] += 1; });
    n.base = n.total - n.abandonne;
    n.pct = n.base ? Math.round((n.fait / n.base) * 100) : 0;
    return n;
  }
  function bar(n) {  // decoratif : le meme chiffre est toujours ecrit en texte a cote
    if (!n.base) return '';
    const w = (k) => ((n[k] / n.base) * 100).toFixed(1);
    return `<div class="bar" aria-hidden="true"><i class="s-fait" style="width:${w('fait')}%"></i><i class="s-a_verifier" style="width:${w('a_verifier')}%"></i><i class="s-en_cours" style="width:${w('en_cours')}%"></i></div>`;
  }
  const progText = (n) => `${n.fait}/${n.base}<span class="sr"> tâches faites</span>`;
  const UI = () => (data && data.meta && data.meta.ui) || {};
  function docLinks(txt) {
    const paths = [...String(txt || '').matchAll(/`([^`\s]+\.(?:md|txt|json|ya?ml|html|sql|[cm]?js|ts|py|php|ps1|sh|conf))`/g)].map((m) => m[1]);
    return [...new Set(paths)].map((p) => {
      // Chemin relatif a la racine du projet : lien ; chemin absolu ou remontant : texte seul.
      const href = !/^(?:[a-z]+:|\/|\.\.)/i.test(p) ? (UI().racine ?? '../../') + p : null;
      return href ? `<a href="${esc(href)}" target="_blank" rel="noopener"><svg aria-hidden="true"><use href="#i-doc"/></svg>${esc(p)}${NEW_WIN}</a>` : `<code>${esc(p)}</code>`;
    }).join('') || md(txt);
  }

  // ---------- filtres ----------
  const F = {
    q: $('#q'), prio: $('#fPrio'), dom: $('#fDom'), statut: $('#fStatut'), ch: $('#fCh'), lot: $('#fLot'), avecTaches: $('#fAvecTaches'), decision: $('#fDecision'),
  };
  function restoreFilters() {
    const f = store.get('filters', {});
    Object.entries(F).forEach(([k, el]) => { if (f[k] !== undefined) el[el.type === 'checkbox' ? 'checked' : 'value'] = f[k]; });
  }
  function saveFilters() {
    store.set('filters', Object.fromEntries(Object.entries(F).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value])));
  }
  const q = () => F.q.value.trim().toLowerCase();
  function chMatch(c) {
    if (F.prio.value && c.priorite !== F.prio.value) return false;
    if (F.avecTaches.checked && !itemsOf(c.id).length) return false;
    const s = q();
    return !s || [c.id, c.titre, c.prochaine_action, c.decisions, c.note].join(' ').toLowerCase().includes(s);
  }
  function itMatch(i) {
    if (F.prio.value && i.priorite !== F.prio.value) return false;
    if (F.dom.value && i.domaine !== F.dom.value) return false;
    if (F.statut.value && i.statut !== F.statut.value) return false;
    if (F.ch.value === '__none' ? i.chantier : F.ch.value && i.chantier !== F.ch.value) return false;
    if (F.lot.value === '__none') { if (!i.chantier || !lotsOf(i.chantier).length || effLot(i)) return false; }
    else if (F.lot.value) { const [cid, lid] = F.lot.value.split('|'); if (i.chantier !== cid || effLot(i) !== lid) return false; }
    if (F.decision.checked && !i.decision) return false;
    const s = q();
    return !s || [i.id, i.titre, i.constat, i.attendu, i.note, i.chantier].join(' ').toLowerCase().includes(s);
  }

  // ---------- rendu ----------
  function renderKpis() {
    const open = data.chantiers.filter(OPEN);
    const all = { base: 0, fait: 0, en_cours: 0, a_verifier: 0 };
    data.items.forEach((i) => { if (i.statut !== 'abandonne') all.base += 1; if (all[i.statut] !== undefined) all[i.statut] += 1; });
    const pct = all.base ? Math.round((all.fait / all.base) * 100) : 0;
    const k = (v, l, cls = '') => `<li class="kpi ${cls}"><b>${v}</b><span>${l}</span></li>`;
    $('#kpis').innerHTML = [
      k(open.length, 'chantiers ouverts'),
      k(open.filter((c) => c.colonne === 'en_cours').length, 'en cours'),
      k(open.filter((c) => c.colonne === 'bloque').length, 'bloqués (décision)'),
      k(open.filter((c) => c.priorite === 'P0').length, 'chantiers P0 ouverts'),
      `<li class="kpi wide"><b>${all.fait} / ${all.base} · ${pct} %</b><span>tâches faites (${all.a_verifier} à vérifier, ${all.en_cours} en cours)</span>${bar({ ...all, abandonne: 0 })}</li>`,
      k(data.items.filter((i) => i.decision && !['fait', 'abandonne'].includes(i.statut)).length, UI().marqueKpi || 'décisions attendues'),
    ].join('');
  }

  function row(c, pos, count) {
    const n = progress(c.id);
    const t = esc(plain(c.titre));
    return `<div class="row" draggable="true" data-id="${esc(c.id)}">
      <svg class="grip" aria-hidden="true"><use href="#i-grip"/></svg>
      <span class="mono">${esc(c.id)}</span>
      <span class="prio-cell">${prio(c.priorite)}</span>
      <span class="title"><a href="#${esc(c.id)}"><span class="sr">${esc(c.id)} : </span>${t}</a><small>${esc(plain(c.note || c.prochaine_action))}</small></span>
      <span class="etat">${pill(c.colonne, COLS[c.colonne] || c.colonne, 'état')}${c.orphelin ? ' ' + pill('orphan', 'orphelin') : ''}</span>
      <span class="prog">${n.total ? `${bar(n)}${progText(n)}` : '<span aria-hidden="true">—</span>'}</span>
      <span class="moves">
        <button type="button" data-move="-1"${pos === 0 ? ' disabled' : ''} aria-label="Monter ${esc(c.id)} (rang ${pos + 1} sur ${count} en ${c.priorite})"><svg aria-hidden="true"><use href="#i-up"/></svg></button>
        <button type="button" data-move="1"${pos === count - 1 ? ' disabled' : ''} aria-label="Descendre ${esc(c.id)} (rang ${pos + 1} sur ${count} en ${c.priorite})"><svg aria-hidden="true"><use href="#i-down"/></svg></button></span>
    </div>`;
  }

  function renderPrio() {
    const open = data.chantiers.filter(OPEN).filter(chMatch).sort((a, b) => a.rang - b.rang);
    return PRIOS.map((p) => {
      const list = open.filter((c) => c.priorite === p);
      return `<section class="group" data-prio="${p}" aria-labelledby="g-${p}"><h2 id="g-${p}">${prio(p)} ${list.length} chantier(s)</h2>
        ${list.map((c, k) => row(c, k, list.length)).join('') || `<div class="drop-hint" data-prio="${p}">Aucun chantier en ${p}. Glisser un chantier ici, ou changer sa priorité dans sa fiche.</div>`}</section>`;
    }).join('') + '<p class="count">Ordonner : glisser-déposer, ou boutons Monter / Descendre (clavier). La priorité se change aussi dans la fiche du chantier. L\'état vient de <code>docs/CHANTIERS.md</code> (relancer <code>npm run chantiers</code> après une mise à jour).</p>';
  }

  function renderBoard() {
    const cols = ['pas_commence', 'en_cours', 'bloque', 'termine'];
    const list = data.chantiers.filter(chMatch);
    const ord = (a, b) => PRIOS.indexOf(a.priorite) - PRIOS.indexOf(b.priorite) || a.rang - b.rang;
    return `<div class="board">${cols.map((col) => {
      const cs = list.filter((c) => c.colonne === col).sort(ord);
      return `<section class="col" aria-labelledby="c-${col}"><h2 id="c-${col}"><span>${COLS[col]}</span><span>${cs.length}</span></h2>${cs.map((c) => {
        const n = progress(c.id);
        return `<article class="card ${esc(c.priorite)}" data-id="${esc(c.id)}">
          <div class="meta"><span class="mono">${esc(c.id)}</span>${prio(c.priorite)}${n.total ? `<span class="prog">${progText(n)}</span>` : ''}</div>
          <a href="#${esc(c.id)}"><span class="sr">${esc(c.id)} : </span>${esc(plain(c.titre))}</a>${n.total ? bar(n) : ''}</article>`;
      }).join('')}</section>`;
    }).join('')}</div>`;
  }

  function renderItems() {
    const list = data.items.filter(itMatch);
    const k = sort.k;
    const val = (i) => (k === 'priorite' ? PRIOS.indexOf(i.priorite) : k === 'ligne' ? i.ligne
      : k === 'lot' ? `${i.chantier || 'zz'}|${String(effLot(i) || 'z').padStart(3, '0')}` : String(i[k] ?? 'zz'));
    const lotCell = (i) => {
      const ls = i.chantier ? lotsOf(i.chantier) : [];
      if (!ls.length) return '<span class="muted" title="Sa spec ne découpe pas en lots">—</span>';
      const cur = effLot(i);
      const none = i.lot_spec ? `suivre la spec (lot ${esc(i.lot_spec)})` : '— sans lot';
      return `<select data-f="lot" aria-label="Lot de ${esc(i.id)}"><option value="">${none}</option>${ls.map((l) => `<option value="${esc(l.id)}"${l.id === cur ? ' selected' : ''}>${esc(lotLabel(l).slice(0, 48))}</option>`).join('')}</select>`;
    };
    list.sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * sort.d);
    const chOpts = (cur) => `<option value="">— aucun —</option>` + data.chantiers.map((c) => `<option value="${esc(c.id)}"${c.id === cur ? ' selected' : ''}>${esc(c.id)}</option>`).join('');
    const th = (key, l) => {
      const s = sort.k === key ? (sort.d > 0 ? 'ascending' : 'descending') : 'none';
      return `<th scope="col" aria-sort="${s}"><button type="button" data-sort="${key}">${l}<span class="sr">, trier</span><span aria-hidden="true">${s === 'none' ? '' : s === 'ascending' ? ' ▲' : ' ▼'}</span></button></th>`;
    };
    return `<p class="count" role="status">${list.length} tâche(s) sur ${data.items.length}</p>
      <div class="table-wrap"><table class="items tasks"><caption class="sr">Tâches, filtrées</caption>
      <thead><tr>${th('id', 'ID')}${th('priorite', 'P')}${th('titre', 'Tâche')}${th('statut', 'Statut')}${th('chantier', 'Chantier')}${th('lot', 'Lot')}<th scope="col" class="c-note">Note</th></tr></thead><tbody>
      ${list.map((i) => `<tr class="st-${esc(i.statut)}" data-item="${esc(i.id)}">
        <th scope="row" class="c-id"><a href="#item/${esc(i.id)}" class="mono">${esc(i.id)}</a></th>
        <td class="c-p"><select data-f="priorite" aria-label="Priorité de ${esc(i.id)}">${prioOptions(i.priorite)}</select></td>
        <td class="t">${esc(plain(i.titre))} ${i.decision ? pill('decision', UI().marque || 'DÉCISION', 'attend') : ''}<small>${esc(i.section)}</small>${i.suivi ? `<small class="suivi">${esc(i.suivi)}</small>` : ''}</td>
        <td class="c-st"><select data-f="statut" aria-label="Statut de ${esc(i.id)}">${options(STATUTS, i.statut)}</select></td>
        <td class="c-ch" data-label="Chantier"><select data-f="chantier" aria-label="Chantier de ${esc(i.id)}">${chOpts(i.chantier)}</select></td>
        <td class="c-lot" data-label="Lot">${lotCell(i)}</td>
        <td class="c-note" data-label="Note"><input class="note-in" data-f="note" value="${esc(i.note)}" aria-label="Note sur ${esc(i.id)}"></td></tr>`).join('')}
      </tbody></table></div>`;
  }

  function renderDone() {
    const list = data.chantiers.filter((c) => !OPEN(c)).filter(chMatch)
      .sort((a, b) => String(b.clos_le || b.maj).localeCompare(String(a.clos_le || a.maj)));
    return list.map((c) => `<div class="row done" data-id="${esc(c.id)}">
      <span class="mono">${esc(c.id)}</span>
      <span class="title"><a href="#${esc(c.id)}"><span class="sr">${esc(c.id)} : </span>${esc(plain(c.titre))}</a><small>${esc(plain(c.reste || c.prochaine_action))}</small></span>
      <span>${pill(c.colonne, COLS[c.colonne], 'état')}</span><span class="mono">${esc(c.clos_le || c.maj)}</span></div>`).join('') || '<p class="empty">Rien.</p>';
  }

  // ---------- onglet Code ----------
  // Les statistiques vivent dans un AUTRE fichier, local et hors git, ecrit par
  // `scripts/worklog/code-stats.mjs` (npm run code:stats), lance a la main, par une tache planifiee
  // Windows (install-code-stats-task.ps1) ou par cron.
  // Il est lu au premier affichage de l'onglet, et lui seul : le tableau des chantiers ne
  // doit pas dependre de sa presence, ni payer sa lecture quand on ne le regarde pas.
  let code = null;   // null = jamais demande ; {attente} pendant la lecture ; sinon le JSON, ou {erreur}
  async function loadCode() {
    code = { attente: true };
    try {
      const r = await fetch('code_stats.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      code = await r.json();
    } catch (e) { code = { erreur: e.message }; }
    if (view === 'code') render();
  }

  const num = (n) => String(n).replace(/\B(?=(\d{3})+$)/g, ' ');
  function delta(a, b) {
    if (b === null || b === undefined) return '<span class="muted">—</span>';
    const d = a - b;
    if (!d) return '<span class="muted">=</span>';
    return `<span class="${d > 0 ? 'd-up' : 'd-down'}">${d > 0 ? '+' : '−'}${num(Math.abs(d))}</span>`;
  }

  function renderCode() {
    if (code === null) { loadCode(); return '<p class="empty">Lecture de <code>code_stats.json</code>…</p>'; }
    if (code.attente) return '<p class="empty">Lecture de <code>code_stats.json</code>…</p>';
    const rs = (code.releves || []);
    if (code.erreur || !rs.length) {
      return `<p class="empty">Aucun relevé de code (${esc(code.erreur || 'fichier vide')}).
        Relevé immédiat : <code>npm run code:stats</code>, puis recharger la page. Relevé automatique : tâche planifiée Windows
        (<code>powershell -ExecutionPolicy Bypass -File scripts/worklog/install-code-stats-task.ps1</code>) ou ligne cron (voir le README).</p>`;
    }
    const groupes = code.groupes || [];
    const cur = rs[rs.length - 1];
    const prev = rs.length > 1 ? rs[rs.length - 2] : null;
    const mes = (r, cle) => (r && r.mesures && r.mesures[cle]) || null;
    const total = (r, prod) => groupes.filter((g) => g.production === prod)
      .reduce((s, g) => s + ((mes(r, g.cle) || {}).brut || 0), 0);

    const ligne = (g) => {
      const a = mes(cur, g.cle);
      const cls = g.production ? '' : ' class="hors-prod"';
      if (!a) {
        return `<tr${cls}><th scope="row">${esc(g.libelle)}</th><td colspan="5" class="muted">dépôt absent au relevé</td></tr>`;
      }
      const b = mes(prev, g.cle);
      const cas = a.cas === undefined ? '<span class="muted">—</span>'
        : `${num(a.cas)}${b && b.cas !== undefined && b.cas !== a.cas ? ` ${delta(a.cas, b.cas)}` : ''}`;
      return `<tr${cls}><th scope="row">${esc(g.libelle)}</th>
        <td class="n">${num(a.brut)}</td><td class="n hm">${num(a.net)}</td><td class="n hm">${num(a.fichiers)}</td>
        <td class="n">${cas}</td>
        <td class="n">${b ? delta(a.brut, b.brut) : '<span class="muted">—</span>'}</td></tr>`;
    };
    const totalCas = (r) => groupes.reduce((s, g) => s + ((mes(r, g.cle) || {}).cas || 0), 0);
    const somme = (prod, libelle) => `<tr class="somme${prod ? '' : ' hors-prod'}"><th scope="row">${libelle}</th>
      <td class="n">${num(total(cur, prod))}</td><td class="n hm"></td><td class="n hm"></td>
      <td class="n">${prod ? '' : num(totalCas(cur))}</td>
      <td class="n">${prev ? delta(total(cur, prod), total(prev, prod)) : '<span class="muted">—</span>'}</td></tr>`;

    const hist = rs.slice().reverse().map((r, k, arr) => {
      const p = arr[k + 1];
      return `<li><span class="mono">${esc(r.date)}</span> ${num(total(r, true))} lignes de production
        ${p ? delta(total(r, true), total(p, true)) : ''}</li>`;
    }).join('');

    const heure = (cur.genere_le || '').slice(11, 16);
    return `<p class="count" role="status">Relevé du ${esc(cur.date)}${heure ? ` à ${esc(heure)}` : ''}${prev ? `, comparé à celui du ${esc(prev.date)}` : ' (premier relevé, aucune comparaison)'}.
      <code>brut</code> = toutes les lignes, <code>non vides</code> = hors lignes blanches ; les commentaires sont comptés dans les deux.
      <code>Cas de test</code> compte les déclarations (<code>it(…)</code>, <code>test(…)</code>, <code>def test_…</code>, <code>func Test…</code>) : c'est un plancher, la paramétrisation en produit davantage à l'exécution.
      Relevé immédiat : <code>npm run code:stats</code> ; un relevé par jour, rejouer le même jour le remplace.</p>
      <div class="table-wrap"><table class="items stats"><caption class="sr">Lignes de code par groupe</caption>
      <thead><tr><th scope="col">Groupe</th><th scope="col" class="n">Brut</th><th scope="col" class="n hm">Non vides</th>
        <th scope="col" class="n hm">Fichiers</th><th scope="col" class="n">Cas de test</th><th scope="col" class="n">Δ brut</th></tr></thead><tbody>
      ${groupes.filter((g) => g.production).map(ligne).join('')}
      ${somme(true, 'Total production')}
      ${groupes.filter((g) => !g.production).map(ligne).join('')}
      ${somme(false, 'Total tests')}
      </tbody></table></div>
      <section class="group"><h2>Historique</h2><ul class="hist">${hist}</ul></section>`;
  }

  function render() {
    document.body.dataset.view = view;
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
    renderKpis();
    const v = { prio: renderPrio, board: renderBoard, items: renderItems, done: renderDone, code: renderCode }[view] || renderPrio;
    $('#view').innerHTML = v();
  }

  // ---------- panneau (boite de dialogue modale) ----------
  const OUTSIDE = ['.top', '#kpis', '.tabs', '#filters', '#view', '.skip'];
  const isOpen = () => $('#drawer').classList.contains('open');
  function openDrawer(html, id, title) {
    if (!isOpen()) opener = document.activeElement;
    $('#drId').textContent = id;
    $('#drTitle').textContent = title;
    $('#drBody').innerHTML = html;
    $('#drawer').classList.add('open');
    $('#drawer').removeAttribute('aria-hidden');
    OUTSIDE.forEach((s) => { const n = $(s); if (n) n.inert = true; });
    $('#scrim').hidden = false;
    $('#drClose').focus();
  }
  function closeDrawer() {
    if (!isOpen()) return;
    $('#drawer').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
    OUTSIDE.forEach((s) => { const n = $(s); if (n) n.inert = false; });
    $('#scrim').hidden = true;
    if (location.hash) history.replaceState(null, '', location.pathname);
    if (opener && document.contains(opener)) opener.focus();
    opener = null;
  }
  function showChantier(id) {
    const c = byId()[id];
    if (!c) return;
    const its = itemsOf(id);
    const n = progress(id);
    const sec = (t, h) => (h ? `<h3>${t}</h3><div class="txt">${h}</div>` : '');
    openDrawer(`
      <div class="ctrl">${pill(c.colonne, COLS[c.colonne], 'état')}
        <label>Priorité <select data-ch="priorite">${prioOptions(c.priorite)}</select></label>
        <label>Rang <input data-ch="rang" type="number" min="1" value="${esc(c.rang)}" style="width:6rem"></label>
        ${n.total ? `<div class="prog" style="min-width:12rem">${bar(n)} ${n.pct} %<span class="sr"> des tâches faites</span></div>` : ''}</div>
      ${sec('État (CHANTIERS.md)', md(c.etat))}
      ${sec('Prochaine action', md(c.prochaine_action))}
      ${sec('Décisions en attente', c.decisions && c.decisions !== '—' ? md(c.decisions) : '')}
      ${sec('Preuve', md(c.preuve))}${sec('Ce qui en reste', md(c.reste))}
      ${sec('Docs', `<div class="docs">${docLinks(c.doc || c.preuve)}</div>`)}
      ${sec('Dernière MAJ', esc(c.clos_le || c.maj))}
      <h3><label for="drNote">Ma note</label></h3><textarea id="drNote" data-ch="note">${esc(c.note)}</textarea>
      ${its.length ? `<h3>Tâches (${its.length})</h3>${lotGroups(c, its)}` : ''}`,
    c.id, plain(c.titre));
    $('#drBody').dataset.ch = c.id;
  }
  function lotGroups(c, its) {
    const li = (i) => `<li data-item="${esc(i.id)}">
        <a href="#item/${esc(i.id)}" class="mono">${esc(i.id)}</a>${prio(i.priorite)}<span>${esc(plain(i.titre))}${i.suivi ? `<small class="suivi">${esc(i.suivi)}</small>` : ''}</span>
        <select data-f="statut" aria-label="Statut de ${esc(i.id)}">${options(STATUTS, i.statut)}</select></li>`;
    const ls = c.lots || [];
    if (!ls.length) return `<p class="muted">Sa spec ne découpe pas encore en lots.</p><ul class="mini">${its.map(li).join('')}</ul>`;
    const groups = ls.map((l) => ({ l, list: its.filter((i) => effLot(i) === l.id) }));
    const rest = its.filter((i) => !effLot(i) || !ls.some((l) => l.id === effLot(i)));
    // Un lot fait a 100 % se replie ; celui qu'on a rouvert le reste d'un rendu a l'autre.
    const lot = (key, title, list, texte) => {
      const n = { total: list.length, fait: 0, en_cours: 0, a_verifier: 0, abandonne: 0 };
      list.forEach((i) => { if (n[i.statut] !== undefined) n[i.statut] += 1; });
      n.base = n.total - n.abandonne;
      const et = lotEtat(list);
      const open = et !== 'fait' || lotsOuverts.has(key);
      return `<details class="lot" data-lot="${esc(key)}" data-etat="${et}"${open ? ' open' : ''}><summary class="lot-head"><h4>${esc(title)}</h4>${pill('lot-' + et, LOT_ETATS[et], 'état du lot')}
        ${n.base ? `<span class="prog">${bar(n)}${progText(n)}</span>` : ''}</summary>${texte ? `<p class="lot-txt">${md(texte)}</p>` : ''}${list.length ? `<ul class="mini">${list.map(li).join('')}</ul>` : ''}</details>`;
    };
    return groups.map(({ l, list }) => lot(`${c.id}|${l.id}`, lotLabel(l), list, l.texte)).join('')
      + (rest.length ? lot(`${c.id}|`, 'Sans lot', rest, 'Tâches que la spec ne rattache à aucun lot : à placer (colonne Lot de la liste des tâches).') : '');
  }
  function showItem(id) {
    const i = data.items.find((x) => x.id === id);
    if (!i) return;
    const c = i.chantier && byId()[i.chantier];
    openDrawer(`
      <div class="ctrl" data-item="${esc(i.id)}">${prio(i.priorite)} ${i.decision ? pill('decision', UI().marque || 'DÉCISION', 'attend') : ''}
        <label>Statut <select data-f="statut">${options(STATUTS, i.statut)}</select></label>
        <label>Priorité <select data-f="priorite">${prioOptions(i.priorite)}</select></label></div>
      ${i.suivi ? `<h3>Suivi des sessions</h3><div class="txt">${esc(i.suivi)}</div>` : ''}
      <h3>Section du backlog</h3><div class="txt">${esc(i.section)} · <a href="${esc(UI().backlog || '../chantiers/backlog.md')}" target="_blank" rel="noopener">backlog, ligne ${esc(i.ligne)}${NEW_WIN}</a></div>
      <h3>Constat</h3><div class="txt">${md(i.constat || i.titre)}</div>
      ${i.attendu ? `<h3>Attendu</h3><div class="txt">${md(i.attendu)}</div>` : ''}
      <h3>Chantier</h3><div class="txt">${c ? `<a href="#${esc(c.id)}">${esc(c.id)} — ${esc(plain(c.titre))}</a>` : 'aucun'}</div>
      ${c && effLot(i) ? `<h3>Lot</h3><div class="txt">${esc(lotLabel((c.lots || []).find((l) => l.id === effLot(i)) || { id: effLot(i), titre: '?' }))}${i.lot ? ' (choisi ici)' : ' (spec)'}</div>` : ''}
      <h3><label for="itNote">Note</label></h3><div data-item="${esc(i.id)}"><textarea id="itNote" data-f="note">${esc(i.note)}</textarea></div>`, i.id, plain(i.titre));
    delete $('#drBody').dataset.ch;
  }
  function route() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (!h) return;
    if (h.startsWith('item/')) showItem(h.slice(5)); else showChantier(h);
  }

  // ---------- edition ----------
  function renumber() {
    const ord = [...data.chantiers].sort((a, b) => PRIOS.indexOf(a.priorite) - PRIOS.indexOf(b.priorite) || a.rang - b.rang);
    ord.forEach((c, k) => { if (c.rang !== k + 1) { c.rang = k + 1; mark('chantiers', c.id, 'rang'); } });
  }
  function moveBefore(id, targetId, p) {
    const c = byId()[id];
    if (!c) return;
    const t = targetId && byId()[targetId];
    c.priorite = t ? t.priorite : p || c.priorite;
    c.rang = t ? t.rang - 0.5 : 1e6;
    mark('chantiers', c.id, 'priorite'); mark('chantiers', c.id, 'rang');
    renumber(); changed();
  }
  function step(id, dir) {
    const c = byId()[id];
    const peers = data.chantiers.filter(OPEN).filter((x) => x.priorite === c.priorite).sort((a, b) => a.rang - b.rang);
    const other = peers[peers.indexOf(c) + dir];
    if (!other) return;
    [c.rang, other.rang] = [other.rang, c.rang];
    mark('chantiers', c.id, 'rang'); mark('chantiers', other.id, 'rang');
    changed();
    // le focus suit le chantier deplace ; en bout de liste le meme bouton est desactive, on prend l'autre
    const btns = [dir, -dir].map((d) => $(`.row[data-id="${CSS.escape(id)}"] [data-move="${d}"]`));
    const btn = btns.find((b) => b && !b.disabled);
    if (btn) btn.focus();
  }
  function setItem(id, f, v) {
    const i = data.items.find((x) => x.id === id);
    if (!i) return;
    i[f] = f === 'chantier' || f === 'lot' ? (v || null) : v;
    mark('items', id, f);
    if (f === 'chantier') { i.lot = null; mark('items', id, 'lot'); }  // un lot n'a de sens que dans son chantier
    changed(f !== 'note');
  }
  function mark(kind, id, field) {
    if (!dirty[kind].has(id)) dirty[kind].set(id, new Set());
    dirty[kind].get(id).add(field);
  }
  function snapshot() {
    base = { chantiers: new Map(), items: new Map() };
    for (const c of data.chantiers) base.chantiers.set(c.id, { priorite: c.priorite, rang: c.rang, note: c.note ?? '' });
    for (const i of data.items) base.items.set(i.id, { statut: i.statut, priorite: i.priorite, note: i.note ?? '', chantier: i.chantier ?? null, lot: i.lot ?? null });
  }
  function changed(rerender = true) {
    if (rerender) {
      const scroll = window.scrollY;
      const focusSel = document.activeElement && document.activeElement.closest('[data-item]') && document.activeElement.dataset.f
        ? `[data-item="${document.activeElement.closest('[data-item]').dataset.item}"] [data-f="${document.activeElement.dataset.f}"]` : null;
      render(); window.scrollTo(0, scroll);
      if (isOpen() && $('#drBody').dataset.ch) showChantier($('#drBody').dataset.ch);
      if (focusSel && !isOpen()) { const n = $(focusSel); if (n) n.focus(); }
    }
    setState('Modifications non enregistrées…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 700);
  }
  function setState(txt, cls = '') { const el = $('#saveState'); el.textContent = txt; el.className = 'save-state ' + cls; }

  function patchOf(kind, rows) {
    const out = [];
    for (const [id, fields] of dirty[kind]) {
      const row = rows.find((x) => x.id === id);
      if (!row) continue;
      const set = {}, b = base[kind].get(id) || {};
      const was = {};
      for (const f of fields) { set[f] = f === 'lot' || f === 'chantier' ? (row[f] || null) : row[f]; was[f] = b[f] ?? null; }
      out.push({ id, set, base: was });
    }
    return out;
  }

  async function save() {
    if (saving) { saveTimer = setTimeout(save, 400); return; }
    const patch = { chantiers: patchOf('chantiers', data.chantiers), items: patchOf('items', data.items) };
    if (!patch.chantiers.length && !patch.items.length) { setState(''); return; }
    saving = true;
    try {
      const r = await fetch('save.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status);
      data.meta.version = j.version;
      data.meta.edition = j.edition;
      // Ecrit : ces champs ne sont plus « a envoyer », et leur nouvelle valeur devient la reference.
      const conflicts = j.conflicts || [];
      const refused = new Set(conflicts.map((c) => (c.kind === 'chantier' ? 'chantiers' : 'items') + '|' + c.id + '|' + c.champ));
      for (const kind of ['chantiers', 'items']) {
        for (const [id, fields] of [...dirty[kind]]) {
          const row = data[kind].find((x) => x.id === id);
          for (const f of [...fields]) {
            if (refused.has(kind + '|' + id + '|' + f)) continue;
            if (row) { const b = base[kind].get(id) || {}; b[f] = row[f] ?? null; base[kind].set(id, b); }
            fields.delete(f);
          }
          if (!fields.size) dirty[kind].delete(id);
        }
      }
      if (conflicts.length) {
        // Refuse champ par champ : on NE perd pas la saisie, on dit quoi et on recharge le reste.
        const noms = conflicts.map((c) => `${c.id} (${c.champ})`).join(', ');
        setState(`Modifié ailleurs entre-temps, non écrasé : ${noms}. Recharger pour voir la valeur du fichier.`, 'err');
      } else {
        setState('Enregistré à ' + new Date().toLocaleTimeString('fr-FR'), 'ok');
      }
      syncInfo();
    } catch (e) {
      // La saisie reste dans `dirty` : le prochain passage la renverra.
      setState('Échec de l\'enregistrement : ' + e.message + ' (saisie conservée, nouvel essai au prochain changement)', 'err');
    } finally { saving = false; }
  }

  // Le fichier est reecrit par `npm run chantiers` a chaque passage d'une session.
  // Sans cette relecture, le tableau affichait un etat fige pendant des heures.
  async function poll() {
    if (saving || dirty.chantiers.size || dirty.items.size) return;   // jamais par-dessus une saisie
    if (document.activeElement && document.activeElement.closest('[data-f], [data-ch]')) return;
    try {
      const r = await fetch('chantiers.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const fresh = await r.json();
      if (!fresh || !fresh.meta || fresh.meta.version === data.meta.version) return;
      data = fresh;
      snapshot();
      render();
      if (isOpen() && $('#drBody').dataset.ch) showChantier($('#drBody').dataset.ch);
      setState('Rechargé : le fichier a changé (v' + data.meta.version + ')', 'ok');
      syncInfo();
    } catch { /* hors ligne : on retentera */ }
  }

  function syncInfo() {
    const m = data.meta;
    $('#syncInfo').textContent = `CHANTIERS.md relu le ${String(m.synchro_md || '?').replace('T', ' ').replace('Z', ' UTC')}` +
      (m.edition ? ` · dernière édition ${m.edition.replace('T', ' ').replace('Z', ' UTC')}` : '') + ` · v${m.version}`;
  }

  async function load() {
    try {
      const r = await fetch('chantiers.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = await r.json();
    } catch (e) {
      $('#view').innerHTML = `<p class="empty">Impossible de lire <code>chantiers.json</code> (${esc(e.message)}). Lancer <code>npm run chantiers</code>, puis <code>npm run tracker</code> et ouvrir l'adresse affichée (une page ouverte en <code>file://</code> ne peut pas lire le fichier).</p>`;
      return;
    }
    applyBrand();
    const doms = [...new Set(data.items.map((i) => i.domaine))].sort();
    F.dom.innerHTML = '<option value="">Tous</option>' + doms.map((d) => `<option>${esc(d)}</option>`).join('');
    F.statut.innerHTML = '<option value="">Tous</option>' + options(STATUTS, '');
    F.ch.innerHTML = '<option value="">Tous</option><option value="__none">Sans chantier</option>' +
      data.chantiers.filter((c) => itemsOf(c.id).length).map((c) => `<option value="${esc(c.id)}">${esc(c.id)} ${esc(plain(c.titre).slice(0, 40))}</option>`).join('');
    F.lot.innerHTML = '<option value="">Tous</option><option value="__none">Sans lot (chantier découpé)</option>' +
      data.chantiers.filter((c) => (c.lots || []).length).map((c) => `<optgroup label="${esc(c.id)} ${esc(plain(c.titre).slice(0, 36))}">${
        c.lots.map((l) => `<option value="${esc(c.id)}|${esc(l.id)}">${esc(c.id)} · ${esc(lotLabel(l).slice(0, 50))}</option>`).join('')}</optgroup>`).join('');
    restoreFilters();
    snapshot();
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, 15000);
    syncInfo(); setState('');
    render(); route();
  }

  // Nom du projet, couleur d'accent et mot de la decision viennent du reglage (meta.ui).
  function applyBrand() {
    const ui = UI();
    const nom = (data.meta && data.meta.projet) || '';
    document.title = nom ? `Chantiers · ${nom}` : 'Chantiers';
    $('#appTitle').textContent = nom ? `Chantiers ${nom}` : 'Chantiers';
    $('#fDecisionLabel').textContent = ui.marqueFiltre || 'Décision attendue';
    const root = document.documentElement.style;
    const dark = document.documentElement.dataset.theme === 'dark'
      || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    const c = dark ? ui.accentSombre : ui.accent;
    if (c) { root.setProperty('--accent', c); root.setProperty('--focus', c); } else { root.removeProperty('--accent'); root.removeProperty('--focus'); }
  }

  // ---------- evenements ----------
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    view = b.dataset.view; store.set('view', view); render();
  });
  Object.values(F).forEach((el) => el.addEventListener('input', () => { saveFilters(); render(); }));

  const main = $('#view');
  main.addEventListener('click', (e) => {
    const mv = e.target.closest('[data-move]');
    if (mv) { step(mv.closest('.row').dataset.id, Number(mv.dataset.move)); return; }
    const sb = e.target.closest('button[data-sort]');
    if (sb) {
      sort = { k: sb.dataset.sort, d: sort.k === sb.dataset.sort ? -sort.d : 1 }; store.set('sort', sort); render();
      const again = $(`button[data-sort="${sort.k}"]`); if (again) again.focus();
      return;
    }
    if (e.target.closest('select, input, a, button')) return;
    const card = e.target.closest('[data-id]');  // confort souris : toute la ligne ouvre la fiche (le lien reste la voie clavier)
    if (card) location.hash = card.dataset.id;
  });
  const onField = (e) => {
    const el = e.target.closest('[data-f]');
    if (!el) return;
    const host = el.closest('[data-item]');
    if (host) setItem(host.dataset.item, el.dataset.f, el.value);
  };
  main.addEventListener('change', (e) => { if (e.target.dataset.f !== 'note') onField(e); });
  main.addEventListener('input', (e) => { if (e.target.dataset.f === 'note') onField(e); });

  // glisser-deposer (vue priorisation) ; equivalent clavier : boutons Monter / Descendre
  let dragId = null;
  main.addEventListener('dragstart', (e) => {
    const r = e.target.closest('.row[draggable]');
    if (!r) return;
    dragId = r.dataset.id; r.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  main.addEventListener('dragend', () => { dragId = null; main.querySelectorAll('.dragging,.drop-before').forEach((n) => n.classList.remove('dragging', 'drop-before')); });
  main.addEventListener('dragover', (e) => {
    if (!dragId) return;
    const t = e.target.closest('.row[draggable], .drop-hint, .group');
    if (!t) return;
    e.preventDefault();
    main.querySelectorAll('.drop-before').forEach((n) => n.classList.remove('drop-before'));
    if (t.classList.contains('row')) t.classList.add('drop-before');
  });
  main.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const r = e.target.closest('.row[draggable]');
    const g = e.target.closest('[data-prio]');
    if (r && r.dataset.id !== dragId) moveBefore(dragId, r.dataset.id);
    else if (!r && g) moveBefore(dragId, null, g.dataset.prio);
  });

  // panneau
  const body = $('#drBody');
  body.addEventListener('change', (e) => {
    const el = e.target;
    const cid = body.dataset.ch;
    if (el.dataset.ch && cid) {
      if (el.dataset.ch === 'note') return;
      const c = byId()[cid];
      if (el.dataset.ch === 'priorite') { c.priorite = el.value; mark('chantiers', cid, 'priorite'); renumber(); }
      if (el.dataset.ch === 'rang') { c.rang = Math.max(1, Number(el.value) || 1) - 0.5; renumber(); }
      const key = el.dataset.ch;
      changed();
      const back = body.querySelector(`[data-ch="${key}"]`); if (back) back.focus();
      return;
    }
    if (el.dataset.f !== 'note') {
      const lot = el.closest('details.lot');  // le lot qu'on vient de finir ne se referme pas sous le curseur
      if (lot) lotsOuverts.add(lot.dataset.lot);
      onField(e);
      const host = el.closest('[data-item]');
      if (host && body.dataset.ch) { const back = body.querySelector(`[data-item="${host.dataset.item}"] [data-f="${el.dataset.f}"]`); if (back) back.focus(); }
    }
  });
  body.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.ch === 'note' && body.dataset.ch) { mark('chantiers', body.dataset.ch, 'note'); byId()[body.dataset.ch].note = el.value; changed(false); }
    else if (el.dataset.f === 'note') onField(e);
  });
  body.addEventListener('toggle', (e) => {  // toggle ne remonte pas : ecoute en capture
    const d = e.target;
    if (!d.matches || !d.matches('details.lot[data-etat="fait"]')) return;  // le rendu initial declenche aussi toggle
    if (d.open) lotsOuverts.add(d.dataset.lot); else lotsOuverts.delete(d.dataset.lot);
  }, true);
  $('#drClose').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  window.addEventListener('hashchange', () => { if (location.hash) route(); else closeDrawer(); });

  $('#reloadBtn').addEventListener('click', load);
  const applyTheme = (t) => {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    $('#themeBtn use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
    $('#themeBtn').setAttribute('aria-label', dark ? 'Passer en thème clair' : 'Passer en thème sombre');
  };
  $('#themeBtn').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    store.set('theme', next); applyTheme(next); if (data) applyBrand();
  });
  applyTheme(store.get('theme', null));
  load();
})();
