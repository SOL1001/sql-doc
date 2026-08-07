# SQL Queries Reference



## Endpoint 1 — GET /api/v1/orders

Returns a paginated list of sale orders for a user. Supports filtering by merchant and order history status.
We have optimized this endpoint to use a single highly-optimized CTE + LATERAL query.

Tables: sale_order, res_company, res_partner, res_country_state, res_country, sale_order_line, product_product, product_template, uom_uom

```sql
WITH partner AS (
    SELECT id FROM res_partner WHERE app_user_id = $1 AND active = TRUE LIMIT 1
),
company AS (
    SELECT id FROM res_company WHERE merchant = $2 AND is_delivery = FALSE AND merchant IS NOT NULL LIMIT 1
),
base_orders AS (
    SELECT so.id, so.name, so.state, so.superapp_order_status, so.date_order,
           ROUND(so.amount_total::numeric, 2) AS total_price, so."deliveryType",
           so.driver_name, so.driver_mobile, so.driver_delivery_medium, so.company_id
    FROM sale_order so
    WHERE so.partner_id = (SELECT id FROM partner)
      AND so.is_superapp_order = TRUE
      -- AND so.company_id = (SELECT id FROM company) -- if merchant provided
      -- AND so.superapp_order_status NOT IN ('cancelled', 'delivered') -- if history=active
      -- AND so.superapp_order_status IN ('delivered', 'cancelled') -- if history=inactive
    ORDER BY so.id DESC
    LIMIT $3 OFFSET $4
),
total_count AS (
    SELECT COUNT(*) AS c
    FROM sale_order so
    WHERE so.partner_id = (SELECT id FROM partner)
      AND so.is_superapp_order = TRUE
      -- AND so.company_id = (SELECT id FROM company)
      -- AND so.superapp_order_status NOT IN ('cancelled', 'delivered')
),
aggregated_orders AS (
    SELECT json_agg(
        json_build_object(
            'id', bo.id,
            'name', bo.name,
            'state', bo.state,
            'superapp_order_status', bo.superapp_order_status,
            'date_order', TO_CHAR(bo.date_order AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
            'total_price', bo.total_price,
            'deliveryType', bo."deliveryType",
            'driver_info', CASE WHEN bo."deliveryType" = 'delivery' THEN json_build_object(
                'driver_name', bo.driver_name,
                'driver_mobile', bo.driver_mobile,
                'driver_delivery_medium', bo.driver_delivery_medium
            ) ELSE NULL END,
            'company_info', json_build_object(
                'company_id', rc.id,
                'merchant', rc.merchant,
                'company_name', rc.name,
                'has_logo', rc.logo_web IS NOT NULL,
                'lat_location', rc.lat_location,
                'lng_location', rc.lng_location,
                'company_phone', rc.phone,
                'street', rp.street,
                'city', rp.city,
                'state_name', rs.name,
                'country_name', rco.name->>'en_US',
                'parent_name', rcp.name
            ),
            'order_lines', COALESCE(lines.lines_json, '[]'::json)
        ) ORDER BY bo.id DESC
    ) AS orders_json
    FROM base_orders bo
    LEFT JOIN res_company rc ON rc.id = bo.company_id
    LEFT JOIN res_partner rp ON rp.id = rc.partner_id
    LEFT JOIN res_country_state rs ON rs.id = rp.state_id
    LEFT JOIN res_country rco ON rco.id = rp.country_id
    LEFT JOIN res_company rcp ON rcp.id = rc.parent_id
    LEFT JOIN LATERAL (
        SELECT json_agg(
            json_build_object(
                'id', sol.id,
                'product_id', sol.product_id,
                'product_name', CASE WHEN attrs.attributes IS NOT NULL THEN CONCAT(pt.name->>'en_US', ' (', attrs.attributes, ')') ELSE pt.name->>'en_US' END,
                'product_uom_qty', sol.product_uom_qty,
                'uom_name', u.name->>'en_US',
                'price_unit', ROUND(sol.price_unit::numeric, 2),
                'price_total', ROUND(sol.price_total::numeric, 2),
                'company_merchant', rc.merchant
            ) ORDER BY sol.id ASC
        ) AS lines_json
        FROM sale_order_line sol
        LEFT JOIN product_product pp ON pp.id = sol.product_id
        LEFT JOIN product_template pt ON pt.id = pp.product_tmpl_id
        LEFT JOIN uom_uom u ON u.id = sol.product_uom
        LEFT JOIN (
            SELECT pvc.product_product_id, string_agg(pav.name->>'en_US', ', ' ORDER BY pa.sequence) AS attributes
            FROM product_variant_combination pvc
            JOIN product_template_attribute_value ptav ON ptav.id = pvc.product_template_attribute_value_id
            JOIN product_attribute_value pav ON pav.id = ptav.product_attribute_value_id
            JOIN product_attribute pa ON pa.id = pav.attribute_id
            GROUP BY pvc.product_product_id
        ) attrs ON attrs.product_product_id = pp.id
        WHERE sol.order_id = bo.id
    ) lines ON true
)
SELECT 
    (SELECT EXISTS(SELECT 1 FROM partner)) AS partner_exists,
    (SELECT EXISTS(SELECT 1 FROM company)) AS company_exists,
    (SELECT c FROM total_count) AS total_count,
    COALESCE((SELECT orders_json FROM aggregated_orders), '[]'::json) AS results;
```



