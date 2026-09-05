import { encode } from "uqr";

export function qrSvg(text: string): string {
  const { data, size } = encode(text);
  const cell = 8;
  const pad = 2;
  const dim = (size + pad * 2) * cell;
  let rects = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[y][x]) {
        rects += `<rect x="${(x + pad) * cell}" y="${(y + pad) * cell}" width="${cell}" height="${cell}"/>`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/>${rects}</svg>`;
}
