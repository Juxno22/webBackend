const MP_API_BASE_URL = "https://api.mercadopago.com";

function cleanEnv(value) {
    return String(value || "").trim();
}

function getAccessToken() {
    return cleanEnv(process.env.MP_ACCESS_TOKEN);
}

export function isMercadoPagoConfigured() {
    return Boolean(getAccessToken());
}

export function assertMercadoPagoConfigured() {
    if (!isMercadoPagoConfigured()) {
        const error = new Error("Mercado Pago no está configurado.");
        error.status = 500;
        throw error;
    }
}

function getMercadoPagoHeaders() {
    assertMercadoPagoConfigured();

    return {
        Authorization: `Bearer ${getAccessToken()}`,
        "Content-Type": "application/json",
    };
}

async function mercadoPagoRequest(path, options = {}) {
    const response = await fetch(`${MP_API_BASE_URL}${path}`, {
        ...options,
        headers: {
            ...getMercadoPagoHeaders(),
            ...(options.headers || {}),
        },
    });

    const text = await response.text();

    let data = null;

    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = { raw: text };
        }
    }

    if (!response.ok) {
        const error = new Error(
            data?.message ||
            data?.error ||
            `Mercado Pago respondió con HTTP ${response.status}.`
        );

        error.status = response.status;
        error.mercadoPago = data;
        throw error;
    }

    return data;
}

export function getMercadoPagoCheckoutUrls() {
    return {
        success: cleanEnv(process.env.MP_SUCCESS_URL),
        pending: cleanEnv(process.env.MP_PENDING_URL),
        failure: cleanEnv(process.env.MP_FAILURE_URL),
        notification: cleanEnv(process.env.MP_NOTIFICATION_URL),
    };
}

export function getMercadoPagoStatementDescriptor() {
    return cleanEnv(process.env.MP_STATEMENT_DESCRIPTOR) || "ANDYFERS";
}

export function getMercadoPagoAutoReturn() {
    return cleanEnv(process.env.MP_AUTO_RETURN) || "approved";
}

export function getEcommerceSucursalClave() {
    return cleanEnv(process.env.ECOMMERCE_SUCURSAL_CLAVE) || "ECOMMERCE";
}

export function getEcommerceCurrency() {
    return cleanEnv(process.env.ECOMMERCE_CURRENCY) || "MXN";
}

export async function createMercadoPagoPreference(preferencePayload) {
    return mercadoPagoRequest("/checkout/preferences", {
        method: "POST",
        body: JSON.stringify(preferencePayload),
    });
}

export async function getMercadoPagoPayment(paymentId) {
    if (!paymentId) {
        const error = new Error("paymentId es obligatorio.");
        error.status = 400;
        throw error;
    }

    return mercadoPagoRequest(`/v1/payments/${encodeURIComponent(paymentId)}`, {
        method: "GET",
    });
}

export async function getMercadoPagoMerchantOrder(merchantOrderId) {
    if (!merchantOrderId) {
        const error = new Error("merchantOrderId es obligatorio.");
        error.status = 400;
        throw error;
    }

    return mercadoPagoRequest(
        `/merchant_orders/${encodeURIComponent(merchantOrderId)}`,
        {
            method: "GET",
        }
    );
}

export function mapMercadoPagoStatusToVentaStatus(paymentStatus) {
    const status = cleanEnv(paymentStatus).toLowerCase();

    if (status === "approved") return "PAGADA";

    if (
        status === "rejected" ||
        status === "cancelled" ||
        status === "refunded" ||
        status === "charged_back"
    ) {
        return "PAGO_RECHAZADO";
    }

    return "PENDIENTE_PAGO";
}

export function buildPreferenceBasePayload({
    venta,
    items,
    payer,
    metadata = {},
}) {
    const urls = getMercadoPagoCheckoutUrls();

    if (!urls.success || !urls.pending || !urls.failure) {
        const error = new Error(
            "Faltan URLs de retorno de Mercado Pago en variables de entorno."
        );
        error.status = 500;
        throw error;
    }

    const payload = {
        items,
        payer,
        back_urls: {
            success: urls.success,
            pending: urls.pending,
            failure: urls.failure,
        },
        auto_return: getMercadoPagoAutoReturn(),
        statement_descriptor: getMercadoPagoStatementDescriptor(),
        external_reference: venta?.folio || String(venta?.id || ""),
        metadata: {
            venta_id: venta?.id || null,
            venta_folio: venta?.folio || null,
            ...metadata,
        },
    };

    if (urls.notification) {
        payload.notification_url = urls.notification;
    }

    return payload;
}