## Endpoint 2 — GET /api/v1/{merchant}/orders/{order_id}/status

Returns detailed status of a specific order.
Optimized to use a single highly-optimized CTE + LATERAL query, combining order details, delivery counts, and order lines.

Tables: sale_order, res_company, res_partner, res_country_state, res_country, stock_picking, sale_order_line

```sql
WITH base AS (
    SELECT 
        so.id, so.name, so.state, so.superapp_order_status, so.date_order,
        so.amount_total, so."deliveryType", so.driver_name, so.driver_mobile,
        so.driver_email, so.driver_delivery_medium, so.delivery_pickup_code,
        so.customer_delivery_code, so.require_signature, so.signature,
        so.require_photo, so.photo, so.driver_assigned, so.rating,
        so.cancel_reason, so.message_to_driver, so.note, so.lock_id,
        so.invoice_status,
        -- Company
        rc.merchant, rc.name AS company_name, rc.logo_web IS NOT NULL AS has_logo,
        rc.lat_location, rc.lng_location, rc.phone AS company_phone,
        -- Address
        rp.street, rp.city, rs.name AS state_name, rco.name->>'en_US' AS country_name,
        rcp.name AS parent_name,
        -- Delivery product price
        (
            SELECT sol_del.price_total 
            FROM sale_order_line sol_del 
            WHERE sol_del.order_id = so.id AND sol_del.is_delivery = TRUE 
            LIMIT 1
        ) AS delivery_price
    FROM sale_order so
    INNER JOIN res_company rc ON rc.id = so.company_id
    LEFT JOIN res_partner rp ON rp.id = rc.partner_id
    LEFT JOIN res_country_state rs ON rs.id = rp.state_id
    LEFT JOIN res_country rco ON rco.id = rp.country_id
    LEFT JOIN res_company rcp ON rcp.id = rc.parent_id
    WHERE so.id = $1 AND rc.merchant = $2 AND so.is_superapp_order = TRUE
)
SELECT 
    (SELECT COUNT(*) FROM base) > 0 AS order_exists,
    COALESCE((
        SELECT json_build_object(
            'id', b.id, 'order_ref', b.name, 'state', b.state,
            'delivery_status', b.superapp_order_status,
            'date_order', TO_CHAR(b.date_order AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
            'total_price', ROUND(b.amount_total::numeric, 2),
            'deliveryType', b."deliveryType",
            'delivery_pickup_code', b.delivery_pickup_code,
            'customer_delivery_code', b.customer_delivery_code,
            'require_signature', COALESCE(b.require_signature, false),
            'signature', b.signature,
            'require_photo', COALESCE(b.require_photo, false),
            'photo', b.photo,
            'driver_assigned', b.driver_assigned,
            'rating', b.rating, 'cancel_reason', b.cancel_reason,
            'message_to_driver', b.message_to_driver, 'note', b.note,
            'lock_id', COALESCE(b.lock_id, 'false'),
            'invoice_status', COALESCE(b.invoice_status, 'false'),
            'delivery_price', ROUND(COALESCE(b.delivery_price, 0)::numeric, 2),
            'driver_info', json_build_object(
                'driver_name', b.driver_name, 'driver_mobile', b.driver_mobile,
                'driver_email', b.driver_email, 'delivery_medium', b.driver_delivery_medium
            ),
            'merchant', json_build_object(
                'merchant', b.merchant, 'name', b.company_name, 'has_logo', b.has_logo,
                'lat', b.lat_location, 'lng', b.lng_location, 'phone', b.company_phone,
                'parent', b.parent_name, 'street', b.street, 'city', b.city,
                'state_name', b.state_name, 'country_name', b.country_name
            ),
            'delivery_count', COALESCE(delivery.dcount, 0),
            'sale_order_lines', COALESCE(lines.lines_json, '[]'::json)
        )
        FROM base b
        LEFT JOIN LATERAL (
            SELECT COUNT(*) AS dcount FROM stock_picking WHERE sale_id = b.id
        ) delivery ON true
        LEFT JOIN LATERAL (
            SELECT json_agg(
                json_build_object(
                    'id', sol.id, 'product_id', sol.product_id,
                    'product_name', CASE WHEN attrs.attributes IS NOT NULL THEN CONCAT(pt.name->>'en_US', ' (', attrs.attributes, ')') ELSE pt.name->>'en_US' END,
                    'product_uom_qty', sol.product_uom_qty,
                    'uom_name', u.name->>'en_US', 'price_unit', ROUND(sol.price_unit::numeric, 2),
                    'price_total', ROUND(sol.price_total::numeric, 2)
                ) ORDER BY sol.id ASC
            ) AS lines_json
            FROM sale_order_line sol
            LEFT JOIN product_product pp ON pp.id = sol.product_id
            LEFT JOIN product_template pt ON pt.id = pp.product_tmpl_id
            LEFT JOIN uom_uom u ON u.id = sol.product_uom
            LEFT JOIN (
                SELECT pvc.product_product_id, string_agg(pav.name->>'en_US', ', ' ORDER BY pa.sequence) AS attributes
                FROM product_variant_combination pvc
                JOIN product_template_attribute_value ptav ON ptav.id = pvc.product_template_attribute_value_id
                JOIN product_attribute_value pav ON pav.id = ptav.product_attribute_value_id
                JOIN product_attribute pa ON pa.id = pav.attribute_id
                GROUP BY pvc.product_product_id
            ) attrs ON attrs.product_product_id = pp.id
            WHERE sol.order_id = b.id AND COALESCE(sol.is_delivery, FALSE) = FALSE
        ) lines ON true
    ), '{}'::json) AS result_json;
```



