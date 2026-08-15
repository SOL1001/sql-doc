# SQL Queries Reference
```ELST```



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



## Endpoint 4 — GET /api/v1/product/purchase_status

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



## Endpoint 5 — GET /api/v1/orders/list

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



## Endpoint 6 — GET /api/v1/categoryads

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


## Endpoint 7 — GET /api/v1/populars

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


## Endpoint 8 — GET /api/v1/popular_categories

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

## Endpoint 9 — GET /api/v1/popular_categories/{merchant_id:string}

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


## Endpoint 10 — GET /api/v1/popular_products

```sql
SELECT 
    pt.id AS product_id,
    pt.name->>'en_US' AS product_name,
    pt.description_sale AS description,
    pt.sold_count || ' ' || (uom.name->>'en_US') AS total_sold_qty,
    pt.ecommerce_float_price AS list_price,
    rcur.name AS currency,
    pt.image_1920_url AS image,
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

## Endpoint 11 — GET /api/v1/{merchant:string}/popular_merchant_products

```sql
SELECT 
    pt.id AS product_id,
    pt.name->>'en_US' AS product_name,
    pt.description_sale AS description,
    pt.sold_count || ' ' || (uom.name->>'en_US') AS total_sold_qty,
    pt.ecommerce_float_price AS list_price,
    rcur.name AS currency,
    pt.image_1920_url AS image,
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


## Endpoint 12 — GET /api/v1/{merchant:string}/popular_merchant_products/category/{category_id:int}

```sql
SELECT 
    pt.id AS product_id,
    pt.name->>'en_US' AS product_name,
    pt.description_sale AS description,
    pt.sold_count || ' ' || (uom.name->>'en_US') AS total_sold_qty,
    pt.ecommerce_float_price AS list_price,
    rcur.name AS currency,
    pt.image_1920_url AS image,
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

## Endpoint 13 — GET /api/v1/popular_categories

```sql
SELECT 
pec.id AS category_id,
pec.name AS category_name,
pec.superapp_sale_count AS total_sold_qty,
COUNT(pt.id) AS product_count,
pec.image_1_url
FROM product_ecomerce_categories pec LEFT JOIN product_template pt ON pt.ecomerce_category_id = pec.id
GROUP BY pec.id,pec.name,pec.superapp_sale_count
OFFSET %s --0
LIMIT %s -- 10 ;
```


## Endpoint 14 — GET /api/v1/popular_categories/{merchant_id:string}

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
    pec.image_1_url AS image
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
    pec.image_1_url,
    rc.id
ORDER BY
    COUNT(sol.id) DESC
LIMIT %s --10
OFFSET %s --0;
```


## Endpoint 15 — GET /api/v1/search/{query:string}

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

## Endpoint 16 — GET /api/v1/search/all/<query:string>

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
                    pec.image_1_url

                FROM product_ecomerce_categories pec

                WHERE
                    pec.name ILIKE %s -- '%co%'

            ) category
        ),
        '[]'::json
    )

) AS result;
```

## Endpoint 17 — GET /api/v1/products/search/{query:string}

```sql
SELECT 
pt.id,pt.name->>'en_US' AS name,
pt.ecommerce_float_price AS list_price,
pt.image_1920_url AS image_url,
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

## Endpoint 18 — GET /api/v1/categories/search?query={query:string}

```sql
SELECT pec.id,
       pec.name,
       pec.complete_name,
       pec.image_1_url,
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

## Endpoint 19 — GET /api/v1/total_products

```sql
WITH merchant_status_check AS (
    SELECT
        CASE
            WHEN NULLIF(TRIM(COALESCE(NULL::text, NULL::text)), '') IS NULL THEN 'valid'  -- replace with actual merchant param
            WHEN NOT EXISTS (
                SELECT 1 FROM res_company c
                WHERE c.merchant = NULL  -- bind :merchant here
                  AND c.cps_enabled = true
                  AND COALESCE(c.is_delivery, false) = false
                  AND c.active = true
            ) THEN 'not_found'
            WHEN EXISTS (
                SELECT 1 FROM res_company c
                JOIN res_company parent ON parent.id = COALESCE(c.parent_id, c.id)
                WHERE c.merchant = NULL  -- bind :merchant here
                  AND c.cps_enabled = true AND c.active = true
                  AND COALESCE(c.is_delivery, false) = false
                  AND c.merchant IS NOT NULL AND c.merchant != ''
            ) THEN 'valid'
            ELSE 'forbidden'
        END AS status
)
SELECT status FROM merchant_status_check;
-- App layer: if status = 'forbidden' -> return 403 "Merchant not available"
--            if status = 'not_found' -> return 404 "Merchant not found"
--            if status = 'valid'     -> proceed to main query below
-- ============================================================================

WITH params AS (
    SELECT
        'http://localhost:8062'::text AS base_url,
        NULL::text AS path_merchant,
        NULL::text AS query_merchant,
        1::int AS page,
        10::int AS per_page,
        500::int AS fetch_limit,
        0::numeric AS min_price,
        10000000::numeric AS max_price,
        NULL::int AS category_id,
        NULL::text AS app_user_id,
        NULL::text AS order_param,
        NULL::text AS high_to_low_param,
        NULL::text AS is_featured_param,
        NULL::text AS is_halal_param,
        NULL::text AS is_arrival_param,
        NULL::text AS is_discount_param
),
request_params AS (
    SELECT
        p.*,
        COALESCE(NULLIF(TRIM(path_merchant), ''), NULLIF(TRIM(query_merchant), '')) AS merchant,
        CASE
            WHEN lower(coalesce(is_featured_param, '')) IN ('1', 'true', 'yes') THEN true
            WHEN lower(coalesce(is_featured_param, '')) IN ('0', 'false', 'no') THEN false
            ELSE NULL
        END AS featured_filter,
        CASE
            WHEN lower(coalesce(is_halal_param, '')) IN ('1', 'true', 'yes') THEN true
            WHEN lower(coalesce(is_halal_param, '')) IN ('0', 'false', 'no') THEN false
            ELSE NULL
        END AS halal_filter,
        CASE
            WHEN lower(coalesce(is_arrival_param, '')) IN ('1', 'true', 'yes') THEN true
            WHEN lower(coalesce(is_arrival_param, '')) IN ('0', 'false', 'no') THEN false
            ELSE NULL
        END AS arrival_filter,
        lower(coalesce(is_discount_param, '')) IN ('1', 'true', 'yes') AS discount_only,
        CASE
            WHEN lower(coalesce(high_to_low_param, '')) IN ('1', 'true', 'yes') THEN 'desc'
            WHEN lower(coalesce(high_to_low_param, '')) IN ('0', 'false', 'no') THEN 'asc'
            WHEN lower(coalesce(order_param, '')) = 'asc' THEN 'asc'
            WHEN order_param IS NOT NULL THEN 'desc'
            ELSE NULL
        END AS price_sort_direction
    FROM params p
),
allowed_parent_companies AS (
    SELECT id
    FROM res_company
    WHERE parent_id IS NULL
        AND cps_enabled = true
        AND COALESCE(is_delivery, false) = false
        AND active = true
        AND merchant IS NOT NULL
        AND merchant != ''
),
allowed_companies AS (
    SELECT id
    FROM allowed_parent_companies
    UNION ALL
    SELECT c.id
    FROM res_company c
    JOIN allowed_parent_companies p ON c.parent_id = p.id
    WHERE c.cps_enabled = true
        AND c.active = true
        AND COALESCE(c.is_delivery, false) = false
        AND c.merchant IS NOT NULL
        AND c.merchant != ''
),

-- Stock data for is_in_stock filter / available_qty reporting.
-- The ORM uses a stored field 'is_in_stock' on product.template as the
-- actual FILTER (see product_base below); this CTE only recomputes the
-- underlying quantity for reporting available_qty / virtual_available.
stock_data AS (
    SELECT
        pp.product_tmpl_id,
        SUM(sq.quantity) AS available_qty
    FROM stock_quant sq
    JOIN product_product pp ON pp.id = sq.product_id
    JOIN product_template pt ON pt.id = pp.product_tmpl_id
    JOIN stock_location sl
        ON sl.id = sq.location_id
        AND sl.usage = 'internal'
        AND sl.company_id = pt.company_id
    GROUP BY pp.product_tmpl_id
),
-- Virtual available = qty_available - outgoing_qty (for reporting only)
outgoing_data AS (
    SELECT
        pp.product_tmpl_id,
        COALESCE(SUM(sm.product_qty), 0) AS outgoing_qty
    FROM stock_move sm
    JOIN product_product pp ON pp.id = sm.product_id
    JOIN stock_location src ON src.id = sm.location_id
    JOIN stock_location dest ON dest.id = sm.location_dest_id
    WHERE sm.state IN ('confirmed', 'partially_available', 'assigned', 'waiting')
      AND src.usage = 'internal'
      AND dest.usage != 'internal'
    GROUP BY pp.product_tmpl_id
),

dated_discount_products_for_filter AS (
    SELECT DISTINCT product_tmpl_id
    FROM product_discount
    WHERE is_active = true
        AND x_superapp_approval_status = 'approved'
        AND start_date IS NOT NULL AND start_date <= CURRENT_DATE
        AND end_date IS NOT NULL AND end_date >= CURRENT_DATE
),

active_loyalty_programs AS (
    SELECT
        lp.id,
        lp.name,
        lp.date_from,
        lp.date_to,
        lp.company_id
    FROM loyalty_program lp
    WHERE lp.program_type IN ('promotion')
        AND lp.is_ecommerce = true
        AND lp.x_superapp_approval_status = 'approved'
        AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
        AND (lp.date_to IS NULL OR lp.date_to >= CURRENT_DATE)
),

first_loyalty_per_company AS (
    SELECT DISTINCT ON (company_id)
        alp.id,
        alp.name,
        alp.date_from,
        alp.date_to,
        alp.company_id
    FROM active_loyalty_programs alp
    ORDER BY company_id, id  
),

active_loyalty_company AS (
    SELECT DISTINCT company_id
    FROM loyalty_program
    WHERE program_type IN ('promotion')
        AND is_ecommerce = true
        AND x_superapp_approval_status = 'approved'
        AND company_id IS NOT NULL
        AND (date_from IS NULL OR date_from <= CURRENT_DATE)
        AND (date_to IS NULL OR date_to >= CURRENT_DATE)
),

