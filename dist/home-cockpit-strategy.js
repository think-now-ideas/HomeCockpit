/*
 * HomeCockpit – Dashboard-Strategie für Home Assistant
 * ====================================================
 * Version 0.3.1 · Stand 08.11.2026 · OFFLINE + IM BROWSER MIT TESTDATEN GETESTET,
 * NOCH NICHT IN EINEM ECHTEN HOME ASSISTANT GETESTET.
 *
 * Neu in 0.3: feste Seiten im Editor bearbeitbar (Karten verschieben, bearbeiten, hinzufügen),
 * „Automatisch machen“ (Baustein mitten in einer festen Seite: `custom:home-cockpit-block`),
 * Versionsprüfung gegen die Datei auf dem HA-Server.
 *
 * Neu in 0.2: Editor-Ansicht „⚙ HomeCockpit“ (nur Admins), eigene Seiten (`pages`),
 * Kartenvorlagen (`templates`, Platzhalter {entity} {name} {area} {entities}),
 * Ausnahmen je Baustein (`exclude`).
 *
 * Grundmuster (abgeleitet aus dem bestehenden Tablet-Dashboard):
 *
 *   Handseiten (views_before)        → unverändert übernommen, z. B. „Home“ mit Uhr, Wetter, Kamera
 *   Etage  (Unterseite, generiert)   → je Bereich ein Raumknopf (Kachel mit Heizung/Temperatur)
 *   Raum   (Unterseite, generiert)   → links Geräte, rechts Klima – aus „Bausteinen“
 *   Handseiten (views_after)         → unverändert übernommen, z. B. „DSL“, „Heizung“, „Garten“
 *   Nicht zugeordnet (generiert)     → was nirgends erscheint, mit Grund
 *
 * Regeln, die das Verhalten bestimmen:
 *   - Ein Baustein = Filter (any = ODER-Gruppen, darin UND; not = Ausschlüsse) + Kartenart.
 *   - Der ERSTE passende Baustein „bekommt“ die Entität (keine doppelten Karten).
 *     Ausnahme: `shared: true` – der Baustein zeigt auch schon vergebene Entitäten (z. B. Verlauf).
 *   - Bereiche, Etagen und Labels dürfen als NAME oder ID angegeben werden.
 *   - Gibt es eine Handseite mit demselben Pfad wie ein Raum, wird keine Raumseite erzeugt;
 *     der Raumknopf führt dann auf die Handseite (z. B. „Garten“ bleibt handgemacht).
 *   - Entitäten auf Handseiten gelten als „zugeordnet“ und erscheinen nicht unter „Nicht zugeordnet“.
 *
 * WICHTIG – Strategien sind NICHT live: Die Karten werden beim Öffnen der Ansicht berechnet.
 * Darum gibt es keinen Filter auf Zustände. Für „nur zeigen, wenn offen“ gibt es `visible_state`,
 * das in die HA-eigene, live ausgewertete `visibility`-Bedingung übersetzt wird.
 *
 * Datenschutz/Sicherheit: Die Strategie liest nur, was das Frontend ohnehin hat
 * (hass.entities, hass.devices, hass.areas, hass.floors, hass.states) plus die Label-Liste
 * per Websocket. Sie schreibt nichts, lädt nichts nach und sendet nichts nach außen.
 */

const VERSION = "0.3.1";
const LOG = "[home-cockpit]";

// ---------------------------------------------------------------------------
// Kleine Helfer
// ---------------------------------------------------------------------------

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const lower = (s) => String(s ?? "").toLowerCase();

/** Pfad aus einem Namen: „1. Obergeschoss“ → „1-obergeschoss“, „Küche“ → „kueche“. */
function slug(name) {
  return lower(name)
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Sucht in einem Objekt {id: {name}} nach ID oder Name (Groß/Klein egal). */
function resolveId(map, idOrName, idKey) {
  if (!idOrName) return null;
  if (map[idOrName]) return idOrName;
  const wanted = lower(idOrName);
  const hit = Object.values(map).find((x) => lower(x.name) === wanted);
  return hit ? hit[idKey] : null;
}

/** Wert aus einer Zuordnung, die nach Bereichs-ID ODER Bereichsname indiziert sein darf. */
function byArea(map, area) {
  if (!map || !area) return undefined;
  if (map[area.area_id] !== undefined) return map[area.area_id];
  const key = Object.keys(map).find((k) => lower(k) === lower(area.name));
  return key !== undefined ? map[key] : undefined;
}

/** Alle Entitäts-IDs, die irgendwo in einer (Hand-)Konfiguration vorkommen. */
function collectEntityIds(node, out = new Set()) {
  if (Array.isArray(node)) {
    node.forEach((n) => collectEntityIds(n, out));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if ((k === "entity" || k === "entity_id") && typeof v === "string") out.add(v);
      else if (k === "entities" && Array.isArray(v)) {
        v.forEach((x) => (typeof x === "string" ? out.add(x) : collectEntityIds(x, out)));
      } else collectEntityIds(v, out);
    }
  }
  return out;
}

/** Alle Pfade von Ansichten. */
/**
 * Absoluter Pfad innerhalb dieses Dashboards. HA erwartet bei navigation_path/back_path
 * „/dashboard-xyz/ansicht“. Das Dashboard kennt seine eigene URL nicht → aus der Adresse lesen,
 * oder in der Konfiguration `dashboard_path: /dashboard-tablet` fest angeben.
 */
function absPath(config, path) {
  if (!path || path.startsWith("/")) return path;
  const base = config.dashboard_path || "/" + (globalThis.location?.pathname.split("/")[1] || "lovelace");
  return `${base}/${path}`;
}

const pathsOf = (views) => new Set(asList(views).map((v) => v && v.path).filter(Boolean));

// ---------------------------------------------------------------------------
// Labels (Name → ID). Kurz zwischengespeichert, damit neue Labels ohne Neuladen ankommen.
// ---------------------------------------------------------------------------

let _labels = null;
let _labelsAt = 0;
async function loadLabels(hass) {
  if (_labels && Date.now() - _labelsAt < 60_000) return _labels;
  const map = {};
  try {
    const labels = await hass.callWS({ type: "config/label_registry/list" });
    for (const l of labels) {
      map[lower(l.label_id)] = l.label_id;
      map[lower(l.name)] = l.label_id;
    }
  } catch (err) {
    // Ohne Admin-Rechte evtl. nicht lesbar → dann gehen nur Label-IDs.
    console.warn(LOG, "Label-Liste nicht lesbar, nur Label-IDs möglich", err);
  }
  _labels = map;
  _labelsAt = Date.now();
  return map;
}

// ---------------------------------------------------------------------------
// Modell: Entitäten, Bereiche, Etagen aufbereiten
// ---------------------------------------------------------------------------

/** Bereich einer Entität: eigener Bereich, sonst der des Geräts. */
function areaOf(hass, ent) {
  if (ent.area_id) return ent.area_id;
  const dev = ent.device_id ? (hass.devices || {})[ent.device_id] : null;
  return dev ? dev.area_id || null : null;
}

/**
 * Alle Entitäten mit den Feldern, nach denen gefiltert wird.
 * Ausgeblendete und Diagnose-/Konfig-Entitäten fallen raus (mit Grund, für „Nicht zugeordnet“).
 */
function collectEntities(hass) {
  const out = [];
  const areas = hass.areas || {};
  for (const [entityId, ent] of Object.entries(hass.entities || {})) {
    const st = hass.states[entityId];
    if (!st) continue; // gerade nicht vorhanden (deaktiviert, Integration lädt nicht)
    const areaId = areaOf(hass, ent);
    const area = areaId ? areas[areaId] : null;
    out.push({
      entity_id: entityId,
      domain: entityId.split(".")[0],
      device_class: st.attributes.device_class || null,
      labels: ent.labels || [],
      area_id: areaId,
      floor_id: area ? area.floor_id || null : null,
      platform: ent.platform || null,
      device_id: ent.device_id || null,
      name: st.attributes.friendly_name || entityId,
      hidden: !!ent.hidden,
      category: ent.entity_category || null,
    });
  }
  return out;
}

/**
 * Löst die Struktur auf: welche Etagen, welche Bereiche, welche Pfade.
 * Wird von allen Strategien gleich berechnet, damit Pfade/Rückwege übereinstimmen.
 */
function buildLayout(config, hass) {
  const floorsAll = hass.floors || {};
  const areasAll = hass.areas || {};
  const handPaths = new Set([...pathsOf(config.views_before), ...pathsOf(config.views_after)]);

  // Etagen: Reihenfolge aus der Konfiguration, sonst nach Ebene (level)
  let floorIds;
  if (config.floors) {
    floorIds = asList(config.floors).map((f) => {
      const id = resolveId(floorsAll, f, "floor_id");
      if (!id) console.warn(LOG, `Etage „${f}“ nicht gefunden`);
      return id;
    }).filter(Boolean);
  } else {
    floorIds = Object.values(floorsAll)
      .sort((a, b) => (a.level ?? 0) - (b.level ?? 0))
      .map((f) => f.floor_id);
  }

  const floors = floorIds.map((id) => ({
    floor_id: id,
    name: floorsAll[id].name,
    icon: floorsAll[id].icon || "mdi:home-floor-" + (floorsAll[id].level ?? 0),
    areaIds: Object.values(areasAll).filter((a) => a.floor_id === id).map((a) => a.area_id),
  }));

  // Optionale Pseudo-Etage für Bereiche ohne Etage (z. B. Garten, Einfahrt)
  if (config.outside && asList(config.outside.areas).length) {
    floors.push({
      floor_id: "_outside",
      name: config.outside.name || "Außen",
      icon: config.outside.icon || "mdi:tree",
      areaIds: asList(config.outside.areas).map((a) => {
        const id = resolveId(areasAll, a, "area_id");
        if (!id) console.warn(LOG, `Bereich „${a}“ (outside) nicht gefunden`);
        return id;
      }).filter(Boolean),
    });
  }

  const sortAreas = (ids) => {
    const order = asList(config.area_order).map((a) => resolveId(areasAll, a, "area_id"));
    return [...ids].sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      return areasAll[a].name.localeCompare(areasAll[b].name, "de");
    });
  };

  const homePath = config.home_path || (asList(config.views_before)[0] || {}).path || "uebersicht";
  const pathOverride = (area) => byArea(config.paths, area);

  for (const f of floors) {
    f.path = byArea(config.paths, { area_id: f.floor_id, name: f.name }) || slug(f.name);
    f.hand = handPaths.has(f.path); // Handseite ersetzt die generierte Etagenseite
  }
  // Pfade müssen eindeutig sein: Raum „Keller“ auf Etage „Keller“ → keller-raum
  const floorPaths = new Set(floors.filter((f) => !f.hand).map((f) => f.path));
  const usedAreaPaths = new Set();
  for (const f of floors) {
    f.areas = sortAreas(f.areaIds).map((id) => {
      const area = areasAll[id];
      let path = pathOverride(area) || slug(area.name);
      if (!handPaths.has(path)) {
        const base = path; let n = 1;
        while (floorPaths.has(path) || usedAreaPaths.has(path)) path = `${base}-${n++ === 1 ? "raum" : n}`;
      }
      usedAreaPaths.add(path);
      return {
        area_id: id,
        name: area.name,
        icon: area.icon || "mdi:door",
        path,
        hand: handPaths.has(path), // Handseite ersetzt die generierte Raumseite
      };
    });
  }
  return { floors, homePath, handPaths };
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

/** Prüft eine UND-Gruppe, z. B. {domain: "switch", label: "licht"}. */
function matchGroup(e, g, ctx) {
  if (g.domain && !asList(g.domain).includes(e.domain)) return false;
  if (g.device_class && !asList(g.device_class).includes(e.device_class)) return false;
  if (g.integration && !asList(g.integration).includes(e.platform)) return false;
  if (g.entity_id && !asList(g.entity_id).includes(e.entity_id)) return false;
  if (g.area) {
    const ids = asList(g.area).map((a) => resolveId(ctx.hass.areas || {}, a, "area_id"));
    if (!ids.includes(e.area_id)) return false;
  }
  if (g.floor) {
    const ids = asList(g.floor).map((f) => resolveId(ctx.hass.floors || {}, f, "floor_id"));
    if (!ids.includes(e.floor_id)) return false;
  }
  if (g.name_contains) {
    // mehrere Teilwörter = eines davon muss vorkommen
    const n = lower(e.name) + " " + lower(e.entity_id);
    if (!asList(g.name_contains).some((w) => n.includes(lower(w)))) return false;
  }
  if (g.label) {
    // Name oder ID, Groß/Klein egal
    const wanted = asList(g.label).map((l) => lower(ctx.labels[lower(l)] || l));
    if (!wanted.some((l) => e.labels.some((x) => lower(x) === l))) return false;
  }
  return true;
}

/** Baustein: mindestens eine `any`-Gruppe passt (oder keine angegeben) und keine `not`-Gruppe. */
function matchBlock(e, block, ctx) {
  const any = asList(block.any);
  if (any.length && !any.some((g) => matchGroup(e, g, ctx))) return false;
  if (asList(block.not).some((g) => matchGroup(e, g, ctx))) return false;
  return true;
}

/** Grundausschluss: in HA ausgeblendet, Diagnose/Konfig, oder in `exclude` gelistet. */
function excludedWhy(e, config) {
  if (asList(config.exclude).includes(e.entity_id)) return "in „exclude“ gelistet";
  if (e.hidden) return "in HA ausgeblendet";
  if (e.category) return e.category === "diagnostic" ? "Diagnose-Entität" : "Konfigurations-Entität";
  return null;
}

/**
 * Verteilt die Entitäten eines Bereichs auf die Bausteine (erster Treffer gewinnt).
 * Rückgabe: [{block, hits:[e]}] in Baustein-Reihenfolge plus Set der vergebenen IDs.
 */
function assignBlocks(ents, blocks, ctx, opts = {}) {
  const claimed = new Set();
  const result = blocks.map((block) => ({ block, hits: [] }));
  // Vergabe-Reihenfolge: `order` (Indizes) oder Baustein-Reihenfolge; geteilte Bausteine zuletzt
  const order = opts.order || result.map((_, i) => i);
  for (const pass of [false, true]) {
    order.map((i) => result[i]).forEach((r) => {
      if (!!r.block.shared !== pass) return;
      const blockEx = asList(r.block.exclude); // Ausnahmen je Baustein („hier nicht zeigen“)
      let hits = ents.filter((e) => (pass || !claimed.has(e.entity_id)) && !blockEx.includes(e.entity_id)
        && matchBlock(e, r.block, ctx));
      hits.sort((a, b) => a.name.localeCompare(b.name, "de"));
      if (r.block.limit) hits = hits.slice(0, r.block.limit); // erst begrenzen, dann vergeben
      if (!pass) hits.forEach((e) => claimed.add(e.entity_id));
      r.hits = hits;
    });
  }
  return { result, claimed };
}

// ---------------------------------------------------------------------------
// Karten bauen
// ---------------------------------------------------------------------------

