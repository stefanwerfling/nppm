<p align="center">
  <img src="logo.svg" width="64" height="64" alt="nppm" />
</p>

# nppm — Benutzerhandbuch

> 🇬🇧 English version: [`manual_en.md`](manual_en.md)

Dieses Handbuch beschreibt nppm anhand der Screenshots, die `npm run
docs:screenshots` aus deiner eigenen `nppm.json` erzeugt — d.h. du
siehst hier echte Daten aus deinen konfigurierten Projekten, nicht
Beispielprojekte.

## Inhalt

1. [Die projektübergreifende Matrix](#1-die-projektübergreifende-matrix)
2. [Ein Projekt im Detail](#2-ein-projekt-im-detail)
   - [Deklarierte Abhängigkeiten](#21-deklarierte-abhängigkeiten)
   - [Installierte Abhängigkeiten](#22-installierte-abhängigkeiten)
   - [Projekt-Matrix](#23-projekt-matrix)
   - [Abhängigkeitsbaum](#24-abhängigkeitsbaum)
   - [History](#25-history)
   - [Unbenutzte Abhängigkeiten](#26-unbenutzte-abhängigkeiten)
3. [Paket-Detail-Panel](#3-paket-detail-panel)
   - [Dateien](#31-dateien)
   - [Abhängigkeiten](#32-abhängigkeiten)
   - [Releases](#33-releases)
   - [Sicherheit](#34-sicherheit)
   - [Lizenz](#36-lizenz)
4. [Globaler CVE-Scan](#4-globaler-cve-scan)
5. [Headless-CI-Modus](#5-headless-ci-modus)
6. [SBOM-Export](#6-sbom-export)
7. [Eine Abhängigkeit upgraden (Upgrade-Modal)](#7-eine-abhängigkeit-upgraden-upgrade-modal)
8. [Bulk-Update-Wizard](#8-bulk-update-wizard)
9. [Sprache wechseln](#9-sprache-wechseln)

---

## 1. Die projektübergreifende Matrix

Die Einstiegsansicht. Zeilen sind **Pakete**, Spalten sind **Projekte**
plus eine **Latest**-Spalte aus dem npm-Registry. Die Zellenfarbe
zeigt den Zeilenstatus:

- 🟢 **aligned** — alle Projekte, die das Paket pinnen, benutzen den
  gleichen Range *und* der Range löst auf die Registry-Latest auf.
- 🟡 **outdated** — alle einig, aber die Registry hat eine neuere
  Version.
- 🔴 **drift** — mindestens zwei Projekte sind sich über die Version
  uneinig.
- ⚪ **unknown** — der Registry-Lookup ist fehlgeschlagen.

![Projektübergreifende Matrix](screenshots/01_matrix_de.png)

**Filter** oben links: `Alle / Probleme / Drift / Veraltet / Unsicher /
Lizenzen` (letzterer zeigt nur Pakete mit Strong-Copyleft, proprietärer
oder unbekannter Lizenz).
Die **Suche** macht case-insensitive Substring-Matching auf den
Paketnamen. **Sortierung:** Name, Status (am dringlichsten zuerst)
oder aggregierter Security-Score.

**Badges in der Namensspalte:**

- `CVE N` — N bekannte OSV.dev-Schwachstellen in der Latest-Version.
- `SCRIPT` / `SCRIPT!` — Lifecycle-Scripts auf Warn-/Risk-Stufe.
- `EVAL N` — N dynamische Code-Ausführungs-Pattern im Tarball.
- `BIN N` — N native Binärdateien (`.exe / .dll / .so` …) im Tarball.
- `OWNER!` — Schneller Owner-Wechsel auf einem etablierten Paket
  (klassisches Account-Takeover-Profil — siehe Maintainer-Scanner unten).
- `GPL` / `UNLIC` / `LIC?` — Lizenz-Klassifikation: Strong-Copyleft /
  proprietär / unbekannt (siehe Lizenz-Tab unten).
- `WS` — Workspaces *innerhalb* eines Projekts sind uneinig.

**Git-Dependencies** zeigen die *installierte* Version als Zellenwert
plus ein kleines `git`-Chip; im Hover erscheint die Original-URL.

Klick auf eine Zelle öffnet das
[Paket-Detail-Panel](#3-paket-detail-panel). Klick auf einen
Projekt-Spaltenkopf wechselt in das Projekt.

---

## 2. Ein Projekt im Detail

Wählt man im linken Treeview ein Projekt aus, landet man in einer
Sechs-Tab-Ansicht: **Deklariert / Installiert / History / Matrix /
Tree / Unbenutzt**. Der Toggle ist in jedem Tab gleich — Navigation ist
immer ein Klick weit weg.

### 2.1 Deklarierte Abhängigkeiten

Flache Tabelle aller Abhängigkeiten aus den `package.json`-Dateien
(Root + Workspaces) des Projekts.

![Deklariert](screenshots/02_declared_de.png)

### 2.2 Installierte Abhängigkeiten

Jede Zeile bekommt in der Pfad-Spalte einen kleinen **`IDE`**-Button,
sobald `actions.editor` in `nppm.json` gesetzt ist. Klick öffnet
`node_modules/<pkg>` im konfigurierten Editor über dessen
URL-Handler (`vscode://`, `vscodium://`, `cursor://`, `phpstorm://`,
`webstorm://`, `idea://`, `subl://`). Bei Remote-Projekten
ausgeblendet (die Dateien liegen ja nicht lokal) und wenn kein Editor
konfiguriert ist.

Was npm tatsächlich auf der Platte aufgelöst hat. Die Anzeige nennt
die *Quelle* der Daten:

- **`package-lock.json v3`** — committed Lockfile (beste Datenqualität).
- **`node_modules/.package-lock.json v3`** — npm's versteckter Klon mit
  identischen Daten, wird bei jedem `npm install` geschrieben —
  Fallback wenn die committed Lockfile in `.gitignore` steht.
- **Aus node_modules synthetisiert** — Last-Resort-Walk wenn gar keine
  Lockfile existiert (ohne `dev` / `peer` / `optional`-Flags).

![Installiert](screenshots/03_installed_de.png)

Der Button **Analyse starten** startet einen pro-Projekt-SSE-OSV-Scan;
die CVE-Spalte füllt sich zeilenweise während der Fortschrittsbalken
läuft.

### 2.3 Projekt-Matrix

Gleiche Form wie die globale Matrix, aber die Spalten sind die
*Workspaces* des Projekts statt anderer Projekte. Nützlich wenn die
Workspaces eines einzelnen Projekts uneins sind.

![Projekt-Matrix](screenshots/04_project_matrix_de.png)

### 2.4 Abhängigkeitsbaum

D3 collapsible Tree. Root = das Projekt, Kinder = Top-Level-Deps;
Klick auf einen Knoten lädt seine Sub-Abhängigkeiten on-demand.
Knotenfarbe folgt der Status-Semantik; ein umrandeter Knoten hat noch
versteckte Kinder.

![Tree](screenshots/05_tree_de.png)

### 2.5 History

Bei jedem Lockfile-Aufruf vergleicht nppm den aktuellen Stand mit dem
letzten Snapshot und fügt einen History-Eintrag hinzu, wenn sich etwas
geändert hat. Das Reason-Feld wird automatisch aus dem Semver-Bump-Typ
generiert, mit CVE-Hinweis wenn die alte Version bekannte
Schwachstellen im OSV-Cache hatte.

![History](screenshots/06_history_de.png)

Die History-Dateien liegen in `.nppm-history/` neben deiner
`nppm.json` — kannst du committen, wenn du langfristige Audit-Spuren
willst.

### 2.6 Unbenutzte Abhängigkeiten

Ein depcheck-artiger Hygiene-Scan über den Quellbaum des Projekts.
Der Tab gruppiert die Befunde in drei Listen:

- **Unbenutzt** — in `package.json` deklariert, aber nirgends unter
  `src/` importiert. Severity ist `risk` für echte Kandidaten und
  `info` für Einträge, die der Scanner bewusst verschont (Allowlist /
  `scripts:`-Referenz / `@types/X` deren `X` importiert wird).
- **Falsch einsortiert** — nur aus Dev-Pfaden importiert (`*.test.*`,
  `*.spec.*`, `tests/`, `*.config.*`), steht aber in `dependencies`
  statt `devDependencies`. Fix ist ein `package.json`-Edit.
- **Fehlend** — wird aus dem Quellcode importiert, ist aber nirgends
  deklariert. Meist ein transitiv geleakter Import, manchmal eine
  vergessene Peer-Dep.

Der Scanner arbeitet rein per Regex (kein AST-Parse). Dynamische
Specs wie `import(varName)` können nicht aufgelöst werden; betroffene
Dateien werden separat aufgeführt, damit die Unused-Liste dort nicht
als endgültig missverstanden wird.

Eine Default-Allowlist deckt die Bin-Tools ab, die fast jedes
npm-Projekt in `devDependencies` führt (`vite`, `vitest`, `tsx`,
`typescript`, `eslint`, `prettier`, `husky`, `rimraf`, `cross-env`, …)
plus den bekannten `tsc → typescript`-Bin-Alias. Eigene Extras
ergänzt man über `security.unused.allowlist` in `nppm.json` — die
Default-Liste wird *vereinigt*, nicht ersetzt, damit ein Ein-Zeilen-
Override nicht eine Welle falscher Treffer zurückbringt.

Remote-Projekte (GitHub / Gitea) zeigen aktuell "nicht unterstützt"
an, weil der contents-API-Aufruf pro Datei in v1 das Rate-Limit-
Budget sprengen würde.

---

## 3. Paket-Detail-Panel

Klick auf eine Matrix-Zelle öffnet ein Modal mit fünf Tabs.

### 3.1 Dateien

Pro Datei im Tarball: SHA-256 + Größe. Im Header steht die
Gesamtanzahl + Bytes.

![Detail: Dateien](screenshots/07_panel_files_de.png)

### 3.2 Abhängigkeiten

Was das Paket selbst als `dependencies`, `devDependencies`,
`peerDependencies`, `optionalDependencies` deklariert. Aus der
`package.json` im Tarball gelesen (permanent gecached).

![Detail: Abhängigkeiten](screenshots/08_panel_deps_de.png)

### 3.3 Diff

Vergleicht die Cell-Version mit der Registry-Latest, Datei für Datei:
hinzugefügt / entfernt / geändert. Lazy-loaded beim ersten Tab-Klick.

### 3.4 Releases

Zusammengeführte Zeitleiste:

- npm-Publish-Daten (immer verfügbar)
- Publisher (`_npmUser`) pro Version — `by <name>` hinter dem Datum,
  damit du Owner-Wechsel direkt am Versionsverlauf siehst.
- GitHub-Release-Titel + Body-Notes (wenn das `repository`-Feld des
  Pakets auf github.com zeigt)

Der Pfeil rechts ist ein direkter Link zur GitHub-Release-Seite. Setze
`GH_TOKEN` in deinem `.env`, um das 60-req/h-Anonymous-Rate-Limit
loszuwerden.

![Detail: Releases](screenshots/09_panel_releases_de.png)

### 3.5 Sicherheit

Aggregiert sechs Scanner:

- **CVEs** aus OSV.dev (Single-Version-Query, volle Details)
- **Install-Scripts** — Lifecycle-Hooks klassifiziert info/warn/risk
- **Code-Pattern** — `eval(`, `new Function(`, `child_process`, base64
- **Binärdateien** — nativer Code im Tarball
- **Datei-Churn** — Vergleich gegen die vorherige Stable-Version
- **Maintainer / Publisher** — vergleicht den `_npmUser` der gewählten
  Version mit dem Trust-Set der letzten Vorgänger.

Die Severity beim Maintainer-Scanner orientiert sich an der **Geschwindigkeit
des Owner-Wechsels** auf einem etablierten Paket — empirisch hatten die
echten npm-Account-Takeovers (event-stream, ua-parser-js, coa, rc,
@solana/web3.js) kurze Gaps:

| Gap zur Vorversion | Severity |
|--------------------|----------|
| ≤ 30 Tage + ≥10 Vorgänger | `risk` — Takeover-Profil |
| 31 – 180 Tage + ≥10 Vorgänger | `warn` — ungewöhnlich, Blick lohnt sich |
| > 180 Tage | `info` — wahrscheinlich legitime Community-Übernahme eines verlassenen Pakets |

Schwellen sind in `nppm.json` unter `security.maintainer.{quickHandoverDays,
suspiciousGapDays,matureVersions,trustWindow}` konfigurierbar.

Wenn `Maintainer = risk` **und** `Churn = warn/risk` für dieselbe
Version zusammenkommen, blendet das Panel oben einen roten **"Möglicher
Supply-Chain-Angriff"**-Banner ein — das ist das Muster, das die
genannten realen Takeovers gemeinsam hatten.

Bei Git-Dependencies erscheint ein "Git-Paket"-Hinweis, weil OSV nur
Registry-Versionen indiziert — die anderen Scanner laufen trotzdem
normal.

![Detail: Sicherheit](screenshots/10_panel_security_de.png)

### 3.6 Lizenz

Eigener Tab für Compliance-Fragen. Klassifiziert das `license`-Feld des
Pakets in fünf Buckets:

| Bucket | Beispiele | Bedeutung |
|--------|-----------|-----------|
| `permissive` | MIT, Apache-2.0, BSD-*, ISC | Keine Auflagen |
| `weak-copyleft` | LGPL-*, MPL-2.0, EPL-2.0 | Datei-Grenze, meist akzeptiert |
| `strong-copyleft` | GPL-*, AGPL-* | Viral, Code-Freigabe für Derivate |
| `proprietary` | `UNLICENSED`, `SEE LICENSE IN …` | Keine Weitergabe ohne Vertrag |
| `unknown` | nicht im SPDX-Katalog | Nicht klassifizierbar — manueller Check |

Ein Mini-SPDX-Parser handhabt Ausdrücke wie `(MIT OR Apache-2.0)` (bei
OR gewinnt der erlaubteste Bucket — der Nutzer darf wählen) und
`MIT AND GPL-3.0` (bei AND der restriktivste — alle Auflagen gelten).
`WITH`-Klauseln (`Apache-2.0 WITH Classpath-exception-2.0`) ändern den
Bucket nicht.

Zusätzlich listet der Tab die **tatsächlich im Tarball mitgelieferten
`LICENSE*` / `COPYING*`-Dateien** auf — ein Cross-Check gegen die
Selbstauskunft im `package.json`.

**Policy in `nppm.json`:**

```json
"security": {
  "license": {
    "allowlist": ["MIT", "Apache-2.0", "BSD-*", "ISC"],
    "denylist": ["AGPL-*"],
    "treatUnknownAs": "proprietary"
  }
}
```

`allowlist` überschreibt den Bucket auf `permissive`, `denylist` auf
`proprietary` (denylist gewinnt bei Konflikt). `treatUnknownAs:
"proprietary"` zwingt jedes Paket ohne erkannte Lizenz in den manuellen
Review.

---

## 4. Globaler CVE-Scan

Der **Alle scannen**-Button in der Topbar startet einen SSE-Stream
über die Lockfiles aller konfigurierten Projekte, dedupliziert
`name@version` über die ganze Range und fragt OSV in Chunks von 50.
Der Topbar-Fortschrittsbalken zeigt Sammel- und OSV-Phase.

Die Ergebnisse landen in einem eigenen rechten Pane: jede eindeutige
`name@version`-Kombination über alle Projekte, mit Vuln-Anzahl und der
Liste der Projekte, die das Paket benutzen. Die Checkbox **nur
Treffer** filtert auf Zeilen mit bekannten CVEs.

Ein zweiter Scan ist instant für jedes `pkg@version`, das schon im
OSV-Cache liegt — nur neue Einträge kosten Netzwerk.

---

## 5. Headless-CI-Modus

`nppm scan` ist das gleiche Set an Scannern wie der Dev-Server, nur
nicht-interaktiv — zum Einklinken in eine CI-Pipeline.

```sh
nppm scan                              # alles, fail bei risk
nppm scan --project=alpha --json       # ein Projekt, maschinenlesbar
nppm scan --fail-on=warn               # strengeres Gate
nppm scan --no-osv --no-heuristics     # offline / ohne Lockfile-Sicht
```

Was der Lauf pro Projekt (bzw. pro `--project=…`-Auswahl) macht:

1. Lockfile lesen, `name@version` deduplizieren.
2. CVE-IDs bei OSV.dev abrufen (außer `--no-osv`).
3. Heuristik-Batch — Scripts / Patterns / Binaries / Maintainer /
   Lizenz — über denselben Fingerprint-Cache laufen lassen, den auch
   der Dev-Server befüllt (außer `--no-heuristics`).
4. Unused-Deps-Detektor laufen lassen (außer `--no-unused`).

Jede einzelne Scanner-Severity wird auf eine gemeinsame
`info / warn / risk`-Skala abgebildet; `--fail-on=<level>` setzt die
Schwelle für einen Non-Zero-Exit. Lizenzklassen falten dazu:
`permissive` schweigt, `weak-copyleft` und `unknown` werden zu `info`,
`strong-copyleft` zu `warn`, `proprietary` zu `risk`. OSV-Vulns sind
einheitlich `risk` (entspricht `npm audit --audit-level=high`).

Output ist standardmäßig Text; `--json` liefert maschinenlesbares
JSON, `--sarif` ein SARIF-2.1.0-Envelope, das GitHub Code Scanning
direkt frisst (`actions/upload-sarif`). Die CLI nutzt `.nppm-cache/`
und `.nppm-history/` mit — ein warmer CI-Lauf ist schnell, weil OSV-
und Fingerprint-Cache schon gefüllt sind.

Exit-Codes:

- `0` — sauber, oder alle Befunde unterhalb `--fail-on`
- `1` — mindestens ein Befund erreicht/übersteigt `--fail-on`
- `2` — Nutzungs- / Config-Fehler (falsches Flag, fehlende `nppm.json`)

Beispiel-Step in GitHub Actions:

```yaml
- run: npx nppm scan --fail-on=risk --json > nppm-report.json
```

Für Code-Scanning-Ingest:

```yaml
- run: npx nppm scan --fail-on=none --sarif > nppm.sarif
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: nppm.sarif
```

---

## 6. SBOM-Export

`nppm sbom` schreibt eine Software Bill of Materials für ein Projekt
raus. Zwei Formate:

- **CycloneDX 1.6** (Default) — OWASP-Standard, großes Security-Tool-
  Ökosystem (Trivy, Dependency-Track, OSV-Scanner).
- **SPDX 2.3** — Linux Foundation, Lizenz-/Compliance-zentriert
  (FOSSA, Fossology, SPDX-tools).

```sh
nppm sbom --project=kavula                   # CycloneDX auf stdout
nppm sbom --project=kavula --format=spdx     # SPDX 2.3 JSON
nppm sbom --project=kavula --output=bom.json # in Datei schreiben
```

`--project` ist Pflicht sobald mehr als ein Projekt konfiguriert ist.
Dieselben Daten via REST:

- `GET /api/projects/:id/sbom?format=cyclonedx` — Default
- `GET /api/projects/:id/sbom?format=spdx`

Beide Endpoints setzen `Content-Type` passend
(`application/vnd.cyclonedx+json` / `application/spdx+json`) damit
ein Proxy / Tool nach Header routen kann.

Datenquellen pro Paket:

| Feld | Quelle |
|------|--------|
| `name`, `version` | Lockfile |
| `purl` | aus name + version abgeleitet |
| sha512-Hash | Lockfile-`integrity` (base64 → hex) |
| Lizenz | Registry-Packument |
| Repository | Registry-Packument |
| `dependencies[]`-Kanten | Lockfile-`dependencies`-Map |

Keine Fingerprint-Downloads — SBOM ist Identität + Provenance, nicht
Tarball-Inhalt. Bei warmem Registry-Cache läuft das instant.

---

## 7. Eine Abhängigkeit upgraden (Upgrade-Modal)

Outdated-Cells in der Projekt-Matrix bekommen einen kleinen
`↑`-Button. Klick öffnet das Upgrade-Modal — fokussierter Per-Cell-
Flow:

1. **Plan** — zeigt welche `package.json` (Workspace) geändert würde.
2. **Zielversion** — `dist-tags.latest` aus der Registry. Der Button
   füllt `^<latest>` vor, damit das Lockfile die neue Range aufnimmt.
3. **Security-Heads-up** — Einzeiler mit den schlimmsten Signalen
   des `SecurityScanner` auf die *Zielversion*: CVEs, Install-
   Scripts, Maintainer-Wechsel, Churn. Für den vollen Bericht ins
   Detail-Panel.
4. **Diff** — geplante `package.json`-Änderung mit zwei Zeilen
   Kontext. Indent und Tail-Newline bleiben erhalten.
5. **Aktion**:
   - **Nur package.json anpassen** (immer verfügbar). Schreibt die
     Datei, legt ein Backup nach `.nppm-backups/<timestamp>/` und
     erinnert dich daran, `npm install` von Hand zu starten.
   - **Anpassen + Installieren (--ignore-scripts)**. Nur sichtbar bei
     `actions.allowInstall: true` in `nppm.json`. Streamt das
     Install-Output live im Modal.

Nach erfolgreicher Installation listet das Modal jeden Install-Time-
Lifecycle-Hook aus `node_modules/*` auf — `preinstall`, `install`,
`postinstall`, `prepare`. Pro Eintrag siehst du den Script-Body und
einen manuellen Befehl (`npm rebuild <pkg>`). Wenn das Gate offen
ist, feuert ein Per-Zeilen **Ausführen**-Button den Befehl per SSE
und streamt das Output zurück. Re-Run ist immer explizit pro Paket;
nichts läuft von selbst los.

```json
"actions": {
  "allowInstall": true
}
```

Sicherheits-Haltung: Scripts sind per Default aus. Das Gate
freischalten erlaubt die *Option* zu installieren + Hooks
nachzufeuern, aber jeder Script-Lauf bleibt ein bewusster Klick.
Wer dauerhaft im Edit-Only-Modus bleiben will, lässt die Flag aus —
nppm wird ein präziser Editor und zeigt dir den `npm install`-Befehl
zum manuellen Ausführen an.

---

## 8. Bulk-Update-Wizard

Das Per-Cell-Upgrade-Modal ist super, wenn man eine veraltete
Dependency hat. Wenn sich aber zehn davon über drei Projekte
angesammelt haben, macht der **Bulk-Update-Wizard** daraus einen
einzigen Durchlauf.

In der **globalen Matrix** bekommt jede Outdated-Cell eines *lokalen*
Projekts eine Checkbox neben der Version. (Remote-Projekte und
git-gepinnte Deps werden übersprungen — der `Upgrader` mutiert nur
lokale Dateien, und Git-Installs haben kein Registry-`latest` zum
Bumpen.) Mit dem `Outdated`-Filter sind die Kandidaten leichter zu
finden.

![Bulk-Auswahl in der Matrix](screenshots/11_bulk_select_de.png)

Eine sticky **Footer-Bar** erscheint unter der Tabelle, sobald die
erste Checkbox tickt: Live-Counter, **Auswahl löschen** und der
primäre **Auswahl aktualisieren**-Trigger. Auswahlen überleben
Filter-/Sort-Wechsel innerhalb derselben Page-Session und werden
beim nächsten Reload zurückgesetzt.

Klick auf **Auswahl aktualisieren** öffnet den Wizard:

![Bulk-Upgrade-Wizard](screenshots/12_bulk_modal_de.png)

1. **Header** — Anzahl der Picks über alle ausgewählten Cells.
2. **Summary** — `N geplant, M übersprungen — über K Projekt(e)`.
   Skip-Buckets sind identisch zur Single-Pick-API: `not-local`,
   `unknown-project`, `not-found` (die Dep wird in der globalen
   Matrix über Workspaces aggregiert; lebt sie nur in einem
   Nicht-Root-Workspace, kann ein Root-Level-Edit sie nicht
   erreichen), `no-change`.
3. **Per-Projekt-Gruppen** — jedes Projekt bekommt eine eigene
   Karte mit den getickten Picks. Pro Zeile: `name`, die geplante
   `from → to`-Range und ein Einzeiler mit den schlimmsten
   Security-Signalen auf die Zielversion (CVE-Anzahl,
   Install-Scripts, Maintainer / Churn / Lizenz).
4. **Skipped-Liste** unten — jede Auswahl, die nicht geplant
   werden konnte, mit Grund. Nichts verschwindet still.
5. **Aktionen**:
   - **Nur package.json-Änderungen anwenden** — schreibt jede
     geänderte `package.json`, ein geteiltes Backup-Verzeichnis
     pro Projekt unter `.nppm-backups/<timestamp>/`, dann der
     Hinweis pro Projekt `npm install` von Hand zu starten.
   - **Änderungen + Install pro Projekt (--ignore-scripts)** —
     dasselbe plus sequenzielles `npm install`. Ein Install pro
     Projekt, niemals parallel (der npm-Cache-Lock würde
     kollidieren). Streamt das Output aller Installs live in ein
     gemeinsames Log.

Das Live-Log ist nach Projekt gruppiert:

```
── kavula (3 picks) ──
  ✓ Backup gespeichert nach .nppm-backups/2026-05-29T11-15-02Z
    · package.json
    · package-lock.json
  ✓ vitest → package.json
  ✓ vite → package.json
  ✓ typescript → package.json

  $ npm install --ignore-scripts --no-audit --no-fund
    (cwd: /home/swe/Dokumente/Projekte/pkg/kavula)

  …
  Install fertig (Exit 0)

── swipemeister (2 picks) ──
  ...
```

Ein fehlgeschlagener Install in einem Projekt erscheint als `error`,
bricht aber den Lauf für die anderen Projekte nicht ab —
Teilerfolg ist über die Backup-Ordner wiederherstellbar.

Der Wizard bietet **keinen** "Lifecycle-Scripts ausführen"-Schritt
(das Single-Package-Modal schon). Wenn nach einem Bulk-Upgrade
Scripts nachgefeuert werden müssen, das betroffene Paket in der
Per-Projekt-Matrix einzeln öffnen und den dortigen per-Script
Ausführen-Button nutzen.

> 💡 **Tipp:** Den `Outdated`-Filter mit der Suchbox kombinieren,
> um nur ein Ökosystem auf einmal zu bumpen — z.B. `vite`
> eintippen, um `vite`, `vitest`, `@vitejs/*` über alle Projekte
> auf einen Schlag zu erwischen.

---

## 9. Sprache wechseln

Die Flaggen oben rechts schalten die UI-Sprache. Default ist Englisch,
Deutsch ist mitgeliefert. Eine dritte Sprache hinzufügen ist ein
Drei-Schritt-Edit — siehe [`CLAUDE.md`](../CLAUDE.md) für die
Anleitung.

Die Sprachwahl wird in `localStorage` (`nppm.lang`) gemerkt und beim
nächsten Page-Load wirksam.