# SQL Queries Reference



## Endpoint 1 — GET /api/v1/orders





**Step 1 — resolve customer partner**    
```
SELECT id
	FROM res_partner
	WHERE app_user_id = $1
	  AND active = TRUE
	LIMIT 1
```

**Step 2 — resolve merchant company (when merchant filter is provided)**
```
SELECT id
	FROM res_company
	WHERE merchant = $1
	  AND is_delivery = FALSE
	  AND merchant IS NOT NULL
	LIMIT 1
```
**Step 3 — page order ids (limit applies to orders, not line rows)**

```
q := `
	SELECT id
	FROM sale_order
	WHERE partner_id = $1
	  AND is_superapp_order = TRUE
	  AND ($2 = 0 OR company_id = $2)
	  AND ($4 = 0 OR id < $4)
	`
	switch history {
	case "active":
		q += `
	  AND superapp_order_status NOT IN ('cancelled', 'delivered')
	`
	case "inactive":
		q += `
	  AND superapp_order_status IN ('delivered', 'cancelled')
	`
	}
	q += `
	ORDER BY id DESC
	LIMIT $3
	`
```
**Step 4a — order fields only (PK lookup, no company joins)**
```
SELECT
	    id                     AS order_id,
	    name                   AS order_ref,
	    state                  AS order_state,
	    superapp_order_status  AS delivery_status,
	    date_order             AS date_order,
	    amount_total           AS total_price,
	    "deliveryType"         AS delivery_type,
	    driver_name            AS driver_name,
	    driver_mobile          AS driver_mobile,
	    driver_email           AS driver_email,
	    driver_delivery_medium AS delivery_medium,
	    company_id             AS company_id
	FROM sale_order
	WHERE id = ANY($1::int[])
	ORDER BY id DESC
```

**Step 4b — merchant/company data fetched once per distinct company on the page**
```
SELECT
	    rc.id              AS company_id,
	    rc.merchant        AS merchant_code,
	    rc.name            AS company_name,
	    NULLIF(TRIM(COALESCE(rc.logo_url, rp.image_1920_url, '')), '') AS logo_url,
	    rc.lat_location    AS lat,
	    rc.lng_location    AS lng,
	    rc.phone           AS company_phone,
	    rp.street          AS street,
	    rp.city            AS city,
	    rcs.name           AS state_name,
	    rco.name->>'en_US' AS country_name,
	    rcp.name           AS parent_name
	FROM res_company rc
	LEFT JOIN res_partner rp ON rp.id = rc.partner_id
	LEFT JOIN res_country_state rcs ON rcs.id = rp.state_id
	LEFT JOIN res_country rco ON rco.id = rp.country_id
	LEFT JOIN res_company rcp ON rcp.id = rc.parent_id
	WHERE rc.id = ANY($1::int[])
```
**Step 5 — line items for the page**
```
SELECT
	    sol.order_id       AS order_id,
	    sol.id             AS line_id,
	    sol.product_id     AS product_id,
	    sol.name           AS line_name,
	    sol.product_uom_qty AS qty,
	    sol.price_unit     AS price_unit,
	    sol.price_total    AS line_amount,
	    COALESCE(pt.name->>'en_US', pt.name::text) AS product_template_name,
	    u.name->>'en_US'   AS uom_name,
	    NULLIF(TRIM(COALESCE(pp.image_1920_url, pt.image_1920_url, '')), '') AS product_image
	FROM sale_order_line sol
	LEFT JOIN product_product pp ON pp.id = sol.product_id
	LEFT JOIN product_template pt ON pt.id = pp.product_tmpl_id
	LEFT JOIN uom_uom u ON u.id = sol.product_uom
	WHERE sol.order_id = ANY($1::int[])
	ORDER BY sol.order_id DESC, sol.id ASC
```
**Step 6 — variant attributes: filter products first (uses product_variant_combination_product_id_idx)**
```
SELECT
	    pvc.product_product_id AS product_id,
	    string_agg(pav.name->>'en_US', ', ' ORDER BY pa.sequence) AS product_attributes
	FROM product_variant_combination pvc
	INNER JOIN product_template_attribute_value ptav
	    ON ptav.id = pvc.product_template_attribute_value_id
	INNER JOIN product_attribute_value pav
	    ON pav.id = ptav.product_attribute_value_id
	INNER JOIN product_attribute pa
	    ON pa.id = pav.attribute_id
	WHERE pvc.product_product_id = ANY($1::int[])
	GROUP BY pvc.product_product_id
```

## Endpoint 2 — GET /api/v1/{merchant}/orders/{order_id}/status

**Step 1 — resolve merchant company**
```
SELECT id
	FROM res_company
	WHERE merchant = $1
	  AND is_delivery = FALSE
	  AND merchant IS NOT NULL
	LIMIT 1
```
**Step 2 — order header for one id scoped to merchant company**
```
SELECT
	    so.id                     AS order_id,
	    so.name                   AS order_name,
	    so.superapp_order_status  AS order_status,
	    ROUND((so.amount_total + COALESCE(dp.ecommerce_float_price, 0))::numeric, 2) AS amount_total,
	    so.invoice_status         AS invoice_status,
	    so.lock_id                AS lock_id,
	    so.ft_reference           AS ft_reference,
	    so.delivery_lat           AS delivery_lat,
	    so.delivery_long          AS delivery_long,
	    so.customer_pickup_code   AS pickup_code,
	    so.driver_name            AS driver_name,
	    so.driver_mobile          AS driver_mobile,
	    so.driver_delivery_medium AS driver_medium,
	    so."deliveryType"         AS delivery_type,
	    so.date_order             AS date_order,
	    dp.ecommerce_float_price  AS delivery_price,
	    so.company_id             AS company_id
	FROM sale_order so
	LEFT JOIN product_product dp
	       ON dp.id = so.delivery_product_id::integer
	      AND so.delivery_product_id IS NOT NULL
	      AND so.delivery_product_id != '0'
	WHERE so.id = $1
	  AND so.company_id = $2
	  AND so.is_superapp_order = TRUE
	LIMIT 1
```
**Step 3 — delivery count for one order**
```
SELECT COUNT(*)::int AS delivery_count
	FROM stock_picking
	WHERE sale_id = $1
```
**Step 4 — merchant/company data**
```
SELECT
	    rc.id              AS company_id,
	    rc.merchant        AS merchant_code,
	    rc.name            AS company_name,
	    NULLIF(TRIM(COALESCE(rc.logo_url, rp.image_1920_url, '')), '') AS logo_url,
	    rc.lat_location    AS lat,
	    rc.lng_location    AS lng,
	    rc.phone           AS company_phone,
	    rp.street          AS street,
	    rp.city            AS city,
	    rcs.name           AS state_name,
	    rco.name->>'en_US' AS country_name,
	    rcp.name           AS parent_name
	FROM res_company rc
	LEFT JOIN res_partner rp ON rp.id = rc.partner_id
	LEFT JOIN res_country_state rcs ON rcs.id = rp.state_id
	LEFT JOIN res_country rco ON rco.id = rp.country_id
	LEFT JOIN res_company rcp ON rcp.id = rc.parent_id
	WHERE rc.id = ANY($1::int[])
```
**Step 5 — line items for the order**
```
SELECT
	    sol.order_id          AS order_id,
	    sol.id                AS line_id,
	    sol.product_id        AS product_id,
	    sol.name              AS line_name,
	    sol.product_uom_qty   AS qty,
	    sol.price_unit        AS price_unit,
	    sol.price_total       AS line_amount,
	    COALESCE(pt.name->>'en_US', pt.name::text) AS product_template_name,
	    u.name->>'en_US'      AS uom_name,
	    NULLIF(TRIM(COALESCE(pp.image_1920_url, pt.image_1920_url, '')), '') AS product_image
	FROM sale_order_line sol
	LEFT JOIN product_product pp ON pp.id = sol.product_id
	LEFT JOIN product_template pt ON pt.id = pp.product_tmpl_id
	LEFT JOIN uom_uom u ON u.id = sol.product_uom
	WHERE sol.order_id = ANY($1::int[])
	ORDER BY sol.order_id DESC, sol.id ASC
```

