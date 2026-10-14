// Receipt printing for the desktop app. The receipt is drawn like the
// on-screen version (same layout as the browser print service), turned into a
// black & white image and sent to the printer silently by the app.

const { invoke } = window.__TAURI__.core;

const LINE_HEIGHT = 1.15; // Arial line spacing
const ASCENT = 0.905; // Arial ascent

/**
 * Draws the receipt at printer resolution.
 * Returns { width, height, data } with 1 bit per pixel, rows packed MSB first, 1 = black.
 */
export function renderReceipt(r, widthDots) {
  const s = Math.max(1, widthDots / 440);
  const margin = Math.round(8 * s);
  const w = widthDots - 2 * margin;

  const canvas = document.createElement("canvas");
  canvas.width = widthDots;
  canvas.height = Math.ceil(1400 * s);
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = "#000";
  g.strokeStyle = "#000";

  const font = (size, bold) => `${bold ? "bold " : ""}${size}px Arial`;
  const fontTitle = [30 * s, true];
  const fontSmall = [19 * s, false];
  const fontLabel = [22 * s, false];
  const fontValue = [22 * s, true];

  const measure = (text, [size, bold]) => {
    g.font = font(size, bold);
    return g.measureText(text).width;
  };

  const drawText = (text, [size, bold], x, top, align = "left") => {
    g.font = font(size, bold);
    g.textAlign = align;
    g.textBaseline = "alphabetic";
    g.fillText(text, x, top + size * ASCENT);
  };

  const wrap = (text, f) => {
    const lines = [];
    let current = "";
    for (const word of text.split(" ")) {
      const next = current ? `${current} ${word}` : word;
      if (current && measure(next, f) > w) {
        lines.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    lines.push(current);
    return lines;
  };

  let y = 6 * s;

  // Round "W" logo
  const d = 62 * s;
  g.beginPath();
  g.arc(widthDots / 2, y + d / 2, d / 2, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#fff";
  g.font = font(32 * s, true);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("W", widthDots / 2, y + d / 2 + 1 * s);
  g.fillStyle = "#000";
  y += d + 12 * s;

  const centered = (text, f, after) => {
    const lh = f[0] * LINE_HEIGHT;
    const lines = wrap(text, f);
    lines.forEach((line, i) => drawText(line, f, margin + w / 2, y + i * lh, "center"));
    return y + lines.length * lh + after;
  };

  const divider = () => {
    const yy = y + 14 * s;
    g.lineWidth = 2 * s;
    g.setLineDash([6 * s, 4 * s]);
    g.beginPath();
    g.moveTo(margin, yy);
    g.lineTo(margin + w, yy);
    g.stroke();
    g.setLineDash([]);
    return yy + 18 * s;
  };

  const row = (label, value, labelFont, valueFont, gap) => {
    value = String(value ?? "");
    const h = Math.max(labelFont[0], valueFont[0]) * LINE_HEIGHT;
    const lw = measure(label, labelFont);
    const vw = measure(value, valueFont);
    drawText(label, labelFont, margin, y);
    let yy = y;
    if (lw + vw + 8 > w) yy += h;
    drawText(value, valueFont, margin + w, yy, "right");
    return yy + h + gap;
  };

  const rowGap = 12 * s;
  y = centered("WASTINA COMMERCIAL CENTER", fontTitle, 8 * s);
  y = centered("Thank you for parking with us!", fontSmall, 0);
  y = divider();
  y = row("Receipt No.", r.receiptNo, fontLabel, fontValue, rowGap);
  y = row("Date", r.date, fontLabel, fontValue, 0);
  y = divider();
  y = row("In-Time", r.inTime, fontLabel, fontValue, rowGap);
  y = row("Out-Time", r.outTime, fontLabel, fontValue, 0);
  y = divider();
  // Keep "TOTAL FEE  amount" on one line, like the screen
  let totalSize = 29 * s;
  while (
    totalSize > 18 &&
    measure("TOTAL FEE", [totalSize, true]) + measure(String(r.feeText), [totalSize, true]) + 8 > w
  ) {
    totalSize -= 1;
  }
  y = row("TOTAL FEE", r.feeText, [totalSize, true], [totalSize, true], 0);
  y += 22 * s;
  y = centered("Please keep this receipt for your records.", fontSmall, 6 * s);
  y = centered("Have a safe journey!", fontSmall, 0);
  y += 10 * s;

  // Crop to content and convert to 1-bit
  const height = Math.ceil(y);
  const pixels = g.getImageData(0, 0, widthDots, height).data;
  const bytesPerRow = Math.ceil(widthDots / 8);
  const data = new Uint8Array(bytesPerRow * height);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < widthDots; px++) {
      const i = (py * widthDots + px) * 4;
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] < 384) {
        data[py * bytesPerRow + (px >> 3)] |= 0x80 >> (px & 7);
      }
    }
  }

  return { width: widthDots, height, data: Array.from(data) };
}

/** Saves and prints a receipt on this PC's receipt printer. Returns the printer name. */
export async function printReceipt(receipt) {
  const target = await invoke("print_target");
  const raster = renderReceipt(receipt, target.dots);
  return invoke("print_receipt", { receipt, target, raster });
}

/** Prints a sample receipt with not-yet-saved printer settings. */
export async function testPrint(settings, token) {
  const target = await invoke("print_target", { settings });
  const sample = {
    receiptNo: "TEST-PRINT",
    date: new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }),
    inTime: "08:00 AM",
    outTime: "09:00 AM",
    fee: 0,
    feeText: "0.00 ETB",
  };
  const raster = renderReceipt(sample, target.dots);
  return invoke("test_print", { settings, target, raster, token: token || null });
}
