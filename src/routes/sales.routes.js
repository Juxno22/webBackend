import { Router } from "express";
import { pool } from "../config/db.js";
import { trackAnalyticsEventSafe } from "../services/analytics.service.js";
import {
    buildPreferenceBasePayload,
    createMercadoPagoPreference,
    getEcommerceCurrency,
    getMercadoPagoPayment,
    mapMercadoPagoStatusToVentaStatus,
} from "../services/mercadoPago.service.js";
import {
    calculateItemSubtotal,
    calculateSaleTotals,
    cleanPhone,
    cleanSaleText,
    generateVentaFolio,
    getEcommerceSucursal,
    parseMoney,
    parseSaleQuantity,
    validateCartItems,
    validateCheckoutCustomer,
} from "../services/sales.service.js";

const router = Router();

function getClientBaseUrl(req) {
    const fromEnv = cleanSaleText(process.env.FRONTEND_URL || process.env.SITE_URL);

    if (fromEnv) return fromEnv.replace(/\/$/, "");

    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const host = req.headers["x-forwarded-host"] || req.headers.host;

    return host ? `${protocol}://${host}` : "";
}

function buildPictureUrl(req, product = {}) {
    const url = cleanSaleText(product.imagen_thumbnail_url || product.imagen_url);

    if (!url) return undefined;
    if (/^https?:\/\//i.test(url)) return url;

    const baseUrl = getClientBaseUrl(req);

    return baseUrl ? `${baseUrl}${url.startsWith("/") ? "" : "/"}${url}` : undefined;
}

function extractPaymentIdFromRequest(req) {
    return (
        cleanSaleText(req.body?.data?.id) ||
        cleanSaleText(req.body?.id) ||
        cleanSaleText(req.query?.["data.id"]) ||
        cleanSaleText(req.query?.id)
    );
}

function buildWebhookEventUid(req, paymentId) {
    const action = cleanSaleText(req.body?.action || req.query?.action);
    const type = cleanSaleText(
        req.body?.type ||
        req.body?.topic ||
        req.query?.type ||
        req.query?.topic
    );
    const requestId = cleanSaleText(req.headers["x-request-id"]);
    const id = paymentId || cleanSaleText(req.body?.id || req.query?.id) || "sin-id";

    return [requestId, type, action, id].filter(Boolean).join("|").slice(0, 220);
}

function buildProductWhereFromCartItem(item = {}) {
    const params = [];
    const conditions = ["p.activo = 1", "p.activo_web = 1"];

    if (item.producto_id) {
        conditions.push("p.id = ?");
        params.push(Number(item.producto_id));
    } else if (item.codigo_andyfers) {
        conditions.push("p.codigo_andyfers = ?");
        params.push(cleanSaleText(item.codigo_andyfers));
    } else if (item.codigo_importacion) {
        conditions.push("p.codigo_importacion = ?");
        params.push(cleanSaleText(item.codigo_importacion));
    }

    return {
        whereSql: conditions.join(" AND "),
        params,
    };
}

function buildSaleProductMultimediaSelectSql(alias = "p") {
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
    ) AS imagen_url
  `;
}

async function getSaleProductSnapshot(connection, item, sucursalId) {
    const { whereSql, params } = buildProductWhereFromCartItem(item);

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
      i.id AS inventario_id,
      i.sucursal_id,
      COALESCE(i.stock, 0) AS stock,
      i.precio AS precio,
      i.disponible_web,
      ${buildSaleProductMultimediaSelectSql("p")}
    FROM productos p
    JOIN categorias c ON c.id = p.categoria_id
    LEFT JOIN inventario i
      ON i.producto_id = p.id
     AND i.sucursal_id = ?
    WHERE ${whereSql}
    LIMIT 1
    `,
        [sucursalId, ...params]
    );

    return rows?.[0] || null;
}

function validateProductForSale(snapshot, item, index) {
    const errors = [];
    const label =
        snapshot?.codigo_andyfers ||
        snapshot?.codigo_importacion ||
        `#${index + 1}`;

    const cantidad = parseSaleQuantity(item.cantidad);
    const precio = parseMoney(snapshot?.precio);
    const stock = Number(snapshot?.stock || 0);

    if (!snapshot) {
        return [`El producto #${index + 1} no existe o no está activo.`];
    }

    if (!snapshot.inventario_id) {
        errors.push(`El producto ${label} no tiene inventario ecommerce configurado.`);
    }

    if (Number(snapshot.disponible_web) !== 1) {
        errors.push(`El producto ${label} no está disponible para venta web.`);
    }

    if (precio <= 0) {
        errors.push(`El producto ${label} no tiene precio de venta configurado.`);
    }

    if (stock < cantidad) {
        errors.push(
            `El producto ${label} no tiene existencia suficiente. Disponible: ${stock}.`
        );
    }

    return errors;
}

