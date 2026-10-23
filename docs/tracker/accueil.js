/* Accueil multi-projets (npm run accueil) : une carte par projet inscrit au registre.
 * Lit /api/projets (resume calcule par le serveur depuis le chantiers.json de chaque projet),
 * inscrit un dossier (POST /api/projets) et retire une carte (POST /api/projets/retirer) : ce
 * retrait ne touche aucun fichier du projet, seulement le registre.
 * Accessibilite : une carte = un lien (une tabulation) ; le bouton Retirer est a part ; la
 * confirmation se fait dans la carte (jamais confirm()) et le focus y reste.
 */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const KEY = 'worklog:' + location.pathname + ':';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(KEY + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
  };

  let projets = [];
  let outil = '';
  let aRetirer = null;      // id dont la confirmation de retrait est ouverte
  let ajoutOuvert = false;
  let ajoutErreur = '';
  let ajoutMode = 'nouveau';  // 'nouveau' : projet parti de zero ; 'existant' : reprise d'un dossier
  let ajoutSaisie = { nom: '', dossier: '' };
  let liens = 0;            // BFF lies a l'accueil (mode base possible)
  let ajoutStockage = 'fichiers';
  let aBaser = null;        // id dont la confirmation de passage en base est ouverte

  const dark = () => document.documentElement.dataset.theme === 'dark'
    || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const plural = (n, un, plus) => `${n} ${n > 1 ? plus : un}`;

  function carte(p) {
    if (p.erreur) {
      return `<li class="proj err" data-id="${esc(p.id)}"><div class="proj-body">
        <h2>${esc(p.nom || p.id)}</h2><p class="proj-err" role="note">${esc(p.erreur)}</p><p class="muted mono">${esc(p.dossier)}</p></div>${retrait(p)}</li>`;
    }
    const r = p.resume;
    const t = r.taches;
    const w = (k) => (t.base ? ((t[k] / t.base) * 100).toFixed(1) : 0);
    const acc = (dark() ? r.accentSombre : r.accent) || '';
    return `<li class="proj" data-id="${esc(p.id)}"${acc ? ` style="--proj:${esc(acc)}"` : ''}>
      <a class="proj-body" href="/p/${encodeURIComponent(p.id)}/">
        <h2>${esc(r.nom || p.id)}${p.type === 'base' ? ' <span class="pill stock">base</span>' : ''}</h2>
        <p class="proj-pct"><b>${t.pct} %</b> <span>${t.fait} / ${t.base} tâches faites</span></p>
        <div class="bar" aria-hidden="true"><i class="s-fait" style="width:${w('fait')}%"></i><i class="s-a_verifier" style="width:${w('a_verifier')}%"></i><i class="s-en_cours" style="width:${w('en_cours')}%"></i></div>
        <ul class="chips">
          <li class="pill en_cours">${plural(r.chantiers.en_cours, 'chantier en cours', 'chantiers en cours')}</li>
          ${t.a_verifier ? `<li class="pill a_verifier">${t.a_verifier} à vérifier</li>` : ''}
          ${r.decisions ? `<li class="pill decision">${plural(r.decisions, 'décision', 'décisions')}</li>` : ''}
          ${r.chantiers.bloque ? `<li class="pill bloque">${plural(r.chantiers.bloque, 'chantier bloqué', 'chantiers bloqués')}</li>` : ''}
        </ul>
        <p class="proj-act">${plural(r.bouges7j, 'tâche bougée', 'tâches bougées')} en 7 jours${r.derniere ? ` · dernière le ${esc(r.derniere)}` : ''}</p>
        ${r.aJour ? '' : `<p class="proj-maj">outil ${esc(r.version || 'inconnu')}, accueil ${esc(outil)} : relancer install.mjs</p>`}
      </a>${p.type !== 'base' && liens ? passage(p) : ''}${retrait(p)}</li>`;
  }

  // Projet en fichiers, BFF lie : import dans la base, confirme dans la carte.
  function passage(p) {
    if (aBaser !== p.id) return `<button type="button" class="proj-x" data-baser="${esc(p.id)}">Passer en base<span class="sr"> : ${esc(p.id)}</span></button>`;
    return `<div class="proj-confirm" role="group" aria-label="Passer ${esc(p.id)} en base ?">
      <p>Importer ce projet dans la base ? Ses .md restent dans le dépôt, gelés ; les sessions écriront ensuite dans la base.</p>
      <button type="button" class="btn primary" data-baser-ok="${esc(p.id)}">Importer</button>
      <button type="button" class="btn" data-baser-non="${esc(p.id)}">Annuler</button></div>`;
  }

  function retrait(p) {
    if (aRetirer !== p.id) return `<button type="button" class="proj-x" data-retirer="${esc(p.id)}">Retirer de l'accueil<span class="sr"> : ${esc(p.id)}</span></button>`;
    return `<div class="proj-confirm" role="group" aria-label="Retirer ${esc(p.id)} de l'accueil ?">
      <p>Retirer de l'accueil ? Les fichiers du projet ne sont pas touchés.</p>
      <button type="button" class="btn danger" data-confirmer="${esc(p.id)}">Retirer</button>
      <button type="button" class="btn" data-annuler="${esc(p.id)}">Annuler</button></div>`;
  }

  function ajout() {
    if (!ajoutOuvert) return `<li class="proj add"><button type="button" id="addBtn"><svg aria-hidden="true"><use href="#i-plus"/></svg>Ajouter un projet</button></li>`;
    const neuf = ajoutMode === 'nouveau';
    const aide = neuf
      ? 'Le dossier est créé s’il n’existe pas. On y pose le suivi et des modèles à remplir (registre, backlog, spec d’exemple).'
      : 'Déjà suivi (il a son tracker.config.json) : il est simplement ajouté. Sinon, le suivi y est installé, sans toucher à vos fichiers.';
    const radio = (v, l) => `<label class="radio"><input type="radio" name="mode" value="${v}"${ajoutMode === v ? ' checked' : ''}> ${l}</label>`;
    return `<li class="proj add open"><form id="addForm" class="proj-body">
      <fieldset class="modes"><legend>Ajouter</legend>${radio('nouveau', 'Nouveau projet')}${radio('existant', 'Projet existant')}</fieldset>
      ${liens ? `<fieldset class="modes"><legend>Suivi</legend>${['fichiers', 'base'].map((v) => `<label class="radio"><input type="radio" name="stockage" value="${v}"${ajoutStockage === v ? ' checked' : ''}> ${v === 'base' ? 'Base de données' : 'Fichiers .md'}</label>`).join('')}</fieldset>` : ''}
      ${neuf ? `<label for="addNom">Nom du projet</label>
      <input id="addNom" name="nom" required autocomplete="off" value="${esc(ajoutSaisie.nom)}">` : ''}
      <label for="addDir">Dossier du projet</label>
      <input id="addDir" name="dossier" required autocomplete="off" spellcheck="false" placeholder="E:/www/mon-projet" value="${esc(ajoutSaisie.dossier)}" aria-describedby="addAide${ajoutErreur ? ' addErr' : ''}">
      <p class="muted" id="addAide">${aide}</p>
      ${ajoutErreur ? `<p class="proj-err" id="addErr" role="alert">${esc(ajoutErreur)}</p>` : ''}
      <div class="row-btns"><button type="submit" class="btn primary">${neuf ? 'Créer' : 'Ajouter'}</button><button type="button" class="btn" id="addCancel">Annuler</button></div>
    </form></li>`;
  }

  function render(focusSel) {
    $('#projets').innerHTML = projets.map(carte).join('') + ajout();
    $('#syncInfo').textContent = `${plural(projets.length, 'projet', 'projets')} · relu à ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
    if (focusSel) { const n = $(focusSel); if (n) n.focus(); }
  }

  async function load(focusSel) {
    try {
      const r = await fetch('/api/projets', { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'HTTP ' + r.status);
      projets = j.projets;
      outil = j.outil;
      liens = j.liens || 0;
      render(focusSel);
    } catch (e) {
      $('#projets').innerHTML = `<li class="empty" role="alert">Impossible de lire la liste des projets (${esc(e.message)}).</li>`;
    }
  }

  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status); return j; });

  // Ce qui a le focus, pour le lui rendre apres un nouveau rendu de la liste.
  function focusSel() {
    const el = document.activeElement;
    if (!el || !$('#projets').contains(el)) return null;
    if (el.id) return '#' + CSS.escape(el.id);
    for (const k of ['retirer', 'annuler', 'confirmer']) if (el.dataset[k]) return `[data-${k}="${CSS.escape(el.dataset[k])}"]`;
    const card = el.closest('[data-id]');
    return card ? `[data-id="${CSS.escape(card.dataset.id)}"] a.proj-body` : null;
  }
  // Une saisie en cours ou une confirmation ouverte ne sont jamais effacees par le rafraichissement.
  setInterval(() => { if (!ajoutOuvert && !aRetirer && !aBaser && !document.hidden) load(focusSel()); }, 30000);

  $('#projets').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'addBtn') { ajoutOuvert = true; ajoutErreur = ''; ajoutSaisie = { nom: '', dossier: '' }; render('input[name="mode"]:checked'); return; }
    if (b.id === 'addCancel') { ajoutOuvert = false; render('#addBtn'); return; }
    if (b.dataset.baser) { aBaser = b.dataset.baser; render(`[data-baser-non="${CSS.escape(aBaser)}"]`); return; }
    if (b.dataset.baserNon) { const id = aBaser; aBaser = null; render(`[data-baser="${CSS.escape(id)}"]`); return; }
    if (b.dataset.baserOk) {
      const id = b.dataset.baserOk;
      b.disabled = true; b.textContent = 'Import…';
      try { await post('/api/projets/passer-en-base', { id }); aBaser = null; await load(`[data-id="${CSS.escape(id)}"] a.proj-body`); }
      catch (err) { aBaser = null; render(`[data-baser="${CSS.escape(id)}"]`); alertLine(err.message); }
      return;
    }
    if (b.dataset.retirer) { aRetirer = b.dataset.retirer; render(`[data-annuler="${CSS.escape(aRetirer)}"]`); return; }
    if (b.dataset.annuler) { const id = aRetirer; aRetirer = null; render(`[data-retirer="${CSS.escape(id)}"]`); return; }
    if (b.dataset.confirmer) {
      try { await post('/api/projets/retirer', { id: b.dataset.confirmer }); aRetirer = null; await load('#addBtn'); }
      catch (err) { const id = aRetirer; aRetirer = null; render(`[data-retirer="${CSS.escape(id)}"]`); alertLine(err.message); }
    }
  });
  // Changer de mode garde ce qui est deja saisi.
  $('#projets').addEventListener('change', (e) => {
    if (e.target.name === 'stockage') { ajoutStockage = e.target.value; return; }
    if (e.target.name !== 'mode') return;
    lireSaisie(); ajoutMode = e.target.value; ajoutErreur = '';
    render(`input[name="mode"][value="${ajoutMode}"]`);
  });
  function lireSaisie() {
    ajoutSaisie = { nom: $('#addNom') ? $('#addNom').value : ajoutSaisie.nom, dossier: $('#addDir') ? $('#addDir').value : ajoutSaisie.dossier };
  }
  $('#projets').addEventListener('submit', async (e) => {
    e.preventDefault();
    lireSaisie();
    const dossier = ajoutSaisie.dossier.trim();
    const btn = e.target.querySelector('[type="submit"]');
    btn.disabled = true; btn.textContent = 'Installation…';
    try {
      const j = await post('/api/projets', { mode: ajoutMode, dossier, nom: ajoutSaisie.nom.trim(), stockage: liens ? ajoutStockage : 'fichiers' });
      ajoutOuvert = false; ajoutErreur = '';
      await load(`[data-id="${CSS.escape(j.projet.id)}"] a.proj-body, [data-id="${CSS.escape(j.projet.id)}"] .proj-x`);
    } catch (err) { ajoutErreur = err.message; render('#addDir'); }
  });
  function alertLine(msg) { $('#syncInfo').textContent = 'Échec : ' + msg; }

  // theme : meme logique que le tableau
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    const d = dark();
    $('#themeBtn use').setAttribute('href', d ? '#i-sun' : '#i-moon');
    $('#themeBtn').setAttribute('aria-label', d ? 'Passer en thème clair' : 'Passer en thème sombre');
  }
  $('#themeBtn').addEventListener('click', () => {
    const next = dark() ? 'light' : 'dark';
    store.set('theme', next); applyTheme(next); render();
  });
  $('#reloadBtn').addEventListener('click', () => load(focusSel()));
  applyTheme(store.get('theme', null));
  load();
})();
