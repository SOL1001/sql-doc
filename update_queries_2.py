import re

# Read done (2)
with open('done (2)', 'r') as f:
    done_content = f.read()

# Read QUERIES.md
with open('QUERIES.md', 'r') as f:
    queries_content = f.read()

# Helper to extract a query from done (2) by searching for its header
def extract_query(start_marker, end_marker=None):
    start_idx = done_content.find(start_marker)
    if start_idx == -1:
        return None
    
    if end_marker:
        end_idx = done_content.find(end_marker, start_idx)
        if end_idx == -1:
            end_idx = len(done_content)
    else:
        end_idx = len(done_content)
    
    return done_content[start_idx:end_idx].strip()

# Helper to replace an existing endpoint in QUERIES.md
def replace_endpoint(endpoint_marker, new_content):
    global queries_content
    start_idx = queries_content.find(endpoint_marker)
    if start_idx == -1:
        print(f"Could not find {endpoint_marker}")
        return False
    
    # Find the next endpoint to know where to stop
    # Find "## Endpoint " that comes after start_idx + len(endpoint_marker)
    next_endpoint_idx = queries_content.find("## Endpoint", start_idx + 15)
    
    # The new content should be wrapped in markdown
    replacement = f"{endpoint_marker}\n\n```sql\n{new_content}\n```\n\n"
    
    if next_endpoint_idx != -1:
        queries_content = queries_content[:start_idx] + replacement + queries_content[next_endpoint_idx:]
    else:
        queries_content = queries_content[:start_idx] + replacement
    return True


# 1. total_products
q1_sql = extract_query("WITH merchant_status_check AS (", "-------------------------------------------------------------------------------")
if q1_sql:
    # Need to remove the trailing dashed line
    q1_sql = re.sub(r"-{10,}\s*", "", q1_sql).strip()
    replace_endpoint("## Endpoint 19 — GET /api/v1/total_products", q1_sql)

# 2. merchant/{{merchant}}
merchant_idx = done_content.find("-- GET /api/v1/merchant/{{merchant}}")
q2_start = done_content.find("WITH params AS (", merchant_idx)
q2_end = done_content.find("-------------------------------------------------------------------------------", q2_start)
q2_sql = done_content[q2_start:q2_end].strip()
if q2_sql:
    replace_endpoint("## Endpoint 21 — GET /api/v1/merchant/{merchant}", q2_sql)

# 3. categories
cat_idx = done_content.find("-- GET /api/v1/categories")
q3_start = done_content.find("WITH params AS (", cat_idx)
q3_end = done_content.find("-------------------------------------------------------------------------------", q3_start)
q3_sql = done_content[q3_start:q3_end].strip()

# 4. categories/{{category_id}}
cat_id_idx = done_content.find("-- GET /api/v1/categories/{{category_id}}")
q4_start = done_content.find("WITH params AS (", cat_id_idx)
q4_end = done_content.find("-------------------------------------------------------------------------------", q4_start)
q4_sql = done_content[q4_start:q4_end].strip()

# 5. product/{{product_tmpl_id}}
prod_idx = done_content.find("-- GET /api/v1/product/{{product_tmpl_id}}")
q5_start = done_content.find("WITH params AS (", prod_idx)
q5_end = len(done_content)
q5_sql = done_content[q5_start:q5_end].strip()

# Append the new ones
appends = ""
if q3_sql:
    appends += f"\n## Endpoint 26 — GET /api/v1/categories\n\n```sql\n{q3_sql}\n```\n\n"
if q4_sql:
    appends += f"\n## Endpoint 27 — GET /api/v1/categories/{{category_id:int}}\n\n```sql\n{q4_sql}\n```\n\n"
if q5_sql:
    appends += f"\n## Endpoint 28 — GET /api/v1/product/{{product_tmpl_id:int}}\n\n```sql\n{q5_sql}\n```\n\n"

queries_content += appends

with open('QUERIES.md', 'w') as f:
    f.write(queries_content)

# Process app/page.tsx
with open('app/page.tsx', 'r') as f:
    p_content = f.read()

if "endpoint-26" not in p_content:
    nav_addition = """  { kind: "link",    id: "endpoint-26-get-apiv1categories",                         label: "26. Categories"        },
  { kind: "link",    id: "endpoint-27-get-apiv1categoriescategory_idint",           label: "27. Category Details"  },
  { kind: "link",    id: "endpoint-28-get-apiv1productproduct_tmpl_idint",          label: "28. Product Details"   },
]"""
    p_content = re.sub(r'  { kind: "link",    id: "endpoint-25-get-apiv1driverhistory",                      label: "25\. Driver History"    },\n]',
                       f'  {{ kind: "link",    id: "endpoint-25-get-apiv1driverhistory",                      label: "25. Driver History"    }},\n{nav_addition}', p_content)

with open('app/page.tsx', 'w') as f:
    f.write(p_content)