function buildMercadoPagoItems(req, saleItems) {
    const currency = getEcommerceCurrency();

    return saleItems.map((item) => ({
        id: item.codigo_andyfers || item.codigo_importacion || String(item.producto_id),
        title: `${item.codigo_andyfers || item.codigo_importacion || "Producto"} - ${item.descripcion_producto}`.slice(0, 250),
        description: item.descripcion_producto?.slice(0, 600),
        picture_url: item.picture_url || undefined,
        category_id: "auto_parts",
        quantity: Number(item.cantidad),
        currency_id: currency,
        unit_price: Number(item.precio_unitario),
    }));
}

function buildPayerFromPayload(payload = {}) {
    const nombre = cleanSaleText(payload.nombre_cliente);
    const whatsapp = cleanPhone(payload.whatsapp);

    return {
        name: nombre,
        phone: {
            number: whatsapp,
        },
        address: {
            street_name: cleanSaleText(payload.direccion_envio).slice(0, 250),
        },
    };
}

async function insertSaleHistory(
    connection,
    ventaId,
    previousStatus,
    nextStatus,
    origin,
    note
) {
    await connection.query(
        `
    INSERT INTO venta_estado_historial (
      venta_id,
      estado_anterior,
      estado_nuevo,
      origen,
      nota
    )
    VALUES (?, ?, ?, ?, ?)
    `,
        [ventaId, previousStatus || null, nextStatus, origin || "SISTEMA", note || null]
    );
}

async function getVentaByFolioForUpdate(connection, folio) {
    const [rows] = await connection.query(
        `
    SELECT *
    FROM ventas
    WHERE folio = ?
    LIMIT 1
    FOR UPDATE
    `,
        [folio]
    );

    return rows?.[0] || null;
}

async function discountStockForApprovedPayment(connection, venta) {
    const [items] = await connection.query(
        `
    SELECT
      vi.*,
      i.stock AS stock_actual
    FROM venta_items vi
    JOIN inventario i ON i.id = vi.inventario_id
    WHERE vi.venta_id = ?
    ORDER BY vi.id ASC
    FOR UPDATE
    `,
        [venta.id]
    );

    const pendingItems = items.filter(
        (item) => Number(item.stock_descontado) !== 1
    );

    if (pendingItems.length === 0) {
        return {
            ok: true,
            alreadyDiscounted: true,
        };
    }

    const insufficient = pendingItems.filter(
        (item) => Number(item.stock_actual) < Number(item.cantidad)
    );

    if (insufficient.length > 0) {
        return {
            ok: false,
            reason: "STOCK_INSUFICIENTE",
            message: `Pago aprobado, pero no hay stock suficiente para: ${insufficient
                .map(
                    (item) =>
                        item.codigo_andyfers ||
                        item.codigo_importacion ||
                        item.descripcion_producto
                )
                .join(", ")}.`,
        };
    }

    for (const item of pendingItems) {
        const stockAnterior = Number(item.stock_actual);
        const cantidad = Number(item.cantidad);
        const stockNuevo = stockAnterior - cantidad;

        await connection.query(
            `
      UPDATE inventario
      SET stock = ?, updated_at = NOW()
      WHERE id = ?
      `,
            [stockNuevo, item.inventario_id]
        );

        await connection.query(
            `
      UPDATE venta_items
      SET stock_descontado = 1
      WHERE id = ?
      `,
            [item.id]
        );

        await connection.query(
            `
      INSERT INTO venta_stock_movimientos (
        venta_id,
        venta_item_id,
        producto_id,
        inventario_id,
        sucursal_id,
        tipo,
        cantidad,
        stock_anterior,
        stock_nuevo,
        nota
      )
      VALUES (?, ?, ?, ?, ?, 'DESCUENTO_VENTA', ?, ?, ?, ?)
      `,
            [
                venta.id,
                item.id,
                item.producto_id,
                item.inventario_id,
                item.sucursal_id,
                cantidad,
                stockAnterior,
                stockNuevo,
                `Descuento por pago aprobado de venta ${venta.folio}.`,
            ]
        );
    }

    return {
        ok: true,
        alreadyDiscounted: false,
    };
}

