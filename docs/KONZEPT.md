# HomeCockpit – Konzept (Stand 08.11.2026 abends, nach Abgleich mit einem echten Tablet-Dashboard)

## Ziel
Dashboards in Home Assistant **nach Regeln automatisch** aufbauen, statt jede Karte von Hand zu pflegen – aber **ohne YAML**: ein grafischer Editor für Filter, Zugehörigkeiten, Kartenarten und Darstellung. Neue Geräte erscheinen von selbst am richtigen Platz, sobald Bereich/Label stimmen.

Grundsatz wie bei Home Rhythm: **so viel HA wie möglich** (Bereiche, Etagen, Labels, Geräteklassen, Standardkarten), HomeCockpit ergänzt nur die Regeln und den Editor.

## Modell
**Neu nach dem Abgleich mit dem Tablet-Dashboard:** Das Grundmuster ist *Navigation*, nicht „lange Etagenseite“.
```
Dashboard
├─ Handseiten vorne      unverändert übernommen (z. B. Home mit Uhr, Wetter, Kamera)
├─ Etage  (Unterseite)   je Bereich ein Raumknopf (Kachel mit Heizung/Temperatur) + „Offen“ (live)
│  └─ Raum (Unterseite)  links Geräte, rechts Klima – aus Bausteinen; Zurück-Pfeil = back_path
├─ Handseiten hinten     unverändert (DSL, Heizung, Keller, Garten, Energie …)
└─ Nicht zugeordnet      gruppiert nach Grund
Baustein = Filter + Kartenart + Darstellung (+ limit, shared, visible_state)
```
- **Handseite mit gleichem Pfad** wie ein Raum/eine Etage ersetzt die generierte Seite (z. B. Garten bleibt handgemacht).
- **Erster passender Baustein gewinnt** (keine doppelten Karten); rechte Spalte (Klima) vergibt zuerst.
- **Namen statt IDs** für Bereiche, Etagen, Labels, Pfade.
- **Strategien sind nicht live** → kein Zustandsfilter im Code; Zustände nur über HA-`visibility` (`visible_state`).
- Weitere Ansichtsarten („je Label“, „je Domäne“) bleiben möglich, sind aber nicht mehr Stufe 1.
- **Generatoren** („je …“) vervielfachen Ansichten/Abschnitte und geben ihren Wert nach unten weiter (z. B. „Bereich = aktueller“). Im Editor blau markiert.
- **Filter**: Gruppen mit UND, Gruppen untereinander ODER (wie Home-Rhythm-Bedingungen). Kriterien: Label, Bereich, Etage, Domäne, Geräteklasse, Integration, Gerät, Name enthält, Zustand/Wert, Entitätskategorie. Dazu **„Nicht:“**-Ausschlüsse; in HA ausgeblendete Entitäten und Diagnose/Konfig-Entitäten standardmäßig raus.
- **Kartenart**: Kachel (tile), Schaltfläche, Liste (entities), Thermostat, Verlauf, Home-Rhythm-Raumkarte, später **Kartenvorlagen** (beliebige Karte als YAML mit Platzhaltern `{entity}`, `{area}`, `{name}`), Modus „je Entität“ oder „eine Karte für alle“.
- **Darstellung**: Spalten, Bereichsnamen im Namen weglassen, Farbe nach Zustand, Kachel-Funktionen (z. B. Helligkeit, Position).
- **Reihenfolge**: Name / Zustand / Hand / Label-Reihenfolge. **Wenn leer**: ausblenden oder Hinweis.
- **Ausnahmen** je Entität: ausblenden, an den Anfang, andere Kartenart. Gespeichert als Liste, damit sie nachvollziehbar bleiben.
- **Handkarten**: Einzelstücke (z. B. Markdown mit Hausmodus) fest an einer Stelle einfügen – nicht in Regeln pressen.

## Editor (siehe Entwurf)
1. **Aufbau**: links Gliederung (Baum), Mitte Baustein-Editor mit Trefferliste, rechts Live-Vorschau mit den echten Ansichten. Klick auf eine Karte → **„Warum ist diese Karte hier?“** (Ansicht, Abschnitt, Baustein, Regel) mit „hier ausblenden“, „nur diese anders darstellen“.
2. **Nicht zugeordnet**: Entitäten, die kein Baustein erfasst, mit Grund (z. B. „Bereich hat keine Etage“, „Schalter ohne Label licht“).
3. **Mit Bestand abgleichen**: bestehende Dashboards lesen (`lovelace/config`), Muster erkennen (gleicher Aufbau auf mehreren Unterseiten, gleiche button-card-Vorlage n-mal), Vorschläge zum Übernehmen; Abdeckung: im Bestand / abgedeckt / fehlen (mit Grund) / neu dazu.
4. **Labels zuordnen** (geplant): viele Entitäten auf einmal mit Labels/Bereichen versehen (HA `config/entity_registry/update`). Ohne saubere Labels funktioniert das Prinzip nicht.
5. **Kartenvorlagen** (geplant): eigene Kartenarten aus vorhandenen Karten ableiten, mit Vorschau.
Gerätesuche überall nach Teilwörtern (Name, Bereich, deutsche Geräteart).

