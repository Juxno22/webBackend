import { normalizeText } from "./normalize.js";

const MOTOR_DISPLACEMENT_PATTERN = /\b\d+(?:\.\d+)?\s*L\b/i;
const CILINDRAJE_PATTERN = /\b(?:L|V|H|I|W|B)\s*\d{1,2}\b/i;

function cleanPart(value) {
  const text = String(value || "")
    .trim()
    .replace(/\s+/g, " ");

  return text || null;
}

function normalizeDisplacement(value) {
  const text = cleanPart(value);
  if (!text) return null;

  const normalized = normalizeText(text)
    .replace(",", ".")
    .replace(/\s+/g, " ")
    .trim();

  const ccMatch = normalized.match(/^([0-9]{3,4})\s*CC$/);

  if (ccMatch) {
    const cc = Number(ccMatch[1]);

    if (Number.isFinite(cc) && cc >= 600 && cc <= 9000) {
      return `${(cc / 1000).toFixed(1)}L`;
    }
  }

  const literMatch = normalized.match(
    /^([0-9]{1,2}(?:\.[0-9])?)\s*(?:L|LT|LTS|LITRO|LITROS)?$/
  );

  if (literMatch) {
    const liters = Number(literMatch[1]);

    if (Number.isFinite(liters) && liters > 0) {
      return `${liters.toFixed(1)}L`;
    }
  }

  return text.toUpperCase().replace(/\s+/g, "");
}

function normalizeCilindraje(value) {
  const text = cleanPart(value);
  if (!text) return null;

  return text.toUpperCase().replace(/\s+/g, "");
}

export function splitApplicationMotor(value) {
  const original = cleanPart(value);

  if (!original) {
    return {
      motor_original: null,
      motor: null,
      cilindraje: null,
      motor_detalle: null,
      motor_label: null,
    };
  }

  const displacementMatch = original.match(MOTOR_DISPLACEMENT_PATTERN);
  const cilindrajeMatch = original.match(CILINDRAJE_PATTERN);

  const motor = displacementMatch ? normalizeDisplacement(displacementMatch[0]) : null;
  const cilindraje = cilindrajeMatch ? normalizeCilindraje(cilindrajeMatch[0]) : null;

  let detail = original;

  if (cilindrajeMatch) {
    detail = detail.replace(cilindrajeMatch[0], " ");
  }

  if (displacementMatch) {
    detail = detail.replace(displacementMatch[0], " ");
  }

  const motor_detalle = cleanPart(detail);
  const motor_label = buildApplicationMotorLabel({
    motor,
    cilindraje,
    motor_detalle,
    motor_original: original,
  });

  return {
    motor_original: original,
    motor: motor || original,
    cilindraje,
    motor_detalle,
    motor_label,
  };
}

export function buildApplicationMotorFromPayload(payload = {}) {
  const explicitMotor = cleanPart(payload.motor);
  const explicitCilindraje = cleanPart(payload.cilindraje);
  const explicitDetalle = cleanPart(payload.motor_detalle);
  const explicitOriginal = cleanPart(payload.motor_original);

  const shouldSplitLegacyMotor =
    explicitMotor &&
    !explicitCilindraje &&
    MOTOR_DISPLACEMENT_PATTERN.test(explicitMotor);

  if (shouldSplitLegacyMotor) {
    const parsed = splitApplicationMotor(explicitMotor);

    return {
      motor: parsed.motor,
      cilindraje: parsed.cilindraje,
      motor_detalle: explicitDetalle || parsed.motor_detalle,
      motor_original: explicitOriginal || parsed.motor_original,
      motor_label: buildApplicationMotorLabel({
        motor: parsed.motor,
        cilindraje: parsed.cilindraje,
        motor_detalle: explicitDetalle || parsed.motor_detalle,
        motor_original: explicitOriginal || parsed.motor_original,
      }),
    };
  }

  return {
    motor: normalizeDisplacement(explicitMotor) || explicitMotor,
    cilindraje: normalizeCilindraje(explicitCilindraje),
    motor_detalle: explicitDetalle,
    motor_original: explicitOriginal,
    motor_label: buildApplicationMotorLabel({
      motor: normalizeDisplacement(explicitMotor) || explicitMotor,
      cilindraje: normalizeCilindraje(explicitCilindraje),
      motor_detalle: explicitDetalle,
      motor_original: explicitOriginal,
    }),
  };
}