/** „Küche Dimmer Schrank“ im Bereich „Küche“ → „Dimmer Schrank“. undefined = HA-Standardname. */
function shortName(name, areaName, enabled) {
  if (!enabled || !areaName) return undefined;
  const re = new RegExp("^\\s*" + areaName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*", "i");
  const s = name.replace(re, "").trim();
  return s && s !== name ? s.charAt(0).toUpperCase() + s.slice(1) : undefined;
}

// ---------------------------------------------------------------------------
// Kartenvorlagen: beliebige Karte mit Platzhaltern
// ---------------------------------------------------------------------------

/**
 * Ersetzt Platzhalter in einer Karte (tief, auch in tap_action usw.).
 * Ein Wert, der GENAU "{entities}" ist, wird durch die Liste der Entitäts-IDs ersetzt.
 */
function fillPlaceholders(node, map, list) {
  if (typeof node === "string") {
    if (node === "{entities}") return list || [];
    return node.replace(/\{(entity|name|area|area_id|entity_name)\}/g, (m) => (map[m] !== undefined ? map[m] : m));
  }
  if (Array.isArray(node)) return node.map((n) => fillPlaceholders(n, map, list));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = fillPlaceholders(v, map, list);
    return out;
  }
  return node;
}

/**
 * Macht aus einer vorhandenen Karte eine Vorlage: die Entität wird zu {entity},
 * ein gesetzter Name zu {name}. Karten mit `entities`-Liste werden „eine Karte für alle“.
 */
function makeTemplate(card, label) {
  const ent = typeof card.entity === "string" ? card.entity : null;
  const nm = typeof card.name === "string" && card.name.trim() ? card.name : null;
  const per = !ent && Array.isArray(card.entities) ? "all" : "entity";
  const walk = (n, key) => {
    if (typeof n === "string") {
      if (nm && key === "name" && n === nm) return "{name}";
      return ent ? n.split(ent).join("{entity}") : n;
    }
    if (Array.isArray(n)) return n.map((x) => walk(x, key));
    if (n && typeof n === "object") {
      const o = {};
      for (const [k, v] of Object.entries(n)) o[k] = per === "all" && k === "entities" && n === card ? "{entities}" : walk(v, k);
      return o;
    }
    return n;
  };
  return { label: label || card.type, per, card: walk(card, null) };
}

/** Live-Sichtbarkeit (HA wertet `visibility` selbst aus, auch nach dem Generieren). */
function withVisibility(card, block, entityId) {
  if (block.visible_state === undefined) return card;
  return {
    ...card,
    visibility: [{ condition: "state", entity: entityId, state: String(block.visible_state) }],
  };
}

/** Wartet kurz, ob eine Custom Card geladen wird (Ressourcen laden manchmal später). */
async function cardAvailable(tag, ms = 3000) {
  if (customElements.get(tag)) return true;
  return Promise.race([
    customElements.whenDefined(tag).then(() => true),
    new Promise((r) => setTimeout(() => r(false), ms)),
  ]);
}

async function buildCards(block, ents, area, config) {
  const kind = block.card || "tile";
  const short = (e) => shortName(e.name, area && area.name, config.shorten_names !== false);
  const extra = block.card_options || {}; // beliebige Zusatzoptionen je Karte durchreichen

  switch (kind) {
    case "entities":
      return [{
        type: "entities",
        title: block.title === false ? undefined : block.name,
        show_header_toggle: false,
        state_color: true,
        entities: ents.map((e) => ({ entity: e.entity_id, name: short(e) })),
        ...extra,
      }];
    case "thermostat":
      return ents.map((e) => withVisibility(
        { type: "thermostat", entity: e.entity_id, show_current_as_primary: true, ...extra }, block, e.entity_id));
    case "graph":
      // Verlauf wie im Bestand: Sensor-Karte mit Linie
      return ents.map((e) => ({
        type: "sensor", entity: e.entity_id, graph: "line", detail: 2,
        hours_to_show: block.hours || 96, name: short(e),
        grid_options: { columns: 12, rows: 3 }, ...extra,
      }));
    case "home-rhythm": {
      if (!(await cardAvailable("home-rhythm-card"))) {
        return [{ type: "markdown", content: "⚠️ `home-rhythm-card` ist nicht geladen (Ressourcen prüfen)." }];
      }
      // Home-Rhythm-Raum-ID ≠ Bereichs-ID möglich → Zuordnung über `home_rhythm_rooms`
      const room = byArea(config.home_rhythm_rooms, area) || (area && area.area_id);
      return room ? [{ type: "custom:home-rhythm-card", room, layout: block.layout || "standard", ...extra }] : [];
    }
    case "template": {
      const tpl = (config.templates || {})[block.template];
      if (!tpl) return [{ type: "markdown", content: `⚠️ Vorlage „${block.template}“ fehlt.` }];
      const areaMap = { "{area}": area ? area.name : "", "{area_id}": area ? area.area_id : "" };
      if (tpl.per === "all") return [fillPlaceholders(tpl.card, areaMap, ents.map((e) => e.entity_id))];
      return ents.map((e) => withVisibility(fillPlaceholders(tpl.card, {
        ...areaMap, "{entity}": e.entity_id, "{entity_name}": e.name,
        "{name}": short(e) || e.name,
      }), block, e.entity_id));
    }
    default: // tile
      return ents.map((e) => withVisibility({
        type: "tile", entity: e.entity_id, name: short(e),
        ...(block.features ? { features: block.features, features_position: block.features_position || "bottom" } : {}),
        ...extra,
      }, block, e.entity_id));
  }
}

/** Abschnitt aus Bausteinen (mit Zwischenüberschriften, leere Bausteine fallen weg). */
async function sectionFromBlocks(assigned, area, config) {
  const cards = [];
  for (const { block, hits } of assigned) {
    if (!hits.length) continue; // „Wenn leer: ausblenden“
    const kind = block.card || "tile";
    if (block.heading !== false && kind !== "entities" && block.name) {
      cards.push({ type: "heading", heading: block.name, heading_style: "subtitle" });
    }
    cards.push(...(await buildCards(block, hits, area, config)));
  }
  return cards;
}

// ---------------------------------------------------------------------------
// Standard-Bausteine einer Raumseite (aus dem Tablet-Dashboard abgeleitet)
// ---------------------------------------------------------------------------

const DEFAULT_ROOM = {
  left: [
    { name: "Rollladen", card: "tile", any: [{ domain: "cover" }],
      features: [{ type: "cover-open-close" }, { type: "cover-position" }] },
    { name: "Licht & Schalter", card: "entities", any: [{ domain: ["light", "switch", "fan", "input_boolean"] }] },
    { name: "Fenster & Türen", card: "entities",
      any: [{ domain: "binary_sensor", device_class: ["window", "door", "opening", "garage_door"] }] },
    { name: "Medien", card: "tile", any: [{ domain: "media_player" }] },
    { name: "Messwerte", card: "tile",
      any: [{ domain: "sensor", device_class: ["temperature", "humidity", "carbon_dioxide", "pressure",
        "power", "illuminance", "sound_pressure", "moisture", "pm25", "volatile_organic_compounds"] }] },
  ],
  right: [
    { name: "Heizung", card: "thermostat", heading: false, any: [{ domain: "climate" }] },
    { name: "Verlauf", card: "graph", heading: false, limit: 1,
      any: [{ domain: "sensor", device_class: "temperature" }] },
  ],
};

/** Rechte Spalte (Klima) vergibt zuerst – sie ist spezifischer (z. B. „Verlauf“ nimmt einen Temperatursensor). */
const claimOrder = (left, right) => [...right.map((_, i) => left.length + i), ...left.map((_, i) => i)];

function roomBlocks(config) {
  const r = config.room || {};
  return { left: r.left || DEFAULT_ROOM.left, right: r.right || DEFAULT_ROOM.right };
}

// ---------------------------------------------------------------------------
// Bausteine mitten in festen Seiten: { type: "custom:home-cockpit-block", block: {...} }
// ---------------------------------------------------------------------------

const BLOCK_CARD = "custom:home-cockpit-block";

/** Ersetzt in einer festen Seite jede Baustein-Karte durch die erzeugten Karten. */
async function expandHandView(view, config, hass, ctx) {
  if (!JSON.stringify(view).includes(BLOCK_CARD)) return view; // schnell: nichts zu tun
  const ents = collectEntities(hass).filter((e) => !excludedWhy(e, config));
  const expandCards = async (cards) => {
    const out = [];
    for (const c of asList(cards)) {
      if (c && c.type === BLOCK_CARD && c.block) {
        const { result } = assignBlocks(ents, [c.block], ctx);
        out.push(...(await sectionFromBlocks(result, null, config)));
      } else if (c && Array.isArray(c.cards)) {
        out.push({ ...c, cards: await expandCards(c.cards) }); // Stacks
      } else out.push(c);
    }
    return out;
  };
  const v = { ...view };
  if (Array.isArray(v.sections)) v.sections = await Promise.all(v.sections.map(async (sec) => ({ ...sec, cards: await expandCards(sec.cards) })));
  if (Array.isArray(v.cards)) v.cards = await expandCards(v.cards);
  return v;
}

// ---------------------------------------------------------------------------
// Dashboard-Strategie: Ansichten-Liste
// ---------------------------------------------------------------------------

class HomeCockpitDashboardStrategy extends HTMLElement {
  static async generate(config, hass) {
    const { floors, homePath } = buildLayout(config, hass);
    const views = [];

    // 1. Handseiten vorne (Baustein-Karten darin werden erzeugt)
    const hctx = { hass, labels: await loadLabels(hass) };
    for (const v of asList(config.views_before)) views.push(await expandHandView(v, config, hass, hctx));

    // 2. Ohne eigene Startseite: einfache Übersicht mit Etagenknöpfen
    if (!asList(config.views_before).length) {
      views.push({
        title: config.title || "Übersicht", path: homePath, icon: "mdi:home", type: "sections",
        sections: [{ type: "grid", cards: floors.map((f) => ({
          type: "button", name: f.name, icon: f.icon, show_state: false,
          tap_action: { action: "navigate", navigation_path: absPath(config, f.path) },
          grid_options: { columns: 6, rows: 2 },
        })) }],
      });
    }

    // 3. Etagen und Räume (Unterseiten, Rückweg über den Pfeil oben links)
    const tabs = config.floor_tabs === true;
    for (const f of floors) {
      if (!f.hand) views.push({
        title: f.name, path: f.path, icon: f.icon,
        ...(tabs ? {} : { subview: true, back_path: absPath(config, homePath) }),
        strategy: { type: "custom:home-cockpit-floor", floor_id: f.floor_id, parent: config },
      });
      for (const a of f.areas) {
        if (a.hand) continue; // Handseite mit gleichem Pfad vorhanden
        views.push({
          title: a.name, path: a.path, icon: a.icon, subview: true, back_path: absPath(config, f.path),
          strategy: { type: "custom:home-cockpit-room", area_id: a.area_id, parent: config },
        });
      }
    }

    // 4. Eigene Seiten aus Bausteinen (z. B. Heizung, Garten) – vor oder nach den Handseiten
    const pageView = (pg, i) => ({
      title: pg.title, path: pg.path || slug(pg.title), icon: pg.icon || "mdi:view-dashboard-outline",
      ...(pg.subview ? { subview: true, back_path: absPath(config, homePath) } : {}),
      strategy: { type: "custom:home-cockpit-page", page: i, parent: config },
    });
    asList(config.pages).forEach((pg, i) => { if (pg.position !== "end") views.push(pageView(pg, i)); });

    // 5. Handseiten hinten
    for (const v of asList(config.views_after)) views.push(await expandHandView(v, config, hass, hctx));
    asList(config.pages).forEach((pg, i) => { if (pg.position === "end") views.push(pageView(pg, i)); });

    // 6. Nicht zugeordnet
    if (config.unassigned_view !== false) {
      views.push({
        title: "Nicht zugeordnet", path: "nicht-zugeordnet", icon: "mdi:help-box-outline",
        subview: !tabs, ...(tabs ? {} : { back_path: absPath(config, homePath) }),
        strategy: { type: "custom:home-cockpit-unassigned", parent: config },
      });
    }

    // 7. Editor – nur für Admins (das Dashboard wird je Benutzer erzeugt)
    if (hass.user && hass.user.is_admin && config.editor !== false) {
      views.push({ title: "HomeCockpit", path: "homecockpit", icon: "mdi:cog-outline", type: "panel",
        cards: [{ type: "custom:home-cockpit-editor" }] });
    }

    if (!floors.length) {
      views.push({ title: "HomeCockpit", cards: [{ type: "markdown",
        content: "Keine Etagen gefunden. Lege in HA Etagen an und ordne die Bereiche zu." }] });
    }
    return { title: config.title || "HomeCockpit", views };
  }
}

// ---------------------------------------------------------------------------
// View-Strategie: Etage → Raumknöpfe
// ---------------------------------------------------------------------------

/** Leitentität für den Raumknopf: Thermostat, sonst Temperatursensor. */
function leadEntity(ents, config) {
  const ok = ents.filter((e) => !excludedWhy(e, config));
  return ok.find((e) => e.domain === "climate" && !e.labels.includes("bt_heizung"))
    || ok.find((e) => e.domain === "climate")
    || ok.find((e) => e.domain === "sensor" && e.device_class === "temperature")
    || null;
}

class HomeCockpitFloorViewStrategy extends HTMLElement {
  static async generate(config, hass) {
    const parent = config.parent || {};
    const { floors } = buildLayout(parent, hass);
    const floor = floors.find((f) => f.floor_id === config.floor_id);
    if (!floor) return { type: "sections", sections: [] };
    const ents = collectEntities(hass);

    const roomCards = floor.areas.map((a) => {
      const inArea = ents.filter((e) => e.area_id === a.area_id);
      const lead = byArea(parent.room_lead, { area_id: a.area_id, name: a.name }) ||
        (leadEntity(inArea, parent) || {}).entity_id;
      const nav = { action: "navigate", navigation_path: absPath(parent, a.path) };
      // Kachel zeigt den Zustand der Leitentität (z. B. „Heizen · 21 °C“), Tippen öffnet den Raum
      return lead
        ? { type: "tile", entity: lead, name: a.name, icon: a.icon, tap_action: nav,
            icon_tap_action: nav, grid_options: { columns: 6, rows: 1 } }
        : { type: "button", name: a.name, icon: a.icon, show_state: false, tap_action: nav,
            grid_options: { columns: 6, rows: 1 } };
    });

    // Live-Hinweis: offene Fenster/Türen der Etage (nur sichtbar, solange offen)
    const openings = ents.filter((e) => floor.areas.some((a) => a.area_id === e.area_id)
      && e.domain === "binary_sensor" && ["window", "door", "opening"].includes(e.device_class)
      && !excludedWhy(e, parent));

    const sections = [{ type: "grid", cards: [
      { type: "heading", heading: floor.name, heading_style: "title" }, ...roomCards] }];
    if (openings.length && parent.floor_openings !== false) {
      sections.push({ type: "grid", cards: [
        { type: "heading", heading: "Offen", heading_style: "subtitle", icon: "mdi:window-open-variant",
          visibility: [{ condition: "or", conditions: openings.map((e) => ({ condition: "state", entity: e.entity_id, state: "on" })) }] },
        ...openings.map((e) => withVisibility({ type: "tile", entity: e.entity_id },
          { visible_state: "on" }, e.entity_id)),
      ] });
    }
    return { type: "sections", max_columns: parent.max_columns || 2, sections };
  }
}

// ---------------------------------------------------------------------------
// View-Strategie: Raum → links Geräte, rechts Klima
// ---------------------------------------------------------------------------

