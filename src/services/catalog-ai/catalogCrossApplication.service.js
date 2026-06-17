import { normalizeText } from "../../utils/normalize.js";

const CROSS_APP_MODEL_HINTS = new Map([
  // GM FAMILY 1
  ["CHEVY", { marca: "CHEVROLET", modelo: "CHEVY", familia_motor: "GM_FAM1" }],
  ["CORSA", { marca: "CHEVROLET", modelo: "CORSA", familia_motor: "GM_FAM1" }],
  ["ASTRA", { marca: "CHEVROLET", modelo: "ASTRA", familia_motor: "GM_FAM1" }],
  ["VECTRA", { marca: "CHEVROLET", modelo: "VECTRA", familia_motor: "GM_FAM1" }],
  ["ZAFIRA", { marca: "CHEVROLET", modelo: "ZAFIRA", familia_motor: "GM_FAM1" }],
  ["MERIVA", { marca: "CHEVROLET", modelo: "MERIVA", familia_motor: "GM_FAM1" }],
  ["MONTANA", { marca: "CHEVROLET", modelo: "MONTANA", familia_motor: "GM_FAM1" }],

  // GM FAMILY 2
  ["CRUZE", { marca: "CHEVROLET", modelo: "CRUZE", familia_motor: "GM_FAM2" }],
  ["ONIX", { marca: "CHEVROLET", modelo: "ONIX", familia_motor: "GM_FAM2" }],
  ["PRISMA", { marca: "CHEVROLET", modelo: "PRISMA", familia_motor: "GM_FAM2" }],
  ["COBALT", { marca: "CHEVROLET", modelo: "COBALT", familia_motor: "GM_FAM2" }],

  // GM ECOTEC
  ["TRAX", { marca: "CHEVROLET", modelo: "TRAX", familia_motor: "GM_ECOTEC" }],
  ["EQUINOX", { marca: "CHEVROLET", modelo: "EQUINOX", familia_motor: "GM_ECOTEC" }],
  ["SPARK", { marca: "CHEVROLET", modelo: "SPARK", familia_motor: "GM_ECOTEC" }],
  ["BEAT", { marca: "CHEVROLET", modelo: "BEAT", familia_motor: "GM_ECOTEC" }],

  // NISSAN
  ["TSURU", { marca: "NISSAN", modelo: "TSURU", familia_motor: "NISSAN_GA" }],
  ["SENTRA", { marca: "NISSAN", modelo: "SENTRA", familia_motor: "NISSAN_GA" }],
  ["B15", { marca: "NISSAN", modelo: "SENTRA B15", familia_motor: "NISSAN_GA" }],
  ["MARCH", { marca: "NISSAN", modelo: "MARCH", familia_motor: "NISSAN_HR" }],
  ["VERSA", { marca: "NISSAN", modelo: "VERSA", familia_motor: "NISSAN_HR" }],
  ["KICKS", { marca: "NISSAN", modelo: "KICKS", familia_motor: "NISSAN_HR" }],

  // VOLKSWAGEN
  ["GOL", { marca: "VOLKSWAGEN", modelo: "GOL", familia_motor: "VW_AP" }],
  ["POINTER", { marca: "VOLKSWAGEN", modelo: "POINTER", familia_motor: "VW_AP" }],
  ["PARATI", { marca: "VOLKSWAGEN", modelo: "PARATI", familia_motor: "VW_AP" }],
  ["SANTANA", { marca: "VOLKSWAGEN", modelo: "SANTANA", familia_motor: "VW_AP" }],
  ["POLO", { marca: "VOLKSWAGEN", modelo: "POLO", familia_motor: "VW_EA111" }],
  ["VIRTUS", { marca: "VOLKSWAGEN", modelo: "VIRTUS", familia_motor: "VW_EA111" }],
  ["SAVEIRO", { marca: "VOLKSWAGEN", modelo: "SAVEIRO", familia_motor: "VW_EA111" }],
  ["VENTO", { marca: "VOLKSWAGEN", modelo: "VENTO", familia_motor: "VW_EA111" }],
  ["JETTA", { marca: "VOLKSWAGEN", modelo: "JETTA", familia_motor: "VW_EA888" }],
  ["AMAROK", { marca: "VOLKSWAGEN", modelo: "AMAROK", familia_motor: "VW_AMAROK" }],

  // TOYOTA
  ["COROLLA", { marca: "TOYOTA", modelo: "COROLLA", familia_motor: "TOYOTA_ZZ" }],
  ["YARIS", { marca: "TOYOTA", modelo: "YARIS", familia_motor: "TOYOTA_NZ" }],
  ["MATRIX", { marca: "TOYOTA", modelo: "MATRIX", familia_motor: "TOYOTA_ZZ" }],

  // HONDA
  ["CIVIC", { marca: "HONDA", modelo: "CIVIC", familia_motor: "HONDA_D" }],
  ["CIVIC-16V", { marca: "HONDA", modelo: "CIVIC 16V", familia_motor: "HONDA_D" }],
  ["ACCORD", { marca: "HONDA", modelo: "ACCORD", familia_motor: "HONDA_K" }],
  ["CRV", { marca: "HONDA", modelo: "CR-V", familia_motor: "HONDA_K" }],
  ["HRV", { marca: "HONDA", modelo: "HR-V", familia_motor: "HONDA_L" }],

  // FORD
  ["FOCUS", { marca: "FORD", modelo: "FOCUS", familia_motor: "FORD_ZETEC" }],
  ["FIESTA", { marca: "FORD", modelo: "FIESTA", familia_motor: "FORD_ZETEC" }],
  ["KA", { marca: "FORD", modelo: "KA", familia_motor: "FORD_DURATEC" }],
  ["RANGER", { marca: "FORD", modelo: "RANGER", familia_motor: "FORD_RANGER" }],

  // FIAT
  ["PALIO", { marca: "FIAT", modelo: "PALIO", familia_motor: "FIAT_FIRE" }],
  ["UNO", { marca: "FIAT", modelo: "UNO", familia_motor: "FIAT_FIRE" }],
  ["SIENA", { marca: "FIAT", modelo: "SIENA", familia_motor: "FIAT_FIRE" }],
  ["STRADA", { marca: "FIAT", modelo: "STRADA", familia_motor: "FIAT_FIRE" }],
  ["ARGO", { marca: "FIAT", modelo: "ARGO", familia_motor: "FIAT_TORQ" }],

  // RENAULT
  ["LOGAN", { marca: "RENAULT", modelo: "LOGAN", familia_motor: "RENAULT_K" }],
  ["SANDERO", { marca: "RENAULT", modelo: "SANDERO", familia_motor: "RENAULT_K" }],
  ["DUSTER", { marca: "RENAULT", modelo: "DUSTER", familia_motor: "RENAULT_K" }],
  ["CAPTUR", { marca: "RENAULT", modelo: "CAPTUR", familia_motor: "RENAULT_K" }],

  // HYUNDAI / KIA
  ["ACCENT", { marca: "HYUNDAI", modelo: "ACCENT", familia_motor: "HYUNDAI_ALPHA" }],
  ["ELANTRA", { marca: "HYUNDAI", modelo: "ELANTRA", familia_motor: "HYUNDAI_BETA" }],
  ["RIO", { marca: "KIA", modelo: "RIO", familia_motor: "HYUNDAI_ALPHA" }],
  ["CERATO", { marca: "KIA", modelo: "CERATO", familia_motor: "HYUNDAI_BETA" }],

  // MAZDA
  ["MAZDA3", { marca: "MAZDA", modelo: "MAZDA 3", familia_motor: "MAZDA_L" }],
  ["MAZDA6", { marca: "MAZDA", modelo: "MAZDA 6", familia_motor: "MAZDA_L" }],
  ["CX5", { marca: "MAZDA", modelo: "CX-5", familia_motor: "MAZDA_L" }],
]);

