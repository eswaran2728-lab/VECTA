import sharp from "sharp";
import { mkdirSync } from "fs";

const SRC_BADGE = "public/icons/avsec-badge.jpg";
const OUT_DIR = "public/icons";

mkdirSync(OUT_DIR, { recursive: true });

const BLACK = { r: 10, g: 10, b: 10, alpha: 1 };

async function squareOnBlack(size, outPath, { padPercent = 0 } = {}) {
  const inner = Math.round(size * (1 - padPercent * 2));
  const resized = await sharp(SRC_BADGE)
    .resize(inner, inner, { fit: "contain", background: BLACK })
    .toBuffer();

  await sharp({
    create: { width: size, height: size, channels: 4, background: BLACK },
  })
    .composite([{ input: resized, gravity: "center" }])
    .png()
    .toFile(outPath);
}

await squareOnBlack(192, `${OUT_DIR}/icon-192.png`);
await squareOnBlack(512, `${OUT_DIR}/icon-512.png`);
// Maskable: extra padding so Android's circular/rounded crop doesn't clip the badge.
await squareOnBlack(512, `${OUT_DIR}/icon-512-maskable.png`, { padPercent: 0.1 });
await squareOnBlack(180, `${OUT_DIR}/apple-touch-icon.png`);
await squareOnBlack(32, `${OUT_DIR}/favicon-32.png`);
await squareOnBlack(16, `${OUT_DIR}/favicon-16.png`);

console.log("Icons generated.");
