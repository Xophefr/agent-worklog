<?php
/**
 * Enregistre les champs que le tableau de suivi pilote, dans chantiers.json.
 *
 * Poste local seulement : refuse tout ce qui n'arrive pas en direct de 127.0.0.1 / ::1
 * sur un Host localhost (un reverse proxy local presenterait aussi 127.0.0.1, d'ou le
 * refus de X-Forwarded-For). N'ecrit QUE les champs du tableau (priorite, rang, note,
 * statut, rattachement, lot) : l'etat venu de docs/CHANTIERS.md n'est jamais reecrit ici.
 *
 * DEUX PROTOCOLES (le serveur Node, scripts/worklog/patch.mjs, ne parle que le premier) :
 *
 * 1. `patch` (le client actuel) : le tableau n'envoie QUE les champs qu'on a touches, avec
 *    la valeur qu'ils avaient au chargement (`base`). Un champ s'ecrit si le fichier porte
 *    encore cette valeur ; sinon il part dans `conflicts` et rien n'est ecrase. Le numero de
 *    version n'est plus un verrou : `npm run chantiers` l'incremente a chaque passage
 *    d'une session, et un verrou global refuserait alors TOUTE edition faite pendant ce temps.
 *    Un verrou par CHAMP protege la meme chose sans jeter le travail.
 *
 * 2. `items`/`chantiers` complets + `version` (l'ancien client, page deja ouverte dans un
 *    onglet) : conserve tel quel, verrou de version compris. Une charge complete ne peut PAS
 *    etre appliquee sans ce verrou : elle reecrirait avec des valeurs perimees les statuts
 *    que le script vient d'ecrire.
 */
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function fail(int $code, string $msg): void {
    http_response_code($code);
    echo json_encode(['ok' => false, 'error' => $msg], JSON_UNESCAPED_UNICODE);
    exit;
}

$remote = $_SERVER['REMOTE_ADDR'] ?? '';
$host = strtolower(preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? ''));
if (!in_array($remote, ['127.0.0.1', '::1'], true)
    || !in_array($host, ['localhost', '127.0.0.1', '[::1]'], true)
    || isset($_SERVER['HTTP_X_FORWARDED_FOR'])) {
    fail(403, 'ecriture reservee au poste local');
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'POST attendu');
}
// Pas d'ecriture depuis une autre page ouverte dans le navigateur du poste (CSRF) :
// un formulaire ou un fetch « simple » d'un autre site arrive bien de 127.0.0.1. Le JSON impose une requete
// de controle que le navigateur ne passe pas sans en-tetes CORS, et Sec-Fetch-Site dit d'ou vient l'appel.
if (stripos($_SERVER['CONTENT_TYPE'] ?? '', 'application/json') !== 0) {
    fail(415, 'JSON attendu');
}
$site = $_SERVER['HTTP_SEC_FETCH_SITE'] ?? '';
if ($site !== '' && $site !== 'same-origin') {
    fail(403, 'appel depuis une autre page refuse');
}

$raw = file_get_contents('php://input', false, null, 0, 2_000_000);
$in = json_decode($raw ?: '', true);
if (!is_array($in)) {
    fail(400, 'charge invalide');
}
$isPatch = isset($in['patch']) && is_array($in['patch']);
if (!$isPatch && (!isset($in['version'], $in['chantiers'], $in['items'])
    || !is_int($in['version']) || !is_array($in['chantiers']) || !is_array($in['items']))) {
    fail(400, 'charge invalide');
}

const PRIOS = ['P0', 'P1', 'P2', 'P3'];
const STATUTS = ['a_faire', 'en_cours', 'a_verifier', 'fait', 'abandonne'];