const MOTOR_FAMILY_STRONG_PARTS = new Set([
  "BOMBA DE AGUA",
  "TERMOSTATO",
  "BULBO",
  "TERMOSWITCH",
  "SENSOR TEMPERATURA",
]);

const CHASSIS_SENSITIVE_PARTS = new Set([
  "RADIADOR",
  "MANGUERA DE ENFRIAMIENTO",
  "VENTILADOR DE ENFRIAMIENTO",
  "DEPOSITO DE EXPANSION",
  "TAPON RADIADOR",
]);

function getCrossAppVehicleHint(token) {
  const cleanToken = normalizeText(token);
  return CROSS_APP_MODEL_HINTS.get(cleanToken) || null;
}

function detectCoolingPart(question, directProductTerms = []) {
  const text = normalizeText(question);

  if (/\bBOMBA\s+DE\s+AGUA\b/.test(text) || /\bBOMBA\s+AGUA\b/.test(text)) {
    return "BOMBA DE AGUA";
  }

  if (/\bTERMOSTATO\b/.test(text)) return "TERMOSTATO";
  if (/\bRADIADOR\b/.test(text)) return "RADIADOR";

  if (/\bTAPON\s+DE\s+RADIADOR\b/.test(text) || /\bTAPON\s+RADIADOR\b/.test(text)) {
    return "TAPON RADIADOR";
  }

  if (/\bVENTILADOR\b/.test(text) || /\bMOTOVENTILADOR\b/.test(text)) {
    return "VENTILADOR DE ENFRIAMIENTO";
  }

  if (/\bDEPOSITO\b/.test(text) || /\bTANQUE\s+DE\s+AGUA\b/.test(text)) {
    return "DEPOSITO DE EXPANSION";
  }

  if (/\bMANGUERA\b/.test(text)) return "MANGUERA DE ENFRIAMIENTO";

  if (/\bTERMO\s+SWITCH\b/.test(text) || /\bTERMOSWITCH\b/.test(text)) {
    return "TERMOSWITCH";
  }

  if (/\bBULBO\b/.test(text) || /\bSENSOR\s+DE\s+TEMPERATURA\b/.test(text)) {
    return "SENSOR TEMPERATURA";
  }

  if (Array.isArray(directProductTerms) && directProductTerms.length > 0) {
    return directProductTerms[0];
  }

  return "PIEZA DEL SISTEMA DE ENFRIAMIENTO";
}

