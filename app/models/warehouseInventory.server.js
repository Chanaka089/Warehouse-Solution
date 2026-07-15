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
      inventoryPolicy
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

const CUSTOMER_DEFAULT_WAREHOUSE_QUERY = `#graphql
  query CustomerDefaultWarehouse($id: ID!) {
    customer(id: $id) {
      id
      metafield(namespace: "warehouse_fulfillment", key: "default_location") {
        value
      }
    }
  }
`;

async function getCustomerDefaultWarehouseKey(admin, customerId) {
  if (!admin || !customerId) return null;
  const gid = toNumericGid(customerId, "Customer");

  try {
    const response = await admin.graphql(CUSTOMER_DEFAULT_WAREHOUSE_QUERY, {
      variables: { id: gid },
    });
    const { data } = await response.json();
    return data?.customer?.metafield?.value ?? null;
  } catch (error) {
    console.error("getCustomerDefaultWarehouseKey failed", error);
    return null;
  }
}

export async function getWarehouseStock({ admin, variantId, customerId }) {
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
  const defaultWarehouseKey = await getCustomerDefaultWarehouseKey(admin, customerId);

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
    .sort((a, b) => b.available - a.available || a.name.localeCompare(b.name));

  const continueSellingOutOfStock = variant.inventoryPolicy === "CONTINUE";

  return { variantId: gid, tracked, defaultWarehouseKey, continueSellingOutOfStock, warehouses };


}

/**
 * Reads which native Shopify Location each fulfillment order is currently
 * assigned to, compares it against the warehouse the customer actually chose
 * (carried on the order's line item properties), and uses fulfillmentOrderMove
 * to correct any mismatch. This is what makes the customer's choice bind to
 * Shopify's real location_id - the field your Acumatica connector reads -
 * rather than just being informational text on the order.
 */
const ORDER_FULFILLMENT_ORDERS_QUERY = `#graphql
  query OrderFulfillmentOrders($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 20) {
        nodes {
          id
          status
          assignedLocation {
            location { id }
          }
          lineItems(first: 50) {
            nodes {
              id
              remainingQuantity
              lineItem { id }
            }
          }
        }
      }
    }
  }
`;

const FULFILLMENT_ORDER_MOVE_MUTATION = `#graphql
  mutation MoveFulfillmentOrder($id: ID!, $newLocationId: ID!, $fulfillmentOrderLineItems: [FulfillmentOrderLineItemInput!]) {
    fulfillmentOrderMove(id: $id, newLocationId: $newLocationId, fulfillmentOrderLineItems: $fulfillmentOrderLineItems) {
      movedFulfillmentOrder { id status }
      originalFulfillmentOrder { id status }
      userErrors { field message }
    }
  }
`;

export function buildLineItemWarehouseMap(lineItems = []) {
  const map = new Map();
  for (const item of lineItems) {
    if (item.warehouseLocationId) {
      map.set(`gid://shopify/LineItem/${item.lineItemId}`, item.warehouseLocationId);
    }
  }
  return map;
}

export async function reassignFulfillmentOrdersToChosenWarehouses({
  admin,
  orderGid,
  lineItemLocationMap,
}) {
  if (!lineItemLocationMap.size) return { moves: [], skipped: "no-warehouse-choices" };

  const response = await admin.graphql(ORDER_FULFILLMENT_ORDERS_QUERY, {
    variables: { id: orderGid },
  });
  const { data } = await response.json();
  const fulfillmentOrders = data?.order?.fulfillmentOrders?.nodes ?? [];

  const moves = [];

  for (const fo of fulfillmentOrders) {
    if (fo.status === "CLOSED" || fo.status === "CANCELLED") continue;

    const currentLocationId = fo.assignedLocation?.location?.id;
    const byTargetLocation = new Map();

    for (const foLineItem of fo.lineItems.nodes) {
      if (foLineItem.remainingQuantity <= 0) continue;

      const targetLocationId = lineItemLocationMap.get(foLineItem.lineItem.id);
      if (!targetLocationId || targetLocationId === currentLocationId) continue;

      if (!byTargetLocation.has(targetLocationId)) byTargetLocation.set(targetLocationId, []);
      byTargetLocation.get(targetLocationId).push({
        id: foLineItem.id,
        quantity: foLineItem.remainingQuantity,
      });
    }

    for (const [targetLocationId, items] of byTargetLocation.entries()) {
      try {
        const moveResponse = await admin.graphql(FULFILLMENT_ORDER_MOVE_MUTATION, {
          variables: {
            id: fo.id,
            newLocationId: targetLocationId,
            fulfillmentOrderLineItems: items,
          },
        });
        const moveResult = await moveResponse.json();
        const userErrors = moveResult.data?.fulfillmentOrderMove?.userErrors ?? [];

        if (userErrors.length) {
          console.error("fulfillmentOrderMove userErrors", {
            orderGid,
            fulfillmentOrderId: fo.id,
            targetLocationId,
            userErrors,
          });
        }

        moves.push({
          fulfillmentOrderId: fo.id,
          targetLocationId,
          itemCount: items.length,
          userErrors,
        });
      } catch (error) {
        console.error("fulfillmentOrderMove failed", {
          orderGid,
          fulfillmentOrderId: fo.id,
          targetLocationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { moves };
}

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
