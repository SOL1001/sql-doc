import re

with open("QUERIES.md", "r") as f:
    content = f.read()

replacements = [
    (r"## Cateogry advertisements list\s*#### API:\s*```/api/v1/categoryads```\s*", "## Endpoint 7 — GET /api/v1/categoryads\n\n"),
    (r"## Popular Mechants List\s*#### API:\s*```/api/v1/populars```\s*", "## Endpoint 8 — GET /api/v1/populars\n\n"),
    (r"## Popular Categories List\s*#### API:\s*```/api/v1/popular_categories```\s*", "## Endpoint 9 — GET /api/v1/popular_categories\n\n"),
    (r"## Popular Categories List By Merchant\s*#### API:\s*```/api/v1/popular_categories/\{merchant_id:string\}```\s*", "## Endpoint 10 — GET /api/v1/popular_categories/{merchant_id:string}\n\n"),
    (r"## Popular Products List\s*#### API:\s*```/api/v1/popular_products```\s*", "## Endpoint 11 — GET /api/v1/popular_products\n\n"),
    (r"## POPULAR PRODUCT BY MERCHANT\s*#### API:\s*```/api/v1/\{merchant:string\}/popular_merchant_products```\s*", "## Endpoint 12 — GET /api/v1/{merchant:string}/popular_merchant_products\n\n"),
    (r"## Popular merchant product by category\s*#### API:\s*```/api/v1/\{merchant:string\}/popular_merchant_products/category/\{category_id:int\}```\s*", "## Endpoint 13 — GET /api/v1/{merchant:string}/popular_merchant_products/category/{category_id:int}\n\n"),
    (r"## Popular Categories\s*#### API:\s*```/api/v1/popular_categories```\s*", "## Endpoint 14 — GET /api/v1/popular_categories\n\n"),
    (r"## Search Merchant\s*#### API:\s*```/api/v1/search/\{query:string\}```\s*", "## Endpoint 16 — GET /api/v1/search/{query:string}\n\n"),
    (r"## Search All\s*#### API:\s*```/api/v1/search/all/<query:string>```\s*", "## Endpoint 17 — GET /api/v1/search/all/<query:string>\n\n"),
    (r"## Product Search\s*#### API:\s*```/ai/v1/products/search/\{query:string\}```\s*", "## Endpoint 18 — GET /api/v1/products/search/{query:string}\n\n"),
    (r"## Category Search\s*#### API:\s*```/api/v1/categories/search\?query=\{query:string\}```\s*", "## Endpoint 19 — GET /api/v1/categories/search?query={query:string}\n\n"),
]

for pat, repl in replacements:
    content = re.sub(pat, repl, content, flags=re.IGNORECASE)

with open("QUERIES.md", "w") as f:
    f.write(content)