function extractCrossVehicles(question) {
  const text = normalizeText(question);

  const targetPatterns = [
    /\bPARA\s+MI\s+([A-Z0-9ÑÁÉÍÓÚ-]+)\b/,
    /\bA\s+MI\s+([A-Z0-9ÑÁÉÍÓÚ-]+)\b/,
    /\bAL\s+([A-Z0-9ÑÁÉÍÓÚ-]+)\b/,
    /\bA\s+LA\s+([A-Z0-9ÑÁÉÍÓÚ-]+)\b/,
    /\bA\s+EL\s+([A-Z0-9ÑÁÉÍÓÚ-]+)\b/,
  ];

  const donorPatterns = [
    /\bDEL\s+([A-Z0-9ÑÁÉÍÓÚ-]+)\b/,
    /\bDE\s+LA\s+([A-Z0-9ÑÁÉÍÓÚ-]+)\b/,
    /\bDE\s+EL\s+([A-Z0-9ÑÁÉÍÓÚ-]+)\b/,
    /\bDE\s+UN\s+([A-Z0-9ÑÁÉÍÓÚ-]+)\b/,
    /\bDE\s+UNA\s+([A-Z0-9ÑÁÉÍÓÚ-]+)\b/,
  ];

  let targetVehicle = null;
  let donorVehicle = null;

  for (const pattern of targetPatterns) {
    const match = text.match(pattern);

    if (match) {
      targetVehicle = getCrossAppVehicleHint(match[1]);
      if (targetVehicle) break;
    }
  }

  for (const pattern of donorPatterns) {
    const match = text.match(pattern);

    if (match) {
      donorVehicle = getCrossAppVehicleHint(match[1]);
      if (donorVehicle) break;
    }
  }

  return { targetVehicle, donorVehicle };
}