$file = __DIR__ . '/chantiers.json';
$fh = fopen($file, 'c+');
if ($fh === false || !flock($fh, LOCK_EX)) {
    fail(500, 'fichier inaccessible');
}
$cur = json_decode(stream_get_contents($fh) ?: '', true);
if (!is_array($cur) || !isset($cur['meta']['version'])) {
    flock($fh, LOCK_UN);
    fail(500, 'chantiers.json illisible');
}
if (!$isPatch && (int)$cur['meta']['version'] !== $in['version']) {
    flock($fh, LOCK_UN);
    fail(409, 'le fichier a change depuis le chargement (version ' . $cur['meta']['version'] . ')');
}

$note = static fn($v): string => mb_substr(is_string($v) ? $v : '', 0, 4000);
$chIds = [];
$lotIds = [];  // lots lus dans la spec de chaque chantier (scripts/worklog/chantiers-tracker.mjs)
foreach ($cur['chantiers'] as $c) {
    $chIds[$c['id']] = true;
    foreach (($c['lots'] ?? []) as $l) { $lotIds[$c['id']][(string)$l['id']] = true; }
}

/** Deux valeurs sont « la meme » pour le verrou par champ (null et '' sont un vide commun). */
$same = static function ($a, $b): bool {
    $n = static fn($v) => ($v === null || $v === '') ? null : (is_int($v) || is_float($v) ? (string)$v : $v);
    return $n($a) === $n($b);
};

$conflicts = [];
$written = 0;

/** `detache` = le proprietaire a vide le rattachement EXPRES (lu par scripts/worklog/chantiers-tracker.mjs). */
$marque = static function (array &$it): void {
    if (($it['chantier'] ?? null) === null) { $it['detache'] = true; } else { unset($it['detache']); }
};

/** Ecrit un champ si la valeur validee passe le filtre ET que le fichier porte encore `base`. */
$apply = static function (array &$row, string $kind, string $field, $value, array $base, bool $checked)
        use (&$conflicts, &$written, $same): void {
    if (!$checked) { return; }                       // valeur refusee par la validation
    if (array_key_exists($field, $base) && !$same($row[$field] ?? null, $base[$field])) {
        $conflicts[] = ['kind' => $kind, 'id' => $row['id'], 'champ' => $field, 'actuel' => $row[$field] ?? null];
        return;
    }
    $row[$field] = $value;
    $written++;
};