product_discount_data AS (
    SELECT
        pd.product_tmpl_id,
        jsonb_agg(
            jsonb_build_object(
                'name', pd.name,
                'discount_type', INITCAP(pd.discount_type),
                'discount_value', pd.discount_value::text,
                'start_date', TO_CHAR(pd.start_date, 'DD/MM/YY'),
                'end_date', TO_CHAR(pd.end_date, 'DD/MM/YY')
            ) ORDER BY pd.id
        ) AS discount,
        COALESCE(
            (SELECT SUM(
                CASE
                    WHEN pd2.discount_type = 'percentage' THEN
                        ROUND(GREATEST(pt.ecommerce_float_price - (pt.ecommerce_float_price * pd2.discount_value / 100), 0)::numeric, 2)
                    ELSE
                        ROUND(GREATEST(pt.ecommerce_float_price - pd2.discount_value, 0)::numeric, 2)
                END
            )
            FROM product_discount pd2
            JOIN product_template pt ON pt.id = pd2.product_tmpl_id
            WHERE pd2.product_tmpl_id = pd.product_tmpl_id
                AND pd2.is_active = true
                AND pd2.x_superapp_approval_status = 'approved'
                AND (pd2.start_date IS NULL OR pd2.start_date <= CURRENT_DATE)
                AND (pd2.end_date IS NULL OR pd2.end_date >= CURRENT_DATE)
            ), 0
        ) AS product_discounts
    FROM product_discount pd
    WHERE pd.is_active = true
        AND pd.x_superapp_approval_status = 'approved'
        AND (pd.start_date IS NULL OR pd.start_date <= CURRENT_DATE)
        AND (pd.end_date IS NULL OR pd.end_date >= CURRENT_DATE)
    GROUP BY pd.product_tmpl_id
),

loyalty_rewards_flat AS (
    SELECT
        flpc.company_id,
        flpc.name AS program_name,
        flpc.date_from,
        flpc.date_to,
        lr.id AS reward_id,
        lr.discount_mode,
        lr.discount
    FROM first_loyalty_per_company flpc
    JOIN loyalty_reward lr ON lr.program_id = flpc.id
),


final_discount_data AS (
    SELECT
        pt.id AS product_tmpl_id,
        pt.company_id,
        pt.ecommerce_float_price,
        CASE
            WHEN pdd.product_tmpl_id IS NOT NULL THEN pdd.discount
            ELSE COALESCE(lrp.discount_json, '[]'::jsonb)
        END AS discount,
        CASE
            WHEN pdd.product_tmpl_id IS NOT NULL THEN COALESCE(pdd.product_discounts, 0)
            ELSE COALESCE(lrp.product_discounts, 0)
        END AS product_discounts
    FROM product_template pt
    LEFT JOIN product_discount_data pdd ON pdd.product_tmpl_id = pt.id
    LEFT JOIN LATERAL (
        SELECT
            jsonb_agg(
                jsonb_build_object(
                    'name', lrf.program_name,
                    'discount_type', CASE WHEN lrf.discount_mode = 'percent' THEN 'Percentage' ELSE INITCAP(lrf.discount_mode) END,
                    'discount_value', lrf.discount::text,
                    'start_date', CASE WHEN lrf.date_from IS NOT NULL THEN TO_CHAR(lrf.date_from, 'DD/MM/YY') ELSE NULL END,
                    'end_date', CASE WHEN lrf.date_to IS NOT NULL THEN TO_CHAR(lrf.date_to, 'DD/MM/YY') ELSE NULL END
                ) ORDER BY lrf.reward_id
            ) AS discount_json,
            SUM(
                CASE
                    WHEN lrf.discount_mode = 'percent' THEN
                        ROUND(GREATEST(pt.ecommerce_float_price - (pt.ecommerce_float_price * lrf.discount / 100), 0)::numeric, 2)
                    ELSE
                        ROUND(GREATEST(pt.ecommerce_float_price - lrf.discount, 0)::numeric, 2)
                END
            ) AS product_discounts
        FROM loyalty_rewards_flat lrf
        WHERE lrf.company_id = pt.company_id
    ) lrp ON pdd.product_tmpl_id IS NULL
),

-- Wishlist check (is_wishlisted).
wishlist_check AS (
    SELECT DISTINCT
        pt.id AS product_tmpl_id,
        rp.id AS partner_id
    FROM product_template pt
    JOIN product_product pp ON pp.product_tmpl_id = pt.id
    JOIN wishlist wl ON wl.product_id = pp.id
    JOIN res_partner rp ON rp.id = wl.user_id
    WHERE wl.is_active = true
),
-- Product variant count (computed field, count active variants)
variant_count AS (
    SELECT
        pt.id AS product_tmpl_id,
        COUNT(pp.id)::int AS product_variant_count
    FROM product_template pt
    LEFT JOIN product_product pp ON pp.product_tmpl_id = pt.id AND pp.active = true
    GROUP BY pt.id
),
-- Review stats (stored fields if total_reviews/average_rating exist)
review_stats AS (
    SELECT
        pt.id AS product_tmpl_id,
        pt.total_reviews,
        pt.average_rating
    FROM product_template pt
),
color_attribute_values AS (
    SELECT DISTINCT
        pt.id AS product_tmpl_id,
        pa.id AS attribute_id,
        pa.name ->> 'en_US' AS attribute_name,
        pa.display_type,
        jsonb_build_object(
            'id', pav.id,
            'name', pav.name ->> 'en_US',
            'color', COALESCE(pav.html_color, '#FFFFFF')
        ) AS value_json
    FROM product_template pt
    JOIN product_template_attribute_line pal ON pal.product_tmpl_id = pt.id
    JOIN product_attribute pa ON pa.id = pal.attribute_id
    JOIN product_attribute_value_product_template_attribute_line_rel palvr ON palvr.product_template_attribute_line_id = pal.id
    JOIN product_attribute_value pav ON pav.id = palvr.product_attribute_value_id
    WHERE pa.display_type = 'color'
),
non_color_attribute_values AS (
    SELECT DISTINCT
        pt.id AS product_tmpl_id,
        pa.id AS attribute_id,
        pa.name ->> 'en_US' AS attribute_name,
        pa.display_type,
        jsonb_build_object(
            'id', pav.id,
            'name', pav.name ->> 'en_US'
        ) AS value_json
    FROM product_template pt
    JOIN product_template_attribute_line pal ON pal.product_tmpl_id = pt.id
    JOIN product_attribute pa ON pa.id = pal.attribute_id
    JOIN product_attribute_value_product_template_attribute_line_rel palvr ON palvr.product_template_attribute_line_id = pal.id
    JOIN product_attribute_value pav ON pav.id = palvr.product_attribute_value_id
    WHERE pa.display_type != 'color'
),
variant_attributes AS (
    SELECT DISTINCT
        pt.id AS product_tmpl_id,
        pa.id AS attribute_id,
        pa.name ->> 'en_US' AS attribute_name,
        pa.display_type,
        (SELECT jsonb_agg(
            CASE WHEN display_type = 'color' THEN
                jsonb_build_object(
                    'id', (value_json->>'id')::int,
                    'name', value_json->>'name',
                    'color', value_json->>'color'
                )
            ELSE
                jsonb_build_object(
                    'id', (value_json->>'id')::int,
                    'name', value_json->>'name'
                )
            END ORDER BY (value_json->>'id')::int
        )
         FROM (
             SELECT value_json, 'color' AS display_type FROM color_attribute_values c
             WHERE c.product_tmpl_id = pt.id AND c.attribute_id = pa.id
             UNION ALL
             SELECT value_json, 'non-color' AS display_type FROM non_color_attribute_values n
             WHERE n.product_tmpl_id = pt.id AND n.attribute_id = pa.id
         ) AS all_values) AS values_json
    FROM product_template pt
    JOIN product_template_attribute_line pal ON pal.product_tmpl_id = pt.id
    JOIN product_attribute pa ON pa.id = pal.attribute_id
),
variant_type_data AS (
    SELECT
        product_tmpl_id,
        jsonb_agg(
            jsonb_build_object(
                'id', attribute_id,
                'attribute', attribute_name,
                'values', values_json
            ) ORDER BY attribute_id
        ) AS variant_type
    FROM (
        SELECT DISTINCT
            product_tmpl_id,
            attribute_id,
            attribute_name,
            values_json
        FROM variant_attributes
    ) AS va
    GROUP BY product_tmpl_id
),
product_base AS (
    SELECT DISTINCT
        pt.id,
        pt.name,
        pt.description_sale,
        pt.ecommerce_float_price,
        pt.uom_id,
        pt.company_id,
        pt.t_is_featured,
        pt.is_halal,
        pt.is_arrival,
        pt.min_quantity,
        pt.max_quantity,
        pt.ecomerce_category_id,
        pt.has_image,
        pt.is_in_stock
    FROM product_template pt
    WHERE pt.active = true
        AND pt.is_for_ecommerce = true
        AND pt.x_superapp_approval_status = 'approved'
        AND pt.company_id IN (SELECT id FROM allowed_companies)
        -- Filter on stored is_in_stock field (matches ORM domain: ('is_in_stock', '=', True))
        AND pt.is_in_stock = true
),
product_with_stock AS (
    SELECT
        pb.*,
        c.merchant,
        c.name AS company_name,
        c.has_logo,
        -- available_qty from stock_data (same value used to calculate is_in_stock)
        COALESCE(sd.available_qty, 0) AS available_qty,
        -- virtual_available = qty_available - outgoing_qty
        COALESCE(sd.available_qty, 0) - COALESCE(og.outgoing_qty, 0) AS virtual_available
    FROM product_base pb
    JOIN res_company c ON c.id = pb.company_id
    LEFT JOIN stock_data sd ON sd.product_tmpl_id = pb.id
    LEFT JOIN outgoing_data og ON og.product_tmpl_id = pb.id
),
product_with_discounts AS (
    SELECT
        pws.*,
        COALESCE(fdd.discount, '[]'::jsonb) AS discount,
        COALESCE(fdd.product_discounts, 0) AS product_discounts
    FROM product_with_stock pws
    LEFT JOIN final_discount_data fdd ON fdd.product_tmpl_id = pws.id
),
product_with_reviews AS (
    SELECT
        pwd.*,
        COALESCE(rs.total_reviews, 0) AS total_review_count,
        rs.average_rating AS average_rating
    FROM product_with_discounts pwd
    LEFT JOIN review_stats rs ON rs.product_tmpl_id = pwd.id
),
product_with_variants AS (
    SELECT
        pwr.*,
        vc.product_variant_count AS total_variants,
        vt.variant_type AS variant_type
    FROM product_with_reviews pwr
    LEFT JOIN variant_count vc ON vc.product_tmpl_id = pwr.id
    LEFT JOIN variant_type_data vt ON vt.product_tmpl_id = pwr.id
),
-- Same 403/404 split fix as the preflight block above.
merchant_check AS (
    SELECT
        CASE
            WHEN (SELECT merchant FROM request_params LIMIT 1) IS NULL THEN 'valid'
            WHEN NOT EXISTS (
                SELECT 1 FROM res_company c
                WHERE c.merchant = (SELECT merchant FROM request_params LIMIT 1)
                  AND c.cps_enabled = true
                  AND COALESCE(c.is_delivery, false) = false
                  AND c.active = true
            ) THEN 'not_found'
            WHEN EXISTS (
                SELECT 1 FROM res_company c
                WHERE c.merchant = (SELECT merchant FROM request_params LIMIT 1)
                  AND c.cps_enabled = true
                  AND COALESCE(c.is_delivery, false) = false
                  AND c.active = true
                  AND c.id IN (SELECT id FROM allowed_companies)
            ) THEN 'valid'
            ELSE 'forbidden'
        END AS status
),

