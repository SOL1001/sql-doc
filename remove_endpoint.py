import re

# 1. Process QUERIES.md
with open('QUERIES.md', 'r') as f:
    q_content = f.read()

# Find Endpoint 4 block and remove it
q4_start = q_content.find("## Endpoint 4 —")
if q4_start != -1:
    q5_start = q_content.find("## Endpoint 5 —", q4_start)
    if q5_start != -1:
        # Remove everything from Endpoint 4 up to Endpoint 5
        q_content = q_content[:q4_start] + q_content[q5_start:]

# Renumber endpoints 5..23 to 4..22
def renumber_md_heading(match):
    num = int(match.group(1))
    if num > 4:
        return f"## Endpoint {num - 1} —"
    return match.group(0)

q_content = re.sub(r"## Endpoint (\d+) —", renumber_md_heading, q_content)

with open('QUERIES.md', 'w') as f:
    f.write(q_content)


# 2. Process app/page.tsx
with open('app/page.tsx', 'r') as f:
    p_content = f.read()

lines = p_content.split('\n')
new_lines = []

for line in lines:
    if "endpoint-4-" in line:
        continue # skip removing it
    
    # Renumber endpoint IDs and labels
    match = re.search(r'endpoint-(\d+)-', line)
    if match:
        num = int(match.group(1))
        if num > 4:
            # Replace endpoint-X- with endpoint-(X-1)-
            line = re.sub(r'endpoint-\d+-', f'endpoint-{num-1}-', line)
            # Replace label: "X. with label: "(X-1).
            line = re.sub(r'label:\s*"' + str(num) + r'\.\s*', f'label: "{num-1}. ', line)
            
    new_lines.append(line)

with open('app/page.tsx', 'w') as f:
    f.write('\n'.join(new_lines))