**Step 6 — variant attributes for line products**
```
SELECT
	    pvc.product_product_id AS product_id,
	    string_agg(pav.name->>'en_US', ', ' ORDER BY pa.sequence) AS product_attributes
	FROM product_variant_combination pvc
	INNER JOIN product_template_attribute_value ptav
	    ON ptav.id = pvc.product_template_attribute_value_id
	INNER JOIN product_attribute_value pav
	    ON pav.id = ptav.product_attribute_value_id
	INNER JOIN product_attribute pa
	    ON pa.id = pav.attribute_id
	WHERE pvc.product_product_id = ANY($1::int[])
	GROUP BY pvc.product_product_id
```



## Endpoint 3 — GET /api/v1/product/{product_id}/reviews

**Step 1 — product exists (product_template.id)**
```
SELECT EXISTS(
	    SELECT 1
	    FROM product_template
	    WHERE id = $1
	)
```
**Step 2 — page review ids (cursor on review id DESC)**
```
SELECT id
	FROM product_review
	WHERE product_template = $1
	  AND ($3 = 0 OR id < $3)
	ORDER BY id DESC
	LIMIT $2
```
**Step 3 — review rows for the page**
```
SELECT
	    pr.id              AS review_id,
	    COALESCE(rp.name, 'Anonymous') AS user_name,
	    rp.app_user_id     AS app_user_id,
	    pr.rating          AS rating,
	    COALESCE(pr.review, '') AS review,
	    pr.create_date     AS create_date
	FROM product_review pr
	LEFT JOIN res_partner rp ON rp.id = pr.user_id
	WHERE pr.id = ANY($1::int[])
	ORDER BY pr.id DESC
```
**Step 4 — replies for the page reviews (single batch)**
```
SELECT
	    rr.review_id       AS review_id,
	    COALESCE(rp.name, 'Dev Team') AS reply_from,
	    COALESCE(rr.reply, '') AS reply,
	    rr.create_date     AS reply_date
	FROM review_reply rr
	LEFT JOIN res_partner rp ON rp.id = rr.user_id
	WHERE rr.review_id = ANY($1::int[])
	ORDER BY rr.review_id ASC, rr.id ASC
```

## Endpoint 4 — GET /api/v1/product/purchase_status

**Step 1 — resolve customer partner**
```
SELECT id
	FROM res_partner
	WHERE app_user_id = $1
	LIMIT 1
```
**Step 2 — check if product was bought in a confirmed superapp order**
```
SELECT EXISTS(
	    SELECT 1
	    FROM sale_order_line sol
	    JOIN sale_order so ON so.id = sol.order_id
	    WHERE so.partner_id = $1
	      AND so.is_superapp_order = TRUE
	      AND so.state IN ('sale', 'done')
	      AND sol.product_id = $2
	)
```

## Endpoint 5 — GET /api/v1/orders/list

**Step 1 — resolve customer partner**
```
SELECT id
	FROM res_partner
	WHERE app_user_id = $1
	  AND active = TRUE
	LIMIT 1
```
**Step 2 — order counts grouped by merchant company for one partner**
```
SELECT
	    rc.id              AS company_id,
	    rc.name            AS company_name,
	    rc.merchant        AS merchant,
	    NULLIF(TRIM(COALESCE(rc.logo_url, rp.image_1920_url, '')), '') AS logo_url,
	    COUNT(so.id)::int AS order_count
	FROM sale_order so
	JOIN res_company rc ON rc.id = so.company_id
	LEFT JOIN res_partner rp ON rp.id = rc.partner_id
	WHERE so.partner_id = $1
	  AND so.is_superapp_order = TRUE
	GROUP BY rc.id, rc.name, rc.merchant, rc.logo_url, rp.image_1920_url
	ORDER BY order_count DESC, company_name ASC, company_id ASC
```
**Step 3 — line item counts for page companies (non-cancelled orders only)**
```
SELECT
	    so.company_id      AS company_id,
	    COUNT(sol.id)::int AS item_count
	FROM sale_order_line sol
	JOIN sale_order so ON so.id = sol.order_id
	WHERE so.partner_id = $1
	  AND so.is_superapp_order = TRUE
	  AND so.superapp_order_status != 'cancelled'
	  AND so.company_id = ANY($2::int[])
	GROUP BY so.company_id
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
    c.id
    c.name AS name,
    c.logo_url,
    c.merchant,
    c.superapp_orders
FROM res_company c
WHERE c.parent_id IS NULL
  AND c.cps_enabled = true
  AND c.is_delivery = false
  AND c.active = true
  AND c.merchant IS NOT NULL
  AND c.superapp_orders > 0
  AND (c.id,c.superapp_orders) < (%cursor_id,%cursor_superapp_orders)
ORDER BY c.superapp_orders DESC
LIMIT %lim;
```


## Endpoint 8 — GET /api/v1/popular_categories

```sql
SELECT
    c.id AS category_id,
    c.name AS category_name,
    c.superapp_sale_count AS total_sold_qty,
    c.image_1_url AS image,
    c.superapp_sale_count,
    c.product_count AS product_count
FROM product_ecomerce_categories c

WHERE c.superapp_sale_count > 0 
AND (c.id,c.superapp_sale_count) < (%cursor_id,%cursor_super_app_sale_count)

ORDER BY c.superapp_sale_count DESC
LIMIT %lim; --10; 
```




## Endpoint 10 — GET /api/v1/popular_products

### Parameter Breakdown
#### ** Parameter on API 
| HTTP Query Parameter | Target Go Variable | Parsing Logic / Transformation | Default Value | Notes / Validation Rules |
| --- | --- | --- | --- | --- |
| `merchant` | `merchantParam` (`*string`) | `strings.TrimSpace(q.Get("merchant"))` | `nil` | When absent, triggers global resolution (Mode B) |
| `cursor_id` | `cursorID` (`*int64`) | `strconv.ParseInt(c, 10, 64)` | `nil` | Keyset anchor: Product ID from the previous page |
| `cursor_sold_count` | `cursorSold` (`*int`) | `strconv.Atoi(cs)` | `nil` | Keyset anchor: Units sold from the previous page |
| `per_page` | `perPage` (`int`) | `strconv.Atoi(p)` | `10` | Clamped to the range `[1, 100]` |
| `min_price` | `minPrice` (`float64`) | `strconv.ParseFloat(mp, 64)` | `0.0` | Bound filter: `ecommerce_float_price >= minPrice` |
| `max_price` | `maxPrice` (`float64`) | `strconv.ParseFloat(mp, 64)` | `10000000.0` | Bound filter: `ecommerce_float_price <= maxPrice` |
| `category_id` | `categoryID` (`int`) | `strconv.Atoi(cat)` | `0` | Filter by ecommerce category ID (`0` disables filter) |
| `is_halal` | `halalFilter` (`*bool`) | `parseTriState(...)` | `nil` | Maps `"true"`, `"1"`, `"yes"` $\rightarrow$ `true`; `"false"`, `"0"`, `"no"` $\rightarrow$ `false` |
| `sort_mode` | `sortMode` (`string`) | `strings.ToLower(strings.TrimSpace(...))` | `"sold_desc"` | Matches `"sold_asc"` or `"asc"`; defaults to `"sold_desc"` |