filtered_products AS (
    SELECT pwv.*
    FROM product_with_variants pwv
    CROSS JOIN request_params r
    CROSS JOIN merchant_check m
    WHERE m.status = 'valid'
        AND pwv.ecommerce_float_price BETWEEN r.min_price AND r.max_price
        AND (r.merchant IS NULL OR r.merchant = '' OR r.merchant = pwv.merchant)
        AND (r.category_id IS NULL OR r.category_id = 0 OR pwv.ecomerce_category_id = r.category_id)
        AND (r.featured_filter IS NULL OR COALESCE(pwv.t_is_featured, false) = r.featured_filter)
        AND (r.halal_filter IS NULL OR COALESCE(pwv.is_halal, false) = r.halal_filter)
        AND (r.arrival_filter IS NULL OR COALESCE(pwv.is_arrival, false) = r.arrival_filter)
        -- Uses dated_discount_products_for_filter (strict, non-null-tolerant
        -- dates -- see FIXED v3 note on that CTE above).
        AND (r.discount_only = false
             OR pwv.id IN (SELECT product_tmpl_id FROM dated_discount_products_for_filter)
             OR pwv.company_id IN (SELECT company_id FROM active_loyalty_company))
),
limited_products AS (
    SELECT fp.*
    FROM filtered_products fp
    CROSS JOIN request_params r
    ORDER BY
        CASE WHEN r.price_sort_direction = 'desc' THEN fp.ecommerce_float_price END DESC,
        CASE WHEN r.price_sort_direction = 'asc' THEN fp.ecommerce_float_price END ASC,
        fp.id DESC
    LIMIT (SELECT fetch_limit FROM params)
),

paginated_products AS (
    SELECT
        lp.*,
        COUNT(*) OVER () AS total_count,
        ROW_NUMBER() OVER (
            ORDER BY
                CASE WHEN (SELECT price_sort_direction FROM request_params LIMIT 1) = 'desc'
                    THEN lp.ecommerce_float_price END DESC,
                CASE WHEN (SELECT price_sort_direction FROM request_params LIMIT 1) = 'asc'
                    THEN lp.ecommerce_float_price END ASC,
                lp.id DESC
        ) AS row_num
    FROM limited_products lp
)
SELECT
    pp.id,
    pp.name ->> 'en_US' AS name,
    -- FIXED v3: NULLIF(...,'') to mirror `t.description_sale or None`
    -- (an empty translated string must come out as null, not "").
    NULLIF(pp.description_sale ->> 'en_US', '') AS product_description,
    CASE
        WHEN pp.has_image
            THEN r.base_url || '/api/v1/' || pp.merchant || '/image/product.template/' || pp.id
        ELSE NULL
    END AS product_image,
    pp.ecommerce_float_price AS list_price,
    u.name ->> 'en_US' AS "UoM",
    COALESCE(pp.discount, '[]'::jsonb) AS discount,
    COALESCE(pp.product_discounts, 0) AS product_discounts,
    COALESCE(pp.t_is_featured, false) AS is_featured,
    COALESCE(pp.is_halal, false) AS is_halal,
    COALESCE(pp.is_arrival, false) AS is_arrival,
    pp.available_qty AS available_quantity,
    NULLIF(pp.min_quantity, 0) AS min_quantity,
    NULLIF(pp.max_quantity, 0) AS max_quantity,
    pp.total_review_count,
    pp.average_rating,
    pp.total_variants,
    pp.variant_type AS variant_type,
    jsonb_build_object(
        'merchant', pp.merchant,
        'name', pp.company_name,
        'logo', CASE
            WHEN pp.has_logo THEN r.base_url || '/api/v1/merchant/logo/' || pp.company_id
            ELSE NULL
        END
    ) AS merchant,
    EXISTS (
        SELECT 1
        FROM wishlist_check wc
        CROSS JOIN request_params r
        WHERE wc.product_tmpl_id = pp.id
            AND r.app_user_id IS NOT NULL
            AND wc.partner_id IS NOT NULL
            AND EXISTS (
                SELECT 1 FROM res_partner rp WHERE rp.id = wc.partner_id AND rp.app_user_id = TRIM(r.app_user_id)
            )
    ) AS is_wishlisted,
    pp.available_qty AS available_qty,
    pp.virtual_available AS virtual_available
FROM paginated_products pp
CROSS JOIN request_params r
LEFT JOIN uom_uom u ON u.id = pp.uom_id
WHERE pp.row_num > ((SELECT page FROM params) - 1) * (SELECT per_page FROM params)
  AND pp.row_num <= ((SELECT page FROM params) - 1) * (SELECT per_page FROM params) + (SELECT per_page FROM params)
ORDER BY pp.row_num;
```

## Endpoint 20 — GET /api/v1/merchants/list_all

```sql
WITH params AS (
    SELECT
        'http://localhost:8062'::text AS base_url,
        1::int AS page,
        10::int AS per_page,
        NULL::text AS is_featured_param,
        NULL::text AS is_discount_param,
        false::boolean AS is_delivery_param,
        NULL::int AS limit_param  -- Optional limit on total records across all pages
),
limit_calc AS (
    SELECT 
        page::int AS page,
        per_page::int AS per_page,
        limit_param::int AS limit_param,
        NULLIF(limit_param::int, 0) AS effective_limit,
        lower(coalesce(is_discount_param, '')) IN ('1','true','yes') AS discount_filter_on
    FROM params
),
allowed_parents AS (
    SELECT c.*
    FROM res_company c
    CROSS JOIN params p
    WHERE c.parent_id IS NULL
      AND c.merchant IS NOT NULL
      AND c.merchant != ''
      AND c.cps_enabled = true
      AND c.active = true
      AND c.is_delivery = p.is_delivery_param
      AND (NOT (lower(coalesce(p.is_featured_param, '')) IN ('1','true','yes')) OR c.is_featured = true)
),
loyalty_company_ids AS (
    SELECT DISTINCT lp.company_id
    FROM loyalty_program lp
    WHERE lp.is_ecommerce = true
      AND lp.x_superapp_approval_status = 'approved'
      AND lp.company_id IS NOT NULL
      AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
      AND (lp.date_to IS NULL OR lp.date_to >= CURRENT_DATE)
),
filtered_parents AS (
    SELECT ap.*
    FROM allowed_parents ap
    CROSS JOIN limit_calc l
    WHERE NOT l.discount_filter_on
       OR ap.id IN (SELECT company_id FROM loyalty_company_ids)
),
counted AS (
    SELECT 
        COUNT(*) AS total_parents,
        (SELECT effective_limit FROM limit_calc) AS effective_limit,
        CASE 
            WHEN (SELECT effective_limit FROM limit_calc) IS NOT NULL 
                 AND COUNT(*) > (SELECT effective_limit FROM limit_calc)
            THEN (SELECT effective_limit FROM limit_calc)
            ELSE COUNT(*) 
        END AS effective_total
    FROM filtered_parents
),
paginated_parents AS (
    SELECT *
    FROM filtered_parents
    ORDER BY id DESC
    LIMIT (
        CASE 
            WHEN (SELECT effective_limit FROM limit_calc) IS NOT NULL THEN 
                LEAST(
                    (SELECT per_page FROM limit_calc),
                    GREATEST(0, (SELECT effective_limit FROM limit_calc) - ((SELECT page FROM limit_calc) - 1) * (SELECT per_page FROM limit_calc))
                )
            ELSE (SELECT per_page FROM limit_calc)
        END
    )
    OFFSET ((SELECT page FROM limit_calc) - 1) * (SELECT per_page FROM limit_calc)
),
product_counts AS (
    SELECT
        pt.company_id,
        COUNT(*)::int AS total_products
    FROM product_template pt
    WHERE pt.company_id IN (SELECT id FROM paginated_parents)
      AND pt.is_for_ecommerce = true
      AND pt.x_superapp_approval_status = 'approved'
      AND pt.active = true
    GROUP BY pt.company_id
),
loyalty_flags AS (
    SELECT
        lp.company_id,
        TRUE AS has_loyalty
    FROM loyalty_program lp
    WHERE lp.company_id IN (SELECT id FROM paginated_parents)
      AND lp.is_ecommerce = true
      AND lp.x_superapp_approval_status = 'approved'
      AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
      AND (lp.date_to IS NULL OR lp.date_to >= CURRENT_DATE)
    GROUP BY lp.company_id
),
-- Loyalty ordering: matches ORM's order = "sequence"
first_loyalty_per_company AS (
    SELECT DISTINCT ON (lp.company_id)
        lp.id,
        lp.name,
        lp.company_id,
        lp.sequence
    FROM loyalty_program lp
    WHERE lp.company_id IN (SELECT id FROM paginated_parents)
      AND lp.is_ecommerce = true
      AND lp.x_superapp_approval_status = 'approved'
      AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
      AND (lp.date_to IS NULL OR lp.date_to >= CURRENT_DATE)
    ORDER BY lp.company_id, lp.sequence, lp.id
),
loyalty_rewards_json AS (
    SELECT
        flpc.company_id,
        json_agg(
            json_build_object(
                'id', flpc.id,
                'name', flpc.name ->> 'en_US',
                'rewards',
                (
                    SELECT COALESCE(
                        json_agg(
                            json_build_object(
                                'reward_type', lr.reward_type,
                                'discount', lr.discount,
                                'discount_mode', lr.discount_mode,
                                'discount_applicability', lr.discount_applicability,
                                'description', lr.description ->> 'en_US'
                            )
                            ORDER BY lr.id
                        ),
                        '[]'::json
                    )
                    FROM loyalty_reward lr
                    WHERE lr.program_id = flpc.id
                )
            )
            ORDER BY flpc.id
        ) AS discount
    FROM first_loyalty_per_company flpc
    GROUP BY flpc.company_id
),
-- has_logo and has_banner: use stored computed fields from res_company
-- These are computed with store=True in threeclick_merchant_optimization module
-- has_logo = bool(company.logo), has_banner = bool(company.banner)
company_images AS (
    SELECT
        id AS company_id,
        has_logo,
        has_banner
    FROM res_company
    WHERE id IN (SELECT id FROM paginated_parents)
)
SELECT
    pp.id AS company_id,
    pp.name,
    pp.merchant AS merchant_id,

    CASE
        WHEN ci.has_logo
        THEN (SELECT base_url FROM params) || '/api/v1/merchant/logo/' || pp.id
        ELSE NULL
    END AS logo,

    CASE
        WHEN ci.has_banner
        THEN (SELECT base_url FROM params) || '/api/v1/merchant/banner/' || pp.id
        ELSE NULL
    END AS banner,

    bt.code AS business_type,

    COALESCE(pc.total_products, 0) AS total_products,

    -- "HH:MM AM/PM" — zero-padded hour:minute built from the numeric
    -- *_hour columns, moment upper-cased.
    -- Use FLOOR for minutes and LEAST to prevent :60 edge case from rounding
    LPAD(FLOOR(pp.open_hour)::int::text, 2, '0') || ':' ||
    LPAD(LEAST(FLOOR(((pp.open_hour - FLOOR(pp.open_hour)) * 60)::numeric), 59)::int::text, 2, '0') ||
    ' ' || upper(pp.open_moment) AS opening_time,

    LPAD(FLOOR(pp.close_hour)::int::text, 2, '0') || ':' ||
    LPAD(LEAST(FLOOR(((pp.close_hour - FLOOR(pp.close_hour)) * 60)::numeric), 59)::int::text, 2, '0') ||
    ' ' || upper(pp.close_moment) AS closing_time,

    NULLIF(pp.cps_account_number, '') AS cps_account_number,

    -- Always computed here; if is_discount/discount must be fully absent
    -- (not just false/[]) when ?is_discount isn't passed, that filtering
    -- needs to happen at the app layer when serializing each row.
    COALESCE(lf.has_loyalty, false) AS is_discount,

    COALESCE(lrj.discount, '[]'::json) AS discount,

    ci.has_logo,
    ci.has_banner

