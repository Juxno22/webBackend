import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { spawn } from "child_process";
import { pool } from "../config/db.js";
import { getProductionConfigSnapshot, isValidPublicHttpUrl } from "../config/productionConfig.js";

const REQUIRED_ENV = [
  { key: "JWT_SECRET", level: "CRITICAL", label: "JWT_SECRET" },
  { key: "DB_HOST", level: "CRITICAL", label: "DB_HOST" },
  { key: "DB_USER", level: "CRITICAL", label: "DB_USER" },
  { key: "DB_NAME", level: "CRITICAL", label: "DB_NAME" },
  { key: "CORS_ORIGIN", level: "CRITICAL", label: "CORS_ORIGIN" },
  { key: "FRONTEND_URL", level: "WARNING", label: "FRONTEND_URL" },
  { key: "BACKEND_URL", level: "WARNING", label: "BACKEND_URL" },
];

const OPTIONAL_ENV = [
  { key: "DB_PORT", label: "DB_PORT" },
  { key: "DB_CONNECTION_LIMIT", label: "DB_CONNECTION_LIMIT" },
  { key: "PUBLIC_FRONTEND_URL", label: "PUBLIC_FRONTEND_URL" },
  { key: "PUBLIC_BACKEND_URL", label: "PUBLIC_BACKEND_URL" },
  { key: "NEXT_PUBLIC_API_URL", label: "NEXT_PUBLIC_API_URL" },
  { key: "NEXT_PUBLIC_SITE_URL", label: "NEXT_PUBLIC_SITE_URL" },
  { key: "CORS_ORIGINS", label: "CORS_ORIGINS" },
  { key: "TRUST_PROXY", label: "TRUST_PROXY" },
  { key: "CLOUDINARY_CLOUD_NAME", label: "CLOUDINARY_CLOUD_NAME" },
  { key: "CLOUDINARY_API_KEY", label: "CLOUDINARY_API_KEY" },
  { key: "CLOUDINARY_API_SECRET", label: "CLOUDINARY_API_SECRET" },
  { key: "OPENROUTER_API_KEY", label: "OPENROUTER_API_KEY" },
  { key: "MYSQLDUMP_PATH", label: "MYSQLDUMP_PATH" },
  { key: "PRODUCTION_BACKUP_DIR", label: "PRODUCTION_BACKUP_DIR" },
  { key: "PRODUCTION_BACKUP_KEEP", label: "PRODUCTION_BACKUP_KEEP" },
  { key: "PRODUCTION_BACKUP_MIN_BYTES", label: "PRODUCTION_BACKUP_MIN_BYTES" },
  { key: "PRODUCTION_BACKUP_SCHEDULE", label: "PRODUCTION_BACKUP_SCHEDULE" },
];

const DEFAULT_BACKUP_KEEP = 15;
const DEFAULT_BACKUP_MIN_BYTES = 1024;
const BACKUP_LOG_OPTIONAL_COLUMNS = [
  "checksum_sha256",
  "integrity_status",
  "integrity_message",
  "restore_tested_at",
  "restore_tested_by_admin_id",
  "restore_tested_by_nombre",
  "restore_notes",
  "metadata_json",
];

let backupLogColumnsCache = null;

const CRITICAL_TABLES = [
  "productos",
  "categorias",
  "usuarios_admin",
  "cotizaciones",
  "cotizacion_items",
  "producto_multimedia",
  "home_hero_slides",
  "site_content_blocks",
  "site_banners",
  "site_commercial_lines",
  "site_featured_sections",
  "site_contact_channels",
  "analytics_eventos",
  "analytics_oportunidades_revision",
  "catalogo_pendientes_comerciales",
  "multimedia_macheo_reportes",
  "multimedia_macheo_items",
  "performance_web_vitals",
  "admin_audit_logs",
  "admin_security_events",
  "admin_critical_action_logs",
  "admin_production_backup_logs",
  "admin_production_check_runs",
  "admin_production_deploy_runs",
  "admin_production_deploy_items",
];

const COUNTER_QUERIES = [
  ["productos", "SELECT COUNT(*) AS total FROM productos"],
  ["productos_activos_web", "SELECT COUNT(*) AS total FROM productos WHERE COALESCE(activo_web, 0) = 1"],
  ["productos_visibles_catalogo", "SELECT COUNT(*) AS total FROM productos WHERE COALESCE(visible_catalogo, 0) = 1"],
  ["productos_con_multimedia", "SELECT COUNT(DISTINCT producto_id) AS total FROM producto_multimedia WHERE activo = 1 AND tipo = 'IMAGEN'"],
  ["cotizaciones", "SELECT COUNT(*) AS total FROM cotizaciones"],
  ["analytics_eventos", "SELECT COUNT(*) AS total FROM analytics_eventos"],
  ["pendientes_comerciales_abiertos", "SELECT COUNT(*) AS total FROM catalogo_pendientes_comerciales WHERE estado NOT IN ('COMPLETADO','DESCARTADO')"],
  ["macheo_reportes", "SELECT COUNT(*) AS total FROM multimedia_macheo_reportes"],
  ["performance_eventos", "SELECT COUNT(*) AS total FROM performance_web_vitals"],
  ["usuarios_admin_activos", "SELECT COUNT(*) AS total FROM usuarios_admin WHERE activo = 1"],
];

function nowIsoForFilename() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

function mysqlDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function envValue(key) {
  if (key === "DB_NAME") return process.env.DB_NAME || process.env.DB_DATABASE || "";
  if (key === "CORS_ORIGIN") return process.env.CORS_ORIGIN || process.env.CORS_ORIGINS || "";
  if (key === "FRONTEND_URL") return process.env.FRONTEND_URL || process.env.PUBLIC_FRONTEND_URL || process.env.NEXT_PUBLIC_SITE_URL || "";
  if (key === "BACKEND_URL") return process.env.BACKEND_URL || process.env.PUBLIC_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || "";
  return process.env[key] || "";
}

function maskValue(value) {
  if (!value) return "";
  const text = String(value);
  if (text.length <= 4) return "****";
  return `${text.slice(0, 2)}${"*".repeat(Math.min(8, text.length - 4))}${text.slice(-2)}`;
}

function getBackupDir() {
  const configured = process.env.PRODUCTION_BACKUP_DIR || process.env.BACKUP_DIR || "backups";
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

function parsePositiveInteger(value, fallback, min = 1, max = 1000000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(Math.trunc(parsed), max));
}

