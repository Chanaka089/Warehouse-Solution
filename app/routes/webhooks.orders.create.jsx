import { authenticate } from "../shopify.server";
import { summarizeOrderWarehouses } from "../models/warehouseInventory.server";

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
    // Shop session missing/offline token revoked - nothing we can write with.
    console.warn(`No admin context for ${shop}, skipping warehouse tagging.`);
    return new Response();
  }

  const orderGid = `gid://shopify/Order/${payload.id}`;
  const summary = summarizeOrderWarehouses(payload.line_items || []);

  // 1. Human-readable tags so staff can filter/search orders in Admin,
  //    e.g. "Warehouse: East", "Warehouse: West", "Warehouse: Both Warehouses".
  const tags = [`Warehouse: ${summary.label}`];

  const tagResponse = await admin.graphql(TAG_MUTATION, {
    variables: { id: orderGid, tags },
  });
  const tagResult = await tagResponse.json();
  const tagErrors = tagResult.data?.tagsAdd?.userErrors ?? [];
  if (tagErrors.length) {
    console.error("tagsAdd errors", tagErrors);
  }

  // 2. Structured, machine-readable metafield so a future ERP connection (or
  //    any other app/script) can read one field instead of re-parsing line
  //    item properties. Namespace is scoped to this feature so it never
  //    collides with unrelated metafields.
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

  return new Response();
};