function getCrossConfidence({ targetVehicle, donorVehicle, pieza }) {
  if (!targetVehicle || !donorVehicle) {
    return {
      nivel: "DATOS_INSUFICIENTES",
      misma_familia_motor: false,
      mensaje_base:
        "No identifiqué claramente ambos vehículos para comparar la aplicación.",
    };
  }

  const targetFamily = targetVehicle.familia_motor || null;
  const donorFamily = donorVehicle.familia_motor || null;
  const sameFamily = Boolean(targetFamily && donorFamily && targetFamily === donorFamily);

  if (sameFamily && MOTOR_FAMILY_STRONG_PARTS.has(pieza)) {
    return {
      nivel: "ALTA_PROBABILIDAD",
      misma_familia_motor: true,
      mensaje_base:
        "Comparten familia de motor, así que puede existir cruce de aplicación para esta pieza.",
    };
  }

  if (sameFamily && CHASSIS_SENSITIVE_PARTS.has(pieza)) {
    return {
      nivel: "POSIBLE_PERO_VALIDAR_MEDIDAS",
      misma_familia_motor: true,
      mensaje_base:
        "Comparten familia de motor, pero esta pieza puede variar por carrocería, transmisión, año o medidas físicas.",
    };
  }

  if (sameFamily) {
    return {
      nivel: "POSIBLE_POR_FAMILIA_MOTOR",
      misma_familia_motor: true,
      mensaje_base:
        "Comparten familia de motor, pero se debe validar aplicación exacta.",
    };
  }

  return {
    nivel: "NO_RECOMENDADO_SIN_VALIDACION",
    misma_familia_motor: false,
    mensaje_base:
      "No comparten la misma familia de motor registrada en la regla interna, así que no conviene asumir compatibilidad.",
  };
}

export function detectCrossApplicationComparison(question, directProductTerms = []) {
  const text = normalizeText(question);

  const hasCrossQuestion =
    /\bLE\s+PUEDO\s+PONER\b/.test(text) ||
    /\bPUEDO\s+PONER\b/.test(text) ||
    /\bSE\s+LE\s+PUEDE\s+PONER\b/.test(text) ||
    /\bLE\s+SIRVE\b/.test(text) ||
    /\bLE\s+QUEDA\b/.test(text) ||
    /\bSIRVE\s+PARA\b/.test(text) ||
    /\bCOMPATIBLE\s+CON\b/.test(text);

  if (!hasCrossQuestion) return null;

  const pieza = detectCoolingPart(question, directProductTerms);
  const { targetVehicle, donorVehicle } = extractCrossVehicles(question);

  if (!targetVehicle && !donorVehicle) return null;

  const confidence = getCrossConfidence({
    targetVehicle,
    donorVehicle,
    pieza,
  });

  return {
    activa: true,
    tipo: "CROSS_APPLICATION_COMPARISON",
    vehiculo_objetivo: targetVehicle,
    vehiculo_donante: donorVehicle,
    pieza,
    familia_motor_objetivo: targetVehicle?.familia_motor || null,
    familia_motor_donante: donorVehicle?.familia_motor || null,
    misma_familia_motor: confidence.misma_familia_motor,
    nivel_confianza: confidence.nivel,
    mensaje_base: confidence.mensaje_base,
    requiere_validacion_catalogo: true,
    regla_seguridad:
      "No confirmar compatibilidad final sin validar año, motor, código, aplicación registrada o muestra física.",
  };
}