function getBackupPolicy() {
  const keep = parsePositiveInteger(
    process.env.PRODUCTION_BACKUP_KEEP,
    DEFAULT_BACKUP_KEEP,
    1,
    365
  );
  const minBytes = parsePositiveInteger(
    process.env.PRODUCTION_BACKUP_MIN_BYTES,
    DEFAULT_BACKUP_MIN_BYTES,
    256,
    1024 * 1024 * 1024
  );
  const schedule = String(process.env.PRODUCTION_BACKUP_SCHEDULE || "manual").trim() || "manual";

  return {
    backup_dir: getBackupDir(),
    keep,
    min_bytes: minBytes,
    schedule,
    automatic_enabled: schedule.toLowerCase() !== "manual",
    restore_mode: "manual_verified_only",
  };
}

async function getBackupLogColumns() {
  if (backupLogColumnsCache) return backupLogColumnsCache;

  const config = getDbConfig();
  const [rows] = await pool.query(
    `
    SELECT COLUMN_NAME AS column_name
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ?
      AND TABLE_NAME = 'admin_production_backup_logs'
    `,
    [config.database]
  );

  backupLogColumnsCache = new Set((rows || []).map((row) => row.column_name));
  return backupLogColumnsCache;
}

function hasOptionalColumn(columns, column) {
  return columns?.has?.(column);
}

