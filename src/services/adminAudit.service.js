import crypto from "crypto";
import { pool } from "../config/db.js";

const DEFAULT_SECRET = "andyfers-admin-security";

function cleanString(value, maxLength = 255) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeKey(value, fallback = "ADMIN_ACTION") {
  const key = cleanString(value, 120)
    ?.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return key || fallback;
}

function safeJson(value) {
  if (value === undefined || value === null) return null;

  try {
    const json = JSON.stringify(value);
    return json.length > 65000 ? json.slice(0, 65000) : json;
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
    req.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    req.ip ||
    null
  );
}

function getAdminSnapshot(req) {
  const user = req.admin || req.user || req.usuario || req.auth || {};

  return {
    admin_user_id: user.id || user.user_id || user.usuario_id || user.admin_id || null,
    admin_email: cleanString(user.email || user.correo || user.username || user.usuario, 180),
    admin_nombre: cleanString(user.nombre || user.name || user.full_name, 180),
    admin_role: cleanString(user.role || user.rol || user.tipo || user.perfil, 80),
  };
}

export function buildAuditActionFromRequest(req) {
  const method = (req.method || "GET").toUpperCase();
  const originalUrl = req.originalUrl || req.url || "";
  const pathOnly = originalUrl.split("?")[0];

  if (pathOnly.includes("/login")) return "ADMIN_LOGIN";
  if (pathOnly.includes("/productos")) return `ADMIN_PRODUCTOS_${method}`;
  if (pathOnly.includes("/cotizaciones")) return `ADMIN_COTIZACIONES_${method}`;
  if (pathOnly.includes("/contenido")) return `ADMIN_CONTENIDO_${method}`;
  if (pathOnly.includes("/home/hero")) return `ADMIN_FLYERS_HOME_${method}`;
  if (pathOnly.includes("/pendientes-comerciales")) return `ADMIN_PENDIENTES_COMERCIALES_${method}`;
  if (pathOnly.includes("/catalogo-calidad")) return `ADMIN_CATALOGO_CALIDAD_${method}`;
  if (pathOnly.includes("/multimedia")) return `ADMIN_MULTIMEDIA_${method}`;
  if (pathOnly.includes("/analytics") || pathOnly.includes("/analitica")) return `ADMIN_ANALITICA_${method}`;
  if (pathOnly.includes("/performance")) return `ADMIN_PERFORMANCE_${method}`;
  if (pathOnly.includes("/seguridad")) return `ADMIN_SEGURIDAD_${method}`;

  return `ADMIN_${method}`;
}

export async function auditAdminAction(req, payload = {}) {
  try {
    const admin = getAdminSnapshot(req);
    const action = normalizeKey(payload.action || buildAuditActionFromRequest(req));
    const method = cleanString(payload.method || req.method, 12);
    const path = cleanString(payload.path || req.originalUrl || req.url, 420);
    const statusCode = Number(payload.status_code || payload.statusCode || 0) || null;
    const success = payload.success === false || (statusCode && statusCode >= 400) ? 0 : 1;

    await pool.query(
      `INSERT INTO admin_audit_logs (
        admin_user_id, admin_email, admin_nombre, admin_role,
        action, method, path, status_code, success,
        resource_type, resource_id, request_id,
        ip_hash, user_agent_hash, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        admin.admin_user_id,
        admin.admin_email,
        admin.admin_nombre,
        admin.admin_role,
        action,
        method,
        path,
        statusCode,
        success,
        cleanString(payload.resource_type || payload.resourceType, 120),
        cleanString(payload.resource_id || payload.resourceId, 120),
        cleanString(payload.request_id || req.headers["x-request-id"], 80),
        hashValue(getIp(req)),
        hashValue(req.headers["user-agent"]),
        safeJson(payload.metadata || payload.metadata_json || null),
      ]
    );
  } catch (error) {
    console.warn("No se pudo guardar auditoría admin:", error?.message || error);
  }
}

export async function recordSecurityEvent(req, payload = {}) {
  try {
    const admin = getAdminSnapshot(req || {});
    const severidad = normalizeKey(payload.severidad || payload.severity || "MEDIA", "MEDIA");
    const allowedSeverity = ["BAJA", "MEDIA", "ALTA", "CRITICA"].includes(severidad)
      ? severidad
      : "MEDIA";

    await pool.query(
      `INSERT INTO admin_security_events (
        tipo, severidad, estado, admin_user_id, admin_email,
        method, path, ip_hash, user_agent_hash, detalle, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalizeKey(payload.tipo || payload.type || "SECURITY_EVENT", "SECURITY_EVENT"),
        allowedSeverity,
        "NUEVO",
        admin.admin_user_id,
        admin.admin_email || cleanString(payload.email, 180),
        cleanString(payload.method || req?.method, 12),
        cleanString(payload.path || req?.originalUrl || req?.url, 420),
        hashValue(payload.ip || getIp(req || {})),
        hashValue(payload.user_agent || req?.headers?.["user-agent"]),
        cleanString(payload.detalle || payload.detail, 520),
        safeJson(payload.metadata || null),
      ]
    );
  } catch (error) {
    console.warn("No se pudo guardar evento de seguridad admin:", error?.message || error);
  }
}

