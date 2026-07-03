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
 *   "warehouses": [
 *     { "key": "east", "locationId": "gid://...", "name": "EAST Warehouse", "city": "Toronto", "province": "Ontario", "available": 18 },
 *     { "key": "west", "locationId": "gid://...", "name": "WEST Warehouse", "city": "London", "province": "Ontario", "available": 5 }
 *   ]
 * }
 */
export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.public.appProxy(request);

  if (!session) {
    // Signature didn't verify, or app isn't installed for this shop.
    return json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const variantIdParam = url.searchParams.get("variant_id");
  const productIdParam = url.searchParams.get("product_id");

  if (!variantIdParam) {
    return json({ error: "variant_id is required" }, { status: 400 });
  }

  try {
    const data = await getWarehouseStock({
      admin,
      variantId: variantIdParam,
      productId: productIdParam,
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