#### **Query Parameter Breakdown
| Query Step | Parameter Placeholder | Go Source Expression | PostgreSQL Data Type | Description |
| --- | --- | --- | --- | --- |
| **Step 1A** | `$1` | `*merchantParam` | `text` | Target merchant identifier. |
| **Step 1B** | *(None)* | *(None)* | *(None)* | Self-join evaluation with no bound parameters. |
| **Step 2** | `$1` | `pq.Array(companyIDs)` | `bigint[]` | Array of company IDs resolved in Step 1. |
| **Step 2** | Dynamic (`$2...`) | `categoryID` | `integer` | Filters by `pt.ecomerce_category_id`. |
| **Step 2** | Dynamic | `minPrice` | `double precision` | Lower price limit (`>=`). |
| **Step 2** | Dynamic | `maxPrice` | `double precision` | Upper price limit (`<=`). |
| **Step 2** | Dynamic | `*halalFilter` | `boolean` | `true` or `false` match on `pt.is_halal`. |
| **Step 2** | Dynamic (Cursor) | `*cursorSold`, `*cursorID` | `integer`, `bigint` | Keyset cursor tuple: `(sold_count, id)`. |
| **Step 2** | Dynamic (Limit) | `fetchLimit` (`perPage + 1`) | `integer` | Keyset window limit + 1 to calculate `has_more`. |
| **Step 3A** | `$1` | `pq.Array(productIDs)` | `bigint[]` | Array of product IDs returned from Step 2. |
| **Step 3B** | `$1` | `pq.Array(distinctCompanyIDs)` | `bigint[]` | Deduplicated list of company IDs from the page. |

#### **Step 1A: Merchant Pre-Resolution (When `merchant` is provided)**
```sql
SELECT c.id
FROM res_company c
WHERE c.merchant = $1
  AND c.active = TRUE
  AND c.cps_enabled = TRUE
  AND COALESCE(c.is_delivery, FALSE) = FALSE
LIMIT 1;
```

#### **Step 1B: Merchant Pre-Resolution (When `merchant` is omitted / nil)**
```sql
SELECT c.id
FROM res_company c
LEFT JOIN res_company p ON p.id = c.parent_id
WHERE c.cps_enabled = TRUE
  AND COALESCE(c.is_delivery, FALSE) = FALSE
  AND c.active = TRUE
  AND NULLIF(TRIM(c.merchant::text), '') IS NOT NULL
  AND (
      c.parent_id IS NULL 
      OR (
          p.parent_id IS NULL 
          AND p.cps_enabled = TRUE 
          AND COALESCE(p.is_delivery, FALSE) = FALSE 
          AND p.active = TRUE 
          AND NULLIF(TRIM(p.merchant::text), '') IS NOT NULL
      )
  );
```


#### **Step 2: Fetch Products by Popularity (Keyset Pagination)**
```sql
SELECT
    pt.id,
    pt.name ->> 'en_US' AS name,
    NULLIF(pt.description_sale ->> 'en_US', '') AS product_description,
    NULLIF(pt.image_1920_url, '') AS product_image,
    pt.ecommerce_float_price AS list_price,
    pt.company_id,
    COALESCE(pt.sold_count, 0) AS sold_count,
    COALESCE(pt.t_is_featured, FALSE) AS is_featured,
    COALESCE(pt.is_halal, FALSE) AS is_halal,
    COALESCE(pt.is_arrival, FALSE) AS is_arrival,
    COALESCE(NULLIF(TRIM(pt.product_variant_count_str::text), '')::int, 0) AS total_variants,
    COALESCE(pt.total_reviews, 0) AS total_review_count,
    COALESCE(pt.average_rating, 0.0) AS average_rating
FROM product_template pt
WHERE pt.active = TRUE
  AND pt.is_for_ecommerce = TRUE
  AND pt.is_in_stock = TRUE
  AND pt.sold_count > 0
  AND pt.x_superapp_approval_status = 'approved'
  AND pt.company_id = ANY($1)
  -- Dynamic filter clauses (appended conditionally):
  -- AND pt.ecomerce_category_id = $category_id
  -- AND pt.ecommerce_float_price >= $min_price
  -- AND pt.ecommerce_float_price <= $max_price
  -- AND COALESCE(pt.is_halal, FALSE) = $halal_filter
  -- Keyset cursor clause:
  -- When sort_mode = 'sold_asc':
  --   AND (pt.sold_count > $cursor_sold OR (pt.sold_count = $cursor_sold AND pt.id < $cursor_id))
  --   ORDER BY pt.sold_count ASC, pt.id DESC
  -- When sort_mode = 'sold_desc' (default):
  --   AND (pt.sold_count < $cursor_sold OR (pt.sold_count = $cursor_sold AND pt.id < $cursor_id))
  --   ORDER BY pt.sold_count DESC, pt.id DESC
LIMIT $limit;

```


#### **Step 3A: Batch Direct Product Discounts**
```sql
SELECT DISTINCT ON (pd.product_tmpl_id)
    pd.product_tmpl_id,
    pd.discount_type,
    pd.discount_value
FROM product_discount pd
WHERE pd.product_tmpl_id = ANY($1::bigint[])
  AND pd.is_active = TRUE
  AND pd.x_superapp_approval_status = 'approved'
  AND (pd.start_date IS NULL OR pd.start_date <= CURRENT_DATE)
  AND (pd.end_date IS NULL OR pd.end_date >= CURRENT_DATE)
ORDER BY pd.product_tmpl_id, pd.id ASC;
```

#### **Step 3B: Batch Loyalty Program Promotion Rewards**
```sql
SELECT DISTINCT ON (lp.company_id)
    lp.company_id,
    lp.primary_reward_discount_mode,
    lp.primary_reward_discount
FROM loyalty_program lp 
WHERE lp.company_id = ANY($1::bigint[])
  AND lp.program_type = 'promotion'
  AND lp.is_ecommerce = TRUE
  AND lp.x_superapp_approval_status = 'approved'
  AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
  AND (lp.date_to IS NULL OR lp.date_to >= CURRENT_DATE)
ORDER BY lp.company_id, lp.sequence, lp.id ASC;
```



## Endpoint 11 — GET /api/v1/{merchant:string}/popular_merchant_products
```sql
GET /api/v1/popular_products                       ─┐
(?merchant=MRT000001SPR optional query param)       │
                                                    ├──► ExecutePopularProductsFeed(ctx, merchantParam, filter)
GET /api/v1/{merchant}/popular_merchant_products   ─┤
(merchant required from URL path)                  ─┘
```


## Endpoint 12 — GET /api/v1/{merchant:string}/popular_merchant_products/category/{category_id:int}

```sql
GET /api/v1/popular_products                                               ─┐
(?merchant=MRT000001SPR optional query param)                               │
                                                                            ├──► ExecutePopularProductsFeed(ctx, merchantParam, filter)
GET /api/v1/{merchant}/popular_merchant_products/category/{id}             ─┤
(merchant and category_id striclty enforce required from URL path)         ─┘

```

## Endpoint 13 — GET /api/v1/popular_categories

```sql
SELECT 
    pec.id AS category_id,
    pec.name AS category_name,
    pec.superapp_sale_count AS total_sold_qty,
    pec.product_count AS product_count,
    pec.image_1_url
FROM product_ecomerce_categories pec
WHERE 
    pec.superapp_sale_count > 0 
    AND pec.superapp_sale_count < 1000
    AND (pec.superapp_sale_count, pec.id) < (%cursor_sale_count, %cursor_id)
ORDER BY 
    pec.superapp_sale_count DESC,
    pec.id DESC
LIMIT %lim;
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
                  SELECT id
                  FROM res_company
                  WHERE parent_id = rc.id
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
    rc.merchant = %s
    AND rc.cps_enabled = true
    AND so.superapp_order_status = 'delivered'
    AND so.is_superapp_order = true
    AND sol.category_id IS NOT NULL
GROUP BY
    pec.id,
    pec.name,
    pec.image_1_url,
    rc.id
HAVING
    %s IS NULL
    OR (
        COUNT(sol.id),
        pec.id
    ) < (
        %s,
        %s
    )
ORDER BY
    COUNT(sol.id) DESC,
    pec.id DESC
LIMIT %s;
```


