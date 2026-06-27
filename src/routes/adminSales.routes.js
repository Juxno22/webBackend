import { Router } from "express";
import { pool } from "../config/db.js";
import { requireAdminAuth, requireRole } from "../middleware/authAdmin.js";
import { trackAnalyticsEventSafe } from "../services/analytics.service.js";

const router = Router();

const ESTADOS_VENTA = [
    "CREADA",
    "PENDIENTE_PAGO",
    "PAGADA",
    "PAGO_RECHAZADO",
    "CANCELADA",
    "EN_PREPARACION",
    "LISTA_ENTREGA",
    "ENTREGADA",
    "REEMBOLSADA",
];

const ESTADOS_ADMIN_OPERATIVOS = [
    "EN_PREPARACION",
    "LISTA_ENTREGA",
    "ENTREGADA",
    "CANCELADA",
    "REEMBOLSADA",
];

function cleanText(value) {
    return String(value ?? "")
        .trim()
        .replace(/\s+/g, " ");
}

function parsePositiveInt(value, fallback = 1, max = 200) {
    const number = Number.parseInt(value, 10);

    if (!Number.isFinite(number) || number < 1) return fallback;

    return Math.min(number, max);
}

function buildPagination(query = {}) {
    const page = parsePositiveInt(query.page, 1, 999999);
    const limit = parsePositiveInt(query.limit, 20, 100);
    const offset = (page - 1) * limit;

    return { page, limit, offset };
}

function buildVentasWhere(query = {}) {
    const conditions = [];
    const params = [];

    const estado = cleanText(query.estado);
    const q = cleanText(query.q);
    const desde = cleanText(query.desde);
    const hasta = cleanText(query.hasta);

    if (estado && ESTADOS_VENTA.includes(estado)) {
        conditions.push("v.estado = ?");
        params.push(estado);
    }

    if (desde) {
        conditions.push("DATE(v.created_at) >= ?");
        params.push(desde);
    }

    if (hasta) {
        conditions.push("DATE(v.created_at) <= ?");
        params.push(hasta);
    }

    if (q) {
        const like = `%${q}%`;

        conditions.push(`
      (
        v.folio LIKE ?
        OR v.nombre_cliente LIKE ?
        OR v.whatsapp LIKE ?
        OR v.mp_payment_id LIKE ?
        OR EXISTS (
          SELECT 1
          FROM venta_items viq
          WHERE viq.venta_id = v.id
            AND (
              viq.codigo_andyfers LIKE ?
              OR viq.codigo_importacion LIKE ?
              OR viq.descripcion_producto LIKE ?
            )
        )
      )
    `);

        params.push(like, like, like, like, like, like, like);
    }

    return {
        whereSql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
        params,
    };
}

function getAllowedNextStatuses(currentStatus) {
    switch (currentStatus) {
        case "CREADA":
        case "PENDIENTE_PAGO":
        case "PAGO_RECHAZADO":
            return ["CANCELADA"];

        case "PAGADA":
            return ["EN_PREPARACION"];

        case "EN_PREPARACION":
            return ["LISTA_ENTREGA", "ENTREGADA"];

        case "LISTA_ENTREGA":
            return ["ENTREGADA", "EN_PREPARACION"];

        default:
            return [];
    }
}

async function insertVentaHistory(
    connection,
    ventaId,
    estadoAnterior,
    estadoNuevo,
    origen,
    nota,
    adminId = null
) {
    await connection.query(
        `
    INSERT INTO venta_estado_historial (
      venta_id,
      estado_anterior,
      estado_nuevo,
      origen,
      nota,
      admin_id
    )
    VALUES (?, ?, ?, ?, ?, ?)
    `,
        [
            ventaId,
            estadoAnterior || null,
            estadoNuevo,
            origen || "ADMIN",
            nota || null,
            adminId,
        ]
    );
}

