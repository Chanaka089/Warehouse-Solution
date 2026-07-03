# Multi-Warehouse Stock & Fulfillment - what was built

Store: `ft-dev-vxapuen6.myshopify.com`
Locations confirmed live via Admin API:
  - **EAST Warehouse** - Toronto, ON (`gid://shopify/Location/89515196657`)
  - **WEST Warehouse** - London, ON (`gid://shopify/Location/89515163889`)

## 1. What's already done for you

### Theme (pushed to a working copy, not your live theme)
Your live theme is `FT`. I duplicated it to **`FT - Warehouse Build`**
(unpublished) and pushed the changes there so you can preview safely before
publishing:
  - `templates/product.json` - the block that used to contain your static
    HTML/CSS now renders `{% render 'warehouse-stock-selector', ... %}`.
  - `snippets/warehouse-stock-selector.liquid` - your card design, now
    server-rendered as a skeleton and filled with real numbers by JS.
  - `assets/warehouse-selector.js` - fetches live stock, renders the cards,
    writes the chosen warehouse into the product form as cart properties,
    and blocks "Add to cart" if nothing in stock is selected.

**To go live:** Admin → Online Store → Themes → find "FT - Warehouse Build"
→ Preview it, check a few products, then Publish (or copy the three files
into your live `FT` theme via the theme code editor if you'd rather not
switch themes wholesale).

### App (code written, not yet deployed - see step 3)
  - `app/routes/apps.warehouse.jsx` - app proxy endpoint. The theme calls
    `/apps/warehouse?variant_id=...` on your storefront domain; Shopify
    proxies that (signed, so it's trustworthy) to this route.
  - `app/models/warehouseInventory.server.js` - queries the Admin API for
    real inventory at every location that fulfills online orders (not
    hardcoded to two - if you add a third warehouse later, it just shows up).
  - `app/routes/webhooks.orders.create.jsx` - on every new order, tags it
    `Warehouse: East` / `Warehouse: West` / `Warehouse: Both Warehouses`,
    and writes a `warehouse_fulfillment.summary` JSON metafield on the order
    with a per-line-item breakdown - this is the one field your ERP
    integration should read, rather than re-parsing line item text.
  - `shopify.app.toml` - added the `[app_proxy]` block, the `orders/create`
    webhook subscription, and the `read_orders`/`write_orders` scopes needed
    to tag orders.

### Future fulfillment routing (scaffolded, needs Plus beta access)
  - `extensions/warehouse-order-routing/` - a Shopify Function that would
    make the customer's warehouse choice *binding* (today it's recorded but
    Shopify's own routing still decides who actually fulfills it). Read
    `extensions/warehouse-order-routing/README.md` before touching this -
    it requires Shopify Plus + enrollment in the order-routing beta.

## 2. How data flows, end to end

```
Product page load
  -> snippet renders card skeleton, variant id in a data attribute
  -> warehouse-selector.js calls GET /apps/warehouse?variant_id=123
  -> Shopify proxies to your app, signed
  -> app queries Admin GraphQL: inventoryItem.inventoryLevels per location
  -> JSON back to the browser -> cards render with real numbers

Customer picks a warehouse, clicks Add to cart
  -> JS has already written into the product <form>:
       properties[Warehouse] = "EAST Warehouse — Toronto, Ontario"
       properties[_warehouse_location_id] = "gid://shopify/Location/89515196657"
  -> normal /cart/add.js request carries those properties through
     cart -> checkout -> order, no extra work needed

Order created
  -> orders/create webhook fires
  -> app reads each line item's "Warehouse" property
  -> tags the order (single warehouse, or "Both Warehouses" if the cart
     mixed EAST and WEST items)
  -> writes warehouse_fulfillment.summary metafield (JSON) for ERP
```

## 3. What you still need to do to deploy the app half

I can query/write your store's Admin API and theme files through the
connected Shopify tools here, but I can't host a server for Shopify to call
back into, and app deployment needs your Partner account. From your machine,
inside this project folder:

```bash
npm install
shopify app config link          # confirms this uses client_id 352f02244a8f9809c7f86554ee96f020
shopify app dev                  # for local testing, gives you a tunnel URL
```

Then, once you have a real hosting URL (Vercel/Fly/Render/etc. - `npm run
build && npm run start` per the existing Dockerfile) or are using the CLI's
dev tunnel:

1. Replace the two `https://example.com` placeholders in
   `shopify.app.toml` (`application_url` and `[app_proxy].url`) with your
   real URL, keeping the paths (`/api/auth`, `/apps/warehouse`) as-is.
2. `shopify app deploy` to register the new scopes, the app proxy, and the
   `orders/create` webhook.
3. Re-install/re-authorize the app on this dev store so it picks up the new
   `read_orders`/`write_orders` scopes (Shopify will prompt for this
   automatically on next admin visit if scopes changed).
4. Place a couple of test orders mixing EAST-only, WEST-only, and
   both-warehouse carts, and confirm the order tags/metafield show up in
   Admin → Orders.

## 4. Extensibility notes (since you mentioned this will grow)

  - **More warehouses**: nothing to change. `getWarehouseStock` returns
    every active, order-fulfilling location; the JS renders however many
    cards come back.
  - **ERP integration**: read `warehouse_fulfillment.summary` on the order
    (via Admin API or your own `orders/create`/`orders/updated` webhook
    subscription) rather than re-parsing line item properties - it's the
    one stable contract.
  - **Stock thresholds** (what counts as "low"/"critical"): tune the
    numbers in `stockLevel()` in `warehouseInventory.server.js`.
  - **Binding fulfillment routing**: see the order-routing extension above
    once you're ready for that Plus beta conversation with Shopify.
