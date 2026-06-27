import { Router } from "express";
import multer from "multer";
import XLSX from "xlsx";
import { pool } from "../config/db.js";
import { requireAdminAuth, requireRole } from "../middleware/authAdmin.js";

const router = Router();

const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 12 * 1024 * 1024,
  },
  fileFilter(req, file, cb) {
    const allowedMimeTypes = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "text/csv",
      "application/csv",
    ];

    const allowedName = /\.(xlsx|xls|csv)$/i.test(file.originalname || "");

    if (!allowedMimeTypes.includes(file.mimetype) && !allowedName) {
      return cb(new Error("Solo se permiten archivos Excel o CSV."));
    }

    return cb(null, true);
  },
});

function cleanText(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeHeader(value) {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeCode(value) {
  return cleanText(value).toUpperCase();
}

function parseExcelNumber(value) {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const raw = cleanText(value)
    .replace(/\$/g, "")
    .replace(/\s/g, "");

  if (!raw) return null;

  let normalized = raw;

  const hasComma = normalized.includes(",");
  const hasDot = normalized.includes(".");

  if (hasComma && hasDot) {
    normalized = normalized.replace(/,/g, "");
  } else if (hasComma && !hasDot) {
    const parts = normalized.split(",");

    if (parts.length === 2 && parts[1].length <= 2) {
      normalized = `${parts[0]}.${parts[1]}`;
    } else {
      normalized = normalized.replace(/,/g, "");
    }
  }

  const number = Number(normalized);

  return Number.isFinite(number) ? number : null;
}

function parseStock(value) {
  const number = parseExcelNumber(value);

  if (number === null) return null;

  return Math.max(0, Math.floor(number));
}

function parsePrice(value) {
  const number = parseExcelNumber(value);

  if (number === null) return null;

  return Number(number.toFixed(2));
}

function parseMultiplo(value) {
  const number = parseExcelNumber(value);

  if (number === null || number < 1) return 1;

  return Math.max(1, Math.floor(number));
}

function getCell(row, aliases = []) {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(row, alias)) {
      return row[alias];
    }
  }

  return "";
}

function normalizeRows(sheet) {
  const rawRows = XLSX.utils.sheet_to_json(sheet, {
    defval: "",
    raw: false,
  });

  return rawRows.map((row) => {
    const normalized = {};

    Object.entries(row).forEach(([key, value]) => {
      normalized[normalizeHeader(key)] = value;
    });

    return normalized;
  });
}

function buildImportRow(row, index) {
  const codigoAndyfers = normalizeCode(
    getCell(row, [
      "codigo_andyfers",
      "codigo_andyfer",
      "codigo_andifers",
      "codigo",
      "sku",
    ])
  );

  const codigoImportacion = normalizeCode(
    getCell(row, [
      "codigo_importacion",
      "codigo_importación",
      "codigo_import",
      "importacion",
      "codigo_importado",
    ])
  );

  const existenciaRaw = getCell(row, [
    "existencia",
    "existencias",
    "stock",
    "cantidad",
    "inventario",
  ]);

  const precioRaw = getCell(row, [
    "precio",
    "precio_venta",
    "precio_web",
    "precio_publico",
  ]);

  const multiploRaw = getCell(row, [
    "multiplo_venta",
    "multiplo",
    "unidad",
    "unidad_venta",
  ]);

  const existencia = parseStock(existenciaRaw);
  const precio = parsePrice(precioRaw);
  const multiploVenta = parseMultiplo(multiploRaw);

  return {
    row_number: index + 2,
    codigo_andyfers: codigoAndyfers,
    codigo_importacion: codigoImportacion,
    existencia,
    precio,
    multiplo_venta: multiploVenta,
  };
}

async function getEcommerceSucursal(connection) {
  const clave = cleanText(process.env.ECOMMERCE_SUCURSAL_CLAVE || "ECOMMERCE");

  const [rows] = await connection.query(
    `
    SELECT id, nombre, clave
    FROM sucursales
    WHERE clave = ?
      AND activo = 1
    LIMIT 1
    `,
    [clave]
  );

  const sucursal = rows?.[0];

  if (!sucursal) {
    const error = new Error(`No existe almacén ecommerce con clave ${clave}.`);
    error.status = 500;
    throw error;
  }

  return sucursal;
}