router.get(
    "/admin/ventas/resumen",
    requireAdminAuth,
    async (req, res, next) => {
        try {
            const { whereSql, params } = buildVentasWhere(req.query);

            const [rows] = await pool.query(
                `
        SELECT
          COUNT(*) AS total,

          SUM(CASE WHEN v.estado = 'CREADA' THEN 1 ELSE 0 END) AS creadas,
          SUM(CASE WHEN v.estado = 'PENDIENTE_PAGO' THEN 1 ELSE 0 END) AS pendiente_pago,
          SUM(CASE WHEN v.estado = 'PAGADA' THEN 1 ELSE 0 END) AS pagadas,
          SUM(CASE WHEN v.estado = 'PAGO_RECHAZADO' THEN 1 ELSE 0 END) AS rechazadas,
          SUM(CASE WHEN v.estado = 'CANCELADA' THEN 1 ELSE 0 END) AS canceladas,
          SUM(CASE WHEN v.estado = 'EN_PREPARACION' THEN 1 ELSE 0 END) AS en_preparacion,
          SUM(CASE WHEN v.estado = 'LISTA_ENTREGA' THEN 1 ELSE 0 END) AS lista_entrega,
          SUM(CASE WHEN v.estado = 'ENTREGADA' THEN 1 ELSE 0 END) AS entregadas,
          SUM(CASE WHEN v.estado = 'REEMBOLSADA' THEN 1 ELSE 0 END) AS reembolsadas,

          SUM(CASE WHEN DATE(v.created_at) = CURDATE() THEN 1 ELSE 0 END) AS ventas_hoy,

          SUM(CASE WHEN v.estado IN ('PAGADA', 'EN_PREPARACION', 'LISTA_ENTREGA', 'ENTREGADA') THEN v.total ELSE 0 END) AS importe_confirmado,
          SUM(CASE WHEN v.estado = 'PENDIENTE_PAGO' THEN v.total ELSE 0 END) AS importe_pendiente,
          SUM(CASE WHEN v.estado = 'ENTREGADA' THEN v.total ELSE 0 END) AS importe_entregado,

          SUM(
            CASE
              WHEN v.estado IN ('PAGADA', 'EN_PREPARACION', 'LISTA_ENTREGA')
              THEN 1
              ELSE 0
            END
          ) AS requieren_atencion
        FROM ventas v
        ${whereSql}
        `,
                params
            );

            const [topProducts] = await pool.query(
                `
        SELECT
          vi.codigo_andyfers,
          vi.codigo_importacion,
          vi.descripcion_producto,
          SUM(vi.cantidad) AS piezas,
          SUM(vi.subtotal) AS importe
        FROM venta_items vi
        JOIN ventas v ON v.id = vi.venta_id
        ${whereSql}
          ${whereSql ? "AND" : "WHERE"} v.estado IN ('PAGADA', 'EN_PREPARACION', 'LISTA_ENTREGA', 'ENTREGADA')
        GROUP BY
          vi.codigo_andyfers,
          vi.codigo_importacion,
          vi.descripcion_producto
        ORDER BY piezas DESC, importe DESC
        LIMIT 10
        `,
                params
            );

            const resumen = rows?.[0] || {};

            res.json({
                ok: true,
                data: {
                    total: Number(resumen.total || 0),
                    creadas: Number(resumen.creadas || 0),
                    pendiente_pago: Number(resumen.pendiente_pago || 0),
                    pagadas: Number(resumen.pagadas || 0),
                    rechazadas: Number(resumen.rechazadas || 0),
                    canceladas: Number(resumen.canceladas || 0),
                    en_preparacion: Number(resumen.en_preparacion || 0),
                    lista_entrega: Number(resumen.lista_entrega || 0),
                    entregadas: Number(resumen.entregadas || 0),
                    reembolsadas: Number(resumen.reembolsadas || 0),
                    ventas_hoy: Number(resumen.ventas_hoy || 0),
                    importe_confirmado: Number(resumen.importe_confirmado || 0),
                    importe_pendiente: Number(resumen.importe_pendiente || 0),
                    importe_entregado: Number(resumen.importe_entregado || 0),
                    requieren_atencion: Number(resumen.requieren_atencion || 0),
                    top_productos: topProducts,
                },
            });
        } catch (error) {
            next(error);
        }
    }
);