async function processPaymentNotification(payment, eventRecordId, req = null) {
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const folio = cleanSaleText(
            payment.external_reference || payment.metadata?.venta_folio
        );

        if (!folio) {
            throw new Error("El pago de Mercado Pago no contiene external_reference/folio.");
        }

        const venta = await getVentaByFolioForUpdate(connection, folio);

        if (!venta) {
            throw new Error(`No se encontró venta para el folio ${folio}.`);
        }

        const nextStatus = mapMercadoPagoStatusToVentaStatus(payment.status);
        const previousStatus = venta.estado;

        const stockResult =
            nextStatus === "PAGADA"
                ? await discountStockForApprovedPayment(connection, venta)
                : { ok: true };

        const paymentId = payment.id ? String(payment.id) : null;
        const merchantOrderId = payment.order?.id ? String(payment.order.id) : null;
        const statusDetail = cleanSaleText(payment.status_detail);

        const adminNote = !stockResult.ok
            ? [venta.notas_admin, stockResult.message].filter(Boolean).join("\n")
            : venta.notas_admin;

        await connection.query(
            `
      UPDATE ventas
      SET
        estado = ?,
        mp_payment_id = COALESCE(?, mp_payment_id),
        mp_merchant_order_id = COALESCE(?, mp_merchant_order_id),
        mp_payment_status = ?,
        mp_payment_status_detail = ?,
        pagado_at = CASE
          WHEN ? = 'PAGADA' AND pagado_at IS NULL THEN NOW()
          ELSE pagado_at
        END,
        notas_admin = ?,
        updated_at = NOW()
      WHERE id = ?
      `,
            [
                nextStatus,
                paymentId,
                merchantOrderId,
                cleanSaleText(payment.status),
                statusDetail,
                nextStatus,
                adminNote || null,
                venta.id,
            ]
        );

        if (previousStatus !== nextStatus) {
            await insertSaleHistory(
                connection,
                venta.id,
                previousStatus,
                nextStatus,
                "MERCADOPAGO",
                stockResult.ok
                    ? `Mercado Pago confirmó estado ${payment.status}.`
                    : stockResult.message
            );
        }

        await connection.query(
            `
      UPDATE mercadopago_webhook_eventos
      SET
        venta_id = ?,
        mp_payment_id = COALESCE(?, mp_payment_id),
        mp_merchant_order_id = COALESCE(?, mp_merchant_order_id),
        mp_external_reference = ?,
        procesado = 1,
        procesado_at = NOW(),
        error_proceso = ?
      WHERE id = ?
      `,
            [
                venta.id,
                paymentId,
                merchantOrderId,
                folio,
                stockResult.ok ? null : stockResult.message,
                eventRecordId,
            ]
        );

        await connection.commit();

        const analyticsEvent =
            nextStatus === "PAGADA"
                ? "VENTA_PAGO_APROBADO"
                : nextStatus === "PAGO_RECHAZADO"
                    ? "VENTA_PAGO_RECHAZADO"
                    : "VENTA_PAGO_PENDIENTE";

        if (req) {
            await trackAnalyticsEventSafe(req, {
                evento: analyticsEvent,
                origen: "MERCADOPAGO_WEBHOOK",
                venta_id: venta.id,
                venta_folio: venta.folio,
                importe: venta.total,
                metadata: {
                    payment_id: payment.id || null,
                    payment_status: payment.status || null,
                    payment_status_detail: payment.status_detail || null,
                    merchant_order_id: payment.order?.id || null,
                    stock_ok: stockResult.ok,
                    stock_message: stockResult.message || null,
                },
            });
        }

        return {
            venta_id: venta.id,
            folio: venta.folio,
            estado: nextStatus,
            stock: stockResult,
        };
    } catch (error) {
        await connection.rollback();

        if (eventRecordId) {
            await pool.query(
                `
        UPDATE mercadopago_webhook_eventos
        SET error_proceso = ?
        WHERE id = ?
        `,
                [error.message, eventRecordId]
            );
        }

        throw error;
    } finally {
        connection.release();
    }
}