## Endpoint 15 — GET /api/v1/search/{query:string}

```sql
WITH merchant_stats AS (
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

        (
            SELECT COUNT(*)
            FROM product_template pt
            WHERE pt.company_id = rc.id
              AND pt.active = true
              AND pt.sale_ok = true
              AND pt.x_superapp_approval_status = 'approved'
        ) AS product_template_count,

        (
            SELECT COUNT(*)
            FROM product_product pp
            INNER JOIN product_template pt
                ON pp.product_tmpl_id = pt.id
            WHERE pt.company_id = rc.id
              AND pp.active = true
              AND pt.active = true
              AND pt.sale_ok = true
              AND pt.x_superapp_approval_status = 'approved'
        ) AS product_variant_count

    FROM res_company rc
    LEFT JOIN res_company prc
        ON rc.parent_id = prc.id
    LEFT JOIN company_business_type cbt
        ON cbt.id = rc.business_type_id

    WHERE (
        rc.name ILIKE '%a%'
        OR rc.merchant ILIKE '%a%'
    )
    AND rc.cps_enabled = true
    AND (
        
         rc.id > %(cursor_id)
    )

    ORDER BY rc.id ASC
    LIMIT %(lim)
)
SELECT
    json_build_object(
        'status', 'success',
        'merchants', COALESCE(
            json_agg(
                json_build_object(
                    'id', ms.id,
                    'name', ms.name,
                    'merchant', ms.merchant,
                    'business_type', ms.business_type,
                    'logo', ms.logo,
                    'banner', ms.banner,
                    'is_featured', ms.is_featured,
                    'email', ms.email,
                    'phone', ms.phone,
                    'parent_id', ms.parent_id,
                    'parent_merchant', ms.parent_merchant,
                    'product_template_count', ms.product_template_count,
                    'product_variant_count', ms.product_variant_count
                )
                ORDER BY ms.id ASC
            ),
            '[]'::json
        )
    ) AS response
FROM merchant_stats ms;
```

## Endpoint 16 — GET /api/v1/search/all/<query:string>

```sql
SELECT json_build_object(
    'query', %s,                
	
    'merchants_count', (
        SELECT COUNT(DISTINCT rc.id)
        FROM res_company rc
        JOIN product_template pt
            ON pt.company_id = rc.id
           AND pt.x_superapp_approval_status = 'approved'
        WHERE (rc.name ILIKE %s OR rc.merchant ILIKE %s)
          AND rc.cps_enabled = TRUE
          AND rc.is_delivery = FALSE
    ),

    'merchants', COALESCE((
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
               AND pt.x_superapp_approval_status = 'approved'
            LEFT JOIN product_product pp
                ON pp.product_tmpl_id = pt.id
            LEFT JOIN res_company prc
                ON rc.parent_id = prc.id
            LEFT JOIN company_business_type cbt
                ON cbt.id = rc.business_type_id
            WHERE (rc.name ILIKE %s OR rc.merchant ILIKE %s)
              AND rc.cps_enabled = TRUE
              AND rc.is_delivery = FALSE
            GROUP BY
                rc.id, rc.name, rc.merchant, cbt.code,
                rc.logo_url, rc.banner_url, rc.is_featured,
                rc.email, rc.phone, rc.parent_id, prc.merchant
            ORDER BY rc.id ASC
            LIMIT %s
        ) company
    ), '[]'::json),
	
    'products_total', (
        SELECT COUNT(DISTINCT pt.id)
        FROM product_template pt
        JOIN res_company rc ON rc.id = pt.company_id
        WHERE COALESCE(pt.name->>'en_US', pt.name->>'en', '') ILIKE %s
          AND rc.cps_enabled = TRUE
          AND rc.is_delivery = FALSE
          AND pt.x_superapp_approval_status = 'approved'
    ),

    'products', COALESCE((
        SELECT json_agg(product)
        FROM (
            SELECT
                pt.id,
                COALESCE(pt.name->>'en_US', pt.name->>'en', '') AS name,
                pt.image_1920_url AS image_url,
                pt.ecommerce_float_price AS list_price,
                json_build_object(
                    'id',       rc.id,
                    'name',     rc.name,
                    'merchant', rc.merchant,
                    'logo',     rc.logo_url
                ) AS company,
                pt.average_rating,
                COUNT(pr.id) AS total_reviews
            FROM product_template pt
            JOIN res_company rc ON rc.id = pt.company_id
            LEFT JOIN product_review pr ON pr.product_template = pt.id
            WHERE COALESCE(pt.name->>'en_US', pt.name->>'en', '') ILIKE %s
              AND rc.cps_enabled = TRUE
              AND rc.is_delivery = FALSE
              AND pt.x_superapp_approval_status = 'approved'
            GROUP BY pt.id, rc.id
            ORDER BY pt.id ASC
            LIMIT %s
        ) product
    ), '[]'::json),

    'categories_count', (
        SELECT COUNT(*)
        FROM product_ecomerce_categories pec
        WHERE pec.name ILIKE %s
    ),

    'categories', COALESCE((
        SELECT json_agg(category)
        FROM (
            SELECT
                pec.id,
                pec.name,
                pec.complete_name,
                pec.image_1_url
            FROM product_ecomerce_categories pec
            WHERE pec.name ILIKE %s
            ORDER BY pec.id ASC
            LIMIT %s
        ) category
    ), '[]'::json)

) AS result;
```

## Endpoint 17 — GET /api/v1/products/search/{query:string}

```sql
SELECT
    pt.id,
    COALESCE(pt.name->>'en_US', pt.name->>'en', '') AS name,
    pt.ecommerce_float_price AS list_price,
    pt.image_1920_url AS image_url,
    pt.average_rating,
    COALESCE(pt.total_reviews, 0) AS total_reviews,
    json_build_object(
        'id', rc.id,
        'name', rc.name,
        'merchant', rc.merchant,
        'logo', rc.logo_url
    ) AS company
FROM product_template pt
JOIN res_company rc
    ON rc.id = pt.company_id
   AND rc.cps_enabled = true
WHERE COALESCE(
    pt.name->>'en_US',
    pt.name->>'en',
    ''
) ILIKE  %s --'%e%'
AND (
    COALESCE(pt.reviews_count, 0),
    pt.id
) < (%s, %s)
ORDER BY
    COALESCE(pt.reviews_count, 0) DESC,
    pt.id DESC
LIMIT %lim;
```

## Endpoint 18 — GET /api/v1/categories/search?query={query:string}

```sql
SELECT
    pec.id,
    pec.name,
    pec.complete_name,
    pec.image_1_url AS image,
    pec.product_count AS items,
    parent.id AS parent_id,
    parent.name AS parent_name
FROM product_ecomerce_categories pec
LEFT JOIN product_ecomerce_categories parent
    ON pec.parent_id = parent.id
WHERE
    pec.name ILIKE '%e%'
	AND pec.product_count > 0
   AND pec.id < %cursor_id
GROUP BY
    pec.id,
    parent.id
ORDER BY
    pec.id DESC
LIMIT %lim;
```

