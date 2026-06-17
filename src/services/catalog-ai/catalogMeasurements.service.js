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

function uniqueByKey(items = [], keyFn) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = keyFn(item);

    if (seen.has(key)) continue;

    seen.add(key);
    result.push(item);
  }

  return result;
}

function finalizeMeasurementFilters(filters = []) {
  return uniqueByKey(
    filters
      .filter((item) => item.tipo === "TEXT_ATTRIBUTE" || Number.isFinite(Number(item.valor_numero)))
      .sort((a, b) => Number(b.prioridad || 0) - Number(a.prioridad || 0)),
    (item) =>
      item.tipo === "TEXT_ATTRIBUTE"
        ? `${item.tipo}:${item.atributo_normalizado}:${item.valor_normalizado}`
        : `${item.tipo}:${item.atributo_normalizado}:${item.valor_numero}:${item.unidad}`
  ).slice(0, 12);
}

function normalizePrettyNumber(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) return String(value || "");

  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(3)));
}

function makeNumericFilter({
  atributo_normalizado,
  atributo_label,
  valor_numero,
  unidad = "mm",
  original = "",
  tolerancia = 0.75,
  aplicar_filtro = true,
  prioridad = 50,
  contexto = "POLEA",
}) {
  return {
    tipo: "NUMERIC_ATTRIBUTE",
    contexto,
    atributo_normalizado: normalizeText(atributo_normalizado),
    atributo_label,
    valor_numero: Number(Number(valor_numero).toFixed(3)),
    unidad,
    tolerancia,
    original,
    aplicar_filtro,
    prioridad,
  };
}

function makeTextFilter({
  atributo_normalizado,
  atributo_label,
  valor_texto,
  original = "",
  aplicar_filtro = false,
  prioridad = 20,
  contexto = "POLEA",
}) {
  return {
    tipo: "TEXT_ATTRIBUTE",
    contexto,
    atributo_normalizado: normalizeText(atributo_normalizado),
    atributo_label,
    valor_texto: String(valor_texto || "").trim(),
    valor_normalizado: normalizeText(valor_texto),
    original,
    aplicar_filtro,
    prioridad,
  };
}

function addMeasurementMatches({ text, filters, patterns, atributo_normalizado, atributo_label, tolerancia = 0.75, aplicar_filtro = true, prioridad = 50 }) {
  for (const pattern of patterns) {
    let match;

    while ((match = pattern.exec(text)) !== null) {
      const value = match.groups?.value || match[1];
      const unit = match.groups?.unit || match[2] || "MM";
      const mm = toMillimeters(value, unit);

      if (!Number.isFinite(mm)) continue;

      filters.push(
        makeNumericFilter({
          atributo_normalizado,
          atributo_label,
          valor_numero: mm,
          unidad: "mm",
          original: match[0],
          tolerancia,
          aplicar_filtro,
          prioridad,
        })
      );
    }
  }
}