class HomeCockpitRoomViewStrategy extends HTMLElement {
  static async generate(config, hass) {
    const parent = config.parent || {};
    const area = (hass.areas || {})[config.area_id];
    if (!area) return { type: "sections", sections: [] };
    const ctx = { hass, labels: await loadLabels(hass) };
    const ents = collectEntities(hass)
      .filter((e) => e.area_id === area.area_id && !excludedWhy(e, parent));

    const { left, right } = roomBlocks(parent);
    // Gemeinsam verteilen, damit „erster Treffer gewinnt“ über beide Spalten gilt
    const { result } = assignBlocks(ents, [...left, ...right], ctx, { order: claimOrder(left, right) });
    const hand = byArea(parent.room_cards, area) || {};

    const leftCards = [...asList(hand.before),
      ...(await sectionFromBlocks(result.slice(0, left.length), area, parent))];
    const rightCards = [
      ...(await sectionFromBlocks(result.slice(left.length), area, parent)), ...asList(hand.after)];

    const sections = [];
    if (leftCards.length) sections.push({ type: "grid", cards: leftCards });
    if (rightCards.length) sections.push({ type: "grid", cards: rightCards });
    if (!sections.length) {
      sections.push({ type: "grid", cards: [{ type: "markdown",
        content: `Im Bereich **${area.name}** passt noch nichts zu den Bausteinen.` }] });
    }
    return { type: "sections", max_columns: parent.max_columns || 2, sections };
  }
}

// ---------------------------------------------------------------------------
// View-Strategie: eigene Seite → je Baustein ein Abschnitt (optional je Bereich gruppiert)
// ---------------------------------------------------------------------------

/** onlyIndex: nur diesen Baustein darstellen (Editor-Vorschau), Vergabe aber wie auf der echten Seite */
async function buildPageSections(page, config, hass, onlyIndex) {
  const ctx = { hass, labels: await loadLabels(hass) };
  const ents = collectEntities(hass).filter((e) => !excludedWhy(e, config));
  const blocks = asList(page.blocks);
  const { result } = assignBlocks(ents, blocks, ctx);
  const areas = hass.areas || {};
  const sections = [];
  for (const [ri, { block, hits }] of result.entries()) {
    if (!hits.length || (onlyIndex !== undefined && ri !== onlyIndex)) continue;
    if (block.group_by === "area") {
      // ein Abschnitt je Bereich, z. B. „Alle Thermostate“ nach Räumen
      const byA = {};
      hits.forEach((e) => (byA[e.area_id || "_"] = byA[e.area_id || "_"] || []).push(e));
      const ids = Object.keys(byA).sort((a, b) => lower((areas[a] || {}).name || "~").localeCompare(lower((areas[b] || {}).name || "~"), "de"));
      for (const id of ids) {
        const area = areas[id] || null;
        sections.push({ type: "grid", cards: [
          { type: "heading", heading: area ? area.name : "Ohne Bereich", heading_style: "title" },
          ...(await buildCards(block, byA[id], area, config)),
        ] });
      }
    } else {
      const cards = await sectionFromBlocks([{ block: { ...block, heading: false }, hits }], null, config);
      sections.push({ type: "grid", cards: [
        ...(block.name && block.heading !== false ? [{ type: "heading", heading: block.name, heading_style: "title" }] : []),
        ...cards] });
    }
  }
  return sections;
}

class HomeCockpitPageViewStrategy extends HTMLElement {
  static async generate(config, hass) {
    const parent = config.parent || {};
    const page = asList(parent.pages)[config.page];
    if (!page) return { type: "sections", sections: [] };
    const sections = await buildPageSections(page, parent, hass);
    if (!sections.length) sections.push({ type: "grid", cards: [{ type: "markdown",
      content: `Auf der Seite **${page.title}** passt noch nichts zu den Bausteinen.` }] });
    return { type: "sections", max_columns: page.max_columns || parent.max_columns || 3, sections };
  }
}

// ---------------------------------------------------------------------------
// View-Strategie: was nirgends erscheint – mit Grund
// ---------------------------------------------------------------------------

/**
 * Bestimmt für jede Entität, ob und warum sie NICHT im Dashboard erscheint.
 * Exportiert (window.HomeCockpit.explain) für Editor und Tests.
 */
async function explainAll(config, hass) {
  const ctx = { hass, labels: await loadLabels(hass) };
  const { floors } = buildLayout(config, hass);
  const onHand = collectEntityIds([config.views_before, config.views_after, config.room_cards]);
  const areaInfo = {};
  floors.forEach((f) => f.areas.forEach((a) => (areaInfo[a.area_id] = { floor: f, area: a })));
  const { left, right } = roomBlocks(config);
  const blocks = [...left, ...right];

  const out = [];
  const all = collectEntities(hass);
  // Je Bereich einmal verteilen (erster Treffer gewinnt) – wie in der Raumseite
  const placed = new Map();
  for (const areaId of Object.keys(areaInfo)) {
    const ents = all.filter((e) => e.area_id === areaId && !excludedWhy(e, config));
    const { result } = assignBlocks(ents, blocks, ctx, { order: claimOrder(left, right) });
    result.forEach(({ block, hits }) => hits.forEach((e) => {
      if (!placed.has(e.entity_id)) placed.set(e.entity_id, block.name);
    }));
  }
  // Bausteine in festen Seiten
  const handBlocks = [];
  const findBlocks = (n, page) => {
    if (Array.isArray(n)) return n.forEach((x) => findBlocks(x, page));
    if (!n || typeof n !== "object") return;
    if (n.type === BLOCK_CARD && n.block) handBlocks.push({ page, block: n.block });
    Object.values(n).forEach((x) => findBlocks(x, page));
  };
  [...asList(config.views_before), ...asList(config.views_after)].forEach((v) => findBlocks(v, v.title || v.path));
  for (const hb of handBlocks) {
    const { result } = assignBlocks(all.filter((e) => !excludedWhy(e, config)), [hb.block], ctx);
    result[0].hits.forEach((e) => { if (!placed.has(e.entity_id)) placed.set(e.entity_id, `Seite ${hb.page} › ${hb.block.name}`); });
  }
  // Eigene Seiten: Bausteine gelten für alle Bereiche
  for (const pg of asList(config.pages)) {
    const ents = all.filter((e) => !excludedWhy(e, config));
    const { result } = assignBlocks(ents, asList(pg.blocks), ctx);
    result.forEach(({ block, hits }) => hits.forEach((e) => {
      if (!placed.has(e.entity_id)) placed.set(e.entity_id, `Seite ${pg.title} › ${block.name}`);
    }));
  }
  for (const e of all) {
    let status = "shown", why = "";
    const info = areaInfo[e.area_id];
    const pl = placed.get(e.entity_id);
    if (pl && pl.startsWith("Seite ")) {
      why = pl + (onHand.has(e.entity_id) ? " (auch auf Handseite)" : "");
    }
    else if (pl && info && !info.area.hand) {
      why = `${info.floor.name} › ${info.area.name} › ${pl}` + (onHand.has(e.entity_id) ? " (auch auf Handseite)" : "");
    }
    else if (onHand.has(e.entity_id)) { status = "hand"; why = "auf einer Handseite"; }
    else if (excludedWhy(e, config)) { status = "excluded"; why = excludedWhy(e, config); }
    else if (!e.area_id) { status = "missing"; why = "kein Bereich"; }
    else if (!e.floor_id && !info) { status = "missing"; why = "Bereich ohne Etage"; }
    else if (!info) { status = "missing"; why = "Etage nicht im Dashboard"; }
    else if (info.area.hand) { status = "missing"; why = `Raum „${info.area.name}“ ist eine Handseite, Entität fehlt dort`; }
    else { status = "missing"; why = `kein Baustein passt (${e.domain}${e.device_class ? " · " + e.device_class : ""})`; }
    out.push({ ...e, status, why });
  }
  return out;
}

class HomeCockpitUnassignedViewStrategy extends HTMLElement {
  static async generate(config, hass) {
    const parent = config.parent || {};
    const missing = (await explainAll(parent, hass)).filter((e) => e.status === "missing");
    // Nach Grund gruppieren, damit man gezielt aufräumen kann
    const groups = {};
    missing.forEach((e) => (groups[e.why] = groups[e.why] || []).push(e));
    const MAX = 150;
    const sections = Object.entries(groups)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([why, list]) => ({ type: "grid", cards: [
        { type: "heading", heading: `${why} (${list.length})`, heading_style: "subtitle" },
        { type: "entities", entities: list.slice(0, MAX).map((e) => ({ entity: e.entity_id, secondary_info: "entity-id" })) },
        ...(list.length > MAX ? [{ type: "markdown", content: `… und ${list.length - MAX} weitere` }] : []),
      ] }));
    return { type: "sections", max_columns: 3, sections: [
      { type: "grid", column_span: 3, cards: [{ type: "heading", heading_style: "title",
        heading: missing.length ? `Nicht zugeordnet (${missing.length})` : "Alles ist zugeordnet ✓" }] },
      ...sections,
    ] };
  }
}

// ===========================================================================
// EDITOR – Ansicht „⚙ HomeCockpit“ (nur für Admins)
// ===========================================================================
//
// Bearbeitet den „Bauplan“ (= die Strategie-Konfiguration dieses Dashboards) und speichert ihn
// über den HA-Websocket `lovelace/config/save`. Vorher wird die alte Fassung im Browser gesichert
// (localStorage), damit „Rückgängig“ möglich ist.
//
// Sicherheit: Alle Texte aus HA (Namen, IDs, Konfiguration) werden vor der Ausgabe escaped.
// Es werden keine externen Dateien geladen und keine Daten nach außen geschickt.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o ?? null));
const listText = (v) => asList(v).join(", ");
/** „light, switch“ → ["light","switch"], „light“ → "light", „“ → undefined */
const parseList = (t) => {
  const a = String(t || "").split(",").map((x) => x.trim()).filter(Boolean);
  return a.length === 0 ? undefined : a.length === 1 ? a[0] : a;
};

const CRITERIA = [
  ["domain", "Domäne", "light, switch, cover, climate …"],
  ["device_class", "Geräteklasse", "temperature, window, power …"],
  ["label", "Label", "Name oder ID"],
  ["area", "Bereich", "Name oder ID"],
  ["floor", "Etage", "Name oder ID"],
  ["name_contains", "Stichwort", "Teilwort in Name/ID"],
  ["integration", "Integration", "z. B. shelly, netatmo"],
];
const CARD_KINDS = [
  ["tile", "Kachel (je Gerät)"],
  ["entities", "Liste (eine Karte für alle)"],
  ["thermostat", "Thermostat (je Gerät)"],
  ["graph", "Verlauf (je Gerät)"],
  ["home-rhythm", "Home-Rhythm-Raumkarte"],
];

const EDITOR_CSS = `
:host{display:block;--hc-acc:var(--primary-color,#0b5cad);--hc-line:var(--divider-color,#e0e0e0);--hc-sub:var(--secondary-text-color,#666);
  --hc-card:var(--card-background-color,#fff);--hc-text:var(--primary-text-color,#212121);--hc-soft:var(--secondary-background-color,#f3f4f6);
  color:var(--hc-text);font-family:var(--paper-font-body1_-_font-family,Roboto,system-ui,sans-serif);font-size:14px}
*{box-sizing:border-box}
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:10px 16px;background:var(--hc-card);border-bottom:1px solid var(--hc-line);position:sticky;top:0;z-index:2}
.bar h1{font-size:17px;margin:0;font-weight:600}
.bar .sp{flex:1}
.wrap{display:flex;flex-wrap:wrap;gap:14px;padding:14px;align-items:flex-start}
.col{background:var(--hc-card);border:1px solid var(--hc-line);border-radius:14px;padding:14px}
.tree{flex:1 1 240px;max-width:290px}
.main{flex:999 1 420px;min-width:0;display:flex;flex-direction:column;gap:14px}
.prev{flex:1 1 330px;max-width:440px;display:flex;flex-direction:column;gap:10px}
.lbl{font-size:11px;font-weight:600;color:var(--hc-sub);text-transform:uppercase;letter-spacing:.05em}
.small{font-size:12px;color:var(--hc-sub)}
.ti{display:flex;align-items:center;gap:8px;width:100%;border:0;background:none;color:inherit;font:inherit;text-align:left;padding:7px 9px;border-radius:8px;cursor:pointer;min-height:36px}
.ti:hover{background:var(--hc-soft)} .ti.on{background:color-mix(in srgb,var(--hc-acc) 14%,transparent)}
.ti .dot{width:9px;height:9px;border-radius:3px;flex:none;background:var(--hc-acc)} .ti .dot.fix{background:#b7791f}
.ti .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grp{display:flex;align-items:center;gap:6px;padding:12px 9px 4px;font-weight:600;font-size:13px}
.ind{padding-left:22px}
button.b{border:1px solid var(--hc-line);background:var(--hc-card);color:var(--hc-text);border-radius:10px;padding:7px 12px;font:inherit;font-size:13px;cursor:pointer;min-height:36px}
button.b:hover{border-color:var(--hc-sub)} button.pri{background:var(--hc-acc);border-color:var(--hc-acc);color:var(--text-primary-color,#fff)}
button.b:disabled{opacity:.45;cursor:default} button.danger{color:var(--error-color,#c62828)}
button.mini{min-height:28px;padding:3px 8px;font-size:12px}
input,select,textarea{font:inherit;color:var(--hc-text);background:var(--hc-card);border:1px solid var(--hc-line);border-radius:9px;padding:7px 10px;min-height:36px;width:100%}
textarea{min-height:80px;font-family:ui-monospace,Menlo,monospace;font-size:12px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.row > label{min-width:110px;color:var(--hc-sub);font-size:13px}
.row > input,.row > select{flex:1 1 200px;width:auto}
.rg{border:1px dashed var(--hc-line);border-radius:12px;padding:10px;display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;position:relative}
.rg.not{border-color:color-mix(in srgb,var(--error-color,#c62828) 40%,transparent);background:color-mix(in srgb,var(--error-color,#c62828) 4%,transparent)}
.rg label{font-size:11px;color:var(--hc-sub);display:block;margin-bottom:2px}
.rg .x{position:absolute;top:4px;right:6px}
.or{font-size:11px;font-weight:600;color:var(--hc-sub);margin:6px 2px}
.hint{border-radius:10px;padding:10px 12px;font-size:13px;background:color-mix(in srgb,var(--hc-acc) 9%,transparent)}
.warn{background:color-mix(in srgb,#f5a623 16%,transparent)}
.hit{display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--hc-line);font-size:13px}
.hit input{width:18px;height:18px;min-height:0;flex:none}
.hit .id{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--hc-sub);margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50%}
.off{color:var(--hc-sub);text-decoration:line-through}
.pv{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:8px}
.pv > *{grid-column:span 12;min-width:0}
.pv > .half{grid-column:span 6}
.pvwrap{position:relative;cursor:pointer;border-radius:12px;outline:2px solid transparent}
.pvwrap.sel{outline-color:var(--hc-acc)}
.pvwrap .shield{position:absolute;inset:0;z-index:1}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;font-family:ui-monospace,Menlo,monospace;background:var(--hc-soft);padding:10px;border-radius:10px;max-height:480px;overflow:auto}
table{border-collapse:collapse;width:100%} td,th{padding:6px;border-top:1px solid var(--hc-line);text-align:left;font-size:13px;vertical-align:middle}
.status{font-size:13px;color:var(--hc-sub)}
.chip{display:inline-flex;align-items:center;padding:3px 9px;border-radius:999px;border:1px solid var(--hc-line);font-size:12px}
@media (max-width:1100px){.prev{max-width:none}.tree{max-width:none}}
`;

