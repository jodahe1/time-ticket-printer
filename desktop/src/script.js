import { printReceipt } from "./printing.js";

const parkingForm = document.getElementById("parkingForm");
const formSection = document.getElementById("formSection");
const receiptSection = document.getElementById("receiptSection");
const feeInput = document.getElementById("fee");

const printButton = document.getElementById("printButton");
const newReceiptButton = document.getElementById("newReceiptButton");
const backButton = document.getElementById("backButton");

// ─── Desktop app: receipts are saved and printed by the app itself ──────────
const { invoke } = window.__TAURI__.core;

let currentReceipt = null;

// First start on this PC: choose the printer and create the admin login
invoke("get_status").then((status) => {
  if (!status.configured) window.location.replace("setup.html");
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(timeValue) {
  const [hours, minutes] = timeValue.split(":");
  const date = new Date();
  date.setHours(Number(hours), Number(minutes), 0, 0);

  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
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

  const inTime = document.getElementById("inTime").value;
  const outTime = document.getElementById("outTime").value;
  const feeRaw = document.getElementById("fee").value;
  const fee = parseFeeInput(feeRaw);

  if (!inTime || !outTime || feeRaw === "") {
    alert("Please fill in all the required fields.");
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
    inTime: formatTime(inTime),
    outTime: formatTime(outTime),
    fee,
    feeText: formatFee(fee),
  };

  document.getElementById("receiptNumber").textContent = currentReceipt.receiptNo;
  document.getElementById("receiptDate").textContent = currentReceipt.date;
  document.getElementById("receiptInTime").textContent = currentReceipt.inTime;
  document.getElementById("receiptOutTime").textContent = currentReceipt.outTime;
  document.getElementById("receiptFee").textContent = currentReceipt.feeText;

  // Save the receipt on this PC (best effort; printing saves it again)
  invoke("save_receipt", { receipt: currentReceipt }).catch((err) =>
    console.warn("Could not save receipt:", err),
  );

  formSection.classList.add("hidden");
  receiptSection.classList.remove("hidden");

  window.scrollTo({
    top: 0,
    behavior: "smooth",
  });
});

// ─── Print button ─────────────────────────────────────────────────────────────

// Prints silently on this PC's receipt printer — no dialog
async function printWithApp() {
  printButton.disabled = true;
  printButton.textContent = "Printing…";

  try {
    await printReceipt(currentReceipt);
    printButton.textContent = "Printed ✓";
    setTimeout(() => {
      printButton.textContent = "Print Receipt";
    }, 2000);
  } catch (err) {
    console.error("Print error:", err);
    printButton.textContent = "Print Receipt";
    alert(
      "Printing failed: " + (err?.message ?? String(err)) +
      "\n\nCheck that the printer is on and connected. " +
      "The printer can be changed on the Admin page (Printer settings).",
    );
  } finally {
    printButton.disabled = false;
  }
}

printButton.addEventListener("click", printWithApp);

// ─── Navigation buttons ───────────────────────────────────────────────────────

backButton.addEventListener("click", function () {
  receiptSection.classList.add("hidden");
  formSection.classList.remove("hidden");

  document.getElementById("inTime").focus();

  window.scrollTo({
    top: 0,
    behavior: "smooth",
  });
});

newReceiptButton.addEventListener("click", function () {
  parkingForm.reset();

  receiptSection.classList.add("hidden");
  formSection.classList.remove("hidden");

  document.getElementById("inTime").focus();

  window.scrollTo({
    top: 0,
    behavior: "smooth",
  });
});
