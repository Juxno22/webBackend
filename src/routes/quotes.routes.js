import { Router } from "express";
import { pool } from "../config/db.js";
import { trackAnalyticsEventSafe } from "../services/analytics.service.js";
import { cleanString, parseCsvParam, placeholders } from "../utils/queryHelpers.js";

const router = Router();

function cleanPhone(value) {
    const clean = cleanString(value);

    if (!clean) return null;

    return clean.replace(/[^\d+]/g, "");
}

function parsePositiveQuantity(value) {
    const number = Number.parseInt(value, 10);

    if (Number.isNaN(number) || number < 1) return 1;

    return Math.min(number, 999);
}

function parseOptionalYear(value) {
    if (value === undefined || value === null || value === "") return null;

    const year = Number.parseInt(value, 10);

    if (Number.isNaN(year)) return null;

    if (year < 1900 || year > 2100) return null;

    return year;
}

function parseOptionalNumber(value) {
    if (value === undefined || value === null || value === "") return null;

    const number = Number(value);

    if (!Number.isFinite(number)) return null;

    return number;
}

function parseLimit(value, defaultLimit = 12, maxLimit = 24) {
    const limit = Number.parseInt(value, 10);

    if (Number.isNaN(limit) || limit < 1) return defaultLimit;

    return Math.min(limit, maxLimit);
}

function buildQuoteProductMultimediaSelectSql(alias = "p") {
    return `
        (
            SELECT pm.thumbnail_url
            FROM producto_multimedia pm
            WHERE pm.producto_id = ${alias}.id
              AND pm.tipo = 'IMAGEN'
              AND pm.activo = 1
            ORDER BY
              CASE pm.rol
                WHEN 'PRINCIPAL' THEN 0
                WHEN 'GALERIA' THEN 1
                ELSE 2
              END,
              pm.orden ASC,
              pm.id ASC
            LIMIT 1
        ) AS imagen_thumbnail_url,

        (
            SELECT pm.secure_url
            FROM producto_multimedia pm
            WHERE pm.producto_id = ${alias}.id
              AND pm.tipo = 'IMAGEN'
              AND pm.activo = 1
            ORDER BY
              CASE pm.rol
                WHEN 'PRINCIPAL' THEN 0
                WHEN 'GALERIA' THEN 1
                ELSE 2
              END,
              pm.orden ASC,
              pm.id ASC
            LIMIT 1
        ) AS imagen_url,

        (
            SELECT COUNT(*)
            FROM producto_multimedia pm
            WHERE pm.producto_id = ${alias}.id
              AND pm.tipo = 'IMAGEN'
              AND pm.activo = 1
        ) AS total_imagenes
    `;
}

function stringifyReasons(value) {
    if (!value) return null;

    if (Array.isArray(value)) {
        return value.join(" | ");
    }

    if (typeof value === "object") {
        return JSON.stringify(value);
    }

    return String(value);
}

function validateQuotePayload(body) {
    const errors = [];

    if (!cleanString(body.nombre_cliente)) {
        errors.push("El nombre del cliente es obligatorio.");
    }

    if (!cleanPhone(body.whatsapp)) {
        errors.push("El WhatsApp es obligatorio.");
    }

    if (!Array.isArray(body.productos) || body.productos.length === 0) {
        errors.push("La cotización debe incluir al menos un producto.");
    }

    if (Array.isArray(body.productos)) {
        body.productos.forEach((item, index) => {
            if (!item.producto_id && !item.codigo_andyfers && !item.codigo_importacion) {
                errors.push(`El producto #${index + 1} no tiene identificador válido.`);
            }
        });
    }

    return errors;
}

async function generateFolio(connection) {
    const anio = new Date().getFullYear();

    await connection.query(
        `
    INSERT INTO cotizacion_folios (anio, ultimo_consecutivo)
    VALUES (?, 0)
    ON DUPLICATE KEY UPDATE anio = anio
    `,
        [anio]
    );

    await connection.query(
        `
    UPDATE cotizacion_folios
    SET ultimo_consecutivo = LAST_INSERT_ID(ultimo_consecutivo + 1)
    WHERE anio = ?
    `,
        [anio]
    );

    const [rows] = await connection.query(
        "SELECT LAST_INSERT_ID() AS consecutivo"
    );

    const consecutivo = Number(rows?.[0]?.consecutivo || 1);

    return `COT-${anio}-${String(consecutivo).padStart(6, "0")}`;
}

