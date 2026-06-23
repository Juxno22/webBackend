import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { pool } from "../config/db.js";

const REQUIRED_ENV = [
  { key: "JWT_SECRET", level: "CRITICAL", label: "JWT_SECRET" },
  { key: "DB_HOST", level: "CRITICAL", label: "DB_HOST" },
  { key: "DB_USER", level: "CRITICAL", label: "DB_USER" },
  { key: "DB_NAME", level: "CRITICAL", label: "DB_NAME" },
  { key: "CORS_ORIGIN", level: "WARNING", label: "CORS_ORIGIN" },
];

const OPTIONAL_ENV = [
  { key: "DB_PORT", label: "DB_PORT" },
  { key: "DB_CONNECTION_LIMIT", label: "DB_CONNECTION_LIMIT" },
  { key: "FRONTEND_URL", label: "FRONTEND_URL" },
  { key: "NEXT_PUBLIC_API_URL", label: "NEXT_PUBLIC_API_URL" },
  { key: "NEXT_PUBLIC_SITE_URL", label: "NEXT_PUBLIC_SITE_URL" },
  { key: "CLOUDINARY_CLOUD_NAME", label: "CLOUDINARY_CLOUD_NAME" },
  { key: "CLOUDINARY_API_KEY", label: "CLOUDINARY_API_KEY" },
  { key: "CLOUDINARY_API_SECRET", label: "CLOUDINARY_API_SECRET" },
  { key: "OPENROUTER_API_KEY", label: "OPENROUTER_API_KEY" },
  { key: "MYSQLDUMP_PATH", label: "MYSQLDUMP_PATH" },
  { key: "PRODUCTION_BACKUP_DIR", label: "PRODUCTION_BACKUP_DIR" },
];

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
    db_host: dbConfig.host,
    db_port: dbConfig.port,
    db_name: dbConfig.database,
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

export async function runProductionChecks({ admin = null, persist = false } = {}) {
  const checks = [];

  checks.push(checkEnvVariables());
  checks.push(checkNodeEnv());

  const asyncChecks = [
    checkDatabase,
    checkCriticalTables,
    checkCoreCounters,
    checkBackupDirectory,
    checkMysqldump,
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

async function insertBackupLog({ status, filename, filepath, sizeBytes, dbName, startedAt, finishedAt, durationMs, errorMessage, admin }) {
  await pool.query(
    `
    INSERT INTO admin_production_backup_logs
      (status, filename, filepath, size_bytes, db_name, backup_type, started_at, finished_at, duration_ms, error_message, created_by_admin_id, created_by_nombre)
    VALUES (?, ?, ?, ?, ?, 'MANUAL', ?, ?, ?, ?, ?, ?)
    `,
    [
      status,
      filename || null,
      filepath || null,
      sizeBytes || null,
      dbName || null,
      mysqlDateTime(startedAt),
      finishedAt ? mysqlDateTime(finishedAt) : null,
      durationMs || null,
      errorMessage || null,
      admin?.id || null,
      admin?.nombre || null,
    ]
  );
}

export async function listProductionBackups({ limit = 50 } = {}) {
  try {
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
        created_by_nombre,
        created_at
      FROM admin_production_backup_logs
      ORDER BY id DESC
      LIMIT ?
      `,
      [Math.max(1, Math.min(Number(limit) || 50, 200))]
    );

    return rows || [];
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

      const stat = await fsp.stat(filepath);
      const result = {
        status: "OK",
        filename,
        filepath,
        size_bytes: stat.size,
        db_name: config.database,
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: durationMs,
      };

      await insertBackupLog({
        status: "OK",
        filename,
        filepath,
        sizeBytes: stat.size,
        dbName: config.database,
        startedAt,
        finishedAt,
        durationMs,
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
    titulo: "Respaldo previo generado",
    descripcion: "Generar o validar un respaldo SQL antes de tocar producción.",
    grupo: "RESPALDOS",
    obligatorio: true,
    orden: 10,
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
      created_from: "M12_1B_DEPLOY_CHECKLIST",
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

