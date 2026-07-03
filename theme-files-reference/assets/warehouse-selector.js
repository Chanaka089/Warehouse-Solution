/**
 * Warehouse stock + selection widget.
 *
 * Responsibilities:
 *  1. Fetch live per-location stock from the app proxy (/apps/warehouse)
 *     and render it into the cards defined in warehouse-stock-selector.liquid.
 *  2. Keep the selection in sync with two hidden cart line item properties
 *     on the product's <form>:
 *       - properties[Warehouse]              (human readable, shown to the customer)
 *       - properties[_warehouse_location_id] (Shopify Location GID, hidden from
 *                                              the customer, used by ERP/back office)
 *  3. Re-fetch stock whenever the shopper switches variant.
 *  4. Block "Add to cart" if the chosen (or only available) warehouse has 0 stock.
 *
 * No framework assumptions beyond what Horizon's product-form.liquid already
 * guarantees: a <form> with class "product-form-{sectionId}" and a
 * <select id="variant-selector-{sectionId}"> that always reflects the
 * currently selected variant.
 */
(function () {
  "use strict";

  const WAREHOUSE_PROP_NAME = "Warehouse";
  const WAREHOUSE_LOCATION_PROP_NAME = "_warehouse_location_id";

  function qs(root, sel) {
    return root.querySelector(sel);
  }
  function qsa(root, sel) {
    return Array.prototype.slice.call(root.querySelectorAll(sel));
  }

  function findForm(sectionId) {
    return (
      document.querySelector(".product-form-" + sectionId) ||
      document.querySelector('form[data-product-form]')
    );
  }

  function ensureHiddenInput(form, name) {
    let input = form.querySelector(
      'input[name="properties[' + name + ']"]'
    );
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = "properties[" + name + "]";
      form.appendChild(input);
    }
    return input;
  }

  function setSelection(form, warehouse) {
    const nameInput = ensureHiddenInput(form, WAREHOUSE_PROP_NAME);
    const idInput = ensureHiddenInput(form, WAREHOUSE_LOCATION_PROP_NAME);

    if (!warehouse) {
      nameInput.value = "";
      idInput.value = "";
      return;
    }

    const label = [warehouse.name, [warehouse.city, warehouse.province].filter(Boolean).join(", ")]
      .filter(Boolean)
      .join(" — ");

    nameInput.value = label;
    idInput.value = warehouse.locationId;
  }

  function renderError(block, show) {
    const errorEl = qs(block, "[data-warehouse-error]");
    if (!errorEl) return;
    errorEl.classList.toggle("hidden", !show);
  }

  function renderCards(block, warehouses) {
    const container = qs(block, "[data-warehouse-cards]");
    const template = qs(block, "[data-warehouse-card-template]");
    const sectionId = block.getAttribute("data-section-id");
    const form = findForm(sectionId);

    container.innerHTML = "";

    if (!warehouses.length) {
      const p = document.createElement("p");
      p.className = "warehouse-loading";
      p.textContent = "No warehouse inventory is configured for this product.";
      container.appendChild(p);
      if (form) setSelection(form, null);
      return;
    }

    const groupName = "warehouse-" + sectionId;
    let firstInStock = null;

    warehouses.forEach(function (warehouse, index) {
      const node = template.content.firstElementChild.cloneNode(true);
      const radio = qs(node, "[data-warehouse-radio]");
      const nameEl = qs(node, "[data-warehouse-name]");
      const addressEl = qs(node, "[data-warehouse-address]");
      const stockEl = qs(node, "[data-warehouse-stock]");

      radio.name = groupName;
      radio.value = warehouse.locationId;
      radio.disabled = warehouse.available <= 0;

      nameEl.textContent = warehouse.name.toUpperCase();
      addressEl.textContent = [warehouse.city, warehouse.province]
        .filter(Boolean)
        .join(", ");

      stockEl.classList.add(warehouse.level);
      stockEl.textContent =
        warehouse.available > 0
          ? warehouse.available + " Available"
          : "Out of Stock";

      if (warehouse.available <= 0) {
        node.setAttribute("data-disabled", "true");
      } else if (firstInStock === null) {
        firstInStock = index;
      }

      radio.addEventListener("change", function () {
        if (!form) return;
        setSelection(form, warehouse);
        renderError(block, false);
      });

      container.appendChild(node);
    });

    const radios = qsa(container, "[data-warehouse-radio]");

    if (firstInStock !== null) {
      radios[firstInStock].checked = true;
      if (form) setSelection(form, warehouses[firstInStock]);
      renderError(block, false);
    } else {
      // Every warehouse is out of stock for this variant.
      if (form) setSelection(form, null);
      renderError(block, true);
    }
  }

  function loadStock(block, variantId) {
    const endpoint = block.getAttribute("data-stock-endpoint");
    const loadingEl = qs(block, "[data-warehouse-loading]");
    const container = qs(block, "[data-warehouse-cards]");

    if (loadingEl) loadingEl.style.display = "";
    if (container) {
      const existingLoading = qs(container, "[data-warehouse-loading]");
      if (!existingLoading) {
        container.innerHTML =
          '<p class="warehouse-loading" data-warehouse-loading>Checking live stock…</p>';
      }
    }

    fetch(endpoint + "?variant_id=" + encodeURIComponent(variantId), {
      headers: { Accept: "application/json" },
    })
      .then(function (res) {
        if (!res.ok) throw new Error("stock request failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        renderCards(block, data.warehouses || []);
      })
      .catch(function (err) {
        console.error("Warehouse stock lookup failed", err);
        container.innerHTML =
          '<p class="warehouse-loading">Unable to load live stock right now.</p>';
      });
  }

  function guardSubmit(block, form) {
    if (!form || form.__warehouseGuardAttached) return;
    form.__warehouseGuardAttached = true;

    form.addEventListener(
      "submit",
      function (event) {
        const checked = document.querySelector(
          '[name="warehouse-' +
            block.getAttribute("data-section-id") +
            '"]:checked'
        );
        const warehouseCards = qs(block, "[data-warehouse-cards]");
        const hasAnyWarehouse =
          warehouseCards && warehouseCards.querySelectorAll("[data-warehouse-radio]").length > 0;

        if (hasAnyWarehouse && !checked) {
          event.preventDefault();
          event.stopImmediatePropagation();
          renderError(block, true);
        }
      },
      true // capture, so this runs before Horizon's own submit handler
    );
  }

  function initBlock(block) {
    const sectionId = block.getAttribute("data-section-id");
    const variantId = block.getAttribute("data-variant-id");
    const form = findForm(sectionId);

    if (variantId) loadStock(block, variantId);
    if (form) guardSubmit(block, form);

    const variantSelect = document.getElementById(
      "variant-selector-" + sectionId
    );
    if (variantSelect) {
      variantSelect.addEventListener("change", function () {
        if (variantSelect.value) loadStock(block, variantSelect.value);
      });
    }

    // Horizon re-renders sections via the Section Rendering API on variant
    // change in some contexts; watch for the select being swapped out too.
    const observer = new MutationObserver(function () {
      const freshSelect = document.getElementById(
        "variant-selector-" + sectionId
      );
      if (freshSelect && freshSelect.value !== block.__lastVariantId) {
        block.__lastVariantId = freshSelect.value;
        loadStock(block, freshSelect.value);
      }
    });
    const meta = document.querySelector('[data-sticky-container]');
    if (meta) observer.observe(meta, { childList: true, subtree: true });
  }

  function init() {
    qsa(document, "[data-warehouse-block]").forEach(initBlock);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Quick-view / quick-add modals inject markup after the fact.
  document.addEventListener("shopify:section:load", init);
})();
