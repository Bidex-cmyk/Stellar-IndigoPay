#!/usr/bin/env python3
"""
Generate a 2-minute demo video for Stellar-IndigoPay from screenshots.
Uses Pillow to create styled slides and ffmpeg to produce an MP4.
"""

import subprocess, os, glob, textwrap
from PIL import Image, ImageDraw, ImageFont

SRC_DIR = "screenshots"
OUT_DIR = "assets"
VIDEO_OUT = f"{OUT_DIR}/demo.mp4"
W, H = 1920, 1080

# ── Color palette ───────────────────────────────────────────────────
BG    = (15, 15, 30)        # deep indigo-black
PRIMARY = (99, 102, 241)    # #6366F1
ACCENT  = (129, 140, 248)   # #818CF8
GREEN   = (16, 185, 129)    # #10B981
WHITE   = (255, 255, 255)
MUTED   = (156, 163, 175)   # #9CA3AF

# ── Slides: (title, subtitle, screenshot_file, duration_sec) ────────
SLIDES = [
    # Intro
    (
        "Stellar-IndigoPay",
        "Fund the planet. One XLM at a time.\n\nA Production-Ready Stellar dApp for Climate Donations",
        None, 7
    ),
    # 1. Wallet options
    (
        "1. Multi-Wallet Integration",
        "Connect with Freighter, Albedo, xBull, or Rabet\nChoose your preferred wallet to get started",
        "01-wallet-options.png", 12
    ),
    # 2. Wallet connected
    (
        "2. Wallet Connected",
        "Your Stellar public key is your identity\nNo email, no password — just connect and go",
        "02-wallet-connected.png", 12
    ),
    # 3. Balance displayed
    (
        "3. Real-Time Balance Display",
        "View your XLM and USDC balances instantly\nAuto-refreshes after every transaction",
        "03-balance-displayed.png", 12
    ),
    # 4. Transaction success
    (
        "4. Donate on Stellar Testnet",
        "Send XLM directly to verified climate projects\nFunds flow donor → project with zero custody",
        "04-transaction-success.png", 14
    ),
    # 5. Transaction result
    (
        "5. On-Chain Verification",
        "Every donation recorded on Soroban with a TX hash\nVerifiable on Stellar Expert in real time",
        "05-transaction-result.png", 12
    ),
    # 6. Mobile responsive
    (
        "6. Fully Responsive Design",
        "Desktop, tablet, and mobile layouts\nBeautiful on any screen size",
        "06-mobile-responsive.png", 12
    ),
    # 7. CI/CD pipeline
    (
        "7. Production CI/CD Pipeline",
        "15 automated workflows — build, test, lint, deploy\nSmart contract deployment to Stellar Testnet",
        "07-ci-pipeline.png", 12
    ),
    # 8. Tests
    (
        "8. Comprehensive Test Suite",
        "420+ passing tests across 47 suites\nUnit, integration, E2E, and smart contract fuzz tests",
        "08-test-output.png", 12
    ),
    # Outro
    (
        "Stellar-IndigoPay",
        "Live at stellar-indigo-pay.vercel.app\n\nOpen Source · MIT Licensed · Community Built\n\n🌱 github.com/Stellar-IndigoPay/Stellar-IndigoPay",
        None, 7
    ),
]


