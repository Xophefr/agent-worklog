/* Export Excel du tableau : un vrai classeur .xlsx (Office Open XML), ecrit sans dependance.
 * Un .xlsx est une archive zip de fichiers XML ; on la construit sans compression (methode
 * « stored »), ce qui suffit a Excel, LibreOffice et Google Sheets et tient en quelques lignes.
 * Chaque feuille : ligne d'en-tete en gras, figee, avec filtre automatique ; texte renvoye a la
 * ligne. Les cellules texte sont « en ligne » (inlineStr) : pas de table de chaines partagees.
 * Charge par le navigateur (window.WorklogXlsx) et par les tests Node (require).
 */
(function (root) {
  'use strict';
  const enc = new TextEncoder();

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // Archive zip sans compression : en-tete local + donnees par fichier, puis repertoire central.
  function zip(files) {
    const parts = [], central = [];
    let offset = 0;
    const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;  // date fixe : meme contenu, memes octets
    for (const f of files) {
      const name = enc.encode(f.name), data = f.data, crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);  // UTF-8
      local.setUint16(8, 0, true); local.setUint16(10, 0, true); local.setUint16(12, DOS_DATE, true);
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true); cen.setUint16(12, 0, true); cen.setUint16(14, DOS_DATE, true);
      cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true);
      cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
      parts.push(new Uint8Array(local.buffer), name, data);
      central.push(new Uint8Array(cen.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const size = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, size, true); end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
    let at = 0;
    for (const p of all) { out.set(p, at); at += p.length; }
    return out;
  }

  // Caracteres interdits en XML 1.0 retires ; une cellule Excel tient 32 767 caracteres au plus.
  const xml = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .slice(0, 32767).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const col = (n) => { let s = ''; for (n += 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

  // sheet : { nom, colonnes: [{ titre, largeur }], lignes: [[valeur, ...]] }. Nombre -> cellule
  // numerique ; null / undefined / '' -> cellule vide ; le reste -> texte.
  function sheetXml(sheet) {
    const cols = sheet.colonnes;
    const cell = (v, r, c, style) => {
      const ref = col(c) + r;
      if (v === null || v === undefined || v === '') return '';
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}" s="${style}"><v>${v}</v></c>`;
      return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
    };
    const rows = [`<row r="1">${cols.map((c, k) => cell(c.titre, 1, k, 1)).join('')}</row>`]
      .concat(sheet.lignes.map((l, i) => `<row r="${i + 2}">${l.map((v, k) => cell(v, i + 2, k, 2)).join('')}</row>`));
    const last = col(cols.length - 1) + (sheet.lignes.length + 1);
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      + `<cols>${cols.map((c, k) => `<col min="${k + 1}" max="${k + 1}" width="${c.largeur || 14}" customWidth="1"/>`).join('')}</cols>`
      + `<sheetData>${rows.join('')}</sheetData>`
      + `<autoFilter ref="A1:${last}"/></worksheet>`;
  }

  const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>';

  // Nom de feuille : 31 caracteres au plus, sans []:*?/\.
  const sheetName = (s) => String(s).replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Feuille';

  function workbook(sheets) {
    const noms = sheets.map((s) => sheetName(s.nom));
    const ns = 'http://schemas.openxmlformats.org';
    const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    const files = [
      ['[Content_Types].xml', head + `<Types xmlns="${ns}/package/2006/content-types">`
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + sheets.map((_, k) => `<Override PartName="/xl/worksheets/sheet${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
        + '</Types>'],
      ['_rels/.rels', head + `<Relationships xmlns="${ns}/package/2006/relationships">`
        + `<Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ['xl/workbook.xml', head + `<workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets>`
        + noms.map((n, k) => `<sheet name="${xml(n)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join('') + '</sheets>'
        // Le filtre automatique d'une feuille reclame ce nom defini, sinon Excel « repare » le fichier.
        + `<definedNames>${sheets.map((s, k) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${k}" hidden="1">'${xml(noms[k].replace(/'/g, "''"))}'!$A$1:$${col(s.colonnes.length - 1)}$${s.lignes.length + 1}</definedName>`).join('')}</definedNames>`
        + '</workbook>'],
      ['xl/_rels/workbook.xml.rels', head + `<Relationships xmlns="${ns}/package/2006/relationships">`
        + sheets.map((_, k) => `<Relationship Id="rId${k + 1}" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`).join('')
        + `<Relationship Id="rId${sheets.length + 1}" Type="${ns}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
      ['xl/styles.xml', STYLES],
      ...sheets.map((s, k) => [`xl/worksheets/sheet${k + 1}.xml`, sheetXml(s)]),
    ];
    return zip(files.map(([name, text]) => ({ name, data: enc.encode(text) })));
  }

  const api = { workbook, crc32, zip };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.WorklogXlsx = api;
})(this);
