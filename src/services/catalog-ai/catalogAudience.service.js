import { normalizeText } from "../../utils/normalize.js";

const FAKE_PART_TOKENS = new Set([
  "LLEVA",
  "LLEVO",
  "LLEVAR",
  "PIEZA",
  "CARRO",
  "COCHE",
  "AUTO",
  "VEHICULO",
  "VEHÍCULO",
  "BUSCO",
  "BUSCAR",
  "QUIERO",
  "NECESITO",
  "OCUPO",
  "TIENE",
  "TENGO",
  "SERA",
  "SERÁ",
  "PUEDE",
  "PARA",
]);

const MECHANIC_PATTERNS = [
  /\bOEM\b/,
  /\bNO\s+DE\s+PARTE\b/,
  /\bN[ÚU]MERO\s+DE\s+PARTE\b/,
  /\bCRUCE\b/,
  /\bCRUCES\b/,
  /\bAPLICACI[ÓO]N\b/,
  /\bCOMPATIBILIDAD\b/,
  /\bPSI\b/,
  /\bLIBRAS\b/,
  /\bBAR\b/,
  /\bMM\b/,
  /\bMIL[IÍ]METROS\b/,
  /\bCANALES\b/,
  /\bPOLEA\b/,
  /\bTERMOSTATO\b.*\b(82|87|90|92)\b/,
  /\bTEMPERATURA\s+DE\s+APERTURA\b/,
  /\bMOTOR\s+[0-9]\.[0-9]\b/,
  /\b[0-9]\.[0-9]\s*(L|LT|LTS|LITROS?)\b/,
  /\b16V\b/,
  /\b8V\b/,
  /\bSOHC\b/,
  /\bDOHC\b/,
];

const BEGINNER_PATTERNS = [
  /\bNO\s+S[EÉ]\b/,
  /\bNO\s+S[EÉ]\s+C[ÓO]MO\b/,
  /\bNO\s+TENGO\s+IDEA\b/,
  /\bNO\s+S[EÉ]\s+QU[EÉ]\s+PIEZA\b/,
  /\bNO\s+S[EÉ]\s+QU[EÉ]\s+LLEVA\b/,
  /\bMI\s+(CARRO|COCHE|AUTO|VEH[IÍ]CULO)\b/,
  /\bSE\s+CALIENTA\b/,
  /\bTIRA\s+(AGUA|L[IÍ]QUIDO|ANTICONGELANTE)\b/,
  /\bHACE\s+RUIDO\b/,
  /\bNO\s+ARRANCA\b/,
  /\bNO\s+PRENDE\b/,
  /\bQU[EÉ]\s+PUEDE\s+SER\b/,
  /\bQU[EÉ]\s+ME\s+RECOMIENDAS\b/,
  /\bALGO\s+PARA\b/,
];

const INTERMEDIATE_PATTERNS = [
  /\bBOMBA\s+DE\s+AGUA\b/,
  /\bRADIADOR\b/,
  /\bTERMOSTATO\b/,
  /\bMANGUERA\b/,
  /\bTAP[ÓO]N\b/,
  /\bDEP[ÓO]SITO\b/,
  /\bSENSOR\b/,
  /\bVENTILADOR\b/,
  /\bMOTOVENTILADOR\b/,
  /\bCHEVY\b/,
  /\bTSURU\b/,
  /\bMARCH\b/,
  /\b[12][0-9]{3}\b/,
];

function countMatches(text, patterns = []) {
  return patterns.reduce((count, pattern) => {
    return pattern.test(text) ? count + 1 : count;
  }, 0);
}

function isMeaningfulPartToken(token) {
  const value = normalizeText(token);

  if (!value || FAKE_PART_TOKENS.has(value)) return false;

  // Código real normalmente trae letras+números, guiones, diagonal o formato de parte.
  const hasLetter = /[A-Z]/.test(value);
  const hasDigit = /[0-9]/.test(value);
  const hasCodeSymbol = /[-/_.]/.test(value);

  if (hasLetter && hasDigit && value.length >= 3) return true;
  if (hasCodeSymbol && value.length >= 4) return true;

  return false;
}

function hasStrongMechanicLanguage(text) {
  return (
    /\b(OEM|CRUCE|CRUCES|APLICACI[ÓO]N|PSI|CANALES|MM|MIL[IÍ]METROS|SOHC|DOHC|16V|8V)\b/.test(text) ||
    /\bTEMPERATURA\s+DE\s+APERTURA\b/.test(text) ||
    /\bMOTOR\s+[0-9]\.[0-9]\b/.test(text) ||
    /\b[0-9]\.[0-9]\s*(L|LT|LTS|LITROS?)\b/.test(text)
  );
}

export function detectAudienceLevel({ question, intent = {} } = {}) {
  const text = normalizeText(question);

  const meaningfulPartTokens = Array.isArray(intent.numero_parte_tokens)
    ? intent.numero_parte_tokens.filter(isMeaningfulPartToken)
    : [];

  const hasMeasurements =
    Array.isArray(intent.medidas_detectadas) &&
    intent.medidas_detectadas.length > 0;

  const hasMotor = Boolean(intent.motor);
  const strongMechanicLanguage = hasStrongMechanicLanguage(text);

  const beginnerScore =
    countMatches(text, BEGINNER_PATTERNS) +
    (Array.isArray(intent.sintomas_detectados) && intent.sintomas_detectados.length ? 1 : 0);

  const intermediateScore =
    countMatches(text, INTERMEDIATE_PATTERNS) +
    (intent.marca_auto ? 1 : 0) +
    (intent.modelo_auto ? 1 : 0) +
    (intent.anio ? 1 : 0);

  const mechanicScore =
    countMatches(text, MECHANIC_PATTERNS) +
    (meaningfulPartTokens.length ? 2 : 0) +
    (hasMeasurements ? 2 : 0) +
    (hasMotor ? 1 : 0);

  // Regla fuerte: si el cliente claramente no sabe qué pieza lleva,
  // no lo clasifiques como mecánico por tokens accidentales.
  if (beginnerScore >= 3 && !strongMechanicLanguage && !hasMeasurements && !meaningfulPartTokens.length) {
    return {
      nivel_usuario: "PRINCIPIANTE",
      tono_respuesta: "SIMPLE_GUIADO",
      score: {
        mecanico: mechanicScore,
        intermedio: intermediateScore,
        principiante: beginnerScore,
      },
    };
  }

  // Mecánico solo si hay evidencia técnica real, no por palabras comunes.
  if (
    mechanicScore >= 2 &&
    (strongMechanicLanguage || hasMeasurements || meaningfulPartTokens.length)
  ) {
    return {
      nivel_usuario: "MECANICO",
      tono_respuesta: "TECNICO",
      score: {
        mecanico: mechanicScore,
        intermedio: intermediateScore,
        principiante: beginnerScore,
      },
    };
  }

  if (beginnerScore >= 2) {
    return {
      nivel_usuario: "PRINCIPIANTE",
      tono_respuesta: "SIMPLE_GUIADO",
      score: {
        mecanico: mechanicScore,
        intermedio: intermediateScore,
        principiante: beginnerScore,
      },
    };
  }

  return {
    nivel_usuario: "INTERMEDIO",
    tono_respuesta: "NORMAL_COMERCIAL",
    score: {
      mecanico: mechanicScore,
      intermedio: intermediateScore,
      principiante: beginnerScore,
    },
  };
}