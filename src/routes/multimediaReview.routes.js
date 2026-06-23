import { Router } from "express";
import multer from "multer";
import { pool } from "../config/db.js";
import { requireAdminAuth, requireRole } from "../middleware/authAdmin.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const reviewAccess = [requireAdminAuth, requireRole(["ADMIN", "VENTAS", "COMPRAS"])] ;

const VALID_ITEM_REVISION = new Set([
  "PENDIENTE",
  "REVISAR",
  "CREAR_PRODUCTO",
  "SOLICITAR_IMAGEN",
  "SOLICITAR_CRUCE",
  "DESCARTADO",
  "RESUELTO",
  "PENDIENTE_GENERADO",
]);

function cleanString(value, maxLength = 320) {
  if (value === undefined || value === null) return "";

  return String(value).trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function cleanText(value, maxLength = 12000) {
  if (value === undefined || value === null) return "";

  return String(value).trim().slice(0, maxLength);
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

function parsePositiveInt(value, fallback = 50, max = 1000) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;

  return Math.min(parsed, max);
}

function parseOptionalInt(value) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) return null;

  return parsed;
}

function getUserLabel(req) {
  return (
    cleanString(req.user?.nombre, 160) ||
    cleanString(req.user?.email, 160) ||
    cleanString(req.user?.usuario, 160) ||
    "ADMIN"
  );
}

function normalizeCsvHeader(value) {
  return cleanString(value, 120)
    .replace(/^\uFEFF/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function detectDelimiter(text) {
  const firstLine = String(text || "").split(/\r?\n/).find((line) => line.trim()) || "";
  const candidates = [",", "\t", ";"];

  let best = ",";
  let bestCount = -1;

  for (const delimiter of candidates) {
    const count = firstLine.split(delimiter).length;

    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }

  return best;
}

function parseDelimitedLine(line, delimiter) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values.map((value) => value.trim());
}

function parseCsvText(text) {
  const clean = String(text || "").replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(clean);
  const lines = clean.split(/\r?\n/).filter((line) => line.trim() !== "");

  if (lines.length < 2) return [];

  const headers = parseDelimitedLine(lines[0], delimiter).map(normalizeCsvHeader);

  return lines.slice(1).map((line) => {
    const values = parseDelimitedLine(line, delimiter);
    const row = {};

    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });

    return row;
  });
}

function pick(row, keys, maxLength = 320) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      const value = cleanString(row[key], maxLength);

      if (value) return value;
    }
  }

  return "";
}

function mapReportRow(row) {
  const estado = normalizeKey(pick(row, ["estado", "status"], 60) || "NO_ENCONTRADO", 60);

  return {
    archivo: pick(row, ["archivo", "filename", "nombre_archivo"], 260),
    codigo_archivo: pick(row, ["codigo_archivo", "codigo", "codigo_base"], 120),
    codigo_archivo_original: pick(row, ["codigo_archivo_original", "codigo_original"], 120),
    codigo_catalogo: pick(row, ["codigo_catalogo", "catalogo"], 120),
    folder_prefix: pick(row, ["folder_prefix", "prefijo", "prefix"], 40),
    orden: Number.parseInt(pick(row, ["orden", "order"], 20) || "1", 10) || 1,
    rol: pick(row, ["rol", "role"], 40),
    candidatos: cleanText(pick(row, ["candidatos", "candidates"], 8000), 8000),
    estado,
    producto_id: parseOptionalInt(pick(row, ["producto_id", "id_producto"], 40)),
    codigo_andyfers: pick(row, ["codigo_andyfers", "codigo_sistema"], 80),
    codigo_importacion: pick(row, ["codigo_importacion", "codigo_import"], 80),
    familia: pick(row, ["familia"], 160),
    descripcion: cleanText(pick(row, ["descripcion", "description"], 4000), 4000),
    mensaje: cleanText(pick(row, ["mensaje", "message", "observacion"], 4000), 4000),
  };
}

function summarizeItems(items) {
  const summary = {
    total_items: items.length,
    total_match_unico: 0,
    total_ambiguo: 0,
    total_no_encontrado: 0,
    total_subido: 0,
    total_error: 0,
  };

  items.forEach((item) => {
    if (item.estado === "MATCH_UNICO") summary.total_match_unico += 1;
    if (item.estado === "AMBIGUO") summary.total_ambiguo += 1;
    if (item.estado === "NO_ENCONTRADO") summary.total_no_encontrado += 1;
    if (item.estado === "SUBIDO") summary.total_subido += 1;
    if (item.estado === "ERROR") summary.total_error += 1;
  });

  return summary;
}

