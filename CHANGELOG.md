# Änderungen

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
