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
        <h2>${esc(r.nom || p.id)}</h2>
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
      </a>${retrait(p)}</li>`;
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
    return `<li class="proj add open"><form id="addForm" class="proj-body">
      <label for="addDir">Dossier du projet</label>
      <input id="addDir" name="dossier" required autocomplete="off" spellcheck="false" placeholder="E:/www/mon-projet" aria-describedby="addAide${ajoutErreur ? ' addErr' : ''}">
      <p class="muted" id="addAide">Le dossier doit contenir tracker.config.json.</p>
      ${ajoutErreur ? `<p class="proj-err" id="addErr" role="alert">${esc(ajoutErreur)}</p>` : ''}
      <div class="row-btns"><button type="submit" class="btn primary">Ajouter</button><button type="button" class="btn" id="addCancel">Annuler</button></div>
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
      render(focusSel);
    } catch (e) {
      $('#projets').innerHTML = `<li class="empty" role="alert">Impossible de lire la liste des projets (${esc(e.message)}).</li>`;
    }
  }

  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status); return j; });

  // Une saisie en cours ou une confirmation ouverte ne sont jamais effacees par le rafraichissement.
  setInterval(() => { if (!ajoutOuvert && !aRetirer && !document.hidden) load(document.activeElement && document.activeElement.matches('a.proj-body')
    ? `[data-id="${CSS.escape(document.activeElement.closest('[data-id]').dataset.id)}"] a.proj-body` : null); }, 30000);

  $('#projets').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'addBtn') { ajoutOuvert = true; ajoutErreur = ''; render('#addDir'); return; }
    if (b.id === 'addCancel') { ajoutOuvert = false; render('#addBtn'); return; }
    if (b.dataset.retirer) { aRetirer = b.dataset.retirer; render(`[data-annuler="${CSS.escape(aRetirer)}"]`); return; }
    if (b.dataset.annuler) { const id = aRetirer; aRetirer = null; render(`[data-retirer="${CSS.escape(id)}"]`); return; }
    if (b.dataset.confirmer) {
      try { await post('/api/projets/retirer', { id: b.dataset.confirmer }); aRetirer = null; await load('#addBtn'); }
      catch (err) { aRetirer = null; render(); alertLine(err.message); }
    }
  });
  $('#projets').addEventListener('submit', async (e) => {
    e.preventDefault();
    const dossier = $('#addDir').value.trim();
    try {
      const j = await post('/api/projets', { dossier });
      ajoutOuvert = false; ajoutErreur = '';
      await load(`[data-id="${CSS.escape(j.projet.id)}"] a.proj-body, [data-id="${CSS.escape(j.projet.id)}"] .proj-x`);
    } catch (err) { ajoutErreur = err.message; render('#addDir'); $('#addDir').value = dossier; }
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
  $('#reloadBtn').addEventListener('click', () => load());
  applyTheme(store.get('theme', null));
  load();
})();
