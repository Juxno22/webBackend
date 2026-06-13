import { getAiConfig } from "./aiConfig.service.js";
import { callOpenRouter } from "./aiOpenRouterClient.service.js";
import { buildIntentNormalizerMessages } from "./aiPromptBuilder.service.js";
import {
  cleanString,
  coerceBoolean,
  coerceConfidence,
  coerceStringArray,
  coerceYear,
  parseJsonObjectFromAi,
} from "./aiText.service.js";

function normalizeSemanticIntentPayload(payload) {
  if (!payload || typeof payload !== "object") return null;

  const preferencias = payload.preferencias || {};
  const vehiculo = payload.vehiculo || {};

  const legacyExclusions = Array.isArray(payload.exclusiones)
    ? coerceStringArray(payload.exclusiones)
    : [];

  const nestedExclusions =
    payload.exclusiones && typeof payload.exclusiones === "object"
      ? payload.exclusiones
      : {};

  const exclusionesVehiculo = [
    ...coerceStringArray(payload.exclusiones_vehiculo),
    ...coerceStringArray(nestedExclusions.vehiculo),
    ...coerceStringArray(nestedExclusions.aplicacion),
  ];

  const exclusionesMarcaProducto = [
    ...coerceStringArray(payload.exclusiones_marca_producto),
    ...coerceStringArray(nestedExclusions.marca_producto),
    ...coerceStringArray(nestedExclusions.producto),
    ...coerceStringArray(nestedExclusions.fabricante),
  ];

  return {
    pieza_normalizada: cleanString(payload.pieza_normalizada).toUpperCase() || null,

    // Legacy: por compatibilidad. Ya no lo usamos como principal.
    exclusiones: legacyExclusions,

    exclusiones_vehiculo: [...new Set(exclusionesVehiculo)].slice(0, 8),
    exclusiones_marca_producto: [...new Set(exclusionesMarcaProducto)].slice(0, 8),

    preferencias: {
      economica: coerceBoolean(preferencias.economica),
      no_original: coerceBoolean(preferencias.no_original),
      otra_marca: coerceBoolean(preferencias.otra_marca),
    },

    vehiculo: {
      marca_auto: cleanString(vehiculo.marca_auto).toUpperCase() || null,
      modelo_auto: cleanString(vehiculo.modelo_auto).toUpperCase() || null,
      anio: coerceYear(vehiculo.anio),
      motor: cleanString(vehiculo.motor).toUpperCase() || null,
    },

    tipo_busqueda:
      cleanString(payload.tipo_busqueda).toUpperCase() || "NO_DETERMINADO",
    confianza: coerceConfidence(payload.confianza),
    requiere_validacion: payload.requiere_validacion !== false,
  };
}

export async function normalizeUserIntentWithAi({
  question,
  localIntent = {},
} = {}) {
  const config = getAiConfig();

  if (!config.enabled || config.provider !== "openrouter" || !config.apiKey) {
    return {
      service: "LOCAL_ONLY",
      intent: null,
    };
  }

  try {
    const response = await callOpenRouter({
      messages: buildIntentNormalizerMessages({
        question,
        localIntent,
      }),
      config,
      temperature: 0,
      maxTokens: 320,
    });

    const parsed = parseJsonObjectFromAi(response);
    const normalized = normalizeSemanticIntentPayload(parsed);

    if (!normalized) {
      return {
        service: "OPENROUTER_INTENT_INVALID",
        intent: null,
      };
    }

    return {
      service: `OPENROUTER_INTENT:${config.model}`,
      intent: normalized,
    };
  } catch (error) {
    console.error("OpenRouter intent normalizer falló:", error.message);

    return {
      service: "OPENROUTER_INTENT_FAILED",
      intent: null,
    };
  }
}