async function getProductSnapshot(connection, item) {
    if (!item.producto_id && !item.codigo_andyfers && !item.codigo_importacion) {
        return null;
    }

    const params = [];
    const conditions = ["p.activo = 1"];

    if (item.producto_id) {
        conditions.push("p.id = ?");
        params.push(item.producto_id);
    } else if (item.codigo_andyfers) {
        conditions.push("p.codigo_andyfers = ?");
        params.push(item.codigo_andyfers);
    } else if (item.codigo_importacion) {
        conditions.push("p.codigo_importacion = ?");
        params.push(item.codigo_importacion);
    }

    const [rows] = await connection.query(
        `
    SELECT
      p.id,
      p.codigo_andyfers,
      p.codigo_importacion,
      p.descripcion,
      p.familia,
      p.armadora,
      p.categoria_id,
      c.nombre AS categoria,
      COALESCE(SUM(CASE WHEN i.disponible_web = 1 THEN i.stock ELSE 0 END), 0) AS stock_referencia,
      MIN(i.precio) AS precio_referencia
    FROM productos p
    JOIN categorias c ON c.id = p.categoria_id
    LEFT JOIN inventario i ON i.producto_id = p.id
    WHERE ${conditions.join(" AND ")}
    GROUP BY
      p.id,
      p.codigo_andyfers,
      p.codigo_importacion,
      p.descripcion,
      p.familia,
      p.armadora,
      p.categoria_id,
      c.nombre
    LIMIT 1
    `,
        params
    );

    return rows?.[0] || null;
}


router.get("/cotizaciones/productos-relacionados", async (req, res, next) => {
    try {
        const familias = parseCsvParam(req.query.familias);
        const categorias = parseCsvParam(req.query.categorias);
        const armadoras = parseCsvParam(req.query.armadoras);
        const exclude = parseCsvParam(req.query.exclude);
        const limit = parseLimit(req.query.limit, 12, 24);

        if (
            familias.length === 0 &&
            categorias.length === 0 &&
            armadoras.length === 0
        ) {
            return res.json({
                ok: true,
                data: [],
            });
        }

        const whereParts = ["p.activo = 1", "p.activo_web = 1"];
        const whereParams = [];

        const matchParts = [];

        if (familias.length > 0) {
            matchParts.push(`p.familia IN (${placeholders(familias)})`);
            whereParams.push(...familias);
        }

        if (categorias.length > 0) {
            matchParts.push(`c.nombre IN (${placeholders(categorias)})`);
            whereParams.push(...categorias);
        }

        if (armadoras.length > 0) {
            matchParts.push(`p.armadora IN (${placeholders(armadoras)})`);
            whereParams.push(...armadoras);
        }

        whereParts.push(`(${matchParts.join(" OR ")})`);

        if (exclude.length > 0) {
            const excludePlaceholders = placeholders(exclude);

            whereParts.push(`
                NOT (
                    CAST(p.id AS CHAR) IN (${excludePlaceholders})
                    OR p.codigo_andyfers IN (${excludePlaceholders})
                    OR p.codigo_importacion IN (${excludePlaceholders})
                )
            `);

            whereParams.push(...exclude, ...exclude, ...exclude);
        }

        const scoreParts = [];
        const scoreParams = [];

        if (familias.length > 0) {
            scoreParts.push(`CASE WHEN p.familia IN (${placeholders(familias)}) THEN 60 ELSE 0 END`);
            scoreParams.push(...familias);
        }

        if (armadoras.length > 0) {
            scoreParts.push(`CASE WHEN p.armadora IN (${placeholders(armadoras)}) THEN 25 ELSE 0 END`);
            scoreParams.push(...armadoras);
        }

        if (categorias.length > 0) {
            scoreParts.push(`CASE WHEN c.nombre IN (${placeholders(categorias)}) THEN 15 ELSE 0 END`);
            scoreParams.push(...categorias);
        }

        const scoreSql = scoreParts.length > 0 ? scoreParts.join(" + ") : "0";

        const [rows] = await pool.query(
            `
            SELECT
                p.id,
                p.id AS producto_id,
                p.codigo_andyfers,
                p.codigo_importacion,
                p.descripcion,
                p.familia,
                p.armadora,
                c.nombre AS categoria,
                ${buildQuoteProductMultimediaSelectSql("p")},
                0 AS total_cruces,
                (${scoreSql}) AS score_relacion
            FROM productos p
            LEFT JOIN categorias c ON c.id = p.categoria_id
            WHERE ${whereParts.join(" AND ")}
            ORDER BY
                score_relacion DESC,
                p.familia ASC,
                p.descripcion ASC
            LIMIT ?
            `,
            [...scoreParams, ...whereParams, limit]
        );

        res.json({
            ok: true,
            data: rows,
        });
    } catch (error) {
        next(error);
    }
});


