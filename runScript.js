//08272025
const axios = require('axios');
const nodemailer = require('nodemailer');

const SUPPLIER_API_URL_INVENTORY = process.env.SUPPLIER_API_URL_INVENTORY;
const AUTH_TOKEN = Buffer.from(process.env.SUPPLIER_API_KEY).toString('base64');
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_PASSWORD = process.env.SHOPIFY_API_PASSWORD;
const SHOPIFY_SHOP_NAME = process.env.SHOPIFY_SHOP_NAME;
const SHOPIFY_LOCATION_ID = process.env.SHOPIFY_LOCATION_ID;

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_TO = process.env.EMAIL_TO;

const GRAPHQL_API_URL = `https://${SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/2023-10/graphql.json`;

const delay = (ms) => new Promise(res => setTimeout(res, ms));

async function fetchSupplierInventory() {
    try {
        const response = await axios.get(SUPPLIER_API_URL_INVENTORY, {
            headers: {
                'Authorization': `Basic ${AUTH_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data?.inventory || [];
    } catch (err) {
        console.error("Error fetching supplier inventory:", err.response?.data || err.message);
        return [];
    }
}
/* og
async function fetchShopifyProducts(cursor = null) {
    const query = `
    query ($cursor: String) {
      products(first: 100, after: $cursor) {
        edges {
          cursor
          node {
            id
            variants(first: 1) {
              edges {
                node {
                  id
                  sku
                  inventoryQuantity
                  inventoryItem {
                    id
                  }
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }`;

    const variables = { cursor };

    try {
        const response = await axios.post(
            GRAPHQL_API_URL,
            { query, variables },
            {
                headers: {
                    'Authorization': `Basic ${Buffer.from(`${SHOPIFY_API_KEY}:${SHOPIFY_API_PASSWORD}`).toString('base64')}`,
                    'Content-Type': 'application/json',
                }
            }
        );

        const data = response.data;

        // Retry on throttle
        if (data.errors?.some(e => e.extensions?.code === "THROTTLED")) {
            const available = data.extensions?.cost?.throttleStatus?.currentlyAvailable || 0;
            const waitTime = Math.ceil((101 - available) / 100) * 1000;
            //console.warn(`Throttled. Waiting ${waitTime} ms before retrying...`);
            await delay(waitTime);
            return await fetchShopifyProducts(cursor);
        }

        if (!data.data?.products) {
            //console.error('Invalid Shopify response structure:', JSON.stringify(data, null, 2));
            return { edges: [], pageInfo: { hasNextPage: false } };
        }

        return data.data.products;
    } catch (error) {
        //console.error('Error fetching Shopify products:', error.response?.data || error.message);
        return { edges: [], pageInfo: { hasNextPage: false } };
    }
}
*/
async function fetchShopifyProducts(cursor = null) {
    const query = `
    query ($cursor: String, $queryString: String!) {
      products(first: 100, after: $cursor, query: $queryString) {
        edges {
          cursor
          node {
            id
            vendor
            variants(first: 1) {
              edges {
                node {
                  id
                  sku
                  inventoryQuantity
                  inventoryItem {
                    id
                  }
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }`;

    // The GraphQL query string filters products by vendor
    const variables = {
        cursor,
        queryString: 'vendor:TR-AU'
    };

    try {
        const response = await axios.post(
            GRAPHQL_API_URL,
            { query, variables },
            {
                headers: {
                    'Authorization': `Basic ${Buffer.from(`${SHOPIFY_API_KEY}:${SHOPIFY_API_PASSWORD}`).toString('base64')}`,
                    'Content-Type': 'application/json',
                }
            }
        );

        const data = response.data;

        // Retry on throttle
        if (data.errors?.some(e => e.extensions?.code === "THROTTLED")) {
            const available = data.extensions?.cost?.throttleStatus?.currentlyAvailable || 0;
            const waitTime = Math.ceil((101 - available) / 100) * 1000;
            await delay(waitTime);
            return await fetchShopifyProducts(cursor);
        }

        if (!data.data?.products) {
            return { edges: [], pageInfo: { hasNextPage: false } };
        }

        return data.data.products;
    } catch (error) {
        return { edges: [], pageInfo: { hasNextPage: false } };
    }
}

async function adjustShopifyInventory(inventoryAdjustments) {
    const mutation = `
    mutation adjustInventory($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        inventoryAdjustmentGroup {
          id
        }
        userErrors {
          field
          message
        }
      }
    }`;

    const input = {
        input: {
            reason: "correction",
            name: "available",
            changes: inventoryAdjustments.map(item => ({
                delta: item.delta,
                locationId: SHOPIFY_LOCATION_ID,
                inventoryItemId: item.inventoryItemId,
            }))
        }
    };

    try {
        const response = await axios.post(
            GRAPHQL_API_URL,
            { query: mutation, variables: input },
            {
                headers: {
                    'Authorization': `Basic ${Buffer.from(`${SHOPIFY_API_KEY}:${SHOPIFY_API_PASSWORD}`).toString('base64')}`,
                    'Content-Type': 'application/json',
                }
            }
        );

        if (response.data.errors?.length) {
            //console.error('Shopify mutation errors:', JSON.stringify(response.data.errors, null, 2));
        } else {
            inventoryAdjustments.forEach(item => {
                //console.log(`Inventory adjusted for InventoryItem ID: '${item.inventoryItemId}', Delta: ${item.delta}`);
            });
        }

        if (response.data.data?.inventoryAdjustQuantities?.userErrors?.length) {
            //console.warn('Shopify user errors:', response.data.data.inventoryAdjustQuantities.userErrors);
        }
    } catch (err) {
        //console.error("Shopify mutation request failed:", err.response?.data || err.message);
    }
}

async function sendUnmatchedSkusEmail(unmatchedSkus) {
    if (!unmatchedSkus.length) return;

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: EMAIL_USER,
            pass: EMAIL_PASS
        }
    });

    const mailOptions = {
        from: `"Inventory Sync" <${EMAIL_USER}>`,
        to: EMAIL_TO,
        subject: 'Unmatched SKUs Found in Shopify',
        text: `The following SKUs were found in Shopify but not in your supplier inventory:\n\n${unmatchedSkus.join('\n')}`
    };

    try {
        await transporter.sendMail(mailOptions);
        //console.log(`Email sent: ${unmatchedSkus.length} unmatched SKUs`);
    } catch (err) {
        //console.error('Failed to send unmatched SKUs email:', err.message);
    }
}

async function main() {
    const startTime = Date.now();

    const supplierInventory = await fetchSupplierInventory();
    if (!supplierInventory.length) {
        //console.log('No inventory to update.');
        return;
    }

    let cursor = null;
    let hasNextPage = true;
    let pageCount = 1;
    const unmatchedSkus = [];

    while (hasNextPage) {
        //console.log(`Fetching Shopify product page ${pageCount}...`);
        const { edges, pageInfo } = await fetchShopifyProducts(cursor);
        cursor = pageInfo.endCursor;
        hasNextPage = pageInfo.hasNextPage;
        pageCount++;

        const adjustments = [];

        for (const product of edges) {
            for (const variant of product.node.variants.edges) {
                const sku = variant.node.sku;
                const currentQty = variant.node.inventoryQuantity;
                const inventoryItemId = variant.node.inventoryItem?.id;

                const supplierItem = supplierInventory.find(item => item[0] === sku);
                if (!supplierItem) {
    if (!['this product keeps track of images 1', 'this product keeps track of images 2'].includes(sku)) {
        unmatchedSkus.push(sku);
    }
    continue;
}

                if (!inventoryItemId) continue;

                const supplierQty = supplierItem[1];

                if (
                    (supplierQty <= 1 && supplierQty !== currentQty) ||
                    (supplierQty >= 2 && currentQty <= 1)
                ) {
                    const delta = supplierQty - currentQty;
                    adjustments.push({ inventoryItemId, delta });
                }
            }
        }

        if (adjustments.length > 0) {
            console.log(`Adjusting ${adjustments.length} inventory items...`);
            await adjustShopifyInventory(adjustments);
            await delay(1000);
        }
    }

    await sendUnmatchedSkusEmail(unmatchedSkus);

    const endTime = Date.now();
    const durationSec = ((endTime - startTime) / 1000).toFixed(2);
    console.log(`Inventory sync complete in ${durationSec} seconds.`);
}

main().catch(console.error);