function buildDateFilter(params = {}) {
  const filters = [];
  const values = [];

  if (params.desde) {
    filters.push("created_at >= ?");
    values.push(`${String(params.desde).slice(0, 10)} 00:00:00`);
  }

  if (params.hasta) {
    filters.push("created_at <= ?");
    values.push(`${String(params.hasta).slice(0, 10)} 23:59:59`);
  }

  if (!params.desde && !params.hasta) {
    const days = Math.min(Math.max(Number(params.days || 30), 1), 180);
    filters.push("created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)");
    values.push(days);
  }

  return { filters, values };
}

export async function getAdminSecuritySummary(params = {}) {
  const { filters, values } = buildDateFilter(params);
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const [auditRows] = await pool.query(
    `SELECT
      COUNT(*) AS total_acciones,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS acciones_fallidas,
      COUNT(DISTINCT admin_user_id) AS admins_activos,
      COUNT(DISTINCT ip_hash) AS ips_detectadas
    FROM admin_audit_logs
    ${where}`,
    values
  );

  const [securityRows] = await pool.query(
    `SELECT
      COUNT(*) AS total_eventos,
      SUM(CASE WHEN estado = 'NUEVO' THEN 1 ELSE 0 END) AS eventos_nuevos,
      SUM(CASE WHEN severidad IN ('ALTA','CRITICA') THEN 1 ELSE 0 END) AS eventos_altos
    FROM admin_security_events
    ${where}`,
    values
  );

  const [topActions] = await pool.query(
    `SELECT action, COUNT(*) AS total
     FROM admin_audit_logs
     ${where}
     GROUP BY action
     ORDER BY total DESC
     LIMIT 10`,
    values
  );

  const [topSecurity] = await pool.query(
    `SELECT tipo, severidad, estado, COUNT(*) AS total
     FROM admin_security_events
     ${where}
     GROUP BY tipo, severidad, estado
     ORDER BY total DESC
     LIMIT 10`,
    values
  );

  return {
    audit: auditRows?.[0] || {},
    security: securityRows?.[0] || {},
    top_actions: topActions,
    top_security: topSecurity,
  };
}

export async function getAdminAuditLogs(params = {}) {
  const limit = Math.min(Math.max(Number(params.limit || 80), 1), 300);
  const offset = Math.max(Number(params.offset || 0), 0);
  const { filters, values } = buildDateFilter(params);

  if (params.action) {
    filters.push("action = ?");
    values.push(normalizeKey(params.action));
  }

  if (params.method) {
    filters.push("method = ?");
    values.push(cleanString(params.method, 12)?.toUpperCase());
  }

  if (params.success !== undefined && params.success !== null && String(params.success) !== "") {
    filters.push("success = ?");
    values.push(Number(params.success) ? 1 : 0);
  }

  if (params.q) {
    filters.push("(admin_email LIKE ? OR action LIKE ? OR path LIKE ? OR resource_id LIKE ?)");
    const q = `%${String(params.q).trim()}%`;
    values.push(q, q, q, q);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const [rows] = await pool.query(
    `SELECT
      id, admin_user_id, admin_email, admin_nombre, admin_role,
      action, method, path, status_code, success,
      resource_type, resource_id, request_id, metadata_json, created_at
     FROM admin_audit_logs
     ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    [...values, limit, offset]
  );

  return rows;
}

export async function getAdminSecurityEvents(params = {}) {
  const limit = Math.min(Math.max(Number(params.limit || 80), 1), 300);
  const offset = Math.max(Number(params.offset || 0), 0);
  const { filters, values } = buildDateFilter(params);

  if (params.tipo) {
    filters.push("tipo = ?");
    values.push(normalizeKey(params.tipo));
  }

  if (params.estado) {
    filters.push("estado = ?");
    values.push(normalizeKey(params.estado));
  }

  if (params.severidad) {
    filters.push("severidad = ?");
    values.push(normalizeKey(params.severidad));
  }

  if (params.q) {
    filters.push("(admin_email LIKE ? OR tipo LIKE ? OR detalle LIKE ? OR path LIKE ?)");
    const q = `%${String(params.q).trim()}%`;
    values.push(q, q, q, q);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const [rows] = await pool.query(
    `SELECT
      id, tipo, severidad, estado, admin_user_id, admin_email,
      method, path, detalle, metadata_json, created_at, updated_at
     FROM admin_security_events
     ${where}
     ORDER BY
      CASE severidad WHEN 'CRITICA' THEN 1 WHEN 'ALTA' THEN 2 WHEN 'MEDIA' THEN 3 ELSE 4 END,
      created_at DESC,
      id DESC
     LIMIT ? OFFSET ?`,
    [...values, limit, offset]
  );

  return rows;
}

export async function updateSecurityEventStatus(id, estado) {
  const normalized = normalizeKey(estado, "NUEVO");
  const allowed = ["NUEVO", "EN_REVISION", "RESUELTO", "DESCARTADO"];

  if (!allowed.includes(normalized)) {
    const error = new Error("Estado de evento de seguridad no válido.");
    error.status = 400;
    throw error;
  }

  const [result] = await pool.query(
    `UPDATE admin_security_events SET estado = ? WHERE id = ?`,
    [normalized, Number(id)]
  );

  return { affected_rows: result.affectedRows || 0 };
}