FROM paginated_parents pp
LEFT JOIN company_business_type bt
       ON bt.id = pp.business_type_id
LEFT JOIN product_counts pc
       ON pc.company_id = pp.id
LEFT JOIN loyalty_flags lf
       ON lf.company_id = pp.id
LEFT JOIN loyalty_rewards_json lrj
       ON lrj.company_id = pp.id
LEFT JOIN company_images ci
       ON ci.company_id = pp.id
CROSS JOIN counted c
ORDER BY pp.id DESC;
```

## Endpoint 21 — GET /api/v1/merchant/{merchant}

```sql
WITH params AS (
    SELECT
        'http://localhost:8062'::text AS base_url,
        'MRT00042R12'::text AS merchant
),
merchant_company AS (
    SELECT c.*
    FROM params p
    JOIN res_company c ON c.merchant = p.merchant
    WHERE c.active IS TRUE
    LIMIT 1
),
branches AS (
    SELECT b.*
    FROM res_company b
    JOIN merchant_company mc ON mc.id = b.parent_id
    WHERE b.cps_enabled IS TRUE
      AND COALESCE(b.is_delivery, FALSE) IS FALSE
      AND b.active IS TRUE
      AND b.merchant IS NOT NULL
      AND b.merchant != ''
),
company_ids AS (
    SELECT id FROM merchant_company
    UNION
    SELECT id FROM branches
),
template_counts AS (
    SELECT company_id, COUNT(*)::int AS product_template_count
    FROM product_template
    WHERE company_id IN (SELECT id FROM company_ids)
      AND active IS TRUE
      AND is_for_ecommerce IS TRUE
      AND x_superapp_approval_status = 'approved'
    GROUP BY company_id
),
variant_counts AS (
    SELECT pt.company_id, COUNT(*)::int AS product_variant_count
    FROM product_product pp
    JOIN product_template pt ON pt.id = pp.product_tmpl_id
    WHERE pt.company_id IN (SELECT id FROM company_ids)
      AND pp.active IS TRUE
      AND pt.is_for_ecommerce IS TRUE
      AND pt.x_superapp_approval_status = 'approved'
    GROUP BY pt.company_id
),
branch_payload AS (
    SELECT
        b.parent_id,
        jsonb_agg(
            jsonb_build_object(
                'id', b.id,
                'name', b.name,
                'branch_id', b.merchant,
                'is_featured', COALESCE(b.is_featured, FALSE),
                'business_type', bbt.code,
                'opening_time',
                    LPAD(FLOOR(COALESCE(b.open_hour, 0))::int::text, 2, '0')
                    || ':'
                    || LPAD(ROUND(((COALESCE(b.open_hour, 0) - FLOOR(COALESCE(b.open_hour, 0))) * 60)::numeric)::int::text, 2, '0')
                    || ' '
                    || UPPER(COALESCE(b.open_moment, '')),
                'closing_time',
                    LPAD(FLOOR(COALESCE(b.close_hour, 0))::int::text, 2, '0')
                    || ':'
                    || LPAD(ROUND(((COALESCE(b.close_hour, 0) - FLOOR(COALESCE(b.close_hour, 0))) * 60)::numeric)::int::text, 2, '0')
                    || ' '
                    || UPPER(COALESCE(b.close_moment, '')),
                'cps_account_number', NULLIF(b.cps_account_number, ''),
                'email', NULLIF(brp.email, ''),
                'phone', NULLIF(brp.phone, ''),
                'lat_location', NULLIF(b.lat_location, 0),
                'lng_location', NULLIF(b.lng_location, 0),
                'map_holder', NULLIF(b.map_holder, ''),
                'street', NULLIF(brp.street, ''),
                'city', NULLIF(brp.city, ''),
                'description', NULLIF(b.description, ''),
                'product_template_count', COALESCE(btc.product_template_count, 0),
                'product_variant_count', COALESCE(bvc.product_variant_count, 0),
                'is_delivery', COALESCE(b.is_delivery, FALSE),
                'is_ecommerce', NOT COALESCE(b.is_delivery, FALSE)
            )
            ORDER BY b.id
        ) AS branches
    FROM branches b
    LEFT JOIN template_counts btc ON btc.company_id = b.id
    LEFT JOIN variant_counts bvc ON bvc.company_id = b.id
    LEFT JOIN company_business_type bbt ON bbt.id = b.business_type_id
    LEFT JOIN res_partner brp ON brp.id = b.partner_id
    GROUP BY b.parent_id
)
SELECT
    c.id,
    c.name,
    c.merchant AS merchant_id,
    bt.code AS business_type,

    CASE
        WHEN c.has_logo IS NOT NULL AND c.has_logo != false
        THEN p.base_url || '/api/v1/merchant/logo/' || c.id
        ELSE NULL
    END AS logo,

    COALESCE(c.is_featured, FALSE) AS is_featured,

    CASE
        WHEN c.has_banner IS NOT NULL AND c.has_banner != false
        THEN p.base_url || '/api/v1/merchant/banner/' || c.id
        ELSE NULL
    END AS banner,

    LPAD(FLOOR(COALESCE(c.open_hour, 0))::int::text, 2, '0')
        || ':'
        || LPAD(ROUND(((COALESCE(c.open_hour, 0) - FLOOR(COALESCE(c.open_hour, 0))) * 60)::numeric)::int::text, 2, '0')
        || ' '
        || UPPER(COALESCE(c.open_moment, '')) AS opening_time,
    LPAD(FLOOR(COALESCE(c.close_hour, 0))::int::text, 2, '0')
        || ':'
        || LPAD(ROUND(((COALESCE(c.close_hour, 0) - FLOOR(COALESCE(c.close_hour, 0))) * 60)::numeric)::int::text, 2, '0')
        || ' '
        || UPPER(COALESCE(c.close_moment, '')) AS closing_time,
    NULLIF(c.cps_account_number, '') AS cps_account_number,
    NULLIF(c.lat_location, 0) AS lat_location,
    NULLIF(c.lng_location, 0) AS lng_location,
    NULLIF(c.map_holder, '') AS map_holder,
    NULLIF(rp.street, '') AS street,
    NULLIF(rp.city, '') AS city,
    NULLIF(c.description, '') AS description,
    COALESCE(bp.branches, '[]'::jsonb) AS branches,
    COALESCE(tc.product_template_count, 0) AS product_template_count,
    COALESCE(vc.product_variant_count, 0) AS product_variant_count,
    COALESCE(c.is_delivery, FALSE) AS is_delivery,
    NOT COALESCE(c.is_delivery, FALSE) AS is_ecommerce
FROM params p
JOIN merchant_company c ON TRUE
LEFT JOIN company_business_type bt ON bt.id = c.business_type_id
LEFT JOIN res_partner rp ON rp.id = c.partner_id
LEFT JOIN template_counts tc ON tc.company_id = c.id
LEFT JOIN variant_counts vc ON vc.company_id = c.id
LEFT JOIN branch_payload bp ON bp.parent_id = c.id;



-----------------------------------
```

## Endpoint 22 — GET /api/v1/wishlist/{user_id}

Returns a paginated list of wishlist items for a specific user, including product details, reviews, and active discounts (either direct product discounts or loyalty programs).

Tables: res_partner, wishlist, product_template, res_company, product_product, product_review, product_discount, loyalty_program, loyalty_reward

```sql
-- 1. Partner Resolution
SELECT id FROM res_partner WHERE app_user_id = $1 LIMIT 1;