router.post("/ventas/checkout", async (req, res, next) => {
    const connection = await pool.getConnection();

    try {
        const payload = req.body || {};

        const errors = [
            ...validateCheckoutCustomer(payload),
            ...validateCartItems(payload.productos),
        ];

        if (errors.length > 0) {
            return res.status(400).json({
                ok: false,
                error: "Datos inválidos para crear la venta.",
                errors,
            });
        }

        await connection.beginTransaction();

        const sucursal = await getEcommerceSucursal(connection);
        const saleItems = [];
        const productErrors = [];

        for (const [index, item] of payload.productos.entries()) {
            const snapshot = await getSaleProductSnapshot(connection, item, sucursal.id);
            const itemErrors = validateProductForSale(snapshot, item, index);

            if (itemErrors.length > 0) {
                productErrors.push(...itemErrors);
                continue;
            }

            const cantidad = parseSaleQuantity(item.cantidad);
            const precioUnitario = parseMoney(snapshot.precio);

            saleItems.push({
                producto_id: snapshot.id,
                codigo_andyfers: snapshot.codigo_andyfers,
                codigo_importacion: snapshot.codigo_importacion,
                descripcion_producto: snapshot.descripcion,
                familia: snapshot.familia,
                categoria: snapshot.categoria,
                armadora: snapshot.armadora,
                cantidad,
                precio_unitario: precioUnitario,
                subtotal: calculateItemSubtotal(cantidad, precioUnitario),
                inventario_id: snapshot.inventario_id,
                sucursal_id: snapshot.sucursal_id,
                picture_url: buildPictureUrl(req, snapshot),
            });
        }

        if (productErrors.length > 0) {
            await connection.rollback();

            return res.status(400).json({
                ok: false,
                error: "Hay productos que no pueden venderse todavía.",
                errors: productErrors,
            });
        }

        const totals = calculateSaleTotals(saleItems);
        const folio = await generateVentaFolio(connection);
        const nombreCliente = cleanSaleText(payload.nombre_cliente);
        const whatsapp = cleanPhone(payload.whatsapp);
        const direccionEnvio = cleanSaleText(payload.direccion_envio);
        const comentariosCliente = cleanSaleText(payload.comentarios_cliente);

        const [ventaResult] = await connection.query(
            `
      INSERT INTO ventas (
        folio,
        estado,
        canal,
        nombre_cliente,
        whatsapp,
        direccion_envio,
        comentarios_cliente,
        subtotal,
        costo_envio,
        descuento,
        total,
        moneda
      )
      VALUES (?, 'CREADA', 'WEB', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
            [
                folio,
                nombreCliente,
                whatsapp,
                direccionEnvio,
                comentariosCliente || null,
                totals.subtotal,
                totals.costo_envio,
                totals.descuento,
                totals.total,
                getEcommerceCurrency(),
            ]
        );

        const ventaId = ventaResult.insertId;

        for (const item of saleItems) {
            await connection.query(
                `
        INSERT INTO venta_items (
          venta_id,
          producto_id,
          codigo_andyfers,
          codigo_importacion,
          descripcion_producto,
          familia,
          categoria,
          armadora,
          cantidad,
          precio_unitario,
          subtotal,
          inventario_id,
          sucursal_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
                [
                    ventaId,
                    item.producto_id,
                    item.codigo_andyfers,
                    item.codigo_importacion,
                    item.descripcion_producto,
                    item.familia,
                    item.categoria,
                    item.armadora,
                    item.cantidad,
                    item.precio_unitario,
                    item.subtotal,
                    item.inventario_id,
                    item.sucursal_id,
                ]
            );
        }

        await insertSaleHistory(
            connection,
            ventaId,
            null,
            "CREADA",
            "SISTEMA",
            "Venta creada desde checkout web."
        );

        await connection.commit();

        const venta = {
            id: ventaId,
            folio,
            total: totals.total,
            moneda: getEcommerceCurrency(),
        };

        const preferencePayload = buildPreferenceBasePayload({
            venta,
            items: buildMercadoPagoItems(req, saleItems),
            payer: buildPayerFromPayload(payload),
            metadata: {
                canal: "WEB",
                whatsapp,
            },
        });

        let preference;

        try {
            preference = await createMercadoPagoPreference(preferencePayload);
        } catch (preferenceError) {
            await pool.query(
                `
        UPDATE ventas
        SET
          estado = 'CANCELADA',
          cancelado_at = NOW(),
          notas_admin = ?,
          updated_at = NOW()
        WHERE id = ?
        `,
                [
                    `No se pudo crear la preferencia de Mercado Pago: ${preferenceError.message}`,
                    ventaId,
                ]
            );

            await insertSaleHistory(
                pool,
                ventaId,
                "CREADA",
                "CANCELADA",
                "MERCADOPAGO",
                `No se pudo crear la preferencia de Mercado Pago: ${preferenceError.message}`
            );

            throw preferenceError;
        }

        await pool.query(
            `
      UPDATE ventas
      SET
        estado = 'PENDIENTE_PAGO',
        mp_preference_id = ?,
        mp_init_point = ?,
        mp_sandbox_init_point = ?,
        mp_external_reference = ?,
        updated_at = NOW()
      WHERE id = ?
      `,
            [
                preference.id || null,
                preference.init_point || null,
                preference.sandbox_init_point || null,
                folio,
                ventaId,
            ]
        );

        await insertSaleHistory(
            pool,
            ventaId,
            "CREADA",
            "PENDIENTE_PAGO",
            "MERCADOPAGO",
            `Preferencia Mercado Pago creada: ${preference.id || "sin-id"}.`
        );

        await trackAnalyticsEventSafe(req, {
            evento: "VENTA_CHECKOUT_CREADO",
            origen: "CHECKOUT_WEB",
            venta_id: ventaId,
            venta_folio: folio,
            cantidad: saleItems.reduce(
                (sum, item) => sum + Number(item.cantidad || 0),
                0
            ),
            importe: totals.total,
            metadata: {
                venta_id: ventaId,
                venta_folio: folio,
                total: totals.total,
                total_productos: saleItems.length,
                total_piezas: saleItems.reduce(
                    (sum, item) => sum + Number(item.cantidad || 0),
                    0
                ),
            },
        });

        res.status(201).json({
            ok: true,
            message: "Checkout creado correctamente.",
            data: {
                id: ventaId,
                folio,
                estado: "PENDIENTE_PAGO",
                total: totals.total,
                moneda: getEcommerceCurrency(),
                mercado_pago: {
                    preference_id: preference.id || null,
                    init_point: preference.init_point || null,
                    sandbox_init_point: preference.sandbox_init_point || null,
                },
            },
        });
    } catch (error) {
        try {
            await connection.rollback();
        } catch {
            // La transacción puede ya estar cerrada si el error ocurrió después del commit.
        }

        next(error);
    } finally {
        connection.release();
    }
});

