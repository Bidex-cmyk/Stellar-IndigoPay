with open("extension/src/__tests__/content-script.test.ts", "r") as f:
    lines = f.readlines()

def fix_line(start_idx):
    # Find the closing parenthesis for the call
    idx = start_idx
    while ");" not in lines[idx]:
        idx += 1
    # Check if the previous line contains the last argument
    # Actually, we can just insert the argument before the ); line
    # If lines[idx] is "    );\n", we can insert the argument above it.
    if lines[idx].strip() == ");":
        lines.insert(idx, '      ["10", "50", "100", "500"],\n')
    return idx

for i in range(len(lines)):
    if "const result = buildBodyContent(" in lines[i]:
        fix_line(i)

with open("extension/src/__tests__/content-script.test.ts", "w") as f:
    f.writelines(lines)
