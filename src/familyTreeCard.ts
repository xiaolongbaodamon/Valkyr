import { createCanvas, loadImage } from "@napi-rs/canvas";

export type FamilyTreeMember = {
  id: string;
  name: string;
  avatarUrl: string;
  role: string;
};

export type FamilyTreeEdge = {
  fromId: string;
  toId: string;
  kind: "parent" | "child" | "sibling";
};

const width = 1800;
const nodeRadius = 42;
const rowHeight = 190;
const topOffset = 150;

function roundedRect(context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>, x: number, y: number, w: number, h: number, radius: number): void {
  context.beginPath();
  context.roundRect(x, y, w, h, radius);
}

export async function renderFamilyTree(
  familyName: string,
  rootId: string,
  members: FamilyTreeMember[],
  edges: FamilyTreeEdge[],
): Promise<Buffer> {
  const memberById = new Map(members.map((member) => [member.id, member]));
  const depthById = new Map<string, number>([[rootId, 0]]);
  const queue = [rootId];
  while (queue.length) {
    const currentId = queue.shift()!;
    const currentDepth = depthById.get(currentId) ?? 0;
    for (const edge of edges) {
      if (edge.fromId !== currentId || !memberById.has(edge.toId) || depthById.has(edge.toId)) continue;
      const depth = currentDepth + (edge.kind === "parent" ? 1 : edge.kind === "child" ? -1 : 0);
      depthById.set(edge.toId, depth);
      queue.push(edge.toId);
    }
  }

  const depths = [...depthById.values()];
  const minDepth = Math.min(...depths);
  const levels = new Map<number, FamilyTreeMember[]>();
  for (const [memberId, depth] of depthById) {
    const member = memberById.get(memberId);
    if (!member) continue;
    const generation = depth - minDepth;
    const row = levels.get(generation) ?? [];
    row.push(member);
    levels.set(generation, row);
  }
  for (const row of levels.values()) row.sort((a, b) => a.name.localeCompare(b.name));

  const rows = [...levels.entries()].sort(([depthA], [depthB]) => depthA - depthB);
  const height = Math.max(520, topOffset + rows.length * rowHeight + 110);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "#28545d");
  background.addColorStop(1, "#497e78");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  roundedRect(context, 20, 20, width - 40, height - 40, 20);
  context.strokeStyle = "rgba(255,255,255,0.42)";
  context.lineWidth = 3;
  context.stroke();

  context.fillStyle = "#ffffff";
  context.font = "bold 36px Arial, sans-serif";
  context.textAlign = "left";
  context.fillText(`${familyName} Family Tree`, 52, 78, width - 104);
  context.fillStyle = "rgba(255,255,255,0.76)";
  context.font = "18px Arial, sans-serif";
  context.fillText(`${depthById.size} connected family members`, 54, 110);

  const positions = new Map<string, { x: number; y: number }>();
  for (const [rowIndex, [, row]] of rows.entries()) {
    row.forEach((member, index) => {
      const x = 70 + ((width - 140) * (index + 1)) / (row.length + 1);
      const y = topOffset + rowIndex * rowHeight;
      positions.set(member.id, { x, y });
    });
  }

  context.lineWidth = 3;
  context.lineCap = "round";
  for (const edge of edges) {
    if (edge.kind === "parent") {
      const parent = positions.get(edge.fromId);
      const child = positions.get(edge.toId);
      if (!parent || !child) continue;
      context.strokeStyle = "rgba(235,255,245,0.78)";
      context.beginPath();
      context.moveTo(parent.x, parent.y + nodeRadius);
      context.bezierCurveTo(parent.x, parent.y + rowHeight * 0.6, child.x, child.y - rowHeight * 0.6, child.x, child.y - nodeRadius);
      context.stroke();
    } else if (edge.kind === "sibling" && edge.fromId < edge.toId) {
      const first = positions.get(edge.fromId);
      const second = positions.get(edge.toId);
      if (!first || !second || first.y !== second.y) continue;
      context.strokeStyle = "rgba(105,220,220,0.88)";
      context.beginPath();
      context.moveTo(first.x + nodeRadius, first.y);
      context.lineTo(second.x - nodeRadius, second.y);
      context.stroke();
    }
  }

  for (const [memberId, position] of positions) {
    const member = memberById.get(memberId)!;
    context.fillStyle = "rgba(13, 30, 35, 0.38)";
    context.beginPath();
    context.arc(position.x, position.y + 4, nodeRadius + 5, 0, Math.PI * 2);
    context.fill();
    try {
      const avatar = await loadImage(member.avatarUrl);
      context.save();
      context.beginPath();
      context.arc(position.x, position.y, nodeRadius, 0, Math.PI * 2);
      context.clip();
      context.drawImage(avatar, position.x - nodeRadius, position.y - nodeRadius, nodeRadius * 2, nodeRadius * 2);
      context.restore();
    } catch {
      context.fillStyle = "#768d91";
      context.beginPath();
      context.arc(position.x, position.y, nodeRadius, 0, Math.PI * 2);
      context.fill();
    }
    context.strokeStyle = memberId === rootId ? "#ffd36a" : "rgba(255,255,255,0.9)";
    context.lineWidth = memberId === rootId ? 5 : 3;
    context.beginPath();
    context.arc(position.x, position.y, nodeRadius, 0, Math.PI * 2);
    context.stroke();

    context.textAlign = "center";
    context.fillStyle = "#ffffff";
    context.font = "bold 16px Arial, sans-serif";
    context.fillText(member.name, position.x, position.y + nodeRadius + 24, 150);
    context.fillStyle = memberId === rootId ? "#ffe29a" : "rgba(238,255,248,0.8)";
    context.font = "13px Arial, sans-serif";
    context.fillText(memberId === rootId ? "YOU" : member.role, position.x, position.y + nodeRadius + 44, 150);
  }

  const legendY = height - 48;
  context.textAlign = "left";
  context.font = "bold 14px Arial, sans-serif";
  context.fillStyle = "#ffffff";
  context.fillText("PARENT  ─  CHILD", 54, legendY);
  context.fillStyle = "#9bf0e8";
  context.fillText("SIBLING", 250, legendY);
  context.fillStyle = "#ffe29a";
  context.fillText("YOU", 370, legendY);

  return canvas.toBuffer("image/png");
}