async function findProductByCodes(connection, item) {
  const attempts = [];

  if (item.codigo_andyfers) {
    attempts.push({
      field: "codigo_andyfers",
      value: item.codigo_andyfers,
      source: "codigo_andyfers",
    });

    attempts.push({
      field: "codigo_importacion",
      value: item.codigo_andyfers,
      source: "codigo_andyfers_como_importacion",
    });
  }

  if (item.codigo_importacion) {
    attempts.push({
      field: "codigo_importacion",
      value: item.codigo_importacion,
      source: "codigo_importacion",
    });
  }

  for (const attempt of attempts) {
    const [rows] = await connection.query(
      `
      SELECT
        id,
        codigo_andyfers,
        codigo_importacion,
        descripcion
      FROM productos
      WHERE ${attempt.field} = ?
        AND activo = 1
      LIMIT 2
      `,
      [attempt.value]
    );

    if (rows.length > 1) {
      return {
        error: `Código ambiguo por ${attempt.source}: ${attempt.value}.`,
      };
    }

    if (rows.length === 1) {
      return {
        producto: rows[0],
        matched_by: attempt.source,
      };
    }
  }

  return {
    error: `Producto no encontrado: ${
      item.codigo_andyfers || item.codigo_importacion || "sin código"
    }.`,
  };
}

function validateImportItem(item) {
  const errors = [];

  if (!item.codigo_andyfers && !item.codigo_importacion) {
    errors.push("Falta codigo_andyfers o codigo_importacion.");
  }

  if (item.existencia === null) {
    errors.push("Existencia inválida.");
  }

  if (item.precio === null || item.precio <= 0) {
    errors.push("Precio inválido o menor/igual a cero.");
  }

  if (!item.multiplo_venta || item.multiplo_venta < 1) {
    errors.push("Múltiplo inválido.");
  }

  return errors;
}

async function processImportRows({ connection, rows, sucursal, dryRun }) {
  const result = {
    total_filas: rows.length,
    filas_validas: 0,
    actualizados: 0,
    creados: 0,
    sin_cambios: 0,
    omitidos: 0,
    errores: 0,
    detalles: [],
  };

  for (const item of rows) {
    const rowErrors = validateImportItem(item);

    if (rowErrors.length > 0) {
      result.errores += 1;
      result.detalles.push({
        row_number: item.row_number,
        codigo_andyfers: item.codigo_andyfers,
        codigo_importacion: item.codigo_importacion,
        estado: "ERROR",
        mensaje: rowErrors.join(" "),
      });
      continue;
    }

    const lookup = await findProductByCodes(connection, item);

    if (lookup.error) {
      result.errores += 1;
      result.detalles.push({
        row_number: item.row_number,
        codigo_andyfers: item.codigo_andyfers,
        codigo_importacion: item.codigo_importacion,
        estado: "ERROR",
        mensaje: lookup.error,
      });
      continue;
    }

    const producto = lookup.producto;

    const [inventarioRows] = await connection.query(
      `
      SELECT
        id,
        stock,
        precio,
        precio_publico,
        multiplo_venta,
        disponible_web
      FROM inventario
      WHERE producto_id = ?
        AND sucursal_id = ?
      LIMIT 1
      `,
      [producto.id, sucursal.id]
    );

    const current = inventarioRows?.[0] || null;

    const nextDisponibleWeb = item.existencia > 0 && item.precio > 0 ? 1 : 0;

    const hasChanges =
      !current ||
      Number(current.stock || 0) !== Number(item.existencia) ||
      Number(current.precio || 0) !== Number(item.precio) ||
      Number(current.precio_publico || 0) !== Number(item.precio) ||
      Number(current.multiplo_venta || 1) !== Number(item.multiplo_venta) ||
      Number(current.disponible_web || 0) !== nextDisponibleWeb;

    result.filas_validas += 1;

    if (!hasChanges) {
      result.sin_cambios += 1;
      result.detalles.push({
        row_number: item.row_number,
        producto_id: producto.id,
        codigo_andyfers: producto.codigo_andyfers,
        codigo_importacion: producto.codigo_importacion,
        estado: "SIN_CAMBIOS",
        mensaje: "El inventario ecommerce ya tenía esos valores.",
      });
      continue;
    }

    if (!dryRun) {
      await connection.query(
        `
        INSERT INTO inventario (
          producto_id,
          sucursal_id,
          stock,
          precio,
          precio_publico,
          multiplo_venta,
          mostrar_precio,
          disponible_cotizacion,
          disponible_web
        )
        VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)
        ON DUPLICATE KEY UPDATE
          stock = VALUES(stock),
          precio = VALUES(precio),
          precio_publico = VALUES(precio_publico),
          multiplo_venta = VALUES(multiplo_venta),
          mostrar_precio = 1,
          disponible_cotizacion = 1,
          disponible_web = VALUES(disponible_web),
          updated_at = NOW()
        `,
        [
          producto.id,
          sucursal.id,
          item.existencia,
          item.precio,
          item.precio,
          item.multiplo_venta,
          nextDisponibleWeb,
        ]
      );
    }

    if (current) {
      result.actualizados += 1;
    } else {
      result.creados += 1;
    }

    result.detalles.push({
      row_number: item.row_number,
      producto_id: producto.id,
      codigo_andyfers: producto.codigo_andyfers,
      codigo_importacion: producto.codigo_importacion,
      estado: dryRun ? "VALIDADO" : current ? "ACTUALIZADO" : "CREADO",
      matched_by: lookup.matched_by,
      existencia: item.existencia,
      precio: item.precio,
      multiplo_venta: item.multiplo_venta,
      disponible_web: nextDisponibleWeb,
    });
  }

  result.omitidos = result.total_filas - result.filas_validas - result.errores;

  return result;
}

