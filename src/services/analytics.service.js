import crypto from "crypto";
import { pool } from "../config/db.js";

export const ANALYTICS_EVENTOS_VALIDOS = new Set([
  "BUSQUEDA_CATALOGO",
  "BUSQUEDA_CATALOGO_SIN_RESULTADO",
  "BUSQUEDA_IA",
  "BUSQUEDA_IA_SIN_RESULTADO",
  "PRODUCTO_CONSULTADO",
  "PRODUCTO_AGREGADO_CARRITO",
  "PRODUCTO_AGREGADO_COTIZACION",
  "COTIZACION_GENERADA",
  "WHATSAPP_CLICK",
  "CONTACTO_FORMULARIO",
]);

function cleanString(value, maxLength = 320) {
  if (value === null || value === undefined) return "";

  return String(value)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function cleanText(value) {
  if (value === null || value === undefined) return "";

  return String(value).trim().slice(0, 4000);
}

function normalizeText(value, maxLength = 320) {
  return cleanString(value, maxLength)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeKey(value, maxLength = 120) {
  return cleanString(value, maxLength)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength);
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) return null;

  return parsed;
}

function parseNonNegativeInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 0) return fallback;

  return parsed;
}

function parseDecimal(value) {
  if (value === null || value === undefined || value === "") return null;

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) return null;

  return parsed;
}

function parseScore(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) return 0;

  return parsed;
}

function safeJson(value) {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "string") {
    return value.slice(0, 65000);
  }

  try {
    return JSON.stringify(value).slice(0, 65000);
  } catch {
    return null;
  }
}

function getIpFromRequest(req) {
  const forwarded = req.headers["x-forwarded-for"];

  if (forwarded) {
    return String(forwarded).split(",")[0].trim();
  }

  return req.socket?.remoteAddress || req.ip || "";
}

function hashValue(value) {
  const clean = cleanString(value, 1000);

  if (!clean) return null;

  const salt =
    process.env.ANALYTICS_HASH_SALT ||
    process.env.JWT_SECRET ||
    process.env.APP_SECRET ||
    "andyfers_analytics";

  return crypto
    .createHash("sha256")
    .update(`${salt}:${clean}`)
    .digest("hex");
}

function sqlNorm(column) {
  return `
    REPLACE(
      REPLACE(
        REPLACE(
          UPPER(COALESCE(${column}, '')),
          ' ',
          ''
        ),
        '-',
        ''
      ),
      '_',
      ''
    )
  `;
}

async function getProductSnapshot(payload = {}) {
  const productoId = parsePositiveInt(payload.producto_id);
  const codigoAndyfers = normalizeText(payload.codigo_andyfers, 80);
  const codigoImportacion = normalizeText(payload.codigo_importacion, 80);

  const clauses = [];
  const params = [];

  if (productoId) {
    clauses.push("p.id = ?");
    params.push(productoId);
  }

  const codes = [codigoAndyfers, codigoImportacion].filter(Boolean);

  if (codes.length) {
    const placeholders = codes.map(() => "?").join(",");

    clauses.push(`
      ${sqlNorm("p.codigo_andyfers")} IN (${placeholders})
      OR ${sqlNorm("p.codigo_andyfers_normalizado")} IN (${placeholders})
      OR ${sqlNorm("p.codigo_importacion")} IN (${placeholders})
    `);

    params.push(...codes, ...codes, ...codes);
  }

  if (!clauses.length) return null;

  const [rows] = await pool.query(
    `
    SELECT
      p.id,
      p.codigo_andyfers,
      p.codigo_importacion,
      p.categoria_id,
      c.nombre AS categoria_nombre,
      p.familia
    FROM productos p
    LEFT JOIN categorias c ON c.id = p.categoria_id
    WHERE ${clauses.map((clause) => `(${clause})`).join(" OR ")}
    LIMIT 1
    `,
    params
  );

  return rows[0] || null;
}

function deriveResultadoEstado(evento, totalResultados, resultadoEstado) {
  const estado = normalizeKey(resultadoEstado, 40);

  if (["SIN_RESULTADO", "CON_RESULTADO", "NO_APLICA"].includes(estado)) {
    return estado;
  }

  if (evento.includes("SIN_RESULTADO")) {
    return "SIN_RESULTADO";
  }

  if (evento === "BUSQUEDA_CATALOGO" || evento === "BUSQUEDA_IA") {
    return totalResultados > 0 ? "CON_RESULTADO" : "SIN_RESULTADO";
  }

  return "NO_APLICA";
}