function csvEscape(value) {
  const clean = value === undefined || value === null ? "" : String(value);

  return `"${clean.replace(/"/g, '""')}"`;
}

function buildExportCsv(rows) {
  const headers = [
    "archivo",
    "codigo_archivo",
    "codigo_archivo_original",
    "codigo_catalogo",
    "folder_prefix",
    "orden",
    "rol",
    "candidatos",
    "estado",
    "revision_estado",
    "producto_id",
    "codigo_andyfers",
    "codigo_importacion",
    "familia",
    "descripcion",
    "mensaje",
    "nota_revision",
  ];

  const lines = [headers.map(csvEscape).join(",")];

  rows.forEach((row) => {
    lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  });

  return `\uFEFF${lines.join("\n")}`;
}

function buildItemsWhere(query = {}) {
  const clauses = ["mmi.reporte_id = ?"];
  const params = [parseOptionalInt(query.reporte_id || query.id)];

  const estado = normalizeKey(query.estado, 60);
  const revision = normalizeKey(query.revision_estado, 60);
  const prefix = normalizeKey(query.folder_prefix, 40);
  const q = cleanString(query.q, 160);

  if (estado) {
    clauses.push("mmi.estado = ?");
    params.push(estado);
  }

  if (revision) {
    clauses.push("mmi.revision_estado = ?");
    params.push(revision);
  }

  if (prefix) {
    clauses.push("mmi.folder_prefix = ?");
    params.push(prefix);
  }

  if (q) {
    clauses.push(`
      (
        mmi.archivo LIKE ?
        OR mmi.codigo_archivo LIKE ?
        OR mmi.codigo_archivo_original LIKE ?
        OR mmi.codigo_catalogo LIKE ?
        OR mmi.codigo_andyfers LIKE ?
        OR mmi.codigo_importacion LIKE ?
        OR mmi.familia LIKE ?
        OR mmi.descripcion LIKE ?
        OR mmi.mensaje LIKE ?
      )
    `);

    const like = `%${q}%`;
    params.push(like, like, like, like, like, like, like, like, like);
  }

  return { clauses, params };
}