## Endpoint 3 — GET /api/v1/product/{product_id}/reviews

Returns paginated product reviews along with all developer replies in a single optimized CTE query.

Tables: product_template, product_review, review_reply, res_partner

```sql
WITH product_check AS (
    SELECT EXISTS(SELECT 1 FROM product_template WHERE id = $1) AS exists
),
base AS (
    SELECT
        pr.id,
        COALESCE(rp.name, 'Anonymous')  AS user_name,
        rp.app_user_id,
        pr.rating,
        COALESCE(pr.review, '')         AS review,
        TO_CHAR(pr.create_date, 'DD TMMonth YYYY') AS create_date
    FROM product_review pr
    LEFT JOIN res_partner rp ON rp.id = pr.user_id
    WHERE pr.product_template = $1
    ORDER BY pr.id DESC
    LIMIT $2 OFFSET $3
),
total_reviews AS (
    SELECT COUNT(*) AS c FROM product_review WHERE product_template = $1
),
aggregated_reviews AS (
    SELECT json_agg(
        json_build_object(
            'id', b.id,
            'user_name', b.user_name,
            'user_id', CASE WHEN b.app_user_id IS NOT NULL AND b.app_user_id != '' THEN to_jsonb(b.app_user_id) ELSE to_jsonb(false) END,
            'rating', COALESCE(NULLIF(b.rating, ''), '0')::int,
            'review', b.review,
            'create_date', b.create_date,
            'replys', COALESCE(replies.replies_json, '[]'::json)
        ) ORDER BY b.id DESC
    ) AS reviews_json
    FROM base b
    LEFT JOIN LATERAL (
        SELECT json_agg(
            json_build_object(
                'reply_from', COALESCE(rp2.name, 'Dev Team'),
                'reply', COALESCE(rr.reply, ''),
                'reply_date', TO_CHAR(rr.create_date, 'DD TMMonth YYYY')
            ) ORDER BY rr.id ASC
        ) AS replies_json
        FROM review_reply rr
        LEFT JOIN res_partner rp2 ON rp2.id = rr.user_id
        WHERE rr.review_id = b.id
    ) replies ON true
)
SELECT 
    (SELECT exists FROM product_check),
    (SELECT c FROM total_reviews),
    COALESCE((SELECT reviews_json FROM aggregated_reviews), '[]'::json)
```



## Endpoint 4 — GET /api/v1/driver/history

Returns a list of delivered orders assigned to a driver.
Fixed to correctly map the `pickup_from` details to the merchant's data (`dord.partner_id`) instead of the customer's data.

Tables: res_users, delivery_order, res_partner, sale_order

```sql
-- Step 1: Validate x-token
SELECT ru.id, ru.partner_id, ru.token_expiration_time
FROM res_users ru
WHERE ru.token = $1 AND ru.active = TRUE
LIMIT 1;

-- Step 2: Fetch history (updated to correctly use merchant details)
SELECT
    dord.id,
    dord.name                                   AS order_name,
    -- merchant name (pickup_from.name in Odoo response)
    COALESCE(merch.name, '')                    AS merchant_name,
    -- merchant street (pickup_from.branch in Odoo response)
    COALESCE(merch.street, '')                  AS merchant_street,
    dord.delivery_date,
    -- sale order status via so_id join
    so.superapp_order_status
FROM delivery_order dord
LEFT JOIN res_partner merch ON merch.id = dord.partner_id
LEFT JOIN sale_order so     ON so.id    = dord.so_id
WHERE dord.driver_assigned = $1
  AND dord.state = 'delivered'
ORDER BY dord.id DESC;
```



## Endpoint 5 — GET /api/v1/product/purchase_status

Checks if an app user has previously purchased a specific product. 
Optimized into a single query using EXISTS.

