import crypto from "crypto";
import { pool } from "../config/db.js";

const DEFAULT_SECRET = "andyfers-admin-critical-actions";

export const CRITICAL_ADMIN_ACTION_DEFINITIONS = {
  OCULTAR_CATALOGO: {
    label: "Ocultar producto del catálogo público",
    expected_confirmation: "OCULTAR_CATALOGO",
    motivo_required: true,
    severidad: "ALTA",
  },
  ACTIVAR_CATALOGO: {
    label: "Activar producto en catálogo público",
    expected_confirmation: "ACTIVAR_CATALOGO",
    motivo_required: true,
    severidad: "ALTA",
  },
  DESMARCAR_NUEVO: {
    label: "Quitar marca de producto nuevo",
    expected_confirmation: "DESMARCAR_NUEVO",
    motivo_required: true,
    severidad: "MEDIA",
  },
  DESMARCAR_DESTACADO: {
    label: "Quitar marca de producto destacado",
    expected_confirmation: "DESMARCAR_DESTACADO",
    motivo_required: true,
    severidad: "MEDIA",
  },
  DESCARTAR_PENDIENTE: {
    label: "Descartar pendiente comercial",
    expected_confirmation: "DESCARTAR_PENDIENTE",
    motivo_required: true,
    severidad: "MEDIA",
  },
};

function cleanString(value, maxLength = 255) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanNullable(value, maxLength = 255) {
  const text = cleanString(value, maxLength);
  return text || null;
}

function normalizeKey(value, fallback = "") {
  const text = cleanString(value, 140)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return text || fallback;
}

function safeJson(value) {
  if (value === undefined || value === null || value === "") return null;

  try {
    return JSON.stringify(value).slice(0, 65000);
  } catch {
    return null;
  }
}

function hashValue(value) {
  const text = cleanString(value, 2000);
  if (!text) return null;

  const secret = process.env.ADMIN_AUDIT_HASH_SECRET || process.env.JWT_SECRET || DEFAULT_SECRET;
  return crypto.createHash("sha256").update(`${secret}:${text}`).digest("hex");
}

function getIp(req) {
  return (
    req?.headers?.["x-forwarded-for"]?.split(",")?.[0]?.trim() ||
    req?.headers?.["x-real-ip"] ||
    req?.socket?.remoteAddress ||
    req?.ip ||
    null
  );
}

function getAdminSnapshot(req) {
  const user = req?.admin || req?.user || req?.usuario || req?.auth || {};

  return {
    admin_user_id: user.id || user.user_id || user.usuario_id || user.admin_id || null,
    admin_email: cleanNullable(user.email || user.correo || user.username || user.usuario, 180),
    admin_nombre: cleanNullable(user.nombre || user.name || user.full_name, 180),
    admin_role: cleanNullable(user.role || user.rol || user.tipo || user.perfil, 80),
  };
}

function buildDateFilter(params = {}, tableAlias = "") {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  const filters = [];
  const values = [];

  if (params.desde) {
    filters.push(`${prefix}created_at >= ?`);
    values.push(`${String(params.desde).slice(0, 10)} 00:00:00`);
  }

  if (params.hasta) {
    filters.push(`${prefix}created_at <= ?`);
    values.push(`${String(params.hasta).slice(0, 10)} 23:59:59`);
  }

  if (!params.desde && !params.hasta) {
    const days = Math.min(Math.max(Number(params.days || 30), 1), 180);
    filters.push(`${prefix}created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`);
    values.push(days);
  }

  return { filters, values };
}

export function isCriticalAdminAction(action) {
  return Boolean(CRITICAL_ADMIN_ACTION_DEFINITIONS[normalizeKey(action)]);
}

export function getCriticalActionDefinition(action) {
  const normalized = normalizeKey(action);
  return CRITICAL_ADMIN_ACTION_DEFINITIONS[normalized] || null;
}

export function validateCriticalActionPayload(req, action, options = {}) {
  const normalizedAction = normalizeKey(action);
  const definition = getCriticalActionDefinition(normalizedAction);

  if (!definition) {
    return {
      isCritical: false,
      ok: true,
      action: normalizedAction,
    };
  }

  const expected = normalizeKey(options.expected_confirmation || definition.expected_confirmation || normalizedAction);
  const confirmation = normalizeKey(
    req?.body?.confirmacion_accion ||
      req?.body?.confirmacion_critica ||
      req?.body?.confirmacion ||
      req?.body?.confirmation ||
      req?.body?.confirm ||
      ""
  );

  const motivo = cleanString(
    req?.body?.motivo_critico || req?.body?.motivo || req?.body?.reason || req?.body?.justificacion || "",
    1200
  );

  if (confirmation !== expected) {
    return {
      isCritical: true,
      ok: false,
      action: normalizedAction,
      label: definition.label,
      expected_confirmation: expected,
      confirmation,
      motivo,
      severidad: definition.severidad || "ALTA",
      error: `Acción crítica bloqueada. Para continuar escribe exactamente: ${expected}`,
    };
  }

  const motivoRequired = options.motivo_required ?? definition.motivo_required;
  if (motivoRequired && motivo.length < 8) {
    return {
      isCritical: true,
      ok: false,
      action: normalizedAction,
      label: definition.label,
      expected_confirmation: expected,
      confirmation,
      motivo,
      severidad: definition.severidad || "ALTA",
      error: "Acción crítica bloqueada. Escribe un motivo operativo de al menos 8 caracteres.",
    };
  }

  return {
    isCritical: true,
    ok: true,
    action: normalizedAction,
    label: definition.label,
    expected_confirmation: expected,
    confirmation,
    motivo,
    severidad: definition.severidad || "ALTA",
  };
}

