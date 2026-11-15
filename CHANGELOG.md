# Änderungen

## 0.3.10 – 15.11.2026
- **Nicht zugeordnet aufgeräumt:**
  - System-Entitäten (Personen, Automationen, Skripte, Szenen, Timer, TTS, Updates, Geräte-Tracker …) zählen nicht mehr mit; die Seite nennt nur ihre Anzahl.
  - Neue Gruppe **„verwaist“** ganz oben: nicht verfügbar oder unbekannt und ohne Bereich – meist Reste, die man in HA löschen kann.
  - **Ganze Gruppen ignorieren** im Editor (Werkzeuge › Nicht zugeordnet): Integration oder Domäne mit einem Klick (die häufigsten werden vorgeschlagen), dazu Stichwörter. Wieder zählen mit „×“. Gespeichert als `ignore: [{ integration: unifi }, …]`; Bausteine sind davon nicht betroffen.
- **Raumknöpfe ohne Heizung/Temperatur** sind jetzt schmale Kacheln wie die anderen statt großer Schaltflächen.
- **Verlauf in Home-Rhythm-Räumen:** Ist dort kein Raumfühler eingestellt, nimmt der Verlauf nie den eingebauten Fühler eines Thermostats (auch nicht von noch nicht gesteuerten), sondern einen eigenen Raumfühler.

## 0.3.9 – 15.11.2026
- **Home Rhythm (ab 0.9.13):** Räume, die Home Rhythm kennt, bekommen
  - auf der Etagenseite den Raumknopf von Home Rhythm (Symbol → Bedien-Fenster, übrige Fläche → Raumseite),
  - auf der Raumseite rechts oben die Home-Rhythm-Karte (Format „tablet“) statt der Thermostate; Thermostate und alles an deren Geräten (z. B. der Fühler im Thermostat) gehören zu dieser Karte,
  - als Verlauf den Raumfühler, den Home Rhythm verwendet – auch wenn er in einem anderen Bereich hängt.
  - Abschaltbar im Editor unter „Etagen & Raumknöpfe“ (`home_rhythm: false`); ein fest eingestellter `room_lead` hat beim Raumknopf Vorrang. Ohne Home Rhythm bleibt alles wie bisher.
- **„Nicht zugeordnet“ erreichbar:** Dashboards ohne Reiter bekommen unten auf der Startseite den Verweis „Nicht zugeordnet (N)“ – nur für Admins und nur, wenn etwas fehlt.
- **Namen kürzen:** Trennzeichen nach dem Bereichsnamen fallen mit weg („Küche-Backofen-Mini“ → „Backofen-Mini“); gekürzt wird nur ein ganzes Wort („Bad“ kürzt „Badewanne“ nicht mehr).
- **Raumknopf ohne Home Rhythm:** Temperaturen von Messgeräten (Zähler, Zwischenstecker) zählen nicht mehr als Raumtemperatur.
- Home-Rhythm-Baustein nutzt `area:` statt einer erratenen Raum-ID (`home_rhythm_rooms` gilt weiter, falls gesetzt).

## 0.3.8 – 15.11.2026
- Neues Logo: im Editor-Kopf (Schrift passt sich hellem und dunklem Design an), in der README und als Dateien im Ordner `brand/`

## 0.3.7 – 15.11.2026
- Hinweistext zu fest übernommenen Seiten: LineGuard heißt jetzt HomeLines

## 0.3.6 – 08.11.2026
- Verknüpfte Seiten: „Unterseite“ ausschalten wirkt jetzt (vorher galt weiter die Einstellung der Quellseite)

## 0.3.5 – 08.11.2026
- Vorschau: Pop-up-Karten (Bubble Card pop-up u. ä.) nur als Platzhalter – sie haben den ganzen Editor ausgeblendet

## 0.3.4 – 08.11.2026
- Verknüpfte Seiten: Fehler werden angezeigt statt leerer Seite; „Verknüpfung prüfen“ im Editor (Dashboard, Seite, Karten, geladene Kartentypen)
- Abschnittsbreite (column_span) wird an die Spaltenzahl der Seite angepasst

## 0.3.3 – 08.11.2026
- Symbol-Auswahl mit Vorschau (HA-Symbolsuche, wenn verfügbar; sonst Liste häufiger Symbole)
- Verknüpfte Seiten: eine Seite aus einem anderen Dashboard live einbinden (z. B. LineGuard „Internet“) – gepflegt wird sie dort
- „In feste Seite umwandeln“ macht aus einer verknüpften Seite eine bearbeitbare Kopie

## 0.3.2 – 08.11.2026
- Bestand übernehmen: „Nur fehlende Seiten ergänzen“ – bearbeitete feste Seiten bleiben erhalten
- Menüseiten (z. B. „weiteres“) werden nicht mehr fälschlich als Etage erkannt
- Pfad-Zuordnungen auf Seiten, die jetzt feste Seiten sind, werden entfernt
- Räume auf Etagen, die nicht im Dashboard sind (z. B. Außenbereich), werden als feste Seite übernommen statt weggelassen

## 0.3.1 – 08.11.2026
- Öffnen einer Karte im HA-Karteneditor zählt nicht mehr als „ungespeicherte Änderung“
- Releases werden automatisch angelegt, sobald eine neue Version auf GitHub liegt

## 0.3.0 – 08.11.2026
- Feste Seiten im Editor bearbeitbar: jede Seite in der Gliederung, Karten verschieben (auch zwischen Abschnitten), duplizieren, löschen, Abschnitte anlegen/löschen, Titel/Pfad/Symbol ändern
- Karte bearbeiten: grafischer Karteneditor von Home Assistant (wenn verfügbar), sonst als Text (JSON)
- „+ Karte“: leere Kachel oder Karte aus einem anderen Dashboard einfügen
- „Automatisch machen“: feste Karte wird zur Vorlage + Regel mitten in der festen Seite (`custom:home-cockpit-block`)
- Versionsprüfung: Hinweis, wenn der Browser eine ältere Datei geladen hat als auf dem HA-Server liegt
- ab jetzt Versionen als GitHub-Releases

## 0.2.3
- Etagen auch über Abkürzungen (EG/OG/DG/KG), Aliase und Raumknöpfe erkennen; tote Knöpfe in „Nicht zugeordnet“

## 0.2.2
- Bauplan kopieren ohne HTTPS, Download als Datei

## 0.2.1
- erste HACS-Fassung: Strategie + Editor-Tab, Anmeldung im Dialog „Dashboard hinzufügen“