router.get("/admin/multimedia-macheo/resumen", reviewAccess, async (req, res, next) => {
  try {
    const [reportRows] = await pool.query(
      `
      SELECT
        COUNT(*) AS total_reportes,
        COALESCE(SUM(total_items), 0) AS total_items,
        COALESCE(SUM(total_match_unico), 0) AS total_match_unico,
        COALESCE(SUM(total_ambiguo), 0) AS total_ambiguo,
        COALESCE(SUM(total_no_encontrado), 0) AS total_no_encontrado,
        COALESCE(SUM(total_subido), 0) AS total_subido,
        COALESCE(SUM(total_error), 0) AS total_error
      FROM multimedia_macheo_reportes
      `
    );

    const [itemRows] = await pool.query(
      `
      SELECT
        SUM(CASE WHEN revision_estado = 'PENDIENTE' THEN 1 ELSE 0 END) AS pendientes_revision,
        SUM(CASE WHEN revision_estado = 'PENDIENTE_GENERADO' THEN 1 ELSE 0 END) AS pendientes_generados,
        SUM(CASE WHEN estado = 'MATCH_UNICO' AND producto_id IS NOT NULL THEN 1 ELSE 0 END) AS listos_subir,
        SUM(CASE WHEN estado IN ('NO_ENCONTRADO', 'AMBIGUO', 'ERROR') THEN 1 ELSE 0 END) AS requieren_revision
      FROM multimedia_macheo_items
      `
    );

    res.json({
      ok: true,
      data: {
        ...(reportRows[0] || {}),
        ...(itemRows[0] || {}),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/multimedia-macheo/reportes", reviewAccess, async (req, res, next) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 50, 200);

    const [rows] = await pool.query(
      `
      SELECT
        id,
        nombre,
        archivo_nombre,
        fuente,
        total_items,
        total_match_unico,
        total_ambiguo,
        total_no_encontrado,
        total_subido,
        total_error,
        notas,
        uploaded_by,
        created_at,
        updated_at
      FROM multimedia_macheo_reportes
      ORDER BY created_at DESC, id DESC
      LIMIT ?
      `,
      [limit]
    );

    res.json({ ok: true, data: rows });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/multimedia-macheo/reportes/:id", reviewAccess, async (req, res, next) => {
  try {
    const id = parseOptionalInt(req.params.id);

    if (!id) {
      return res.status(400).json({ ok: false, error: "ID inválido." });
    }

    const limit = parsePositiveInt(req.query.limit, 200, 1000);
    const offset = Math.max(Number.parseInt(req.query.offset || "0", 10) || 0, 0);

    const [reports] = await pool.query(
      `SELECT * FROM multimedia_macheo_reportes WHERE id = ? LIMIT 1`,
      [id]
    );

    const reporte = reports[0];

    if (!reporte) {
      return res.status(404).json({ ok: false, error: "Reporte no encontrado." });
    }

    const where = buildItemsWhere({ ...req.query, reporte_id: id });

    const [items] = await pool.query(
      `
      SELECT *
      FROM multimedia_macheo_items mmi
      WHERE ${where.clauses.join(" AND ")}
      ORDER BY
        CASE estado
          WHEN 'NO_ENCONTRADO' THEN 1
          WHEN 'AMBIGUO' THEN 2
          WHEN 'ERROR' THEN 3
          WHEN 'MATCH_UNICO' THEN 4
          WHEN 'SUBIDO' THEN 5
          ELSE 6
        END,
        folder_prefix ASC,
        codigo_archivo ASC,
        orden ASC,
        archivo ASC
      LIMIT ? OFFSET ?
      `,
      [...where.params, limit, offset]
    );

    const [countRows] = await pool.query(
      `
      SELECT COUNT(*) AS total
      FROM multimedia_macheo_items mmi
      WHERE ${where.clauses.join(" AND ")}
      `,
      where.params
    );

    const [statusRows] = await pool.query(
      `
      SELECT estado, COUNT(*) AS total
      FROM multimedia_macheo_items
      WHERE reporte_id = ?
      GROUP BY estado
      ORDER BY total DESC
      `,
      [id]
    );

    res.json({
      ok: true,
      data: {
        reporte,
        items,
        total: countRows[0]?.total || 0,
        resumen_estados: statusRows,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/admin/multimedia-macheo/reportes/upload",
  reviewAccess,
  upload.single("file"),
  async (req, res, next) => {
    const connection = await pool.getConnection();

    try {
      const csvText = req.file?.buffer?.toString("utf8") || cleanText(req.body.csv_text, 2500000);

      if (!csvText) {
        return res.status(400).json({
          ok: false,
          error: "Sube un CSV o envía csv_text.",
        });
      }

      const parsedRows = parseCsvText(csvText).map(mapReportRow).filter((row) => row.archivo);

      if (!parsedRows.length) {
        return res.status(400).json({
          ok: false,
          error: "El CSV no contiene filas válidas.",
        });
      }

      const summary = summarizeItems(parsedRows);
      const nombre = cleanString(req.body.nombre, 220) || `Reporte multimedia ${new Date().toISOString().slice(0, 10)}`;
      const archivoNombre = cleanString(req.file?.originalname || req.body.archivo_nombre, 260) || "reporte_multimedia.csv";

      await connection.beginTransaction();

      const [reportResult] = await connection.query(
        `
        INSERT INTO multimedia_macheo_reportes (
          nombre,
          archivo_nombre,
          fuente,
          total_items,
          total_match_unico,
          total_ambiguo,
          total_no_encontrado,
          total_subido,
          total_error,
          notas,
          uploaded_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          nombre,
          archivoNombre,
          normalizeKey(req.body.fuente || "IMPORT_MULTIMEDIA", 80),
          summary.total_items,
          summary.total_match_unico,
          summary.total_ambiguo,
          summary.total_no_encontrado,
          summary.total_subido,
          summary.total_error,
          cleanText(req.body.notas, 4000) || null,
          getUserLabel(req),
        ]
      );

      const reporteId = reportResult.insertId;

      for (const item of parsedRows) {
        await connection.query(
          `
          INSERT INTO multimedia_macheo_items (
            reporte_id,
            archivo,
            codigo_archivo,
            codigo_archivo_original,
            codigo_catalogo,
            folder_prefix,
            orden,
            rol,
            candidatos,
            estado,
            producto_id,
            codigo_andyfers,
            codigo_importacion,
            familia,
            descripcion,
            mensaje,
            accion_sugerida
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            codigo_archivo = VALUES(codigo_archivo),
            codigo_archivo_original = VALUES(codigo_archivo_original),
            codigo_catalogo = VALUES(codigo_catalogo),
            folder_prefix = VALUES(folder_prefix),
            orden = VALUES(orden),
            rol = VALUES(rol),
            candidatos = VALUES(candidatos),
            estado = VALUES(estado),
            producto_id = VALUES(producto_id),
            codigo_andyfers = VALUES(codigo_andyfers),
            codigo_importacion = VALUES(codigo_importacion),
            familia = VALUES(familia),
            descripcion = VALUES(descripcion),
            mensaje = VALUES(mensaje),
            accion_sugerida = VALUES(accion_sugerida),
            updated_at = CURRENT_TIMESTAMP
          `,
          [
            reporteId,
            item.archivo,
            item.codigo_archivo || null,
            item.codigo_archivo_original || null,
            item.codigo_catalogo || null,
            item.folder_prefix || null,
            item.orden,
            item.rol || null,
            item.candidatos || null,
            item.estado,
            item.producto_id,
            item.codigo_andyfers || null,
            item.codigo_importacion || null,
            item.familia || null,
            item.descripcion || null,
            item.mensaje || null,
            item.estado === "MATCH_UNICO" ? "SUBIR_IMAGEN" : "REVISAR_MACHEO",
          ]
        );
      }

      await connection.commit();

      res.status(201).json({
        ok: true,
        message: "Reporte multimedia cargado correctamente.",
        data: {
          id: reporteId,
          ...summary,
        },
      });
    } catch (error) {
      await connection.rollback();
      next(error);
    } finally {
      connection.release();
    }
  }
);

router.patch("/admin/multimedia-macheo/items/:id", reviewAccess, async (req, res, next) => {
  try {
    const id = parseOptionalInt(req.params.id);

    if (!id) {
      return res.status(400).json({ ok: false, error: "ID inválido." });
    }

    const revisionEstado = normalizeKey(req.body.revision_estado, 60);
    const updates = [];
    const params = [];

    if (revisionEstado) {
      if (!VALID_ITEM_REVISION.has(revisionEstado)) {
        return res.status(400).json({ ok: false, error: "Estado de revisión inválido." });
      }

      updates.push("revision_estado = ?");
      params.push(revisionEstado);
    }

    if (Object.prototype.hasOwnProperty.call(req.body, "accion_sugerida")) {
      updates.push("accion_sugerida = ?");
      params.push(cleanString(req.body.accion_sugerida, 160) || null);
    }

    if (Object.prototype.hasOwnProperty.call(req.body, "nota_revision")) {
      updates.push("nota_revision = ?");
      params.push(cleanText(req.body.nota_revision, 4000) || null);
    }

    if (!updates.length) {
      return res.status(400).json({ ok: false, error: "No hay campos para actualizar." });
    }

    params.push(id);

    const [result] = await pool.query(
      `UPDATE multimedia_macheo_items SET ${updates.join(", ")} WHERE id = ?`,
      params
    );

    if (!result.affectedRows) {
      return res.status(404).json({ ok: false, error: "Item no encontrado." });
    }

    res.json({ ok: true, message: "Item actualizado correctamente." });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/admin/multimedia-macheo/reportes/:id/generar-pendientes",
  reviewAccess,
  async (req, res, next) => {
    const connection = await pool.getConnection();

    try {
      const id = parseOptionalInt(req.params.id);

      if (!id) {
        return res.status(400).json({ ok: false, error: "ID inválido." });
      }

      await connection.beginTransaction();

      const [result] = await connection.query(
        `
        INSERT INTO catalogo_pendientes_comerciales (
          tipo_pendiente,
          origen,
          referencia_tipo,
          referencia_key,
          producto_id,
          codigo_andyfers,
          codigo_importacion,
          familia,
          titulo,
          descripcion,
          accion_sugerida,
          prioridad,
          estado,
          score,
          total_eventos,
          metadata_json,
          creado_por,
          actualizado_por
        )
        SELECT
          CASE
            WHEN mmi.estado = 'AMBIGUO' THEN 'MULTIMEDIA_AMBIGUA'
            WHEN mmi.estado = 'ERROR' THEN 'MULTIMEDIA_ERROR'
            ELSE 'IMAGEN_NO_MACHEADA'
          END AS tipo_pendiente,
          'MULTIMEDIA_MACHEO' AS origen,
          'MULTIMEDIA_ITEM' AS referencia_tipo,
          CONCAT('REPORTE_', mmi.reporte_id, '_ITEM_', mmi.id) AS referencia_key,
          mmi.producto_id,
          mmi.codigo_andyfers,
          mmi.codigo_importacion,
          mmi.familia,
          CONCAT('Revisar imagen ', mmi.archivo) AS titulo,
          CONCAT(
            'Estado de macheo: ', mmi.estado,
            '. Código archivo: ', COALESCE(mmi.codigo_archivo, ''),
            '. Candidatos: ', COALESCE(mmi.candidatos, ''),
            '. Mensaje: ', COALESCE(mmi.mensaje, '')
          ) AS descripcion,
          CASE
            WHEN mmi.estado = 'AMBIGUO' THEN 'Resolver producto correcto para imagen'
            WHEN mmi.estado = 'ERROR' THEN 'Revisar error de carga/importación'
            ELSE 'Crear producto, agregar cruce o solicitar imagen correcta'
          END AS accion_sugerida,
          CASE
            WHEN mmi.folder_prefix IN ('AF', 'AP') THEN 'ALTA'
            WHEN mmi.estado = 'AMBIGUO' THEN 'ALTA'
            ELSE 'MEDIA'
          END AS prioridad,
          'NUEVO' AS estado,
          CASE
            WHEN mmi.estado = 'AMBIGUO' THEN 85
            WHEN mmi.folder_prefix IN ('AF', 'AP') THEN 75
            ELSE 55
          END AS score,
          1 AS total_eventos,
          JSON_OBJECT(
            'reporte_id', mmi.reporte_id,
            'item_id', mmi.id,
            'archivo', mmi.archivo,
            'estado_macheo', mmi.estado,
            'folder_prefix', mmi.folder_prefix,
            'codigo_archivo', mmi.codigo_archivo,
            'codigo_archivo_original', mmi.codigo_archivo_original,
            'codigo_catalogo', mmi.codigo_catalogo
          ) AS metadata_json,
          ? AS creado_por,
          ? AS actualizado_por
        FROM multimedia_macheo_items mmi
        WHERE mmi.reporte_id = ?
          AND mmi.estado IN ('NO_ENCONTRADO', 'AMBIGUO', 'ERROR')
        ON DUPLICATE KEY UPDATE
          descripcion = VALUES(descripcion),
          accion_sugerida = VALUES(accion_sugerida),
          prioridad = VALUES(prioridad),
          score = VALUES(score),
          metadata_json = VALUES(metadata_json),
          actualizado_por = VALUES(actualizado_por),
          updated_at = CURRENT_TIMESTAMP
        `,
        [getUserLabel(req), getUserLabel(req), id]
      );

      await connection.query(
        `
        UPDATE multimedia_macheo_items
        SET revision_estado = 'PENDIENTE_GENERADO'
        WHERE reporte_id = ?
          AND estado IN ('NO_ENCONTRADO', 'AMBIGUO', 'ERROR')
          AND revision_estado = 'PENDIENTE'
        `,
        [id]
      );

      await connection.commit();

      res.json({
        ok: true,
        message: "Pendientes generados desde reporte multimedia.",
        data: {
          affected_rows: result.affectedRows,
        },
      });
    } catch (error) {
      await connection.rollback();
      next(error);
    } finally {
      connection.release();
    }
  }
);

router.get("/admin/multimedia-macheo/reportes/:id/export", reviewAccess, async (req, res, next) => {
  try {
    const id = parseOptionalInt(req.params.id);

    if (!id) {
      return res.status(400).json({ ok: false, error: "ID inválido." });
    }

    const where = buildItemsWhere({ ...req.query, reporte_id: id });

    const [rows] = await pool.query(
      `
      SELECT *
      FROM multimedia_macheo_items mmi
      WHERE ${where.clauses.join(" AND ")}
      ORDER BY estado, folder_prefix, codigo_archivo, archivo
      `,
      where.params
    );

    const csv = buildExportCsv(rows);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="multimedia_macheo_reporte_${id}.csv"`);
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

router.delete("/admin/multimedia-macheo/reportes/:id", reviewAccess, async (req, res, next) => {
  try {
    const id = parseOptionalInt(req.params.id);

    if (!id) {
      return res.status(400).json({ ok: false, error: "ID inválido." });
    }

    const [result] = await pool.query(
      `DELETE FROM multimedia_macheo_reportes WHERE id = ?`,
      [id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ ok: false, error: "Reporte no encontrado." });
    }

    res.json({ ok: true, message: "Reporte eliminado correctamente." });
  } catch (error) {
    next(error);
  }
});

export default router;
