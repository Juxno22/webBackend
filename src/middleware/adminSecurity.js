// NOTA: Este rate limiter es de proceso único. Si se usa PM2 cluster,
// se debe reemplazar por un almacén compartido (ej. Redis con rate-limiter-flexible).
import { auditAdminAction, recordSecurityEvent } from "../services/adminAudit.service.js";

const memoryBuckets = new Map();

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    req.ip ||
    "unknown"
  );
}

function getAdminEmailFromBody(req) {
  return String(req.body?.email || req.body?.correo || req.body?.usuario || req.body?.username || "")
    .trim()
    .toLowerCase();
}

function cleanupBuckets(now) {
  if (memoryBuckets.size < 500) return;

  for (const [key, bucket] of memoryBuckets.entries()) {
    if (!bucket || bucket.resetAt <= now) memoryBuckets.delete(key);
  }
}

export function createFixedWindowRateLimit(options = {}) {
  const windowMs = Number(options.windowMs || 60_000);
  const max = Number(options.max || 120);
  const message = options.message || "Demasiadas solicitudes. Intenta de nuevo más tarde.";
  const eventType = options.eventType || "ADMIN_RATE_LIMIT";

  return async function fixedWindowRateLimit(req, res, next) {
    const now = Date.now();
    cleanupBuckets(now);

    const key = options.keyGenerator
      ? options.keyGenerator(req)
      : `${getClientIp(req)}:${req.method}:${req.originalUrl?.split("?")[0] || req.url}`;

    let bucket = memoryBuckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      memoryBuckets.set(key, bucket);
    }

    bucket.count += 1;

    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(max - bucket.count, 0)));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      await recordSecurityEvent(req, {
        tipo: eventType,
        severidad: options.severidad || options.severity || "ALTA",
        detalle: message,
        metadata: {
          key,
          count: bucket.count,
          max,
          windowMs,
          route: req.originalUrl || req.url,
        },
      });

      return res.status(429).json({ ok: false, error: message });
    }

    return next();
  };
}

export function adminSecurityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Admin-Area", "andyfers-admin");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  return next();
}

export const adminLoginRateLimit = createFixedWindowRateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.ADMIN_LOGIN_RATE_LIMIT_MAX || 8),
  eventType: "ADMIN_LOGIN_RATE_LIMIT",
  severidad: "CRITICA",
  message: "Demasiados intentos de acceso al admin. Espera unos minutos.",
  keyGenerator: (req) => `${getClientIp(req)}:login:${getAdminEmailFromBody(req) || "no-email"}`,
});

export const adminApiRateLimit = createFixedWindowRateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.ADMIN_API_RATE_LIMIT_MAX || 240),
  eventType: "ADMIN_API_RATE_LIMIT",
  severidad: "ALTA",
  message: "Demasiadas solicitudes al admin. Intenta de nuevo en un momento.",
  keyGenerator: (req) => `${getClientIp(req)}:admin-api`,
});

const adminMutatingRateLimitInternal = createFixedWindowRateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.ADMIN_WRITE_RATE_LIMIT_MAX || 80),
  eventType: "ADMIN_WRITE_RATE_LIMIT",
  severidad: "ALTA",
  message: "Demasiadas acciones administrativas. Intenta de nuevo en un momento.",
  keyGenerator: (req) => `${getClientIp(req)}:admin-write:${req.method}`,
});

export function adminMutatingRateLimit(req, res, next) {
  const method = String(req.method || "GET").toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return next();
  return adminMutatingRateLimitInternal(req, res, next);
}

export function auditAdminMutations(req, res, next) {
  const method = String(req.method || "GET").toUpperCase();

  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return next();
  }

  res.on("finish", () => {
    auditAdminAction(req, {
      status_code: res.statusCode,
      success: res.statusCode < 400,
      metadata: {
        query: req.query || null,
        params: req.params || null,
        body_keys: req.body && typeof req.body === "object" ? Object.keys(req.body).slice(0, 40) : null,
      },
    });
  });

  return next();
}