## Endpoint 19 — GET /api/v1/total_products
### 2. Query Parameter Breakdown
| Step | Parameter | Source Expression | DB Type | Description |
| --- | --- | --- | --- | --- |
| **Step 1A** | `$1` | `*merchantParam` | `text` | Target merchant code (e.g. `MRT000001SPR`). |
| **Step 1B** | *(None)* | *(None)* | *(None)* | Unparameterized self-join query. |
| **Step 2** | `$1` | `pq.Array(companyIDs)` | `bigint[]` | Array of company IDs resolved in Step 1. |
| **Step 2** | Dynamic | `categoryID` | `integer` | Filters by `pt.ecomerce_category_id`. |
| **Step 2** | Dynamic | `minPrice` | `double precision` | Minimum list price (`>=`). |
| **Step 2** | Dynamic | `maxPrice` | `double precision` | Maximum list price (`<=`). |
| **Step 2** | Dynamic | `*featuredFilter` | `boolean` | Match on `pt.t_is_featured`. |
| **Step 2** | Dynamic | `*halalFilter` | `boolean` | Match on `pt.is_halal`. |
| **Step 2** | Dynamic | `*arrivalFilter` | `boolean` | Match on `pt.is_arrival`. |
| **Step 2** | Dynamic (Cursor) | `*cursorPrice`, `*cursorID` | `double precision`, `bigint` | Keyset pagination anchor values. |
| **Step 2** | Dynamic (Limit) | `fetchLimit` (`perPage + 1`) | `integer` | Number of items to fetch to determine `has_more`. |
| **Step 3A** | `$1` | `pq.Array(productIDs)` | `bigint[]` | Array of IDs of products present on the page. |
| **Step 3B** | `$1` | `pq.Array(distinctCompanyIDs)` | `bigint[]` | Array of company IDs present on the page. |


#### Query Parameters
| Parameter | Type | Required | Default | Values / Behavior |
| --- | --- | --- | --- | --- |
| `merchant` | string | No | `null` | Merchant code identifier. |
| `per_page` | integer | No | `10` | Number of items per page (clamped between `1` and `100`). |
| `cursor_id` | integer | No | `null` | Pagination cursor: ID of the last item on the previous page. |
| `cursor_price` | float | No | `null` | Pagination cursor: list price of the last item (used for price sorts). |
| `sort_mode` | string | No | `id_desc` | Sort type: `id_desc`, `price_desc`, `price_asc`. |
| `high_to_low` | string | No | `null` | Legacy price sort override: `true`/`1` sets `price_desc`; `false`/`0` sets `price_asc`. |
| `category_id` | integer | No | `0` | Filter by `ecomerce_category_id` (`0` disables filter). |
| `min_price` | float | No | `0.0` | Minimum `ecommerce_float_price`. |
| `max_price` | float | No | `10000000.0` | Maximum `ecommerce_float_price`. |
| `is_featured` | string | No | `null` | Tri-state boolean (`true`/`false`). |
| `is_halal` | string | No | `null` | Tri-state boolean (`true`/`false`). |
| `is_arrival` | string | No | `null` | Tri-state boolean (`true`/`false`). |
| `is_discount` | string | No | `false` | When `true`/`1`, returns only products that have an active discount. |

#### **Step 1A: Targeted Merchant Lookup (When `merchant` is provided)**
Executed when the `merchant` query parameter is present:
```sql
SELECT 
    c.id, 
    c.merchant, 
    c.name, 
    NULLIF(c.logo_url, '') AS logo_url
FROM res_company c
WHERE c.merchant = $1
  AND c.active = TRUE
  AND c.cps_enabled = TRUE
  AND COALESCE(c.is_delivery, FALSE) = FALSE
LIMIT 1;
```

#### **Step 1B: Global Merchant Resolution (When `merchant` is omitted / nil)**
Executed when no `merchant` parameter is supplied, retrieving all root companies and valid children of root companies:
```sql
SELECT 
    c.id, 
    c.merchant, 
    c.name, 
    NULLIF(c.logo_url, '') AS logo_url
FROM res_company c
LEFT JOIN res_company p ON p.id = c.parent_id
WHERE c.cps_enabled = TRUE
  AND COALESCE(c.is_delivery, FALSE) = FALSE
  AND c.active = TRUE
  AND NULLIF(TRIM(c.merchant), '') IS NOT NULL
  AND (
      c.parent_id IS NULL 
      OR (
          p.parent_id IS NULL 
          AND p.cps_enabled = TRUE 
          AND COALESCE(p.is_delivery, FALSE) = FALSE 
          AND p.active = TRUE 
          AND NULLIF(TRIM(p.merchant), '') IS NOT NULL
      )
  );
```

#### **Step 2: Fetch Paginated Products (Keyset Pagination)**
Pulls products using indexed fields with dynamic keyset bounds:
```sql
SELECT
    pt.id,
    pt.name ->> 'en_US' AS name,
    NULLIF(pt.description_sale ->> 'en_US', '') AS product_description,
    NULLIF(pt.image_1920_url, '') AS product_image,
    pt.ecommerce_float_price AS list_price,
    pt.company_id,
    COALESCE(pt.t_is_featured, FALSE) AS is_featured,
    COALESCE(pt.is_halal, FALSE) AS is_halal,
    COALESCE(pt.is_arrival, FALSE) AS is_arrival,
    NULLIF(pt.min_quantity, 0) AS min_quantity,
    NULLIF(pt.max_quantity, 0) AS max_quantity,
    COALESCE(pt.product_variant_count_str, 0) AS total_variants,
    COALESCE(pt.total_reviews, 0) AS total_review_count,
    COALESCE(pt.average_rating, 0.0) AS average_rating
FROM product_template pt
WHERE pt.active = TRUE
  AND pt.is_for_ecommerce = TRUE
  AND pt.is_in_stock = TRUE
  AND pt.x_superapp_approval_status = 'approved'
  AND pt.company_id = ANY($1)
  -- Dynamic Filters (appended when set):
  -- AND pt.ecomerce_category_id = $category_id
  -- AND pt.ecommerce_float_price >= $min_price
  -- AND pt.ecommerce_float_price <= $max_price
  -- AND COALESCE(pt.t_is_featured, FALSE) = $featured
  -- AND COALESCE(pt.is_halal, FALSE) = $halal
  -- AND COALESCE(pt.is_arrival, FALSE) = $arrival

  -- Dynamic Keyset Ordering:
  -- Mode id_desc (default):
  --   AND pt.id < $cursor_id
  --   ORDER BY pt.id DESC

  -- Mode price_desc:
  --   AND (pt.ecommerce_float_price < $cursor_price OR (pt.ecommerce_float_price = $cursor_price AND pt.id < $cursor_id))
  --   ORDER BY pt.ecommerce_float_price DESC, pt.id DESC

  -- Mode price_asc:
  --   AND (pt.ecommerce_float_price > $cursor_price OR (pt.ecommerce_float_price = $cursor_price AND pt.id < $cursor_id))
  --   ORDER BY pt.ecommerce_float_price ASC, pt.id DESC
LIMIT $limit;

```

#### **Step 3A: Batch Hydrate Direct Product Discounts**
Parallel discount resolution for all retrieved product IDs:
```sql
SELECT DISTINCT ON (pd.product_tmpl_id)
    pd.product_tmpl_id,
    pd.discount_type,
    pd.discount_value
FROM product_discount pd
WHERE pd.product_tmpl_id = ANY($1::bigint[])
  AND pd.is_active = TRUE
  AND pd.x_superapp_approval_status = 'approved'
  AND (pd.start_date IS NULL OR pd.start_date <= CURRENT_DATE)
  AND (pd.end_date IS NULL OR pd.end_date >= CURRENT_DATE)
ORDER BY pd.product_tmpl_id, pd.id ASC;
```

