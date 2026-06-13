export function normalizeText(value = "") {
  return String(value)
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function normalizePartNumber(value = "") {
  return normalizeText(value).replace(/[^A-Z0-9]/g, "");
}

export function parsePositiveInt(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

export function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function extractSearchNumbers(value = "") {
  const text = String(value);
  const matches = text.match(/\d+(\.\d+)?/g) || [];

  return matches
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

export function normalizeSearchQuery(value = "") {
  return normalizeText(value)
    .replace(/[.,;:(){}[\]"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set([
  "DE",
  "DEL",
  "LA",
  "EL",
  "LOS",
  "LAS",
  "Y",
  "O",
  "PARA",
  "CON",
  "SIN",
  "UN",
  "UNA",
]);

export function getSearchTokens(value = "") {
  const normalized = normalizeSearchQuery(value);

  if (!normalized) return [];

  const text = ` ${normalized} `;
  const terms = new Set();

  terms.add(normalized);

  const words = normalized
    .split(" ")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !STOP_WORDS.has(item))
    .filter((item) => item.length >= 2);

  words.forEach((word) => terms.add(word));

  // Familias conocidas: agregamos términos útiles, pero sin explotar la búsqueda.
  if (text.includes(" DEPOSITO ")) {
    terms.add("DEPOSITO");
    terms.add("DEPOSITO ANTICONGELANTE");
  }

  if (text.includes(" TAPON ")) {
    terms.add("TAPON");
    terms.add("TAPON DEPOSITO ANTICONGELANTE");
  }

  if (text.includes(" BOMBA ")) {
    terms.add("BOMBA");
    terms.add("BOMBAS DE AGUA");
  }

  if (text.includes(" TOMA ")) {
    terms.add("TOMA");

    if (text.includes(" AGUA ")) {
      terms.add("TOMA AGUA");
    }

    if (text.includes(" AIRE ")) {
      terms.add("TOMA AIRE");
    }
  }

  if (text.includes(" MANGUERA ")) {
    terms.add("MANGUERA");
    terms.add("MANGUERA MULTIFLEX");
  }

  if (text.includes(" TERMOSTATO ")) {
    terms.add("TERMOSTATO");
  }

  if (text.includes(" POLEA ") || text.includes(" POLEAS ")) {
    terms.add("POLEA");
    terms.add("POLEAS");
  }

  if (text.includes(" CALEFACCION ")) {
    terms.add("CALEFACCION");
    terms.add("KIT CALEFACCION");
    terms.add("VALVULA CALEFACCION");
  }

  if (text.includes(" VALVULA ")) {
    terms.add("VALVULA");
  }

  // Límite intencional para no volver lenta la consulta.
  return Array.from(terms).slice(0, 8);
}