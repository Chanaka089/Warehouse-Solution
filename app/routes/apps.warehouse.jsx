import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getWarehouseStock } from "../models/warehouseInventory.server";

/**
 * Storefront-facing endpoint, reached via the Shopify App Proxy at:
 *   https://{shop}.myshopify.com/apps/warehouse?variant_id={id}
 *
 * `authenticate.public.appProxy` verifies the request signature that Shopify
 * attaches to every app-proxy call, so we never expose the Admin API token to
 * the browser and we can trust `session` / `admin` are scoped to the right shop.
 *
 * Response shape (stable contract for the theme JS and any future ERP glue):
 * {
 *   "variantId": "gid://shopify/ProductVariant/123",
 *   "tracked": true,
 *   "defaultWarehouseKey": "east",
 *   "warehouses": [
 *     { "key": "east", "locationId": "gid://...", "name": "EAST Warehouse", "city": "Toronto", "province": "Ontario", "available": 18 },
 *     { "key": "west", "locationId": "gid://...", "name": "WEST Warehouse", "city": "London", "province": "Ontario", "available": 5 }
 *   ]
 * }
 */
export const loader = async ({ request }) => {
  let session, admin;
  try {
    const authResult = await authenticate.public.appProxy(request);
    session = authResult.session;
    admin = authResult.admin;
  } catch (error) {
    // authenticate.public.appProxy throws a Response on failed signature
    // verification. Log everything we can about it so we can see the real
    // cause instead of just a bare status code in the browser.
    console.error("apps.warehouse: authenticate.public.appProxy threw", {
      isResponse: error instanceof Response,
      status: error instanceof Response ? error.status : undefined,
      message: error instanceof Error ? error.message : String(error),
      url: request.url,
    });
    if (error instanceof Response) {
      const body = await error.text().catch(() => "");
      console.error("apps.warehouse: thrown Response body:", body);
      return error;
    }
    throw error;
  }

  if (!session) {
    // Signature verified, but there's no active session for this shop -
    // almost always means the app currently shows as not installed.
    console.error("apps.warehouse: no session for shop", {
      url: request.url,
    });
    return json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const variantIdParam = url.searchParams.get("variant_id");
  const productIdParam = url.searchParams.get("product_id");
  // Shopify automatically appends this to every app proxy request when the
  // shopper is logged in; it's empty for guests.
  const customerIdParam = url.searchParams.get("logged_in_customer_id");

  if (!variantIdParam) {
    return json({ error: "variant_id is required" }, { status: 400 });
  }

  try {
    const data = await getWarehouseStock({
      admin,
      variantId: variantIdParam,
      productId: productIdParam,
      customerId: customerIdParam || null,
    });

    return json(data, {
      headers: {
        // Stock changes constantly - never let a CDN/browser cache this.
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("apps.warehouse loader error", error);
    return json({ error: "failed_to_load_stock" }, { status: 500 });
  }
};
