import re

with open("extension/src/content-script-logic.ts", "r") as f:
    content = f.read()

# Add presets parameter to buildBodyContent
content = content.replace(
    "freighterPublicKey: string,\n): {",
    "freighterPublicKey: string,\n  presets: string[],\n): {"
)

# Update presets in buildBodyContent
def replace_presets(match):
    return """        <div class="igp-presets">
          ${presets.map(p => `<button class="igp-preset-btn" data-amount="${p}">${p}</button>`).join('')}
        </div>"""

content = re.sub(
    r'<div class="igp-presets">[\s\S]*?</div>',
    replace_presets,
    content
)

# Modify handleDonateClick to fetch presets
new_handle_click = """export function handleDonateClick(address: string): void {
  // Remove any existing overlay
  if (overlayCleanup) {
    overlayCleanup();
    setOverlayCleanup(null);
  }

  const freighterAvailable = typeof (window as any).freighter !== "undefined";

  chrome.storage.sync.get(["presets"], (settingsRes) => {
    const presets = settingsRes.presets || ["10", "50", "100", "500"];

    // Mount overlay immediately with a loading spinner
    const cleanup = mountDonateOverlay({
      address,
      project: null,
      isLoading: true,
      presets,
      onClose: () => {
        setOverlayCleanup(null);
      },
      onDonate: async (amount: string, memo?: string) => {
        return handleDonateSubmit(address, parseFloat(amount), memo);
      },
      freighterAvailable,
      freighterPublicKey: "",
      onConnectFreighter: async () => {
        return connectFreighter();
      },
    });
    setOverlayCleanup(cleanup);

    // Fetch project info from background (async — updates overlay in-place)
    chrome.runtime.sendMessage(
      { type: "LOOKUP_PROJECT", address },
      (response: { project?: ProjectInfo | null }) => {
        const project = response?.project || null;
        const overlay = document.getElementById("indigopay-overlay");
        if (!overlay) return;

        const bodyEl = overlay.querySelector(".igp-body") as HTMLElement;
        if (!bodyEl) return;

        // Replace the body content with the project/direct-donate view
        const { renderProjectViewStr, renderDirectDonateViewStr } =
          buildBodyContent(address, project, freighterAvailable, "", presets);

        bodyEl.innerHTML = project
          ? renderProjectViewStr
          : renderDirectDonateViewStr;

        // Wire up the new form elements inside the updated body
        wireBodyEvents(overlay, address, project, "");
      },
    );
  });
}"""

content = re.sub(
    r'export function handleDonateClick\(address: string\): void \{[\s\S]*?\}\n\n/\*\*',
    new_handle_click + "\n\n/**",
    content
)

with open("extension/src/content-script-logic.ts", "w") as f:
    f.write(content)
