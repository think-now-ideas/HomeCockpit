# HomeCockpit

Dashboard-Strategie für Home Assistant: baut Dashboards **nach Regeln** (Etagen, Bereiche, Labels, Geräteklassen) – mit einem **grafischen Editor** statt YAML.

- **Etage → Raumknöpfe → Raumseite**, automatisch aus den Bereichen und Etagen in Home Assistant
- **Bausteine**: „diese Karte, mit dieser Konfiguration, für alle Geräte mit Klasse / Label / Stichwort / Bereich“
- **Kartenvorlagen** aus vorhandenen Karten (auch Mushroom, button-card …): Gerät wird zu `{entity}`, Name zu `{name}`
- **Feste Seiten** bleiben erhalten (Startseite mit Uhr, Kamera …) – „Aus Bestand übernehmen“ liest ein bestehendes Dashboard ein
- **Warum ist diese Karte hier?**, Ausnahmen per Haken, **Nicht zugeordnet** mit Grund
- Editor-Tab **„HomeCockpit“** nur für Admins, Speichern mit Rückgängig

> Status: **frühe Testversion (0.2.x)**. Bitte zuerst in einem neuen Test-Dashboard ausprobieren.

## Installation (HACS)
1. HACS → ⋮ → **Benutzerdefinierte Repositories** → `https://github.com/think-now-ideas/HomeCockpit`, Typ **Dashboard** → Hinzufügen.
2. **HomeCockpit** suchen → **Herunterladen** → Browser neu laden.
3. Einstellungen → Dashboards → **Dashboard hinzufügen** → unter „Community-Dashboards“ **HomeCockpit** wählen.
4. Dashboard öffnen → Tab **HomeCockpit** → z. B. **Aus Bestand übernehmen**.

Ohne den Dialog (HA vor 2026.5): neues leeres Dashboard → ✏️ → ⋮ → Raw-Konfigurationseditor:
```yaml
strategy:
  type: custom:home-cockpit
```

## Wichtig
- Im erzeugten Dashboard **nicht** „Kontrolle übernehmen“ wählen – das friert alles als YAML ein. Änderungen im Tab HomeCockpit.
- Strategien werden beim Öffnen berechnet; neue Geräte erscheinen automatisch, sobald Bereich/Label stimmen.

## Datenschutz
Die Datei liest nur, was das Home-Assistant-Frontend ohnehin hat (Entitäten, Geräte, Bereiche, Etagen, Labels, Dashboards). Sie lädt nichts aus dem Internet und sendet nichts nach außen. Gespeichert wird nur in der Konfiguration des eigenen Dashboards (und eine Sicherung für „Rückgängig“ im Browser).

## Konzept
Siehe [docs/KONZEPT.md](docs/KONZEPT.md).