router.post("/cotizaciones", async (req, res, next) => {
    const connection = await pool.getConnection();

    try {
        const payload = req.body || {};
        const errors = validateQuotePayload(payload);

        if (errors.length > 0) {
            return res.status(400).json({
                ok: false,
                error: "Datos inválidos para crear la cotización.",
                errors,
            });
        }

        await connection.beginTransaction();

        const folio = await generateFolio(connection);

        const nombreCliente = cleanString(payload.nombre_cliente);
        const whatsapp = cleanPhone(payload.whatsapp);

        const [cotizacionResult] = await connection.query(
            `
      INSERT INTO cotizaciones (
        folio,
        nombre_cliente,
        whatsapp,
        telefono_alt,
        correo,
        ciudad,
        estado_cliente,
        marca_vehiculo,
        modelo_vehiculo,
        anio_vehiculo,
        motor_vehiculo,
        version_vehiculo,
        numero_parte_cliente,
        mensaje_cliente,
        pregunta_ia_original,
        origen,
        estado
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NUEVA')
      `,
            [
                folio,
                nombreCliente,
                whatsapp,
                cleanPhone(payload.telefono_alt),
                cleanString(payload.correo),
                cleanString(payload.ciudad),
                cleanString(payload.estado_cliente),
                cleanString(payload.marca_vehiculo),
                cleanString(payload.modelo_vehiculo),
                parseOptionalYear(payload.anio_vehiculo),
                cleanString(payload.motor_vehiculo),
                cleanString(payload.version_vehiculo),
                cleanString(payload.numero_parte_cliente),
                cleanString(payload.mensaje_cliente),
                cleanString(payload.pregunta_ia_original),
                cleanString(payload.origen) || "CATALOGO",
            ]
        );

        const cotizacionId = cotizacionResult.insertId;
        const quoteAnalyticsItems = [];

        for (const item of payload.productos) {
            const snapshot = await getProductSnapshot(connection, item);
            const cantidad = parsePositiveQuantity(item.cantidad);

            if (!snapshot) {
                quoteAnalyticsItems.push({
                    producto_id: null,
                    codigo_andyfers: cleanString(item.codigo_andyfers),
                    codigo_importacion: cleanString(item.codigo_importacion),
                    descripcion: cleanString(item.descripcion) || "Producto solicitado sin descripción",
                    familia: cleanString(item.familia),
                    armadora: cleanString(item.armadora),
                    categoria_nombre: cleanString(item.categoria),
                    cantidad,
                    compatibilidad_estimada: parseOptionalNumber(item.compatibilidad_estimada),
                });

                await connection.query(
                    `
          INSERT INTO cotizacion_items (
            cotizacion_id,
            producto_id,
            codigo_andyfers,
            codigo_importacion,
            descripcion_producto,
            familia,
            armadora,
            categoria,
            cantidad,
            compatibilidad_estimada,
            razones_compatibilidad,
            precio_referencia,
            stock_referencia,
            notas_cliente
          )
          VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
                    [
                        cotizacionId,
                        cleanString(item.codigo_andyfers),
                        cleanString(item.codigo_importacion),
                        cleanString(item.descripcion) || "Producto solicitado sin descripción",
                        cleanString(item.familia),
                        cleanString(item.armadora),
                        cleanString(item.categoria),
                        cantidad,
                        parseOptionalNumber(item.compatibilidad_estimada),
                        stringifyReasons(item.razones_compatibilidad),
                        parseOptionalNumber(item.precio_referencia),
                        parseOptionalNumber(item.stock_referencia),
                        cleanString(item.notas_cliente),
                    ]
                );

                continue;
            }

            quoteAnalyticsItems.push({
                producto_id: snapshot.id,
                codigo_andyfers: snapshot.codigo_andyfers,
                codigo_importacion: snapshot.codigo_importacion,
                descripcion: snapshot.descripcion,
                familia: snapshot.familia,
                armadora: snapshot.armadora,
                categoria_id: snapshot.categoria_id,
                categoria_nombre: snapshot.categoria,
                cantidad,
                compatibilidad_estimada: parseOptionalNumber(item.compatibilidad_estimada),
            });

            await connection.query(
                `
        INSERT INTO cotizacion_items (
          cotizacion_id,
          producto_id,
          codigo_andyfers,
          codigo_importacion,
          descripcion_producto,
          familia,
          armadora,
          categoria,
          cantidad,
          compatibilidad_estimada,
          razones_compatibilidad,
          precio_referencia,
          stock_referencia,
          notas_cliente
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
                [
                    cotizacionId,
                    snapshot.id,
                    snapshot.codigo_andyfers,
                    snapshot.codigo_importacion,
                    snapshot.descripcion,
                    snapshot.familia,
                    snapshot.armadora,
                    snapshot.categoria,
                    cantidad,
                    parseOptionalNumber(item.compatibilidad_estimada),
                    stringifyReasons(item.razones_compatibilidad),
                    snapshot.precio_referencia,
                    snapshot.stock_referencia,
                    cleanString(item.notas_cliente),
                ]
            );
        }

        await connection.query(
            `
      INSERT INTO cotizacion_eventos (
        cotizacion_id,
        estado_anterior,
        estado_nuevo,
        comentario,
        usuario_interno
      )
      VALUES (?, NULL, 'NUEVA', ?, 'SISTEMA')
      `,
            [
                cotizacionId,
                "Cotización creada desde la página web.",
            ]
        );

        await connection.commit();

        await trackAnalyticsEventSafe(req, {
            evento: "COTIZACION_GENERADA",
            origen: cleanString(payload.origen) || "CATALOGO",
            cotizacion_id: cotizacionId,
            cotizacion_folio: folio,
            marca_vehiculo: cleanString(payload.marca_vehiculo),
            modelo_vehiculo: cleanString(payload.modelo_vehiculo),
            anio_vehiculo: cleanString(payload.anio_vehiculo),
            motor_vehiculo: cleanString(payload.motor_vehiculo),
            metadata: {
                total_productos: quoteAnalyticsItems.length,
                total_piezas: quoteAnalyticsItems.reduce(
                    (total, item) => total + Number(item.cantidad || 0),
                    0
                ),
                ciudad: cleanString(payload.ciudad),
                estado_cliente: cleanString(payload.estado_cliente),
            },
        });

        for (const analyticsItem of quoteAnalyticsItems) {
            await trackAnalyticsEventSafe(req, {
                evento: "PRODUCTO_AGREGADO_COTIZACION",
                origen: cleanString(payload.origen) || "CATALOGO",
                cotizacion_id: cotizacionId,
                cotizacion_folio: folio,
                producto_id: analyticsItem.producto_id,
                codigo_andyfers: analyticsItem.codigo_andyfers,
                codigo_importacion: analyticsItem.codigo_importacion,
                categoria_id: analyticsItem.categoria_id,
                categoria_nombre: analyticsItem.categoria_nombre,
                familia: analyticsItem.familia,
                cantidad: analyticsItem.cantidad,
                marca_vehiculo: cleanString(payload.marca_vehiculo),
                modelo_vehiculo: cleanString(payload.modelo_vehiculo),
                anio_vehiculo: cleanString(payload.anio_vehiculo),
                motor_vehiculo: cleanString(payload.motor_vehiculo),
                metadata: {
                    descripcion: analyticsItem.descripcion,
                    armadora: analyticsItem.armadora,
                    compatibilidad_estimada: analyticsItem.compatibilidad_estimada,
                },
            });
        }

        res.status(201).json({
            ok: true,
            message: "Cotización creada correctamente.",
            folio,
            data: {
                id: cotizacionId,
                folio,
                estado: "NUEVA",
                nombre_cliente: nombreCliente,
                whatsapp,
            },
        });
    } catch (error) {
        await connection.rollback();
        next(error);
    } finally {
        connection.release();
    }
});

router.get("/cotizaciones/:folio/publica", async (req, res, next) => {
    try {
        const folio = cleanString(req.params.folio);

        const [cotizaciones] = await pool.query(
            `
      SELECT
        id,
        folio,
        nombre_cliente,
        ciudad,
        estado_cliente,
        marca_vehiculo,
        modelo_vehiculo,
        anio_vehiculo,
        motor_vehiculo,
        mensaje_cliente,
        origen,
        estado,
        created_at
      FROM cotizaciones
      WHERE folio = ?
      LIMIT 1
      `,
            [folio]
        );

        const cotizacion = cotizaciones?.[0];

        if (!cotizacion) {
            return res.status(404).json({
                ok: false,
                error: "Cotización no encontrada.",
            });
        }

        const [items] = await pool.query(
            `
      SELECT
        id,
        producto_id,
        codigo_andyfers,
        codigo_importacion,
        descripcion_producto,
        familia,
        armadora,
        categoria,
        cantidad,
        compatibilidad_estimada,
        razones_compatibilidad
      FROM cotizacion_items
      WHERE cotizacion_id = ?
      ORDER BY id ASC
      `,
            [cotizacion.id]
        );

        res.json({
            ok: true,
            data: {
                ...cotizacion,
                items,
            },
        });
    } catch (error) {
        next(error);
    }
});

export default router;