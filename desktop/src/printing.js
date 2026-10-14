// Receipt and Z report printing for the desktop app. The paper is drawn like
// the on-screen receipt (same layout as the browser print service), turned
// into a black & white image and sent to the printer silently by the app.

const { invoke } = window.__TAURI__.core;

const LINE_HEIGHT = 1.15; // Arial line spacing
const ASCENT = 0.905; // Arial ascent
const SHOP_NAME = "WASTINA COMMERCIAL CENTER";
const POWERED_BY = "Powered By NYT Software Solutions";

/**
 * A strip of receipt paper at printer resolution with drawing helpers.
 * Fonts are [sizePx, bold]. Each helper draws at the current y and moves it down.
 */
function createPaper(widthDots, maxHeight) {
  const s = Math.max(1, widthDots / 440);
  const margin = Math.round(8 * s);
  const w = widthDots - 2 * margin;

  const canvas = document.createElement("canvas");
  canvas.width = widthDots;
  canvas.height = Math.ceil(maxHeight * s);
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = "#000";
  g.strokeStyle = "#000";

  const font = (size, bold) => `${bold ? "bold " : ""}${size}px Arial`;

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

  const paper = {
    s,
    y: 6 * s,
    fonts: {
      title: [30 * s, true],
      heading: [26 * s, true],
      small: [19 * s, false],
      smallBold: [19 * s, true],
      label: [22 * s, false],
      value: [22 * s, true],
      footer: [16 * s, false],
    },

    // Round "W" logo
    logo() {
      const d = 62 * s;
      g.beginPath();
      g.arc(widthDots / 2, paper.y + d / 2, d / 2, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#fff";
      g.font = font(32 * s, true);
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("W", widthDots / 2, paper.y + d / 2 + 1 * s);
      g.fillStyle = "#000";
      paper.y += d + 12 * s;
    },

    centered(text, f, after = 0) {
      const lh = f[0] * LINE_HEIGHT;
      const lines = wrap(text, f);
      lines.forEach((line, i) => drawText(line, f, margin + w / 2, paper.y + i * lh, "center"));
      paper.y += lines.length * lh + after;
    },

    // Shop name on one line like the screen, shrinking the font if needed
    title(text) {
      let size = paper.fonts.title[0];
      while (size > 20 * s && measure(text, [size, true]) > w) size -= 1;
      paper.centered(text, [size, true], 8 * s);
    },

    divider() {
      const yy = paper.y + 14 * s;
      g.lineWidth = 2 * s;
      g.setLineDash([6 * s, 4 * s]);
      g.beginPath();
      g.moveTo(margin, yy);
      g.lineTo(margin + w, yy);
      g.stroke();
      g.setLineDash([]);
      paper.y = yy + 18 * s;
    },

    // Label on the left, value on the right (value moves to the next line if it doesn't fit)
    row(label, value, labelFont = paper.fonts.label, valueFont = paper.fonts.value, gap = 0) {
      value = String(value ?? "");
      const h = Math.max(labelFont[0], valueFont[0]) * LINE_HEIGHT;
      const lw = measure(label, labelFont);
      const vw = measure(value, valueFont);
      drawText(label, labelFont, margin, paper.y);
      let yy = paper.y;
      if (lw + vw + 8 > w) yy += h;
      drawText(value, valueFont, margin + w, yy, "right");
      paper.y = yy + h + gap;
    },

    // Bold "label  value" line that stays on one line, like the screen's TOTAL FEE
    total(label, value) {
      let size = 29 * s;
      while (size > 18 && measure(label, [size, true]) + measure(String(value), [size, true]) + 8 > w) {
        size -= 1;
      }
      paper.row(label, value, [size, true], [size, true], 0);
    },

    space(px) {
      paper.y += px * s;
    },

    poweredBy() {
      paper.space(14);
      paper.centered(POWERED_BY, paper.fonts.footer, 0);
    },

    // Crop to content; 1 bit per pixel, rows packed MSB first, 1 = black
    finish() {
      const height = Math.min(canvas.height, Math.ceil(paper.y + 10 * s));
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
    },
  };
  return paper;
}

/** Draws one parking receipt, like the on-screen receipt. */
export function renderReceipt(r, widthDots) {
  const p = createPaper(widthDots, 1600);
  const f = p.fonts;
  const rowGap = 12 * p.s;

  p.logo();
  p.title(SHOP_NAME);
  p.centered("Thank you for parking with us!", f.small);
  p.divider();
  p.row("Receipt No.", r.receiptNo, f.label, f.value, rowGap);
  p.row("Date", r.date);
  p.divider();
  if (r.plateNumber) p.row("Plate No.", r.plateNumber, f.label, f.value, rowGap);
  if (r.tinNumber) p.row("TIN No.", r.tinNumber, f.label, f.value, rowGap);
  p.row("In-Time", r.inTime, f.label, f.value, rowGap);
  p.row("Out-Time", r.outTime);
  p.divider();
  p.total("TOTAL FEE", r.feeText);
  p.space(22);
  p.centered("Please keep this receipt for your records.", f.small, 6 * p.s);
  p.centered("Have a safe journey!", f.small);
  p.poweredBy();
  return p.finish();
}

/**
 * Draws the Z report (end-of-day summary) for one day.
 * report: { dayText, printedAt, count, prints, first, last, totalText }
 * (first / last: { receiptNo, time } or null)
 */
export function renderZReport(report, widthDots) {
  const p = createPaper(widthDots, 1600);
  const f = p.fonts;
  const rowGap = 12 * p.s;

  p.logo();
  p.title(SHOP_NAME);
  p.centered("Z REPORT", f.heading, 4 * p.s);
  p.centered("Daily parking summary", f.small);
  p.divider();
  p.row("Date", report.dayText, f.label, f.value, rowGap);
  p.row("Printed", report.printedAt);
  p.divider();
  p.row("Receipts", String(report.count), f.label, f.value, rowGap);
  p.row("Prints", String(report.prints));
  if (report.first) {
    p.divider();
    p.row("First", report.first.receiptNo, f.label, f.value, 2 * p.s);
    p.row("", report.first.time, f.label, f.small, rowGap);
    p.row("Last", report.last.receiptNo, f.label, f.value, 2 * p.s);
    p.row("", report.last.time, f.label, f.small);
  }
  p.divider();
  p.total("TOTAL", report.totalText);
  p.poweredBy();
  return p.finish();
}

/** Saves and prints a receipt on this PC's receipt printer. Returns the printer name. */
export async function printReceipt(receipt) {
  const target = await invoke("print_target");
  const raster = renderReceipt(receipt, target.dots);
  return invoke("print_receipt", { receipt, target, raster });
}

/** Prints the Z report of one day ("YYYY-MM-DD"). Returns the printer name. */
export async function printZReport(day, report) {
  const target = await invoke("print_target");
  const raster = renderZReport(report, target.dots);
  return invoke("print_report", { day, target, raster });
}

/** Prints a sample receipt with not-yet-saved printer settings. */
export async function testPrint(settings, token) {
  const target = await invoke("print_target", { settings });
  const sample = {
    receiptNo: "TEST-PRINT",
    date: new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }),
    plateNumber: "AA 3-B12345",
    tinNumber: "0012345678",
    inTime: "08:00 AM",
    outTime: "09:00 AM",
    fee: 0,
    feeText: "0.00 ETB",
  };
  const raster = renderReceipt(sample, target.dots);
  return invoke("test_print", { settings, target, raster, token: token || null });
}