export async function recordCriticalActionLog(req, payload = {}, connection = null) {
  const db = connection || pool;
  const admin = getAdminSnapshot(req);
  const action = normalizeKey(payload.action || payload.accion || "ADMIN_CRITICAL_ACTION");
  const status = normalizeKey(payload.status || payload.estado || "APLICADA", "APLICADA");
  const allowedStatus = ["APLICADA", "BLOQUEADA", "ERROR"].includes(status) ? status : "APLICADA";

  try {
    await db.query(
      `INSERT INTO admin_critical_action_logs (
        admin_user_id, admin_email, admin_nombre, admin_role,
        action, label, status, severidad,
        resource_type, resource_id, producto_id, pendiente_id,
        confirmation_text, motivo, error_message,
        method, path, ip_hash, user_agent_hash, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        admin.admin_user_id,
        admin.admin_email,
        admin.admin_nombre,
        admin.admin_role,
        action,
        cleanNullable(payload.label || getCriticalActionDefinition(action)?.label, 220),
        allowedStatus,
        normalizeKey(payload.severidad || payload.severity || getCriticalActionDefinition(action)?.severidad || "ALTA", "ALTA"),
        cleanNullable(payload.resource_type || payload.resourceType, 120),
        cleanNullable(payload.resource_id || payload.resourceId, 120),
        payload.producto_id || payload.productoId || null,
        payload.pendiente_id || payload.pendienteId || null,
        cleanNullable(payload.confirmation_text || payload.confirmacion || payload.confirmation, 140),
        cleanNullable(payload.motivo || payload.reason, 1200),
        cleanNullable(payload.error_message || payload.error, 520),
        cleanNullable(payload.method || req?.method, 12),
        cleanNullable(payload.path || req?.originalUrl || req?.url, 420),
        hashValue(payload.ip || getIp(req)),
        hashValue(payload.user_agent || req?.headers?.["user-agent"]),
        safeJson(payload.metadata || null),
      ]
    );
  } catch (error) {
    console.warn("No se pudo guardar acción crítica admin:", error?.message || error);
  }
}

export async function getCriticalActionSummary(params = {}) {
  const { filters, values } = buildDateFilter(params);
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const [rows] = await pool.query(
    `SELECT
      COUNT(*) AS total_acciones_criticas,
      SUM(CASE WHEN status = 'APLICADA' THEN 1 ELSE 0 END) AS aplicadas,
      SUM(CASE WHEN status = 'BLOQUEADA' THEN 1 ELSE 0 END) AS bloqueadas,
      SUM(CASE WHEN severidad IN ('ALTA','CRITICA') THEN 1 ELSE 0 END) AS alta_prioridad,
      COUNT(DISTINCT admin_user_id) AS admins_involucrados,
      COUNT(DISTINCT producto_id) AS productos_afectados
     FROM admin_critical_action_logs
     ${where}`,
    values
  );

  const [topActions] = await pool.query(
    `SELECT action, status, COUNT(*) AS total
     FROM admin_critical_action_logs
     ${where}
     GROUP BY action, status
     ORDER BY total DESC
     LIMIT 10`,
    values
  );

  return {
    resumen: rows?.[0] || {},
    top_actions: topActions || [],
  };
}

export async function getCriticalActionLogs(params = {}) {
  const limit = Math.min(Math.max(Number(params.limit || 100), 1), 300);
  const offset = Math.max(Number(params.offset || 0), 0);
  const { filters, values } = buildDateFilter(params);

  if (params.action) {
    filters.push("action = ?");
    values.push(normalizeKey(params.action));
  }

  if (params.status) {
    filters.push("status = ?");
    values.push(normalizeKey(params.status));
  }

  if (params.severidad) {
    filters.push("severidad = ?");
    values.push(normalizeKey(params.severidad));
  }

  if (params.q) {
    filters.push(`(
      admin_email LIKE ?
      OR action LIKE ?
      OR label LIKE ?
      OR resource_id LIKE ?
      OR codigo_andyfers_cache LIKE ?
      OR motivo LIKE ?
    )`);
    const q = `%${String(params.q).trim()}%`;
    values.push(q, q, q, q, q, q);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const [rows] = await pool.query(
    `SELECT
      id, admin_user_id, admin_email, admin_nombre, admin_role,
      action, label, status, severidad,
      resource_type, resource_id, producto_id, pendiente_id,
      confirmation_text, motivo, error_message,
      method, path, codigo_andyfers_cache, metadata_json, created_at
     FROM admin_critical_action_logs
     ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    [...values, limit, offset]
  );

  return rows;
}
