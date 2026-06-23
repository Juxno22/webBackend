import express from "express";
import crypto from "crypto";
import { pool } from "../config/db.js";
import { requireAdminAuth, requireRole } from "../middleware/authAdmin.js";

const router = express.Router();
const PUBLIC_ALLOWED_METRICS = new Set([
  "LCP",
  "CLS",
  "INP",
  "FID",
  "FCP",
  "TTFB",
  "LOAD",
  "DOM_READY",
  "NAVIGATION",
]);

function cleanString(value, maxLength = 255) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function cleanKey(value, maxLength = 80) {
  return cleanString(value, maxLength)
    ?.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || null;
}

function hashValue(value) {
  if (!value) return null;
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function normalizeMetricRating(metricName, rawValue, explicitRating) {
  const given = cleanKey(explicitRating, 40);
  if (["GOOD", "NEEDS_IMPROVEMENT", "POOR"].includes(given)) return given;

  const value = Number(rawValue);
  if (!Number.isFinite(value)) return null;

  switch (metricName) {
    case "LCP":
      if (value <= 2500) return "GOOD";
      if (value <= 4000) return "NEEDS_IMPROVEMENT";
      return "POOR";
    case "CLS":
      if (value <= 0.1) return "GOOD";
      if (value <= 0.25) return "NEEDS_IMPROVEMENT";
      return "POOR";
    case "INP":
    case "FID":
      if (value <= 200) return "GOOD";
      if (value <= 500) return "NEEDS_IMPROVEMENT";
      return "POOR";
    case "FCP":
      if (value <= 1800) return "GOOD";
      if (value <= 3000) return "NEEDS_IMPROVEMENT";
      return "POOR";
    case "TTFB":
      if (value <= 800) return "GOOD";
      if (value <= 1800) return "NEEDS_IMPROVEMENT";
      return "POOR";
    case "LOAD":
    case "DOM_READY":
    case "NAVIGATION":
      if (value <= 2000) return "GOOD";
      if (value <= 5000) return "NEEDS_IMPROVEMENT";
      return "POOR";
    default:
      return null;
  }
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || null;
}

function getDateRange(req) {
  const daysRaw = Number(req.query.days || 30);
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 180) : 30;
  return { days };
}

router.post("/performance/web-vitals", async (req, res, next) => {
  try {
    const payload = req.body || {};
    const events = Array.isArray(payload.events) ? payload.events : [payload];
    const validEvents = [];

    for (const event of events.slice(0, 30)) {
      const metricName = cleanKey(event.metric_name || event.name, 80);
      if (!PUBLIC_ALLOWED_METRICS.has(metricName)) continue;

      const metricValue = Number(event.metric_value ?? event.value);
      if (!Number.isFinite(metricValue)) continue;

      const pathname = cleanString(event.pathname || event.path, 320);
      const url = cleanString(event.url, 700);
      const metricRating = normalizeMetricRating(metricName, metricValue, event.metric_rating || event.rating);

      validEvents.push({
        session_id: cleanString(event.session_id || payload.session_id, 120),
        visitante_id: cleanString(event.visitante_id || payload.visitante_id, 120),
        url,
        pathname,
        referrer: cleanString(event.referrer, 700),
        device_type: cleanKey(event.device_type, 40),
        connection_type: cleanString(event.connection_type, 60),
        viewport_width: Number.isFinite(Number(event.viewport_width)) ? Number(event.viewport_width) : null,
        viewport_height: Number.isFinite(Number(event.viewport_height)) ? Number(event.viewport_height) : null,
        user_agent_hash: hashValue(req.headers["user-agent"] || null),
        ip_hash: hashValue(getClientIp(req)),
        metric_name: metricName,
        metric_value: metricValue,
        metric_rating: metricRating,
        navigation_type: cleanString(event.navigation_type, 80),
        metadata_json: event.metadata ? JSON.stringify(event.metadata).slice(0, 8000) : null,
      });
    }

    if (!validEvents.length) {
      return res.json({ ok: true, inserted: 0 });
    }

    const values = validEvents.map((event) => [
      event.session_id,
      event.visitante_id,
      event.url,
      event.pathname,
      event.referrer,
      event.device_type,
      event.connection_type,
      event.viewport_width,
      event.viewport_height,
      event.user_agent_hash,
      event.ip_hash,
      event.metric_name,
      event.metric_value,
      event.metric_rating,
      event.navigation_type,
      event.metadata_json,
    ]);

    await pool.query(
      `
      INSERT INTO performance_web_vitals (
        session_id,
        visitante_id,
        url,
        pathname,
        referrer,
        device_type,
        connection_type,
        viewport_width,
        viewport_height,
        user_agent_hash,
        ip_hash,
        metric_name,
        metric_value,
        metric_rating,
        navigation_type,
        metadata_json
      ) VALUES ?
      `,
      [values]
    );

    return res.json({ ok: true, inserted: validEvents.length });
  } catch (error) {
    return next(error);
  }
});