-- 2. Total Count
SELECT COUNT(*) 
FROM wishlist wl
JOIN product_template pt ON pt.id = wl.product_id
LEFT JOIN res_company rc  ON rc.id = pt.company_id
WHERE wl.user_id = $1
  AND wl.is_active = TRUE
  AND rc.cps_enabled = TRUE
  AND wl.ecommerce_float_price >= $2
  AND wl.ecommerce_float_price <= $3
  -- AND pt.ecomerce_category_id = $4 (if category_id provided)
;

-- 3. Main Query
WITH base AS (
    SELECT
        wl.id,
        pt.id                                                         AS product_id,
        COALESCE(pt.name->>'en_US', pt.name::text)                    AS name,
        wl.ecommerce_float_price                                      AS price,
        COALESCE(rc.merchant, '')                                     AS merchant,
        pt.company_id
    FROM wishlist wl
    JOIN product_template pt ON pt.id = wl.product_id
    LEFT JOIN res_company rc  ON rc.id = pt.company_id
    WHERE wl.user_id = $1
      AND wl.is_active = TRUE
      AND rc.cps_enabled = TRUE
      AND wl.ecommerce_float_price >= $2
      AND wl.ecommerce_float_price <= $3
      -- AND pt.ecomerce_category_id = $4
    ORDER BY wl.id DESC -- or wl.ecommerce_float_price ASC/DESC
    LIMIT $4 OFFSET $5
)
SELECT
    b.id,
    b.product_id,
    b.name,
    rev.avg_rating,
    rev.total_review,
    
    (
        SELECT COUNT(*) FROM product_product pp
        WHERE pp.product_tmpl_id = b.product_id AND pp.active = TRUE
    ) AS total_variants,
    
    b.price,
    b.merchant,
    COALESCE(disc.discount_sum, loy.discount_sum)     AS discounts,
    COALESCE(disc.discount_json, loy.discount_json)   AS loyalty_programs
    
FROM base b

LEFT JOIN LATERAL (
    SELECT 
        AVG(pr.rating::numeric) AS avg_rating, 
        COUNT(pr.id)            AS total_review
    FROM product_review pr 
    WHERE pr.product_template = b.product_id
) rev ON true

LEFT JOIN LATERAL (
    SELECT 
        SUM(
            CASE WHEN d.discount_type = 'percentage'
                THEN ROUND((b.price - (b.price * d.discount_value / 100))::numeric, 2)
                ELSE ROUND((b.price - d.discount_value)::numeric, 2)
            END
        ) AS discount_sum,
        json_agg(json_build_object(
            'name',           d.name,
            'discount_type',  INITCAP(d.discount_type),
            'discount_value', CASE WHEN d.discount_value = FLOOR(d.discount_value) THEN d.discount_value::text || '.0' ELSE d.discount_value::text END,
            'start_date',     TO_CHAR(d.start_date, 'DD/MM/YY'),
            'end_date',       TO_CHAR(d.end_date, 'DD/MM/YY')
        )) AS discount_json
    FROM product_discount d
    WHERE d.product_tmpl_id = b.product_id
      AND d.is_active = TRUE
      AND d.company_id IS NOT NULL
      AND d.x_superapp_approval_status = 'approved'
      AND (d.start_date IS NULL OR d.start_date <= CURRENT_DATE)
      AND (d.end_date   IS NULL OR d.end_date   >= CURRENT_DATE)
) disc ON true

LEFT JOIN LATERAL (
    SELECT 
        SUM(
            ROUND((
                CASE WHEN lr.discount_mode = 'percent'
                    THEN b.price - (b.price * lr.discount / 100)
                    ELSE b.price - lr.discount
                END
            )::numeric, 2)
        ) AS discount_sum,
        json_agg(json_build_object(
            'name',           lp.name->>'en_US',
            'discount_type',  CASE WHEN lr.discount_mode = 'percent' THEN 'Percentage' ELSE INITCAP(lr.discount_mode) END,
            'discount_value', CASE WHEN lr.discount = FLOOR(lr.discount) THEN lr.discount::text || '.0' ELSE lr.discount::text END,
            'start_date',     TO_CHAR(lp.date_from, 'DD/MM/YY'),
            'end_date',       TO_CHAR(lp.date_to, 'DD/MM/YY')
        )) AS discount_json
    FROM loyalty_program lp
    JOIN loyalty_reward lr ON lr.program_id = lp.id
    WHERE lp.company_id = b.company_id
      AND lp.is_ecommerce = TRUE
      AND lp.x_superapp_approval_status = 'approved'
      AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
      AND (lp.date_to   IS NULL OR lp.date_to   >= CURRENT_DATE)
      AND disc.discount_sum IS NULL
) loy ON true

ORDER BY b.id DESC -- or b.price ASC/DESC
;
```


## Endpoint 23 — GET /api/v1/driver/orders

**Driver Orders List**

token: from request header `x-token`

```sql
SELECT
    dop.id,
    dop.name AS order_id,
    order_comp.logo_url AS logo,
    order_comp.name AS "from",

    json_build_object(
        'street', order_partner.street,
        'city', order_partner.city,
        'state', rcs.name
    ) AS pickup_location,

    json_build_object(
        'images',
        COALESCE(
            json_agg(
                DISTINCT
                icp.value
                || '/api/v1/image/product.template/'
                || pt.id
                || '/image_1920'
            ) FILTER (WHERE pt.id IS NOT NULL),
            '[]'::json
        ),
        'number',
        COUNT(pt.id)
    ) AS items,

    dop.delivery_date AS "date",
	dso.superapp_order_status AS status

FROM delivery_order dop

LEFT JOIN res_partner rp
    ON rp.id = dop.driver_assigned

LEFT JOIN res_users ru
    ON ru.partner_id = rp.id

LEFT JOIN res_company rc
    ON rc.id = dop.company_id

LEFT JOIN res_partner dop_partner
    ON dop_partner.id = dop.partner_id

LEFT JOIN res_company order_comp
    ON order_comp.name = dop_partner.name

LEFT JOIN res_partner order_partner
    ON order_partner.id = order_comp.partner_id

LEFT JOIN res_country_state rcs
    ON order_partner.state_id = rcs.id

LEFT JOIN delivery_order_line dol
    ON dol.delivery_order_id = dop.id

LEFT JOIN product_template pt
    ON dol.product_id = pt.id
LEFT JOIN sale_order dso ON dso.id = dop.so_id
CROSS JOIN ir_config_parameter icp

WHERE
    icp.key = 'image.base.url'
    AND ru.token =  %s    --'760e9d74bdc5ed81107e62aa4f589c99'
	AND ru.token_expiration_time > NOW()
 AND dop.state IN ('driver', 'picked')
GROUP BY
    dop.id,
    dop.name,
    order_comp.logo_url,
    order_comp.name,
    order_partner.street,
    order_partner.city,
	dso.superapp_order_status,
    rcs.name,
    dop.delivery_date
LIMIT %s --10
OFFSET %s --0;
```


## Endpoint 24 — GET /api/v1/driver/order/{order_id:int}

**Driver Order Detail**

token: from request header `x-token`

```sql
SELECT
    dop.id,
    dop.name AS ref_no,
	dso.superapp_order_status AS status,
    order_comp.logo_url AS logo,
	COALESCE(order_partner.street, '') || ', ' || COALESCE(order_partner.city, '') || ' ' || COALESCE(rcs.name, '') AS pickup_from, 
    dop.delivery_date,
	dop.delivery_pickup_code,
	customer.name AS customer_info,
	json_build_object (
'lat',dop.delivery_lat,'lng',dop.delivery_long
	) AS coordinates,

dop.delivery_notes AS additional_note,
	json_agg(
json_build_object(
'id',pt.id,'name',pt.name->>'en_US','image',pt.image_1920_url,
'qunatity',dol.quantity,'uom',uom.name->>'en_US','description',dol.description
)
	) AS items

FROM delivery_order dop

LEFT JOIN res_partner rp
    ON rp.id = dop.driver_assigned

LEFT JOIN res_users ru
    ON ru.partner_id = rp.id

LEFT JOIN res_company rc
    ON rc.id = dop.company_id

LEFT JOIN res_partner dop_partner
    ON dop_partner.id = dop.partner_id

LEFT JOIN res_company order_comp
    ON order_comp.name = dop_partner.name

LEFT JOIN res_partner order_partner
    ON order_partner.id = order_comp.partner_id

LEFT JOIN res_country_state rcs
    ON order_partner.state_id = rcs.id

LEFT JOIN delivery_order_line dol
    ON dol.delivery_order_id = dop.id
LEFT JOIN uom_uom uom ON dol.uom = uom.id

LEFT JOIN product_template pt
    ON dol.product_id = pt.id
LEFT JOIN sale_order dso ON dso.id = dop.so_id
LEFT JOIN res_partner customer ON dop.customer_id = customer.id
CROSS JOIN ir_config_parameter icp

WHERE
    icp.key = 'image.base.url'
    AND ru.token = %s --'760e9d74bdc5ed81107e62aa4f589c99'
	AND ru.token_expiration_time > NOW()
AND dop.state IN ('driver', 'picked')
 AND dop.id = %s --4

GROUP BY
    dop.id,
    dop.name,
    order_comp.logo_url,
    order_comp.name,
    order_partner.street,
    order_partner.city,
	dso.superapp_order_status,
	customer.id,
    rcs.name,
    dop.delivery_date;
```


## Endpoint 25 — GET /api/v1/driver/history

**Driver History List**

token: from request header `x-token`

```sql
SELECT
    dop.id,
    dop.name AS order_no,
	json_build_object(
'name',order_comp.name,'branch',order_partner.street
	) AS pickup_from,
	dop.delivery_date AS date,
	dop.state AS status
   
FROM delivery_order dop

LEFT JOIN res_partner rp
    ON rp.id = dop.driver_assigned

LEFT JOIN res_users ru
    ON ru.partner_id = rp.id

LEFT JOIN res_company rc
    ON rc.id = dop.company_id

LEFT JOIN res_partner dop_partner
    ON dop_partner.id = dop.partner_id

LEFT JOIN res_company order_comp
    ON order_comp.name = dop_partner.name

LEFT JOIN res_partner order_partner
    ON order_partner.id = order_comp.partner_id


CROSS JOIN ir_config_parameter icp

WHERE
    icp.key = 'image.base.url'
    AND ru.token = %s --'760e9d74bdc5ed81107e62aa4f589c99'
	AND ru.token_expiration_time > NOW()
