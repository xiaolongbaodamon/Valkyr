import { createCanvas, loadImage } from "@napi-rs/canvas";

export type StatusCardData = {
  displayName: string;
  username: string;
  avatarUrl: string;
  bio: string;
  accountAge: string;
  serverTime: string;
  level: number;
  levelTitle: string;
  xp: number;
  nextLevelXp: number;
  wordsSent: number;
  commandsUsed: number;
  voiceTime: string;
  accentColor: string;
  font: "sans" | "serif" | "mono";
  backgroundBase64: string | null;
};

const width = 1100;
const height = 500;
const fontFamilies = {
  sans: "Arial, sans-serif",
  serif: "Georgia, serif",
  mono: "monospace",
} as const;

function drawCover(context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>, image: Awaited<ReturnType<typeof loadImage>>): void {
  const scale = Math.max(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

function wrapText(
  context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  value: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
): void {
  const words = value.split(/\s+/).filter(Boolean);
  let line = "";
  let lineCount = 0;
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width > maxWidth && line) {
      context.fillText(line, x, y + lineCount * lineHeight, maxWidth);
      lineCount++;
      if (lineCount >= maxLines) {
        context.fillText("...", x, y + (maxLines - 1) * lineHeight, maxWidth);
        return;
      }
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line && lineCount < maxLines) context.fillText(line, x, y + lineCount * lineHeight, maxWidth);
}

export async function renderStatusCard(data: StatusCardData): Promise<Buffer> {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  let hasBackground = false;
  if (data.backgroundBase64) {
    try {
      const image = await loadImage(Buffer.from(data.backgroundBase64, "base64"));
      drawCover(context, image);
      hasBackground = true;
    } catch (error) {
      console.warn("Could not render saved status-card background:", error);
    }
  }

  if (!hasBackground) {
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#222b38");
    gradient.addColorStop(1, "#13171e");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
  }

  context.fillStyle = "rgba(12, 15, 21, 0.78)";
  context.fillRect(0, 0, width, height);
  context.fillStyle = data.accentColor;
  context.fillRect(0, 0, 12, height);

  try {
    const avatar = await loadImage(data.avatarUrl);
    context.save();
    context.beginPath();
    context.arc(132, 132, 78, 0, Math.PI * 2);
    context.clip();
    context.drawImage(avatar, 54, 54, 156, 156);
    context.restore();
  } catch {
    context.fillStyle = data.accentColor;
    context.beginPath();
    context.arc(132, 132, 78, 0, Math.PI * 2);
    context.fill();
  }

  const fontFamily = fontFamilies[data.font];
  context.textBaseline = "alphabetic";
  context.fillStyle = "#ffffff";
  context.font = `bold 38px ${fontFamily}`;
  context.fillText(data.displayName, 250, 88, 790);
  context.fillStyle = "#c5ccd6";
  context.font = `22px ${fontFamily}`;
  context.fillText(data.username, 252, 124, 780);

  context.fillStyle = data.accentColor;
  context.font = `bold 24px ${fontFamily}`;
  context.fillText(`LEVEL ${data.level} · ${data.levelTitle}`, 250, 177, 790);
  context.fillStyle = "#f2f4f8";
  context.font = `20px ${fontFamily}`;
  wrapText(context, data.bio || "No bio set.", 250, 219, 790, 28, 2);

  const progress = Math.max(0, Math.min(1, data.xp / Math.max(data.nextLevelXp, 1)));
  const barX = 250;
  const barY = 280;
  const barWidth = 790;
  context.fillStyle = "rgba(255,255,255,0.18)";
  context.fillRect(barX, barY, barWidth, 14);
  context.fillStyle = data.accentColor;
  context.fillRect(barX, barY, barWidth * progress, 14);
  context.fillStyle = "#d8dde6";
  context.font = `16px ${fontFamily}`;
  context.fillText(`${data.xp.toLocaleString()} / ${data.nextLevelXp.toLocaleString()} XP`, barX, 322);

  const stats = [
    ["ACCOUNT AGE", data.accountAge],
    ["ON SERVER", data.serverTime],
    ["WORDS SENT", data.wordsSent.toLocaleString()],
    ["COMMANDS", data.commandsUsed.toLocaleString()],
    ["VOICE TIME", data.voiceTime],
  ];
  const startX = 54;
  const gap = 22;
  const itemWidth = (width - startX * 2 - gap * 4) / 5;
  stats.forEach(([label, value], index) => {
    const x = startX + index * (itemWidth + gap);
    context.fillStyle = "rgba(255,255,255,0.08)";
    context.fillRect(x, 374, itemWidth, 82);
    context.fillStyle = data.accentColor;
    context.font = `bold 13px ${fontFamily}`;
    context.fillText(label!, x + 12, 400, itemWidth - 24);
    context.fillStyle = "#ffffff";
    context.font = `18px ${fontFamily}`;
    context.fillText(value!, x + 12, 433, itemWidth - 24);
  });

  return canvas.toBuffer("image/png");
}