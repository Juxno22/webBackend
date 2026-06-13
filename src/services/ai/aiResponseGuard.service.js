import { cleanString } from "./aiText.service.js";

function normalizeCodeCandidate(value) {
  return cleanString(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function looksLikeYear(value) {
  const clean = normalizeCodeCandidate(value);

  if (!/^\d{4}$/.test(clean)) return false;

  const year = Number(clean);

  return year >= 1900 && year <= 2049;
}

function looksLikeMotorOrMeasure(value) {
  const text = cleanString(value).toUpperCase();

  return (
    /\b\d\.\d\s*L\b/.test(text) ||
    /\b\d\.\dL\b/.test(text) ||
    /\b\d{3,4}\s*CC\b/.test(text) ||
    /\b\d+\s*MM\b/.test(text) ||
    /\b\d+\s*CM\b/.test(text) ||
    /\b\d+\s*PULG\b/.test(text) ||
    /\b\d+\s*"\b/.test(text)
  );
}

function looksLikeRealPartCode(value) {
  const raw = cleanString(value).toUpperCase();
  const clean = normalizeCodeCandidate(raw);

  if (!clean) return false;
  if (looksLikeYear(clean)) return false;
  if (looksLikeMotorOrMeasure(raw)) return false;
  if (/^[A-Z]{1,6}\d[A-Z0-9]{2,}$/.test(clean)) return true;
  if (/^\d{5,}$/.test(clean)) return true;

  return false;
}

export function responseMentionsUnknownCode(response, allowedCodes) {
  const text = cleanString(response).toUpperCase();

  if (!text || !allowedCodes.length) return false;

  const normalizedAllowed = new Set(
    allowedCodes.map((code) => normalizeCodeCandidate(code)).filter(Boolean)
  );

  const possibleCodes =
    text.match(/\b[A-Z]{1,6}\d[A-Z0-9\-./]{2,}\b|\b\d{4,}\b/g) || [];

  const suspiciousCodes = possibleCodes
    .filter((code) => looksLikeRealPartCode(code))
    .map((code) => ({
      raw: code,
      normalized: normalizeCodeCandidate(code),
    }))
    .filter((item) => !normalizedAllowed.has(item.normalized));

  if (suspiciousCodes.length) {
    console.warn(
      "OpenRouter mencionó posibles códigos fuera del contexto:",
      suspiciousCodes.map((item) => item.raw).join(", ")
    );

    return true;
  }

  return false;
}

export function responseLooksLikeProviderMetadata(response) {
  const text = cleanString(response).toUpperCase();

  if (!text) return true;

  return (
    /^USER SAFETY\s*:/i.test(response) ||
    /SAFETY CATEGORIES\s*:/i.test(response) ||
    /GUNS AND ILLEGAL WEAPONS/i.test(response) ||
    /HARMFUL REQUEST/i.test(response) ||
    /POLICY/i.test(response) ||
    text.length < 12
  );
}

export function responseHasBadChatFormatting(response) {
  const text = cleanString(response);

  return (
    /\|[-:\s|]+\|/.test(text) ||
    /^\s*\|.*\|\s*$/m.test(text) ||
    /\*\*/.test(text)
  );
}