#### **Step 3B: Batch Hydrate Loyalty Promotion Discounts**
Parallel discount resolution using primary reward fields directly from `loyalty_program`:
```sql
SELECT DISTINCT ON (lp.company_id)
    lp.company_id,
    lp.primary_reward_discount_mode,
    lp.primary_reward_discount
FROM loyalty_program lp 
WHERE lp.company_id = ANY($1::bigint[])
  AND lp.program_type = 'promotion'
  AND lp.is_ecommerce = TRUE
  AND lp.x_superapp_approval_status = 'approved'
  AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
  AND (lp.date_to IS NULL OR lp.date_to >= CURRENT_DATE)
ORDER BY lp.company_id, lp.sequence, lp.id ASC;
```


## Endpoint 20 — GET /api/v1/merchants/list_all
Parameters:
    $1: is_featured (true, false, or NULL)
    $2: cursor_id (the last company_id from the previous page, or NULL for page 1)
    $3: limit (e.g., 10 or 100)
    $4: is_discount (1)

```sql
SELECT
    c.id AS company_id,
    c.name,
    c.merchant AS merchant_id,
    c.logo_url AS logo,
    c.banner_url AS banner,
    c.business_type,
    COALESCE(c.product_count, 0) AS total_products,
    c.opening_time,
    c.closing_time,
    NULLIF(c.cps_account_number, '') AS cps_account_number
FROM res_company c
WHERE c.parent_id IS NULL
  AND c.merchant IS NOT NULL
  AND c.merchant <> ''
  AND c.is_delivery = FALSE
  AND c.cps_enabled = TRUE
  AND c.active = TRUE
  AND ($1::boolean IS NOT TRUE OR c.is_featured = TRUE)
  AND ($2::int IS NULL OR c.id < $2)
ORDER BY c.id DESC
LIMIT $3;
```


Query 2: Batch Hydrate Loyalty Programs 
if is_discount param is passes
    for Outer Field ('is_discount' (bool), 'discount' List [])
Parameters:
    $1: Array of company IDs gathered from Query 1 (e.g., ARRAY[22, 26, 30] in raw SQL or pq.Array(companyIDs) in Go).

Iterate through each merchant. The existence of m.CompanyID in loyaltyMap dictates whether is_discount is true or false:
    // 2. State Assignment: If the merchant has a program, attach the flag and array
    if hasDiscount {
        m.IsDiscount = &trueVal
        m.Discount = []LoyaltyDiscount{program}
    }

```sql
SELECT DISTINCT ON (p.company_id)
    p.company_id,
    p.id AS program_id,
    p.name ->> 'en_US' AS program_name,
    p.sequence,
    p.primary_reward_type AS reward_type,
    p.primary_reward_discount AS discount,
    p.primary_reward_discount_mode AS discount_mode,
    p.primary_reward_discount_applicability AS discount_applicability,
    p.primary_reward_description AS description
FROM loyalty_program p
WHERE p.company_id = ANY($1::int[]) -- company ids Array from first request
  AND p.is_ecommerce = TRUE
  AND p.x_superapp_approval_status = 'approved'
  AND (p.date_from IS NULL OR p.date_from <= CURRENT_DATE)
  AND (p.date_to IS NULL OR p.date_to >= CURRENT_DATE)
ORDER BY p.company_id, p.sequence, p.id;
```

## Endpoint 21 — GET /api/v1/merchant/{merchant}

```sql
-- EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
-- query merchant 
SELECT
    c.id,
    c.name,
    c.merchant AS merchant_id,
    c.business_type,
    c.logo_url AS logo,
    COALESCE(c.is_featured, FALSE) AS is_featured,
    c.banner_url AS banner,
    c.opening_time,
    c.closing_time,
    c.cps_account_number,
    c.lat_location,
    c.lng_location,
    c.map_holder,
    c.street_str AS street,
    c.city_str AS city,
    c.description,
    c.product_count AS product_template_count,
    c.variant_count AS product_variant_count
FROM res_company c
WHERE c.merchant = %s::text  --'MRT000016SPR'  -- 'MRT000016SPR' merchant id
  AND c.cps_enabled IS TRUE
  AND c.is_delivery IS NOT TRUE
  AND c.active IS TRUE
LIMIT 1;

-- query branch for mercant  branches : [{}]
SELECT
    b.id,
    b.name,
    b.merchant AS branch_id,
    b.logo_url AS logo,
    b.banner_url AS banner,
    COALESCE(b.is_featured, FALSE) AS is_featured,
    b.business_type AS business_type,
    b.opening_time AS opening_time,
    b.closing_time AS closing_time,
    b.cps_account_number AS cps_account_number,
    b.email AS email,
    b.phone AS phone,
    b.lat_location AS lat_location,
    b.lng_location AS lng_location,
    b.map_holder AS map_holder,
    b.street_str AS street,
    b.city_str AS city,
    b.description AS description,
    b.product_count AS product_template_count,
    b.variant_count AS product_variant_count
FROM res_company b
WHERE b.parent_id = $2 -- Primary Key - Id from the first query merchant 
  AND b.cps_enabled IS TRUE
  AND b.active IS TRUE
  AND b.merchant IS NOT NULL;


```

## Endpoint 22 — GET /api/v1/wishlist/{user_id}

** You ll need to break thi s query according to the request tha comes from mobile side. 

1, filter by `category_id` 
2, filter by price range :- `price_from`, `price_to`
3, sort by price (acs or desc) 

` After running the queries u ll be calculating the actual price if there is a product of merchant level discount `

```
if there is merchant discount, the product level discount can be neglected 

```

=> `discount_price` = `pt.price - (pt.price * discount_amount/100 )` - if discount type is `percentage`  else `pt.price - discount_amount` 
=> `discounted_price` = `pt.price` - `discount_price`


```sql
SELECT
    w.id,
    pt.id AS product_id,
    pt.name->>'en_US' AS name,
    pt.image_1920_url AS product_image,
    pt.list_price AS untaxed_price,
    pt.ecommerce_float_price AS price,
    pt.company_id,
    pt.ecomerce_category_id AS category_id
FROM wishlist w
INNER JOIN res_partner rp ON w.user_id = rp.id
LEFT JOIN product_template pt ON w.product_id = pt.id
INNER JOIN product_ecomerce_categories pec
    ON pec.id = pt.ecomerce_category_id
WHERE rp.app_user_id = %user_id 
-- if filter by category
AND pt.ecomerce_category_id = %category_id
 -- if price_from filter
AND pt.ecommerce_float_price >= %price_from

-- if price_to filter 
AND pt.ecommerce_float_price <= %price_to

-- if order for high_to_low is true
AND (w.id,pt.ecommerce_float_price) < (%ic_cursor,%price)
ORDER BY pt.ecommerce_float_price ASC

-- if order for high_to_low is false
AND (w.id,pt.ecommerce_float_price) > (%ic_cursor,%price)
ORDER BY pt.ecommerce_float_price DESC

-- if order for high_to_low is nil
AND (w.id,pt.ecommerce_float_price) < (%ic_cursor,%price)
ORDER BY w.id DESC

LIMIT %lim;
```

## 22.2 Get Discount

** get merchant discount for the wishlisted product **

use company_id from the `company_id` of the previous response

```
SELECT  
lp.primary_reward_type AS "type",
lp.primary_reward_discount AS discount
FROM loyalty_program lp
INNER JOIN res_company rc ON rc.id = lp.company_id
WHERE rc.id = $company_id
AND lp.date_from <= CURRENT_DATE
AND lp.date_to >= CURRENT_DATE
AND lp.x_superapp_approval_status = 'approved';
```

## 22.3 Product level discount
** Use the `product_id` from wishlist response

```
SELECT  pd.discount_type AS "type", pd.discount_value
FROM product_discount pd
INNER JOIN product_template pt ON pt.id = pd.product_tmpl_id
WHERE pt.id = %product_id
    AND pd.is_active AND pd.x_superapp_approval_status = 'approved'
AND pd.start_date <= CURRENT_DATE
AND pd.end_date >= CURRENT_DATE;
```


