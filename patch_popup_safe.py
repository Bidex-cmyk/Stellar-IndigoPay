with open("extension/src/popup.ts", "r") as f:
    lines = f.readlines()

new_lines = []
skip = False
for line in lines:
    if "Global commands from manifest.json" in line:
        skip = True
    if skip and "Keyboard shortcuts for presets and Enter" in line:
        skip = False
    
    if not skip:
        if "chrome.storage.local.get(['pendingDonationProjectId', 'pendingDonationAddress'], async (res) => {" in line:
            new_lines.append("  chrome.storage.local.get(['pendingDonationProjectId', 'pendingDonationAddress', 'pendingDonationPreset'], async (res) => {\n")
            new_lines.append("    if (res.pendingDonationPreset) {\n")
            new_lines.append("      chrome.storage.local.remove('pendingDonationPreset');\n")
            new_lines.append("      setAmount(res.pendingDonationPreset);\n")
            new_lines.append("    }\n")
        else:
            new_lines.append(line)

with open("extension/src/popup.ts", "w") as f:
    f.writelines(new_lines)