Tables: res_partner, sale_order_line, sale_order

```sql
WITH partner AS (
    SELECT id FROM res_partner WHERE app_user_id = $1 LIMIT 1
)
SELECT 
    EXISTS(SELECT 1 FROM partner) AS partner_exists,
    EXISTS(
        SELECT 1 
        FROM sale_order_line sol
        JOIN sale_order so ON so.id = sol.order_id
        WHERE so.partner_id = (SELECT id FROM partner)
          AND so.is_superapp_order = TRUE
          AND so.state IN ('sale', 'done')
          AND sol.product_id = $2
    ) AS is_bought
```



## Endpoint 6 — GET /api/v1/orders/list

Returns a paginated list of merchants that the user has ordered from, including the total number of orders and items per merchant.
Optimized into a single CTE + LATERAL query.

Tables: res_partner, sale_order, res_company, sale_order_line

```sql
WITH partner AS (
    SELECT id FROM res_partner WHERE app_user_id = $1 AND active = TRUE LIMIT 1
),
base_companies AS (
    SELECT
        rc.id                            AS company_id,
        rc.name                          AS company_name,
        rc.merchant                      AS merchant,
        rc.logo_web IS NOT NULL          AS has_logo,
        COUNT(so.id)                     AS order_count
    FROM sale_order so
    JOIN res_company rc ON rc.id = so.company_id
    WHERE so.partner_id = (SELECT id FROM partner)
      AND so.is_superapp_order = TRUE
    GROUP BY rc.id, rc.name, rc.merchant, rc.logo_web
),
total_count AS (
    SELECT COUNT(*) AS c FROM base_companies
),
paginated_companies AS (
    SELECT *
    FROM base_companies
    ORDER BY order_count DESC, company_name ASC
    LIMIT $2 OFFSET $3
),
aggregated_results AS (
    SELECT json_agg(
        json_build_object(
            'company_id', pc.company_id,
            'company_name', pc.company_name,
            'merchant', pc.merchant,
            'has_logo', pc.has_logo,
            'order_count', pc.order_count,
            'item_count', COALESCE(items.item_count, 0)
        ) ORDER BY pc.order_count DESC, pc.company_name ASC
    ) AS results_json
    FROM paginated_companies pc
    LEFT JOIN LATERAL (
        SELECT COUNT(sol.id)::int AS item_count
        FROM sale_order_line sol
        JOIN sale_order so2 ON so2.id = sol.order_id
        WHERE so2.partner_id = (SELECT id FROM partner)
          AND so2.is_superapp_order = TRUE
          AND so2.superapp_order_status != 'cancelled'
          AND so2.company_id = pc.company_id
    ) items ON true
)
SELECT
    EXISTS(SELECT 1 FROM partner) AS partner_exists,
    COALESCE((SELECT c FROM total_count), 0) AS total,
    COALESCE((SELECT results_json FROM aggregated_results), '[]'::json)
```



## Endpoint 7 — GET /api/v1/categoryads

```sql
SELECT 
bt.id,bt.name,bt.description,bt.image_url,bt.is_active,
json_build_object(
	'id', cat.id,
	'name', cat.name
) AS category
FROM admin_form bt Left JOIN  product_ecomerce_categories cat ON cat.id = bt.category_id
WHERE bt.is_active = true
OFFSET %s
LIMIT %s;
```


## Endpoint 8 — GET /api/v1/populars

```sql
SELECT 
    c.id,
    c.name AS name,
    c.logo_url,
    c.merchant
FROM res_company c
WHERE c.parent_id IS NULL
  AND c.cps_enabled = true
  AND c.is_delivery = false
  AND c.active = true
  AND c.merchant IS NOT NULL
  AND c.superapp_orders > 0 ORDER BY c.superapp_orders DESC 
  OFFSET %S
  LIMIT %S;
```


## Endpoint 9 — GET /api/v1/popular_categories

```sql
SELECT
    c.id AS category_id,
    c.name AS category_name,
    c.superapp_sale_count AS total_sold_qty,
    c.image_url AS image,
    COUNT(pt.id) AS product_count
FROM product_ecomerce_categories c
LEFT JOIN product_template pt
    ON pt.ecomerce_category_id = c.id
WHERE c.superapp_sale_count > 0
GROUP BY
    c.id,
    c.name,
    c.superapp_sale_count,
    c.image_url
ORDER BY c.superapp_sale_count DESC
OFFSET %S
LIMIT %S;
```

## Endpoint 10 — GET /api/v1/popular_categories/{merchant_id:string}