export async function trackAnalyticsEvent(req, rawPayload = {}) {
  const payload = rawPayload || {};

  const evento = normalizeKey(payload.evento || payload.event, 80);

  if (!ANALYTICS_EVENTOS_VALIDOS.has(evento)) {
    const error = new Error("Evento de analítica no válido.");
    error.status = 400;
    throw error;
  }

  const totalResultados = parseNonNegativeInt(payload.total_resultados, 0);
  const resultadoEstado = deriveResultadoEstado(
    evento,
    totalResultados,
    payload.resultado_estado
  );

  const productSnapshot = await getProductSnapshot(payload);

  const busquedaOriginal =
    cleanText(payload.busqueda_original) ||
    cleanText(payload.search) ||
    cleanText(payload.query) ||
    cleanText(payload.pregunta_usuario);

  const busquedaNormalizada =
    normalizeText(payload.busqueda_normalizada, 320) ||
    normalizeText(busquedaOriginal, 320);

  const sessionId =
    cleanString(payload.session_id, 120) ||
    cleanString(req.headers["x-andyfers-session-id"], 120) ||
    null;

  const visitanteId =
    cleanString(payload.visitante_id, 120) ||
    cleanString(req.headers["x-andyfers-visitor-id"], 120) ||
    null;

  const insertPayload = {
    evento,
    origen: normalizeKey(payload.origen || payload.source || "PUBLIC_WEB", 80),
    session_id: sessionId,
    visitante_id: visitanteId,
    ip_hash: hashValue(getIpFromRequest(req)),
    user_agent_hash: hashValue(req.headers["user-agent"] || ""),

    pregunta_usuario: cleanText(payload.pregunta_usuario) || null,
    busqueda_original: busquedaOriginal || null,
    busqueda_normalizada: busquedaNormalizada || null,

    total_resultados: totalResultados,
    resultado_estado: resultadoEstado,

    producto_id: productSnapshot?.id || parsePositiveInt(payload.producto_id),

    codigo_andyfers:
      cleanString(productSnapshot?.codigo_andyfers || payload.codigo_andyfers, 80) ||
      null,

    codigo_importacion:
      cleanString(
        productSnapshot?.codigo_importacion || payload.codigo_importacion,
        80
      ) || null,

    categoria_id:
      productSnapshot?.categoria_id || parsePositiveInt(payload.categoria_id),

    categoria_nombre:
      cleanString(
        productSnapshot?.categoria_nombre || payload.categoria_nombre,
        160
      ) || null,

    familia: cleanString(productSnapshot?.familia || payload.familia, 160) || null,

    marca_vehiculo: normalizeText(payload.marca_vehiculo, 120) || null,
    modelo_vehiculo: normalizeText(payload.modelo_vehiculo, 160) || null,
    anio_vehiculo: cleanString(payload.anio_vehiculo, 40) || null,
    motor_vehiculo: normalizeText(payload.motor_vehiculo, 120) || null,

    cotizacion_id: parsePositiveInt(payload.cotizacion_id),
    cotizacion_folio: cleanString(payload.cotizacion_folio, 120) || null,
    cantidad: parseDecimal(payload.cantidad),

    oportunidad_tipo: normalizeKey(payload.oportunidad_tipo, 80) || null,
    oportunidad_score: parseScore(payload.oportunidad_score),
    metadata_json: safeJson(payload.metadata_json || payload.metadata),
  };

  const [result] = await pool.query(
    `
    INSERT INTO analytics_eventos (
      evento,
      origen,
      session_id,
      visitante_id,
      ip_hash,
      user_agent_hash,
      pregunta_usuario,
      busqueda_original,
      busqueda_normalizada,
      total_resultados,
      resultado_estado,
      producto_id,
      codigo_andyfers,
      codigo_importacion,
      categoria_id,
      categoria_nombre,
      familia,
      marca_vehiculo,
      modelo_vehiculo,
      anio_vehiculo,
      motor_vehiculo,
      cotizacion_id,
      cotizacion_folio,
      cantidad,
      oportunidad_tipo,
      oportunidad_score,
      metadata_json
    )
    VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?
    )
    `,
    [
      insertPayload.evento,
      insertPayload.origen,
      insertPayload.session_id,
      insertPayload.visitante_id,
      insertPayload.ip_hash,
      insertPayload.user_agent_hash,
      insertPayload.pregunta_usuario,
      insertPayload.busqueda_original,
      insertPayload.busqueda_normalizada,
      insertPayload.total_resultados,
      insertPayload.resultado_estado,
      insertPayload.producto_id,
      insertPayload.codigo_andyfers,
      insertPayload.codigo_importacion,
      insertPayload.categoria_id,
      insertPayload.categoria_nombre,
      insertPayload.familia,
      insertPayload.marca_vehiculo,
      insertPayload.modelo_vehiculo,
      insertPayload.anio_vehiculo,
      insertPayload.motor_vehiculo,
      insertPayload.cotizacion_id,
      insertPayload.cotizacion_folio,
      insertPayload.cantidad,
      insertPayload.oportunidad_tipo,
      insertPayload.oportunidad_score,
      insertPayload.metadata_json,
    ]
  );

  return {
    id: result.insertId,
    evento: insertPayload.evento,
    resultado_estado: insertPayload.resultado_estado,
  };
}

export async function trackAnalyticsEventSafe(req, payload = {}) {
  try {
    return await trackAnalyticsEvent(req, payload);
  } catch (error) {
    console.warn("Analytics no registrado:", {
      evento: payload?.evento || payload?.event,
      error: error.message,
    });

    return null;
  }
}