AND dop.state IN ('delivered', 'canceled')

GROUP BY
    dop.id,
    dop.name,
    order_comp.name,
    order_partner.street

LIMIT %s --10
OFFSET %s --0;
```

## Endpoint 26 — GET /api/v1/categories

```sql
WITH params AS (
    SELECT
        'http://localhost:8062'::text AS base_url,
        1::int AS page,
        10::int AS per_page
),
roots AS (
    SELECT c.*
    FROM product_ecomerce_categories c
    WHERE c.parent_id IS NULL
      AND c.active IS TRUE
    ORDER BY c.id  
    LIMIT (SELECT per_page FROM params)
    OFFSET (SELECT (page - 1) * per_page FROM params)
),

total_count AS (
    SELECT COUNT(*)::int AS total
    FROM product_ecomerce_categories c
    WHERE c.parent_id IS NULL
      AND c.active IS TRUE
)

SELECT
    r.id,
    r.name,
    CASE WHEN r.has_image THEN p.base_url || '/api/v1/category/image/' || r.id ELSE NULL END AS image,
    CASE WHEN r.has_banner THEN p.base_url || '/api/v1/category/banner/' || r.id ELSE NULL END AS banner,
    COALESCE(r.product_count, 0) AS items,
    r.description
FROM params p
JOIN roots r ON TRUE
ORDER BY r.id;
```


## Endpoint 27 — GET /api/v1/categories/{category_id:int}

```sql
WITH params AS (
    SELECT
        'http://localhost:8062'::text AS base_url,
        1::int AS category_id   -- swap in the requested category id
),
target_category AS (
    SELECT c.*
    FROM product_ecomerce_categories c
    JOIN params p ON TRUE
    WHERE c.id = p.category_id
      AND c.active IS TRUE
    LIMIT 1
),
children AS (
    SELECT ch.*
    FROM product_ecomerce_categories ch
    JOIN target_category tc ON tc.id = ch.parent_id
    WHERE ch.active IS TRUE
),
children_json AS (
    SELECT
        json_agg(
            json_build_object(
                'id', ch.id,
                'name', COALESCE(ch.name, ''),
                'complete_name', COALESCE(ch.complete_name, ''),
                'image',
                    CASE
                        WHEN ch.has_image
                        THEN (SELECT base_url FROM params) || '/api/v1/category/image/' || ch.id
                        ELSE NULL
                    END,
                'banner',
                    CASE
                        WHEN ch.has_banner
                        THEN (SELECT base_url FROM params) || '/api/v1/category/banner/' || ch.id
                        ELSE NULL
                    END
            )
            ORDER BY ch.id
        ) AS children
    FROM children ch
),
parent_companies AS (
    SELECT c.id
    FROM res_company c
    WHERE c.parent_id IS NULL
      AND c.cps_enabled = true
      AND COALESCE(c.is_delivery, false) = false
      AND c.active = true
      AND c.merchant IS NOT NULL
      AND c.merchant != ''
),
branch_companies AS (
    SELECT c.id
    FROM res_company c
    JOIN parent_companies pc ON pc.id = c.parent_id
    WHERE c.cps_enabled = true
      AND COALESCE(c.is_delivery, false) = false
      AND c.active = true
      AND c.merchant IS NOT NULL
      AND c.merchant != ''
),
allowed_companies AS (
    SELECT id FROM parent_companies
    UNION
    SELECT id FROM branch_companies
),
product_count AS (
    SELECT COUNT(*)::int AS items
    FROM product_template pt
    JOIN target_category tc ON tc.id = pt.ecomerce_category_id
    WHERE pt.active IS TRUE
      AND pt.is_for_ecommerce IS TRUE
      AND pt.x_superapp_approval_status = 'approved'
      AND pt.company_id IN (SELECT id FROM allowed_companies)
)
SELECT
    tc.id,
    COALESCE(tc.name, '') AS name,
    CASE
        WHEN tc.has_image
        THEN (SELECT base_url FROM params) || '/api/v1/category/image/' || tc.id
        ELSE 'False'
    END AS image,

    CASE
        WHEN tc.parent_id IS NOT NULL
        THEN json_build_object(
                'id', parent.id,
                'name', COALESCE(parent.name, ''),
                'complete_name', COALESCE(parent.complete_name, ''),
                'image',
                    CASE
                        WHEN parent.has_image
                        THEN (SELECT base_url FROM params) || '/api/v1/category/image/' || parent.id
                        ELSE NULL
                    END
             )
        ELSE NULL
    END AS parent_category,

    COALESCE(cj.children, '[]'::json) AS child_categories,
    (SELECT COUNT(*)::int FROM children) AS child_count,
    COALESCE(pcnt.items, 0) AS items

FROM target_category tc
LEFT JOIN product_ecomerce_categories parent ON parent.id = tc.parent_id
LEFT JOIN children_json cj ON TRUE
CROSS JOIN product_count pcnt;




```


## Endpoint 28 — GET /api/v1/product/{product_tmpl_id:int}

```sql
WITH recursive params AS (
    SELECT
        'http://localhost:8062'::text AS base_url,
        13::int AS product_tmpl_id
),
allowed_parent_companies AS (
    SELECT id, parent_id
    FROM res_company
    WHERE parent_id IS NULL
        AND cps_enabled = true
        AND COALESCE(is_delivery,false)=false
        AND active=true
        AND merchant IS NOT NULL
        AND merchant!=''
),

allowed_companies AS (
    SELECT id, parent_id, 1 AS depth
    FROM allowed_parent_companies

    UNION ALL

    SELECT c.id, c.parent_id, ac.depth + 1
    FROM res_company c
    JOIN allowed_companies ac ON c.parent_id = ac.id
    WHERE ac.depth < 10 
        AND c.cps_enabled = true
        AND c.active = true
        AND COALESCE(c.is_delivery, false) = false
        AND c.merchant IS NOT NULL
        AND c.merchant != ''
),
product AS (
    SELECT
        pt.id,
        pt.name,
        pt.description_sale,
        pt.ecommerce_float_price,
        c.currency_id AS cost_currency_id, 
        pt.uom_id,
        pt.company_id,
        pt.t_is_featured,
        pt.is_halal,
        pt.is_arrival,
        pt.min_quantity,
        pt.max_quantity,
        pt.ecomerce_category_id,
        c.id AS company_id_joined,
        c.merchant,
        c.name AS merchant_name,
        c.logo_web,
        c.lat_location,
        c.lng_location,
        rp.city,
        st.name AS state_name
    FROM product_template pt
    JOIN res_company c
        ON c.id=pt.company_id
    LEFT JOIN res_partner rp
        ON rp.id=c.partner_id
    LEFT JOIN res_country_state st
        ON st.id=rp.state_id
    CROSS JOIN params p
    WHERE pt.id=p.product_tmpl_id
        AND pt.active=true
        AND pt.is_for_ecommerce=true
        AND pt.x_superapp_approval_status='approved'
        AND pt.company_id IN (
            SELECT id FROM allowed_companies
        )
),
active_product_discounts AS (
    SELECT
        pd.*
    FROM product_discount pd
    WHERE pd.is_active=true
        AND pd.x_superapp_approval_status='approved'
        AND (
            pd.start_date IS NULL
            OR pd.start_date<=CURRENT_DATE
        )
        AND (
            pd.end_date IS NULL
            OR pd.end_date>=CURRENT_DATE
        )
),
discount_data AS (
    SELECT
        pd.product_tmpl_id,
        jsonb_agg(
            jsonb_build_object(
                'name',
                pd.name,   
                'discount_type',
                INITCAP(pd.discount_type),
                'discount_value',
                pd.discount_value::text,
                'start_date',
                CASE
                    WHEN pd.start_date IS NOT NULL
                    THEN TO_CHAR(pd.start_date,'DD/MM/YY')
                    ELSE NULL
                END,
                'end_date',
                CASE
                    WHEN pd.end_date IS NOT NULL
                    THEN TO_CHAR(pd.end_date,'DD/MM/YY')
                    ELSE NULL
                END
            )
            ORDER BY pd.id
        ) AS discount,
        COALESCE(
            (SELECT SUM(
                CASE
                    WHEN pd2.discount_type='percentage'
                    THEN ROUND(
                        (
                            pt2.ecommerce_float_price -
                            (
                                pt2.ecommerce_float_price *
                                pd2.discount_value /
                                100
                            )
                        )::numeric,
                        2
                    )
                    ELSE ROUND(
                        (
                            pt2.ecommerce_float_price -
                            pd2.discount_value
                        )::numeric,
                        2
                    )
                END
            )
            FROM active_product_discounts pd2
            JOIN product_template pt2
                ON pt2.id=pd2.product_tmpl_id
            WHERE pd2.product_tmpl_id=pd.product_tmpl_id
            ), 0
        ) AS product_discounts
    FROM active_product_discounts pd
    GROUP BY pd.product_tmpl_id
),