```sql
WITH merchant_company AS (
    SELECT id
    FROM res_company
    WHERE merchant = 'MRT000001SPR'
    LIMIT 1
),
category_sales AS (
    SELECT
        sol.category_id,
        COUNT(sol.id) AS total_sold_qty
    FROM sale_order_line sol
    JOIN sale_order so
        ON so.id = sol.order_id
    JOIN res_company rc
        ON rc.id = so.company_id
    WHERE rc.merchant = 'MRT000001SPR'
      AND so.is_superapp_order = TRUE
      AND so.superapp_order_status = 'delivered'
      AND sol.category_id IS NOT NULL
    GROUP BY sol.category_id
)
SELECT
    c.id AS category_id,
    c.name AS category_name,
    COUNT(pt.id) AS product_count,
    cs.total_sold_qty,
    c.image_url AS image
FROM category_sales cs
JOIN product_ecomerce_categories c
    ON c.id = cs.category_id
CROSS JOIN merchant_company mc
LEFT JOIN product_template pt
    ON pt.ecomerce_category_id = c.id
    AND (
        pt.company_id = mc.id
        OR pt.company_id IN (
            SELECT id
            FROM res_company
            WHERE parent_id = mc.id
        )
    )
GROUP BY
    c.id,
    c.name,
    c.image_url,
    cs.total_sold_qty
ORDER BY
    cs.total_sold_qty DESC;
```


## Endpoint 11 — GET /api/v1/popular_products

```sql
SELECT 
    pt.id AS product_id,
    pt.name->>'en_US' AS product_name,
    pt.description_sale AS description,
    pt.sold_count || ' ' || (uom.name->>'en_US') AS total_sold_qty,
    pt.ecommerce_float_price AS list_price,
    rcur.name AS currency,
    icp.value || '/api/v1/image/product.template/' || pt.id || '/image_1920' AS image,
    pt.average_rating,
   
    COALESCE(pp_count.total_variants, 0) AS total_variants,

    pt.t_is_featured AS is_featured,
    pt.is_halal,
    pt.is_arrival,

    EXISTS (
        SELECT 1
        FROM product_template_res_partner_rel ptr
        WHERE ptr.product_template_id = pt.id
        AND ptr.res_partner_id = rp.id
    ) AS is_wishlisted,

    COALESCE(discount_data.discounts, '[]'::json) AS discount,
    COALESCE(discount_data.product_discounts, 0) AS product_discounts

FROM product_template pt

LEFT JOIN res_company rc  
    ON rc.id = pt.company_id

LEFT JOIN res_partner rp
    ON rp.app_user_id =  %s--'51a0769721cb5557e0630b6f030a1579'

LEFT JOIN uom_uom uom
    ON uom.id = pt.uom_id

LEFT JOIN res_currency rcur 
    ON rcur.id = rc.currency_id


LEFT JOIN (
    SELECT 
        product_tmpl_id,
        COUNT(id) AS total_variants
    FROM product_product
    GROUP BY product_tmpl_id
) pp_count
    ON pp_count.product_tmpl_id = pt.id


LEFT JOIN LATERAL (
    SELECT
        json_agg(
            json_build_object(
                'name', d.name,
                'discount_type', d.discount_type,
                'discount_value', d.discount_value,
                'start_date', d.start_date,
                'end_date', d.end_date
            )
        ) FILTER (WHERE d.id IS NOT NULL AND d.is_active = true) AS discounts,

        COALESCE(
            SUM(
                CASE
                    WHEN d.discount_type IN ('percentage', 'percent')
                        THEN ROUND(
                            (
                                pt.ecommerce_float_price::numeric *
                                (d.discount_value::numeric / 100)
                            ),
                            2
                        )
                    ELSE
                        ROUND(
                            d.discount_value::numeric,
                            2
                        )
                END
            ) FILTER (
                WHERE d.id IS NOT NULL
                AND d.is_active = true
            ),
            0
        ) AS product_discounts


    FROM product_discount d
    WHERE d.product_tmpl_id = pt.id

) discount_data ON TRUE


CROSS JOIN ir_config_parameter icp

WHERE 
    icp.key = 'image.base.url'
    AND rc.cps_enabled = true
	AND rc.is_delivery = false
	AND rc.active = true
	AND rc.merchant IS NOT NULL
    AND pt.x_superapp_approval_status = 'approved'
    AND pt.sold_count > 0
    AND rc.cps_enabled = true
    AND pt.ecommerce_float_price >= $s -- 0 
    AND pt.ecommerce_float_price <= %s --1000
    AND pt.is_in_stock = true
	OFFSET %s LIMIT %s;
```

## Endpoint 12 — GET /api/v1/{merchant:string}/popular_merchant_products