## Endpoint 23 — GET /api/v1/driver/orders

**Driver Orders List**

token: from request header `x-token`

```sql
SELECT
    dop.id,
    dop.name AS order_id,
    iso.superapp_order_status AS status,
    dop.order_company_id AS order_from,
    to_char(dop.delivery_date, 'MM/DD/YYYY') AS delivery_date
    
FROM delivery_order dop
INNER JOIN res_partner rp
    ON rp.id = dop.driver_assigned
INNER JOIN res_users ru
    ON ru.partner_id = rp.id
	
LEFT JOIN sale_order iso
    ON iso.id = dop.sale_order_id::integer
WHERE
    ru.token = %s --'98db652e5c1d9e6e0c1a8eb4abb669fa'
    AND ru.token_expiration_time > NOW()
    AND dop.state IN ('driver', 'picked')
     dop.id < %cursor_id

ORDER BY dop.id DESC
LIMIT %lim;
```


## 23.2 - GET ordered company info 

** use `order_from` from orders

```
SELECT 
c.name,
c.logo_url as logo,
c.street_str || ',' || c.city_str AS pickup_location
FROM res_company c 
WHERE c.id = %order_from;
```


## 23.3  Get Ordered Products images

** use `id` from orders **

```
SELECT 
pp.image_1920_url
FROM delivery_order_line dol
INNER JOIN delivery_order dop ON dop.id = dol.delivery_order_id
LEFT JOIN product_product pp ON dol.product_variant_id = pp.id
WHERE dop.id = %id; --59;
```

## Endpoint 24 — GET /api/v1/driver/order/{order_id:int}

**Driver Order Detail**

token: from request header `x-token`

```sql
-- EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT 
dop.id,
dop.name AS ref_no,
dop.state AS status,
dop.order_company_id AS pickup_from,
to_char(dop.delivery_date, 'MM/DD/YYYY') AS delivery_date,
dop.delivery_pickup_code,
dop.delivery_lat AS lat,
dop.delivery_long AS lng,
dop.customer_location,
dop.customer_id AS customer_id,
dop.delivery_notes AS additional_note

FROM delivery_order dop
INNER JOIN res_users ru ON dop.driver_assigned = ru.partner_id
WHERE 
 ru.token = %s --'98db652e5c1d9e6e0c1a8eb4abb669fa'
    AND ru.token_expiration_time > NOW()
   AND dop.state IN ('driver', 'picked')
   AND dop.id = %s; --50;
```

## Endpint 24.2 - GET DELIVEY ORDER LINES

** Delivery order lines query by the delivery order id **

do_id = delivery order id

```sql
SELECT 
dol.id AS id,
pt.name->>'en_US' AS name,
pp.image_1920_url AS image,
dol.quantity AS quantity,
dol.uom_name->>'en_US' AS uom,
dol.description
FROM delivery_order_line dol
INNER JOIN delivery_order dop ON dol.delivery_order_id = dop.id
LEFT JOIN product_product pp 
	ON dol.product_variant_id = pp.id
LEFT JOIN product_template pt 
	ON pp.product_tmpl_id = pt.id
WHERE dop.id = %do_id; --50;
```

## 24.3 Get Order Company 

** USE `pickup_from` data from delivery_order response **


```
SELECT 
c.id,
c.name,
c.logo_url AS logo,
c.phone,
c.street_str || ',' || c.city_str AS pickup_location
FROM res_company c 
WHERE c.id = %pickup_from;


```

## 24.4 Customer Info

** use `customer_id` from derivery_order response **
```
SELECT 
c.name,
c.phone,
cs.name AS location
FROM res_partner c
LEFT JOIN res_country_state cs ON c.state_id = cs.id
WHERE c.id = %customer_id; --280;

```



## 25 — GET /api/v1/driver/history

**Driver History List**

token: from request header `x-token`

```sql
SELECT
    dop.id,
    dop.name AS order_no,
   dop.order_company_id AS pickup_from,
    to_char(dop.delivery_date, 'MM/DD/YYYY') AS date,
    iso.superapp_order_status AS status
FROM delivery_order dop
LEFT JOIN sale_order iso
    ON iso.id = dop.sale_order_id::integer
INNER JOIN res_partner rp
    ON rp.id = dop.driver_assigned
INNER JOIN res_users ru
    ON ru.partner_id = rp.id       
WHERE 
    ru.token = %token -- '98db652e5c1d9e6e0c1a8eb4abb669fa'
    AND ru.token_expiration_time > NOW()
    AND dop.state IN ('delivered', 'canceled')
    AND dop.id < %cursor_id --1000
ORDER BY dop.id DESC
LIMIT %lim; --10;
```

## 25.2 Ordered Company info

** use `pickup_from` from order ** 

```
SELECT 
c.id,
c.name,
c.logo_url AS logo,
c.phone
FROM res_company c 
WHERE c.id = %pickup_from; -- 26;

```

## Endpoint 26 — GET /api/v1/categories

```sql
SELECT
    c.id,
    c.name,
    NULLIF(c.image_1_url, '') AS image,
    NULLIF(c.category_banner_url, '') AS banner,
    COALESCE(c.product_count, 0) AS items,
    c.description
FROM product_ecomerce_categories c
WHERE c.parent_id IS NULL
  AND c.active IS TRUE
  AND ($1::int IS NULL OR c.id > $1::int)
ORDER BY c.id ASC
LIMIT LEAST(GREATEST(COALESCE($2::int, 10), 1), 100) + 1;
```


## Endpoint 27 — GET /api/v1/categories/{category_id:int}

```sql
SELECT
    c.id,
    c.name AS name,
    c.image_1_url AS image,
    c.product_count AS items,
    p.id AS parent_id,
    p.name AS parent_name,
    p.complete_name AS parent_complete_name,
    p.image_1_url AS parent_image
FROM product_ecomerce_categories c
LEFT JOIN product_ecomerce_categories p
    ON p.id = c.parent_id
WHERE c.id = %s -- catgoryid 1
  AND c.active IS TRUE;

-- get catagory with the catgory id 
-- "child_categories" : [{}]
SELECT
    child.id,
    child.name AS name,
    child.complete_name AS complete_name,
    child.image_1_url AS image,
    child.category_banner_url AS banner
FROM product_ecomerce_categories child
WHERE child.parent_id = 12 -- catgoryid 1
  AND child.active IS TRUE;
```


## Endpoint 28 — GET /api/v1/product/{product_tmpl_id:int}
**1. API & Routing Parameters**
| Parameter | Type | Source | Description |
| --- | --- | --- | --- |
| `product_id` | `int64` | URL Path (`/api/v1/products/{id}`) | Parsed using `strconv.ParseInt()`. The primary key of the target `product_template`. Halts with `400 Bad Request` if invalid or $\le 0$. |
| `companyID` | `int64` | Database (`pt.company_id`) | Derived dynamically from Step 1A's scan. Serves as the foreign key to locate merchant details and merchant-wide loyalty rules. |

**2. SQL Placeholder Parameters (`$1`)**
Every query in the concurrent pipeline uses single-parameter positional binding (`$1`):
| Query | Table / Purpose | `$1` Source Variable | Data Type | Filter Predicate |
| --- | --- | --- | --- | --- |
| **1A** | `product_template` | `productID` | `BIGINT` | `WHERE pt.id = $1` |
| **1B** | `res_company` | `companyID` | `BIGINT` | `WHERE c.id = $1` |
| **2A** | `product_discount` | `productID` | `BIGINT` | `WHERE pd.product_tmpl_id = $1` |
| **2B** | `loyalty_program` | `companyID` | `BIGINT` | `WHERE lp.company_id = $1` |
| **2C** | `ecomerce_product` | `productID` | `BIGINT` | `WHERE ep.product_id = $1` |
| **2D** | `product_video_url` | `productID` | `BIGINT` | `WHERE pv.product_tmpl_id = $1` |
| **2E** | `product_template_attribute_line` | `productID` | `BIGINT` | `WHERE ptal.product_tmpl_id = $1` |
| **2F-1** | `product_product` | `productID` | `BIGINT` | `WHERE v.product_tmpl_id = $1` |
| **2F-2** | `product_variant_combination` | `productID` | `BIGINT` | `WHERE v.product_tmpl_id = $1` |