active_loyalty_program AS (
    SELECT DISTINCT ON (lp.company_id)
        lp.id,
        lp.name,
        lp.date_from,
        lp.date_to,
        lp.company_id AS loyalty_company_id
    FROM loyalty_program lp
    JOIN allowed_companies ac ON ac.id = lp.company_id
    WHERE lp.program_type IN ('promotion')
        AND lp.is_ecommerce = true
        AND lp.x_superapp_approval_status = 'approved'
        AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
        AND (lp.date_to IS NULL OR lp.date_to >= CURRENT_DATE)
    ORDER BY lp.company_id, lp.sequence ASC, lp.id
),
loyalty_discount_data AS (
    SELECT
        pt_all.id AS product_tmpl_id,
        jsonb_agg(
            jsonb_build_object(
                'name',
                lp.name ->> 'en_US', 
                'discount_type',
                CASE
                    WHEN lr.discount_mode='percent'
                    THEN 'Percentage'
                    ELSE INITCAP(lr.discount_mode)
                END,
                'discount_value',
                lr.discount::text,
                'start_date',
                CASE
                    WHEN lp.date_from IS NOT NULL
                    THEN TO_CHAR(lp.date_from,'DD/MM/YY')
                    ELSE NULL
                END,
                'end_date',
                CASE
                    WHEN lp.date_to IS NOT NULL
                    THEN TO_CHAR(lp.date_to,'DD/MM/YY')
                    ELSE NULL
                END
            )
        ) AS discount,
        SUM(
            CASE
                WHEN lr.discount_mode='percent'
                THEN ROUND(
                    GREATEST(
                        pt_all.ecommerce_float_price -
                        (
                            pt_all.ecommerce_float_price *
                            lr.discount /
                            100
                        ),
                        0
                    )::numeric,
                    2
                )
                ELSE ROUND(
                    GREATEST(
                        pt_all.ecommerce_float_price -
                        lr.discount,
                        0
                    )::numeric,
                    2
                )
            END
        ) AS product_discounts
    FROM product_template pt_all
    JOIN active_loyalty_program lp ON lp.loyalty_company_id=pt_all.company_id
    JOIN loyalty_reward lr ON lr.program_id=lp.id
    WHERE pt_all.active=true
        AND pt_all.is_for_ecommerce=true
        AND pt_all.x_superapp_approval_status='approved'
    GROUP BY pt_all.id
),
final_discounts AS (
    SELECT
        p.id AS product_tmpl_id,
        CASE
            WHEN dd.discount IS NOT NULL AND jsonb_array_length(COALESCE(dd.discount, '[]'::jsonb)) > 0
            THEN dd.discount
            ELSE COALESCE(ld.discount,'[]'::jsonb)
        END AS discount,
        CASE
            WHEN dd.discount IS NOT NULL AND jsonb_array_length(COALESCE(dd.discount, '[]'::jsonb)) > 0
            THEN dd.product_discounts
            ELSE COALESCE(ld.product_discounts,0)
        END AS product_discounts
    FROM product p
    LEFT JOIN discount_data dd
        ON dd.product_tmpl_id=p.id
    LEFT JOIN loyalty_discount_data ld
        ON ld.product_tmpl_id=p.id
)
,review_data AS (
    SELECT
        pr.product_template,
        COUNT(*)::int AS total_reviews,
        ROUND(
            AVG(pr.rating::numeric),
            2
        ) AS average_rating
    FROM product_review pr
    GROUP BY pr.product_template
),
variant_stock AS (
    SELECT
        pp.id AS product_id,
        SUM(sq.quantity) AS qty_available,
        SUM(sq.quantity - COALESCE(sq.reserved_quantity, 0)) AS virtual_available
    FROM product_product pp
	JOIN product_template pt ON pt.id = pp.product_tmpl_id
    JOIN stock_quant sq ON sq.product_id=pp.id
    JOIN stock_location sl
        ON sl.id=sq.location_id
        AND sl.usage='internal'
        AND sl.company_id = pt.company_id
    GROUP BY pp.id
),
color_attribute_values AS (
    SELECT DISTINCT
        pt.id AS product_tmpl_id,
        pa.id AS attribute_id,
        pa.name ->> 'en_US' AS attribute_name,
        jsonb_build_object(
            'id',
            pav.id,
            'name',
            pav.name ->> 'en_US'
        ) AS value_json
    FROM product_template pt
    JOIN product_template_attribute_line pal
        ON pal.product_tmpl_id=pt.id
    JOIN product_attribute pa
        ON pa.id=pal.attribute_id
    JOIN product_attribute_value_product_template_attribute_line_rel palvr
        ON palvr.product_template_attribute_line_id=pal.id
    JOIN product_attribute_value pav
        ON pav.id=palvr.product_attribute_value_id
    WHERE pa.display_type='color'
),
non_color_attribute_values AS (
    SELECT DISTINCT
        pt.id AS product_tmpl_id,
        pa.id AS attribute_id,
        pa.name ->> 'en_US' AS attribute_name,
        jsonb_build_object(
            'id',
            pav.id,
            'name',
            pav.name ->> 'en_US'
        ) AS value_json
    FROM product_template pt
    JOIN product_template_attribute_line pal
        ON pal.product_tmpl_id=pt.id
    JOIN product_attribute pa
        ON pa.id=pal.attribute_id
    JOIN product_attribute_value_product_template_attribute_line_rel palvr
        ON palvr.product_template_attribute_line_id=pal.id
    JOIN product_attribute_value pav
        ON pav.id=palvr.product_attribute_value_id
    WHERE pa.display_type!='color'
),
template_attributes AS (
    SELECT
        x.product_tmpl_id,
        x.attribute_id,
        x.attribute_name,
        jsonb_agg(
            x.value_json
            ORDER BY
            (x.value_json->>'id')::int
        ) AS values_json
    FROM (
        SELECT
            product_tmpl_id,
            attribute_id,
            attribute_name,
            value_json
        FROM color_attribute_values
        UNION ALL
        SELECT
            product_tmpl_id,
            attribute_id,
            attribute_name,
            value_json
        FROM non_color_attribute_values
    ) x
    GROUP BY
        x.product_tmpl_id,
        x.attribute_id,
        x.attribute_name
),
variant_type_data AS (
    SELECT
        product_tmpl_id,
        jsonb_agg(
            jsonb_build_object(
                'id',
                attribute_id,
                'attribute',
                attribute_name,
                'values',
                values_json
            )
            ORDER BY attribute_id
        ) AS variant_type
    FROM template_attributes
    GROUP BY product_tmpl_id
),
variant_attributes AS (
    SELECT
        pp.id AS product_id,
        jsonb_agg(
            jsonb_build_object(
                'id',
                pa.id,
                'attribute',
                pa.name ->> 'en_US',
                'value_id',
                pav.id,
                'value',
                pav.name ->> 'en_US'
            )
            ORDER BY pa.id
        ) AS attributes
    FROM product_product pp
    JOIN product_variant_combination pvc
        ON pvc.product_product_id = pp.id
    JOIN product_template_attribute_value ptav
        ON ptav.id = pvc.product_template_attribute_value_id
    JOIN product_attribute_value pav
        ON pav.id = ptav.product_attribute_value_id
    JOIN product_attribute pa
        ON pa.id = pav.attribute_id
    GROUP BY pp.id
),
variant_discounts AS (
    SELECT
        pp.id AS product_id,
        fd.discount,
        fd.product_discounts
    FROM product_product pp
    JOIN final_discounts fd
        ON fd.product_tmpl_id=pp.product_tmpl_id
),
template_stock AS (
    SELECT
        pp.product_tmpl_id,
        SUM(sq.quantity) AS qty_available,
        SUM(sq.quantity - COALESCE(sq.reserved_quantity, 0)) AS virtual_available
    FROM product_product pp
	JOIN product_template pt ON pt.id = pp.product_tmpl_id
    JOIN stock_quant sq ON sq.product_id=pp.id
    JOIN stock_location sl
        ON sl.id=sq.location_id
        AND sl.usage='internal'
        AND sl.company_id = pt.company_id
    GROUP BY pp.product_tmpl_id
),
template_images AS (
    SELECT
        ia.res_id AS product_tmpl_id,
        jsonb_agg(
            jsonb_build_object(
                'field',
                ia.res_field,
                'url',
                ((SELECT base_url FROM params) || '/api/v1/image/' || ia.res_model || '/' || ia.res_id || '?field=' || ia.res_field)::text
            ) ORDER BY ia.id
        ) AS images
    FROM ir_attachment ia
    WHERE ia.res_model='product.template'
        AND ia.res_field IN ('image_1','image_2','image_3','image_4','image_5','image_6')
    GROUP BY ia.res_id
),
product_video_urls AS (
    SELECT
        pv.product_tmpl_id,
        pt.company_id,
        jsonb_agg(
            jsonb_build_object(
                'video_url',
                pv.url,
                'thumbnail_url',
                CASE
                    WHEN EXISTS (
                        SELECT 1 FROM ir_attachment ia
                        WHERE ia.res_model='product.video.url'
                            AND ia.res_id=pv.id
                            AND ia.res_field='video_thumbnail'
                    )
                    THEN (SELECT base_url FROM params) || '/api/v1/' || COALESCE((SELECT merchant FROM res_company WHERE id=pt.company_id LIMIT 1), 'merchant') || '/image/product.video.url/' || pv.id
                    ELSE NULL
                END
            ) ORDER BY pv.id
        ) AS videos
    FROM product_video_url pv
    JOIN product_template pt ON pt.id = pv.product_tmpl_id
    WHERE pv.url ILIKE '%m3u8%'
    GROUP BY pv.product_tmpl_id, pt.company_id
),
template_delivery_types AS (
    SELECT
        dtptr.product_template_id,
        jsonb_agg(dt.name ORDER BY dt.id) AS delivery_types,
        jsonb_agg(
            jsonb_build_object(
                'name', dt.name,
                'level', COALESCE(dt.priority_level, 0),
                'icon', CASE
                    WHEN EXISTS (SELECT 1 FROM ir_attachment ia
                        WHERE ia.res_model='delivery.type'
                          AND ia.res_id=dt.id
                          AND ia.res_field='icon')
                    THEN (SELECT base_url FROM params) || '/api/v1/image/delivery.type/' || dt.id || '/icon'
                    ELSE NULL
                END
            ) ORDER BY dt.id
        ) AS delivery_object
    FROM delivery_type_product_template_rel dtptr
    JOIN delivery_type dt ON dt.id = dtptr.delivery_type_id
    GROUP BY dtptr.product_template_id
),
product_specifications AS (
    SELECT
        ep.product_id AS product_tmpl_id,
        jsonb_agg(
            jsonb_build_object(
                'id',
                ep.id,
                'spec',
                es.name,
                'value',
                ep.value,
                'icon', NULL 
            ) ORDER BY ep.id
        ) AS specifications
    FROM ecomerce_product ep
    JOIN ecomerce_specs es ON es.id=ep.spec
    GROUP BY ep.product_id
),
variants AS (
    SELECT
        pp.product_tmpl_id,
        COUNT(*)::int AS total_variants,
        jsonb_agg(
            jsonb_build_object(
                'id',
                pp.id,
                'name',
                COALESCE(pt.name ->> 'en_US', ''),
                'product_category',
                COALESCE(
                    (SELECT pec_var.name FROM product_ecomerce_categories pec_var
                     WHERE pec_var.id = pt.ecomerce_category_id),
                    'General'
                ),
                'specifications',
                COALESCE(
                    (SELECT jsonb_agg(jsonb_build_object(
                        'id', ep.id,
                        'spec', es.name,
                        'value', ep.value,
                        'icon', (SELECT base_url FROM params) || '/api/v1/' || rc.merchant || '/image/ecomerce.product/' || ep.id || '/icon'
                     ) ORDER BY ep.id)
                     FROM ecomerce_product ep
                     JOIN ecomerce_specs es ON es.id = ep.spec
                     WHERE ep.product_id = pt.id),
                    '[]'::jsonb
                ),
                'delivery_types',
                COALESCE(
                    (SELECT jsonb_agg(dt.name ORDER BY dt.id)
                     FROM delivery_type_product_template_rel dtptr
                     JOIN delivery_type dt ON dt.id = dtptr.delivery_type_id
                     WHERE dtptr.product_template_id = pt.id),
                    '[]'::jsonb
                ),
                'delivery_object',
                COALESCE(
                    (SELECT jsonb_agg(jsonb_build_object(
                        'name', dt.name,
                        'level', COALESCE(dt.priority_level, 0),
                        -- FIX #5: Include actual delivery icon URL
                        'icon', CASE
                            WHEN EXISTS (SELECT 1 FROM ir_attachment ia
                                WHERE ia.res_model='delivery.type'
                                  AND ia.res_id=dt.id
                                  AND ia.res_field='icon')
                            THEN (SELECT base_url FROM params) || '/api/v1/image/delivery.type/' || dt.id || '/icon'
                            ELSE NULL
                        END
                     ) ORDER BY dt.id)
                     FROM delivery_type_product_template_rel dtptr
                     JOIN delivery_type dt ON dt.id = dtptr.delivery_type_id
                     WHERE dtptr.product_template_id = pt.id),
                    '[]'::jsonb
                ),
                'product_description',
                COALESCE(pt.description_sale ->> 'en_US', ''),
                'cost_currency',
                CASE
                    WHEN rc.currency_id IS NOT NULL
                    THEN jsonb_build_object(
                        'id', rc.currency_id,
                        'name', (SELECT name FROM res_currency WHERE id = rc.currency_id LIMIT 1)
                    )
                    ELSE jsonb_build_object('id', NULL, 'name', NULL)
                END,
                'list_price',
                pp.ecommerce_float_price,
                'UoM',
                CASE
                    WHEN pt.uom_id IS NOT NULL
                    THEN jsonb_build_object(
                        'id', pt.uom_id,
                        'name', (SELECT name ->> 'en_US' FROM uom_uom WHERE id = pt.uom_id LIMIT 1)
                    )
                    ELSE jsonb_build_object('id', NULL, 'name', NULL)
                END,
                'product_image',
                CASE
                    WHEN EXISTS (SELECT 1 FROM ir_attachment WHERE res_model='product.product' AND res_id=pp.id AND res_field='image_1920')
                    THEN (SELECT base_url FROM params) || '/api/v1/' || rc.merchant || '/image/product.product/' || pp.id
                    WHEN EXISTS (SELECT 1 FROM ir_attachment WHERE res_model='product.template' AND res_id=pt.id AND res_field='image_1920')
                    THEN (SELECT base_url FROM params) || '/api/v1/' || rc.merchant || '/image/product.template/' || pt.id
                    ELSE NULL
                END,
                'product_images',
                COALESCE(
                    (SELECT jsonb_agg(
                        jsonb_build_object(
                            'field', f.fld,
                            'url',
                            CASE
                                WHEN iav.id IS NOT NULL
                                THEN (SELECT base_url FROM params) || '/api/v1/' || rc.merchant || '/image/product.product/' || pp.id || '?field=' || f.fld
                                ELSE (SELECT base_url FROM params) || '/api/v1/' || rc.merchant || '/image/product.template/' || pt.id || '?field=' || f.fld
                            END
                        )
                        ORDER BY f.fld
                    )
                     FROM unnest(ARRAY['image_1','image_2','image_3','image_4','image_5','image_6']) AS f(fld)
                     LEFT JOIN ir_attachment iav
                        ON iav.res_model='product.product' AND iav.res_id=pp.id AND iav.res_field=f.fld
                     LEFT JOIN ir_attachment iat
                        ON iat.res_model='product.template' AND iat.res_id=pt.id AND iat.res_field=f.fld
                     WHERE iav.id IS NOT NULL OR iat.id IS NOT NULL),
                    '[]'::jsonb
                ),
                'qty_available',
                COALESCE(vs.qty_available, 0),
                'virtual_available',
                COALESCE(vs.virtual_available, 0),
                'variants_types',
                COALESCE(va.attributes, '[]'::jsonb),
                'is_featured',
                COALESCE(pp.v_is_featured, false),
                'discount',
                COALESCE(vd.discount, '[]'::jsonb),
                'product_discounts',
                COALESCE(vd.product_discounts, 0)
            )
            ORDER BY pp.id
        ) FILTER (WHERE pp.id IS NOT NULL) AS variants
    FROM product_product pp
    JOIN product_template pt
        ON pt.id = pp.product_tmpl_id
    JOIN res_company rc
        ON rc.id = pt.company_id
    LEFT JOIN product_ecomerce_categories pec
        ON pec.id = pt.ecomerce_category_id
    LEFT JOIN variant_stock vs
        ON vs.product_id = pp.id
    LEFT JOIN variant_attributes va
        ON va.product_id = pp.id
    LEFT JOIN variant_discounts vd
        ON vd.product_id = pp.id
    WHERE pp.active = true
        AND pt.x_superapp_approval_status = 'approved'
    GROUP BY pp.product_tmpl_id
)
,product_final AS (
    SELECT
        p.id,
        p.name,
        p.description_sale,
        p.ecommerce_float_price,
        p.cost_currency_id,
        p.uom_id,
        p.company_id,
        p.merchant,
        p.merchant_name,
        p.logo_web,
        p.lat_location,
        p.lng_location,
        p.city,
        p.state_name,
        p.t_is_featured,
        p.is_halal,
        p.is_arrival,
        p.min_quantity,
        p.max_quantity,
        p.ecomerce_category_id,
        COALESCE(ts.qty_available,0) AS qty_available,
        COALESCE(ts.virtual_available,0) AS virtual_available,
        COALESCE(fd.discount,'[]'::jsonb) AS discount,
        COALESCE(fd.product_discounts,0) AS product_discounts,
        COALESCE(rs.total_reviews,0) AS total_reviews,
        COALESCE(rs.average_rating,0) AS average_rating,
        COALESCE(v.total_variants,0) AS total_variants,
        COALESCE(v.variants,'[]'::jsonb) AS variants,
        COALESCE(vtd.variant_type,'[]'::jsonb) AS variant_type,
        COALESCE(ti.images,'[]'::jsonb) AS template_images
    FROM product p
    LEFT JOIN template_stock ts
        ON ts.product_tmpl_id=p.id
    LEFT JOIN final_discounts fd
        ON fd.product_tmpl_id=p.id
    LEFT JOIN review_data rs
        ON rs.product_template=p.id
    LEFT JOIN variants v
        ON v.product_tmpl_id=p.id
    LEFT JOIN variant_type_data vtd
        ON vtd.product_tmpl_id=p.id
    LEFT JOIN template_images ti
        ON ti.product_tmpl_id=p.id
)
SELECT
    pf.id,
    pf.name ->> 'en_US' AS name,
    CASE
        WHEN cat.id IS NOT NULL
        THEN jsonb_build_object(
            'id', cat.id,
            'name', cat.name
        )
        ELSE NULL
    END AS product_category,
    COALESCE(
        pf.description_sale ->> 'en_US',
        ''
    ) AS product_description,
    CASE
        WHEN EXISTS (
            SELECT 1 FROM ir_attachment ia
            WHERE ia.res_model='product.template'
                AND ia.res_id=pf.id
                AND ia.res_field='image_1920'
        )
        THEN r.base_url || '/api/v1/' || pf.merchant || '/image/product.template/' || pf.id
        ELSE NULL
    END AS product_image,
    COALESCE(
        pv.videos,
        '[]'::jsonb
    ) AS video_urls,
    pf.template_images AS product_images,
    CASE
        WHEN pf.cost_currency_id IS NOT NULL
        THEN jsonb_build_array(
            jsonb_build_object(
                'id',
                pf.cost_currency_id,
                'name',
                (SELECT name FROM res_currency WHERE id=pf.cost_currency_id LIMIT 1)
            )
        )
        ELSE '[]'::jsonb
    END AS cost_currency,
    ROUND(
        pf.ecommerce_float_price::numeric,
        2
    ) AS list_price,
    pf.qty_available,
    pf.virtual_available,
    pf.discount,
    pf.product_discounts,
    CASE
        WHEN u.id IS NOT NULL
        THEN jsonb_build_object(
            'id',
            u.id,
            'name',
            u.name ->> 'en_US'
        )
        ELSE NULL
    END AS "UoM",
    COALESCE(
        pf.t_is_featured,
        false
    ) AS is_featured,
    COALESCE(
        pf.variant_type,
        '[]'::jsonb
    ) AS variants_types,
    pf.total_variants,
    pf.variants,
    COALESCE(pf.is_halal, false) AS is_halal,
    COALESCE(pf.is_arrival, false) AS is_arrival,
    COALESCE(
        ps.specifications,
        '[]'::jsonb
    ) AS specifications,
    COALESCE(tdt.delivery_types, '[]'::jsonb) AS delivery_types,
    COALESCE(tdt.delivery_object, '[]'::jsonb) AS delivery_object,
    jsonb_build_object(
        'merchant',
        pf.merchant,
        'name',
        pf.merchant_name,
        'logo',
        CASE
            WHEN pf.logo_web IS NOT NULL
            THEN
                r.base_url ||
                '/api/v1/merchant/logo/' ||
                pf.company_id
            ELSE NULL
        END,
        'lat_location',
        pf.lat_location,
        'lng_location',
        pf.lng_location,
        'city',
        pf.city,
        'state',
        pf.state_name
    ) AS merchant_info,
    pf.min_quantity,
    pf.max_quantity,
    pf.average_rating,
    pf.total_reviews
FROM product_final pf
CROSS JOIN params r
LEFT JOIN product_ecomerce_categories cat
    ON cat.id=pf.ecomerce_category_id
LEFT JOIN product_video_urls pv
    ON pv.product_tmpl_id=pf.id
LEFT JOIN template_delivery_types tdt
    ON tdt.product_template_id=pf.id
LEFT JOIN product_specifications ps
    ON ps.product_tmpl_id=pf.id
LEFT JOIN uom_uom u
    ON u.id=pf.uom_id
WHERE pf.id=(SELECT product_tmpl_id FROM params)
LIMIT 1;
```