## Architektur (Vorschlag)
- **Frontend-only als Start** (HACS „Dashboard“-Plugin, eine JS-Datei, kein Build):
  - Dashboard-Strategie `custom:home-cockpit` (`ll-strategy-dashboard-home-cockpit`) erzeugt die Ansichten-Liste; je Ansicht eine View-Strategie (`ll-strategy-view-home-cockpit-…`), die die Karten erst beim Öffnen baut (schneller Start).
  - Daten aus dem Frontend-`hass`-Objekt: `hass.entities` (area_id, device_id, labels, hidden, entity_category), `hass.devices`, `hass.areas`, `hass.floors`, `hass.states`. Label-Namen über `config/label_registry/list`.
  - **Editor**: HA zeigt für Strategien nur einen kleinen Dialog (`getConfigElement`). Darum erzeugt die Strategie zusätzlich eine Ansicht **„⚙ HomeCockpit“** (nur für Admins sichtbar), in der der volle Editor läuft und die eigene Dashboard-Konfiguration speichert (`lovelace/config/save`).
- **Später optional** eine kleine Integration als Speicher, falls Bausteine zwischen Dashboards geteilt werden sollen oder Nicht-Admins Ausnahmen setzen dürfen.

## Risiken / „verrennen wir uns?“
- Strategien werden bei jedem Laden neu berechnet; „Kontrolle übernehmen“ in HA friert das Dashboard als YAML ein und beendet die Automatik → im Editor deutlich warnen, Ausnahmen statt Handänderung.
- Labels/Bereiche müssen gepflegt sein → Abgleich + „Nicht zugeordnet“ + Label-Werkzeug sind Pflicht, nicht Kür.
- Custom Cards (button-card, Mushroom, home-rhythm-card) müssen geladen sein → Kartenart nur anbieten, wenn das Element existiert (`customElements.get`).
- Interne Frontend-APIs ändern sich gelegentlich → nur dokumentierte Strategie-Schnittstelle und Websocket-Befehle nutzen.
- Abgrenzung: Mushroom Strategy, Area Dashboard Strategy, Bonbon Strategy, auto-entities. Keines hat Regeln + grafischen Editor + Begründung + Abgleich mit dem Bestand.

## Stufenplan
1. **Gerüst lauffähig** – v0.1.0, abgelöst durch v0.2.0, **Nächster Schritt: Test in HA** (zuerst in einem neuen Test-Dashboard).
2. **Abgleich** – Tablet-Dashboard erledigt (Muster: Etage → Raumknopf → Raumseite). Offen: Registrys prüfen (haben die Entitäten Bereiche? Keller/Garten/Einfahrt als Etage?), weitere Dashboards.
3. **Editor-Ansicht „⚙ HomeCockpit“** – **v0.2.0 gebaut** (im Browser mit Testdaten geprüft, noch nicht in echtem HA): Gliederung, Baustein-Editor mit UND/ODER/Nicht, Live-Vorschau mit echten HA-Karten, Warum-Panel, Ausnahmen per Haken, Kartenvorlagen aus vorhandenen Karten, eigene Seiten, Bestand übernehmen, Nicht zugeordnet, Speichern/Rückgängig.
4. Ausnahmen, Handkarten, Kartenvorlagen, Home-Rhythm-Raumkarte.
5. Abgleich im Editor, Label-Werkzeug, GitHub + HACS.

## Entscheidung Plugin vs. Integration (08.11.)
Start als **Plugin** (eine JS-Datei, HACS-Typ Dashboard). Integration nur, falls Bausteine für mehrere Dashboards (Handy/Tablet) geteilt oder Nicht-Admins Ausnahmen setzen sollen – dann nur als Speicher.
Ideen aus Bonbon Strategy: Selektor-Kurzschrift (`domain.*[device_class=…]:not(…):hide(…)`) als Textform der Regeln, Labels als Steuerung (`hidden`, `favorite`, `order_…`).

## Offene Fragen
- Sind Bereiche/Etagen in HA so gepflegt wie die Raumseiten im Dashboard? (Registrys fehlen noch)
- Reihenfolge der Bereiche: liefert `hass.areas` die in HA eingestellte Reihenfolge? Bis geklärt: `area_order`.
- Leitentität im Raumknopf: Heizung oder Raumthermometer? Vorerst `room_lead`.
- Ein Dashboard oder mehrere (Handy / Wandtablet) mit gemeinsamen Bausteinen?
- Ansichtsart: nur „Sections“ (aktueller HA-Standard) oder auch Masonry?
- Nicht-Admins: nur ansehen, oder dürfen sie Ausnahmen setzen?
