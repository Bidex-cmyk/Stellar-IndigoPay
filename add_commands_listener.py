import re

with open("extension/src/popup.ts", "r") as f:
    content = f.read()

listener_code = """
  // Global commands from manifest.json
  if (chrome.commands) {
    chrome.commands.onCommand.addListener((command) => {
      const match = command.match(/^preset-(\d+)$/);
      if (match) {
        const idx = parseInt(match[1], 10) - 1;
        if (idx >= 0 && idx < settings.presets.length) {
          setAmount(settings.presets[idx]);
        }
      }
    });
  }
"""

content = content.replace("  // Keyboard shortcuts for presets and Enter", listener_code + "\n  // Keyboard shortcuts for presets and Enter")

with open("extension/src/popup.ts", "w") as f:
    f.write(content)