router.get("/admin/ventas", requireAdminAuth, async (req, res, next) => {
    try {
        const { page, limit, offset } = buildPagination(req.query);
        const { whereSql, params } = buildVentasWhere(req.query);

        const [countRows] = await pool.query(
            `
      SELECT COUNT(*) AS total
      FROM ventas v
      ${whereSql}
      `,
            params
        );

        const total = Number(countRows?.[0]?.total || 0);

        const [rows] = await pool.query(
            `
      SELECT
        v.id,
        v.folio,
        v.estado,
        v.canal,
        v.nombre_cliente,
        v.whatsapp,
        v.subtotal,
        v.costo_envio,
        v.descuento,
        v.total,
        v.moneda,
        v.mp_preference_id,
        v.mp_payment_id,
        v.mp_payment_status,
        v.mp_payment_status_detail,
        v.pagado_at,
        v.created_at,
        v.updated_at,

        COUNT(vi.id) AS total_items,
        COALESCE(SUM(vi.cantidad), 0) AS total_piezas
      FROM ventas v
      LEFT JOIN venta_items vi ON vi.venta_id = v.id
      ${whereSql}
      GROUP BY
        v.id,
        v.folio,
        v.estado,
        v.canal,
        v.nombre_cliente,
        v.whatsapp,
        v.subtotal,
        v.costo_envio,
        v.descuento,
        v.total,
        v.moneda,
        v.mp_preference_id,
        v.mp_payment_id,
        v.mp_payment_status,
        v.mp_payment_status_detail,
        v.pagado_at,
        v.created_at,
        v.updated_at
      ORDER BY v.created_at DESC, v.id DESC
      LIMIT ? OFFSET ?
      `,
            [...params, limit, offset]
        );

        res.json({
            ok: true,
            data: rows,
            pagination: {
                page,
                limit,
                total,
                total_pages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        next(error);
    }
});

router.get("/admin/ventas/:folio", requireAdminAuth, async (req, res, next) => {
    try {
        const folio = cleanText(req.params.folio);

        const [ventas] = await pool.query(
            `
      SELECT *
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
      SELECT *
      FROM venta_items
      WHERE venta_id = ?
      ORDER BY id ASC
      `,
            [venta.id]
        );

        const [historial] = await pool.query(
            `
      SELECT
        h.*,
        ua.nombre AS admin_nombre,
        ua.correo AS admin_correo
      FROM venta_estado_historial h
      LEFT JOIN usuarios_admin ua ON ua.id = h.admin_id
      WHERE h.venta_id = ?
      ORDER BY h.created_at DESC, h.id DESC
      `,
            [venta.id]
        );

        const [webhooks] = await pool.query(
            `
      SELECT
        id,
        tipo,
        accion,
        resource_id,
        data_id,
        mp_payment_id,
        mp_merchant_order_id,
        mp_external_reference,
        procesado,
        procesado_at,
        error_proceso,
        created_at
      FROM mercadopago_webhook_eventos
      WHERE venta_id = ?
         OR mp_external_reference = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 20
      `,
            [venta.id, venta.folio]
        );

        res.json({
            ok: true,
            data: {
                ...venta,
                allowed_next_statuses: getAllowedNextStatuses(venta.estado),
                items,
                historial,
                webhooks,
            },
        });
    } catch (error) {
        next(error);
    }
});

router.patch(
    "/admin/ventas/:folio/estado",
    requireAdminAuth,
    requireRole(["ADMIN", "VENTAS"]),
    async (req, res, next) => {
        const connection = await pool.getConnection();

        try {
            const folio = cleanText(req.params.folio);
            const estadoNuevo = cleanText(req.body.estado);
            const nota = cleanText(req.body.nota);

            if (!ESTADOS_ADMIN_OPERATIVOS.includes(estadoNuevo)) {
                return res.status(400).json({
                    ok: false,
                    error: "Estado inválido para gestión admin.",
                    estados_validos: ESTADOS_ADMIN_OPERATIVOS,
                });
            }

            await connection.beginTransaction();

            const [rows] = await connection.query(
                `
        SELECT id, folio, estado, notas_admin
        FROM ventas
        WHERE folio = ?
        LIMIT 1
        FOR UPDATE
        `,
                [folio]
            );

            const venta = rows?.[0];

            if (!venta) {
                await connection.rollback();

                return res.status(404).json({
                    ok: false,
                    error: "Venta no encontrada.",
                });
            }

            const allowed = getAllowedNextStatuses(venta.estado);

            if (!allowed.includes(estadoNuevo)) {
                await connection.rollback();

                return res.status(409).json({
                    ok: false,
                    error: `No se puede cambiar una venta de ${venta.estado} a ${estadoNuevo}.`,
                    allowed_next_statuses: allowed,
                });
            }

            const notaFinal =
                nota ||
                `Estado cambiado de ${venta.estado} a ${estadoNuevo} por ${req.admin?.correo}.`;

            const notasAdmin = [venta.notas_admin, nota ? `[${estadoNuevo}] ${nota}` : null]
                .filter(Boolean)
                .join("\n");

            await connection.query(
                `
        UPDATE ventas
        SET
          estado = ?,
          notas_admin = ?,
          cancelado_at = CASE
            WHEN ? = 'CANCELADA' AND cancelado_at IS NULL THEN NOW()
            ELSE cancelado_at
          END,
          updated_at = NOW()
        WHERE id = ?
        `,
                [estadoNuevo, notasAdmin || null, estadoNuevo, venta.id]
            );

            await insertVentaHistory(
                connection,
                venta.id,
                venta.estado,
                estadoNuevo,
                "ADMIN",
                notaFinal,
                req.admin?.id || null
            );

            await connection.commit();

            if (estadoNuevo === "ENTREGADA") {
                await trackAnalyticsEventSafe(req, {
                    evento: "VENTA_ENTREGADA",
                    origen: "ADMIN_VENTAS",
                    venta_id: venta.id,
                    venta_folio: venta.folio,
                    metadata: {
                        estado_anterior: venta.estado,
                        estado_nuevo: estadoNuevo,
                        admin_correo: req.admin?.correo || null,
                    },
                });
            }

            res.json({
                ok: true,
                message: "Estado de venta actualizado.",
                data: {
                    folio,
                    estado_anterior: venta.estado,
                    estado_nuevo: estadoNuevo,
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

router.post(
    "/admin/ventas/:folio/notas",
    requireAdminAuth,
    requireRole(["ADMIN", "VENTAS"]),
    async (req, res, next) => {
        const connection = await pool.getConnection();

        try {
            const folio = cleanText(req.params.folio);
            const nota = cleanText(req.body.nota);

            if (!nota) {
                return res.status(400).json({
                    ok: false,
                    error: "La nota es obligatoria.",
                });
            }

            await connection.beginTransaction();

            const [rows] = await connection.query(
                `
        SELECT id, estado, notas_admin
        FROM ventas
        WHERE folio = ?
        LIMIT 1
        FOR UPDATE
        `,
                [folio]
            );

            const venta = rows?.[0];

            if (!venta) {
                await connection.rollback();

                return res.status(404).json({
                    ok: false,
                    error: "Venta no encontrada.",
                });
            }

            const notaConAutor = `[${new Date().toISOString()}] ${req.admin?.correo}: ${nota}`;
            const notasAdmin = [venta.notas_admin, notaConAutor]
                .filter(Boolean)
                .join("\n");

            await connection.query(
                `
        UPDATE ventas
        SET notas_admin = ?, updated_at = NOW()
        WHERE id = ?
        `,
                [notasAdmin, venta.id]
            );

            await insertVentaHistory(
                connection,
                venta.id,
                venta.estado,
                venta.estado,
                "ADMIN",
                nota,
                req.admin?.id || null
            );

            await connection.commit();

            res.status(201).json({
                ok: true,
                message: "Nota agregada correctamente.",
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