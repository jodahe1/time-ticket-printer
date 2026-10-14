
const parkingForm = document.getElementById("parkingForm");
const formSection = document.getElementById("formSection");
const receiptSection = document.getElementById("receiptSection");
const feeInput = document.getElementById("fee");
const plateNumberInput = document.getElementById("plateNumber");
const tinNumberInput = document.getElementById("tinNumber");

const printButton = document.getElementById("printButton");
const newReceiptButton = document.getElementById("newReceiptButton");
const backButton = document.getElementById("backButton");

// ─── Detect Tauri environment ────────────────────────────────────────────────
const IS_TAURI = typeof window.__TAURI__ !== "undefined" ||
                 typeof window.__TAURI_INTERNALS__ !== "undefined";

// ─── Local print service (print-agent on the POS PC) ─────────────────────────
const PRINT_AGENT_URL = "http://localhost:9123";
const PRINT_SERVICE_DOWNLOAD = "downloads/ParkingPrintService.zip";

let currentReceipt = null;

async function callPrintAgent(path, body, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(PRINT_AGENT_URL + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || `Print service error (${response.status})`);
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Typed 12-hour times: "8:30", "830" or "0830" plus the AM/PM dropdown.
// 24-hour input like "14:30" is accepted and switches the dropdown to PM.
function parseClock(value) {
  const match = value.trim().match(/^(\d{1,2}):?(\d{2})?$/);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour > 23 || minute > 59) return null;

  return { hour, minute };
}