router.post("/ventas/mercadopago/webhook", async (req, res, next) => {
    try {
        const paymentId = extractPaymentIdFromRequest(req);
        const eventoUid = buildWebhookEventUid(req, paymentId);

        const [eventResult] = await pool.query(
            `
      INSERT IGNORE INTO mercadopago_webhook_eventos (
        evento_uid,
        tipo,
        accion,
        resource_id,
        data_id,
        payload_json
      )
      VALUES (?, ?, ?, ?, ?, ?)
      `,
            [
                eventoUid || null,
                cleanSaleText(
                    req.body?.type ||
                    req.body?.topic ||
                    req.query?.type ||
                    req.query?.topic
                ) || null,
                cleanSaleText(req.body?.action || req.query?.action) || null,
                cleanSaleText(req.body?.resource || req.query?.resource) || null,
                paymentId || null,
                JSON.stringify({
                    body: req.body || {},
                    query: req.query || {},
                }),
            ]
        );

        const eventRecordId = eventResult.insertId || null;

        if (!paymentId) {
            if (eventRecordId) {
                await pool.query(
                    `
          UPDATE mercadopago_webhook_eventos
          SET error_proceso = 'Notificación sin payment id.'
          WHERE id = ?
          `,
                    [eventRecordId]
                );
            }

            return res.status(200).json({
                ok: true,
                ignored: true,
            });
        }

        const payment = await getMercadoPagoPayment(paymentId);
        const result = await processPaymentNotification(payment, eventRecordId, req);

        res.status(200).json({
            ok: true,
            processed: true,
            data: result,
        });
    } catch (error) {
        next(error);
    }
});

router.get("/ventas/:folio/publica", async (req, res, next) => {
    try {
        const folio = cleanSaleText(req.params.folio);

        const [ventas] = await pool.query(
            `
      SELECT
        id,
        folio,
        estado,
        nombre_cliente,
        subtotal,
        costo_envio,
        descuento,
        total,
        moneda,
        mp_payment_status,
        mp_payment_status_detail,
        pagado_at,
        created_at
      FROM ventas
      WHERE folio = ?
      LIMIT 1
      `,
            [folio]
        );

        const venta = ventas?.[0];

        if (!venta) {
            return res.status(404).json({
                ok: false,
                error: "Venta no encontrada.",
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
        categoria,
        armadora,
        cantidad,
        precio_unitario,
        subtotal
      FROM venta_items
      WHERE venta_id = ?
      ORDER BY id ASC
      `,
            [venta.id]
        );

        res.json({
            ok: true,
            data: {
                ...venta,
                items,
            },
        });
    } catch (error) {
        next(error);
    }
});

export default router;