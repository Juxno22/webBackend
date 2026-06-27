import {
  normalizePartNumber,
  normalizeSearchQuery,
  normalizeText,
  clampNumber,
} from "../../utils/normalize.js";
import {
  attributeMatchesMeasurement,
  describeMeasurementFilters,
} from "./catalogMeasurements.service.js";
import {
  buildApplicationMotorLabel,
  normalizeMotorSearchValue,
} from "../../utils/applicationMotor.js";

function includesNormalized(haystack, needle) {
  const normalizedHaystack = normalizeSearchQuery(haystack);
  const normalizedNeedle = normalizeSearchQuery(needle);

  return Boolean(normalizedNeedle && normalizedHaystack.includes(normalizedNeedle));
}

function buildApplicationMotorSearchText(app = {}) {
  return [
    app.motor,
    app.cilindraje,
    app.motor_detalle,
    app.motor_original,
    app.motor_label,
    buildApplicationMotorLabel(app),
  ]
    .filter(Boolean)
    .join(" ");
}

export function scoreCandidate(row, intent, details) {
  let score = 25;
  const reasons = [];

  const prioridad = Number(row.prioridad_ia || 0);

  if (prioridad > 0) {
    score += Math.min(prioridad, 15);
    reasons.push("Producto con prioridad interna para IA.");
  }

  const searchableText = [
    row.codigo_andyfers,
    row.codigo_importacion,
    row.categoria,
    row.armadora,
    row.familia,
    row.descripcion,
    row.descripcion_web,
  ].join(" ");

  const strictFamilyMatches = Array.isArray(intent.strict_product_family_tokens)
    ? intent.strict_product_family_tokens.filter((token) => {
      const familyText = normalizeSearchQuery(row.familia);
      const categoryText = normalizeSearchQuery(row.categoria);
      const normalizedToken = normalizeSearchQuery(token);

      return (
        normalizedToken &&
        (familyText.includes(normalizedToken) || categoryText.includes(normalizedToken))
      );
    })
    : [];

  if (strictFamilyMatches.length) {
    score += 35;
    reasons.push(
      `Coincide con familia/categoría solicitada: ${strictFamilyMatches
        .slice(0, 3)
        .join(", ")}.`
    );
  }

  const matchedTokens = intent.tokens.filter((token) =>
    includesNormalized(searchableText, token)
  );

  if (matchedTokens.length) {
    score += Math.min(matchedTokens.length * 6, 30);
    reasons.push(
      `Coincide con términos de búsqueda: ${matchedTokens
        .slice(0, 4)
        .join(", ")}.`
    );
  }

  const measurementFilters = Array.isArray(intent.medidas_detectadas)
    ? intent.medidas_detectadas
    : [];

  if (measurementFilters.length) {
    const atributos = details.atributos || [];
    const matchedMeasurements = measurementFilters.filter((measurement) =>
      atributos.some((attribute) => attributeMatchesMeasurement(attribute, measurement))
    );

    if (matchedMeasurements.length) {
      score += Math.min(matchedMeasurements.length * 28, 42);
      reasons.push(`Coincide con medida solicitada: ${describeMeasurementFilters(matchedMeasurements)}.`);
    }
  }

  const normalizedCodes = [
    normalizePartNumber(row.codigo_andyfers),
    normalizePartNumber(row.codigo_importacion),
  ];

  const codeMatched = intent.numero_parte_tokens.find((token) =>
    normalizedCodes.some((code) => code && code.includes(token))
  );

  if (codeMatched) {
    score += 35;
    reasons.push("Coincide con código o número de parte capturado.");
  }

  const cruces = details.cruces || [];

  const cruceMatched = intent.numero_parte_tokens.find((token) =>
    cruces.some((cruce) =>
      String(cruce.numero_parte_normalizado || "").includes(token)
    )
  );

  if (cruceMatched) {
    score += 40;
    reasons.push("Coincide con un cruce registrado en la base.");
  }

  const aplicaciones = details.aplicaciones || [];

  if (intent.marca_auto) {
    const marcaOk = aplicaciones.some((app) =>
      includesNormalized(app.marca_auto, intent.marca_auto)
    );

    if (marcaOk) {
      score += 14;
      reasons.push(`Coincide con marca de vehículo: ${intent.marca_auto}.`);
    }
  }

  if (intent.modelo_auto) {
    const modeloOk = aplicaciones.some((app) =>
      includesNormalized(app.modelo_auto, intent.modelo_auto)
    );

    if (modeloOk) {
      score += 18;
      reasons.push(`Coincide con modelo: ${intent.modelo_auto}.`);
    }
  }

  if (intent.motor) {
    const normalizedMotor = normalizeMotorSearchValue(intent.motor) || intent.motor;

    const motorOk = aplicaciones.some((app) => {
      const motorText = buildApplicationMotorSearchText(app);

      return (
        includesNormalized(motorText, normalizedMotor) ||
        includesNormalized(motorText, intent.motor)
      );
    });

    if (motorOk) {
      score += 12;
      reasons.push(`Coincide con motor/cilindraje detectado: ${intent.motor}.`);
    }
  }

  if (intent.anio) {
    const yearOk = aplicaciones.some((app) => {
      const start = Number(app.anio_inicio || intent.anio);
      const end = Number(app.anio_fin || intent.anio);

      return intent.anio >= start && intent.anio <= end;
    });

    if (yearOk) {
      score += 16;
      reasons.push(`El año ${intent.anio} cae dentro de una aplicación registrada.`);
    }
  }

  const stock = Number(row.stock_total_web || 0);

  if (stock > 0) {
    score += 4;
    reasons.push("Tiene stock web de referencia.");
  }

  if (!reasons.length) {
    reasons.push("Coincidencia general por descripción, familia o armadora.");
  }

  return {
    score: clampNumber(Math.round(score), 1, 100),
    reasons: reasons.slice(0, 6),
  };
}

