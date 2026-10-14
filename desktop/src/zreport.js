import { printZReport } from "./printing.js";

const { invoke } = window.__TAURI__.core;

const dayInput = document.getElementById("day");
const printButton = document.getElementById("printButton");
const messageEl = document.getElementById("message");
const rowsBody = document.getElementById("receiptRows");

let receipts = [];

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatMoney(amount) {
  return (
    Number(amount || 0).toLocaleString("en-ET", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + " ETB"
  );
}

function formatClock(iso) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
}

function formatDateTime(date) {
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function localDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function dayText(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function showMessage(text, ok = false) {
  messageEl.style.color = ok ? "var(--primary)" : "";
  messageEl.textContent = text;
}

// ─── Summary ─────────────────────────────────────────────────────────────────

function summary() {
  const total = receipts.reduce((sum, r) => sum + Number(r.fee || 0), 0);
  const prints = receipts.reduce((sum, r) => sum + Number(r.printCount || 0), 0);
  const first = receipts[0];
  const last = receipts[receipts.length - 1];
  return {
    dayText: dayText(dayInput.value),
    printedAt: formatDateTime(new Date()),
    count: receipts.length,
    prints,
    total,
    totalText: formatMoney(total),
    first: first ? { receiptNo: first.receiptNo, time: formatClock(first.createdAt) } : null,
    last: last ? { receiptNo: last.receiptNo, time: formatClock(last.createdAt) } : null,
  };
}

function render() {
  const s = summary();
  document.getElementById("statCount").textContent = s.count;
  document.getElementById("statPrints").textContent = s.prints;
  document.getElementById("statTotal").textContent = s.totalText;
  document.getElementById("footCount").textContent = `${s.count} receipts`;
  document.getElementById("footTotal").textContent = s.totalText;

  rowsBody.replaceChildren(
    ...receipts.map((r) => {
      const tr = document.createElement("tr");
      const cells = [
        [r.receiptNo],
        [formatClock(r.createdAt)],
        [r.inTime],
        [r.outTime],
        [r.plateNumber || "—"],
        [r.tinNumber || "—"],
        [formatMoney(r.fee), "num"],
        [String(r.printCount || 0), "num"],
      ];
      for (const [text, cls] of cells) {
        const td = document.createElement("td");
        td.textContent = text ?? "";
        if (cls) td.className = cls;
        tr.appendChild(td);
      }
      return tr;
    }),
  );

  document.getElementById("emptyState").classList.toggle("hidden", receipts.length > 0);
}

async function load() {
  showMessage("");
  if (!dayInput.value) dayInput.value = localDateKey(new Date());
  try {
    receipts = await invoke("z_report", { day: dayInput.value });
  } catch (err) {
    receipts = [];
    showMessage(String(err?.message ?? err));
  }
  render();
}

// ─── Print ───────────────────────────────────────────────────────────────────

printButton.addEventListener("click", async () => {
  showMessage("");
  printButton.disabled = true;
  printButton.textContent = "Printing…";
  try {
    await load(); // include receipts made since the page was opened
    await printZReport(dayInput.value, summary());
    printButton.textContent = "Printed ✓";
    setTimeout(() => {
      printButton.textContent = "Print Z Report";
    }, 2000);
  } catch (err) {
    printButton.textContent = "Print Z Report";
    showMessage(
      "Printing failed: " + String(err?.message ?? err) +
      " Check that the printer is on and connected.",
    );
  } finally {
    printButton.disabled = false;
  }
});

// ─── PDF export ──────────────────────────────────────────────────────────────

async function exportPdf() {
  showMessage("");
  await load();
  const s = summary();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

  doc.setFontSize(16);
  doc.text("Z Report - Wastina Commercial Center", 14, 16);

  doc.setFontSize(10);
  doc.text(`Day: ${s.dayText}`, 14, 23);
  doc.text(`Generated: ${s.printedAt}`, 14, 28);
  doc.text(`Receipts: ${s.count}     Prints: ${s.prints}     Total fees: ${s.totalText}`, 14, 33);

  doc.autoTable({
    startY: 38,
    head: [["Receipt No.", "Time", "In-Time", "Out-Time", "Plate No.", "TIN No.", "Fee", "Prints"]],
    body: receipts.map((r) => [
      r.receiptNo,
      formatClock(r.createdAt),
      r.inTime,
      r.outTime,
      r.plateNumber || "-",
      r.tinNumber || "-",
      formatMoney(r.fee),
      String(r.printCount || 0),
    ]),
    foot: [["", "", "", "", "", `${s.count} receipts`, s.totalText, String(s.prints)]],
    headStyles: { fillColor: [22, 101, 52] },
    footStyles: { fillColor: [237, 241, 238], textColor: [23, 34, 27] },
    columnStyles: { 6: { halign: "right" }, 7: { halign: "right" } },
    styles: { fontSize: 9 },
  });

  doc.setFontSize(8);
  doc.text("Powered By NYT Software Solutions", 14, doc.internal.pageSize.getHeight() - 8);

  try {
    const path = await invoke("save_pdf", {
      fileName: `z-report-${dayInput.value}.pdf`,
      data: Array.from(new Uint8Array(doc.output("arraybuffer"))),
    });
    showMessage("PDF saved to: " + path, true);
  } catch (err) {
    showMessage(String(err?.message ?? err));
  }
}

document.getElementById("exportButton").addEventListener("click", exportPdf);
document.getElementById("todayButton").addEventListener("click", () => {
  dayInput.value = localDateKey(new Date());
  load();
});
dayInput.addEventListener("change", load);

load();
