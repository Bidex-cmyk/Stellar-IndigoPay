import re

with open("extension/src/__tests__/donate-overlay.test.ts", "r") as f:
    content = f.read()

# Replace "5" with "50" since our presets are 10, 50, 100, 500
content = content.replace('getAttribute("data-amount") === "5"', 'getAttribute("data-amount") === "50"')

with open("extension/src/__tests__/donate-overlay.test.ts", "w") as f:
    f.write(content)