```sql
SELECT 
    pt.id AS product_id,
    pt.name->>'en_US' AS product_name,
    pt.description_sale AS description,
    pt.sold_count || ' ' || (uom.name->>'en_US') AS total_sold_qty,
    pt.ecommerce_float_price AS list_price,
    rcur.name AS currency,
    icp.value || '/api/v1/image/product.template/' || pt.id || '/image_1920' AS image,
    pt.average_rating,
   
    COALESCE(pp_count.total_variants, 0) AS total_variants,

    pt.t_is_featured AS is_featured,
    pt.is_halal,
    pt.is_arrival,

    EXISTS (
        SELECT 1
        FROM product_template_res_partner_rel ptr
        WHERE ptr.product_template_id = pt.id
        AND ptr.res_partner_id = rp.id
    ) AS is_wishlisted,

    COALESCE(discount_data.discounts, '[]'::json) AS discount,
    COALESCE(discount_data.product_discounts, 0) AS product_discounts

FROM product_template pt

LEFT JOIN res_company rc  
    ON rc.id = pt.company_id

LEFT JOIN res_partner rp
    ON rp.app_user_id =  %s--'51a0769721cb5557e0630b6f030a1579'

LEFT JOIN uom_uom uom
    ON uom.id = pt.uom_id

LEFT JOIN res_currency rcur 
    ON rcur.id = rc.currency_id


LEFT JOIN (
    SELECT 
        product_tmpl_id,
        COUNT(id) AS total_variants
    FROM product_product
    GROUP BY product_tmpl_id
) pp_count
    ON pp_count.product_tmpl_id = pt.id


LEFT JOIN LATERAL (
    SELECT
        json_agg(
            json_build_object(
                'name', d.name,
                'discount_type', d.discount_type,
                'discount_value', d.discount_value,
                'start_date', d.start_date,
                'end_date', d.end_date
            )
        ) FILTER (WHERE d.id IS NOT NULL AND d.is_active = true) AS discounts,

        COALESCE(
            SUM(
                CASE
                    WHEN d.discount_type IN ('percentage', 'percent')
                        THEN ROUND(
                            (
                                pt.ecommerce_float_price::numeric *
                                (d.discount_value::numeric / 100)
                            ),
                            2
                        )
                    ELSE
                        ROUND(
                            d.discount_value::numeric,
                            2
                        )
                END
            ) FILTER (
                WHERE d.id IS NOT NULL
                AND d.is_active = true
            ),
            0
        ) AS product_discounts


    FROM product_discount d
    WHERE d.product_tmpl_id = pt.id

) discount_data ON TRUE


CROSS JOIN ir_config_parameter icp

WHERE 
    icp.key = 'image.base.url'
    AND rc.cps_enabled = true
	AND rc.is_delivery = false
	AND rc.active = true
	AND rc.merchant = %S --'MRT000001SPR'
    AND pt.x_superapp_approval_status = 'approved'
    AND pt.sold_count > 0
    AND rc.cps_enabled = true
    AND pt.ecommerce_float_price >= $s -- 0 
    AND pt.ecommerce_float_price <= %s --1000
    AND pt.is_in_stock = true
	OFFSET %s LIMIT %s;
```


## Endpoint 13 — GET /api/v1/{merchant:string}/popular_merchant_products/category/{category_id:int}

```sql
SELECT 
    pt.id AS product_id,
    pt.name->>'en_US' AS product_name,
    pt.description_sale AS description,
    pt.sold_count || ' ' || (uom.name->>'en_US') AS total_sold_qty,
    pt.ecommerce_float_price AS list_price,
    rcur.name AS currency,
    icp.value || '/api/v1/image/product.template/' || pt.id || '/image_1920' AS image,
    pt.average_rating,
   
    COALESCE(pp_count.total_variants, 0) AS total_variants,

    pt.t_is_featured AS is_featured,
    pt.is_halal,
    pt.is_arrival,

    EXISTS (
        SELECT 1
        FROM product_template_res_partner_rel ptr
        WHERE ptr.product_template_id = pt.id
        AND ptr.res_partner_id = rp.id
    ) AS is_wishlisted,

    COALESCE(discount_data.discounts, '[]'::json) AS discount,
    COALESCE(discount_data.product_discounts, 0) AS product_discounts

FROM product_template pt

LEFT JOIN res_company rc  
    ON rc.id = pt.company_id

LEFT JOIN res_partner rp
    ON rp.app_user_id =  %s--'51a0769721cb5557e0630b6f030a1579'

LEFT JOIN uom_uom uom
    ON uom.id = pt.uom_id

LEFT JOIN res_currency rcur 
    ON rcur.id = rc.currency_id


LEFT JOIN (
    SELECT 
        product_tmpl_id,
        COUNT(id) AS total_variants
    FROM product_product
    GROUP BY product_tmpl_id
) pp_count
    ON pp_count.product_tmpl_id = pt.id


LEFT JOIN LATERAL (
    SELECT
        json_agg(
            json_build_object(
                'name', d.name,
                'discount_type', d.discount_type,
                'discount_value', d.discount_value,
                'start_date', d.start_date,
                'end_date', d.end_date
            )
        ) FILTER (WHERE d.id IS NOT NULL AND d.is_active = true) AS discounts,

        COALESCE(
            SUM(
                CASE
                    WHEN d.discount_type IN ('percentage', 'percent')
                        THEN ROUND(
                            (
                                pt.ecommerce_float_price::numeric *
                                (d.discount_value::numeric / 100)
                            ),
                            2
                        )
                    ELSE
                        ROUND(
                            d.discount_value::numeric,
                            2
                        )
                END
            ) FILTER (
                WHERE d.id IS NOT NULL
                AND d.is_active = true
            ),
            0
        ) AS product_discounts


    FROM product_discount d
    WHERE d.product_tmpl_id = pt.id

) discount_data ON TRUE


CROSS JOIN ir_config_parameter icp

WHERE 
    icp.key = 'image.base.url'
    AND pec.id = %s -- 1
    AND rc.cps_enabled = true
	AND rc.is_delivery = false
	AND rc.active = true
	AND rc.merchant = %S --'MRT000001SPR'
    AND pt.x_superapp_approval_status = 'approved'
    AND pt.sold_count > 0
    AND rc.cps_enabled = true
    AND pt.ecommerce_float_price >= $s -- 0 
    AND pt.ecommerce_float_price <= %s --1000
    AND pt.is_in_stock = true
	OFFSET %s LIMIT %s;
```