function detectCapMeasurements(text, filters) {
  const pressurePatterns = [
    /\b(?<value>\d{1,3}(?:[.,]\d{1,2})?)\s*(?<unit>PSI|LIBRAS?)\b/g,
    /\bPRESION\s+(?:DE\s+)?(?<value>\d{1,3}(?:[.,]\d{1,2})?)\s*(?<unit>PSI|LIBRAS?)\b/g,
    /\bPRESIÓN\s+(?:DE\s+)?(?<value>\d{1,3}(?:[.,]\d{1,2})?)\s*(?<unit>PSI|LIBRAS?)\b/g,
  ];

  for (const pattern of pressurePatterns) {
    let match;

    while ((match = pattern.exec(text)) !== null) {
      const value = cleanNumber(match.groups?.value || match[1]);

      if (!Number.isFinite(value)) continue;

      filters.push(
        makeNumericFilter({
          atributo_normalizado: "PRESION",
          atributo_label: "presión",
          valor_numero: value,
          unidad: "PSI",
          original: match[0],
          tolerancia: 0,
          aplicar_filtro: true,
          prioridad: 105,
          contexto: "TAPON",
        })
      );
    }
  }

  addMeasurementMatches({
    text,
    filters,
    atributo_normalizado: "DIAMETRO",
    atributo_label: "diámetro",
    aplicar_filtro: true,
    prioridad: 95,
    tolerancia: 0.75,
    patterns: [
      /\b(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\s+DE\s+DIAMETRO\b/g,
      /\bDIAMETRO\s+(?:DE\s+)?(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
      /\bDIÁMETRO\s+(?:DE\s+)?(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
    ],
  });
}

function detectPulleyKind(text, filters) {
  const typeRules = [
    { pattern: /\bPOLEA\s+TENSORA\b/, value: "tensora" },
    { pattern: /\bPOLEA\s+LOCA\b/, value: "loca" },
    { pattern: /\bPOLEA\s+ARMONICA\b|\bPOLEA\s+ARMÓNICA\b|\bAMORTIGUADORA\b/, value: "armónica / amortiguadora" },
    { pattern: /\bPOLEA\s+DE\s+CIGUEÑAL\b|\bPOLEA\s+PARA\s+CIGUEÑAL\b|\bCIGUEÑAL\b|\bCIGÜEÑAL\b/, value: "cigüeñal" },
    { pattern: /\bPOLEA\s+DE\s+ALTERNADOR\b|\bPOLEA\s+PARA\s+ALTERNADOR\b|\bALTERNADOR\b/, value: "alternador" },
    { pattern: /\bDIRECCION\s+HIDRAULICA\b|\bDIRECCIÓN\s+HIDRÁULICA\b/, value: "dirección hidráulica" },
    { pattern: /\bCOMPRESOR\b|\bA\/C\b|\bAC\b/, value: "compresor A/C" },
    { pattern: /\bWATER\s+PUMP\b|\bBOMBA\s+DE\s+AGUA\b|\bBOMBA\s+AGUA\b/, value: "bomba de agua" },
    { pattern: /\bOVERDRIVE\b/, value: "overdrive" },
    { pattern: /\bUNDERDRIVE\b/, value: "underdrive" },
    { pattern: /\bESCALONADA\b/, value: "escalonada" },
    { pattern: /\bMODULAR\b|\bMODULARES\b|\bINTERCAMBIABLES\b/, value: "modular intercambiable" },
  ];

  for (const rule of typeRules) {
    if (rule.pattern.test(text)) {
      filters.push(
        makeTextFilter({
          atributo_normalizado: "TIPO POLEA",
          atributo_label: "tipo de polea",
          valor_texto: rule.value,
          original: rule.value,
          aplicar_filtro: false,
          prioridad: 30,
        })
      );
    }
  }
}

function detectBeltType(text, filters) {
  const rules = [
    { pattern: /\bPOLI\s*V\b|\bPOLI-V\b|\bPOLY\s*V\b/, value: "poli-V" },
    { pattern: /\bRANURA\s+EN\s+V\b|\bCANALES?\s+EN\s+V\b|\bCORREA\s+EN\s+V\b/, value: "V" },
    { pattern: /\bHTD\b/, value: "HTD" },
    { pattern: /\bCORREA\s+DENTADA\b|\bDENTADA\b/, value: "dentada" },
    { pattern: /\bRANURA\s+TIPO\s+'?P'?\b|\bTIPO\s+P\b/, value: "P" },
  ];

  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      filters.push(
        makeTextFilter({
          atributo_normalizado: "TIPO CORREA",
          atributo_label: "tipo de correa",
          valor_texto: rule.value,
          original: rule.value,
          aplicar_filtro: false,
          prioridad: 25,
        })
      );
    }
  }
}

function detectMaterials(text, filters) {
  const materialRules = [
    { pattern: /\bACERO\b/, value: "acero" },
    { pattern: /\bALUMINIO\b/, value: "aluminio" },
    { pattern: /\bNYLON\b/, value: "nylon" },
  ];

  for (const rule of materialRules) {
    if (rule.pattern.test(text)) {
      filters.push(
        makeTextFilter({
          atributo_normalizado: "MATERIAL",
          atributo_label: "material",
          valor_texto: rule.value,
          original: rule.value,
          aplicar_filtro: false,
          prioridad: 20,
        })
      );
    }
  }
}

function detectChannels(text, filters) {
  const channelPatterns = [
    /\b(?<value>\d{1,2})\s*CANALES?\b/g,
    /\b(?<value>\d{1,2})\s*RANURAS?\b/g,
    /\b(?<value>\d{1,2})\s*COSTILLAS?\b/g,
  ];

  for (const pattern of channelPatterns) {
    let match;

    while ((match = pattern.exec(text)) !== null) {
      const channels = cleanNumber(match.groups?.value || match[1]);

      if (!Number.isFinite(channels)) continue;

      filters.push(
        makeNumericFilter({
          atributo_normalizado: "CANALES",
          atributo_label: "canales / ranuras",
          valor_numero: channels,
          unidad: "canales",
          original: match[0],
          tolerancia: 0,
          aplicar_filtro: true,
          prioridad: 85,
        })
      );
    }
  }
}

function detectMounting(text, filters) {
  const boltPatterns = [
    /\b(?<value>\d{1,2})\s*TORNILLOS?\b/g,
    /\b(?<value>\d{1,2})\s*PERNOS?\b/g,
  ];

  for (const pattern of boltPatterns) {
    let match;

    while ((match = pattern.exec(text)) !== null) {
      const value = cleanNumber(match.groups?.value || match[1]);

      if (!Number.isFinite(value)) continue;

      filters.push(
        makeNumericFilter({
          atributo_normalizado: "TORNILLOS MONTAJE",
          atributo_label: "tornillos/pernos de montaje",
          valor_numero: value,
          unidad: "pzas",
          original: match[0],
          tolerancia: 0,
          aplicar_filtro: false,
          prioridad: 25,
        })
      );
    }
  }

  addMeasurementMatches({
    text,
    filters,
    atributo_normalizado: "CIRCULO PERNOS",
    atributo_label: "círculo de pernos",
    aplicar_filtro: false,
    prioridad: 25,
    patterns: [
      /\bFIJACION\s+DE\s+\d{1,2}\s*PERNOS?\s+EN\s+(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\s+DE\s+CIRCULO\b/g,
      /\bCIRCULO\s+DE\s+PERNOS?\s+DE\s+(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
    ],
  });
}

function detectBearings(text, filters) {
  const bearingPatterns = [
    /\bRODAMIENTO\s+(?:DE\s+)?(?<value>\d{3,5}[A-Z0-9]*)\b/g,
    /\bBALERO\s+(?:DE\s+)?(?<value>\d{3,5}[A-Z0-9]*)\b/g,
    /\bBEARING\s+(?:DE\s+)?(?<value>\d{3,5}[A-Z0-9]*)\b/g,
  ];

  for (const pattern of bearingPatterns) {
    let match;

    while ((match = pattern.exec(text)) !== null) {
      filters.push(
        makeTextFilter({
          atributo_normalizado: "RODAMIENTO",
          atributo_label: "rodamiento",
          valor_texto: match.groups?.value || match[1],
          original: match[0],
          aplicar_filtro: false,
          prioridad: 25,
        })
      );
    }
  }
}

export function isMeasurementLikePartToken(value) {
  const raw = String(value || "").trim().toUpperCase();

  if (!raw) return false;

  return (
    /^\d+(?:[.,]\d+)?\s*(MM|CM|IN|PULG|PULGADA|PULGADAS|MILIMETROS|MILÍMETROS|CENTIMETROS|CENTÍMETROS)$/i.test(raw) ||
    /^\d+(?:[.,]\d+)?"$/.test(raw)
  );
}

export function getMeasurementAttributeAliases(attributeName) {
  const key = normalizeText(attributeName);

  const aliasMap = {
    DIAMETRO: ["DIAMETRO", "DIAMETRO EXTERIOR", "DIAMETRO POLEA"],
    "DIAMETRO EXTERIOR": ["DIAMETRO EXTERIOR", "DIAMETRO", "DIAMETRO POLEA"],
    "DIAMETRO INTERIOR": ["DIAMETRO INTERIOR", "DIAMETRO BUJE", "BUJE", "EJE"],
    "DIAMETRO BUJE": ["DIAMETRO BUJE", "DIAMETRO INTERIOR", "BUJE", "EJE"],
    "DIAMETRO MAYOR": ["DIAMETRO MAYOR", "DIAMETRO", "DIAMETRO EXTERIOR"],
    "DIAMETRO MENOR": ["DIAMETRO MENOR", "DIAMETRO", "DIAMETRO EXTERIOR"],
    ANCHO: ["ANCHO", "ANCHO TOTAL", "ANCHO DE PISTA", "ANCHO PISTA"],
    "ANCHO TOTAL": ["ANCHO TOTAL", "ANCHO", "ANCHO DE PISTA"],
    "ANCHO DE PISTA": ["ANCHO DE PISTA", "ANCHO PISTA", "ANCHO"],
    "SEPARACION ENTRE PISTAS": ["SEPARACION ENTRE PISTAS", "DISTANCIA ENTRE PISTAS"],
    "DISTANCIA ENTRE CENTROS": ["DISTANCIA ENTRE CENTROS", "CENTROS"],
    EJE: ["EJE", "DIAMETRO EJE", "DIAMETRO INTERIOR"],
    EXCENTRICIDAD: ["EXCENTRICIDAD"],
    PASO: ["PASO", "PASO DENTADO"],
    CANALES: ["CANALES", "RANURAS", "COSTILLAS", "NUMERO_CANALES", "NUMERO CANALES"],
    "TORNILLOS MONTAJE": ["TORNILLOS MONTAJE", "PERNOS MONTAJE", "TORNILLOS", "PERNOS"],
    "CIRCULO PERNOS": ["CIRCULO PERNOS", "CIRCULO DE PERNOS", "PCD"],
    PRESION: ["PRESION", "PRESIÓN", "PSI", "LIBRAS"],
    PSI: ["PSI", "PRESION", "PRESIÓN", "LIBRAS"],
  };

  return aliasMap[key] || [key];
}

export function detectMeasurementFilters(question) {
  const text = normalizeText(question);
  const hasPulleyIntent =
    /\bPOLEA\b|\bPOLEAS\b|\bPULLEY\b|\bPULLEYS\b/.test(text);
  const hasCapIntent =
    (/\bTAPON\b|\bTAPÓN\b/.test(text) && (/\bRADIADOR\b|\bDEPOSITO\b|\bDEPÓSITO\b/.test(text))) ||
    (/\bPSI\b|\bLIBRAS\b/.test(text) && (/\bTAPON\b|\bTAPÓN\b/.test(text)));

  if (!hasPulleyIntent && !hasCapIntent) return [];

  const filters = [];

  if (hasCapIntent) {
    detectCapMeasurements(text, filters);
  }

  if (!hasPulleyIntent) {
    return finalizeMeasurementFilters(filters);
  }

  detectPulleyKind(text, filters);
  detectBeltType(text, filters);
  detectMaterials(text, filters);
  detectChannels(text, filters);
  detectMounting(text, filters);
  detectBearings(text, filters);

  addMeasurementMatches({
    text,
    filters,
    atributo_normalizado: "DIAMETRO EXTERIOR",
    atributo_label: "diámetro exterior",
    aplicar_filtro: true,
    prioridad: 100,
    patterns: [
      /\bDIAMETRO\s+EXTERIOR\s+(?:DE\s+)?(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
      /\bDIÁMETRO\s+EXTERIOR\s+(?:DE\s+)?(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
    ],
  });

  addMeasurementMatches({
    text,
    filters,
    atributo_normalizado: "DIAMETRO MAYOR",
    atributo_label: "diámetro mayor",
    aplicar_filtro: true,
    prioridad: 90,
    patterns: [
      /\bDIAMETRO\s+MAYOR\s+(?:DE\s+)?(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
      /\bMAYOR\s+(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
    ],
  });

  addMeasurementMatches({
    text,
    filters,
    atributo_normalizado: "DIAMETRO MENOR",
    atributo_label: "diámetro menor",
    aplicar_filtro: true,
    prioridad: 90,
    patterns: [
      /\bDIAMETRO\s+MENOR\s+(?:DE\s+)?(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
      /\bMENOR\s+(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
    ],
  });

  addMeasurementMatches({
    text,
    filters,
    atributo_normalizado: "DIAMETRO",
    atributo_label: "diámetro",
    aplicar_filtro: true,
    prioridad: 95,
    patterns: [
      /\b(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\s+DE\s+DIAMETRO\b/g,
      /\bDIAMETRO\s+(?:DE\s+)?(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
      /\bDIÁMETRO\s+(?:DE\s+)?(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
    ],
  });

  addMeasurementMatches({
    text,
    filters,
    atributo_normalizado: "ANCHO TOTAL",
    atributo_label: "ancho total",
    aplicar_filtro: true,
    prioridad: 75,
    patterns: [
      /\bANCHO\s+TOTAL\s+(?:DE\s+)?(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
    ],
  });

  addMeasurementMatches({
    text,
    filters,
    atributo_normalizado: "ANCHO",
    atributo_label: "ancho",
    aplicar_filtro: true,
    prioridad: 70,
    patterns: [
      /\bANCHO\s+(?:DE\s+)?(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
      /\b(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\s+DE\s+ANCHO\b/g,
    ],
  });

  addMeasurementMatches({
    text,
    filters,
    atributo_normalizado: "ANCHO DE PISTA",
    atributo_label: "ancho de ranura/pista",
    aplicar_filtro: true,
    prioridad: 65,
    patterns: [
      /\bRANURA\s+(?:EN\s+V\s+)?(?:DE\s+)?(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
      /\bCANALES?\s+EN\s+V\s+\(?(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\s+CADA\s+UNO\)?/g,
      /\bCORREA\s+DE\s+(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
    ],
  });

  addMeasurementMatches({
    text,
    filters,
    atributo_normalizado: "SEPARACION ENTRE PISTAS",
    atributo_label: "separación entre pistas",
    aplicar_filtro: false,
    prioridad: 40,
    patterns: [
      /\bSEPARACION\s+ENTRE\s+PISTAS\s+DE\s+(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
      /\bSEPARACIÓN\s+ENTRE\s+PISTAS\s+DE\s+(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
    ],
  });

  addMeasurementMatches({
    text,
    filters,
    atributo_normalizado: "DISTANCIA ENTRE CENTROS",
    atributo_label: "distancia entre centros",
    aplicar_filtro: false,
    prioridad: 40,
    patterns: [
      /\bDISTANCIA\s+ENTRE\s+CENTROS\s+DE\s+(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
    ],
  });

  addMeasurementMatches({
    text,
    filters,
    atributo_normalizado: "EJE",
    atributo_label: "eje",
    aplicar_filtro: true,
    prioridad: 60,
    patterns: [
      /\bEJE\s+(?:DE\s+)?(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
    ],
  });

  addMeasurementMatches({
    text,
    filters,
    atributo_normalizado: "DIAMETRO BUJE",
    atributo_label: "diámetro interior del buje",
    aplicar_filtro: true,
    prioridad: 60,
    patterns: [
      /\bDIAMETRO\s+INTERIOR\s+DEL\s+BUJE\s+DE\s+(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
      /\bDIÁMETRO\s+INTERIOR\s+DEL\s+BUJE\s+DE\s+(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
    ],
  });

  addMeasurementMatches({
    text,
    filters,
    atributo_normalizado: "EXCENTRICIDAD",
    atributo_label: "excentricidad",
    aplicar_filtro: false,
    prioridad: 35,
    patterns: [
      /\bEXCENTRICIDAD\s+DE\s+(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
    ],
  });

  addMeasurementMatches({
    text,
    filters,
    atributo_normalizado: "PASO",
    atributo_label: "paso de correa",
    aplicar_filtro: false,
    prioridad: 35,
    patterns: [
      /\b(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\s+DE\s+PASO\b/g,
      /\bPASO\s+DE\s+(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
    ],
  });

  // Fallback controlado:
  // si solo escribió "polea 70mm" o "polea de 70 mm", lo tratamos como diámetro.
  const alreadyHasDiameter = filters.some((item) =>
    ["DIAMETRO", "DIAMETRO EXTERIOR", "DIAMETRO MAYOR", "DIAMETRO MENOR"].includes(item.atributo_normalizado)
  );

  if (!alreadyHasDiameter) {
    addMeasurementMatches({
      text,
      filters,
      atributo_normalizado: "DIAMETRO",
      atributo_label: "diámetro",
      aplicar_filtro: true,
      prioridad: 80,
      patterns: [
        /\bPOLEA\s+(?:DE\s+)?(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
        /\b(?<value>\d{1,3}(?:[.,]\d{1,3})?)\s*(?<unit>MM|MILIMETROS|MILÍMETROS|CM|PULGADAS?|IN|")\b/g,
      ],
    });
  }

  return finalizeMeasurementFilters(filters);
}

export function attributeMatchesMeasurement(attribute = {}, measurement = {}) {
  const attributeName = normalizeText(attribute.atributo_normalizado || attribute.atributo);
  const expectedNames = getMeasurementAttributeAliases(measurement.atributo_normalizado)
    .map((item) => normalizeText(item));

  if (!attributeName || !expectedNames.includes(attributeName)) return false;

  if (measurement.tipo === "TEXT_ATTRIBUTE") {
    const attributeValue = normalizeText(attribute.valor_normalizado || attribute.valor_texto);

    return Boolean(
      measurement.valor_normalizado &&
      attributeValue &&
      attributeValue.includes(measurement.valor_normalizado)
    );
  }

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
      if (filter.tipo === "TEXT_ATTRIBUTE") {
        return `${filter.atributo_label || filter.atributo_normalizado}: ${filter.valor_texto}`;
      }

      const value = normalizePrettyNumber(filter.valor_numero);

      return `${filter.atributo_label || filter.atributo_normalizado} ${value} ${filter.unidad || ""}`.trim();
    })
    .filter(Boolean)
    .join(", ");
}