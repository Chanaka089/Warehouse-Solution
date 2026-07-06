import { authenticate } from "../shopify.server";
import {
  summarizeOrderWarehouses,
  buildLineItemWarehouseMap,
  reassignFulfillmentOrdersToChosenWarehouses,
} from "../models/warehouseInventory.server";

const TAG_MUTATION = `#graphql
  mutation AddOrderTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

const METAFIELD_MUTATION = `#graphql
  mutation SetWarehouseMetafield($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

export const action = async ({ request }) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) {
    console.warn(`No admin context for ${shop}, skipping warehouse tagging.`);
    return new Response();
  }

  const orderGid = `gid://shopify/Order/${payload.id}`;
  const summary = summarizeOrderWarehouses(payload.line_items || []);

  const tags = [`Warehouse: ${summary.label}`];

  const tagResponse = await admin.graphql(TAG_MUTATION, {
    variables: { id: orderGid, tags },
  });
  const tagResult = await tagResponse.json();
  const tagErrors = tagResult.data?.tagsAdd?.userErrors ?? [];
  if (tagErrors.length) {
    console.error("tagsAdd errors", tagErrors);
  }

  const metafieldResponse = await admin.graphql(METAFIELD_MUTATION, {
    variables: {
      metafields: [
        {
          ownerId: orderGid,
          namespace: "warehouse_fulfillment",
          key: "summary",
          type: "json",
          value: JSON.stringify({
            label: summary.label,
            warehouses: summary.distinctWarehouses,
            lineItems: summary.lineItems,
            generatedAt: new Date().toISOString(),
          }),
        },
      ],
    },
  });
  const metafieldResult = await metafieldResponse.json();
  const metafieldErrors = metafieldResult.data?.metafieldsSet?.userErrors ?? [];
  if (metafieldErrors.length) {
    console.error("metafieldsSet errors", metafieldErrors);
  }

  // 3. Make the choice binding: move each fulfillment order's line items to
  //    the location the customer actually picked, if Shopify's own default
  //    routing put them somewhere else. This is what makes Shopify's real
  //    location_id (what your Acumatica connector reads) match the customer's
  //    choice, instead of just being recorded as text on the order.
  try {
    const lineItemLocationMap = buildLineItemWarehouseMap(summary.lineItems);
    const reassignResult = await reassignFulfillmentOrdersToChosenWarehouses({
      admin,
      orderGid,
      lineItemLocationMap,
    });
    console.log("fulfillment order reassignment result", {
      shop,
      orderGid,
      ...reassignResult,
    });
  } catch (error) {
    console.error("reassignFulfillmentOrdersToChosenWarehouses failed", {
      shop,
      orderGid,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return new Response();
};
