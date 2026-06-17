import { pool } from "../../config/db.js";
import {
  normalizePartNumber,
  normalizeSearchQuery,
  normalizeText,
  getSearchTokens,
} from "../../utils/normalize.js";
import {
  detectMeasurementFilters,
  isMeasurementLikePartToken,
} from "./catalogMeasurements.service.js";
import { detectCrossApplicationComparison } from "./catalogCrossApplication.service.js";

const INVALID_CODES = new Set([
  "#N/A",
  "N/A",
  "NA",
  "ND",
  "N.D.",
  "SIN CODIGO",
  "SIN CÓDIGO",
  "NULL",
  "0",
]);

const STOP_WORDS = new Set([
  "BUSCO",
  "BUSCAR",
  "QUIERO",
  "NECESITO",
  "OCUPO",
  "DAME",
  "DIME",
  "COTIZAR",
  "COTIZACION",
  "COTIZACIÓN",
  "REFACCION",
  "REFACCIÓN",
  "REFACCIONES",
  "PIEZA",
  "PIEZAS",
  "PARTE",
  "PARTES",
  "PARA",
  "DEL",
  "DE",
  "LA",
  "EL",
  "LOS",
  "LAS",
  "LO",
  "CON",
  "SIN",
  "UN",
  "UNA",
  "UNO",
  "EN",
  "A",
  "Y",
  "O",
  "QUE",
  "QUÉ",
  "CUAL",
  "CUÁL",
  "CUALES",
  "CUÁLES",
  "COMO",
  "CÓMO",
  "MI",
  "ME",
  "SE",
  "LE",
  "TE",
  "ESTA",
  "ESTÁ",
  "ESTE",
  "TENGO",
  "TIENE",
  "TRAIGO",
  "AUTO",
  "CARRO",
  "COCHE",
  "VEHICULO",
  "VEHÍCULO",
  "NO",
  "ARRANCA",
  "ARRANCAR",
  "PRENDE",
  "PRENDER",
  "ENCIENDE",
  "ENCENDER",
  "FALLA",
  "FALLANDO",
  "CALIENTA",
  "CALENTANDO",
  "REGANDO",
  "TIRANDO",
  "GOTEA",
  "FUGA",
  "LIQUIDO",
  "LÍQUIDO",
  "TIRA",
  "PARECE",
  "PARECIERA",
  "CREO",
  "CREERIA",
  "CREERÍA",
  "QUIZA",
  "QUIZÁ",
  "TALVEZ",
  "TAL",
  "VEZ",
  "COMO",
  "LIQUIDO",
  "LÍQUIDO",
  "AGUA",
  "SEA",
  "SER",
  "LLEVA",
  "LLEVO",
  "LLEVAR",
  "SERA",
  "SERÁ",
  "PUEDE",
]);

const NON_CATALOG_PATTERNS = [
  /\bCLIMA\b/,
  /\bWEATHER\b/,
  /\bPRONOSTICO\b/,
  /\bPRONÓSTICO\b/,
  /\bHORA\b/,
  /\bNOTICIAS\b/,
  /\bRECETA\b/,
  /\bHOTEL\b/,
  /\bVUELO\b/,
  /\bVIAJE\b/,
];

const DIRECT_PRODUCT_TERMS = [
  "TERMOSTATO",
  "BOMBA",
  "BOMBA DE AGUA",
  "RADIADOR",
  "MANGUERA",
  "POLEA",
  "BANDA",
  "TAPON",
  "TAPON RADIADOR",
  "TAPÓN",
  "DEPOSITO",
  "DEPÓSITO",
  "ANTICONGELANTE",
  "ANTICONGELANTE ORGANICO",
  "ANTICONGELANTE ORGÁNICO",
  "ANTICONGELANTE VERDE",
  "ANTICONGELANTE TRADICIONAL",
  "SENSOR",
  "BULBO",
  "TOMA",
  "TOMA DE AGUA",
  "BRIDA",
  "VENTILADOR",
  "MOTOVENTILADOR",
  "FILTRO",
  "JUNTA",
  "RETEN",
  "RETÉN",
];
const UNCERTAIN_PATTERNS = [
  /\bPARECE\b/,
  /\bPARECIERA\b/,
  /\bCREO QUE\b/,
  /\bCREO\b/,
  /\bNO SE\b/,
  /\bNO SÉ\b/,
  /\bCOMO QUE\b/,
  /\bES COMO\b/,
  /\bTAL VEZ\b/,
  /\bTALVEZ\b/,
  /\bQUIZA\b/,
  /\bQUIZÁ\b/,
];

const GENERIC_PRODUCT_TERMS_REQUIRE_VEHICLE = new Set([
  "BOMBA",
  "BOMBA DE AGUA",
  "BOMBAS",
  "MANGUERA",
  "TUBO",
  "TUBO AGUA",
  "TUBO DE AGUA",
  "TAPON",
  "TAPÓN",
  "DEPOSITO",
  "DEPÓSITO",
  "SENSOR",
  "BULBO",
  "TOMA",
  "TOMA AGUA",
  "TOMA DE AGUA",
  "BRIDA",
  "RADIADOR",
]);

const SYMPTOM_RULES = [
  {
    key: "COOLING_OVERHEAT",
    label: "posible problema de sistema de enfriamiento",
    patterns: [
      /\bSE CALIENTA\b/,
      /\bCALIENTA\b/,
      /\bCALENTANDO\b/,
      /\bSUBE LA TEMPERATURA\b/,
      /\bTEMPERATURA ALTA\b/,
      /\bHIERVE\b/,
    ],
    tokens: [
      "TERMOSTATO",
      "BOMBA AGUA",
      "BOMBA DE AGUA",
      "RADIADOR",
      "MANGUERA",
      "TAPON",
      "TAPON RADIADOR",
      "DEPOSITO",
      "ANTICONGELANTE",
      "BULBO",
      "SENSOR TEMPERATURA",
      "VENTILADOR",
      "MOTOVENTILADOR",
    ],
    searchable: true,
  },
  {
    key: "COOLING_LEAK",
    label: "posible fuga de anticongelante",
    patterns: [
      /\bREGANDO\b/,
      /\bTIRANDO\b/,
      /\bTIRA\b/,
      /\bFUGA\b/,
      /\bGOTEA\b/,
      /\bPIERDE ANTICONGELANTE\b/,
      /\bTIRA ANTICONGELANTE\b/,
      /\bTIRANDO ANTICONGELANTE\b/,
      /\bREGANDO ANTICONGELANTE\b/,
      /\bTIRA LIQUIDO\b/,
      /\bTIRA LÍQUIDO\b/,
      /\bTIRANDO LIQUIDO\b/,
      /\bTIRANDO LÍQUIDO\b/,
      /\bREGANDO LIQUIDO\b/,
      /\bREGANDO LÍQUIDO\b/,
      /\bTIRA AGUA\b/,
      /\bTIRANDO AGUA\b/,
    ],
    tokens: [
      "MANGUERA",
      "RADIADOR",
      "DEPOSITO",
      "DEPÓSITO",
      "TAPON",
      "TAPON RADIADOR",
      "TOMA AGUA",
      "TOMA DE AGUA",
      "BOMBA AGUA",
      "BOMBA DE AGUA",
      "ANTICONGELANTE",
      "BRIDA",
    ],
    searchable: true,
  },
  {
    key: "NO_START",
    label: "falla de arranque demasiado general",
    patterns: [
      /\bNO ARRANCA\b/,
      /\bNO PRENDE\b/,
      /\bNO ENCIENDE\b/,
      /\bBATALLA PARA PRENDER\b/,
    ],
    tokens: [],
    searchable: false,
  },
  {
    key: "FAN_NOT_WORKING",
    label: "posible falla de ventilador o motoventilador",
    patterns: [
      /\bNO\s+PRENDE\s+EL\s+VENTILADOR\b/,
      /\bNO\s+ENCIENDE\s+EL\s+VENTILADOR\b/,
      /\bVENTILADOR\s+NO\s+PRENDE\b/,
      /\bVENTILADOR\s+NO\s+ENCIENDE\b/,
      /\bNO\s+PRENDE\s+EL\s+MOTOVENTILADOR\b/,
      /\bMOTOVENTILADOR\s+NO\s+PRENDE\b/,
      /\bABANICO\s+NO\s+PRENDE\b/,
    ],
    tokens: [
      "VENTILADOR",
      "MOTOVENTILADOR",
      "BULBO",
      "SENSOR TEMPERATURA",
      "RADIADOR",
    ],
    searchable: true,
  },
];
// Extensiones controladas para entrenamiento del buscador.
[
  "PONCHA",
  "PERDIDA",
  "PÉRDIDA",
  "SUBIDA",
  "PLANO",
  "CARRETERA",
  "CLIMA",
  "AIRE",
  "AC",
  "TANQUE",
  "DIFERENCIA",
  "COMPARAR",
  "COMPARACION",
  "COMPARACIÓN",
  "MEJOR",
  "PEOR",
  "VS",
  "LLUEVE",
  "LLUVIA",
  "MOJA",
  "MOJADO",
  "CUANDO",
  "SOLO",
  "SÓLO",
  "RUIDO",
  "SUENA",
  "HACE",
  "HIRVIERA",
  "BARATA",
  "BARATO",
  "ECONOMICA",
  "ECONÓMICA",
  "ECONOMICO",
  "ECONÓMICO",
  "GENERICA",
  "GENÉRICA",
  "GENERICO",
  "GENÉRICO",
  "ORIGINAL",
  "PROXIMA",
  "PRÓXIMA",
  "SEMANA",
  "CUANDO",
  "VAN",
  "TENER",
  "NEED",
  "WATER",
  "PUMP",
  "FOR",
  "NOT",
].forEach((word) => STOP_WORDS.add(word));

[
  "PASTILLAS",
  "PASTILLAS FRENO",
  "PASTILLAS DE FRENO",
  "BALATAS",
  "FRENOS",
  "TUBO",
  "TUBO DE AGUA",
  "TUBO AGUA",
  "EMPAQUE",
  "EMPAQUE CABEZA",
  "EMPAQUE DE CABEZA",
  "JUNTA CABEZA",
  "JUNTA DE CABEZA",
  "JUNTA CULATA",
  "JUNTA DE CULATA",
  "WATER PUMP",
  "POLEA TENSORA",
  "POLEA LOCA",
  "POLEA ARMONICA",
  "POLEA ARMÓNICA",
  "POLEA AMORTIGUADORA",
  "POLEA CIGUEÑAL",
  "POLEA CIGÜEÑAL",
  "POLEA ALTERNADOR",
  "POLEA DIRECCION",
  "POLEA DIRECCIÓN",
  "POLEA COMPRESOR",
  "POLEA A/C",
  "POLEA AC",
  "PULLEY",
].forEach((term) => {
  if (!DIRECT_PRODUCT_TERMS.includes(term)) {
    DIRECT_PRODUCT_TERMS.push(term);
  }
});

[
  "PASTILLAS",
  "PASTILLAS FRENO",
  "PASTILLAS DE FRENO",
  "BALATAS",
  "FRENOS",
  "TUBO",
  "TUBO DE AGUA",
  "TUBO AGUA",
  "EMPAQUE",
  "EMPAQUE CABEZA",
  "EMPAQUE DE CABEZA",
  "JUNTA CABEZA",
  "JUNTA DE CABEZA",
  "JUNTA CULATA",
  "JUNTA DE CULATA",
  "WATER PUMP",
].forEach((term) => GENERIC_PRODUCT_TERMS_REQUIRE_VEHICLE.add(term));