**3. Business Logic & Calculation Parameters**
Parameters passed into `CalculateFinalPrice(listPrice, mode, val)` to compute `product_discounts` per variant:
* **`listPrice`** (`float64`): Variant-level base price from `v.ecommerce_float_price`.
* **`mode`** (`string`): Discount unit type (`"Percentage"`, `"Percent"`, or `"Fixed"`), resolved from `pd.discount_type` or `lp.primary_reward_discount_mode`.
* **`val`** (`float64`): Discount amount or percentage figure from `pd.discount_value` or `lp.primary_reward_discount`.

**Query 1A: Base Template (Direct lookup by Product ID)**
```sql
SELECT
    pt.id,
    COALESCE(pt.name ->> 'en_US', '') AS name,
    COALESCE(cat.name, '') AS category_name,
    COALESCE(pt.description_sale ->> 'en_US', '') AS product_description,
    pt.company_id,
    COALESCE(pt.t_is_featured, FALSE) AS is_featured,
    COALESCE(pt.is_halal, FALSE) AS is_halal,
    COALESCE(pt.is_arrival, FALSE) AS is_arrival,
    COALESCE(pt.min_quantity, 0) AS min_quantity,
    COALESCE(pt.max_quantity, 0) AS max_quantity,
    COALESCE(pt.total_reviews, 0) AS total_reviews,
    ROUND(COALESCE(pt.average_rating, 0.0)::numeric, 2) AS average_rating
FROM product_template pt
LEFT JOIN product_ecomerce_categories cat ON cat.id = pt.ecomerce_category_id
WHERE pt.id = $1
  AND pt.active = TRUE
  AND pt.is_for_ecommerce = TRUE
  AND pt.x_superapp_approval_status = 'approved'
LIMIT 1;
```

**Query 1B: Merchant Details (Lookup by Company ID)**
```sql
SELECT
    COALESCE(c.merchant, '') AS merchant,
    c.name AS merchant_name,
    COALESCE(c.logo_url, '') AS merchant_logo,
    COALESCE(c.lat_location, 0.0) AS lat_location,
    COALESCE(c.lng_location, 0.0) AS lng_location,
    COALESCE(c.city_str, '') AS city
FROM res_company c
WHERE c.id = $1
  AND c.active = TRUE
  AND c.cps_enabled = TRUE
  AND COALESCE(c.is_delivery, FALSE) = FALSE
LIMIT 1;
```

**Query 2A: Direct Item Discounts (Lookup by Product ID)**
```sql
SELECT pd.discount_type, pd.discount_value
FROM product_discount pd
WHERE pd.product_tmpl_id = $1
  AND pd.is_active = TRUE
  AND pd.x_superapp_approval_status = 'approved'
  AND (pd.start_date IS NULL OR pd.start_date <= CURRENT_DATE)
  AND (pd.end_date IS NULL OR pd.end_date >= CURRENT_DATE)
ORDER BY pd.id ASC;
```

**Query 2B: Merchant Loyalty Promotion (Lookup by Company ID)**
```sql
SELECT lp.primary_reward_discount_mode, lp.primary_reward_discount
FROM loyalty_program lp
WHERE lp.company_id = $1
  AND lp.program_type = 'promotion'
  AND lp.is_ecommerce = TRUE
  AND lp.x_superapp_approval_status = 'approved'
  AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
  AND (lp.date_to IS NULL OR lp.date_to >= CURRENT_DATE)
ORDER BY lp.sequence, lp.id ASC
LIMIT 1;

```

**Query 2C: Product Specifications (Lookup by Product ID)**
```sql
SELECT ep.id, COALESCE(es.name, ''), COALESCE(ep.value, ''), COALESCE(es.icon_url, '')
FROM ecomerce_product ep
JOIN ecomerce_specs es ON es.id = ep.spec
WHERE ep.product_id = $1
ORDER BY ep.id ASC;
```

**Query 2D: Product Video URLs (Lookup by Product ID)**
```sql
SELECT pv.url, COALESCE(pv.video_thumbnail_url, '')
FROM product_video_url pv
WHERE pv.product_tmpl_id = $1
  AND pv.url IS NOT NULL
  AND pv.url ILIKE '%m3u8%'
ORDER BY pv.id ASC;
```

**Query 2E: Variant Attribute Types & Values (Lookup by Product ID)**
```sql
SELECT
    pa.id,
    COALESCE(pa.name ->> 'en_US', ''),
    pav.id,
    COALESCE(pav.name ->> 'en_US', '')
FROM product_template_attribute_line ptal
JOIN product_attribute pa ON pa.id = ptal.attribute_id
JOIN product_attribute_value_product_template_attribute_line_rel rel 
  ON rel.product_template_attribute_line_id = ptal.id
JOIN product_attribute_value pav 
  ON pav.id = rel.product_attribute_value_id
WHERE ptal.product_tmpl_id = $1
ORDER BY pa.id ASC, pav.id ASC;
```

**Query 2F-1: Concrete Product Variants (Lookup by Product ID)**

```sql
SELECT
    v.id,
    COALESCE(vt.name ->> 'en_US', '') AS base_name,
    v.ecommerce_float_price AS list_price,
    COALESCE(v.image_1920_url, vt.image_1920_url, '') AS product_image,
    COALESCE(v.image_1_url, vt.image_1_url, '') AS image_1,
    COALESCE(v.image_2_url, vt.image_2_url, '') AS image_2,
    COALESCE(v.image_3_url, vt.image_3_url, '') AS image_3,
    COALESCE(v.image_4_url, vt.image_4_url, '') AS image_4,
    COALESCE(v.image_5_url, vt.image_5_url, '') AS image_5,
    COALESCE(v.image_6_url, vt.image_6_url, '') AS image_6,
    COALESCE(v.api_virtual_available, 0) AS virtual_available
FROM product_product v
JOIN product_template vt ON vt.id = v.product_tmpl_id AND vt.x_superapp_approval_status = 'approved'
WHERE v.product_tmpl_id = $1
  AND v.active = TRUE
ORDER BY v.id ASC;
```

**Query 2F-2: Variant Attribute Value Combinations (Lookup by Product ID)**
```sql
SELECT
    pvc.product_product_id,
    pa.id,
    COALESCE(pa.name ->> 'en_US', ''),
    pav.id,
    COALESCE(pav.name ->> 'en_US', '')
FROM product_variant_combination pvc
JOIN product_product v ON v.id = pvc.product_product_id
JOIN product_template_attribute_value ptav ON ptav.id = pvc.product_template_attribute_value_id
JOIN product_attribute_value pav ON pav.id = ptav.product_attribute_value_id
JOIN product_attribute pa ON pa.id = pav.attribute_id
WHERE v.product_tmpl_id = $1
ORDER BY pa.id ASC, pav.id ASC;
```


## Endpoint 29 — GET /api/v1/delivery/service_providers


```sql
SELECT
    c.id,
    c.name,
    c.logo_url AS logo
FROM res_company c
WHERE c.parent_id IS NULL
  AND c.is_delivery = TRUE
  AND c.cps_enabled = TRUE
  AND c.active = TRUE
  AND c.merchant IS NOT NULL;
```