router.get(
  "/admin/ecommerce/inventario/resumen",
  requireAdminAuth,
  requireRole(["ADMIN", "VENTAS"]),
  async (req, res, next) => {
    try {
      const clave = cleanText(process.env.ECOMMERCE_SUCURSAL_CLAVE || "ECOMMERCE");

      const [summaryRows] = await pool.query(
        `
        SELECT
          COUNT(i.id) AS productos_con_inventario,
          SUM(CASE WHEN i.disponible_web = 1 AND i.stock > 0 AND i.precio > 0 THEN 1 ELSE 0 END) AS vendibles,
          SUM(CASE WHEN COALESCE(i.stock, 0) <= 0 THEN 1 ELSE 0 END) AS sin_existencia,
          SUM(CASE WHEN COALESCE(i.precio, 0) <= 0 THEN 1 ELSE 0 END) AS sin_precio,
          SUM(COALESCE(i.stock, 0)) AS piezas_totales,
          MAX(i.updated_at) AS ultima_actualizacion
        FROM sucursales s
        LEFT JOIN inventario i ON i.sucursal_id = s.id
        WHERE s.clave = ?
        `,
        [clave]
      );

      const [lastImports] = await pool.query(
        `
        SELECT
          id,
          archivo_nombre,
          dry_run,
          total_filas,
          filas_validas,
          actualizados,
          creados,
          sin_cambios,
          errores,
          usuario_admin_correo,
          created_at
        FROM ecommerce_inventario_importaciones
        ORDER BY id DESC
        LIMIT 8
        `
      );

      res.json({
        ok: true,
        data: {
          almacen: clave,
          resumen: summaryRows?.[0] || {},
          importaciones: lastImports,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/admin/ecommerce/inventario/importar",
  requireAdminAuth,
  requireRole(["ADMIN"]),
  uploadExcel.single("file"),
  async (req, res, next) => {
    const connection = await pool.getConnection();

    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error: "Debes subir un archivo Excel o CSV.",
        });
      }

      const dryRun = String(req.body?.dry_run ?? "1") !== "0";

      const workbook = XLSX.read(req.file.buffer, {
        type: "buffer",
        cellDates: false,
      });

      const firstSheetName = workbook.SheetNames?.[0];

      if (!firstSheetName) {
        return res.status(400).json({
          ok: false,
          error: "El archivo no contiene hojas válidas.",
        });
      }

      const sheet = workbook.Sheets[firstSheetName];
      const normalizedRows = normalizeRows(sheet);

      if (normalizedRows.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "El archivo no contiene filas para importar.",
        });
      }

      if (normalizedRows.length > 10000) {
        return res.status(400).json({
          ok: false,
          error: "El archivo supera el máximo de 10,000 filas por carga.",
        });
      }

      const importRows = normalizedRows
        .map(buildImportRow)
        .filter((item) => {
          return (
            item.codigo_andyfers ||
            item.codigo_importacion ||
            item.existencia !== null ||
            item.precio !== null
          );
        });

      await connection.beginTransaction();

      const sucursal = await getEcommerceSucursal(connection);

      const result = await processImportRows({
        connection,
        rows: importRows,
        sucursal,
        dryRun,
      });

      await connection.query(
        `
        INSERT INTO ecommerce_inventario_importaciones (
          archivo_nombre,
          dry_run,
          total_filas,
          filas_validas,
          actualizados,
          creados,
          sin_cambios,
          omitidos,
          errores,
          usuario_admin_id,
          usuario_admin_correo,
          resumen_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          req.file.originalname || null,
          dryRun ? 1 : 0,
          result.total_filas,
          result.filas_validas,
          result.actualizados,
          result.creados,
          result.sin_cambios,
          result.omitidos,
          result.errores,
          req.admin?.id || null,
          req.admin?.correo || null,
          JSON.stringify({
            detalles: result.detalles.slice(0, 500),
          }),
        ]
      );

      await connection.commit();

      res.json({
        ok: true,
        message: dryRun
          ? "Archivo validado. No se aplicaron cambios."
          : "Inventario ecommerce actualizado correctamente.",
        data: {
          dry_run: dryRun,
          ...result,
          detalles: result.detalles.slice(0, 200),
          detalles_truncados: result.detalles.length > 200,
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

export default router;