const QUERY_EXPANSION_RULES = [
  {
    key: "TAPON_TANQUE_AGUA_RADIADOR",
    patterns: [
      /\bTAPON\b.*\bTANQUE\b.*\bAGUA\b/,
      /\bTAPON\b.*\bDEPOSITO\b.*\bAGUA\b/,
      /\bTAPON\b.*\bDEPOSITO\b.*\bANTICONGELANTE\b/,
      /\bTAPON\b.*\bRADIADOR\b/,
      /\bTAPÓN\b.*\bTANQUE\b.*\bAGUA\b/,
      /\bTAPÓN\b.*\bDEPOSITO\b.*\bAGUA\b/,
      /\bTAPÓN\b.*\bRADIADOR\b/,
    ],
    tokens: [
      "TAPON",
      "TAPÓN",
      "TAPON RADIADOR",
      "TAPON DEPOSITO",
      "DEPOSITO",
      "RADIADOR",
      "ANTICONGELANTE",
    ],
  },
  {
    key: "FRENOS",
    patterns: [
      /\bPASTILLAS\b.*\bFRENO\b/,
      /\bPASTILLAS\b.*\bFRENOS\b/,
      /\bBALATAS\b/,
    ],
    tokens: [
      "PASTILLAS",
      "PASTILLAS FRENO",
      "PASTILLAS DE FRENO",
      "BALATAS",
      "FRENOS",
    ],
  },
  {
    key: "CLIMA_CALENTAMIENTO",
    patterns: [
      /\bUSO\b.*\bCLIMA\b/,
      /\bPRENDO\b.*\bCLIMA\b/,
      /\bAIRE\b.*\bACONDICIONADO\b/,
      /\bCON\b.*\bCLIMA\b/,
    ],
    tokens: ["VENTILADOR", "MOTOVENTILADOR", "RADIADOR", "SENSOR TEMPERATURA"],
  },
  {
    key: "EMPAQUE_CABEZA",
    patterns: [
      /\bEMPAQUE\b.*\bCABEZA\b/,
      /\bJUNTA\b.*\bCABEZA\b/,
      /\bJUNTA\b.*\bCULATA\b/,
      /\bEMPAQUE\b.*\bCULATA\b/,
    ],
    tokens: [
      "EMPAQUE CABEZA",
      "EMPAQUE DE CABEZA",
      "JUNTA CABEZA",
      "JUNTA DE CABEZA",
      "JUNTA CULATA",
      "JUNTA DE CULATA",
    ],
  },
  {
    key: "WATER_PUMP_ENGLISH",
    patterns: [/\bWATER\b.*\bPUMP\b/],
    tokens: ["BOMBA", "BOMBA AGUA", "BOMBA DE AGUA"],
  },
  {
    key: "LLUVIA_POSIBLE_ELECTRICO",
    patterns: [/\bLLUEVE\b/, /\bLLUVIA\b/, /\bMOJA\b/, /\bMOJADO\b/],
    tokens: ["SENSOR", "BULBO", "SENSOR TEMPERATURA"],
  },
  {
    key: "ANTICONGELANTE_VARIANTES",
    patterns: [
      /\bANTICONGELANTE\b.*\bORGANICO\b/,
      /\bANTICONGELANTE\b.*\bORGÁNICO\b/,
      /\bANTICONGELANTE\b.*\bTRADICIONAL\b/,
      /\bANTICONGELANTE\b.*\bVERDE\b/,
      /\bORGANICO\b.*\bANTICONGELANTE\b/,
      /\bORGÁNICO\b.*\bANTICONGELANTE\b/,
    ],
    tokens: [
      "ANTICONGELANTE",
      "ANTICONGELANTE ORGANICO",
      "ANTICONGELANTE ORGÁNICO",
      "ANTICONGELANTE VERDE",
      "ANTICONGELANTE TRADICIONAL",
    ],
  },
  {
    key: "RUIDO_HIRVIERA_AGUA",
    patterns: [
      /\bRUIDO\b.*\bHIRVIERA\b/,
      /\bCOMO\b.*\bHIRVIERA\b.*\bAGUA\b/,
      /\bSUENA\b.*\bHIRVIERA\b/,
    ],
    tokens: [
      "TAPON",
      "TAPON RADIADOR",
      "DEPOSITO",
      "RADIADOR",
      "BOMBA DE AGUA",
    ],
  },
];

const COMPARISON_PATTERNS = [
  /\bDIFERENCIA\b/,
  /\bCOMPARAR\b/,
  /\bCOMPARACION\b/,
  /\bCOMPARACIÓN\b/,
  /\bMEJOR\b/,
  /\bPEOR\b/,
  /\bVS\b/,
];

const STOCK_BRANCH_PATTERNS = [
  /\bSUCURSAL\b/,
  /\bTIENDA\b/,
  /\bALMACEN\b/,
  /\bGUADALAJARA\b/,
  /\bCDMX\b/,
  /\bMONTERREY\b/,
  /\bPUEBLA\b/,
];

const STOCK_INTENT_PATTERNS = [
  /\bSTOCK\b/,
  /\bDISPONIBLE\b/,
  /\bDISPONIBILIDAD\b/,
  /\bHAY\b/,
  /\bTIENES\b/,
  /\bTIENEN\b/,
];

const VEHICLE_ONLY_PATTERNS = [
  /\bREFACCION\b/,
  /\bREFACCIÓN\b/,
  /\bPIEZA\b/,
  /\bPARTE\b/,
  /\bALGO\b/,
];

const NEGATION_PATTERNS = [
  /\bQUE\s+NO\s+SEA\s+PARA\s+([A-Z0-9ÁÉÍÓÚÑ]+)/g,
  /\bQUE\s+NO\s+SEA\s+([A-Z0-9ÁÉÍÓÚÑ]+)/g,
  /\bNO\s+SEA\s+PARA\s+([A-Z0-9ÁÉÍÓÚÑ]+)/g,
  /\bNO\s+SEA\s+([A-Z0-9ÁÉÍÓÚÑ]+)/g,
  /\bNO\s+PARA\s+([A-Z0-9ÁÉÍÓÚÑ]+)/g,
  /\bEXCEPTO\s+([A-Z0-9ÁÉÍÓÚÑ]+)/g,
  /\bSIN\s+([A-Z0-9ÁÉÍÓÚÑ]+)/g,
  /\bNOT\s+FOR\s+([A-Z0-9ÁÉÍÓÚÑ]+)/g,
  /\bNOT\s+([A-Z0-9ÁÉÍÓÚÑ]+)/g,
  /\bNO\s+LA\s+ORIGINAL\b/g,
  /\bNO\s+ORIGINAL\b/g,
];

const PART_NUMBER_CONTEXT_PATTERNS = [
  /\bCODIGO\s+([A-Z0-9.\-\/]{2,})\b/g,
  /\bCÓDIGO\s+([A-Z0-9.\-\/]{2,})\b/g,
  /\bCLAVE\s+([A-Z0-9.\-\/]{2,})\b/g,
  /\bNUMERO\s+DE\s+PARTE\s+([A-Z0-9.\-\/]{2,})\b/g,
  /\bNÚMERO\s+DE\s+PARTE\s+([A-Z0-9.\-\/]{2,})\b/g,
  /\bNO\s+DE\s+PARTE\s+([A-Z0-9.\-\/]{2,})\b/g,
  /\bPIEZA\s+([A-Z0-9.\-\/]{2,})\b/g,
  /\bREFACCION\s+([A-Z0-9.\-\/]{2,})\b/g,
  /\bREFACCIÓN\s+([A-Z0-9.\-\/]{2,})\b/g,
];

const MIN_FUZZY_TOKEN_LENGTH = 4;

function cleanString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