## Endpoint 14 — GET /api/v1/popular_categories

```sql
SELECT 
pec.id AS category_id,
pec.name AS category_name,
pec.superapp_sale_count AS total_sold_qty,
COUNT(pt.id) AS product_count,
pec.image_url
FROM product_ecomerce_categories pec LEFT JOIN product_template pt ON pt.ecomerce_category_id = pec.id
GROUP BY pec.id,pec.name,pec.superapp_sale_count
OFFSET %s --0
LIMIT %s -- 10 ;
```


## Endpoint 15 — GET /api/v1/popular_categories/{merchant_id:string}

```sql
SELECT
    pec.id AS category_id,
    pec.name AS category_name,
    (
        SELECT COUNT(*)
        FROM product_template pt
        WHERE pt.ecomerce_category_id = pec.id
        AND (
            pt.company_id = rc.id
            OR pt.company_id IN (
                SELECT id FROM res_company WHERE parent_id = rc.id
            )
        )
    ) AS product_count,
    COUNT(sol.id) AS total_sold_qty,
    pec.image_url AS image
FROM sale_order_line sol
LEFT JOIN product_ecomerce_categories pec
    ON sol.category_id = pec.id
LEFT JOIN sale_order so
    ON sol.order_id = so.id
LEFT JOIN res_company rc
    ON so.company_id = rc.id
WHERE
    rc.merchant = %s --'MRT000001SPR'
    AND rc.cps_enabled = true
    AND so.superapp_order_status = 'delivered'
    AND so.is_superapp_order = true
    AND sol.category_id IS NOT NULL
GROUP BY
    pec.id,
    pec.name,
    pec.image_url,
    rc.id
ORDER BY
    COUNT(sol.id) DESC
LIMIT %s --10
OFFSET %s --0;
```


## Endpoint 16 — GET /api/v1/search/{query:string}

```sql
SELECT
	rc.id,
    rc.name,
	rc.merchant,
		cbt.code AS business_type,

	rc.logo_url AS logo,
	rc.banner_url AS banner,
	rc.is_featured,
	rc.email,
	rc.phone,
	rc.parent_id,
prc.merchant AS parent_merchant,
	COUNT(pt.id) AS product_template_count,
	COUNT(pp.id) AS product_variant_count
FROM res_company rc LEFT JOIN product_template pt ON pt.company_id = rc.id 
LEFT JOIN res_company prc ON rc.parent_id = prc.id
LEFT JOIN product_product pp ON pp.product_tmpl_id = pt.id LEFT JOIN company_business_type cbt ON cbt.id = rc.business_type_id
WHERE
    (
        rc.name ILIKE %s --'%afri%'
        OR rc.merchant ILIKE %s --'%afri%'
    )
    AND rc.cps_enabled = true
GROUP BY
rc.name,
rc.id,
cbt.code,
prc.merchant;
```

## Endpoint 17 — GET /api/v1/search/all/<query:string>