if ($isPatch) {
    $pCh = [];
    foreach (($in['patch']['chantiers'] ?? []) as $p) {
        if (is_array($p) && isset($p['id'])) { $pCh[$p['id']] = $p; }
    }
    foreach ($cur['chantiers'] as &$c) {
        $p = $pCh[$c['id']] ?? null;
        if ($p === null) { continue; }
        $set = is_array($p['set'] ?? null) ? $p['set'] : [];
        $base = is_array($p['base'] ?? null) ? $p['base'] : [];
        foreach ($set as $f => $v) {
            if ($f === 'priorite') { $apply($c, 'chantier', $f, $v, $base, in_array($v, PRIOS, true)); }
            elseif ($f === 'rang') { $apply($c, 'chantier', $f, (int)$v, $base, is_int($v) && $v > 0); }
            elseif ($f === 'note') { $apply($c, 'chantier', $f, $note($v), $base, true); }
        }
    }
    unset($c);

    $pIt = [];
    foreach (($in['patch']['items'] ?? []) as $p) {
        if (is_array($p) && isset($p['id'])) { $pIt[$p['id']] = $p; }
    }
    foreach ($cur['items'] as &$it) {
        $p = $pIt[$it['id']] ?? null;
        if ($p === null) { continue; }
        $set = is_array($p['set'] ?? null) ? $p['set'] : [];
        $base = is_array($p['base'] ?? null) ? $p['base'] : [];
        foreach ($set as $f => $v) {
            if ($f === 'statut') { $apply($it, 'tache', $f, $v, $base, in_array($v, STATUTS, true)); }
            elseif ($f === 'priorite') { $apply($it, 'tache', $f, $v, $base, in_array($v, PRIOS, true)); }
            elseif ($f === 'note') { $apply($it, 'tache', $f, $note($v), $base, true); }
            elseif ($f === 'chantier') {
                $avant = $written;
                $apply($it, 'tache', $f, $v === '' ? null : $v, $base, $v === null || $v === '' || isset($chIds[$v]));
                // Un detachement VOULU laisse sa trace : sans elle, chantiers-tracker
                // rattacherait de nouveau la tache a son chantier par defaut au passage suivant.
                if ($written > $avant) { $marque($it); }
            } elseif ($f === 'lot') {
                $ch = $it['chantier'] ?? null;
                $ok = $v === null || $v === '' || (is_string($v) && $ch !== null && isset($lotIds[$ch][$v]));
                $apply($it, 'tache', $f, ($v === null || $v === '') ? null : $v, $base, $ok);
            }
        }
    }
    unset($it);
} else {
    $patchCh = [];
    foreach ($in['chantiers'] as $p) {
        if (!is_array($p) || !isset($p['id']) || !isset($chIds[$p['id']])) { continue; }
        $patchCh[$p['id']] = $p;
    }
    foreach ($cur['chantiers'] as &$c) {
        $p = $patchCh[$c['id']] ?? null;
        if ($p === null) { continue; }
        if (in_array($p['priorite'] ?? null, PRIOS, true)) { $c['priorite'] = $p['priorite']; }
        if (is_int($p['rang'] ?? null) && $p['rang'] > 0) { $c['rang'] = $p['rang']; }
        if (array_key_exists('note', $p)) { $c['note'] = $note($p['note']); }
    }
    unset($c);

    $patchIt = [];
    foreach ($in['items'] as $p) {
        if (is_array($p) && isset($p['id'])) { $patchIt[$p['id']] = $p; }
    }
    foreach ($cur['items'] as &$it) {
        $p = $patchIt[$it['id']] ?? null;
        if ($p === null) { continue; }
        if (in_array($p['statut'] ?? null, STATUTS, true)) { $it['statut'] = $p['statut']; }
        if (in_array($p['priorite'] ?? null, PRIOS, true)) { $it['priorite'] = $p['priorite']; }
        if (array_key_exists('chantier', $p) && ($p['chantier'] === null || isset($chIds[$p['chantier']]))) {
            $it['chantier'] = $p['chantier'];
            $marque($it);
        }
        if (array_key_exists('note', $p)) { $it['note'] = $note($p['note']); }
        // Lot : null (on revient a celui de la spec) ou un lot du chantier de la tache.
        if (array_key_exists('lot', $p)) {
            $ch = $it['chantier'] ?? null;
            if ($p['lot'] === null || $p['lot'] === '') {
                $it['lot'] = null;
            } elseif (is_string($p['lot']) && $ch !== null && isset($lotIds[$ch][$p['lot']])) {
                $it['lot'] = $p['lot'];
            }
        }
    }
    unset($it);
    $written = 1;
}

if ($written === 0) {
    // Rien a ecrire (tout en conflit) : on ne touche pas au fichier, et on le dit.
    flock($fh, LOCK_UN);
    fclose($fh);
    echo json_encode(['ok' => true, 'version' => (int)$cur['meta']['version'],
                      'edition' => $cur['meta']['edition'] ?? null, 'conflicts' => $conflicts],
                     JSON_UNESCAPED_UNICODE);
    exit;
}

$cur['meta']['version'] = (int)$cur['meta']['version'] + 1;
$cur['meta']['edition'] = gmdate('Y-m-d\TH:i:s\Z');
$json = json_encode($cur, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
if ($json === false) {
    flock($fh, LOCK_UN);
    fail(500, 'encodage impossible');
}
@copy($file, $file . '.bak');
ftruncate($fh, 0);
rewind($fh);
fwrite($fh, $json . "\n");
fflush($fh);
flock($fh, LOCK_UN);
fclose($fh);
echo json_encode(['ok' => true, 'version' => $cur['meta']['version'], 'edition' => $cur['meta']['edition'],
                  'conflicts' => $conflicts], JSON_UNESCAPED_UNICODE);