const BLOCKED_PART_NUMBER_WORDS = new Set([
  "LLEVA",
  "LLEVO",
  "LLEVAR",
  "PIEZA",
  "PIEZAS",
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

function isBlockedPartNumberWord(value) {
  const token = normalizeText(value);

  return (
    !token ||
    STOP_WORDS.has(token) ||
    INVALID_CODES.has(token) ||
    BLOCKED_PART_NUMBER_WORDS.has(token)
  );
}

function isValidPublicCode(value) {
  const clean = normalizeText(value);
  return clean !== "" && !INVALID_CODES.has(clean);
}

function normalizeVehicleLookupText(value) {
  return ` ${normalizeSearchQuery(value)
    .replace(/[¿?¡!.,;:()[\]{}"']/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

function cleanVehicleLookupToken(value) {
  return normalizeText(
    String(value || "")
      .replace(/[¿?¡!.,;:()[\]{}"']/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractYear(question) {
  const matches =
    String(question).match(/\b(19[0-9]{2}|20[0-4][0-9])\b/g) || [];

  if (!matches.length) return null;

  const year = Number(matches[matches.length - 1]);
  return Number.isFinite(year) ? year : null;
}

function extractYearCandidates(question) {
  const matches =
    String(question).match(/\b(19[0-9]{2}|20[0-4][0-9])\b/g) || [];

  return unique(
    matches
      .map((item) => Number(item))
      .filter((year) => Number.isFinite(year) && year >= 1900 && year <= 2049)
  );
}

function hasApproximateYearLanguage(question) {
  const text = normalizeText(question);
  const years = extractYearCandidates(question);

  return (
    years.length > 1 ||
    /\bCOMO\s+DEL\b/.test(text) ||
    /\bCOMO\s+DE\b/.test(text) ||
    /\bAPROX\b/.test(text) ||
    /\bAPROXIMADO\b/.test(text) ||
    /\bNO\s+SE\s+EL\s+AÑO\b/.test(text) ||
    /\bNO\s+SÉ\s+EL\s+AÑO\b/.test(text) ||
    /\bNO\s+SE\s+EL\s+ANIO\b/.test(text)
  );
}

function extractMotor(question) {
  const text = normalizeText(question);

  const decimalMatch = text.match(
    /\b([0-9]{1}\.[0-9])\s*(L|LT|LTS|LITROS?)?\b/,
  );

  if (decimalMatch) {
    if (hasAmbiguousMotor(question)) return null;
    return decimalMatch[1];
  }

  const ccMatch =
    text.match(/\b([0-9]{3,4})\s*CC\b/) || text.match(/\b([0-9]{3,4})CC\b/);

  if (ccMatch) return `${ccMatch[1]} CC`;

  return null;
}

function extractContextualPartNumbers(question) {
  const text = normalizeText(question);
  const codes = [];

  for (const pattern of PART_NUMBER_CONTEXT_PATTERNS) {
    let match;

    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) {
        const rawValue = match[1];
        const code = normalizePartNumber(rawValue);

        if (
          code &&
          code.length >= 2 &&
          !INVALID_CODES.has(code) &&
          !isBlockedPartNumberWord(code) &&
          !isMeasurementLikePartToken(rawValue)
        ) {
          codes.push(code);
        }
      }
    }
  }

  return unique(codes).slice(0, 8);
}

function looksLikePartNumber(rawToken) {
  const raw = String(rawToken || "").trim();
  const token = normalizePartNumber(raw);

  if (!token) return false;

  if (isBlockedPartNumberWord(token)) return false;

  // Evita años cuando vienen solos. Si el usuario escribió "código 2000",
  // eso se captura aparte en extractContextualPartNumbers().
  if (/^19[0-9]{2}$|^20[0-4][0-9]$/.test(token)) return false;

  // Medidas como 70MM, 76 mm o 3 pulgadas no son códigos.
  // En poleas se manejan como atributos numéricos.
  if (isMeasurementLikePartToken(raw)) return false;

  if (STOP_WORDS.has(token)) return false;

  // Códigos numéricos tipo 13346, 202160.
  if (/^\d{4,}$/.test(token)) return true;

  // Códigos alfanuméricos cortos tipo A12, B45, T88.
  if (/[A-Z]/.test(token) && /\d/.test(token) && token.length >= 3) {
    return true;
  }

  // Códigos con separadores: ABC-123, 12.025, KG/8854.
  if (/[-./]/.test(raw) && /\d/.test(raw) && token.length >= 3) {
    return true;
  }

  return false;
}

function isMotorLikePartCode(question, code) {
  const text = normalizeText(question);
  const cleanCode = normalizePartNumber(code);

  if (!cleanCode) return false;

  return (
    /^([1-9][0-9]?)L$/.test(cleanCode) &&
    (
      /\bMOTOR\b/.test(text) ||
      /\b[1-9]\s+[0-9]\s*L\b/.test(text) ||
      /\b[1-9]\.[0-9]\s*L?\b/.test(text)
    )
  );
}

function isVehicleModelLikePartCode(question, code) {
  const text = normalizeText(question);
  const cleanCode = normalizePartNumber(code);

  if (!cleanCode) return false;

  if (
    cleanCode === "B15" &&
    (
      /\bSENTRA\s+B15\b/.test(text) ||
      /\bB15\s+SENTRA\b/.test(text) ||
      /\bNISSAN\s+SENTRA\s+B15\b/.test(text) ||
      /\bRADIADOR\s+SENTRA\s+B15\b/.test(text)
    )
  ) {
    return true;
  }

  return false;
}

function isLoosePartTokenBlockedByContext(question, code) {
  const text = normalizeText(question);
  const cleanCode = normalizePartNumber(code);

  if (!cleanCode) return false;

  if (
    /^\d{3,5}[A-Z0-9]*$/.test(cleanCode) &&
    new RegExp(`\\b(RODAMIENTO|BALERO|BEARING)\\s+(DE\\s+)?${cleanCode}\\b`).test(text)
  ) {
    return true;
  }

  if (
    /^[A-Z]?\d[A-Z0-9]{1,4}$/.test(cleanCode) &&
    new RegExp(`\\b(MOTOR|ENGINE)\\s+([A-Z0-9]+\\s+)?${cleanCode}\\b`).test(text)
  ) {
    return true;
  }

  if (
    /^(6BT|N47)$/i.test(cleanCode) &&
    new RegExp(`\\b(CUMMINS|BMW)\\s+${cleanCode}\\b`).test(text)
  ) {
    return true;
  }

  return false;
}

function extractPartNumbers(question) {
  const contextualCodes = extractContextualPartNumbers(question);

  const rawTokens =
    String(question).match(/[A-Za-z0-9][A-Za-z0-9.\-\/]{2,}/g) || [];

  const looseCodes = rawTokens
    .filter((token) => looksLikePartNumber(token))
    .map((token) => normalizePartNumber(token))
    .filter((code) => !isLoosePartTokenBlockedByContext(question, code))
    .filter((code) => !isMotorLikePartCode(question, code))
    .filter((code) => !isVehicleModelLikePartCode(question, code));

  return unique([...contextualCodes, ...looseCodes]).slice(0, 8);
}

function extractPlainTokens(question) {
  const baseTokens = getSearchTokens(question)
    .flatMap((token) => normalizeSearchQuery(token).split(" "))
    .map((token) => normalizeText(token.trim()))
    .filter(Boolean)
    .filter((token) => token.length >= 2)
    .filter((token) => !STOP_WORDS.has(token));

  return unique(baseTokens).slice(0, 12);
}

async function getMatchingSynonyms(normalizedQuestion, excludedTokens = []) {
  const [rows] = await pool.query(
    `
    SELECT tipo, texto_usuario, texto_normalizado
    FROM sinonimos_busqueda
    WHERE activo = 1
    ORDER BY tipo, texto_usuario
    `,
  );

  return rows
    .filter((row) => {
      if (
        isExcludedValue(row.texto_usuario, excludedTokens) ||
        isExcludedValue(row.texto_normalizado, excludedTokens)
      ) {
        return false;
      }

      const userText = normalizeSearchQuery(row.texto_usuario);
      const normalizedText = normalizeSearchQuery(row.texto_normalizado);

      return (
        (userText && normalizedQuestion.includes(userText)) ||
        (normalizedText && normalizedQuestion.includes(normalizedText))
      );
    })
    .slice(0, 20);
}

function levenshteinDistance(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);

  if (!left || !right) return 999;
  if (Math.abs(left.length - right.length) > 2) return 999;

  const matrix = Array.from({ length: right.length + 1 }, () =>
    Array(left.length + 1).fill(0),
  );

  for (let i = 0; i <= left.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= right.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= right.length; j++) {
    for (let i = 1; i <= left.length; i++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;

      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + cost,
      );
    }
  }

  return matrix[right.length][left.length];
}

function safeFuzzyFind(token, candidates, maxDistance = 1) {
  const cleanToken = normalizeText(token);

  if (!cleanToken) return null;
  if (cleanToken.length < MIN_FUZZY_TOKEN_LENGTH) return null;
  if (STOP_WORDS.has(cleanToken)) return null;
  if (/^\d+$/.test(cleanToken)) return null;

  for (const candidate of candidates) {
    const cleanCandidate = normalizeText(candidate);

    if (!cleanCandidate) continue;

    // Coincidencia exacta por token.
    if (cleanToken === cleanCandidate) return candidate;

    // Permite "nisan" -> "NISSAN", pero evita matches demasiado abiertos.
    if (levenshteinDistance(cleanToken, cleanCandidate) <= maxDistance) {
      return candidate;
    }
  }

  return null;
}

function getExpansionTokens(question) {
  const text = normalizeText(question);
  const expansions = [];

  for (const rule of QUERY_EXPANSION_RULES) {
    const matched = rule.patterns.some((pattern) => pattern.test(text));

    if (matched) {
      expansions.push(...rule.tokens);
    }
  }

  return unique(expansions);
}

function extractProductBrandExclusions(question) {
  const text = normalizeText(question);
  const excluded = [];

  const patterns = [
    /\bQUE\s+NO\s+SEA\s+DE\s+MARCA\s+([A-Z0-9ÁÉÍÓÚÑ]+)/g,
    /\bNO\s+SEA\s+DE\s+MARCA\s+([A-Z0-9ÁÉÍÓÚÑ]+)/g,
    /\bNO\s+MARCA\s+([A-Z0-9ÁÉÍÓÚÑ]+)/g,
    /\bPREFIERO\s+(?:UNA\s+)?ALTERNATIVA\b/g,
    /\bALTERNATIVA\b/g,
    /\bNO\s+ORIGINAL\b/g,
    /\bGENERICO\b/g,
    /\bGENÉRICO\b/g,
  ];

  for (const pattern of patterns) {
    let match;

    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) {
        const value = normalizeText(match[1]);

        if (value && value.length >= 3 && !STOP_WORDS.has(value)) {
          excluded.push(value);
        }
      }
    }
  }

  if (
    /\bPREFIERO\s+(?:UNA\s+)?ALTERNATIVA\b/.test(text) ||
    /\bALTERNATIVA\b/.test(text) ||
    /\bNO\s+ORIGINAL\b/.test(text) ||
    /\bGENERICO\b/.test(text) ||
    /\bGENÉRICO\b/.test(text)
  ) {
    excluded.push("ORIGINAL");
  }

  return unique(excluded).slice(0, 6);
}

function isExcludedValue(value, excludedTokens = []) {
  const cleanValue = normalizeText(value);

  if (!cleanValue) return false;

  return excludedTokens.some((excluded) => {
    const cleanExcluded = normalizeText(excluded);

    return (
      cleanValue === cleanExcluded ||
      cleanValue.includes(cleanExcluded) ||
      cleanExcluded.includes(cleanValue)
    );
  });
}

export function hasComparisonIntent(question) {
  const text = normalizeText(question);

  return COMPARISON_PATTERNS.some((pattern) => pattern.test(text));
}

export function asksForBranchStock(question) {
  const text = normalizeText(question);

  const hasBranch = STOCK_BRANCH_PATTERNS.some((pattern) => pattern.test(text));
  const hasStockIntent = STOCK_INTENT_PATTERNS.some((pattern) =>
    pattern.test(text),
  );

  return hasBranch && hasStockIntent;
}

function hasVehicleOnlyIntent(question, intent) {
  const text = normalizeText(question);

  const hasVehicle =
    Boolean(intent.marca_auto) ||
    Boolean(intent.modelo_auto) ||
    Boolean(intent.anio) ||
    Boolean(intent.motor);

  const hasCode = intent.numero_parte_tokens.length > 0;
  const hasProductTerm = intent.terminos_producto_detectados.length > 0;
  const hasSearchableSymptom = intent.sintomas_detectados.some(
    (item) => item.searchable,
  );

  if (!hasVehicle || hasCode || hasProductTerm || hasSearchableSymptom) {
    return false;
  }

  return (
    VEHICLE_ONLY_PATTERNS.some((pattern) => pattern.test(text)) || hasVehicle
  );
}

const MODEL_BRAND_HINTS = new Map([
  ["CHEVY", "CHEVROLET"],
  ["CORSA", "CHEVROLET"],
  ["AVEO", "CHEVROLET"],
  ["SPARK", "CHEVROLET"],
  ["TRAX", "CHEVROLET"],
  ["CRUZE", "CHEVROLET"],
  ["ONIX", "CHEVROLET"],
  ["BEAT", "CHEVROLET"],
  ["CAPTIVA", "CHEVROLET"],
  ["EQUINOX", "CHEVROLET"],
  ["S10", "CHEVROLET"],
  ["MONTANA", "CHEVROLET"],
  ["BLAZER", "CHEVROLET"],
  ["SILVERADO", "CHEVROLET"],
  ["CAMARO", "CHEVROLET"],
  ["MALIBU", "CHEVROLET"],
  ["ASTRA", "CHEVROLET"],
  ["VECTRA", "CHEVROLET"],
  ["ZAFIRA", "CHEVROLET"],
  ["MERIVA", "CHEVROLET"],
  ["PRISMA", "CHEVROLET"],
  ["COBALT", "CHEVROLET"],
  ["TSURU", "NISSAN"],
  ["MARCH", "NISSAN"],
  ["VERSA", "NISSAN"],
  ["SENTRA", "NISSAN"],
  ["B15", "NISSAN"],
  ["ALTIMA", "NISSAN"],
  ["KICKS", "NISSAN"],
  ["FRONTIER", "NISSAN"],
  ["NP300", "NISSAN"],
  ["XTRAIL", "NISSAN"],
  ["PATHFINDER", "NISSAN"],
  ["MURANO", "NISSAN"],
  ["ROGUE", "NISSAN"],
  ["ARMADA", "NISSAN"],
  ["PLATINA", "NISSAN"],
  ["JETTA", "VOLKSWAGEN"],
  ["POINTER", "VOLKSWAGEN"],
  ["AMAROK", "VOLKSWAGEN"],
  ["GOL", "VOLKSWAGEN"],
  ["POLO", "VOLKSWAGEN"],
  ["VENTO", "VOLKSWAGEN"],
  ["VIRTUS", "VOLKSWAGEN"],
  ["TIGUAN", "VOLKSWAGEN"],
  ["T-CROSS", "VOLKSWAGEN"],
  ["TAOS", "VOLKSWAGEN"],
  ["SAVEIRO", "VOLKSWAGEN"],
  ["BEETLE", "VOLKSWAGEN"],
  ["PASSAT", "VOLKSWAGEN"],
  ["SEDAN", "VOLKSWAGEN"],
  ["COROLLA", "TOYOTA"],
  ["YARIS", "TOYOTA"],
  ["CAMRY", "TOYOTA"],
  ["HILUX", "TOYOTA"],
  ["RAV4", "TOYOTA"],
  ["SIENNA", "TOYOTA"],
  ["TACOMA", "TOYOTA"],
  ["HIGHLANDER", "TOYOTA"],
  ["4RUNNER", "TOYOTA"],
  ["LANDCRUISER", "TOYOTA"],
  ["CIVIC", "HONDA"],
  ["ACCORD", "HONDA"],
  ["CRV", "HONDA"],
  ["HRV", "HONDA"],
  ["FIT", "HONDA"],
  ["PILOT", "HONDA"],
  ["ODYSSEY", "HONDA"],
  ["PASSPORT", "HONDA"],
  ["FOCUS", "FORD"],
  ["RANGER", "FORD"],
  ["FIESTA", "FORD"],
  ["MUSTANG", "FORD"],
  ["BRONCO", "FORD"],
  ["EXPLORER", "FORD"],
  ["MAVERICK", "FORD"],
  ["TRANSIT", "FORD"],
  ["ESCAPE", "FORD"],
  ["EDGE", "FORD"],
  ["ECOSPORT", "FORD"],
  ["PALIO", "FIAT"],
  ["UNO", "FIAT"],
  ["ARGO", "FIAT"],
  ["CRONOS", "FIAT"],
  ["STRADA", "FIAT"],
  ["TORO", "FIAT"],
  ["PULSE", "FIAT"],
  ["MOBI", "FIAT"],
  ["SIENA", "FIAT"],
  ["DOBLO", "FIAT"],
  ["LOGAN", "RENAULT"],
  ["SANDERO", "RENAULT"],
  ["DUSTER", "RENAULT"],
  ["CAPTUR", "RENAULT"],
  ["KWID", "RENAULT"],
  ["KOLEOS", "RENAULT"],
  ["MEGANE", "RENAULT"],
  ["SCENIC", "RENAULT"],
  ["CLIO", "RENAULT"],
  ["208", "PEUGEOT"],
  ["2008", "PEUGEOT"],
  ["301", "PEUGEOT"],
  ["3008", "PEUGEOT"],
  ["PARTNER", "PEUGEOT"],
  ["308", "PEUGEOT"],
  ["508", "PEUGEOT"],
  ["ACCENT", "HYUNDAI"],
  ["ELANTRA", "HYUNDAI"],
  ["TUCSON", "HYUNDAI"],
  ["CRETA", "HYUNDAI"],
  ["SANTAFE", "HYUNDAI"],
  ["KONA", "HYUNDAI"],
  ["PALISADE", "HYUNDAI"],
  ["GRANDU", "HYUNDAI"],
  ["ATOS", "HYUNDAI"],
  ["RIO", "KIA"],
  ["SPORTAGE", "KIA"],
  ["SOUL", "KIA"],
  ["SELTOS", "KIA"],
  ["CERATO", "KIA"],
  ["TELLURIDE", "KIA"],
  ["STINGER", "KIA"],
  ["MORNING", "KIA"],
  ["MAZDA3", "MAZDA"],
  ["MAZDA6", "MAZDA"],
  ["CX3", "MAZDA"],
  ["CX5", "MAZDA"],
  ["CX9", "MAZDA"],
  ["MX5", "MAZDA"],
  ["SWIFT", "SUZUKI"],
  ["VITARA", "SUZUKI"],
  ["GRANDVITARA", "SUZUKI"],
  ["SX4", "SUZUKI"],
  ["JIMNY", "SUZUKI"],
  ["LANCER", "MITSUBISHI"],
  ["OUTLANDER", "MITSUBISHI"],
  ["L200", "MITSUBISHI"],
  ["ECLIPSE", "MITSUBISHI"],
  ["ASX", "MITSUBISHI"],
  ["PAJERO", "MITSUBISHI"],
  ["COMPASS", "JEEP"],
  ["RENEGADE", "JEEP"],
  ["WRANGLER", "JEEP"],
  ["GRANDCHEROKEE", "JEEP"],
  ["RAM", "RAM"],
  ["DURANGO", "DODGE"],
  ["ATTITUDE", "DODGE"],
  ["CHALLENGER", "DODGE"],
  ["CHARGER", "DODGE"],
  ["IMPREZA", "SUBARU"],
  ["FORESTER", "SUBARU"],
  ["OUTBACK", "SUBARU"],
  ["CROSSTREK", "SUBARU"],
  ["LEGACY", "SUBARU"],
  ["XC60", "VOLVO"],
  ["XC90", "VOLVO"],
  ["S60", "VOLVO"],
  ["V60", "VOLVO"],
  ["XC40", "VOLVO"],
  ["MINI-COOPER", "MINI"],
  ["MINI-COUNTRYMAN", "MINI"],
  ["MINI-CLUBMAN", "MINI"],
  ["SMART-FORTWO", "SMART"],
  ["SMART-FORFOUR", "SMART"],
  ["MG-ZS", "MG"],
  ["MG-HS", "MG"],
  ["MG-5", "MG"],
  ["CHANGAN-CS35", "CHANGAN"],
  ["CHANGAN-CS55", "CHANGAN"],
  ["CHANGAN-CS75", "CHANGAN"],
  ["GEELY-EMGRAND", "GEELY"],
  ["GEELY-COOLRAY", "GEELY"],
  ["GEELY-AZCARRA", "GEELY"],
  ["BYD-F3", "BYD"],
  ["BYD-SONG", "BYD"],
  ["BYD-TANG", "BYD"],
  ["JAC-S2", "JAC"],
  ["JAC-S3", "JAC"],
  ["JAC-S4", "JAC"],
  ["DFM-AX7", "DFM"],
  ["DFM-S30", "DFM"],
  ["GAC-GS3", "GAC"],
  ["GAC-GS4", "GAC"],
  ["KARRY-K50", "KARRY"],
  ["KARRY-K60", "KARRY"],
  ["CHERY-TIGGO", "CHERY"],
  ["CHERY-ARRIZO", "CHERY"],
  ["BAIC-X25", "BAIC"],
  ["BAIC-X35", "BAIC"],
]);

const VEHICLE_MODEL_HINTS = new Map([
  ["CHEVY", { marca: "CHEVROLET", modelo: "CHEVY" }],
  ["CORSA", { marca: "CHEVROLET", modelo: "CORSA" }],
  ["AVEO", { marca: "CHEVROLET", modelo: "AVEO" }],
  ["SPARK", { marca: "CHEVROLET", modelo: "SPARK" }],
  ["TRAX", { marca: "CHEVROLET", modelo: "TRAX" }],
  ["CRUZE", { marca: "CHEVROLET", modelo: "CRUZE" }],
  ["ONIX", { marca: "CHEVROLET", modelo: "ONIX" }],
  ["BEAT", { marca: "CHEVROLET", modelo: "BEAT" }],
  ["CAPTIVA", { marca: "CHEVROLET", modelo: "CAPTIVA" }],
  ["EQUINOX", { marca: "CHEVROLET", modelo: "EQUINOX" }],
  ["S10", { marca: "CHEVROLET", modelo: "S10" }],
  ["MONTANA", { marca: "CHEVROLET", modelo: "MONTANA" }],
  ["BLAZER", { marca: "CHEVROLET", modelo: "BLAZER" }],
  ["SILVERADO", { marca: "CHEVROLET", modelo: "SILVERADO" }],
  ["CAMARO", { marca: "CHEVROLET", modelo: "CAMARO" }],
  ["MALIBU", { marca: "CHEVROLET", modelo: "MALIBU" }],
  ["ASTRA", { marca: "CHEVROLET", modelo: "ASTRA" }],
  ["VECTRA", { marca: "CHEVROLET", modelo: "VECTRA" }],
  ["ZAFIRA", { marca: "CHEVROLET", modelo: "ZAFIRA" }],
  ["MERIVA", { marca: "CHEVROLET", modelo: "MERIVA" }],
  ["PRISMA", { marca: "CHEVROLET", modelo: "PRISMA" }],
  ["COBALT", { marca: "CHEVROLET", modelo: "COBALT" }],
  ["TSURU", { marca: "NISSAN", modelo: "TSURU" }],
  ["MARCH", { marca: "NISSAN", modelo: "MARCH" }],
  ["VERSA", { marca: "NISSAN", modelo: "VERSA" }],
  ["SENTRA", { marca: "NISSAN", modelo: "SENTRA" }],
  ["B15", { marca: "NISSAN", modelo: "SENTRA B15" }],
  ["ALTIMA", { marca: "NISSAN", modelo: "ALTIMA" }],
  ["KICKS", { marca: "NISSAN", modelo: "KICKS" }],
  ["FRONTIER", { marca: "NISSAN", modelo: "FRONTIER" }],
  ["NP300", { marca: "NISSAN", modelo: "NP300" }],
  ["XTRAIL", { marca: "NISSAN", modelo: "X-TRAIL" }],
  ["PATHFINDER", { marca: "NISSAN", modelo: "PATHFINDER" }],
  ["MURANO", { marca: "NISSAN", modelo: "MURANO" }],
  ["ROGUE", { marca: "NISSAN", modelo: "ROGUE" }],
  ["ARMADA", { marca: "NISSAN", modelo: "ARMADA" }],
  ["PLATINA", { marca: "NISSAN", modelo: "PLATINA" }],
  ["JETTA", { marca: "VOLKSWAGEN", modelo: "JETTA" }],
  ["POINTER", { marca: "VOLKSWAGEN", modelo: "POINTER" }],
  ["AMAROK", { marca: "VOLKSWAGEN", modelo: "AMAROK" }],
  ["GOL", { marca: "VOLKSWAGEN", modelo: "GOL" }],
  ["POLO", { marca: "VOLKSWAGEN", modelo: "POLO" }],
  ["VENTO", { marca: "VOLKSWAGEN", modelo: "VENTO" }],
  ["VIRTUS", { marca: "VOLKSWAGEN", modelo: "VIRTUS" }],
  ["TIGUAN", { marca: "VOLKSWAGEN", modelo: "TIGUAN" }],
  ["T-CROSS", { marca: "VOLKSWAGEN", modelo: "T-CROSS" }],
  ["TAOS", { marca: "VOLKSWAGEN", modelo: "TAOS" }],
  ["SAVEIRO", { marca: "VOLKSWAGEN", modelo: "SAVEIRO" }],
  ["BEETLE", { marca: "VOLKSWAGEN", modelo: "BEETLE" }],
  ["PASSAT", { marca: "VOLKSWAGEN", modelo: "PASSAT" }],
  ["SEDAN", { marca: "VOLKSWAGEN", modelo: "SEDAN" }],
  ["COROLLA", { marca: "TOYOTA", modelo: "COROLLA" }],
  ["YARIS", { marca: "TOYOTA", modelo: "YARIS" }],
  ["CAMRY", { marca: "TOYOTA", modelo: "CAMRY" }],
  ["HILUX", { marca: "TOYOTA", modelo: "HILUX" }],
  ["RAV4", { marca: "TOYOTA", modelo: "RAV4" }],
  ["SIENNA", { marca: "TOYOTA", modelo: "SIENNA" }],
  ["TACOMA", { marca: "TOYOTA", modelo: "TACOMA" }],
  ["HIGHLANDER", { marca: "TOYOTA", modelo: "HIGHLANDER" }],
  ["4RUNNER", { marca: "TOYOTA", modelo: "4RUNNER" }],
  ["LANDCRUISER", { marca: "TOYOTA", modelo: "LAND CRUISER" }],
  ["CIVIC", { marca: "HONDA", modelo: "CIVIC" }],
  ["ACCORD", { marca: "HONDA", modelo: "ACCORD" }],
  ["CRV", { marca: "HONDA", modelo: "CR-V" }],
  ["HRV", { marca: "HONDA", modelo: "HR-V" }],
  ["FIT", { marca: "HONDA", modelo: "FIT" }],
  ["PILOT", { marca: "HONDA", modelo: "PILOT" }],
  ["ODYSSEY", { marca: "HONDA", modelo: "ODYSSEY" }],
  ["PASSPORT", { marca: "HONDA", modelo: "PASSPORT" }],
  ["FOCUS", { marca: "FORD", modelo: "FOCUS" }],
  ["RANGER", { marca: "FORD", modelo: "RANGER" }],
  ["FIESTA", { marca: "FORD", modelo: "FIESTA" }],
  ["MUSTANG", { marca: "FORD", modelo: "MUSTANG" }],
  ["BRONCO", { marca: "FORD", modelo: "BRONCO" }],
  ["EXPLORER", { marca: "FORD", modelo: "EXPLORER" }],
  ["MAVERICK", { marca: "FORD", modelo: "MAVERICK" }],
  ["TRANSIT", { marca: "FORD", modelo: "TRANSIT" }],
  ["ESCAPE", { marca: "FORD", modelo: "ESCAPE" }],
  ["EDGE", { marca: "FORD", modelo: "EDGE" }],
  ["ECOSPORT", { marca: "FORD", modelo: "ECOSPORT" }],
  ["PALIO", { marca: "FIAT", modelo: "PALIO" }],
  ["UNO", { marca: "FIAT", modelo: "UNO" }],
  ["ARGO", { marca: "FIAT", modelo: "ARGO" }],
  ["CRONOS", { marca: "FIAT", modelo: "CRONOS" }],
  ["STRADA", { marca: "FIAT", modelo: "STRADA" }],
  ["TORO", { marca: "FIAT", modelo: "TORO" }],
  ["PULSE", { marca: "FIAT", modelo: "PULSE" }],
  ["MOBI", { marca: "FIAT", modelo: "MOBI" }],
  ["SIENA", { marca: "FIAT", modelo: "SIENA" }],
  ["DOBLO", { marca: "FIAT", modelo: "DOBLO" }],
  ["LOGAN", { marca: "RENAULT", modelo: "LOGAN" }],
  ["SANDERO", { marca: "RENAULT", modelo: "SANDERO" }],
  ["DUSTER", { marca: "RENAULT", modelo: "DUSTER" }],
  ["CAPTUR", { marca: "RENAULT", modelo: "CAPTUR" }],
  ["KWID", { marca: "RENAULT", modelo: "KWID" }],
  ["KOLEOS", { marca: "RENAULT", modelo: "KOLEOS" }],
  ["MEGANE", { marca: "RENAULT", modelo: "MEGANE" }],
  ["SCENIC", { marca: "RENAULT", modelo: "SCENIC" }],
  ["CLIO", { marca: "RENAULT", modelo: "CLIO" }],
  ["208", { marca: "PEUGEOT", modelo: "208" }],
  ["2008", { marca: "PEUGEOT", modelo: "2008" }],
  ["301", { marca: "PEUGEOT", modelo: "301" }],
  ["3008", { marca: "PEUGEOT", modelo: "3008" }],
  ["PARTNER", { marca: "PEUGEOT", modelo: "PARTNER" }],
  ["308", { marca: "PEUGEOT", modelo: "308" }],
  ["508", { marca: "PEUGEOT", modelo: "508" }],
  ["ACCENT", { marca: "HYUNDAI", modelo: "ACCENT" }],
  ["ELANTRA", { marca: "HYUNDAI", modelo: "ELANTRA" }],
  ["TUCSON", { marca: "HYUNDAI", modelo: "TUCSON" }],
  ["CRETA", { marca: "HYUNDAI", modelo: "CRETA" }],
  ["SANTAFE", { marca: "HYUNDAI", modelo: "SANTA FE" }],
  ["KONA", { marca: "HYUNDAI", modelo: "KONA" }],
  ["PALISADE", { marca: "HYUNDAI", modelo: "PALISADE" }],
  ["GRANDU", { marca: "HYUNDAI", modelo: "GRAND U" }],
  ["ATOS", { marca: "HYUNDAI", modelo: "ATOS" }],
  ["RIO", { marca: "KIA", modelo: "RIO" }],
  ["SPORTAGE", { marca: "KIA", modelo: "SPORTAGE" }],
  ["SOUL", { marca: "KIA", modelo: "SOUL" }],
  ["SELTOS", { marca: "KIA", modelo: "SELTOS" }],
  ["CERATO", { marca: "KIA", modelo: "CERATO" }],
  ["TELLURIDE", { marca: "KIA", modelo: "TELLURIDE" }],
  ["STINGER", { marca: "KIA", modelo: "STINGER" }],
  ["MORNING", { marca: "KIA", modelo: "MORNING" }],
  ["MAZDA3", { marca: "MAZDA", modelo: "MAZDA 3" }],
  ["MAZDA6", { marca: "MAZDA", modelo: "MAZDA 6" }],
  ["CX3", { marca: "MAZDA", modelo: "CX-3" }],
  ["CX5", { marca: "MAZDA", modelo: "CX-5" }],
  ["CX9", { marca: "MAZDA", modelo: "CX-9" }],
  ["MX5", { marca: "MAZDA", modelo: "MX-5" }],
  ["SWIFT", { marca: "SUZUKI", modelo: "SWIFT" }],
  ["VITARA", { marca: "SUZUKI", modelo: "VITARA" }],
  ["GRANDVITARA", { marca: "SUZUKI", modelo: "GRAND VITARA" }],
  ["SX4", { marca: "SUZUKI", modelo: "SX4" }],
  ["JIMNY", { marca: "SUZUKI", modelo: "JIMNY" }],
  ["LANCER", { marca: "MITSUBISHI", modelo: "LANCER" }],
  ["OUTLANDER", { marca: "MITSUBISHI", modelo: "OUTLANDER" }],
  ["L200", { marca: "MITSUBISHI", modelo: "L200" }],
  ["ECLIPSE", { marca: "MITSUBISHI", modelo: "ECLIPSE" }],
  ["ASX", { marca: "MITSUBISHI", modelo: "ASX" }],
  ["PAJERO", { marca: "MITSUBISHI", modelo: "PAJERO" }],
  ["COMPASS", { marca: "JEEP", modelo: "COMPASS" }],
  ["RENEGADE", { marca: "JEEP", modelo: "RENEGADE" }],
  ["WRANGLER", { marca: "JEEP", modelo: "WRANGLER" }],
  ["GRANDCHEROKEE", { marca: "JEEP", modelo: "GRAND CHEROKEE" }],
  ["RAM", { marca: "RAM", modelo: "RAM" }],
  ["DURANGO", { marca: "DODGE", modelo: "DURANGO" }],
  ["ATTITUDE", { marca: "DODGE", modelo: "ATTITUDE" }],
  ["CHALLENGER", { marca: "DODGE", modelo: "CHALLENGER" }],
  ["CHARGER", { marca: "DODGE", modelo: "CHARGER" }],
  ["IMPREZA", { marca: "SUBARU", modelo: "IMPREZA" }],
  ["FORESTER", { marca: "SUBARU", modelo: "FORESTER" }],
  ["OUTBACK", { marca: "SUBARU", modelo: "OUTBACK" }],
  ["CROSSTREK", { marca: "SUBARU", modelo: "CROSSTREK" }],
  ["LEGACY", { marca: "SUBARU", modelo: "LEGACY" }],
  ["XC60", { marca: "VOLVO", modelo: "XC60" }],
  ["XC90", { marca: "VOLVO", modelo: "XC90" }],
  ["S60", { marca: "VOLVO", modelo: "S60" }],
  ["V60", { marca: "VOLVO", modelo: "V60" }],
  ["XC40", { marca: "VOLVO", modelo: "XC40" }],
  ["MINI-COOPER", { marca: "MINI", modelo: "COOPER" }],
  ["MINI-COUNTRYMAN", { marca: "MINI", modelo: "COUNTRYMAN" }],
  ["MINI-CLUBMAN", { marca: "MINI", modelo: "CLUBMAN" }],
  ["SMART-FORTWO", { marca: "SMART", modelo: "FORTWO" }],
  ["SMART-FORFOUR", { marca: "SMART", modelo: "FORFOUR" }],
  ["MG-ZS", { marca: "MG", modelo: "ZS" }],
  ["MG-HS", { marca: "MG", modelo: "HS" }],
  ["MG-5", { marca: "MG", modelo: "5" }],
  ["CHANGAN-CS35", { marca: "CHANGAN", modelo: "CS35" }],
  ["CHANGAN-CS55", { marca: "CHANGAN", modelo: "CS55" }],
  ["CHANGAN-CS75", { marca: "CHANGAN", modelo: "CS75" }],
  ["GEELY-EMGRAND", { marca: "GEELY", modelo: "EMGRAND" }],
  ["GEELY-COOLRAY", { marca: "GEELY", modelo: "COOLRAY" }],
  ["GEELY-AZCARRA", { marca: "GEELY", modelo: "AZCARRA" }],
  ["BYD-F3", { marca: "BYD", modelo: "F3" }],
  ["BYD-SONG", { marca: "BYD", modelo: "SONG" }],
  ["BYD-TANG", { marca: "BYD", modelo: "TANG" }],
  ["JAC-S2", { marca: "JAC", modelo: "S2" }],
  ["JAC-S3", { marca: "JAC", modelo: "S3" }],
  ["JAC-S4", { marca: "JAC", modelo: "S4" }],
  ["DFM-AX7", { marca: "DFM", modelo: "AX7" }],
  ["DFM-S30", { marca: "DFM", modelo: "S30" }],
  ["GAC-GS3", { marca: "GAC", modelo: "GS3" }],
  ["GAC-GS4", { marca: "GAC", modelo: "GS4" }],
  ["KARRY-K50", { marca: "KARRY", modelo: "K50" }],
  ["KARRY-K60", { marca: "KARRY", modelo: "K60" }],
  ["CHERY-TIGGO", { marca: "CHERY", modelo: "TIGGO" }],
  ["CHERY-ARRIZO", { marca: "CHERY", modelo: "ARRIZO" }],
  ["BAIC-X25", { marca: "BAIC", modelo: "X25" }],
  ["BAIC-X35", { marca: "BAIC", modelo: "X35" }],
]);

function detectKnownVehicleModelHint(question, excludedTokens = []) {
  const text = ` ${normalizeText(question).replace(/[¿?¡!.,;:()[\]{}"']/g, " ")} `;

  const entries = [...VEHICLE_MODEL_HINTS.entries()].sort(
    (a, b) => b[0].length - a[0].length
  );

  for (const [token, vehicle] of entries) {
    if (isExcludedValue(token, excludedTokens)) continue;

    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`);

    if (pattern.test(text)) {
      return vehicle;
    }
  }

  return null;
}

function inferBrandFromModel(modelo) {
  const cleanModel = normalizeText(modelo);

  return MODEL_BRAND_HINTS.get(cleanModel) || null;
}

function isInvalidNumericVehicleModel(question, modelo) {
  const text = normalizeText(question);
  const cleanModel = normalizeText(modelo);

  if (!cleanModel || !/^\d{1,3}$/.test(cleanModel)) return false;

  // Modelo "6" casi siempre viene de motor 1.6, medida, canales, etc.
  if (/^\d$/.test(cleanModel)) return true;

  const escaped = cleanModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return (
    new RegExp(`\\bMOTOR\\s+\\d\\s+${escaped}\\b`).test(text) ||
    new RegExp(`\\b${escaped}\\s+(SOHC|DOHC|VTEC|TURBO|L|LTS|LITROS?)\\b`).test(text) ||
    new RegExp(`\\bMOTOR\\s+${escaped}\\b`).test(text)
  );
}

function detectVehicleAlias(question) {
  const text = ` ${normalizeText(question)} `;

  if (
    /\bGM\b/.test(text) ||
    /\bGMC\b/.test(text) ||
    /\bGENERAL MOTORS\b/.test(text)
  ) {
    return {
      marca: "CHEVROLET",
      modelo: null,
      alias_detectado: "GM",
    };
  }

  return null;
}

function isInvalidModelDetectedFromTechnicalMeasurement(question, modelo) {
  const text = normalizeText(question);
  const cleanModel = normalizeText(modelo);

  if (!cleanModel || !/^\d{1,3}$/.test(cleanModel)) return false;

  const escaped = cleanModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return (
    new RegExp(`\\b${escaped}\\s+(CANALES?|RANURAS?|COSTILLAS?|PISTAS?)\\b`).test(text) ||
    new RegExp(`\\b(CANALES?|RANURAS?|COSTILLAS?|PISTAS?)\\s+(DE\\s+)?${escaped}\\b`).test(text) ||
    new RegExp(`\\b${escaped}\\s*(MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN)\\b`).test(text) ||
    new RegExp(`\\b(DIAMETRO|DIÁMETRO|ANCHO|EJE|SEPARACION|SEPARACIÓN|EXCENTRICIDAD|PASO)\\s+(DE\\s+)?${escaped}\\s*(MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN)?\\b`).test(text)
  );
}

async function detectVehicleFromDb(question, excludedTokens = []) {
  const normalizedQuestion = normalizeVehicleLookupText(question);
  const normalizedTextQuestion = ` ${normalizeText(question)} `;
  const vehicleAlias = detectVehicleAlias(question);
  const knownVehicleHint = detectKnownVehicleModelHint(question, excludedTokens);

  if (vehicleAlias) {
    return {
      marca: vehicleAlias.marca,
      modelo: vehicleAlias.modelo,
    };
  }
  const tokens = getSearchTokens(question)
    .map((token) => cleanVehicleLookupToken(token))
    .filter((token) => token.length >= MIN_FUZZY_TOKEN_LENGTH)
    .filter((token) => !STOP_WORDS.has(token))
    .filter((token) => !isExcludedValue(token, excludedTokens));

  const [marcas] = await pool.query(
    `
    SELECT DISTINCT marca_auto
    FROM producto_aplicaciones
    WHERE marca_auto IS NOT NULL AND TRIM(marca_auto) <> ''
    ORDER BY LENGTH(marca_auto) DESC
    LIMIT 300
    `,
  );

  const marcaList = marcas
    .map((row) => row.marca_auto)
    .filter((marca) => !isExcludedValue(marca, excludedTokens));

  let marca =
    marcas.find((row) => {
      if (isExcludedValue(row.marca_auto, excludedTokens)) return false;

      const value = normalizeSearchQuery(row.marca_auto);
      const textValue = normalizeText(row.marca_auto);

      return (
        (value && normalizedQuestion.includes(` ${value} `)) ||
        (textValue && normalizedTextQuestion.includes(` ${textValue} `))
      );
    })?.marca_auto || null;

  if (!marca) {
    for (const token of tokens) {
      const found = safeFuzzyFind(token, marcaList, 1);

      if (found && !isExcludedValue(found, excludedTokens)) {
        marca = found;
        break;
      }
    }
  }

  const [modelos] = await pool.query(
    `
    SELECT DISTINCT modelo_auto
    FROM producto_aplicaciones
    WHERE modelo_auto IS NOT NULL AND TRIM(modelo_auto) <> ''
    ORDER BY LENGTH(modelo_auto) DESC
    LIMIT 800
    `,
  );

  const modeloList = modelos
    .map((row) => row.modelo_auto)
    .filter((modelo) => !isExcludedValue(modelo, excludedTokens));

  let modelo =
    modelos.find((row) => {
      if (isExcludedValue(row.modelo_auto, excludedTokens)) return false;

      const value = normalizeSearchQuery(row.modelo_auto);
      const textValue = normalizeText(row.modelo_auto);

      return (
        (value && normalizedQuestion.includes(` ${value} `)) ||
        (textValue && normalizedTextQuestion.includes(` ${textValue} `))
      );
    })?.modelo_auto || null;

  if (!modelo) {
    for (const token of tokens) {
      const found = safeFuzzyFind(token, modeloList, 1);

      if (found && !isExcludedValue(found, excludedTokens)) {
        modelo = found;
        break;
      }
    }
  }

  if (
    isInvalidModelDetectedFromTechnicalMeasurement(question, modelo) ||
    isInvalidNumericVehicleModel(question, modelo)
  ) {
    modelo = null;
  }

  if (!marca && modelo) {
    marca = inferBrandFromModel(modelo) || marca;
  }

  if (!modelo && knownVehicleHint?.modelo) {
    modelo = knownVehicleHint.modelo;
  }

  if (!marca && knownVehicleHint?.marca) {
    marca = knownVehicleHint.marca;
  }

  return { marca, modelo };
}

function hasNonCatalogIntent(question) {
  const text = normalizeText(question);

  return NON_CATALOG_PATTERNS.some((pattern) => pattern.test(text));
}

function detectDirectProductTerms(question) {
  const text = normalizeText(question);

  return DIRECT_PRODUCT_TERMS.filter((term) => {
    const normalizedTerm = normalizeText(term);
    return text.includes(normalizedTerm);
  });
}

function detectSymptomRules(question) {
  const text = normalizeText(question);
  const negatedOverheat = hasNegatedOverheat(question);

  const mentionsFan =
    /\bVENTILADOR\b/.test(text) ||
    /\bMOTOVENTILADOR\b/.test(text) ||
    /\bABANICO\b/.test(text);

  return SYMPTOM_RULES.filter((rule) => {
    if (rule.key === "COOLING_OVERHEAT" && negatedOverheat) {
      return false;
    }

    if (rule.key === "NO_START" && mentionsFan) {
      return false;
    }

    return rule.patterns.some((pattern) => pattern.test(text));
  });
}

function hasUncertainLanguage(question) {
  const text = normalizeText(question);

  return UNCERTAIN_PATTERNS.some((pattern) => pattern.test(text));
}

function hasGenericProductWithoutVehicle({ intent, directProductTerms }) {
  const hasVehicle =
    Boolean(intent.marca_auto) ||
    Boolean(intent.modelo_auto) ||
    Boolean(intent.anio) ||
    Boolean(intent.motor);

  const hasCode = intent.numero_parte_tokens.length > 0;

  if (hasVehicle || hasCode) return false;

  return directProductTerms.some((term) =>
    GENERIC_PRODUCT_TERMS_REQUIRE_VEHICLE.has(normalizeText(term)),
  );
}
function hasVehicleData(intent) {
  return Boolean(
    intent.marca_auto || intent.modelo_auto || intent.anio || intent.motor,
  );
}

function hasCodeData(intent) {
  return (
    Array.isArray(intent.numero_parte_tokens) &&
    intent.numero_parte_tokens.length > 0
  );
}

function hasSearchableSymptom(intent) {
  return Array.isArray(intent.sintomas_detectados)
    ? intent.sintomas_detectados.some((item) => item.searchable)
    : false;
}

function shouldAllowExploratorySearch({
  intent,
  directProductTerms,
  uncertainLanguage,
}) {
  const hasVehicle = hasVehicleData(intent);
  const hasCode = hasCodeData(intent);
  const hasDirectProduct = directProductTerms.length > 0;

  if (hasVehicle || hasCode) return false;

  // Si el cliente está dudando o describiendo una falla incierta, mejor pedir datos.
  if (uncertainLanguage) return false;

  // Si escribió una pieza/familia clara, dejamos explorar catálogo.
  return hasDirectProduct;
}

function hasExplicitProductSearchIntent(question) {
  const text = normalizeText(question);

  return (
    /\bBUSCO\b/.test(text) ||
    /\bBUSCAR\b/.test(text) ||
    /\bNECESITO\b/.test(text) ||
    /\bOCUPO\b/.test(text) ||
    /\bQUIERO\b/.test(text) ||
    /\bCOTIZAR\b/.test(text) ||
    /\bTIENES\b/.test(text) ||
    /\bTENDRAS\b/.test(text) ||
    /\bTENDRÁS\b/.test(text) ||
    /\bMANEJAS\b/.test(text) ||
    /\bVENDES\b/.test(text) ||
    /\bCODIGO\b/.test(text) ||
    /\bCÓDIGO\b/.test(text)
  );
}

function hasDiagnosticLanguage(question) {
  const text = normalizeText(question);

  return (
    /\bMI\s+(AUTO|CARRO|COCHE|VEHICULO|VEHÍCULO)\b/.test(text) ||
    /\bSE\s+CALIENTA\b/.test(text) ||
    /\bTIRA\b/.test(text) ||
    /\bPIERDE\b/.test(text) ||
    /\bGOTEA\b/.test(text) ||
    /\bHACE\s+RUIDO\b/.test(text) ||
    /\bSUENA\b/.test(text) ||
    /\bQUE\s+PUEDE\s+SER\b/.test(text) ||
    /\bQUÉ\s+PUEDE\s+SER\b/.test(text) ||
    /\bQUE\s+SERA\b/.test(text) ||
    /\bQUÉ\s+SERÁ\b/.test(text)
  );
}

function hasVagueCoolingFluidDescription(question) {
  const text = normalizeText(question);

  return (
    (/\bLIQUIDO\b/.test(text) ||
      /\bLÍQUIDO\b/.test(text) ||
      /\bANTICONGELANTE\b/.test(text) ||
      /\bDONDE\s+LE\s+PONGO\b/.test(text) ||
      /\bDEPOSITO\b/.test(text) ||
      /\bDEPÓSITO\b/.test(text)) &&
    (/\bTIRA\b/.test(text) ||
      /\bPIERDE\b/.test(text) ||
      /\bFUGA\b/.test(text) ||
      /\bGOTEA\b/.test(text))
  );
}

function hasSingleLetterVehicleHint(question) {
  const text = normalizeText(question);

  return (
    /\bPARA\s+UN\s+[A-Z]\b/.test(text) || /\bPARA\s+UNA\s+[A-Z]\b/.test(text)
  );
}

export function buildIntentGate({ question, intent }) {
  const directProductTerms = detectDirectProductTerms(question);
  const symptomRules = detectSymptomRules(question);
  const uncertainLanguage = hasUncertainLanguage(question);
  const genericProductWithoutVehicle = hasGenericProductWithoutVehicle({
    intent,
    directProductTerms,
  });
  const allowExploratorySearch = shouldAllowExploratorySearch({
    intent,
    directProductTerms,
    uncertainLanguage,
  });

  const hasCode = intent.numero_parte_tokens.length > 0;
  const hasVehicle =
    Boolean(intent.marca_auto) ||
    Boolean(intent.modelo_auto) ||
    Boolean(intent.anio) ||
    Boolean(intent.motor);

  const searchableSymptoms = symptomRules.filter((rule) => rule.searchable);
  const nonSearchableSymptoms = symptomRules.filter((rule) => !rule.searchable);

  const explicitProductSearch = hasExplicitProductSearchIntent(question);
  const diagnosticLanguage = hasDiagnosticLanguage(question);

  if (
    searchableSymptoms.length > 0 &&
    !hasVehicle &&
    !hasCode &&
    diagnosticLanguage &&
    !explicitProductSearch
  ) {
    return {
      allowed: false,
      reason: "DIAGNOSTIC_SYMPTOM_WITHOUT_VEHICLE",
      message:
        "Con ese síntoma no conviene recomendar una pieza exacta todavía. Para ayudarte mejor dime marca, modelo, año y motor del vehículo. También ayuda saber si hay fuga, si sube la temperatura, si prende el ventilador o si pierde anticongelante.",
      symptomRules,
      directProductTerms,
    };
  }

  if (
    hasVagueCoolingFluidDescription(question) &&
    !hasVehicle &&
    !hasCode &&
    diagnosticLanguage
  ) {
    return {
      allowed: false,
      reason: "VAGUE_COOLING_FLUID_WITHOUT_VEHICLE",
      message:
        "Por lo que describes, puede estar relacionado con el depósito de anticongelante, tapón, manguera, radiador o alguna fuga del sistema de enfriamiento. Para buscar una pieza correcta necesito marca, modelo, año y motor del vehículo.",
      symptomRules,
      directProductTerms,
    };
  }

  if (
    hasNonCatalogIntent(question) &&
    !hasCode &&
    !directProductTerms.length &&
    !hasVehicle
  ) {
    return {
      allowed: false,
      reason: "OUT_OF_CATALOG_SCOPE",
      message:
        "Solo puedo ayudarte a buscar refacciones dentro del catálogo Andyfers. Escribe la pieza, código, marca, modelo, año o motor del vehículo.",
      symptomRules,
      directProductTerms,
    };
  }

  if (genericProductWithoutVehicle && uncertainLanguage) {
    return {
      allowed: false,
      reason: "GENERIC_UNCERTAIN_PART_WITHOUT_VEHICLE",
      message:
        "Por lo que describes, podría tratarse de una pieza del sistema de enfriamiento, pero todavía no puedo recomendar un producto exacto. Para buscar correctamente necesito marca, modelo, año y motor del vehículo. Si puedes, también indica si el líquido es anticongelante.",
      symptomRules,
      directProductTerms,
    };
  }

  if (genericProductWithoutVehicle && allowExploratorySearch) {
    return {
      allowed: true,
      reason: intent.has_negation
        ? "EXPLORATORY_PRODUCT_SEARCH_WITH_EXCLUSION"
        : "EXPLORATORY_PRODUCT_SEARCH",
      mode: "EXPLORATORY",
      message: null,
      symptomRules,
      directProductTerms,
    };
  }

  if (genericProductWithoutVehicle && uncertainLanguage) {
    return {
      allowed: false,
      reason: "GENERIC_UNCERTAIN_PART_WITHOUT_VEHICLE",
      message:
        "Por lo que describes, podría tratarse de una pieza del sistema de enfriamiento, pero todavía no puedo recomendar un producto exacto. Para buscar correctamente necesito marca, modelo, año y motor del vehículo. Si puedes, también indica si el líquido es anticongelante o sube una foto de la pieza.",
      symptomRules,
      directProductTerms,
    };
  }

  if (
    nonSearchableSymptoms.length > 0 &&
    searchableSymptoms.length === 0 &&
    directProductTerms.length === 0 &&
    !hasCode
  ) {
    return {
      allowed: false,
      reason: "TOO_BROAD_SYMPTOM",
      message:
        "La falla que describes es muy general. Para ayudarte mejor, dime qué pieza buscas o agrega más datos: marca, modelo, año, motor, sistema afectado o número de parte.",
      symptomRules,
      directProductTerms,
    };
  }

  const hasConditionWarnings =
    Array.isArray(intent.condiciones_detectadas) &&
    intent.condiciones_detectadas.length > 0;

  if (
    !hasCode &&
    !hasVehicle &&
    !directProductTerms.length &&
    hasConditionWarnings
  ) {
    return {
      allowed: false,
      reason: "DIAGNOSTIC_WITHOUT_PART_OR_VEHICLE",
      message:
        "Con ese síntoma no conviene recomendar una pieza exacta todavía. Puede estar relacionado con el sistema de enfriamiento, tapón, depósito, radiador, circulación de anticongelante o incluso aire en el sistema. Dime marca, modelo, año, motor y si hay fuga o pérdida de anticongelante para ayudarte mejor.",
      symptomRules,
      directProductTerms,
    };
  }

  if (
    hasSingleLetterVehicleHint(question) &&
    !intent.modelo_auto &&
    !intent.marca_auto
  ) {
    return {
      allowed: false,
      reason: "AMBIGUOUS_SINGLE_LETTER_VEHICLE",
      message:
        "Con solo una letra no puedo identificar el vehículo. Dime la marca y modelo completos, por ejemplo Chevrolet Chevy, GMC, Mazda 3, Gol, Golf, etc.",
      symptomRules,
      directProductTerms,
    };
  }

  if (
    !hasCode &&
    !hasVehicle &&
    !directProductTerms.length &&
    !searchableSymptoms.length
  ) {
    return {
      allowed: false,
      reason: "LOW_CATALOG_INTENT",
      message:
        "No detecté una búsqueda clara de refacción. Escribe la pieza, código, marca, modelo, año o motor para buscar dentro del catálogo Andyfers.",
      symptomRules,
      directProductTerms,
    };
  }

  if (hasVehicleOnlyIntent(question, intent)) {
    return {
      allowed: false,
      reason: "VEHICLE_WITHOUT_PART",
      message:
        "Detecté datos del vehículo, pero todavía falta saber qué pieza necesitas. Dime la refacción, sistema o síntoma para buscar correctamente en el catálogo Andyfers.",
      symptomRules,
      directProductTerms,
    };
  }

  return {
    allowed: true,
    reason: "CATALOG_SEARCH",
    message: null,
    symptomRules,
    directProductTerms,
  };
}

function detectCoolantPreferences(question) {
  const text = normalizeText(question);

  return {
    organico:
      /\bORGANICO\b/.test(text) ||
      /\bORGÁNICO\b/.test(text) ||
      /\bOAT\b/.test(text),
    tradicional:
      /\bTRADICIONAL\b/.test(text) ||
      /\bCONVENCIONAL\b/.test(text),
    verde: /\bVERDE\b/.test(text),
  };
}

function detectCommercialPreferences(question) {
  const text = normalizeText(question);

  return {
    economica:
      /\bMAS\s+BARATA\b/.test(text) ||
      /\bMÁS\s+BARATA\b/.test(text) ||
      /\bBARATA\b/.test(text) ||
      /\bBARATO\b/.test(text) ||
      /\bECONOMICA\b/.test(text) ||
      /\bECONÓMICA\b/.test(text) ||
      /\bECONOMICO\b/.test(text) ||
      /\bECONÓMICO\b/.test(text),
    no_original:
      /\bNO\s+LA\s+ORIGINAL\b/.test(text) ||
      /\bNO\s+ORIGINAL\b/.test(text) ||
      /\bGENERICA\b/.test(text) ||
      /\bGENÉRICA\b/.test(text) ||
      /\bGENERICO\b/.test(text) ||
      /\bGENÉRICO\b/.test(text),
  };
}

function detectConditionWarnings(question) {
  const text = normalizeText(question);
  const warnings = [];

  if (
    /\bLLUEVE\b/.test(text) ||
    /\bLLUVIA\b/.test(text) ||
    /\bMOJA\b/.test(text) ||
    /\bMOJADO\b/.test(text)
  ) {
    warnings.push({
      key: "RAIN_CONDITION",
      label:
        "La falla aparece con lluvia o humedad; también podría relacionarse con conexiones eléctricas, sensores o humedad en componentes.",
    });
  }

  if (
    /\bCON\s+CLIMA\b/.test(text) ||
    /\bUSO\s+EL\s+CLIMA\b/.test(text) ||
    /\bPRENDO\s+EL\s+CLIMA\b/.test(text) ||
    /\bAIRE\s+ACONDICIONADO\b/.test(text)
  ) {
    warnings.push({
      key: "AC_CONDITION",
      label:
        "La falla aparece al usar el clima; puede aumentar la carga del motor o del sistema de enfriamiento.",
    });
  }

  if (/\bNO\s+SE\s+CALIENTA\b/.test(text) || /\bNO\s+CALIENTA\b/.test(text)) {
    warnings.push({
      key: "NEGATED_OVERHEAT",
      label:
        "El cliente indica que no se calienta; no conviene asumir sobrecalentamiento como causa principal.",
    });
  }

  return warnings;
}

export function asksForFutureStock(question) {
  const text = normalizeText(question);

  return (
    /\bCUANDO\b.*\bTENER\b.*\bSTOCK\b/.test(text) ||
    /\bCUÁNDO\b.*\bTENER\b.*\bSTOCK\b/.test(text) ||
    /\bCUANDO\b.*\bLLEGA\b/.test(text) ||
    /\bCUÁNDO\b.*\bLLEGA\b/.test(text) ||
    /\bPROXIMA\s+SEMANA\b/.test(text) ||
    /\bPRÓXIMA\s+SEMANA\b/.test(text) ||
    /\bREABASTECER\b/.test(text) ||
    /\bREABASTECIMIENTO\b/.test(text)
  );
}

function extractMotorCandidates(question) {
  const text = normalizeText(question);

  const decimalMatches = text.match(/\b[0-9]{1}\.[0-9]\b/g) || [];
  const ccMatches = text.match(/\b[0-9]{3,4}\s*CC\b/g) || [];

  return unique([
    ...decimalMatches,
    ...ccMatches.map((item) => item.replace(/\s+/g, " ")),
  ]);
}

function hasAmbiguousMotor(question) {
  const text = normalizeText(question);
  const candidates = extractMotorCandidates(question);

  return (
    candidates.length > 1 ||
    /\bNO\s+SE\s+SI\b.*\bMOTOR\b/.test(text) ||
    /\bNO\s+SÉ\s+SI\b.*\bMOTOR\b/.test(text) ||
    /\bNO\s+SE\s+SI\s+ES\b/.test(text) ||
    /\bNO\s+SÉ\s+SI\s+ES\b/.test(text)
  );
}

function hasNegatedOverheat(question) {
  const text = normalizeText(question);

  return /\bNO\s+SE\s+CALIENTA\b/.test(text) || /\bNO\s+CALIENTA\b/.test(text);
}

function buildProductQueryTokens({
  directProductTerms = [],
  expansionTokens = [],
  symptomTokens = [],
  synonyms = [],
}) {
  const synonymProductTokens = synonyms
    .filter((item) =>
      ["FAMILIA", "CATEGORIA", "CATEGORÍA", "PRODUCTO"].includes(
        normalizeText(item.tipo),
      ),
    )
    .flatMap((item) => [
      ...normalizeSearchQuery(item.texto_usuario).split(" "),
      ...normalizeSearchQuery(item.texto_normalizado).split(" "),
      item.texto_usuario,
      item.texto_normalizado,
    ]);

  return unique([
    ...directProductTerms,
    ...expansionTokens,
    ...symptomTokens,
    ...synonymProductTokens,
  ])
    .map((token) => normalizeText(token))
    .filter(Boolean)
    .filter((token) => token.length >= 2)
    .filter((token) => !STOP_WORDS.has(token))
    .slice(0, 24);
}

function detectStrictProductFamilyTokens({
  directProductTerms = [],
  expansionTokens = [],
}) {
  const text = normalizeText(
    [...directProductTerms, ...expansionTokens].join(" "),
  );

  if (
    text.includes("WATER PUMP") ||
    text.includes("BOMBA DE AGUA") ||
    text.includes("BOMBA AGUA")
  ) {
    return ["BOMBA", "BOMBAS", "BOMBA DE AGUA", "BOMBAS DE AGUA"];
  }

  if (
    text.includes("EMPAQUE DE CABEZA") ||
    text.includes("EMPAQUE CABEZA") ||
    text.includes("JUNTA DE CABEZA") ||
    text.includes("JUNTA CABEZA") ||
    text.includes("JUNTA DE CULATA") ||
    text.includes("JUNTA CULATA")
  ) {
    return [
      "EMPAQUE",
      "EMPAQUE CABEZA",
      "EMPAQUE DE CABEZA",
      "JUNTA CABEZA",
      "JUNTA DE CABEZA",
      "JUNTA CULATA",
      "JUNTA DE CULATA",
    ];
  }

  if (
    text.includes("PASTILLAS DE FRENO") ||
    text.includes("PASTILLAS FRENO") ||
    text.includes("BALATAS")
  ) {
    return [
      "PASTILLAS",
      "PASTILLAS DE FRENO",
      "PASTILLAS FRENO",
      "BALATAS",
      "FRENOS",
    ];
  }

  if (
    text.includes("TAPON RADIADOR") ||
    text.includes("TAPON DEPOSITO") ||
    text.includes("TAPÓN RADIADOR") ||
    text.includes("TAPÓN DEPOSITO")
  ) {
    return [
      "TAPON",
      "TAPÓN",
      "TAPON RADIADOR",
      "TAPON DEPOSITO",
      "TAPÓN RADIADOR",
    ];
  }

  if (text.includes("POLEA") || text.includes("PULLEY")) {
    return ["POLEA", "POLEAS"];
  }

  return [];
}

const SEMANTIC_PRODUCT_MAP = {
  BOMBA: {
    direct: ["BOMBA DE AGUA"],
    product: ["BOMBA", "BOMBA AGUA", "BOMBA DE AGUA", "BOMBAS DE AGUA"],
    strict: ["BOMBA", "BOMBAS", "BOMBA DE AGUA", "BOMBAS DE AGUA"],
  },
  "BOMBA DE AGUA": {
    direct: ["BOMBA DE AGUA"],
    product: ["BOMBA", "BOMBA AGUA", "BOMBA DE AGUA", "BOMBAS DE AGUA"],
    strict: ["BOMBA", "BOMBAS", "BOMBA DE AGUA", "BOMBAS DE AGUA"],
  },
  TERMOSTATO: {
    direct: ["TERMOSTATO"],
    product: ["TERMOSTATO", "TERMOSTATOS"],
    strict: ["TERMOSTATO", "TERMOSTATOS"],
  },
  RADIADOR: {
    direct: ["RADIADOR"],
    product: ["RADIADOR", "RADIADORES"],
    strict: ["RADIADOR", "RADIADORES"],
  },
  MANGUERA: {
    direct: ["MANGUERA"],
    product: ["MANGUERA", "MANGUERAS"],
    strict: ["MANGUERA", "MANGUERAS"],
  },
  TAPON: {
    direct: ["TAPON", "TAPÓN"],
    product: ["TAPON", "TAPÓN", "TAPON RADIADOR", "TAPON DEPOSITO"],
    strict: ["TAPON", "TAPÓN"],
  },
  SENSOR: {
    direct: ["SENSOR"],
    product: ["SENSOR", "BULBO", "SENSOR TEMPERATURA"],
    strict: ["SENSOR", "BULBO"],
  },
  ANTICONGELANTE: {
    direct: ["ANTICONGELANTE"],
    product: ["ANTICONGELANTE", "ANTICONGELANTE ORGANICO", "ANTICONGELANTE VERDE", "ANTICONGELANTE TRADICIONAL"],
    strict: ["ANTICONGELANTE"],
  },
  "EMPAQUE DE CABEZA": {
    direct: ["EMPAQUE DE CABEZA", "JUNTA DE CABEZA", "JUNTA DE CULATA"],
    product: [
      "EMPAQUE",
      "EMPAQUE CABEZA",
      "EMPAQUE DE CABEZA",
      "JUNTA CABEZA",
      "JUNTA DE CABEZA",
      "JUNTA CULATA",
      "JUNTA DE CULATA",
    ],
    strict: [
      "EMPAQUE",
      "EMPAQUE CABEZA",
      "EMPAQUE DE CABEZA",
      "JUNTA CABEZA",
      "JUNTA DE CABEZA",
      "JUNTA CULATA",
      "JUNTA DE CULATA",
    ],
  },
};

function hasSemanticNegationLanguage(question) {
  const text = normalizeText(question);

  return (
    /\bNO\s+SEA\b/.test(text) ||
    /\bOTRA\s+MARCA\b/.test(text) ||
    /\bDISTINT[AO]\b/.test(text) ||
    /\bDIFERENTE\b/.test(text) ||
    /\bEXCEPTO\b/.test(text) ||
    /\bALTERNATIV[AO]\b/.test(text) ||
    /\bNO\s+PERTENEZCA\b/.test(text) ||
    /\bNO\s+PROVENGA\b/.test(text) ||
    /\bNO\s+EST[ÉE]\s+ASOCIAD[AO]\b/.test(text) ||
    /\bNO\s+SEA\s+PRODUCID[AO]\b/.test(text) ||
    /\bFABRICAD[AO]\s+POR\s+UNA\s+MARCA\s+DIFERENTE\b/.test(text) ||
    /\bNOT\s+FOR\b/.test(text)
  );
}

export function shouldUseSemanticIntentNormalizer(question, localIntent) {
  const rawEnabled = process.env.AI_INTENT_NORMALIZER_ENABLED;

  const enabled =
    rawEnabled === undefined
      ? true
      : ["1", "true", "yes", "on", "si", "sí"].includes(
        String(rawEnabled).toLowerCase(),
      );

  if (!enabled) return false;

  const hasLocalExclusions =
    Array.isArray(localIntent.excluded_tokens) &&
    localIntent.excluded_tokens.length > 0;

  if (hasSemanticNegationLanguage(question)) {
    return true;
  }

  const hasProduct =
    Array.isArray(localIntent.terminos_producto_detectados) &&
    localIntent.terminos_producto_detectados.length > 0;

  const hasCode =
    Array.isArray(localIntent.numero_parte_tokens) &&
    localIntent.numero_parte_tokens.length > 0;

  const hasVehicle =
    Boolean(localIntent.marca_auto) ||
    Boolean(localIntent.modelo_auto) ||
    Boolean(localIntent.anio) ||
    Boolean(localIntent.motor);

  const hasWeakIntent = !hasProduct && !hasCode && !hasVehicle;

  if (hasWeakIntent && String(question).length > 20) {
    return true;
  }

  return false;
}

function normalizeSemanticList(values = []) {
  return unique(
    values
      .map((item) => normalizeText(item))
      .filter(Boolean)
      .filter((item) => item.length >= 2),
  );
}

export function applySemanticIntentToLocalIntent(localIntent, semanticIntent) {
  if (!semanticIntent) return localIntent;

  const pieza = normalizeText(semanticIntent.pieza_normalizada);
  const productMap = SEMANTIC_PRODUCT_MAP[pieza] || null;

  const legacySemanticExclusions = normalizeSemanticList(
    semanticIntent.exclusiones,
  );
  const semanticVehicleExclusions = normalizeSemanticList(
    semanticIntent.exclusiones_vehiculo,
  );
  const semanticProductBrandExclusions = normalizeSemanticList(
    semanticIntent.exclusiones_marca_producto,
  );

  const currentVehicleExclusions = normalizeSemanticList(
    localIntent.excluded_vehicle_tokens || localIntent.excluded_tokens || [],
  );

  const currentProductBrandExclusions = normalizeSemanticList(
    localIntent.excluded_product_brand_tokens || [],
  );

  const excludedVehicleTokens = unique([
    ...currentVehicleExclusions,
    ...semanticVehicleExclusions,
  ]);

  const excludedProductBrandTokens = unique([
    ...currentProductBrandExclusions,
    ...semanticProductBrandExclusions,
  ]);

  /**
   * Compatibilidad legacy:
   * Si la IA vieja todavía manda "exclusiones" plano, las usamos como vehículo
   * solo cuando no se pudo clasificar nada nuevo.
   */
  const fallbackVehicleTokens =
    excludedVehicleTokens.length || excludedProductBrandTokens.length
      ? excludedVehicleTokens
      : legacySemanticExclusions;

  const next = {
    ...localIntent,
    excluded_tokens: fallbackVehicleTokens,
    excluded_vehicle_tokens: fallbackVehicleTokens,
    excluded_product_brand_tokens: excludedProductBrandTokens,
    has_negation:
      fallbackVehicleTokens.length > 0 ||
      excludedProductBrandTokens.length > 0 ||
      Boolean(localIntent.has_negation),
    normalizador_ia: semanticIntent,
    normalizador_ia_aplicado: true,
  };

  if (productMap) {
    next.terminos_producto_detectados = unique([
      ...(localIntent.terminos_producto_detectados || []),
      ...productMap.direct,
    ]);

    next.product_query_tokens = unique([
      ...(localIntent.product_query_tokens || []),
      ...productMap.product,
    ]);

    next.strict_product_family_tokens = unique([
      ...(localIntent.strict_product_family_tokens || []),
      ...productMap.strict,
    ]);

    next.tokens = unique([...(localIntent.tokens || []), ...productMap.product])
      .map((token) => normalizeText(token))
      .filter((token) => !STOP_WORDS.has(token));
  }

  const preferencias = semanticIntent.preferencias || {};
  next.preferencias_comerciales = {
    ...(localIntent.preferencias_comerciales || {}),
    economica:
      Boolean(localIntent.preferencias_comerciales?.economica) ||
      Boolean(preferencias.economica),
    no_original:
      Boolean(localIntent.preferencias_comerciales?.no_original) ||
      Boolean(preferencias.no_original),
    otra_marca:
      Boolean(localIntent.preferencias_comerciales?.otra_marca) ||
      Boolean(preferencias.otra_marca),
  };

  const vehiculo = semanticIntent.vehiculo || {};

  if (!next.marca_auto && vehiculo.marca_auto) {
    next.marca_auto = normalizeText(vehiculo.marca_auto);
  }

  if (!next.modelo_auto && vehiculo.modelo_auto) {
    next.modelo_auto = normalizeText(vehiculo.modelo_auto);
  }

  if (!next.anio && vehiculo.anio) {
    next.anio = vehiculo.anio;
  }

  if (!next.motor && vehiculo.motor) {
    next.motor = normalizeText(vehiculo.motor);
  }

  return next;
}

function classifyLocalExclusionsByScope(question, exclusions = []) {
  const text = normalizeText(question);
  const cleanExclusions = normalizeSemanticList(exclusions);

  const productBrandLanguage =
    /\bMARCA\s+DIFERENTE\b/.test(text) ||
    /\bOTRA\s+MARCA\b/.test(text) ||
    /\bDISTINT[AO]\s+A\b/.test(text) ||
    /\bFABRICAD[AO]\b/.test(text) ||
    /\bPRODUCID[AO]\b/.test(text) ||
    /\bPROVENGA\b/.test(text) ||
    /\bORIGINAL\b/.test(text) ||
    /\bOEM\b/.test(text);

  const vehicleApplicationLanguage =
    /\bPARA\b/.test(text) ||
    /\bCOMPATIBLE\b/.test(text) ||
    /\bLE\s+QUEDE\b/.test(text) ||
    /\bLE\s+SIRVA\b/.test(text) ||
    /\bAPLIQUE\b/.test(text) ||
    /\bAPLICACION\b/.test(text) ||
    /\bAPLICACIÓN\b/.test(text) ||
    /\bNOT\s+FOR\b/.test(text);

  if (productBrandLanguage && !vehicleApplicationLanguage) {
    return {
      vehicle: [],
      productBrand: cleanExclusions,
    };
  }

  return {
    vehicle: cleanExclusions,
    productBrand: [],
  };
}

function detectPositionTerms(question) {
  const text = normalizeText(question);
  const positions = [];

  if (/\bSUPERIOR\b/.test(text) || /\bARRIBA\b/.test(text)) {
    positions.push("SUPERIOR");
  }

  if (/\bINFERIOR\b/.test(text) || /\bABAJO\b/.test(text)) {
    positions.push("INFERIOR");
  }

  if (/\bDELANTER[AO]\b/.test(text)) {
    positions.push("DELANTERO");
  }

  if (/\bTRASER[AO]\b/.test(text)) {
    positions.push("TRASERO");
  }

  if (/\bIZQUIERD[AO]\b/.test(text)) {
    positions.push("IZQUIERDO");
  }

  if (/\bDERECH[AO]\b/.test(text)) {
    positions.push("DERECHO");
  }

  return unique(positions);
}

function hasThermostatTemperatureComparison(question) {
  const text = normalizeText(question);

  return (
    /\bTERMOSTATO\b/.test(text) &&
    (
      /\bDIFERENCIA\b/.test(text) ||
      /\bCOMPARA\b/.test(text) ||
      /\bVS\b/.test(text) ||
      /\bENTRE\b/.test(text)
    ) &&
    /\b(7[0-9]|8[0-9]|9[0-9])\s*(°|GRADOS|C)?\b/.test(text)
  );
}

function extractTemperatureCandidates(question) {
  const text = normalizeText(question);
  const matches = text.match(/\b(7[0-9]|8[0-9]|9[0-9])\s*(°|GRADOS|C)?\b/g) || [];

  return unique(
    matches
      .map((item) => {
        const value = String(item).match(/\d+/)?.[0];
        return value ? Number(value) : null;
      })
      .filter((value) => Number.isFinite(value))
  );
}

export async function buildIntent(question) {
  const thermostatTemperatureComparison = hasThermostatTemperatureComparison(question);
  const temperaturas_detectadas = extractTemperatureCandidates(question);
  const normalizedQuestion = normalizeSearchQuery(question);
  const excludedTokens = extractExcludedTerms(question);
  const localExclusionScope = classifyLocalExclusionsByScope(
    question,
    excludedTokens,
  );
  const commercialPreferences = detectCommercialPreferences(question);
  const coolantPreferences = detectCoolantPreferences(question);
  const conditionWarnings = detectConditionWarnings(question);
  const measurementFilters = detectMeasurementFilters(question);
  const motorCandidates = extractMotorCandidates(question);
  const motorAmbiguo = hasAmbiguousMotor(question);
  const synonyms = await getMatchingSynonyms(
    normalizedQuestion,
    excludedTokens,
  );
  const vehicle = await detectVehicleFromDb(question, excludedTokens);

  const synonymTokens = synonyms.flatMap((item) => [
    ...normalizeSearchQuery(item.texto_usuario).split(" "),
    ...normalizeSearchQuery(item.texto_normalizado).split(" "),
  ]);

  const symptomRules = detectSymptomRules(question);
  const symptomTokens = symptomRules
    .filter((rule) => rule.searchable)
    .flatMap((rule) => rule.tokens);

  const directProductTerms = detectDirectProductTerms(question);
  const positionTerms = detectPositionTerms(question);
  const crossApplicationComparison = detectCrossApplicationComparison(
    question,
    directProductTerms
  );
  const expansionTokens = getExpansionTokens(question);
  const productBrandExclusions = extractProductBrandExclusions(question);
  const productQueryTokens = buildProductQueryTokens({
    directProductTerms,
    expansionTokens: [...expansionTokens, ...positionTerms],
    symptomTokens,
    synonyms,
  });
  const strictProductFamilyTokens = detectStrictProductFamilyTokens({
    directProductTerms,
    expansionTokens,
  });

  const tokens = unique([
    ...extractPlainTokens(question),
    ...synonymTokens.map((token) => token.trim()).filter(Boolean),
    ...directProductTerms,
    ...symptomTokens,
    ...expansionTokens,
  ])
    .map((token) => normalizeText(token))
    .filter((token) => token.length >= 2)
    .filter((token) => !STOP_WORDS.has(token))
    .filter((token) => !isExcludedValue(token, excludedTokens))
    .slice(0, 32);

  const vehicleForIntent = crossApplicationComparison?.vehiculo_objetivo || vehicle;
  const yearCandidates = extractYearCandidates(question);
  const selectedYear = yearCandidates.length
    ? yearCandidates[yearCandidates.length - 1]
    : null;
  const approximateYear = hasApproximateYearLanguage(question);

  return {
    pregunta_normalizada: normalizedQuestion,
    anio: selectedYear,
    anios_posibles: yearCandidates,
    anio_aproximado: approximateYear,
    motor: extractMotor(question),
    numero_parte_tokens: extractPartNumbers(question),
    tokens,
    excluded_tokens: localExclusionScope.vehicle,
    excluded_vehicle_tokens: localExclusionScope.vehicle,
    excluded_product_brand_tokens: productBrandExclusions,
    has_negation:
      localExclusionScope.vehicle.length > 0 ||
      localExclusionScope.productBrand.length > 0,
    sinonimos_detectados: synonyms,
    expansiones_detectadas: expansionTokens,
    sintomas_detectados: symptomRules.map((rule) => ({
      key: rule.key,
      label: rule.label,
      searchable: rule.searchable,
    })),
    terminos_producto_detectados: directProductTerms,
    marca_auto: vehicleForIntent?.marca || vehicle.marca,
    modelo_auto: vehicleForIntent?.modelo || vehicle.modelo,
    comparacion_aplicacion: crossApplicationComparison,
    preferencias_comerciales: commercialPreferences,
    preferencias_producto: {
      anticongelante: coolantPreferences,
    },
    condiciones_detectadas: conditionWarnings,
    medidas_detectadas: measurementFilters,
    motores_posibles: motorCandidates,
    motor_ambiguo: motorAmbiguo,
    product_query_tokens: productQueryTokens,
    strict_product_family_tokens: strictProductFamilyTokens,
    posiciones_detectadas: positionTerms,
    comparacion_temperatura_termostato: thermostatTemperatureComparison,
    temperaturas_detectadas,
  };
}