// Returns e.g. "08:30 AM", "" if the box is empty, or null if it is invalid
function readTime(prefix) {
  const clockInput = document.getElementById(`${prefix}Clock`);
  const periodSelect = document.getElementById(`${prefix}Period`);

  if (!clockInput.value.trim()) return "";

  const parsed = parseClock(clockInput.value);
  if (!parsed) return null;

  let { hour } = parsed;
  if (hour === 0) {
    hour = 12;
    periodSelect.value = "AM";
  } else if (hour > 12) {
    hour -= 12;
    periodSelect.value = "PM";
  }

  const clock = `${String(hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;
  clockInput.value = clock;

  return `${clock} ${periodSelect.value}`;
}

function formatFee(amount) {
  return (
    Number(amount).toLocaleString("en-ET", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + " ETB"
  );
}

function parseFeeInput(value) {
  const normalizedValue = value.trim();

  if (!/^\d+(\.\d{1,2})?$/.test(normalizedValue)) {
    return null;
  }

  const amount = Number(normalizedValue);

  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }

  return amount;
}

function generateReceiptNumber() {
  const now = new Date();
  const datePart = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");

  const randomPart = Math.floor(1000 + Math.random() * 9000);

  return `PK-${datePart}-${randomPart}`;
}

// ─── Input sanitisation ───────────────────────────────────────────────────────

// Times: typed as "hh:mm" — the colon is added after two hour digits
// (or typed by hand, e.g. "8:30"); tidied to "hh:mm" when the box loses focus
for (const prefix of ["inTime", "outTime"]) {
  const clockInput = document.getElementById(`${prefix}Clock`);
  clockInput.addEventListener("input", function (event) {
    const deleting = (event.inputType || "").startsWith("delete");
    let [hourPart, ...rest] = this.value.replace(/[^0-9:]/g, "").split(":");

    // "8" → "08", "25" → "02" + "5": no hour starts with 3–9 or 24–29
    if (/^([3-9]|2[4-9])/.test(hourPart)) hourPart = "0" + hourPart;
    if (!rest.length && hourPart.length > 2) rest = [hourPart.slice(2)];
    hourPart = hourPart.slice(0, 2);
    // Minutes can't start with 6–9
    const minutes = rest.join("").replace(/^[6-9]+/, "").slice(0, 2);

    if (rest.length) {
      this.value = `${hourPart}:${minutes}`;
    } else if (hourPart.length === 2 && !deleting) {
      this.value = `${hourPart}:`;
    } else {
      this.value = hourPart;
    }
  });
  clockInput.addEventListener("blur", () => readTime(prefix));
}

// Plate and TIN numbers: letters, digits, spaces and hyphens, upper-cased
for (const input of [plateNumberInput, tinNumberInput]) {
  input.addEventListener("input", function () {
    this.value = this.value.toUpperCase().replace(/[^A-Z0-9\s-]/g, "");
  });
}

feeInput.addEventListener("input", function () {
  const rawValue = this.value.replace(/[^0-9.]/g, "");
  const parts = rawValue.split(".");

  if (parts.length > 2) {
    this.value = `${parts[0]}.${parts.slice(1).join("")}`;
    return;
  }

  if (parts.length === 2) {
    this.value = `${parts[0]}.${parts[1].slice(0, 2)}`;
    return;
  }

  this.value = rawValue;
});

// ─── Form submit ─────────────────────────────────────────────────────────────

parkingForm.addEventListener("submit", function (event) {
  event.preventDefault();

  const inTime = readTime("inTime");
  const outTime = readTime("outTime");
  const feeRaw = document.getElementById("fee").value;
  const fee = parseFeeInput(feeRaw);
  const plateNumber = plateNumberInput.value.trim().replace(/\s+/g, " ");
  const tinNumber = tinNumberInput.value.trim().replace(/\s+/g, " ");

  if (inTime === "" || outTime === "" || feeRaw === "") {
    alert("Please fill in all the required fields.");
    return;
  }

  if (inTime === null || outTime === null) {
    alert("Please enter a valid time, like 8:30 or 08:30.");
    return;
  }

  if (fee === null) {
    alert("Please enter a valid parking fee, like 089 or 89.00.");
    return;
  }

  const now = new Date();

  currentReceipt = {
    receiptNo: generateReceiptNumber(),
    date: now.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }),
    inTime,
    outTime,
    plateNumber,
    tinNumber,
    fee,
    feeText: formatFee(fee),
  };

  document.getElementById("receiptNumber").textContent = currentReceipt.receiptNo;
  document.getElementById("receiptDate").textContent = currentReceipt.date;
  document.getElementById("receiptPlate").textContent = currentReceipt.plateNumber;
  document.getElementById("receiptPlateRow").classList.toggle("hidden", !currentReceipt.plateNumber);
  document.getElementById("receiptTin").textContent = currentReceipt.tinNumber;
  document.getElementById("receiptTinRow").classList.toggle("hidden", !currentReceipt.tinNumber);
  document.getElementById("receiptInTime").textContent = currentReceipt.inTime;
  document.getElementById("receiptOutTime").textContent = currentReceipt.outTime;
  document.getElementById("receiptFee").textContent = currentReceipt.feeText;

  // Save the receipt on the POS PC (best effort; printing saves it again)
  callPrintAgent("/api/receipts", currentReceipt).catch((err) =>
    console.warn("Could not save receipt:", err),
  );

  formSection.classList.add("hidden");
  receiptSection.classList.remove("hidden");

  window.scrollTo({
    top: 0,
    behavior: "smooth",
  });
});

// ─── Thermal printing via tauri-plugin-thermal-printer ───────────────────────

/**
 * Build the structured ESC/POS print job from current receipt data
 * and send it directly to the default thermal printer (production mode).
 */
async function printWithTauriPlugin() {
  printButton.disabled = true;
  printButton.textContent = "Printing…";

  try {
    // Dynamically import from the Tauri-bundled ES module path
    const {
      list_thermal_printers,
      print_thermal_printer,
      title: titleSection,
      text,
      line,
      feed,
      cut,
    } = await import("/node_modules/tauri-plugin-thermal-printer/dist-js/index.js");

    // 1. Find the first available thermal printer
    const printers = await list_thermal_printers();

    if (!printers || printers.length === 0) {
      alert("No thermal printer found. Please connect your printer and try again.");
      return;
    }

    const printer = printers[0]; // Use first / default printer

    // 2. Read values already rendered on screen
    const receiptNo   = document.getElementById("receiptNumber").textContent;
    const receiptDate = document.getElementById("receiptDate").textContent;
    const plateVal    = document.getElementById("receiptPlate").textContent;
    const tinVal      = document.getElementById("receiptTin").textContent;
    const inTimeVal   = document.getElementById("receiptInTime").textContent;
    const outTimeVal  = document.getElementById("receiptOutTime").textContent;
    const feeVal      = document.getElementById("receiptFee").textContent;

    // 3. Build ESC/POS sections
    const sections = [
      // Header
      titleSection("WASTINA COMMERCIAL CENTER", { align: "center" }),
      text("Thank you for parking with us!", { align: "center" }),
      line({ character: "-", length: 32 }),

      // Receipt details
      text(`Receipt No.  ${receiptNo}`,  { align: "left" }),
      text(`Date         ${receiptDate}`, { align: "left" }),
      line({ character: "-", length: 32 }),

      ...(plateVal ? [text(`Plate No.    ${plateVal}`, { align: "left" })] : []),
      ...(tinVal   ? [text(`TIN No.      ${tinVal}`,   { align: "left" })] : []),
      text(`In-Time      ${inTimeVal}`,  { align: "left" }),
      text(`Out-Time     ${outTimeVal}`, { align: "left" }),
      line({ character: "-", length: 32 }),

      // Total
      titleSection(`TOTAL FEE  ${feeVal}`, { align: "center" }),
      line({ character: "=", length: 32 }),

      // Footer
      feed({ lines: 1 }),
      text("Please keep this receipt for your records.", { align: "center" }),
      text("Have a safe journey!", { align: "center" }),

      // Auto-cut
      feed({ lines: 3 }),
      cut({ mode: "partial", feed: 0 }),
    ];

    // 4. Send to printer
    await print_thermal_printer({
      printer_name: printer.name,
      paper_size: "Mm80",
      sections,
    });

    console.log("Print job sent successfully to:", printer.name);
  } catch (err) {
    console.error("Thermal print error:", err);
    alert("Printing failed: " + (err?.message ?? String(err)));
  } finally {
    printButton.disabled = false;
    printButton.textContent = "Print Receipt";
  }
}

// ─── Print button ─────────────────────────────────────────────────────────────

async function printWithAgent() {
  printButton.disabled = true;
  printButton.textContent = "Printing…";

  try {
    await callPrintAgent("/print", currentReceipt, 60000);
    printButton.textContent = "Printed ✓";
    setTimeout(() => {
      printButton.textContent = "Print Receipt";
    }, 2000);
  } catch (err) {
    console.error("Print service error:", err);
    printButton.textContent = "Print Receipt";

    if (err.name === "AbortError" || err instanceof TypeError) {
      const download = confirm(
        "The print service is not installed or not running on this computer " +
        "(or the browser blocked it).\n\n" +
        "Press OK to download the installer, then:\n" +
        "1. Extract the zip and run Setup.bat\n" +
        "2. Choose this PC's receipt printer\n" +
        "3. Press Print Receipt again (click Allow if the browser asks " +
        "to access devices on your local network).",
      );
      if (download) window.location.href = PRINT_SERVICE_DOWNLOAD;
    } else {
      alert("Printing failed: " + err.message);
    }
  } finally {
    printButton.disabled = false;
  }
}

printButton.addEventListener("click", function () {
  if (IS_TAURI) {
    // Desktop app: use thermal printer plugin directly — no dialog
    printWithTauriPlugin();
  } else {
    // Browser: send to the local print service — prints silently, no dialog
    printWithAgent();
  }
});

// ─── Navigation buttons ───────────────────────────────────────────────────────

backButton.addEventListener("click", function () {
  receiptSection.classList.add("hidden");
  formSection.classList.remove("hidden");

  document.getElementById("inTimeClock").focus();

  window.scrollTo({
    top: 0,
    behavior: "smooth",
  });
});

newReceiptButton.addEventListener("click", function () {
  parkingForm.reset();

  receiptSection.classList.add("hidden");
  formSection.classList.remove("hidden");

  document.getElementById("inTimeClock").focus();

  window.scrollTo({
    top: 0,
    behavior: "smooth",
  });
});
