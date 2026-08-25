import re

with open("extension/src/popup.ts", "r") as f:
    content = f.read()

# Replace the pendingDonationAddress check block
old_storage_get = "chrome.storage.local.get(['pendingDonationProjectId', 'pendingDonationAddress'], async (res) => {"
new_storage_get = """chrome.storage.local.get(['pendingDonationProjectId', 'pendingDonationAddress', 'pendingDonationPreset'], async (res) => {
    if (res.pendingDonationPreset) {
      chrome.storage.local.remove('pendingDonationPreset');
      setAmount(res.pendingDonationPreset);
    }
"""
content = content.replace(old_storage_get, new_storage_get)

# Also remove the chrome.commands logic from popup.ts if I put it there earlier.
remove_pattern = re.compile(r"  // Global commands from manifest\.json.*?}\n", re.DOTALL)
content = remove_pattern.sub("", content)

with open("extension/src/popup.ts", "w") as f:
    f.write(content)
