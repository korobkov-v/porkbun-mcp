export interface CardPurchaseArgs {
  domain: string;
  cost: number;
  cardPaymentId?: string;
  idempotencyKey: string;
}

export class CardPaymentError extends Error {
  constructor(public readonly details: Record<string, unknown>) {
    super("Card registration did not return a confirmed success. Inspect outcome and preserve the request key.");
  }
}

const record = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const identifier = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9_-]{1,255}$/.test(x);
const codes = new Set(["PAYMENT_REQUIRED", "PAYMENT_MISMATCH", "PAYMENT_NOT_FOUND", "PAYMENT_ALREADY_USED", "PAYMENT_EXPIRED", "PAYMENT_IN_PROGRESS", "IDEMPOTENCY_KEY_MISMATCH", "VERIFICATION_REQUIRED", "RATE_LIMITED", "INSUFFICIENT_FUNDS"]);

// Bound the body before parsing; never expose provider messages, headers or arbitrary fields.
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) { await reader.cancel(); throw new Error("Response too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function paymentState(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (record(body.payment)) {
    for (const key of ["charged", "holdReleased"]) {
      if (typeof body.payment[key] === "boolean") out[key] = body.payment[key];
    }
    if (body.payment.paidWith === "card") out.paidWith = "card";
  }
  return out;
}

export async function cardPurchase(baseUrl: string, apiKey: string, secretKey: string, args: CardPurchaseArgs): Promise<Record<string, unknown>> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(args.idempotencyKey) ||
      !Number.isSafeInteger(args.cost) || args.cost <= 0 ||
      (args.cardPaymentId !== undefined && !identifier(args.cardPaymentId))) {
    throw new Error("Invalid card purchase arguments.");
  }
  const context = { idempotency_key: args.idempotencyKey, domain: args.domain, cost: args.cost };
  const uncertain = (httpStatus?: number) => new CardPaymentError({ ...context,
    status: "OUTCOME_UNKNOWN", outcome: "unknown", http_status: httpStatus,
    next_step: "Do not start another purchase or pay again. Reconcile with Porkbun; if retrying, resend the identical request with this same idempotency_key." });
  const safeOutput = (value: Record<string, unknown>): Record<string, unknown> => {
    const encoded = JSON.stringify(value);
    if ([apiKey, secretKey].some(secret => secret.length > 0 && encoded.includes(secret))) throw uncertain();
    return value;
  };
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(`${baseUrl}/domain/create/${encodeURIComponent(args.domain)}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { "content-type": "application/json", "Idempotency-Key": args.idempotencyKey },
      body: JSON.stringify({ apikey: apiKey, secretapikey: secretKey, cost: args.cost,
        agreeToTerms: "yes", payWith: "card", ...(args.cardPaymentId ? { cardPaymentId: args.cardPaymentId } : {}) }),
    });
    body = await boundedJson(response);
  } catch { throw uncertain(); }
  if (!record(body)) throw uncertain(response.status);
  if (response.ok && body.status === "SUCCESS") {
    return safeOutput({ ...context, status: "SUCCESS", registered: true, payment: paymentState(body) });
  }
  if (response.status === 402 && body.status === "PAYMENT_REQUIRED") {
    // Only expose links on Porkbun's HTTPS origin. Never fetch or execute the link.
    let url: URL;
    try { url = new URL(String(body.payUrl)); } catch { throw uncertain(402); }
    if (url.origin !== "https://porkbun.com" || url.username || url.password || url.hash || url.search ||
        url.href.length > 2048 || !url.pathname.startsWith("/pay/") ||
        !identifier(body.cardPaymentId) || typeof body.expiresAt !== "string" ||
        body.expiresAt.length > 40 || !Number.isFinite(Date.parse(body.expiresAt)) || body.method !== "card") {
      throw uncertain(402);
    }
    if (Date.parse(body.expiresAt) <= Date.now()) throw new CardPaymentError({ ...context, status: "PAYMENT_EXPIRED", outcome: "unknown", next_step: "Do not pay this expired link. Reconcile the purchase with Porkbun before requesting a fresh link." });
    return safeOutput({ ...context, status: "PAYMENT_REQUIRED", registered: false, charged: false,
      payUrl: url.href, cardPaymentId: body.cardPaymentId, expiresAt: body.expiresAt,
      next_step: "The user must approve this purchase in an MPP wallet. Do not pay an expired link. After authorization repeat the same purchase with card_payment_id and a NEW saved idempotency_key. For an unchanged retry reuse its original key." });
  }
  const code = typeof body.code === "string" && codes.has(body.code) ? body.code :
    typeof body.status === "string" && codes.has(body.status) ? body.status : "API_ERROR";
  throw new CardPaymentError({ ...context, status: code, http_status: response.status,
    outcome: "unknown", payment: paymentState(body),
    next_step: "Reconcile the payment status with Porkbun. Do not automatically pay again, switch to account credit or create a new key for an unchanged retry." });
}
