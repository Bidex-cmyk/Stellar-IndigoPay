import re

with open("extension/src/inject/donate-overlay.ts", "r") as f:
    content = f.read()

# Add presets to DonateOverlayOptions
content = content.replace(
    "  isLoading?: boolean;\n}",
    "  isLoading?: boolean;\n  presets?: string[];\n}"
)

# Update renderProjectView and renderDirectDonateView
def replace_presets(match):
    return """        <div class="igp-presets">
          ${(opts.presets || ["10", "50", "100", "500"]).map(p => `<button class="igp-preset-btn" data-amount="${p}">${p}</button>`).join('')}
        </div>"""

content = re.sub(
    r'<div class="igp-presets">[\s\S]*?</div>',
    replace_presets,
    content
)

with open("extension/src/inject/donate-overlay.ts", "w") as f:
    f.write(content)
