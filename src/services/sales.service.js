import { getEcommerceSucursalClave } from "./mercadoPago.service.js";

export function cleanSaleText(value) {
    return String(value || "")
        .trim()
        .replace(/\s+/g, " ");
}

export function cleanPhone(value) {
    const clean = cleanSaleText(value);

    if (!clean) return "";

    return clean.replace(/[^\d+]/g, "");
}

export function parseSaleQuantity(value) {
    const quantity = Number.parseInt(value, 10);

    if (!Number.isFinite(quantity) || quantity < 1) return 1;

    return Math.min(quantity, 999);
}

export function parseMoney(value) {
    const number = Number(value);

    if (!Number.isFinite(number) || number < 0) return 0;

    return Number(number.toFixed(2));
}

export function calculateItemSubtotal(quantity, price) {
    return parseMoney(parseSaleQuantity(quantity) * parseMoney(price));
}

export function calculateSaleTotals(items = []) {
    const subtotal = items.reduce((sum, item) => {
        return sum + calculateItemSubtotal(item.cantidad, item.precio_unitario);
    }, 0);

    return {
        subtotal: parseMoney(subtotal),
        costo_envio: 0,
        descuento: 0,
        total: parseMoney(subtotal),
    };
}

export async function getEcommerceSucursal(connection) {
    const clave = getEcommerceSucursalClave();

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
        const error = new Error(
            `No existe la sucursal/almacén ecommerce con clave ${clave}.`
        );
        error.status = 500;
        throw error;
    }

    return sucursal;
}

export async function generateVentaFolio(connection) {
    const anio = new Date().getFullYear();

    await connection.query(
        `
    INSERT INTO venta_folios (anio, ultimo_consecutivo)
    VALUES (?, 0)
    ON DUPLICATE KEY UPDATE anio = anio
    `,
        [anio]
    );

    await connection.query(
        `
    UPDATE venta_folios
    SET ultimo_consecutivo = LAST_INSERT_ID(ultimo_consecutivo + 1)
    WHERE anio = ?
    `,
        [anio]
    );

    const [rows] = await connection.query("SELECT LAST_INSERT_ID() AS folio");

    const consecutivo = Number(rows?.[0]?.folio || 1);

    return `VTA-${anio}-${String(consecutivo).padStart(6, "0")}`;
}

export function validateCheckoutCustomer(body = {}) {
    const errors = [];

    if (!cleanSaleText(body.nombre_cliente)) {
        errors.push("El nombre es obligatorio.");
    }

    if (!cleanPhone(body.whatsapp)) {
        errors.push("El teléfono/WhatsApp es obligatorio.");
    }

    if (!cleanSaleText(body.direccion_envio)) {
        errors.push("La dirección de envío es obligatoria.");
    }

    return errors;
}

export function validateCartItems(productos = []) {
    const errors = [];

    if (!Array.isArray(productos) || productos.length === 0) {
        errors.push("El carrito debe incluir al menos un producto.");
        return errors;
    }

    productos.forEach((item, index) => {
        if (!item.producto_id && !item.codigo_andyfers && !item.codigo_importacion) {
            errors.push(`El producto #${index + 1} no tiene identificador válido.`);
        }

        const cantidad = parseSaleQuantity(item.cantidad);

        if (cantidad < 1) {
            errors.push(`La cantidad del producto #${index + 1} no es válida.`);
        }
    });

    return errors;
}