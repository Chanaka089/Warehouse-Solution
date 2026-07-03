/**
 * Warehouse inventory + order-tagging helpers.
 *
 * Design goals:
 *  - Not hardcoded to exactly two locations. Today the shop has EAST/WEST,
 *    but tomorrow it could have a third or fourth warehouse - this module
 *    reads whatever locations are marked as "fulfills online orders" and
 *    returns all of them. The theme renders however many come back.
 *  - A single, stable shape is used everywhere (storefront JSON, order tags,
 *    order metafield) so a future ERP integration has one contract to code
 *    against instead of re-deriving it from line item text.
 */

const VARIANT_STOCK_QUERY = `#graphql
  query VariantWarehouseStock($id: ID!) {
    productVariant(id: $id) {
      id
      title
      inventoryItem {
        id
        tracked
        inventoryLevels(first: 20) {
          nodes {
            location {
              id
              name
              isActive
              fulfillsOnlineOrders
              address {
                city
                province
              }
            }
            quantities(names: ["available"]) {
              name
              quantity
            }
          }
        }
      }
    }
  }
`;

// Turns "EAST Warehouse" -> "east", "West Warehouse" -> "west", so the
// frontend always has a short, stable key to key off of regardless of how
// a merchant later renames/relabels a location in Shopify admin.
export function locationKey(name) {
  return name
    .toLowerCase()
    .replace(/warehouse/g, "")
    .trim()
    .replace(/\s+/g, "-") || name.toLowerCase();
}

export function stockLevel(available) {
  if (available <= 0) return "out-stock";
  if (available <= 5) return "critical-stock";
  if (available <= 15) return "low-stock";
  return "high-stock";
}

function toNumericGid(idOrGid, resource) {
  if (String(idOrGid).startsWith("gid://")) return idOrGid;
  return `gid://shopify/${resource}/${idOrGid}`;
}

export async function getWarehouseStock({ admin, variantId }) {
  const gid = toNumericGid(variantId, "ProductVariant");

  const response = await admin.graphql(VARIANT_STOCK_QUERY, {
    variables: { id: gid },
  });
  const { data } = await response.json();
  const variant = data?.productVariant;

  if (!variant) {
    return { variantId: gid, tracked: false, warehouses: [] };
  }

  const tracked = variant.inventoryItem?.tracked ?? false;
  const levels = variant.inventoryItem?.inventoryLevels?.nodes ?? [];

  const warehouses = levels
    .filter((lvl) => lvl.location.isActive && lvl.location.fulfillsOnlineOrders)
    .map((lvl) => {
      const available =
        lvl.quantities.find((q) => q.name === "available")?.quantity ?? 0;
      return {
        key: locationKey(lvl.location.name),
        locationId: lvl.location.id,
        name: lvl.location.name,
        city: lvl.location.address?.city ?? "",
        province: lvl.location.address?.province ?? "",
        available,
        level: stockLevel(available),
      };
    })
    // Stable order: highest stock first so the UI doesn't jump around,
    // ties broken alphabetically for determinism.
    .sort((a, b) => b.available - a.available || a.name.localeCompare(b.name));

  return { variantId: gid, tracked, warehouses };
}

/**
 * Given the raw line_items array from an orders/create (or orders/updated)
 * webhook payload, extract which warehouse(s) were chosen.
 *
 * Looks for a line item property literally named "Warehouse" - this is the
 * same property name the theme writes at add-to-cart time, so this stays in
 * sync by construction rather than by convention scattered across files.
 */
export function summarizeOrderWarehouses(lineItems = []) {
  const perLineItem = lineItems.map((item) => {
    const props = item.properties || [];
    const warehouseProp = props.find((p) => p.name === "Warehouse");
    const locationIdProp = props.find((p) => p.name === "_warehouse_location_id");

    return {
      lineItemId: item.id,
      title: item.title,
      sku: item.sku,
      quantity: item.quantity,
      warehouse: warehouseProp ? warehouseProp.value : null,
      warehouseLocationId: locationIdProp ? locationIdProp.value : null,
    };
  });

  const distinctWarehouses = [
    ...new Set(perLineItem.map((li) => li.warehouse).filter(Boolean)),
  ];

  let label = "Unassigned";
  if (distinctWarehouses.length === 1) {
    label = distinctWarehouses[0];
  } else if (distinctWarehouses.length > 1) {
    label = "Both Warehouses";
  }

  return {
    label,
    distinctWarehouses,
    lineItems: perLineItem,
  };
}
