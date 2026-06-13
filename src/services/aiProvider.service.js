const DEFAULT_TIMEOUT_MS = 12000;

function cleanString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function boolFromEnv(value, defaultValue = false) {
  const clean = cleanString(value).toLowerCase();

  if (!clean) return defaultValue;

  return ["1", "true", "yes", "on", "si", "sí"].includes(clean);
}

function numberFromEnv(value, defaultValue) {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function getAiConfig() {
  return {
    enabled: boolFromEnv(process.env.AI_ENABLED, false),
    provider: cleanString(process.env.AI_PROVIDER || "openrouter").toLowerCase(),
    apiKey: cleanString(process.env.OPENROUTER_API_KEY),
    apiUrl:
      cleanString(process.env.OPENROUTER_API_URL) ||
      "https://openrouter.ai/api/v1/chat/completions",
    model: cleanString(process.env.OPENROUTER_MODEL) || "openrouter/free",
    siteUrl:
      cleanString(process.env.OPENROUTER_SITE_URL) ||
      "http://localhost:3000",
    siteName:
      cleanString(process.env.OPENROUTER_SITE_NAME) ||
      "Andyfers Smart Catalog",
    timeoutMs: numberFromEnv(process.env.AI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

function safeJsonParse(value) {
  try {
    if (!value) return null;
    if (typeof value === "object") return value;

    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractPayloadFromMessages(messages = []) {
  const userMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");

  return safeJsonParse(userMessage?.content);
}

function extractAllowedCodes(payload) {
  const products = Array.isArray(payload?.contexto_productos)
    ? payload.contexto_productos
    : [];

  return products
    .flatMap((product) => [
      product.codigo_andyfers,
      product.codigo_importacion,
      ...(Array.isArray(product.cruces)
        ? product.cruces.map((cruce) => cruce.numero_parte)
        : []),
    ])
    .map((code) => cleanString(code).toUpperCase())
    .filter(Boolean);
}

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

  // No bloquear años de vehículos.
  if (looksLikeYear(clean)) return false;

  // No bloquear motores o medidas.
  if (looksLikeMotorOrMeasure(raw)) return false;

  // Códigos Andyfers/importación típicos: AP137035T, AT19077, MGA5427.
  if (/^[A-Z]{1,6}\d[A-Z0-9]{2,}$/.test(clean)) return true;

  // Códigos numéricos largos. Evita años porque ya se filtraron arriba.
  if (/^\d{5,}$/.test(clean)) return true;

  return false;
}

function responseMentionsUnknownCode(response, allowedCodes) {
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

function cleanAiText(value) {
  return cleanString(value)
    .replace(/^```(?:json|txt|text|markdown)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function buildOpenRouterMessages(messages = []) {
  const payload = extractPayloadFromMessages(messages);
  const products = Array.isArray(payload?.contexto_productos)
    ? payload.contexto_productos
    : [];

  const strictSystem = [
    "Eres Andy-Bot, asistente comercial de refacciones de Andyfers.",
    "Tu trabajo es redactar una respuesta breve, clara y útil para cliente final.",
    "REGLA CRÍTICA: solo puedes usar los productos incluidos en CONTEXTO.",
    "No inventes códigos, piezas, compatibilidades, precios, stock, marcas ni aplicaciones.",
    "No recomiendes productos que no aparezcan en CONTEXTO.",
    "No diagnostiques como mecánico; solo orienta y pide validación.",
    "Si falta marca, modelo, año o motor, pide esos datos de forma natural.",
    "Siempre aclara que ventas valida compatibilidad y disponibilidad final.",
    "No uses formato JSON. Responde en español mexicano natural.",
    "Si intencion_detectada.excluded_tokens contiene una marca/modelo, no presentes como válida ninguna opción relacionada con esa marca/modelo.",
  ].join(" ");

  const compactPayload = {
    pregunta_cliente: payload?.pregunta_cliente || "",
    intencion_detectada: {
      marca_auto: payload?.intencion_detectada?.marca_auto || null,
      modelo_auto: payload?.intencion_detectada?.modelo_auto || null,
      anio: payload?.intencion_detectada?.anio || null,
      motor: payload?.intencion_detectada?.motor || null,
      modo_busqueda: payload?.intencion_detectada?.modo_busqueda || null,
      sintomas_detectados:
        payload?.intencion_detectada?.sintomas_detectados || [],
      condiciones_detectadas:
        payload?.intencion_detectada?.condiciones_detectadas || [],
      preferencias_comerciales:
        payload?.intencion_detectada?.preferencias_comerciales || {},
      contexto_sesion_aplicado:
        payload?.intencion_detectada?.contexto_sesion_aplicado || false,
      excluded_tokens: payload?.intencion_detectada?.excluded_tokens || [],
      has_negation: payload?.intencion_detectada?.has_negation || false,
    },
    contexto_productos: products.slice(0, 5).map((product) => ({
      codigo_andyfers: product.codigo_andyfers,
      codigo_importacion: product.codigo_importacion,
      descripcion: product.descripcion,
      familia: product.familia,
      categoria: product.categoria,
      compatibilidad_estimada: product.compatibilidad_estimada,
      razones_compatibilidad: product.razones_compatibilidad,
      aplicaciones: Array.isArray(product.aplicaciones)
        ? product.aplicaciones.slice(0, 4)
        : [],
      cruces: Array.isArray(product.cruces)
        ? product.cruces.slice(0, 4)
        : [],
    })),
  };

  return [
    {
      role: "system",
      content: strictSystem,
    },
    {
      role: "user",
      content: JSON.stringify(compactPayload, null, 2),
    },
  ];
}

async function callOpenRouter({
  messages,
  config,
  temperature = 0.25,
  maxTokens = 450,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.apiUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": config.siteUrl,
        "X-Title": config.siteName,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const message =
        data?.error?.message ||
        data?.message ||
        `OpenRouter respondió HTTP ${response.status}`;

      const error = new Error(message);
      error.status = response.status;
      throw error;
    }

    const content = data?.choices?.[0]?.message?.content;

    return cleanAiText(content);
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonObjectFromAi(value) {
  const clean = cleanAiText(value);

  if (!clean) return null;

  const direct = safeJsonParse(clean);
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return direct;
  }

  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;

  const parsed = safeJsonParse(match[0]);

  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : null;
}

function coerceStringArray(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => cleanString(item).toUpperCase())
    .filter(Boolean)
    .slice(0, 8);
}

function coerceBoolean(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function coerceConfidence(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) return 0;

  return Math.max(0, Math.min(1, number));
}

function coerceYear(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) return null;
  if (number < 1900 || number > 2049) return null;

  return number;
}

function normalizeSemanticIntentPayload(payload) {
  if (!payload || typeof payload !== "object") return null;

  const preferencias = payload.preferencias || {};
  const vehiculo = payload.vehiculo || {};

  return {
    pieza_normalizada: cleanString(payload.pieza_normalizada).toUpperCase() || null,
    exclusiones: coerceStringArray(payload.exclusiones),
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

function buildIntentNormalizerMessages({ question, localIntent }) {
  return [
    {
      role: "system",
      content: [
        "Eres un normalizador semántico para un buscador de refacciones.",
        "Tu única tarea es convertir la petición del cliente en JSON estructurado.",
        "No recomiendes productos.",
        "No inventes códigos.",
        "No inventes compatibilidades.",
        "No respondas al cliente.",
        "Interpreta lenguaje natural, sinónimos, negaciones, exclusiones y preferencias.",
        "Si el cliente pide 'otra marca', 'distinta a', 'diferente a', 'excepto', 'no sea', 'no pertenezca', 'no provenga', 'no producida por', debes llenar exclusiones.",
        "Si el cliente pide 'bomba' y el contexto sugiere sistema de agua/enfriamiento, normaliza como BOMBA DE AGUA.",
        "Responde únicamente JSON válido, sin markdown.",
        "Formato obligatorio:",
        JSON.stringify({
          pieza_normalizada: null,
          exclusiones: [],
          preferencias: {
            economica: false,
            no_original: false,
            otra_marca: false,
          },
          vehiculo: {
            marca_auto: null,
            modelo_auto: null,
            anio: null,
            motor: null,
          },
          tipo_busqueda: "NO_DETERMINADO",
          confianza: 0,
          requiere_validacion: true,
        }),
      ].join(" "),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          pregunta_cliente: question,
          intencion_local_previa: {
            pieza_detectada: localIntent?.terminos_producto_detectados || [],
            tokens: localIntent?.tokens || [],
            excluded_tokens: localIntent?.excluded_tokens || [],
            marca_auto: localIntent?.marca_auto || null,
            modelo_auto: localIntent?.modelo_auto || null,
            anio: localIntent?.anio || null,
            motor: localIntent?.motor || null,
            preferencias_comerciales:
              localIntent?.preferencias_comerciales || {},
          },
        },
        null,
        2
      ),
    },
  ];
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

export async function generateAiAnswer({ messages = [] } = {}) {
  const config = getAiConfig();

  if (!config.enabled) {
    return {
      service: "LOCAL_CONTROLADO",
      response: null,
    };
  }

  if (config.provider !== "openrouter") {
    return {
      service: "LOCAL_CONTROLADO",
      response: null,
    };
  }

  if (!config.apiKey) {
    console.warn("OPENROUTER_API_KEY no está configurada. Se usará respuesta local.");

    return {
      service: "LOCAL_CONTROLADO",
      response: null,
    };
  }

  const payload = extractPayloadFromMessages(messages);
  const allowedCodes = extractAllowedCodes(payload);
  const openRouterMessages = buildOpenRouterMessages(messages);

  try {
    const response = await callOpenRouter({
      messages: openRouterMessages,
      config,
    });

    if (!response) {
      return {
        service: "LOCAL_CONTROLADO",
        response: null,
      };
    }

    if (responseMentionsUnknownCode(response, allowedCodes)) {
      console.warn(
        "OpenRouter mencionó un código fuera del contexto. Se descartó la respuesta externa."
      );

      return {
        service: "LOCAL_CONTROLADO_VALIDATED",
        response: null,
      };
    }

    return {
      service: `OPENROUTER:${config.model}`,
      response,
    };
  } catch (error) {
    console.error("OpenRouter falló:", error.message);

    return {
      service: "LOCAL_CONTROLADO",
      response: null,
    };
  }
}