def load_font(size: int, bold: bool = False):
    """Try to load a nice font; fall back to default."""
    paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf" if bold
        else "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for p in paths:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def draw_slide(title: str, subtitle: str, screenshot: str | None, out_path: str):
    """Render one 1920×1080 slide."""
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    # ── Decorative gradient bar at top ──
    for x in range(W):
        r = int(PRIMARY[0] + (ACCENT[0] - PRIMARY[0]) * x / W)
        g = int(PRIMARY[1] + (ACCENT[1] - PRIMARY[1]) * x / W)
        b = int(PRIMARY[2] + (ACCENT[2] - PRIMARY[2]) * x / W)
        draw.line([(x, 0), (x, 6)], fill=(r, g, b))

    # ── Title ──
    font_title = load_font(52, bold=True)
    bbox = draw.textbbox((0, 0), title, font=font_title)
    tw = bbox[2] - bbox[0]
    draw.text(((W - tw) // 2, 70), title, fill=WHITE, font=font_title)

    # ── Decorative line under title ──
    line_y = 145
    draw.line([(W // 2 - 100, line_y), (W // 2 + 100, line_y)],
              fill=PRIMARY, width=3)

    # ── Subtitle ──
    font_sub = load_font(30)
    lines = subtitle.split("\n")
    y = 180
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font_sub)
        lw = bbox[2] - bbox[0]
        draw.text(((W - lw) // 2, y), line, fill=MUTED, font=font_sub)
        y += 42

    # ── Screenshot ──
    if screenshot:
        ss_path = os.path.join(SRC_DIR, screenshot)
        if os.path.exists(ss_path):
            ss = Image.open(ss_path).convert("RGB")
            # Scale to fit 1600×820 area with border
            max_w, max_h = 1600, 800
            ss.thumbnail((max_w, max_h), Image.LANCZOS)
            sx = (W - ss.width) // 2
            sy = max(320, 900 - ss.height)
            # Drop shadow
            shadow = Image.new("RGBA", (ss.width + 20, ss.height + 20), (0, 0, 0, 0))
            sdraw = ImageDraw.Draw(shadow)
            sdraw.rounded_rectangle(
                [5, 5, ss.width + 15, ss.height + 15],
                radius=16, fill=(0, 0, 0, 80)
            )
            img.paste(shadow, (sx - 10, sy - 10), shadow)
            # White border
            border = Image.new("RGB", (ss.width + 8, ss.height + 8), (40, 40, 60))
            ib = ImageDraw.Draw(border)
            ib.rounded_rectangle(
                [0, 0, ss.width + 7, ss.height + 7],
                radius=12, fill=BG, outline=(60, 60, 90), width=2
            )
            img.paste(border, (sx - 4, sy - 4))
            img.paste(ss, (sx, sy))

    # ── Footer ──
    font_footer = load_font(20)
    footer = "stellar-indigo-pay.vercel.app  ·  github.com/Stellar-IndigoPay/Stellar-IndigoPay"
    bbox = draw.textbbox((0, 0), footer, font=font_footer)
    fw = bbox[2] - bbox[0]
    draw.text(((W - fw) // 2, H - 50), footer, fill=MUTED, font=font_footer)

    img.save(out_path)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    frames_dir = "/tmp/demo-frames"
    os.makedirs(frames_dir, exist_ok=True)

    print("Generating slide frames...")
    frame_files = []
    for i, (title, subtitle, ss, duration) in enumerate(SLIDES):
        fps = 24
        total_frames = duration * fps

        # For slides with screenshots, create a zoom-in effect
        path = f"{frames_dir}/frame_{i:03d}.png"
        draw_slide(title, subtitle, ss, path)
        frame_files.append((path, total_frames))

        print(f"  Slide {i+1}/{len(SLIDES)}: {title} ({duration}s)")

    # ── Build ffmpeg concat file with per-frame durations ──
    concat_file = "/tmp/concat.txt"
    with open(concat_file, "w") as f:
        for path, n_frames in frame_files:
            # Loop: repeat the same frame n_frames times
            for _ in range(n_frames):
                f.write(f"file '{path}'\n")
                f.write(f"duration {1/24:.6f}\n")
        # ffmpeg concat requires last frame twice
        last = frame_files[-1][0]
        f.write(f"file '{last}'\n")

    print(f"\nRendering video with ffmpeg...")
    cmd = [
        "ffmpeg", "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concat_file,
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-r", "24",
        "-movflags", "+faststart",
        VIDEO_OUT
    ]
    subprocess.run(cmd, check=True)

    size = os.path.getsize(VIDEO_OUT)
    print(f"\n✅ Demo video created: {VIDEO_OUT} ({size / 1024 / 1024:.1f} MB)")
    print(f"   Duration: ~{sum(s[3] for s in SLIDES)} seconds")


if __name__ == "__main__":
    main()