async function calculateFileSha256(filepath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filepath);

    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function readFilePreview(filepath, bytes = 8192) {
  const handle = await fsp.open(filepath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function validateBackupFile(filepath, { minBytes = DEFAULT_BACKUP_MIN_BYTES } = {}) {
  const stat = await fsp.stat(filepath).catch(() => null);
  if (!stat) {
    return {
      ok: false,
      status: "ERROR",
      size_bytes: 0,
      checksum_sha256: null,
      message: "No se encontró el archivo de respaldo.",
      checks: { exists: false, min_size: false, sql_markers: false },
    };
  }

  const preview = await readFilePreview(filepath).catch(() => "");
  const hasSqlMarkers = /MariaDB dump|MySQL dump|CREATE TABLE|INSERT INTO|-- Host:/i.test(preview);
  const hasMinSize = stat.size >= minBytes;
  const checksum = await calculateFileSha256(filepath).catch(() => null);
  const ok = hasMinSize && hasSqlMarkers && Boolean(checksum);

  return {
    ok,
    status: ok ? "OK" : "WARNING",
    size_bytes: stat.size,
    checksum_sha256: checksum,
    message: ok
      ? "Respaldo validado: existe, supera tamaño mínimo y contiene estructura SQL reconocible."
      : "Respaldo generado, pero requiere revisión de integridad antes de considerarlo seguro.",
    checks: {
      exists: true,
      min_size: hasMinSize,
      sql_markers: hasSqlMarkers,
      checksum: Boolean(checksum),
      min_bytes: minBytes,
    },
  };
}

function candidateMysqldumpPaths() {
  const configured = process.env.MYSQLDUMP_PATH;
  return [
    configured,
    "mysqldump",
    "C:/xampp/mysql/bin/mysqldump.exe",
    "C:/xampp/mysql/bin/mysqldump",
    "/usr/bin/mysqldump",
    "/usr/local/bin/mysqldump",
    "/opt/homebrew/bin/mysqldump",
  ].filter(Boolean);
}

function resolveMysqldumpPath() {
  const configured = process.env.MYSQLDUMP_PATH;
  if (configured) return configured;

  for (const candidate of candidateMysqldumpPaths()) {
    if (candidate === "mysqldump") continue;
    if (fs.existsSync(candidate)) return candidate;
  }

  return "mysqldump";
}

function getDbConfig() {
  return {
    host: process.env.DB_HOST || "localhost",
    port: process.env.DB_PORT || "3307",
    user: process.env.DB_USER || process.env.MYSQL_USER || "root",
    password: process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || "",
    database: process.env.DB_NAME || process.env.DB_DATABASE || "andyfers",
    mysqldumpPath: resolveMysqldumpPath(),
  };
}

function makeCheck({ key, label, area, status, level = "INFO", message, details = null }) {
  return { key, label, area, status, level, message, details };
}

export function getProductionEnvSnapshot() {
  const required = REQUIRED_ENV.map((item) => {
    const value = envValue(item.key);
    return {
      key: item.key,
      label: item.label,
      required: true,
      configured: Boolean(value),
      level: item.level,
      value_masked: value ? maskValue(value) : "",
    };
  });

  const optional = OPTIONAL_ENV.map((item) => {
    const value = envValue(item.key);
    return {
      key: item.key,
      label: item.label,
      required: false,
      configured: Boolean(value),
      level: "INFO",
      value_masked: value ? maskValue(value) : "",
    };
  });

  const dbConfig = getDbConfig();

  return {
    node_env: process.env.NODE_ENV || "development",
    platform: process.platform,
    node_version: process.version,
    hostname: os.hostname(),
    cwd: process.cwd(),
    backup_dir: getBackupDir(),
    mysqldump_path: dbConfig.mysqldumpPath,
    backup_policy: getBackupPolicy(),
    db_host: dbConfig.host,
    db_port: dbConfig.port,
    db_name: dbConfig.database,
    production_config: getProductionConfigSnapshot(),
    required,
    optional,
  };
}

async function checkDatabase() {
  const started = Date.now();
  const [rows] = await pool.query("SELECT 1 AS ok, DATABASE() AS db_name, NOW() AS server_time");
  const row = rows?.[0] || {};

  return makeCheck({
    key: "db_connection",
    label: "Conexión MySQL/MariaDB",
    area: "BASE_DATOS",
    status: "OK",
    level: "CRITICAL",
    message: `Conectado a ${row.db_name || "base no detectada"}.`,
    details: {
      db_name: row.db_name || null,
      server_time: row.server_time || null,
      latency_ms: Date.now() - started,
    },
  });
}

async function checkCriticalTables() {
  const config = getDbConfig();
  const [rows] = await pool.query(
    `
    SELECT TABLE_NAME AS table_name
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = ?
      AND TABLE_NAME IN (${CRITICAL_TABLES.map(() => "?").join(",")})
    `,
    [config.database, ...CRITICAL_TABLES]
  );

  const found = new Set((rows || []).map((row) => row.table_name));
  const missing = CRITICAL_TABLES.filter((table) => !found.has(table));

  return makeCheck({
    key: "critical_tables",
    label: "Tablas críticas del sistema",
    area: "BASE_DATOS",
    status: missing.length ? "WARNING" : "OK",
    level: missing.length ? "WARNING" : "INFO",
    message: missing.length
      ? `Faltan o no se detectan ${missing.length} tablas críticas.`
      : "Tablas críticas detectadas.",
    details: {
      expected: CRITICAL_TABLES,
      found: [...found],
      missing,
    },
  });
}

async function checkCoreCounters() {
  const counters = {};
  const unavailable = [];

  for (const [key, sql] of COUNTER_QUERIES) {
    try {
      const [rows] = await pool.query(sql);
      counters[key] = Number(rows?.[0]?.total || 0);
    } catch (error) {
      counters[key] = null;
      unavailable.push({ key, error: error?.message || "No disponible" });
    }
  }

  const warnings = [];
  if (!counters.productos) warnings.push("No se detectaron productos.");
  if (counters.productos_activos_web === 0) warnings.push("No se detectaron productos activos web.");
  if (counters.productos_visibles_catalogo === 0) warnings.push("No se detectaron productos visibles en catálogo.");
  if (counters.productos_con_multimedia === 0) warnings.push("No se detectó multimedia activa.");

  return makeCheck({
    key: "core_counters",
    label: "Conteos operativos base",
    area: "DATOS",
    status: warnings.length || unavailable.length ? "WARNING" : "OK",
    level: warnings.length ? "WARNING" : "INFO",
    message: warnings.length
      ? warnings.join(" ")
      : unavailable.length
        ? "Algunos conteos no están disponibles porque faltan tablas de módulos opcionales."
        : "Conteos base disponibles.",
    details: { counters, unavailable },
  });
}

async function checkBackupDirectory() {
  const backupDir = getBackupDir();
  await fsp.mkdir(backupDir, { recursive: true });

  const testFile = path.join(backupDir, ".andyfers-write-check");
  await fsp.writeFile(testFile, String(Date.now()), "utf8");
  await fsp.unlink(testFile).catch(() => null);

  const files = await fsp.readdir(backupDir).catch(() => []);
  const sqlBackups = files.filter((file) => file.endsWith(".sql"));

  return makeCheck({
    key: "backup_dir",
    label: "Directorio de respaldos",
    area: "RESPALDOS",
    status: "OK",
    level: "CRITICAL",
    message: "Directorio de respaldos disponible y escribible.",
    details: {
      backup_dir: backupDir,
      sql_backups_detected: sqlBackups.length,
    },
  });
}

async function checkMysqldump() {
  const config = getDbConfig();
  const candidates = candidateMysqldumpPaths();
  const exists = config.mysqldumpPath !== "mysqldump" ? fs.existsSync(config.mysqldumpPath) : null;

  return makeCheck({
    key: "mysqldump",
    label: "Utilidad mysqldump",
    area: "RESPALDOS",
    status: exists === false ? "WARNING" : "OK",
    level: "WARNING",
    message: exists === false
      ? "No se encontró MYSQLDUMP_PATH. Configura la ruta para poder generar respaldos desde el panel."
      : "Ruta de mysqldump configurada o disponible por PATH.",
    details: {
      mysqldump_path: config.mysqldumpPath,
      configured: Boolean(process.env.MYSQLDUMP_PATH),
      candidates,
    },
  });
}

function checkBackupPolicy() {
  const policy = getBackupPolicy();
  const warnings = [];

  if (!policy.automatic_enabled) {
    warnings.push("No hay programación automática configurada; los respaldos quedan en modo manual.");
  }
  if (policy.keep < 7) {
    warnings.push("La retención configurada es menor a 7 respaldos.");
  }

  return makeCheck({
    key: "backup_policy",
    label: "Política de respaldos",
    area: "RESPALDOS",
    status: warnings.length ? "WARNING" : "OK",
    level: warnings.length ? "WARNING" : "INFO",
    message: warnings.length
      ? warnings.join(" ")
      : "Política de respaldo y retención configurada.",
    details: policy,
  });
}

async function checkRecentValidatedBackup() {
  const backups = await listProductionBackups({ limit: 10 });
  const validBackup = backups.find((backup) => {
    const status = String(backup.status || "").toUpperCase();
    const integrity = String(backup.integrity_status || "").toUpperCase();
    return status === "OK" && (!integrity || integrity === "OK") && Number(backup.size_bytes || 0) > 0;
  });

  const lastBackup = backups[0] || null;
  const restoreTested = backups.find((backup) => Boolean(backup.restore_tested_at));

  let status = "OK";
  let message = "Existe al menos un respaldo reciente validado.";

  if (!validBackup) {
    status = "CRITICAL";
    message = "No se encontró un respaldo OK validado. Genera uno antes de publicar.";
  } else if (!restoreTested) {
    status = "WARNING";
    message = "Hay respaldo válido, pero falta registrar una prueba de restauración manual.";
  }

  return makeCheck({
    key: "recent_valid_backup",
    label: "Último respaldo validado",
    area: "RESPALDOS",
    status,
    level: status === "CRITICAL" ? "CRITICAL" : status === "WARNING" ? "WARNING" : "INFO",
    message,
    details: {
      last_backup: lastBackup,
      valid_backup: validBackup || null,
      restore_tested_backup: restoreTested || null,
    },
  });
}

function checkEnvVariables() {
  const snapshot = getProductionEnvSnapshot();
  const missingCritical = snapshot.required.filter(
    (item) => item.level === "CRITICAL" && !item.configured
  );
  const missingWarnings = snapshot.required.filter(
    (item) => item.level !== "CRITICAL" && !item.configured
  );

  const status = missingCritical.length ? "CRITICAL" : missingWarnings.length ? "WARNING" : "OK";

  return makeCheck({
    key: "env_required",
    label: "Variables de entorno críticas",
    area: "CONFIGURACION",
    status,
    level: missingCritical.length ? "CRITICAL" : "INFO",
    message: missingCritical.length
      ? `Faltan ${missingCritical.length} variables críticas.`
      : missingWarnings.length
        ? `Faltan ${missingWarnings.length} variables recomendadas.`
        : "Variables críticas configuradas.",
    details: snapshot,
  });
}

function checkNodeEnv() {
  const nodeEnv = process.env.NODE_ENV || "development";
  return makeCheck({
    key: "node_env",
    label: "Modo de ejecución NODE_ENV",
    area: "CONFIGURACION",
    status: nodeEnv === "production" ? "OK" : "WARNING",
    level: nodeEnv === "production" ? "INFO" : "WARNING",
    message: nodeEnv === "production"
      ? "Backend corriendo en modo production."
      : `Backend corriendo en modo ${nodeEnv}; para producción debe ser production.`,
    details: { node_env: nodeEnv },
  });
}

function checkJwtSecretStrength() {
  const snapshot = getProductionConfigSnapshot();
  const { configured, length, strong } = snapshot.jwt_secret;

  return makeCheck({
    key: "jwt_secret_strength",
    label: "Fortaleza JWT_SECRET",
    area: "SEGURIDAD",
    status: !configured ? "CRITICAL" : strong ? "OK" : "WARNING",
    level: !configured ? "CRITICAL" : strong ? "INFO" : "WARNING",
    message: !configured
      ? "JWT_SECRET no está configurado."
      : strong
        ? "JWT_SECRET tiene longitud adecuada para producción."
        : "JWT_SECRET debe tener al menos 32 caracteres aleatorios.",
    details: {
      configured,
      length,
      min_length: 32,
      recommendation: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    },
  });
}

function checkCorsConfiguration() {
  const snapshot = getProductionConfigSnapshot();
  const origins = snapshot.allowed_cors_origins || [];
  const hasWildcard = origins.includes("*") || process.env.CORS_ORIGIN === "*" || process.env.CORS_ORIGINS === "*";
  const hasLocalhost = origins.some((origin) => /localhost|127\.0\.0\.1/i.test(origin));
  const isProduction = snapshot.is_production;

  let status = "OK";
  let message = "CORS configurado con dominios permitidos.";

  if (!origins.length) {
    status = "CRITICAL";
    message = "No hay dominios permitidos para CORS en producción.";
  } else if (hasWildcard) {
    status = "CRITICAL";
    message = "CORS no debe usar '*' en producción.";
  } else if (isProduction && hasLocalhost) {
    status = "WARNING";
    message = "CORS todavía incluye localhost/127.0.0.1 en modo producción.";
  }

  return makeCheck({
    key: "cors_allowed_origins",
    label: "CORS y dominios permitidos",
    area: "CONFIGURACION",
    status,
    level: status === "CRITICAL" ? "CRITICAL" : status === "WARNING" ? "WARNING" : "INFO",
    message,
    details: {
      configured_from_env: snapshot.cors_origin_configured,
      allowed_origins: origins,
      has_localhost: hasLocalhost,
      has_wildcard: hasWildcard,
    },
  });
}

function checkPublicUrls() {
  const snapshot = getProductionConfigSnapshot();
  const urls = snapshot.public_urls || {};
  const missing = [];
  const invalid = [];

  if (!urls.frontendUrl) missing.push("FRONTEND_URL/PUBLIC_FRONTEND_URL/NEXT_PUBLIC_SITE_URL");
  if (!urls.backendUrl) missing.push("BACKEND_URL/PUBLIC_BACKEND_URL/NEXT_PUBLIC_API_URL");
  if (!urls.siteUrl) missing.push("NEXT_PUBLIC_SITE_URL/SITE_URL");

  for (const [key, value] of Object.entries(urls)) {
    if (value && !isValidPublicHttpUrl(value)) invalid.push(key);
  }

  const status = missing.length || invalid.length ? "WARNING" : "OK";

  return makeCheck({
    key: "public_urls",
    label: "URLs públicas finales",
    area: "CONFIGURACION",
    status,
    level: status === "OK" ? "INFO" : "WARNING",
    message: status === "OK"
      ? "URLs públicas configuradas con formato válido."
      : "Faltan URLs públicas o requieren validación antes de publicar.",
    details: {
      public_urls: urls,
      missing,
      invalid,
    },
  });
}

function checkCloudinaryConfiguration() {
  const snapshot = getProductionConfigSnapshot();
  const cloudinary = snapshot.cloudinary;
  const missing = Object.entries(cloudinary)
    .filter(([key, value]) => key !== "fully_configured" && !value)
    .map(([key]) => key);

  return makeCheck({
    key: "cloudinary_config",
    label: "Cloudinary configurado",
    area: "MULTIMEDIA",
    status: cloudinary.fully_configured ? "OK" : "CRITICAL",
    level: cloudinary.fully_configured ? "INFO" : "CRITICAL",
    message: cloudinary.fully_configured
      ? "Cloudinary tiene las credenciales necesarias."
      : "Faltan credenciales de Cloudinary para administrar multimedia.",
    details: {
      ...cloudinary,
      missing,
    },
  });
}

function checkAiProviderConfiguration() {
  const snapshot = getProductionConfigSnapshot();
  const configured = snapshot.ai_provider_count || 0;

  return makeCheck({
    key: "ai_provider_config",
    label: "Proveedor IA configurado",
    area: "IA",
    status: configured ? "OK" : "WARNING",
    level: configured ? "INFO" : "WARNING",
    message: configured
      ? `${configured} proveedor(es) IA configurado(s).`
      : "No se detectó proveedor IA. El buscador inteligente debe degradar a modo local/controlado.",
    details: {
      providers: snapshot.ai_providers,
      configured_count: configured,
    },
  });
}

function checkProductionCleanMode() {
  const snapshot = getProductionConfigSnapshot();
  const warnings = [];

  if (!snapshot.is_production) warnings.push("NODE_ENV no es production.");
  if ((process.env.LOG_SQL || "").toLowerCase() === "true") warnings.push("LOG_SQL está activo.");
  if ((process.env.DEBUG || "").trim()) warnings.push("DEBUG está configurado.");
  if ((process.env.CORS_ORIGIN || process.env.CORS_ORIGINS || "").includes("localhost")) warnings.push("CORS incluye localhost.");

  return makeCheck({
    key: "production_clean_mode",
    label: "Modo producción limpio",
    area: "CONFIGURACION",
    status: warnings.length ? "WARNING" : "OK",
    level: warnings.length ? "WARNING" : "INFO",
    message: warnings.length
      ? "Hay señales de configuración local/desarrollo activas."
      : "No se detectaron flags obvios de desarrollo en producción.",
    details: { warnings },
  });
}

export async function runProductionChecks({ admin = null, persist = false } = {}) {
  const checks = [];

  checks.push(checkEnvVariables());
  checks.push(checkNodeEnv());
  checks.push(checkJwtSecretStrength());
  checks.push(checkCorsConfiguration());
  checks.push(checkPublicUrls());
  checks.push(checkCloudinaryConfiguration());
  checks.push(checkAiProviderConfiguration());
  checks.push(checkProductionCleanMode());
  checks.push(checkBackupPolicy());

  const asyncChecks = [
    checkDatabase,
    checkCriticalTables,
    checkCoreCounters,
    checkBackupDirectory,
    checkMysqldump,
    checkRecentValidatedBackup,
  ];

  for (const fn of asyncChecks) {
    try {
      checks.push(await fn());
    } catch (error) {
      checks.push(
        makeCheck({
          key: fn.name,
          label: fn.name,
          area: "SISTEMA",
          status: "CRITICAL",
          level: "CRITICAL",
          message: error?.message || "No se pudo ejecutar la revisión.",
          details: null,
        })
      );
    }
  }

  const total = checks.length;
  const ok = checks.filter((item) => item.status === "OK").length;
  const warning = checks.filter((item) => item.status === "WARNING").length;
  const critical = checks.filter((item) => item.status === "CRITICAL").length;
  const status = critical ? "CRITICAL" : warning ? "WARNING" : "OK";

  const result = {
    status,
    total_checks: total,
    ok_checks: ok,
    warning_checks: warning,
    critical_checks: critical,
    generated_at: new Date().toISOString(),
    checks,
  };

  if (persist) {
    await saveProductionCheckRun(result, admin).catch(() => null);
  }

  return result;
}

async function saveProductionCheckRun(result, admin) {
  await pool.query(
    `
    INSERT INTO admin_production_check_runs
      (status, total_checks, ok_checks, warning_checks, critical_checks, metadata_json, created_by_admin_id, created_by_nombre)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      result.status,
      result.total_checks,
      result.ok_checks,
      result.warning_checks,
      result.critical_checks,
      JSON.stringify(result),
      admin?.id || null,
      admin?.nombre || null,
    ]
  );
}

async function insertBackupLog({
  status,
  filename,
  filepath,
  sizeBytes,
  dbName,
  backupType = "MANUAL",
  startedAt,
  finishedAt,
  durationMs,
  errorMessage,
  checksumSha256 = null,
  integrityStatus = null,
  integrityMessage = null,
  metadata = null,
  admin,
}) {
  const columns = await getBackupLogColumns().catch(() => new Set());

  const insertColumns = [
    "status",
    "filename",
    "filepath",
    "size_bytes",
    "db_name",
    "backup_type",
    "started_at",
    "finished_at",
    "duration_ms",
    "error_message",
    "created_by_admin_id",
    "created_by_nombre",
  ];
  const values = [
    status,
    filename || null,
    filepath || null,
    sizeBytes || null,
    dbName || null,
    backupType,
    mysqlDateTime(startedAt),
    finishedAt ? mysqlDateTime(finishedAt) : null,
    durationMs || null,
    errorMessage || null,
    admin?.id || null,
    admin?.nombre || null,
  ];

  const optionalValues = {
    checksum_sha256: checksumSha256,
    integrity_status: integrityStatus,
    integrity_message: integrityMessage,
    metadata_json: metadata ? JSON.stringify(metadata) : null,
  };

  for (const column of BACKUP_LOG_OPTIONAL_COLUMNS) {
    if (!hasOptionalColumn(columns, column)) continue;
    if (!(column in optionalValues)) continue;
    insertColumns.push(column);
    values.push(optionalValues[column]);
  }

  const placeholders = insertColumns.map(() => "?").join(", ");
  await pool.query(
    `
    INSERT INTO admin_production_backup_logs
      (${insertColumns.join(", ")})
    VALUES (${placeholders})
    `,
    values
  );
}

export async function listProductionBackups({ limit = 50 } = {}) {
  try {
    const columns = await getBackupLogColumns().catch(() => new Set());
    const optionalSelect = BACKUP_LOG_OPTIONAL_COLUMNS
      .filter((column) => hasOptionalColumn(columns, column))
      .map((column) => `        ${column},`)
      .join("\n");

    const [rows] = await pool.query(
      `
      SELECT
        id,
        status,
        filename,
        filepath,
        size_bytes,
        db_name,
        backup_type,
        started_at,
        finished_at,
        duration_ms,
        error_message,
${optionalSelect ? `${optionalSelect}\n` : ""}        created_by_nombre,
        created_at
      FROM admin_production_backup_logs
      ORDER BY id DESC
      LIMIT ?
      `,
      [Math.max(1, Math.min(Number(limit) || 50, 200))]
    );

    return (rows || []).map((row) => ({
      checksum_sha256: null,
      integrity_status: null,
      integrity_message: null,
      restore_tested_at: null,
      restore_tested_by_nombre: null,
      restore_notes: null,
      metadata: parseJsonSafe(row.metadata_json, null),
      ...row,
    }));
  } catch {
    return [];
  }
}

export async function createManualDatabaseBackup({ admin = null } = {}) {
  const config = getDbConfig();
  const backupDir = getBackupDir();
  await fsp.mkdir(backupDir, { recursive: true });

  const startedAt = new Date();
  const filename = `${config.database}_${nowIsoForFilename()}.sql`;
  const filepath = path.join(backupDir, filename);

  const args = [
    "--single-transaction",
    "--routines",
    "--triggers",
    "--events",
    "--default-character-set=utf8mb4",
    "-h",
    config.host,
    "-P",
    String(config.port || "3307"),
    "-u",
    config.user,
  ];

  if (config.password) {
    args.push(`--password=${config.password}`);
  }

  args.push(config.database);

  const output = fs.createWriteStream(filepath, { flags: "w" });
  const startedMs = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(config.mysqldumpPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stderr = "";

    child.stdout.pipe(output);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", async (error) => {
      output.close();
      await fsp.unlink(filepath).catch(() => null);
      const finishedAt = new Date();
      const durationMs = Date.now() - startedMs;
      const message = error?.message || "No se pudo ejecutar mysqldump.";
      await insertBackupLog({
        status: "ERROR",
        filename,
        filepath,
        dbName: config.database,
        startedAt,
        finishedAt,
        durationMs,
        errorMessage: message,
        admin,
      }).catch(() => null);
      reject(new Error(message));
    });

    child.on("close", async (code) => {
      output.close();
      const finishedAt = new Date();
      const durationMs = Date.now() - startedMs;

      if (code !== 0) {
        await fsp.unlink(filepath).catch(() => null);
        const message = stderr || `mysqldump finalizó con código ${code}.`;
        await insertBackupLog({
          status: "ERROR",
          filename,
          filepath,
          dbName: config.database,
          startedAt,
          finishedAt,
          durationMs,
          errorMessage: message.slice(0, 2000),
          admin,
        }).catch(() => null);
        reject(new Error(message));
        return;
      }

      const policy = getBackupPolicy();
      const integrity = await validateBackupFile(filepath, { minBytes: policy.min_bytes });
      const result = {
        status: integrity.status,
        filename,
        filepath,
        size_bytes: integrity.size_bytes,
        db_name: config.database,
        checksum_sha256: integrity.checksum_sha256,
        integrity_status: integrity.status,
        integrity_message: integrity.message,
        integrity_checks: integrity.checks,
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: durationMs,
      };

      await insertBackupLog({
        status: integrity.status,
        filename,
        filepath,
        sizeBytes: integrity.size_bytes,
        dbName: config.database,
        backupType: "MANUAL",
        startedAt,
        finishedAt,
        durationMs,
        checksumSha256: integrity.checksum_sha256,
        integrityStatus: integrity.status,
        integrityMessage: integrity.message,
        metadata: {
          integrity_checks: integrity.checks,
          min_bytes: policy.min_bytes,
          source: "createManualDatabaseBackup",
        },
        admin,
      }).catch(() => null);

      resolve(result);
    });
  });
}

export async function cleanOldProductionBackups({ keep = 15 } = {}) {
  const backupDir = getBackupDir();
  await fsp.mkdir(backupDir, { recursive: true });
  const files = await fsp.readdir(backupDir).catch(() => []);

  const sqlFiles = [];
  for (const file of files) {
    if (!file.endsWith(".sql")) continue;
    const filepath = path.join(backupDir, file);
    const stat = await fsp.stat(filepath).catch(() => null);
    if (!stat) continue;
    sqlFiles.push({ file, filepath, mtimeMs: stat.mtimeMs, size: stat.size });
  }

  sqlFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const normalizedKeep = Math.max(1, Math.min(Number(keep) || 15, 100));
  const toDelete = sqlFiles.slice(normalizedKeep);

  for (const item of toDelete) {
    await fsp.unlink(item.filepath).catch(() => null);
  }

  return {
    kept: sqlFiles.length - toDelete.length,
    deleted: toDelete.length,
    deleted_files: toDelete.map((item) => item.file),
  };
}

export function getProductionBackupPolicy() {
  return getBackupPolicy();
}

export async function validateProductionBackup({ id = null, filename = "" } = {}) {
  let backup = null;
  const normalizedId = Number(id || 0);

  if (normalizedId) {
    const backups = await listProductionBackups({ limit: 200 });
    backup = backups.find((item) => Number(item.id) === normalizedId) || null;
  } else if (filename) {
    const backups = await listProductionBackups({ limit: 200 });
    backup = backups.find((item) => item.filename === filename) || null;
  }

  if (!backup?.filepath) {
    const error = new Error("No se encontró el respaldo solicitado o no tiene ruta registrada.");
    error.status = 404;
    throw error;
  }

  const policy = getBackupPolicy();
  const integrity = await validateBackupFile(backup.filepath, { minBytes: policy.min_bytes });
  const columns = await getBackupLogColumns().catch(() => new Set());

  if (normalizedId && hasOptionalColumn(columns, "integrity_status")) {
    const assignments = ["status = ?", "size_bytes = ?", "integrity_status = ?"];
    const values = [integrity.status, integrity.size_bytes, integrity.status];

    if (hasOptionalColumn(columns, "checksum_sha256")) {
      assignments.push("checksum_sha256 = ?");
      values.push(integrity.checksum_sha256);
    }
    if (hasOptionalColumn(columns, "integrity_message")) {
      assignments.push("integrity_message = ?");
      values.push(integrity.message);
    }
    if (hasOptionalColumn(columns, "metadata_json")) {
      assignments.push("metadata_json = ?");
      values.push(JSON.stringify({
        ...(backup.metadata || {}),
        integrity_checks: integrity.checks,
        validated_at: new Date().toISOString(),
      }));
    }

    values.push(normalizedId);
    await pool.query(
      `UPDATE admin_production_backup_logs SET ${assignments.join(", ")} WHERE id = ? LIMIT 1`,
      values
    );
  }

  return {
    backup_id: backup.id,
    filename: backup.filename,
    filepath: backup.filepath,
    ...integrity,
    policy,
    schema_supports_persisted_integrity: hasOptionalColumn(columns, "integrity_status"),
  };
}

export async function markProductionBackupRestoreTested({ id, payload = {}, admin = null } = {}) {
  const backupId = Number(id || 0);
  if (!backupId) {
    const error = new Error("ID de respaldo inválido.");
    error.status = 400;
    throw error;
  }

  const confirmacion = String(payload?.confirmacion || "").trim().toUpperCase();
  if (confirmacion !== "RESTAURACION PROBADA") {
    const error = new Error("Confirmación inválida. Escribe RESTAURACION PROBADA.");
    error.status = 400;
    throw error;
  }

  const columns = await getBackupLogColumns().catch(() => new Set());
  const requiredColumns = ["restore_tested_at", "restore_tested_by_admin_id", "restore_tested_by_nombre", "restore_notes"];
  const missing = requiredColumns.filter((column) => !hasOptionalColumn(columns, column));

  if (missing.length) {
    const error = new Error("La tabla de respaldos no tiene columnas para registrar prueba de restauración. Aplica el script SQL M12.1D incluido.");
    error.status = 409;
    error.details = { missing_columns: missing };
    throw error;
  }

  const notes = normalizeTextValue(payload?.notas, 1200);
  const testedAt = payload?.tested_at ? new Date(payload.tested_at) : new Date();
  const safeTestedAt = Number.isNaN(testedAt.getTime()) ? new Date() : testedAt;

  const [result] = await pool.query(
    `
    UPDATE admin_production_backup_logs
    SET restore_tested_at = ?,
        restore_tested_by_admin_id = ?,
        restore_tested_by_nombre = ?,
        restore_notes = ?
    WHERE id = ?
    LIMIT 1
    `,
    [
      mysqlDateTime(safeTestedAt),
      admin?.id || null,
      admin?.nombre || null,
      notes || null,
      backupId,
    ]
  );

  if (!result?.affectedRows) {
    const error = new Error("Respaldo no encontrado.");
    error.status = 404;
    throw error;
  }

  return {
    id: backupId,
    restore_tested_at: safeTestedAt.toISOString(),
    restore_tested_by_nombre: admin?.nombre || null,
    restore_notes: notes || null,
  };
}

const DEPLOY_STATUSES = new Set([
  "BORRADOR",
  "EN_PROCESO",
  "LISTO",
  "DESPLEGADO",
  "BLOQUEADO",
  "CANCELADO",
]);

const DEPLOY_ITEM_STATUSES = new Set(["PENDIENTE", "OK", "BLOQUEADO", "NO_APLICA"]);

const DEFAULT_DEPLOY_ITEMS = [
  {
    key: "backup_before_deploy",
    titulo: "Respaldo previo generado y validado",
    descripcion: "Generar respaldo SQL, validar integridad/checksum y confirmar que quedó registrado en el historial.",
    grupo: "RESPALDOS",
    obligatorio: true,
    orden: 10,
  },
  {
    key: "backup_restore_tested",
    titulo: "Prueba de restauración documentada",
    descripcion: "Restaurar el respaldo en una base alterna y registrar la evidencia en Producción > Respaldos.",
    grupo: "RESPALDOS",
    obligatorio: true,
    orden: 15,
  },
  {
    key: "env_backend_validated",
    titulo: "Variables backend verificadas",
    descripcion: "Confirmar DB, JWT, CORS, Cloudinary, IA y rutas de respaldo.",
    grupo: "CONFIGURACION",
    obligatorio: true,
    orden: 20,
  },
  {
    key: "cors_security_validated",
    titulo: "CORS, Helmet y dominios definitivos",
    descripcion: "Confirmar dominios permitidos, headers Helmet, trust proxy y ausencia de localhost en producción.",
    grupo: "CONFIGURACION",
    obligatorio: true,
    orden: 25,
  },
  {
    key: "env_frontend_validated",
    titulo: "Variables frontend verificadas",
    descripcion: "Confirmar NEXT_PUBLIC_API_URL, NEXT_PUBLIC_SITE_URL y dominio público.",
    grupo: "CONFIGURACION",
    obligatorio: true,
    orden: 30,
  },
  {
    key: "migrations_applied",
    titulo: "Migraciones SQL aplicadas",
    descripcion: "Ejecutar scripts SQL pendientes y confirmar que las tablas críticas existen.",
    grupo: "BASE_DATOS",
    obligatorio: true,
    orden: 40,
  },
  {
    key: "backend_health_ok",
    titulo: "Backend health OK",
    descripcion: "Validar /api/health, conexión DB y endpoints admin esenciales.",
    grupo: "BACKEND",
    obligatorio: true,
    orden: 50,
  },
  {
    key: "admin_login_ok",
    titulo: "Login admin validado",
    descripcion: "Confirmar acceso admin, navegación interna y permisos ADMIN.",
    grupo: "ADMIN",
    obligatorio: true,
    orden: 60,
  },
  {
    key: "public_catalog_ok",
    titulo: "Catálogo público validado",
    descripcion: "Revisar home, catálogo, detalle de producto, imágenes y cotización.",
    grupo: "PUBLICO",
    obligatorio: true,
    orden: 70,
  },
  {
    key: "seo_routes_ok",
    titulo: "SEO técnico validado",
    descripcion: "Revisar robots.txt, sitemap.xml, landings por línea y metadata de producto.",
    grupo: "SEO",
    obligatorio: true,
    orden: 80,
  },
  {
    key: "analytics_tracking_ok",
    titulo: "Tracking comercial validado",
    descripcion: "Confirmar eventos de búsqueda, producto consultado, cotización y WhatsApp.",
    grupo: "ANALITICA",
    obligatorio: false,
    orden: 90,
  },
  {
    key: "post_deploy_smoke_test",
    titulo: "Prueba rápida post-deploy",
    descripcion: "Después de publicar, validar admin, home, catálogo, IA, cotización y contacto.",
    grupo: "CIERRE",
    obligatorio: true,
    orden: 100,
  },
];

function normalizeDeployStatus(value, fallback = "BORRADOR") {
  const status = String(value || "").trim().toUpperCase();
  return DEPLOY_STATUSES.has(status) ? status : fallback;
}

function normalizeDeployItemStatus(value, fallback = "PENDIENTE") {
  const status = String(value || "").trim().toUpperCase();
  return DEPLOY_ITEM_STATUSES.has(status) ? status : fallback;
}

function normalizeTextValue(value, maxLength = 500) {
  return String(value || "").trim().slice(0, maxLength);
}

function parseJsonSafe(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapDeployRun(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: parseJsonSafe(row.metadata_json, null),
  };
}

async function recalculateDeployCounters(connection, deployRunId) {
  const [rows] = await connection.query(
    `
    SELECT
      COUNT(*) AS total_items,
      SUM(CASE WHEN estado = 'OK' OR estado = 'NO_APLICA' THEN 1 ELSE 0 END) AS items_ok,
      SUM(CASE WHEN estado = 'PENDIENTE' THEN 1 ELSE 0 END) AS items_pendientes,
      SUM(CASE WHEN estado = 'BLOQUEADO' THEN 1 ELSE 0 END) AS items_bloqueados
    FROM admin_production_deploy_items
    WHERE deploy_run_id = ?
    `,
    [deployRunId]
  );

  const row = rows?.[0] || {};
  await connection.query(
    `
    UPDATE admin_production_deploy_runs
    SET total_items = ?, items_ok = ?, items_pendientes = ?, items_bloqueados = ?
    WHERE id = ?
    `,
    [
      Number(row.total_items || 0),
      Number(row.items_ok || 0),
      Number(row.items_pendientes || 0),
      Number(row.items_bloqueados || 0),
      deployRunId,
    ]
  );
}

export function getProductionDeployTemplate() {
  return DEFAULT_DEPLOY_ITEMS.map((item) => ({ ...item }));
}

export async function listProductionDeployRuns({ limit = 40 } = {}) {
  const [rows] = await pool.query(
    `
    SELECT
      id,
      titulo,
      version_label,
      ambiente,
      estado,
      resumen,
      notas,
      total_items,
      items_ok,
      items_pendientes,
      items_bloqueados,
      backup_log_id,
      check_run_id,
      metadata_json,
      started_at,
      finished_at,
      created_by_nombre,
      updated_by_nombre,
      created_at,
      updated_at
    FROM admin_production_deploy_runs
    ORDER BY id DESC
    LIMIT ?
    `,
    [Math.max(1, Math.min(Number(limit) || 40, 150))]
  );

  return (rows || []).map(mapDeployRun);
}

export async function getProductionDeployRun({ id }) {
  const deployId = Number(id);
  if (!deployId) return null;

  const [runs] = await pool.query(
    `
    SELECT
      id,
      titulo,
      version_label,
      ambiente,
      estado,
      resumen,
      notas,
      total_items,
      items_ok,
      items_pendientes,
      items_bloqueados,
      backup_log_id,
      check_run_id,
      metadata_json,
      started_at,
      finished_at,
      created_by_nombre,
      updated_by_nombre,
      created_at,
      updated_at
    FROM admin_production_deploy_runs
    WHERE id = ?
    LIMIT 1
    `,
    [deployId]
  );

  const deploy = mapDeployRun(runs?.[0]);
  if (!deploy) return null;

  const [items] = await pool.query(
    `
    SELECT
      id,
      deploy_run_id,
      item_key,
      titulo,
      descripcion,
      grupo,
      obligatorio,
      estado,
      orden,
      notas,
      checked_at,
      checked_by_nombre,
      created_at,
      updated_at
    FROM admin_production_deploy_items
    WHERE deploy_run_id = ?
    ORDER BY orden ASC, id ASC
    `,
    [deployId]
  );

  return {
    ...deploy,
    items: items || [],
  };
}

export async function createProductionDeployRun({ payload = {}, admin = null } = {}) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const titulo = normalizeTextValue(payload.titulo, 180) || `Despliegue ${new Date().toISOString().slice(0, 10)}`;
    const versionLabel = normalizeTextValue(payload.version_label, 80) || null;
    const ambiente = normalizeTextValue(payload.ambiente, 40).toUpperCase() || "PRODUCCION";
    const resumen = normalizeTextValue(payload.resumen, 1500) || null;
    const notas = normalizeTextValue(payload.notas, 3000) || null;
    const estado = normalizeDeployStatus(payload.estado, "BORRADOR");
    const metadata = {
      source: "ADMIN_PRODUCCION",
      created_from: "M12_PRODUCTION_CHECKLIST",
    };

    const [result] = await connection.query(
      `
      INSERT INTO admin_production_deploy_runs
        (titulo, version_label, ambiente, estado, resumen, notas, metadata_json, started_at, created_by_admin_id, created_by_nombre, updated_by_admin_id, updated_by_nombre)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        titulo,
        versionLabel,
        ambiente,
        estado,
        resumen,
        notas,
        JSON.stringify(metadata),
        estado === "EN_PROCESO" ? mysqlDateTime() : null,
        admin?.id || null,
        admin?.nombre || null,
        admin?.id || null,
        admin?.nombre || null,
      ]
    );

    const deployRunId = result.insertId;
    for (const item of DEFAULT_DEPLOY_ITEMS) {
      await connection.query(
        `
        INSERT INTO admin_production_deploy_items
          (deploy_run_id, item_key, titulo, descripcion, grupo, obligatorio, estado, orden)
        VALUES (?, ?, ?, ?, ?, ?, 'PENDIENTE', ?)
        `,
        [
          deployRunId,
          item.key,
          item.titulo,
          item.descripcion,
          item.grupo,
          item.obligatorio ? 1 : 0,
          item.orden,
        ]
      );
    }

    await recalculateDeployCounters(connection, deployRunId);
    await connection.commit();
    return getProductionDeployRun({ id: deployRunId });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function updateProductionDeployRunStatus({ id, payload = {}, admin = null } = {}) {
  const deployId = Number(id);
  if (!deployId) throw new Error("Despliegue inválido.");

  const estado = normalizeDeployStatus(payload.estado, "BORRADOR");
  const notas = payload.notas === undefined ? undefined : normalizeTextValue(payload.notas, 3000);

  const fields = ["estado = ?", "updated_by_admin_id = ?", "updated_by_nombre = ?"];
  const params = [estado, admin?.id || null, admin?.nombre || null];

  if (estado === "EN_PROCESO") fields.push("started_at = COALESCE(started_at, NOW())");
  if (["DESPLEGADO", "CANCELADO", "BLOQUEADO"].includes(estado)) fields.push("finished_at = COALESCE(finished_at, NOW())");
  if (estado === "BORRADOR") fields.push("finished_at = NULL");
  if (notas !== undefined) {
    fields.push("notas = ?");
    params.push(notas || null);
  }

  params.push(deployId);

  await pool.query(
    `UPDATE admin_production_deploy_runs SET ${fields.join(", ")} WHERE id = ?`,
    params
  );

  return getProductionDeployRun({ id: deployId });
}

export async function updateProductionDeployItem({ deployId, itemId, payload = {}, admin = null } = {}) {
  const normalizedDeployId = Number(deployId);
  const normalizedItemId = Number(itemId);

  if (!normalizedDeployId || !normalizedItemId) throw new Error("Item de despliegue inválido.");

  const estado = normalizeDeployItemStatus(payload.estado, "PENDIENTE");
  const notas = normalizeTextValue(payload.notas, 2000) || null;

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    await connection.query(
      `
      UPDATE admin_production_deploy_items
      SET
        estado = ?,
        notas = ?,
        checked_at = CASE WHEN ? IN ('OK','BLOQUEADO','NO_APLICA') THEN NOW() ELSE NULL END,
        checked_by_admin_id = CASE WHEN ? IN ('OK','BLOQUEADO','NO_APLICA') THEN ? ELSE NULL END,
        checked_by_nombre = CASE WHEN ? IN ('OK','BLOQUEADO','NO_APLICA') THEN ? ELSE NULL END
      WHERE id = ? AND deploy_run_id = ?
      `,
      [
        estado,
        notas,
        estado,
        estado,
        admin?.id || null,
        estado,
        admin?.nombre || null,
        normalizedItemId,
        normalizedDeployId,
      ]
    );

    await recalculateDeployCounters(connection, normalizedDeployId);
    await connection.commit();
    return getProductionDeployRun({ id: normalizedDeployId });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function getProductionDeployReadiness() {
  const [backups, deploys, checks] = await Promise.all([
    listProductionBackups({ limit: 1 }),
    listProductionDeployRuns({ limit: 1 }),
    runProductionChecks({ persist: false }),
  ]);

  const lastBackup = backups?.[0] || null;
  const lastDeploy = deploys?.[0] || null;
  const blockers = [];

  if (checks.critical_checks > 0) blockers.push("Hay checks críticos en producción.");
  if (!lastBackup || lastBackup.status !== "OK") blockers.push("No hay respaldo exitoso reciente registrado.");
  if (lastDeploy && ["BORRADOR", "EN_PROCESO", "BLOQUEADO"].includes(lastDeploy.estado)) {
    blockers.push(`Existe un despliegue abierto o bloqueado: ${lastDeploy.titulo}.`);
  }

  return {
    ready: blockers.length === 0,
    blockers,
    checks_status: checks.status,
    last_backup: lastBackup,
    last_deploy: lastDeploy,
    generated_at: new Date().toISOString(),
  };
}