class HomeCockpitEditor extends HTMLElement {
  setConfig(c) { this._cardCfg = c || {}; }
  getCardSize() { return 20; }

  set hass(h) {
    const first = !this._hass;
    this._hass = h;
    if (first) this._init();
    else (this._pvEls || []).forEach((el) => { try { el.hass = h; } catch (e) { /* Karte ohne hass */ } });
  }

  /** URL-Pfad dieses Dashboards: /dashboard-tablet/… → "dashboard-tablet", /lovelace/… → null */
  get _urlPath() {
    const seg = (location.pathname.split("/")[1] || "lovelace");
    return seg === "lovelace" ? null : seg;
  }

  async _init() {
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `<style>${EDITOR_CSS}</style><div id="root"><div class="wrap"><div class="col">HomeCockpit-Editor lädt …</div></div></div>`;
    this._root = this.shadowRoot.getElementById("root");
    this._sel = { kind: "room", side: "left", i: 0 };
    this._pvEls = [];
    this._sampleArea = null;
    try {
      const conf = await this._hass.callWS({ type: "lovelace/config", url_path: this._urlPath });
      if (!conf || !conf.strategy || conf.strategy.type !== "custom:home-cockpit") {
        this._fatal("Dieses Dashboard nutzt nicht die HomeCockpit-Strategie – der Editor kann hier nichts speichern.");
        return;
      }
      this._orig = clone(conf.strategy);
      this._cfg = clone(conf.strategy);
    } catch (err) {
      this._fatal("Dashboard-Konfiguration nicht lesbar: " + (err && err.message ? err.message : err));
      return;
    }
    if (!this._cfg.room) this._cfg.room = clone(DEFAULT_ROOM); // Standard sichtbar und bearbeitbar machen
    this._cfg.templates = this._cfg.templates || {};
    this._cfg.pages = asList(this._cfg.pages);
    this._ctx = { hass: this._hass, labels: await loadLabels(this._hass) };
    this._dirty = false;
    this._shell();
    this._renderAll();
    this._checkVersion();
  }

