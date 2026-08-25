with open("extension/src/background.ts", "r") as f:
    content = f.read()

commands_listener = """
// ── global keyboard shortcuts ────────────────────────────────────────

if (chrome.commands) {
  chrome.commands.onCommand.addListener(async (command) => {
    const match = command.match(/^preset-(\\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10) - 1;
      const settings = await loadSettings();
      if (idx >= 0 && idx < settings.presets.length) {
        chrome.storage.local.set({ pendingDonationPreset: settings.presets[idx] }, () => {
          openPopup();
        });
      }
    }
  });
}
"""

content = content.replace("// ── project lookup ───────────────────────────────────────────────────", commands_listener + "\n// ── project lookup ───────────────────────────────────────────────────")

with open("extension/src/background.ts", "w") as f:
    f.write(content)