export function buildApplicationMotorLabel({
  motor,
  cilindraje,
  motor_detalle,
  motor_original,
} = {}) {
  const parts = [cilindraje, motor, motor_detalle]
    .map(cleanPart)
    .filter(Boolean);

  if (parts.length) return parts.join(" ");

  return cleanPart(motor_original) || null;
}

function formatMotorLiters(value) {
  const number = Number(String(value || "").replace(",", "."));

  if (!Number.isFinite(number) || number <= 0) return null;

  return `${number.toFixed(1)}L`;
}

function normalizeCcToLiters(value) {
  const cc = Number(String(value || "").replace(/[^0-9]/g, ""));

  if (!Number.isFinite(cc) || cc < 600 || cc > 9000) return null;

  return formatMotorLiters(cc / 1000);
}

export function normalizeMotorSearchValue(value) {
  const raw = cleanPart(value);

  if (!raw) return "";

  const text = normalizeText(raw)
    .replace(/,/g, ".")
    .replace(/\s+/g, " ")
    .trim();

  const ccMatch = text.match(/\b([0-9]{3,4})\s*CC\b/);

  if (ccMatch) {
    return normalizeCcToLiters(ccMatch[1]) || text;
  }

  const decimalLiterMatch = text.match(
    /\b([0-9]{1,2}\.[0-9])\s*(?:L|LT|LTS|LITRO|LITROS)?\b/
  );

  if (decimalLiterMatch) {
    return formatMotorLiters(decimalLiterMatch[1]) || text;
  }

  const integerLiterMatch = text.match(
    /\b([0-9]{1,2})\s*(?:L|LT|LTS|LITRO|LITROS)\b/
  );

  if (integerLiterMatch) {
    return formatMotorLiters(integerLiterMatch[1]) || text;
  }

  const cilindrajeMatch = text.match(/\b(?:L|V|H|I|W|B)\s*\d{1,2}\b/);

  if (cilindrajeMatch) {
    return normalizeCilindraje(cilindrajeMatch[0]);
  }

  const cylindersMatch = text.match(/\b([3468])\s*CILINDROS?\b/);

  if (cylindersMatch) {
    return `L${cylindersMatch[1]}`;
  }

  const parsed = splitApplicationMotor(text);

  return parsed.motor || parsed.cilindraje || text;
}

export function buildApplicationMotorLabelSql(alias = "pa") {
  return `
    COALESCE(
      NULLIF(TRIM(CONCAT_WS(' ',
        NULLIF(TRIM(${alias}.cilindraje), ''),
        NULLIF(TRIM(${alias}.motor), ''),
        NULLIF(TRIM(${alias}.motor_detalle), '')
      )), ''),
      NULLIF(TRIM(${alias}.motor_original), ''),
      NULLIF(TRIM(${alias}.motor), '')
    )
  `;
}

export function buildApplicationMotorTextSearchSql(alias = "pa") {
  const motorLabelSql = buildApplicationMotorLabelSql(alias);

  return `
    (
      UPPER(COALESCE(${alias}.motor, '')) LIKE ?
      OR UPPER(COALESCE(${alias}.cilindraje, '')) LIKE ?
      OR UPPER(COALESCE(${alias}.motor_detalle, '')) LIKE ?
      OR UPPER(COALESCE(${alias}.motor_original, '')) LIKE ?
      OR UPPER(COALESCE(${motorLabelSql}, '')) LIKE ?
    )
  `;
}

export function buildApplicationMotorExactSql(alias = "pa") {
  const motorLabelSql = buildApplicationMotorLabelSql(alias);

  return `
    (
      UPPER(TRIM(COALESCE(${alias}.motor, ''))) = UPPER(TRIM(?))
      OR UPPER(TRIM(COALESCE(${alias}.motor_original, ''))) = UPPER(TRIM(?))
      OR UPPER(TRIM(COALESCE(${motorLabelSql}, ''))) = UPPER(TRIM(?))
    )
  `;
}