  /**
   * Vergleicht die geladene Version mit der Datei, die HA ausliefert.
   * Unterschied = Browser/App hat eine alte Datei zwischengespeichert. Fragt NICHT im Internet nach.
   */
  async _checkVersion() {
    try {
      const res = await this._hass.callWS({ type: "lovelace/resources" });
      const r = asList(res).find((x) => /home-cockpit-strategy\.js/.test(x.url || ""));
      if (!r) return;
      const url = r.url + (r.url.includes("?") ? "&" : "?") + "_hc=" + Date.now();
      const txt = await (await fetch(url, { cache: "no-store" })).text();
      const m = txt.match(/const VERSION = "([^"]+)"/);
      if (!m || m[1] === VERSION) return;
      const bar = this._root.querySelector(".bar");
      bar.insertAdjacentHTML("afterend", `<div class="hint warn" style="margin:10px 14px 0">
        <b>Auf deinem HA liegt Version ${esc(m[1])}, geladen ist aber noch ${esc(VERSION)}.</b>
        Der Browser bzw. die App benutzt eine zwischengespeicherte Datei. Abhilfe: HA-App → Einstellungen → Companion App → Fehlerbehebung →
        „Frontend-Cache zurücksetzen“ (Safari: Website-Daten der HA-Adresse löschen), App/Tab ganz schließen und neu öffnen.
        Ressource: <code>${esc(r.url)}</code></div>`);
    } catch (e) { /* ohne Admin-Rechte oder offline: keine Prüfung */ }
  }

  _fatal(msg) { this._root.innerHTML = `<div class="wrap"><div class="col"><b>HomeCockpit</b><p>${esc(msg)}</p></div></div>`; }

  _backupKey() { return "homecockpit-backup-" + (this._urlPath || "lovelace"); }

  _shell() {
    let hasBackup = false;
    try { hasBackup = !!localStorage.getItem(this._backupKey()); } catch (e) { /* kein Speicher */ }
    this._root.innerHTML = `
      <div class="bar">
        <h1>⚙ HomeCockpit</h1><span class="small">Bauplan dieses Dashboards · v${VERSION}</span>
        <span class="sp"></span>
        <span class="status" id="status"></span>
        <button class="b" data-act="undo" ${hasBackup ? "" : "disabled"} title="Letzte gespeicherte Fassung zurückholen">Rückgängig</button>
        <button class="b pri" data-act="save" id="save" disabled>Speichern</button>
      </div>
      <div class="wrap">
        <div class="col tree" id="tree"></div>
        <div class="col main" id="main"></div>
        <div class="col prev" id="prev"></div>
      </div>`;
    this._root.addEventListener("click", (ev) => this._onClick(ev));
    this._root.addEventListener("input", (ev) => this._onInput(ev));
    this._root.addEventListener("change", (ev) => this._onChange(ev));
  }

  _setDirty() {
    this._dirty = true;
    const b = this._root.querySelector("#save"); if (b) b.disabled = false;
    this._status("Ungespeicherte Änderungen");
  }
  _status(t) { const s = this._root.querySelector("#status"); if (s) s.textContent = t; }

  // ------------------------------------------------------------------ Auswahl
  _block() {
    const s = this._sel, c = this._cfg;
    if (s.kind === "room") return asList(c.room[s.side])[s.i];
    if (s.kind === "pblock") return asList((c.pages[s.p] || {}).blocks)[s.i];
    if (s.kind === "hcard") { const card = this._hcard(); return card && card.type === BLOCK_CARD ? card.block : null; }
    return null;
  }

  // ---- feste Seiten: Behälter = Abschnitte (sections) oder eine Kartenliste (masonry)
  _hview(s = this._sel) { return asList(this._cfg[s.key])[s.v]; }
  _containers(v) {
    if (!v) return [];
    if (Array.isArray(v.sections)) return v.sections;
    v.cards = asList(v.cards);
    return [v];
  }
  _hcard(s = this._sel) {
    const v = this._hview(s); if (!v) return null;
    const c = this._containers(v)[s.sec]; return c ? asList(c.cards)[s.c] : null;
  }
  _cardLabel(card) {
    if (!card) return "—";
    if (card.type === BLOCK_CARD) return (card.block && card.block.name) || "Baustein";
    const st = this._hass.states[card.entity] || {};
    return card.name || card.title || card.heading || (st.attributes && st.attributes.friendly_name) || card.entity
      || (card.type || "Karte").replace("custom:", "");
  }
  _blockList() {
    const s = this._sel, c = this._cfg;
    if (s.kind === "room") return c.room[s.side];
    if (s.kind === "pblock") return c.pages[s.p].blocks;
    return null;
  }

  _renderAll() { this._renderTree(); this._renderMain(); this._renderPreview(); }

  // ------------------------------------------------------------------ Gliederung
  _renderTree() {
    const c = this._cfg, s = this._sel;
    const on = (k, extra = {}) => s.kind === k && Object.entries(extra).every(([a, b]) => s[a] === b) ? " on" : "";
    const item = (label, act, data, cls, dot = "") =>
      `<button class="ti${cls}" data-act="${act}" ${data}>${dot}<span class="grow">${esc(label)}</span></button>`;
    const blk = (b, kind, data, sel) => item(b.name || "(ohne Name)", "sel", `data-kind="${kind}" ${data}`, " ind" + sel,
      `<span class="dot"></span>`) ;
    let h = `<div class="lbl">Gliederung</div>`;
    h += `<div class="grp">Feste Seiten</div>`;
    h += item(`Übersicht & Reihenfolge`, "sel", `data-kind="hand"`, " ind" + on("hand"), `<span class="dot fix"></span>`);
    for (const key of ["views_before", "views_after"]) {
      asList(c[key]).forEach((v, vi) => {
        const isOn = (s.kind === "hpage" || s.kind === "hcard") && s.key === key && s.v === vi;
        h += item(v.title || v.path || "Seite", "sel", `data-kind="hpage" data-key="${key}" data-v="${vi}"`, " ind" + (isOn ? " on" : ""), `<span class="dot fix"></span>`);
      });
    }
    h += `<div class="grp">↻ Etage <span class="small">je Etage</span></div>`;
    h += item("Etagen & Raumknöpfe", "sel", `data-kind="floors"`, " ind" + on("floors"), `<span class="dot"></span>`);
    h += `<div class="grp">↻ Raum <span class="small">je Bereich</span></div>`;
    for (const side of ["left", "right"]) {
      h += `<div class="small ind" style="padding:4px 9px">${side === "left" ? "Linke Spalte" : "Rechte Spalte"}</div>`;
      asList(c.room[side]).forEach((b, i) => { h += blk(b, "room", `data-side="${side}" data-i="${i}"`, on("room", { side, i })); });
      h += `<div class="ind" style="padding:2px 9px 6px"><button class="b mini" data-act="addRoomBlock" data-side="${side}">+ Baustein</button></div>`;
    }
    h += `<div class="grp">Eigene Seiten</div>`;
    c.pages.forEach((pg, p) => {
      h += item(`Seite „${pg.title}“`, "sel", `data-kind="page" data-p="${p}"`, on("page", { p }), `<span class="dot"></span>`);
      asList(pg.blocks).forEach((b, i) => { h += blk(b, "pblock", `data-p="${p}" data-i="${i}"`, on("pblock", { p, i })); });
      h += `<div class="ind" style="padding:2px 9px 6px"><button class="b mini" data-act="addPageBlock" data-p="${p}">+ Baustein</button></div>`;
    });
    h += `<div style="padding:2px 9px 6px"><button class="b mini" data-act="addPage">+ Seite</button></div>`;
    h += `<div class="grp">Werkzeuge</div>`;
    h += item(`Kartenvorlagen (${Object.keys(c.templates).length})`, "sel", `data-kind="templates"`, on("templates"));
    h += item("Aus Bestand übernehmen", "sel", `data-kind="import"`, on("import"));
    h += item("Nicht zugeordnet", "sel", `data-kind="unassigned"`, on("unassigned"));
    h += item("Bauplan ansehen", "sel", `data-kind="raw"`, on("raw"));
    this._root.querySelector("#tree").innerHTML = h;
  }

  // ------------------------------------------------------------------ Mitte
  _renderMain() {
    const m = this._root.querySelector("#main");
    const k = this._sel.kind;
    if (k === "room" || k === "pblock") m.innerHTML = this._blockForm();
    else if (k === "page") m.innerHTML = this._pageForm();
    else if (k === "floors") m.innerHTML = this._floorForm();
    else if (k === "hand") m.innerHTML = this._handForm();
    else if (k === "hpage") m.innerHTML = this._hpageForm();
    else if (k === "hcard") {
      const card = this._hcard();
      if (card && card.type === BLOCK_CARD) m.innerHTML = this._blockForm();
      else { m.innerHTML = this._hcardForm(); this._mountCardEditor(); }
    }
    else if (k === "templates") m.innerHTML = this._templatesForm();
    else if (k === "import") { m.innerHTML = `<div class="lbl">Aus Bestand übernehmen</div><div>Lade Dashboards …</div>`; this._importForm(m); }
    else if (k === "unassigned") { m.innerHTML = `<div class="lbl">Nicht zugeordnet</div><div>Berechne …</div>`; this._unassignedForm(m); }
    else if (k === "raw") m.innerHTML = this._rawForm();
  }

  _ruleGroups(b, key) {
    const groups = asList(b[key]);
    const isNot = key === "not";
    let h = "";
    groups.forEach((g, gi) => {
      if (gi > 0) h += `<div class="or">${isNot ? "ODER NICHT" : "ODER"}</div>`;
      h += `<div class="rg${isNot ? " not" : ""}"><button class="b mini x" data-act="delGroup" data-key="${key}" data-g="${gi}" aria-label="Gruppe entfernen">✕</button>`;
      for (const [f, lab, ph] of CRITERIA) {
        h += `<div><label for="f-${key}-${gi}-${f}">${lab}</label><input id="f-${key}-${gi}-${f}" data-field="${key}.${gi}.${f}" value="${esc(listText(g[f]))}" placeholder="${esc(ph)}" list="dl-${f}"></div>`;
      }
      h += `</div>`;
    });
    return h;
  }

  _datalists() {
    const ents = collectEntities(this._hass);
    const uniq = (a) => [...new Set(a.filter(Boolean))].sort();
    const opts = (a) => a.map((x) => `<option value="${esc(x)}"></option>`).join("");
    const labels = Object.entries(this._ctx.labels).filter(([k, v]) => k !== v.toLowerCase() || true).map(([, v]) => v);
    return `<datalist id="dl-domain">${opts(uniq(ents.map((e) => e.domain)))}</datalist>
      <datalist id="dl-device_class">${opts(uniq(ents.map((e) => e.device_class)))}</datalist>
      <datalist id="dl-label">${opts(uniq(labels))}</datalist>
      <datalist id="dl-area">${opts(uniq(Object.values(this._hass.areas || {}).map((a) => a.name)))}</datalist>
      <datalist id="dl-floor">${opts(uniq(Object.values(this._hass.floors || {}).map((f) => f.name)))}</datalist>
      <datalist id="dl-integration">${opts(uniq(ents.map((e) => e.platform)))}</datalist>
      <datalist id="dl-name_contains"></datalist>`;
  }

  _blockForm() {
    const b = this._block();
    if (!b) return `<div>Kein Baustein gewählt.</div>`;
    const s = this._sel, isRoom = s.kind === "room";
    const tplOpts = Object.entries(this._cfg.templates).map(([id, t]) =>
      `<option value="template:${esc(id)}" ${b.card === "template" && b.template === id ? "selected" : ""}>Vorlage: ${esc(t.label)}</option>`).join("");
    const kindOpts = CARD_KINDS.map(([v, l]) => `<option value="${v}" ${(b.card || "tile") === v ? "selected" : ""}>${l}</option>`).join("");
    const isHand = s.kind === "hcard";
    const where = isRoom ? `Raumseite (je Bereich) · ${s.side === "left" ? "linke" : "rechte"} Spalte`
      : isHand ? `Feste Seite „${esc((this._hview() || {}).title || "")}“ · automatischer Baustein` : `Seite „${esc(this._cfg.pages[s.p].title)}“`;
    return `${this._datalists()}
      <div class="row" style="justify-content:space-between">
        <div><div class="small">${where}</div><div style="font-size:20px;font-weight:700">${esc(b.name || "(ohne Name)")}</div></div>
        <div class="row">
          ${isHand ? `<button class="b mini" data-act="hpageBack">← zur Seite</button>
          <button class="b mini" data-act="hcardMove" data-d="-1" aria-label="nach oben">↑</button>
          <button class="b mini" data-act="hcardMove" data-d="1" aria-label="nach unten">↓</button>
          <button class="b mini danger" data-act="hcardDel">Entfernen</button>` : `
          <button class="b mini" data-act="moveBlock" data-d="-1" aria-label="nach oben">↑</button>
          <button class="b mini" data-act="moveBlock" data-d="1" aria-label="nach unten">↓</button>
          ${isRoom ? `<button class="b mini" data-act="switchSide">Spalte wechseln</button>` : ""}
          <button class="b mini danger" data-act="delBlock">Entfernen</button>`}
        </div>
      </div>
      <div class="hint">${isRoom
        ? "Gilt für <b>jeden Raum</b>: der Bereich wird automatisch eingesetzt. Der erste passende Baustein bekommt ein Gerät – rechte Spalte zuerst."
        : "Gilt für <b>alle Geräte im Haus</b>, auf die die Regel passt. Für einen Bereich: Kriterium „Bereich“ setzen."}</div>
      <div class="row"><label for="b-name">Name</label><input id="b-name" data-field="name" value="${esc(b.name || "")}"></div>
      <div class="row"><label for="b-card">Karte</label><select id="b-card" data-field="cardsel">${kindOpts}${tplOpts}</select>
        <button class="b" data-act="pickTemplate">Karte aus Dashboard als Vorlage …</button></div>
      <div><div class="lbl" style="margin-bottom:6px">Für alle Geräte mit …</div>
        ${this._ruleGroups(b, "any") || `<div class="small">Keine Regel – passt auf alles${isRoom ? " im Raum" : ""}.</div>`}
        <div class="row" style="margin-top:8px"><button class="b mini" data-act="addGroup" data-key="any">+ ODER-Gruppe</button></div>
        <div class="small" style="margin-top:4px">In einer Gruppe gilt UND, mehrere Werte mit Komma = einer davon.</div>
      </div>
      <div><div class="lbl" style="margin-bottom:6px">Nicht …</div>
        ${this._ruleGroups(b, "not")}
        <div class="row" style="margin-top:8px"><button class="b mini" data-act="addGroup" data-key="not">+ Ausschluss</button>
        <span class="small">In HA ausgeblendete und Diagnose-Entitäten sind immer draußen.</span></div>
      </div>
      <div><div class="lbl" style="margin-bottom:6px">Darstellung</div>
        <div class="row"><label for="b-limit">Höchstens</label><input id="b-limit" type="number" min="0" data-field="limit" value="${esc(b.limit || "")}" placeholder="alle"></div>
        <div class="row"><label for="b-vis">Nur sichtbar wenn</label><input id="b-vis" data-field="visible_state" value="${esc(b.visible_state ?? "")}" placeholder="z. B. on – live, ohne Neuladen"></div>
        <div class="row"><label><input type="checkbox" data-field="heading" ${b.heading === false ? "" : "checked"} style="width:auto;min-height:0"> Überschrift „${esc(b.name || "")}“ zeigen</label></div>
        ${isRoom ? `<div class="row"><label><input type="checkbox" data-field="shared" ${b.shared ? "checked" : ""} style="width:auto;min-height:0"> Geräte nicht „verbrauchen“ (dürfen zusätzlich in anderen Bausteinen stehen)</label></div>` : `
        <div class="row"><label><input type="checkbox" data-field="group_by" ${b.group_by === "area" ? "checked" : ""} style="width:auto;min-height:0"> nach Bereichen gruppieren (je Raum ein Abschnitt)</label></div>`}
      </div>
      <div id="tplpick"></div>`;
  }

  _pageForm() {
    const pg = this._cfg.pages[this._sel.p];
    return `<div class="row" style="justify-content:space-between"><div><div class="small">Eigene Seite</div>
        <div style="font-size:20px;font-weight:700">${esc(pg.title)}</div></div>
        <button class="b mini danger" data-act="delPage">Seite entfernen</button></div>
      <div class="hint">Eine Seite aus Bausteinen – z. B. „Heizung“ mit allen Thermostaten nach Räumen, „Garten“ mit Bewässerung und Bodenfeuchte.</div>
      <div class="row"><label for="p-title">Titel</label><input id="p-title" data-pfield="title" value="${esc(pg.title)}"></div>
      <div class="row"><label for="p-path">Pfad</label><input id="p-path" data-pfield="path" value="${esc(pg.path || "")}" placeholder="${esc(slug(pg.title))}"></div>
      <div class="row"><label for="p-icon">Symbol</label><input id="p-icon" data-pfield="icon" value="${esc(pg.icon || "")}" placeholder="mdi:radiator"></div>
      <div class="row"><label for="p-pos">Position</label><select id="p-pos" data-pfield="position">
        <option value="" ${pg.position !== "end" ? "selected" : ""}>nach den Etagen</option>
        <option value="end" ${pg.position === "end" ? "selected" : ""}>ganz hinten</option></select></div>
      <div class="row"><label><input type="checkbox" data-pfield="subview" ${pg.subview ? "checked" : ""} style="width:auto;min-height:0"> Unterseite (kein Tab, nur über Knopf erreichbar)</label></div>
      <div class="small">Hinweis: Wenn eine Handseite denselben Pfad hat, ersetze sie in „Start & Handseiten“ (entfernen), sonst gibt es den Pfad doppelt.</div>`;
  }

  _floorForm() {
    const c = this._cfg;
    const pathsText = Object.entries(c.paths || {}).map(([k, v]) => `${k} = ${v}`).join("\n");
    const chk = (f, label, def = true) => `<div class="row"><label><input type="checkbox" data-cfield="${f}" ${(c[f] ?? def) ? "checked" : ""} style="width:auto;min-height:0"> ${label}</label></div>`;
    return `${this._datalists()}<div><div class="small">Generator „je Etage“</div><div style="font-size:20px;font-weight:700">Etagen & Raumknöpfe</div></div>
      <div class="hint">Je Etage entsteht eine Unterseite mit einem Knopf je Raum (Zustand: Heizung, sonst Temperatur). Jeder Raum bekommt seine Raumseite aus den Raum-Bausteinen.</div>
      <div class="row"><label for="c-floors">Etagen</label><input id="c-floors" data-cfield="floors" value="${esc(listText(c.floors))}" placeholder="alle, nach Ebene sortiert" list="dl-floor"></div>
      <div class="row"><label for="c-out">Außen-Bereiche</label><input id="c-out" data-cfield="outside.areas" value="${esc(listText((c.outside || {}).areas))}" placeholder="z. B. Garten, Einfahrt (Bereiche ohne Etage)"></div>
      <div class="row"><label for="c-outn">Name dafür</label><input id="c-outn" data-cfield="outside.name" value="${esc((c.outside || {}).name || "")}" placeholder="Außen"></div>
      <div class="row"><label for="c-order">Raum-Reihenfolge</label><input id="c-order" data-cfield="area_order" value="${esc(listText(c.area_order))}" placeholder="sonst alphabetisch"></div>
      <div class="row"><label for="c-home">Startseite (Pfad)</label><input id="c-home" data-cfield="home_path" value="${esc(c.home_path || "")}" placeholder="Pfad der ersten Handseite"></div>
      <div class="row"><label for="c-dash">Dashboard-URL</label><input id="c-dash" data-cfield="dashboard_path" value="${esc(c.dashboard_path || "")}" placeholder="/${esc(this._urlPath || "lovelace")}"></div>
      <div class="row"><label for="c-cols">Spalten</label><input id="c-cols" type="number" min="1" max="4" data-cfield="max_columns" value="${esc(c.max_columns || 2)}"></div>
      ${chk("shorten_names", "Bereichsnamen im Gerätenamen weglassen")}
      ${chk("floor_openings", "auf der Etage „Offen“ zeigen (nur solange etwas offen ist)")}
      ${chk("unassigned_view", "Seite „Nicht zugeordnet“ anhängen")}
      <div><label for="c-paths" class="small">Eigene Pfade (eine Zeile je „Name = pfad“, damit alte Knöpfe weiter funktionieren)</label>
        <textarea id="c-paths" data-cfield="paths">${esc(pathsText)}</textarea></div>`;
  }

  _handForm() {
    const c = this._cfg;
    const rows = (key) => asList(c[key]).map((v, i) => `<tr><td>${esc(v.title || v.path)}</td><td class="small">/${esc(v.path || "")}${v.subview ? " · Unterseite" : ""}</td>
      <td style="white-space:nowrap"><button class="b mini" data-act="handMove" data-key="${key}" data-i="${i}">${key === "views_before" ? "nach hinten" : "nach vorne"}</button>
      <button class="b mini danger" data-act="handDel" data-key="${key}" data-i="${i}">entfernen</button></td></tr>`).join("");
    return `<div><div class="small">Feste Seiten</div><div style="font-size:20px;font-weight:700">Start & Handseiten</div></div>
      <div class="hint">Diese Seiten stehen genau so, wie du sie gebaut hast. Am besten nur für Einzelstücke (Startseite mit Uhr, Kamera, LineGuard). Alles mit „gleiche Karte für viele Geräte“ gehört in Bausteine. Bearbeiten: im alten Dashboard ändern und neu übernehmen.</div>
      <div class="lbl">Vorne</div><table>${rows("views_before") || `<tr><td class="small">keine</td></tr>`}</table>
      <div class="lbl">Hinten</div><table>${rows("views_after") || `<tr><td class="small">keine</td></tr>`}</table>`;
  }

  _hpageForm() {
    const v = this._hview(), s = this._sel;
    if (!v) return `<div>Seite nicht gefunden.</div>`;
    const conts = this._containers(v);
    const isSections = Array.isArray(v.sections);
    let rows = "";
    conts.forEach((ct, sec) => {
      rows += `<div class="row" style="justify-content:space-between;margin-top:8px"><div class="lbl">${isSections ? `Abschnitt ${sec + 1}` : "Karten"}</div>
        <div class="row"><button class="b mini" data-act="hcardAdd" data-sec="${sec}">+ Karte</button>
        ${isSections && !asList(ct.cards).length ? `<button class="b mini danger" data-act="hsecDel" data-sec="${sec}">Abschnitt löschen</button>` : ""}</div></div>`;
      asList(ct.cards).forEach((card, ci) => {
        const auto = card.type === BLOCK_CARD;
        rows += `<div class="hit"><span class="ti" style="padding:0;min-height:0;width:auto;flex:1;cursor:pointer" data-act="hcardSel" data-sec="${sec}" data-c="${ci}">
          <span class="dot${auto ? "" : " fix"}"></span><span class="grow"><b>${esc(this._cardLabel(card))}</b>
          <span class="small"> · ${auto ? "automatisch" : esc((card.type || "").replace("custom:", ""))}</span></span></span>
          <button class="b mini" data-act="hcardMoveAt" data-sec="${sec}" data-c="${ci}" data-d="-1" aria-label="nach oben">↑</button>
          <button class="b mini" data-act="hcardMoveAt" data-sec="${sec}" data-c="${ci}" data-d="1" aria-label="nach unten">↓</button>
          <button class="b mini" data-act="hcardSel" data-sec="${sec}" data-c="${ci}">Bearbeiten</button></div>`;
      });
    });
    return `<div class="row" style="justify-content:space-between"><div><div class="small">Feste Seite · ${s.key === "views_before" ? "vorne" : "hinten"}</div>
        <div style="font-size:20px;font-weight:700">${esc(v.title || v.path)}</div></div>
        <button class="b mini danger" data-act="hpageDel">Seite entfernen</button></div>
      <div class="hint">Jede Karte dieser Seite. <b>Ocker</b> = feste Karte (genau so, wie du sie gebaut hast), <b>blau</b> = automatischer Baustein. Eine feste Karte kannst du mit „Automatisch machen“ für alle passenden Geräte verwenden.</div>
      <div class="row"><label for="hp-t">Titel</label><input id="hp-t" data-hpfield="title" value="${esc(v.title || "")}"></div>
      <div class="row"><label for="hp-p">Pfad</label><input id="hp-p" data-hpfield="path" value="${esc(v.path || "")}"></div>
      <div class="row"><label for="hp-i">Symbol</label><input id="hp-i" data-hpfield="icon" value="${esc(v.icon || "")}" placeholder="mdi:home"></div>
      <div class="row"><label><input type="checkbox" data-hpfield="subview" ${v.subview ? "checked" : ""} style="width:auto;min-height:0"> Unterseite (kein Tab)</label></div>
      ${rows || `<div class="small">Keine Karten.</div>`}
      ${isSections ? `<div class="row" style="margin-top:8px"><button class="b mini" data-act="hsecAdd">+ Abschnitt</button></div>` : ""}
      <div id="tplpick"></div>`;
  }

  _hcardForm() {
    const card = this._hcard(), v = this._hview();
    const canAuto = typeof card.entity === "string" || Array.isArray(card.entities);
    return `<div class="row" style="justify-content:space-between"><div><div class="small">Feste Seite „${esc(v.title || v.path)}“ · feste Karte</div>
        <div style="font-size:20px;font-weight:700">${esc(this._cardLabel(card))}</div></div>
        <div class="row">
          <button class="b mini" data-act="hpageBack">← zur Seite</button>
          <button class="b mini" data-act="hcardMove" data-d="-1" aria-label="nach oben">↑</button>
          <button class="b mini" data-act="hcardMove" data-d="1" aria-label="nach unten">↓</button>
          <button class="b mini" data-act="hcardDup">Duplizieren</button>
          <button class="b mini danger" data-act="hcardDel">Entfernen</button></div></div>
      ${canAuto ? `<div class="hint"><b>Automatisch machen:</b> Diese Karte – genau so konfiguriert – für alle Geräte verwenden, die zu einer Regel passen (z. B. alle Fenster, alle Thermostate mit Label „heizung“). Neue Geräte kommen dann von selbst dazu.
        <div class="row" style="margin-top:6px"><button class="b pri" data-act="hcardAuto">Automatisch machen</button></div></div>` : ""}
      <div class="lbl">Karte bearbeiten</div>
      <div id="cardedit"><div class="small">Karteneditor lädt …</div></div>`;
  }

  /** Versucht den grafischen Karteneditor von HA; sonst Textfeld (JSON). */
  async _mountCardEditor() {
    const box = this._root.querySelector("#cardedit");
    const card = this._hcard();
    if (!box || !card) return;
    const token = (this._edToken = (this._edToken || 0) + 1);
    let ok = false;
    try {
      if (!customElements.get("hui-card-element-editor") && window.loadCardHelpers) {
        // Trick: der Stapel-Editor von HA lädt den allgemeinen Karteneditor mit
        const h = await window.loadCardHelpers();
        const stack = await h.createCardElement({ type: "vertical-stack", cards: [] });
        if (stack && stack.constructor && stack.constructor.getConfigElement) await stack.constructor.getConfigElement();
        await Promise.race([customElements.whenDefined("hui-card-element-editor"), new Promise((r) => setTimeout(r, 3000))]);
      }
      if (token !== this._edToken) return;
      if (customElements.get("hui-card-element-editor")) {
        const ed = document.createElement("hui-card-element-editor");
        ed.hass = this._hass;
        ed.lovelace = { config: { views: [] }, editMode: true };
        ed.value = clone(card);
        // Der HA-Editor „räumt“ die Karte beim Öffnen auf und meldet das als Änderung.
        // Diese erste Meldung kurz nach dem Öffnen zählt nicht als Änderung des Benutzers.
        const openedAt = Date.now();
        let first = true;
        ed.addEventListener("config-changed", (ev) => {
          ev.stopPropagation();
          const conf = ev.detail && ev.detail.config;
          if (!conf || typeof conf !== "object" || !conf.type) return;
          const quiet = first && Date.now() - openedAt < 2000;
          first = false;
          this._replaceCard(conf, quiet);
        });
        box.innerHTML = "";
        box.appendChild(ed);
        ok = true;
      }
    } catch (e) { console.warn(LOG, "HA-Karteneditor nicht verfügbar", e); ok = false; }
    if (!ok) this._textEditor(box, card);
    const sw = document.createElement("div");
    sw.className = "row"; sw.style.marginTop = "8px";
    sw.innerHTML = `<button class="b mini" data-act="textEdit">${ok ? "Als Text bearbeiten" : ""}</button>`;
    if (ok) box.appendChild(sw);
  }
  _textEditor(box, card) {
    box.innerHTML = `<textarea id="cardjson" style="min-height:260px">${esc(JSON.stringify(card, null, 2))}</textarea>
      <div class="row" style="margin-top:6px"><button class="b pri" data-act="applyJson">Übernehmen</button><span class="small" id="jsonerr">Format: JSON</span></div>`;
  }
  _replaceCard(conf, quiet = false) {
    const s = this._sel, v = this._hview();
    const ct = this._containers(v)[s.sec];
    if (JSON.stringify(ct.cards[s.c]) === JSON.stringify(conf)) return; // nichts geändert
    ct.cards[s.c] = conf;
    if (quiet) return; // nur aufgeräumt – kein „ungespeichert“
    this._setDirty();
    clearTimeout(this._pt); this._pt = setTimeout(() => { this._renderPreview(); this._renderTree(); }, 400);
  }
  /** Regel aus einer Karte raten: Domäne + Geräteklasse der Entität */
  _guessRule(card) {
    const id = typeof card.entity === "string" ? card.entity : asList(card.entities).map((x) => (typeof x === "string" ? x : x && x.entity)).find(Boolean);
    if (!id) return [{ domain: "light" }];
    const e = collectEntities(this._hass).find((x) => x.entity_id === id);
    const g = { domain: id.split(".")[0] };
    if (e && e.device_class) g.device_class = e.device_class;
    return [g];
  }

  _templatesForm() {
    const t = this._cfg.templates;
    const used = (id) => [...asList(this._cfg.room.left), ...asList(this._cfg.room.right), ...this._cfg.pages.flatMap((p) => asList(p.blocks))]
      .filter((b) => b.card === "template" && b.template === id).map((b) => b.name);
    const items = Object.entries(t).map(([id, x]) => `<div class="col" style="padding:10px">
      <div class="row" style="justify-content:space-between"><b>${esc(x.label)}</b><span class="chip">${x.per === "all" ? "eine Karte für alle" : "je Gerät"}</span></div>
      <div class="small">Verwendet in: ${esc(used(id).join(", ") || "—")}</div>
      <pre>${esc(JSON.stringify(x.card, null, 2))}</pre>
      <div class="row" style="margin-top:6px"><button class="b mini danger" data-act="delTemplate" data-id="${esc(id)}">Vorlage löschen</button></div></div>`).join("");
    return `<div><div class="small">Werkzeug</div><div style="font-size:20px;font-weight:700">Kartenvorlagen</div></div>
      <div class="hint">Eine Vorlage ist eine deiner Karten, bei der das Gerät zu <code>{entity}</code> und der Name zu <code>{name}</code> wird. Weitere Platzhalter: <code>{area}</code>, <code>{entity_name}</code>; bei Listen-Karten <code>{entities}</code>. Neue Vorlagen legst du in einem Baustein an: „Karte aus Dashboard als Vorlage …“.</div>
      ${items || `<div class="small">Noch keine Vorlagen.</div>`}`;
  }

  _rawForm() {
    return `<div><div class="small">Werkzeug</div><div style="font-size:20px;font-weight:700">Bauplan ansehen</div></div>
      <div class="hint">So steht der Bauplan in der Dashboard-Konfiguration. Zum Sichern kopieren oder als Datei laden.</div>
      <div class="row"><button class="b" data-act="copyRaw">Kopieren</button><button class="b" data-act="downloadRaw">Als Datei laden</button></div>
      <textarea id="raw" readonly style="min-height:480px">${esc(JSON.stringify(this._cfg, null, 2))}</textarea>`;
  }

  // ------------------------------------------------------------------ Vorlage aus Karte
  async _loadDashboards() {
    if (this._dashCache) return this._dashCache;
    const list = [{ url_path: null, title: "Übersicht (Standard)" }];
    try {
      const ds = await this._hass.callWS({ type: "lovelace/dashboards/list" });
      ds.filter((d) => d.mode !== "yaml" || true).forEach((d) => list.push({ url_path: d.url_path, title: d.title || d.url_path }));
    } catch (e) { console.warn(LOG, "Dashboard-Liste nicht lesbar", e); }
    this._dashCache = list.filter((d) => d.url_path !== this._urlPath);
    return this._dashCache;
  }
  async _loadDashConfig(urlPath) {
    try { return await this._hass.callWS({ type: "lovelace/config", url_path: urlPath }); }
    catch (e) { return null; }
  }
  /** Alle Karten mit einer Entität (auch in Stacks/Abschnitten) einsammeln */
  _flattenCards(conf) {
    const out = [];
    const walk = (node, view) => {
      if (Array.isArray(node)) return node.forEach((n) => walk(n, view));
      if (!node || typeof node !== "object") return;
      if (node.type && (typeof node.entity === "string" || (Array.isArray(node.entities) && node.entities.length))) {
        out.push({ view, card: node });
      }
      for (const [k, v] of Object.entries(node)) if (k === "cards" || k === "sections" || k === "card") walk(v, view);
    };
    asList(conf && conf.views).forEach((v) => walk([v.sections, v.cards], v.title || v.path || "Ansicht"));
    return out;
  }

  async _renderPicker(query = "") {
    const box = this._root.querySelector("#tplpick");
    if (!box) return;
    if (!this._pick) {
      const ds = await this._loadDashboards();
      this._pick = { ds, url: ds.length ? ds[ds.length > 1 ? 1 : 0].url_path : null, cards: [] };
      await this._pickLoad();
    }
    const p = this._pick;
    const q = lower(query).split(/\s+/).filter(Boolean);
    const hits = p.cards.filter((x) => q.every((w) => lower(x.view + " " + x.card.type + " " + (x.card.entity || "") + " " + (x.card.name || "")).includes(w))).slice(0, 60);
    box.innerHTML = `<div class="col" style="border-style:dashed">
      <div class="row" style="justify-content:space-between"><b>${this._addTo !== undefined ? "Karte aus einem Dashboard einfügen" : "Karte als Vorlage nehmen"}</b><button class="b mini" data-act="closePicker">Schließen</button></div>
      <div class="row" style="margin-top:8px"><label for="pk-d">Dashboard</label><select id="pk-d" data-pick="dash">${p.ds.map((d) =>
        `<option value="${esc(d.url_path ?? "")}" ${String(d.url_path ?? "") === String(p.url ?? "") ? "selected" : ""}>${esc(d.title)}</option>`).join("")}</select></div>
      <div class="row" style="margin-top:6px"><label for="pk-q">Suchen</label><input id="pk-q" data-pick="q" value="${esc(query)}" placeholder="Teilwörter: Seite, Kartentyp, Gerät …"></div>
      <div style="margin-top:6px;max-height:340px;overflow:auto">${hits.map((x, i) => `<div class="hit">
        <span style="flex:1;min-width:0"><b>${esc(x.card.type)}</b> · ${esc(x.card.name || x.card.entity || (x.card.entities || []).length + " Geräte")}<br><span class="small">Seite ${esc(x.view)}</span></span>
        <button class="b mini" data-act="useCard" data-ci="${p.cards.indexOf(x)}">Übernehmen</button></div>`).join("") || `<div class="small">Keine Karten gefunden.</div>`}</div>
      <div class="small" style="margin-top:6px">Gerät → {entity}, Name → {name}. Alles andere (card_mod, Größen, Aktionen) bleibt genau so.</div></div>`;
  }
  async _pickLoad() {
    const conf = await this._loadDashConfig(this._pick.url || null);
    this._pick.cards = this._flattenCards(conf);
  }

  // ------------------------------------------------------------------ Aus Bestand übernehmen
  async _importForm(m) {
    const ds = await this._loadDashboards();
    if (!this._imp) this._imp = { url: ds.length > 1 ? ds[1].url_path : (ds[0] || {}).url_path, rows: null };
    const imp = this._imp;
    if (!imp.rows) {
      const conf = await this._loadDashConfig(imp.url || null);
      imp.rows = this._classifyViews(conf);
    }
    const sel = (r, i) => `<select data-imp="${i}">${[["hand", "als Handseite übernehmen"], ["gen", "wird generiert (weglassen)"], ["skip", "weglassen"]]
      .map(([v, l]) => `<option value="${v}" ${r.action === v ? "selected" : ""}>${l}</option>`).join("")}</select>`;
    m.innerHTML = `<div><div class="small">Werkzeug</div><div style="font-size:20px;font-weight:700">Aus Bestand übernehmen</div></div>
      <div class="hint">Liest ein bestehendes Dashboard. Seiten, die zu einer Etage oder einem Raum passen, erzeugt HomeCockpit künftig selbst; alles andere wird als feste Seite übernommen. Navigationsknöpfe werden auf dieses Dashboard umgebogen. Erst „Speichern“ schreibt etwas.</div>
      <div class="row"><label for="im-d">Dashboard</label><select id="im-d" data-imp="dash">${ds.map((d) =>
        `<option value="${esc(d.url_path ?? "")}" ${String(d.url_path ?? "") === String(imp.url ?? "") ? "selected" : ""}>${esc(d.title)}</option>`).join("")}</select></div>
      ${imp.rows && imp.rows.length ? `<table><tr><th>Seite</th><th>Erkannt</th><th>Übernehmen als</th></tr>${imp.rows.map((r, i) =>
        `<tr><td>${esc(r.title)}<div class="small">/${esc(r.path)}</div></td><td class="small">${esc(r.why)}</td><td>${sel(r, i)}</td></tr>`).join("")}</table>
        <div class="row"><button class="b pri" data-act="applyImport">Übernehmen</button><span class="small">ersetzt „Start & Handseiten“ und eigene Pfade</span></div>`
        : `<div class="small">Keine Seiten gefunden (oder Dashboard ist selbst eine Strategie).</div>`}`;
  }

  _classifyViews(conf) {
    if (!conf || !Array.isArray(conf.views)) return [];
    const floors = Object.values(this._hass.floors || {});
    const areas = Object.values(this._hass.areas || {});
    return conf.views.map((v) => {
      const title = v.title || v.path || "";
      const keys = [slug(title), slug(v.path || ""), lower(v.path || "")];
      // Etage erkennen: Name, ID, Aliase, übliche Abkürzungen (EG = Erdgeschoss …)
      const ABBR = { eg: "erdgeschoss", og: "obergeschoss", dg: "dachgeschoss", kg: "keller", ug: "untergeschoss" };
      const norm = (t) => { const x = slug(t).replace(/^\d+-/, ""); return ABBR[x] || x; };
      const fKeys = keys.map(norm);
      let f = floors.find((x) => [x.name, x.floor_id, ...asList(x.aliases)].some((n) => fKeys.includes(norm(n))));
      const a = areas.find((x) => keys.includes(slug(x.name)) || keys.includes(lower(x.area_id)));
      const empty = !asList(v.sections).some((s) => asList(s.cards).length) && !asList(v.cards).length;
      // Etagenseite = (fast) nur Navigationsknöpfe. Hat sie eigene Inhalte (z. B. Keller mit Heizungsanlage),
      // bleibt sie Handseite und ersetzt die generierte Etage (gleicher Pfad).
      const cardsOf = (n, out = []) => { if (Array.isArray(n)) n.forEach((x) => cardsOf(x, out));
        else if (n && typeof n === "object") { if (n.type && !["horizontal-stack", "vertical-stack", "grid"].includes(n.type)) out.push(n);
          ["cards", "sections"].forEach((k) => n[k] && cardsOf(n[k], out)); } return out; };
      const all = cardsOf([v.sections, v.cards]).filter((c) => c.type !== "heading");
      const nav = all.filter((c) => c.tap_action && c.tap_action.action === "navigate");
      const navOnly = all.length > 0 && nav.length >= all.length * 0.7;
      // Reine Knopf-Seite, deren Ziele Räume EINER Etage sind → diese Etage
      if (!f && navOnly) {
        const count = {};
        nav.forEach((c) => {
          const last = lower(String(c.tap_action.navigation_path).split("/").pop());
          const ar = areas.find((x) => slug(x.name) === last || lower(x.area_id) === last || slug(byArea(this._cfg.paths, x) || "") === last);
          if (ar && ar.floor_id) count[ar.floor_id] = (count[ar.floor_id] || 0) + 1;
        });
        const best = Object.entries(count).sort((x, y) => y[1] - x[1])[0];
        if (best && best[1] >= 2) f = floors.find((x) => x.floor_id === best[0]);
      }
      let action = "hand", why = "eigene Seite";
      if (v.strategy) { action = "skip"; why = "Strategie-Seite"; }
      else if (v.type === "panel" && asList(v.cards).some((c) => c.type === "custom:home-cockpit-editor")) { action = "skip"; why = "HomeCockpit-Editor"; }
      else if (empty) { action = "skip"; why = "leer"; }
      else if (f && navOnly) { action = "gen"; why = `Etage ${f.name} (nur Raumknöpfe)`; }
      else if (f) { why = `Etage ${f.name} mit eigenen Inhalten – als Handseite`; }
      else if (a && a.floor_id) { action = "gen"; why = `Raum ${a.name}`; }
      else if (a) { why = `Bereich ${a.name} ohne Etage – als Handseite`; }
      return { title, path: v.path || slug(title), view: v, action, why, area: a, floor: f };
    });
  }

  _applyImport() {
    const imp = this._imp, c = this._cfg;
    const oldBase = "/" + (imp.url || "lovelace") + "/";
    const newBase = "/" + (this._urlPath || "lovelace") + "/";
    const fix = (v) => JSON.parse(JSON.stringify(v).split(`"${oldBase}`).join(`"${newBase}`));
    const hand = imp.rows.filter((r) => r.action === "hand").map((r) => fix(r.view));
    c.views_before = hand.slice(0, 1);
    c.views_after = hand.slice(1);
    c.home_path = hand.length ? hand[0].path : c.home_path;
    c.dashboard_path = "/" + (this._urlPath || "lovelace");
    // Alte Pfade beibehalten, damit Knöpfe auf den Handseiten weiter funktionieren
    const paths = { ...(c.paths || {}) };
    imp.rows.filter((r) => r.action === "gen").forEach((r) => {
      const name = r.floor && !r.area ? r.floor.name : r.area ? r.area.name : r.floor ? r.floor.name : null;
      if (name && r.path && r.path !== slug(name)) paths[name] = r.path;
    });
    c.paths = paths;
    this._setDirty();
    this._sel = { kind: "hand" };
    this._renderAll();
    this._status(`${hand.length} Seiten übernommen – noch nicht gespeichert`);
  }

  // ------------------------------------------------------------------ Nicht zugeordnet
  async _unassignedForm(m) {
    const all = await explainAll(this._cfg, this._hass);
    const miss = all.filter((e) => e.status === "missing");
    const groups = {};
    miss.forEach((e) => (groups[e.why] = groups[e.why] || []).push(e));
    // Knöpfe auf Handseiten, deren Ziel es in diesem Dashboard nicht (mehr) gibt
    const { floors } = buildLayout(this._cfg, this._hass);
    const have = new Set([...pathsOf(this._cfg.views_before), ...pathsOf(this._cfg.views_after),
      ...floors.filter((f) => !f.hand).map((f) => f.path), ...floors.flatMap((f) => f.areas.map((a) => a.path)),
      ...asList(this._cfg.pages).map((pg) => pg.path || slug(pg.title)), "nicht-zugeordnet", "homecockpit"]);
    const base = "/" + (this._urlPath || "lovelace") + "/";
    const dead = [];
    const scan = (n, page) => {
      if (Array.isArray(n)) return n.forEach((x) => scan(x, page));
      if (!n || typeof n !== "object") return;
      const np = n.tap_action && n.tap_action.navigation_path;
      if (typeof np === "string") {
        const inside = np.startsWith(base) || !np.startsWith("/");
        const target = np.startsWith(base) ? np.slice(base.length) : np;
        if (inside && !have.has(target.split("#")[0])) dead.push({ page, target, name: n.name || n.entity || n.type });
      }
      Object.values(n).forEach((v) => scan(v, page));
    };
    [...asList(this._cfg.views_before), ...asList(this._cfg.views_after)].forEach((v) => scan(v.sections || v.cards, v.title || v.path));
    m.innerHTML = `<div><div class="small">Werkzeug</div><div style="font-size:20px;font-weight:700">Nicht zugeordnet (${miss.length})</div></div>
      ${dead.length ? `<div class="hint warn"><b>${dead.length} Knöpfe führen ins Leere</b> – Ziel gibt es in diesem Dashboard nicht:
        ${dead.map((d) => `<div class="small">Seite ${esc(d.page)} · ${esc(d.name)} → <code>${esc(d.target)}</code></div>`).join("")}
        <div class="small" style="margin-top:4px">Lösung: Seite übernehmen, Etage in „Etagen“ aufnehmen oder unter „Eigene Pfade“ zuordnen (z. B. <code>EG = erdgeschoss</code>).</div></div>` : ""}
      <div class="hint">Geräte, die mit dem aktuellen (auch ungespeicherten) Bauplan nirgends erscheinen. Lösung: Bereich in HA setzen, Baustein-Regel erweitern oder bewusst weglassen.</div>
      ${Object.entries(groups).sort((a, b) => b[1].length - a[1].length).map(([why, list]) => `<div>
        <div class="lbl" style="margin:8px 0 4px">${esc(why)} (${list.length})</div>
        ${list.slice(0, 80).map((e) => `<div class="hit"><span>${esc(e.name)}</span><span class="id">${esc(e.entity_id)}</span>
          <button class="b mini" data-act="excludeGlobal" data-e="${esc(e.entity_id)}" title="Nie automatisch zeigen">ignorieren</button></div>`).join("")}
        ${list.length > 80 ? `<div class="small">… und ${list.length - 80} weitere</div>` : ""}</div>`).join("") || `<div>Alles ist zugeordnet ✓</div>`}
      <div class="small">Ignoriert: ${asList(this._cfg.exclude).length}</div>`;
  }

  // ------------------------------------------------------------------ Vorschau (echte HA-Karten)
  _previewAreas() {
    const { floors } = buildLayout(this._cfg, this._hass);
    return floors.flatMap((f) => f.areas.filter((a) => !a.hand).map((a) => ({ ...a, floor: f.name })));
  }

  async _renderPreview() {
    const box = this._root.querySelector("#prev");
    const s = this._sel;
    const token = (this._pvToken = (this._pvToken || 0) + 1);
    this._pvEls = [];
    if (s.kind === "hpage" || s.kind === "hcard") { await this._renderHandPreview(box, token); return; }
    if (s.kind !== "room" && s.kind !== "pblock" && s.kind !== "page") {
      box.innerHTML = `<div class="lbl">Vorschau</div><div class="small">Einen Baustein wählen, um die Karten zu sehen.</div>`;
      return;
    }
    const cfg = this._cfg;
    const ents = collectEntities(this._hass).filter((e) => !excludedWhy(e, cfg));
    let head = "", hitsHtml = "", cards = [], area = null;
    if (s.kind === "room") {
      const areas = this._previewAreas();
      if (!this._sampleArea || !areas.some((a) => a.area_id === this._sampleArea)) {
        const withHits = areas.find((a) => ents.some((e) => e.area_id === a.area_id && matchBlock(e, this._block(), this._ctx)));
        this._sampleArea = (withHits || areas[0] || {}).area_id;
      }
      area = (this._hass.areas || {})[this._sampleArea] || null;
      head = `<div class="row"><label for="pv-a">Beispielraum</label><select id="pv-a" data-pv="area">${areas.map((a) =>
        `<option value="${esc(a.area_id)}" ${a.area_id === this._sampleArea ? "selected" : ""}>${esc(a.floor)} · ${esc(a.name)}</option>`).join("")}</select></div>`;
      const inArea = ents.filter((e) => area && e.area_id === area.area_id);
      const { left, right } = roomBlocks(cfg);
      const { result } = assignBlocks(inArea, [...left, ...right], this._ctx, { order: claimOrder(left, right) });
      const idx = (s.side === "left" ? 0 : left.length) + s.i;
      const b = this._block();
      const hits = result[idx] ? result[idx].hits : [];
      const exHits = inArea.filter((e) => asList(b.exclude).includes(e.entity_id) && matchBlock(e, { ...b, exclude: [] }, this._ctx));
      hitsHtml = this._hitList(b, hits, exHits, inArea);
      cards = await sectionFromBlocks([{ block: b, hits }], area, cfg);
    } else {
      const pg = cfg.pages[s.p];
      const blocks = asList(pg.blocks);
      if (s.kind === "pblock") {
        const b = this._block();
        const { result } = assignBlocks(ents, blocks, this._ctx);
        const hits = result[s.i] ? result[s.i].hits : [];
        const exHits = ents.filter((e) => asList(b.exclude).includes(e.entity_id) && matchBlock(e, { ...b, exclude: [] }, this._ctx));
        hitsHtml = this._hitList(b, hits, exHits, ents);
        const secs = await buildPageSections(pg, cfg, this._hass, s.i);
        cards = secs.flatMap((x) => x.cards);
      } else {
        const secs = await buildPageSections(pg, cfg, this._hass);
        cards = secs.flatMap((x) => x.cards);
      }
    }
    if (token !== this._pvToken) return; // veraltet (schnelles Tippen)
    box.innerHTML = `<div class="lbl">Vorschau ${s.kind === "room" && area ? "· Raum " + esc(area.name) : ""}</div>${head}
      <div class="pv" id="pvcards"></div>${hitsHtml}
      <div id="why"></div>`;
    await this._mountCards(box.querySelector("#pvcards"), cards, token);
  }

  async _renderHandPreview(box, token) {
    const s = this._sel, v = this._hview();
    if (!v) { box.innerHTML = ""; return; }
    const ctx = this._ctx;
    const one = s.kind === "hcard";
    let cards = [], hitsHtml = "";
    if (one) {
      const card = this._hcard();
      if (card && card.type === BLOCK_CARD) {
        const ents = collectEntities(this._hass).filter((e) => !excludedWhy(e, this._cfg));
        const b = card.block;
        const { result } = assignBlocks(ents, [b], ctx);
        const exHits = ents.filter((e) => asList(b.exclude).includes(e.entity_id) && matchBlock(e, { ...b, exclude: [] }, ctx));
        hitsHtml = this._hitList(b, result[0].hits, exHits, ents);
        cards = await sectionFromBlocks(result, null, this._cfg);
      } else if (card) cards = [card];
    } else {
      const exp = await expandHandView(v, this._cfg, this._hass, ctx);
      cards = this._containers(exp).flatMap((ct) => asList(ct.cards));
    }
    if (token !== this._pvToken) return;
    box.innerHTML = `<div class="lbl">Vorschau · ${one ? "Karte" : "Seite " + esc(v.title || v.path)}</div><div class="pv" id="pvcards"></div>${hitsHtml}<div id="why"></div>`;
    await this._mountCards(box.querySelector("#pvcards"), cards, token);
  }

  _hitList(b, hits, exHits, scope) {
    const rows = [...hits.map((e) => ({ e, on: true })), ...exHits.map((e) => ({ e, on: false }))];
    return `<div><div class="lbl" style="margin:6px 0 2px">Treffer ${hits.length}${exHits.length ? ` · ${exHits.length} ausgenommen` : ""}</div>
      ${rows.map(({ e, on }, i) => `<div class="hit"><input type="checkbox" id="h${i}" data-hit="${esc(e.entity_id)}" ${on ? "checked" : ""}>
        <label for="h${i}" class="${on ? "" : "off"}">${esc(e.name)}</label><span class="id">${esc(e.entity_id)}</span></div>`).join("")
        || `<div class="small" style="padding:6px 0">Keine Treffer – Regel anpassen (oder schon von einem früheren Baustein vergeben).</div>`}
      <div class="small" style="margin-top:4px">Haken weg = Ausnahme für diesen Baustein.</div></div>`;
  }

  async _mountCards(el, cards, token) {
    if (!cards.length) { el.innerHTML = `<div class="small">Leer – wird ausgeblendet.</div>`; return; }
    let helpers = null;
    try { helpers = window.loadCardHelpers ? await window.loadCardHelpers() : null; } catch (e) { helpers = null; }
    if (token !== this._pvToken) return;
    el.innerHTML = "";
    for (const conf of cards) {
      const wrap = document.createElement("div");
      wrap.className = "pvwrap" + (conf.type === "tile" || conf.type === "button" ? " half" : "");
      let card;
      try {
        // Vorschau ohne Sichtbarkeitsbedingung, damit z. B. „Offen“ auch geschlossen zu sehen ist
        const c = { ...conf }; delete c.visibility;
        card = helpers ? helpers.createCardElement(c) : document.createElement("div");
        if (!helpers) card.textContent = conf.type + (conf.entity ? " · " + conf.entity : "");
        card.hass = this._hass;
      } catch (e) {
        card = document.createElement("div"); card.textContent = "Karte nicht darstellbar: " + conf.type;
      }
      this._pvEls.push(card);
      wrap.appendChild(card);
      const shield = document.createElement("div");
      shield.className = "shield"; // Klicks gehen an „Warum?“, nicht an die Karte
      shield.dataset.why = JSON.stringify({ type: conf.type, entity: conf.entity || null });
      wrap.appendChild(shield);
      el.appendChild(wrap);
    }
  }

  async _showWhy(info, wrap) {
    this._root.querySelectorAll(".pvwrap.sel").forEach((x) => x.classList.remove("sel"));
    if (wrap) wrap.classList.add("sel");
    const box = this._root.querySelector("#why");
    if (!box) return;
    const b = this._block(), s = this._sel;
    const rows = [];
    if (s.kind === "hpage" || (s.kind === "hcard" && !b)) rows.push(["Karte", "feste Karte – steht genau so in der Seite"], ["Seite", (this._hview() || {}).title || ""]);
    else if (info.type === "heading") rows.push(["Karte", "Überschrift des Bausteins"]);
    else {
      rows.push(["Ansicht", s.kind === "room" ? "Raumseite (je Bereich)" : s.kind === "hcard" ? `Feste Seite „${(this._hview() || {}).title || ""}“`
        : `Seite „${this._cfg.pages[s.p].title}“`]);
      if (s.kind === "room") rows.push(["Raum", ((this._hass.areas || {})[this._sampleArea] || {}).name || "—"]);
      if (b) rows.push(["Baustein", `${b.name} · Karte: ${b.card === "template" ? "Vorlage " + ((this._cfg.templates[b.template] || {}).label || b.template) : b.card || "tile"}`]);
      if (b) rows.push(["Regel", asList(b.any).map((g) => Object.entries(g).map(([k, v]) => `${(CRITERIA.find((c) => c[0] === k) || [k, k])[1]} = ${listText(v)}`).join(" UND ")).join(" ODER ") || "alles"]);
      if (info.entity) {
        const e = collectEntities(this._hass).find((x) => x.entity_id === info.entity);
        if (e) rows.push(["Dieses Gerät", `${e.domain}${e.device_class ? " · " + e.device_class : ""}${e.labels.length ? " · Label " + e.labels.join(", ") : ""}`]);
      }
    }
    box.innerHTML = `<div class="lbl" style="margin-top:6px">Warum ist diese Karte hier?</div>
      ${rows.map(([k, v]) => `<div style="background:var(--hc-soft);border-radius:8px;padding:6px 9px;margin-top:5px"><div class="small">${esc(k)}</div>${esc(v)}</div>`).join("")}
      ${info.entity && b ? `<div class="row" style="margin-top:6px"><button class="b mini" data-act="hideHere" data-e="${esc(info.entity)}">Hier ausblenden</button></div>` : ""}`;
  }

  // ------------------------------------------------------------------ Ereignisse
  async _onClick(ev) {
    const t = ev.target.closest("[data-act],.shield");
    if (!t) return;
    if (t.classList.contains("shield")) { this._showWhy(JSON.parse(t.dataset.why), t.parentElement); return; }
    const a = t.dataset.act, c = this._cfg, d = t.dataset;
    const list = this._blockList();
    const renderAll = () => { this._setDirty(); this._renderAll(); };
    switch (a) {
      case "sel":
        this._sel = { kind: d.kind, side: d.side, i: d.i !== undefined ? +d.i : undefined, p: d.p !== undefined ? +d.p : undefined,
          key: d.key, v: d.v !== undefined ? +d.v : undefined };
        this._pick = null;
        this._renderAll(); break;
      case "addRoomBlock":
        c.room[d.side].push({ name: "Neuer Baustein", card: "tile", any: [{ domain: "light" }] });
        this._sel = { kind: "room", side: d.side, i: c.room[d.side].length - 1 }; renderAll(); break;
      case "addPageBlock":
        c.pages[+d.p].blocks = asList(c.pages[+d.p].blocks);
        c.pages[+d.p].blocks.push({ name: "Neuer Baustein", card: "tile", any: [{ domain: "sensor", device_class: "temperature" }] });
        this._sel = { kind: "pblock", p: +d.p, i: c.pages[+d.p].blocks.length - 1 }; renderAll(); break;
      case "addPage": {
        const n = c.pages.length + 1;
        c.pages.push({ title: "Neue Seite " + n, path: "seite-" + n, blocks: [] });
        this._sel = { kind: "page", p: c.pages.length - 1 }; renderAll(); break;
      }
      case "delPage":
        c.pages.splice(this._sel.p, 1); this._sel = { kind: "floors" }; renderAll(); break;
      case "delBlock":
        list.splice(this._sel.i, 1);
        this._sel = this._sel.kind === "room" ? { kind: "floors" } : { kind: "page", p: this._sel.p }; renderAll(); break;
      case "moveBlock": {
        const i = this._sel.i, j = i + +d.d;
        if (j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]]; this._sel.i = j; renderAll(); break;
      }
      case "switchSide": {
        const from = this._sel.side, to = from === "left" ? "right" : "left";
        const [b] = c.room[from].splice(this._sel.i, 1); c.room[to].push(b);
        this._sel = { kind: "room", side: to, i: c.room[to].length - 1 }; renderAll(); break;
      }
      case "addGroup": { const b = this._block(); b[d.key] = asList(b[d.key]); b[d.key].push({}); renderAll(); break; }
      case "delGroup": { const b = this._block(); b[d.key].splice(+d.g, 1); if (!b[d.key].length) delete b[d.key]; renderAll(); break; }
      case "pickTemplate": this._pick = null; await this._renderPicker(""); break;
      case "closePicker": { const box = this._root.querySelector("#tplpick"); if (box) box.innerHTML = ""; this._pick = null; break; }
      case "useCard": {
        const x = this._pick.cards[+d.ci];
        if (this._sel.kind === "hpage" && this._addTo !== undefined) {
          const s = this._sel, ct = this._containers(this._hview())[this._addTo];
          ct.cards = asList(ct.cards); ct.cards.push(clone(x.card));
          this._sel = { kind: "hcard", key: s.key, v: s.v, sec: this._addTo, c: ct.cards.length - 1 };
          this._addTo = undefined; this._pick = null; renderAll(); break;
        }
        let id = slug(x.card.type.replace("custom:", "") + "-" + (x.card.name || x.view)) || "vorlage";
        while (c.templates[id]) id += "-2";
        c.templates[id] = makeTemplate(clone(x.card), `${x.card.type.replace("custom:", "")} (${x.view})`);
        const b = this._block(); b.card = "template"; b.template = id;
        this._pick = null; renderAll();
        this._status("Vorlage angelegt – noch nicht gespeichert"); break;
      }
      case "delTemplate": delete c.templates[d.id]; renderAll(); break;
      case "handDel": c[d.key].splice(+d.i, 1); renderAll(); break;
      case "handMove": {
        const [v] = c[d.key].splice(+d.i, 1);
        const other = d.key === "views_before" ? "views_after" : "views_before";
        c[other] = asList(c[other]); if (other === "views_before") c[other].push(v); else c[other].unshift(v);
        renderAll(); break;
      }
      case "applyImport": this._applyImport(); break;
      case "excludeGlobal": c.exclude = [...asList(c.exclude), d.e]; this._setDirty(); this._renderMain(); break;
      case "hideHere": { const b = this._block(); b.exclude = [...asList(b.exclude), d.e]; this._setDirty(); this._renderPreview(); break; }
      case "copyRaw": {
        // navigator.clipboard gibt es nur über HTTPS; im Heimnetz (http://…:8123) und in der App
        // daher Rückfall auf Markieren + execCommand.
        const text = JSON.stringify(c, null, 2);
        let ok = false;
        try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; } } catch (e) { ok = false; }
        if (!ok) {
          const ta = this._root.querySelector("#raw");
          try { ta.focus(); ta.select(); ta.setSelectionRange(0, text.length); ok = document.execCommand("copy"); } catch (e) { ok = false; }
        }
        this._status(ok ? "Kopiert ✓" : "Bitte jetzt „Kopieren“ aus dem Menü wählen (Text ist markiert)");
        break;
      }
      case "downloadRaw": {
        const blob = new Blob([JSON.stringify(c, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `homecockpit-bauplan-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        this._status("Datei wird geladen");
        break;
      }
      case "hcardSel":
        this._sel = { kind: "hcard", key: this._sel.key, v: this._sel.v, sec: +d.sec, c: +d.c };
        this._renderAll(); break;
      case "hpageBack": this._sel = { kind: "hpage", key: this._sel.key, v: this._sel.v }; this._renderAll(); break;
      case "hcardMoveAt": case "hcardMove": {
        const s = this._sel, v = this._hview();
        const sec = a === "hcardMoveAt" ? +d.sec : s.sec, ci = a === "hcardMoveAt" ? +d.c : s.c;
        const conts = this._containers(v), arr = conts[sec].cards, j = ci + +d.d;
        if (j >= 0 && j < arr.length) { [arr[ci], arr[j]] = [arr[j], arr[ci]]; if (a === "hcardMove") s.c = j; }
        else if (j < 0 && sec > 0) { const [x] = arr.splice(ci, 1); conts[sec - 1].cards = asList(conts[sec - 1].cards); conts[sec - 1].cards.push(x); if (a === "hcardMove") { s.sec = sec - 1; s.c = conts[sec - 1].cards.length - 1; } }
        else if (j >= arr.length && sec < conts.length - 1) { const [x] = arr.splice(ci, 1); conts[sec + 1].cards = asList(conts[sec + 1].cards); conts[sec + 1].cards.unshift(x); if (a === "hcardMove") { s.sec = sec + 1; s.c = 0; } }
        else return;
        renderAll(); break;
      }
      case "hcardDel": { const s = this._sel; this._containers(this._hview()).at(s.sec).cards.splice(s.c, 1); this._sel = { kind: "hpage", key: s.key, v: s.v }; renderAll(); break; }
      case "hcardDup": { const s = this._sel, arr = this._containers(this._hview())[s.sec].cards; arr.splice(s.c + 1, 0, clone(arr[s.c])); s.c += 1; renderAll(); break; }
      case "hcardAdd": {
        this._addTo = +d.sec; this._pick = null; await this._renderPicker("");
        const box = this._root.querySelector("#tplpick");
        if (box) box.insertAdjacentHTML("afterbegin", `<div class="row" style="margin-bottom:6px"><button class="b" data-act="hcardAddEmpty">Leere Kachel einfügen</button><span class="small">oder unten eine Karte aus einem Dashboard übernehmen</span></div>`);
        break;
      }
      case "hcardAddEmpty": {
        const s = this._sel, ct = this._containers(this._hview())[this._addTo || 0];
        ct.cards = asList(ct.cards); ct.cards.push({ type: "tile", entity: Object.keys(this._hass.states)[0] || "" });
        this._sel = { kind: "hcard", key: s.key, v: s.v, sec: this._addTo || 0, c: ct.cards.length - 1 }; this._addTo = undefined; renderAll(); break;
      }
      case "hsecAdd": { const v = this._hview(); v.sections.push({ type: "grid", cards: [] }); renderAll(); break; }
      case "hsecDel": { const v = this._hview(); v.sections.splice(+d.sec, 1); renderAll(); break; }
      case "hpageDel": { const s = this._sel; c[s.key].splice(s.v, 1); this._sel = { kind: "hand" }; renderAll(); break; }
      case "hcardAuto": {
        const s = this._sel, card = this._hcard();
        let id = slug((card.type || "karte").replace("custom:", "") + "-" + this._cardLabel(card)) || "vorlage";
        while (c.templates[id]) id += "-2";
        c.templates[id] = makeTemplate(clone(card), `${(card.type || "").replace("custom:", "")} (${this._cardLabel(card)})`);
        const block = { name: this._cardLabel(card), card: "template", template: id, heading: false, any: this._guessRule(card) };
        this._containers(this._hview())[s.sec].cards[s.c] = { type: BLOCK_CARD, block };
        renderAll(); this._status("Automatisch gemacht – Regel prüfen, dann speichern"); break;
      }
      case "textEdit": { const box = this._root.querySelector("#cardedit"); this._edToken = (this._edToken || 0) + 1; this._textEditor(box, this._hcard()); break; }
      case "applyJson": {
        const ta = this._root.querySelector("#cardjson");
        try { const conf = JSON.parse(ta.value); if (!conf || !conf.type) throw new Error("„type“ fehlt"); this._replaceCard(conf); this._root.querySelector("#jsonerr").textContent = "Übernommen ✓"; }
        catch (e) { this._root.querySelector("#jsonerr").textContent = "Fehler: " + e.message; }
        break;
      }
      case "save": await this._save(); break;
      case "undo": this._undo(); break;
    }
  }

  _onInput(ev) {
    const t = ev.target;
    if (t.dataset.pick === "q") { clearTimeout(this._pq); this._pq = setTimeout(() => this._renderPicker(t.value).then(() => {
      const q = this._root.querySelector("#pk-q"); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }), 250); return; }
    if (t.dataset.field && t.type !== "checkbox" && t.tagName !== "SELECT") {
      const b = this._block(); if (!b) return;
      const f = t.dataset.field;
      if (f === "name") b.name = t.value;
      else if (f === "limit") { if (t.value) b.limit = +t.value; else delete b.limit; }
      else if (f === "visible_state") { if (t.value) b.visible_state = t.value; else delete b.visible_state; }
      else {
        const [key, gi, crit] = f.split(".");
        const g = b[key][+gi]; const v = parseList(t.value);
        if (v === undefined) delete g[crit]; else g[crit] = v;
      }
      this._setDirty();
      clearTimeout(this._pt); this._pt = setTimeout(() => { this._renderPreview(); if (f === "name") this._renderTree(); }, 300);
      return;
    }
    if (t.dataset.pfield && t.type !== "checkbox" && t.tagName !== "SELECT") {
      const pg = this._cfg.pages[this._sel.p];
      if (t.value) pg[t.dataset.pfield] = t.value; else delete pg[t.dataset.pfield];
      this._setDirty(); clearTimeout(this._pt); this._pt = setTimeout(() => this._renderTree(), 300); return;
    }
    if (t.dataset.cfield && t.type !== "checkbox") { this._setCfield(t); }
    if (t.dataset.hpfield && t.type !== "checkbox") {
      const v = this._hview(); if (t.value) v[t.dataset.hpfield] = t.value; else delete v[t.dataset.hpfield];
      this._setDirty(); clearTimeout(this._pt); this._pt = setTimeout(() => this._renderTree(), 300);
    }
  }

  _setCfield(t) {
    const c = this._cfg, f = t.dataset.cfield;
    if (f === "paths") {
      const o = {};
      t.value.split("\n").forEach((line) => { const [k, ...r] = line.split("="); if (k && r.length && k.trim() && r.join("=").trim()) o[k.trim()] = r.join("=").trim(); });
      c.paths = o;
    } else if (f.startsWith("outside.")) {
      c.outside = c.outside || {};
      const k = f.split(".")[1];
      const v = k === "areas" ? parseList(t.value) : t.value;
      if (v === undefined || v === "") delete c.outside[k]; else c.outside[k] = k === "areas" ? asList(v) : v;
      if (!Object.keys(c.outside).length) delete c.outside;
    } else if (f === "max_columns") { c.max_columns = +t.value || 2; }
    else if (f === "floors" || f === "area_order") { const v = parseList(t.value); if (v === undefined) delete c[f]; else c[f] = asList(v); }
    else { if (t.value) c[f] = t.value; else delete c[f]; }
    this._setDirty();
  }

  async _onChange(ev) {
    const t = ev.target;
    if (t.dataset.hit) {
      const b = this._block(), id = t.dataset.hit;
      b.exclude = t.checked ? asList(b.exclude).filter((x) => x !== id) : [...asList(b.exclude), id];
      if (!b.exclude.length) delete b.exclude;
      this._setDirty(); this._renderPreview(); return;
    }
    if (t.dataset.pv === "area") { this._sampleArea = t.value; this._renderPreview(); return; }
    if (t.dataset.pick === "dash") { this._pick.url = t.value || null; await this._pickLoad(); this._renderPicker(""); return; }
    if (t.dataset.imp === "dash") { this._imp = { url: t.value || null, rows: null }; this._renderMain(); return; }
    if (t.dataset.imp !== undefined && t.dataset.imp !== "dash") { this._imp.rows[+t.dataset.imp].action = t.value; return; }
    if (t.dataset.field === "cardsel") {
      const b = this._block();
      if (t.value.startsWith("template:")) { b.card = "template"; b.template = t.value.slice(9); }
      else { b.card = t.value; delete b.template; }
      this._setDirty(); this._renderPreview(); return;
    }
    if (t.dataset.field && t.type === "checkbox") {
      const b = this._block(), f = t.dataset.field;
      if (f === "heading") { if (t.checked) delete b.heading; else b.heading = false; }
      if (f === "shared") { if (t.checked) b.shared = true; else delete b.shared; }
      if (f === "group_by") { if (t.checked) b.group_by = "area"; else delete b.group_by; }
      this._setDirty(); this._renderPreview(); return;
    }
    if (t.dataset.pfield && (t.type === "checkbox" || t.tagName === "SELECT")) {
      const pg = this._cfg.pages[this._sel.p], f = t.dataset.pfield;
      const v = t.type === "checkbox" ? t.checked : t.value;
      if (v) pg[f] = v; else delete pg[f];
      this._setDirty(); return;
    }
    if (t.dataset.cfield && t.type === "checkbox") { this._cfg[t.dataset.cfield] = t.checked; this._setDirty(); }
    if (t.dataset.hpfield && t.type === "checkbox") { const v = this._hview(); if (t.checked) v.subview = true; else delete v.subview; this._setDirty(); }
  }

  // ------------------------------------------------------------------ Speichern / Rückgängig
  async _save() {
    const btn = this._root.querySelector("#save");
    btn.disabled = true; this._status("Speichere …");
    try {
      try { localStorage.setItem(this._backupKey(), JSON.stringify(this._orig)); } catch (e) { /* ohne Sicherung weiter */ }
      await this._hass.callWS({ type: "lovelace/config/save", url_path: this._urlPath, config: { strategy: this._cfg } });
      this._orig = clone(this._cfg); this._dirty = false;
      this._status("Gespeichert ✓ – Dashboard wird neu aufgebaut …");
      setTimeout(() => location.reload(), 900);
    } catch (err) {
      btn.disabled = false;
      this._status("Fehler beim Speichern: " + (err && err.message ? err.message : err));
    }
  }

  _undo() {
    let prev = null;
    try { prev = JSON.parse(localStorage.getItem(this._backupKey()) || "null"); } catch (e) { prev = null; }
    if (!prev) { this._status("Keine Sicherung vorhanden"); return; }
    this._cfg = prev;
    if (!this._cfg.room) this._cfg.room = clone(DEFAULT_ROOM);
    this._cfg.templates = this._cfg.templates || {}; this._cfg.pages = asList(this._cfg.pages);
    this._sel = { kind: "floors" };
    this._setDirty(); this._renderAll();
    this._status("Letzte Sicherung geladen – mit „Speichern“ übernehmen");
  }
}

// ---------------------------------------------------------------------------
// Registrierung (doppeltes Laden der Ressource darf nicht crashen)
// ---------------------------------------------------------------------------

const define = (tag, cls) => { if (!customElements.get(tag)) customElements.define(tag, cls); };
define("ll-strategy-dashboard-home-cockpit", HomeCockpitDashboardStrategy);
define("ll-strategy-view-home-cockpit-floor", HomeCockpitFloorViewStrategy);
define("ll-strategy-view-home-cockpit-room", HomeCockpitRoomViewStrategy);
define("ll-strategy-view-home-cockpit-unassigned", HomeCockpitUnassignedViewStrategy);
define("ll-strategy-view-home-cockpit-page", HomeCockpitPageViewStrategy);
define("home-cockpit-editor", HomeCockpitEditor);

// Ab HA 2026.5: im Dialog „Dashboard hinzufügen“ unter „Community-Dashboards“ anbieten –
// dann braucht man zum Anlegen kein YAML mehr.
window.customStrategies = window.customStrategies || [];
if (!window.customStrategies.some((x) => x.type === "home-cockpit")) {
  window.customStrategies.push({
    type: "home-cockpit",
    strategyType: "dashboard",
    name: "HomeCockpit",
    description: "Dashboard nach Regeln (Etagen, Räume, Labels) – mit grafischem Editor im Tab „HomeCockpit“.",
  });
}

// Für den Editor und für Tests
window.HomeCockpit = { VERSION, explain: explainAll, slug, DEFAULT_ROOM, makeTemplate, fillPlaceholders };

console.info(`%c HOME COCKPIT %c ${VERSION} `, "background:#0b5cad;color:#fff;font-weight:700", "background:#e3eefa;color:#0b5cad");