```sql
SELECT json_build_object(
'query','co',

    'merchants_count',
    (
        SELECT COUNT(DISTINCT rc.id)
        FROM res_company rc

        LEFT JOIN product_template pt
            ON pt.company_id = rc.id

        WHERE
            (
                rc.name ILIKE %s -- '%co%'
                OR rc.merchant ILIKE %s -- '%co%'
            )
            AND rc.cps_enabled = TRUE
            AND rc.is_delivery = FALSE
            AND pt.x_superapp_approval_status = 'approved'
    ),

    'merchants',
    COALESCE(
        (
            SELECT json_agg(company)
            FROM (
                SELECT
                    rc.id,
                    rc.name,
                    rc.merchant,
                    cbt.code AS business_type,
                    rc.logo_url AS logo,
                    rc.banner_url AS banner,
                    rc.is_featured,
                    rc.email,
                    rc.phone,
                    rc.parent_id,
                    prc.merchant AS parent_merchant,
                    COUNT(DISTINCT pt.id) AS product_template_count,
                    COUNT(DISTINCT pp.id) AS product_variant_count

                FROM res_company rc

                LEFT JOIN product_template pt
                    ON pt.company_id = rc.id

                LEFT JOIN product_product pp
                    ON pp.product_tmpl_id = pt.id

                LEFT JOIN res_company prc
                    ON rc.parent_id = prc.id

                LEFT JOIN company_business_type cbt
                    ON cbt.id = rc.business_type_id

                WHERE
                    (
                        rc.name ILIKE %s -- '%co%'
                        OR rc.merchant ILIKE %s -- '%co%'
                    )
                    AND rc.cps_enabled = TRUE
                    AND rc.is_delivery = FALSE
                    AND pt.x_superapp_approval_status = 'approved'

                GROUP BY
                    rc.id,
                    rc.name,
                    rc.merchant,
                    cbt.code,
                    rc.logo_url,
                    rc.banner_url,
                    rc.is_featured,
                    rc.email,
                    rc.phone,
                    rc.parent_id,
                    prc.merchant

            ) company
        ),
        '[]'::json
    ),
    'products_total',
    (
        SELECT COUNT(DISTINCT pt.id)
        FROM res_company rc

        LEFT JOIN product_template pt
            ON pt.company_id = rc.id

        WHERE
              COALESCE(
                        pt.name->>'en_US',
                        pt.name->>'en',
                        ''
                    ) ILIKE %s -- '%co%'
            
            AND rc.cps_enabled = TRUE
            AND rc.is_delivery = FALSE
            AND pt.x_superapp_approval_status = 'approved'
    ),
    'products',
    COALESCE(
        (
            SELECT json_agg(product)
            FROM (
                SELECT
                    pt.id,

                    COALESCE(
                        pt.name->>'en_US',
                        pt.name->>'en',
                        ''
                    ) AS name,

                    pt.default_code,
                    pt.list_price,

                    json_build_object(
                        'id', rc.id,
                        'name', rc.name,
                        'merchant', rc.merchant,
                        'logo', rc.logo_url
                    ) AS company,

                    pt.average_rating,

                    COUNT(pr.id) AS total_reviews

                FROM product_template pt

                JOIN res_company rc
                    ON rc.id = pt.company_id

                LEFT JOIN product_review pr
                    ON pr.product_template = pt.id

                WHERE
                    COALESCE(
                        pt.name->>'en_US',
                        pt.name->>'en',
                        ''
                    ) ILIKE %s -- '%co%'

                    AND rc.cps_enabled = TRUE
                    AND rc.is_delivery = FALSE
                    AND pt.x_superapp_approval_status = 'approved'

                GROUP BY
                    pt.id,
                    rc.id

            ) product
        ),
        '[]'::json
    ),
'categories_count',
    (
        SELECT COUNT(DISTINCT pec.id)
        FROM product_ecomerce_categories pec 
		WHERE pec.name ILIKE %s -- '%co%'
    ),
    'categories',
    COALESCE(
        (
            SELECT json_agg(category)
            FROM (
                SELECT
                    pec.id,
                    pec.name,
                    pec.complete_name,
                    pec.image_url

                FROM product_ecomerce_categories pec

                WHERE
                    pec.name ILIKE %s -- '%co%'

            ) category
        ),
        '[]'::json
    )

) AS result;
```

## Endpoint 18 — GET /api/v1/products/search/{query:string}

```sql
SELECT 
pt.id,pt.name->>'en_US' AS name,
pt.ecommerce_float_price AS list_price,
icp.value || '/api/v1/image/product.template/' || pt.id || '/image_1920' AS image_url,
pt.average_rating,
COUNT(pr.id) AS total_reviews,
json_build_object (
'id',rc.id,'name',rc.name,'merchant',rc.merchant,'logo',rc.logo_url
) AS company

FROM product_template pt 
LEFT JOIN res_company rc on rc.id = pt.company_id
LEFT JOIN product_review pr ON pr.product_template = pt.id 
CROSS JOIN ir_config_parameter icp
WHERE
icp.key = 'image.base.url'
AND rc.cps_enabled = true
AND COALESCE (
pt.name->>'en_US',
pt.name->>'en',
''
) ILIKE %s -- '%lo%'
GROUP BY pt.id,icp.value,rc.id; 
```

## Endpoint 19 — GET /api/v1/categories/search?query={query:string}

```sql
SELECT pec.id,
       pec.name,
       pec.complete_name,
       pec.image_url,
       COUNT(pt.id) AS items
FROM product_ecomerce_categories pec
    LEFT JOIN product_template pt ON pt.ecomerce_category_id = pec.id 
    LEFT JOIN res_company rc ON pt.company_id = rc.id
WHERE pec.name ILIKE %s -- '%co%'
    AND pt.x_superapp_approval_status = 'approved'
    AND rc.cps_enabled = true
    AND rc.is_delivery = false
GROUP BY
pec.id
OFFSET %s --0
LIMIT %s; --10;
```