import { normalizeText } from "../../utils/normalize.js";

function cleanNumber(value) {
  const parsed = Number(String(value || "").replace(",", "."));

  return Number.isFinite(parsed) ? parsed : null;
}

function toMillimeters(value, unit) {
  const number = cleanNumber(value);
  const cleanUnit = normalizeText(unit);

  if (!Number.isFinite(number)) return null;

  if (["MM", "MILIMETRO", "MILIMETROS", "MILÍMETRO", "MILÍMETROS"].includes(cleanUnit)) {
    return number;
  }

  if (["CM", "CENTIMETRO", "CENTIMETROS", "CENTÍMETRO", "CENTÍMETROS"].includes(cleanUnit)) {
    return number * 10;
  }

  if (["IN", "PULG", "PULGADA", "PULGADAS", '"'].includes(cleanUnit)) {
    return number * 25.4;
  }

  return null;
}

export function isMeasurementLikePartToken(value) {
  const raw = String(value || "").trim().toUpperCase();

  if (!raw) return false;

  return (
    /^\d+(?:[.,]\d+)?\s*(MM|CM|IN|PULG|PULGADA|PULGADAS|MILIMETROS|MILÍMETROS|CENTIMETROS|CENTÍMETROS)$/i.test(raw) ||
    /^\d+(?:[.,]\d+)?"$/.test(raw)
  );
}

function detectPulleyAttribute(question) {
  const text = normalizeText(question);

  if (/\bANCHO\b/.test(text) || /\bPISTA\b/.test(text)) {
    return {
      atributo_normalizado: "ANCHO DE PISTA",
      atributo_label: "ancho de pista",
    };
  }

  return {
    atributo_normalizado: "DIAMETRO",
    atributo_label: "diámetro",
  };
}

export function detectMeasurementFilters(question) {
  const text = normalizeText(question);
  const hasPulleyIntent = /\bPOLEA\b|\bPOLEAS\b/.test(text);

  if (!hasPulleyIntent) return [];

  const filters = [];
  const pulleyAttribute = detectPulleyAttribute(question);

  const measurePattern = /\b(\d{1,3}(?:[.,]\d{1,3})?)\s*(MM|MILIMETROS|MILÍMETROS|CM|CENTIMETROS|CENTÍMETROS|IN|PULGADAS?|\")\b/g;
  let match;

  while ((match = measurePattern.exec(text)) !== null) {
    const mm = toMillimeters(match[1], match[2]);

    if (!Number.isFinite(mm)) continue;

    filters.push({
      tipo: "NUMERIC_ATTRIBUTE",
      contexto: "POLEA",
      atributo_normalizado: pulleyAttribute.atributo_normalizado,
      atributo_label: pulleyAttribute.atributo_label,
      valor_numero: Number(mm.toFixed(3)),
      unidad: "mm",
      tolerancia: 0.75,
      original: match[0],
    });
  }

  const channelPattern = /\b(\d{1,2})\s*CANALES?\b/g;

  while ((match = channelPattern.exec(text)) !== null) {
    const channels = cleanNumber(match[1]);

    if (!Number.isFinite(channels)) continue;

    filters.push({
      tipo: "NUMERIC_ATTRIBUTE",
      contexto: "POLEA",
      atributo_normalizado: "CANALES",
      atributo_label: "canales",
      valor_numero: channels,
      unidad: "canales",
      tolerancia: 0,
      original: match[0],
    });
  }

  return filters.slice(0, 4);
}

export function attributeMatchesMeasurement(attribute = {}, measurement = {}) {
  const attributeName = normalizeText(attribute.atributo_normalizado || attribute.atributo);
  const expectedName = normalizeText(measurement.atributo_normalizado);

  if (!attributeName || !expectedName || attributeName !== expectedName) return false;

  const attributeValue = Number(attribute.valor_numero);
  const expectedValue = Number(measurement.valor_numero);

  if (!Number.isFinite(attributeValue) || !Number.isFinite(expectedValue)) return false;

  const tolerance = Number.isFinite(Number(measurement.tolerancia))
    ? Number(measurement.tolerancia)
    : 0;

  return Math.abs(attributeValue - expectedValue) <= tolerance;
}

export function describeMeasurementFilters(filters = []) {
  return filters
    .map((filter) => {
      const value = Number(filter.valor_numero);
      const prettyValue = Number.isFinite(value) ? value.toString().replace(/\.0+$/, "") : filter.valor_numero;

      return `${filter.atributo_label || filter.atributo_normalizado} ${prettyValue} ${filter.unidad || ""}`.trim();
    })
    .filter(Boolean)
    .join(", ");
}