export function formatCandidate(row, scoreData, details) {
  const aplicaciones = (details.aplicaciones || []).slice(0, 5).map((app) => ({
    marca_auto: app.marca_auto,
    modelo_auto: app.modelo_auto,
    motor: app.motor,
    cilindraje: app.cilindraje,
    motor_detalle: app.motor_detalle,
    motor_original: app.motor_original,
    motor_label: app.motor_label || buildApplicationMotorLabel(app),
    anio_inicio: app.anio_inicio,
    anio_fin: app.anio_fin,
    version_auto: app.version_auto,
  }));

  const cruces = (details.cruces || []).slice(0, 8).map((cruce) => ({
    marca: cruce.marca,
    numero_parte: cruce.numero_parte,
  }));

  const atributos = (details.atributos || []).slice(0, 8).map((attr) => ({
    atributo: attr.atributo,
    atributo_normalizado: attr.atributo_normalizado,
    valor: attr.valor_texto,
    valor_numero: attr.valor_numero,
    unidad: attr.unidad,
  }));

  return {
    id: row.id,
    producto_id: row.id,
    codigo_andyfers: row.codigo_andyfers,
    codigo_importacion: row.codigo_importacion,
    imagen_url: row.imagen_url,
    categoria: row.categoria,
    armadora: row.armadora,
    familia: row.familia,
    descripcion: row.descripcion,
    descripcion_web: row.descripcion_web,
    marca_producto: row.marca_producto,
    marca_producto_confirmada: row.marca_producto_confirmada,
    marca_producto_confirmada: Boolean(row.marca_producto_confirmada),
    prioridad_ia: Number(row.prioridad_ia || 0),
    stock_total_web: Number(row.stock_total_web || 0),
    precio_minimo: row.precio_minimo,
    total_cruces: Number(row.total_cruces || 0),
    compatibilidad_estimada: scoreData.score,
    razones_compatibilidad: scoreData.reasons,
    aplicaciones,
    cruces,
    atributos,
  };
}


export function compareCandidatesByIntent(intent) {
  return (a, b) => {
    const preferEconomic = intent.preferencias_comerciales?.economica;

    if (preferEconomic) {
      const priceA = Number(a.precio_minimo || 0);
      const priceB = Number(b.precio_minimo || 0);

      const hasPriceA = priceA > 0;
      const hasPriceB = priceB > 0;

      if (hasPriceA && hasPriceB && priceA !== priceB) {
        return priceA - priceB;
      }

      if (hasPriceA && !hasPriceB) return -1;
      if (!hasPriceA && hasPriceB) return 1;
    }

    if (b.compatibilidad_estimada !== a.compatibilidad_estimada) {
      return b.compatibilidad_estimada - a.compatibilidad_estimada;
    }

    return Number(b.prioridad_ia || 0) - Number(a.prioridad_ia || 0);
  };
}


export function productMatchesExcluded(product = {}, intent = {}) {
  const excludedTokens = Array.isArray(intent.excluded_vehicle_tokens)
    ? intent.excluded_vehicle_tokens
    : Array.isArray(intent.excluded_tokens)
      ? intent.excluded_tokens
      : [];

  if (!excludedTokens.length) return false;

  const text = normalizeText(
    [
      product.codigo_andyfers,
      product.codigo_importacion,
      product.categoria,
      product.armadora,
      product.familia,
      product.descripcion,
      product.descripcion_web,
      ...(Array.isArray(product.aplicaciones)
        ? product.aplicaciones.flatMap((app) => [
          app.marca_auto,
          app.modelo_auto,
          app.version_auto,
          app.motor,
          app.cilindraje,
          app.motor_detalle,
          app.motor_original,
          app.motor_label,
        ])
        : []),
      ...(Array.isArray(product.cruces)
        ? product.cruces.flatMap((cruce) => [
          cruce.marca,
          cruce.numero_parte,
        ])
        : []),
    ].join(" ")
  );

  return excludedTokens.some((excluded) => {
    const cleanExcluded = normalizeText(excluded);

    return cleanExcluded && text.includes(cleanExcluded);
  });
}