router.get(
  "/admin/performance/resumen",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const { days } = getDateRange(req);

      const [kpisRows] = await pool.query(
        `
        SELECT
          COUNT(*) AS total_mediciones,
          COUNT(DISTINCT session_id) AS sesiones,
          COUNT(DISTINCT pathname) AS paginas,
          SUM(CASE WHEN metric_rating = 'GOOD' THEN 1 ELSE 0 END) AS buenas,
          SUM(CASE WHEN metric_rating = 'NEEDS_IMPROVEMENT' THEN 1 ELSE 0 END) AS mejora,
          SUM(CASE WHEN metric_rating = 'POOR' THEN 1 ELSE 0 END) AS malas
        FROM performance_web_vitals
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        `,
        [days]
      );

      const [metricas] = await pool.query(
        `
        SELECT
          metric_name,
          COUNT(*) AS mediciones,
          ROUND(AVG(metric_value), 2) AS promedio,
          ROUND(MIN(metric_value), 2) AS minimo,
          ROUND(MAX(metric_value), 2) AS maximo,
          SUM(CASE WHEN metric_rating = 'GOOD' THEN 1 ELSE 0 END) AS buenas,
          SUM(CASE WHEN metric_rating = 'NEEDS_IMPROVEMENT' THEN 1 ELSE 0 END) AS mejora,
          SUM(CASE WHEN metric_rating = 'POOR' THEN 1 ELSE 0 END) AS malas
        FROM performance_web_vitals
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY metric_name
        ORDER BY FIELD(metric_name, 'LCP', 'CLS', 'INP', 'FCP', 'TTFB', 'LOAD', 'DOM_READY', 'NAVIGATION'), metric_name
        `,
        [days]
      );

      const [paginasLentas] = await pool.query(
        `
        SELECT
          pathname,
          metric_name,
          COUNT(*) AS mediciones,
          ROUND(AVG(metric_value), 2) AS promedio,
          ROUND(MAX(metric_value), 2) AS maximo,
          SUM(CASE WHEN metric_rating = 'POOR' THEN 1 ELSE 0 END) AS malas,
          MAX(created_at) AS ultima_medicion
        FROM performance_web_vitals
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
          AND pathname IS NOT NULL
          AND pathname <> ''
        GROUP BY pathname, metric_name
        HAVING malas > 0 OR promedio >= CASE
          WHEN metric_name = 'LCP' THEN 2500
          WHEN metric_name = 'CLS' THEN 0.1
          WHEN metric_name IN ('INP', 'FID') THEN 200
          WHEN metric_name = 'FCP' THEN 1800
          WHEN metric_name = 'TTFB' THEN 800
          ELSE 2500
        END
        ORDER BY malas DESC, promedio DESC
        LIMIT 80
        `,
        [days]
      );

      const [diario] = await pool.query(
        `
        SELECT
          DATE(created_at) AS fecha,
          metric_name,
          COUNT(*) AS mediciones,
          ROUND(AVG(metric_value), 2) AS promedio,
          SUM(CASE WHEN metric_rating = 'POOR' THEN 1 ELSE 0 END) AS malas
        FROM performance_web_vitals
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY DATE(created_at), metric_name
        ORDER BY fecha DESC, metric_name
        LIMIT 180
        `,
        [days]
      );

      return res.json({
        ok: true,
        data: {
          rango_dias: days,
          kpis: kpisRows?.[0] || {},
          metricas,
          paginas_lentas: paginasLentas,
          diario,
        },
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.get(
  "/admin/performance/eventos",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const { days } = getDateRange(req);
      const metric = cleanKey(req.query.metric, 80);
      const rating = cleanKey(req.query.rating, 40);
      const pathname = cleanString(req.query.pathname, 320);
      const limitRaw = Number(req.query.limit || 100);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 300) : 100;

      const where = ["created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)"];
      const params = [days];

      if (metric) {
        where.push("metric_name = ?");
        params.push(metric);
      }

      if (rating) {
        where.push("metric_rating = ?");
        params.push(rating);
      }

      if (pathname) {
        where.push("pathname LIKE ?");
        params.push(`%${pathname}%`);
      }

      params.push(limit);

      const [rows] = await pool.query(
        `
        SELECT
          id,
          session_id,
          visitante_id,
          pathname,
          url,
          referrer,
          device_type,
          connection_type,
          viewport_width,
          viewport_height,
          metric_name,
          metric_value,
          metric_rating,
          navigation_type,
          created_at
        FROM performance_web_vitals
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT ?
        `,
        params
      );

      return res.json({ ok: true, data: rows });
    } catch (error) {
      return next(error);
    }
  }
);

export default router;
