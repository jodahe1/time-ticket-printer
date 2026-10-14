const PRINT_AGENT_URL = "http://localhost:9123";
const PRINT_SERVICE_DOWNLOAD = "downloads/ParkingPrintService.zip";
const TOKEN_KEY = "parkingAdminToken";

const loginSection = document.getElementById("loginSection");
const dataSection = document.getElementById("dataSection");
const topActions = document.getElementById("topActions");
const searchInput = document.getElementById("search");
const fromDateInput = document.getElementById("fromDate");
const toDateInput = document.getElementById("toDate");
const rowsBody = document.getElementById("receiptRows");
const emptyState = document.getElementById("emptyState");

let allReceipts = [];

function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable; token lives for this page only
  }
  memoryToken = token;
}

let memoryToken = getToken();

async function api(path, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(PRINT_AGENT_URL + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(memoryToken ? { Authorization: `Bearer ${memoryToken}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(
      "Cannot reach the print service on this computer. Install it from " +
      `${new URL(PRINT_SERVICE_DOWNLOAD, location.href)} (run Setup.bat) ` +
      "and allow local network access if the browser asks.",
    );
  }

  const result = await response.json().catch(() => ({}));

  if (response.status === 401 && path !== "/api/login") {
    setToken(null);
    showLogin();
  }
  if (!response.ok) throw new Error(result.error || `Error ${response.status}`);
  return result;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatMoney(amount) {
  return (
    Number(amount || 0).toLocaleString("en-ET", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + " ETB"
  );
}

function formatCreated(iso) {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function localDateKey(iso) {
  const d = new Date(iso);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

// ─── Filtering & rendering ───────────────────────────────────────────────────

function getFiltered() {
  const query = searchInput.value.trim().toLowerCase();
  const from = fromDateInput.value;
  const to = toDateInput.value;

  return allReceipts.filter((r) => {
    if (query) {
      const haystack = `${r.receiptNo} ${r.plateNumber ?? ""} ${r.tinNumber ?? ""}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    const day = localDateKey(r.createdAt);
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  });
}

function render() {
  const receipts = getFiltered();
  const total = receipts.reduce((sum, r) => sum + Number(r.fee || 0), 0);

  document.getElementById("statCount").textContent = receipts.length;
  document.getElementById("statTotal").textContent = formatMoney(total);

  rowsBody.replaceChildren(
    ...receipts.map((r) => {
      const tr = document.createElement("tr");
      const cells = [
        [r.receiptNo],
        [formatCreated(r.createdAt)],
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

  emptyState.classList.toggle("hidden", receipts.length > 0);
}

async function loadReceipts() {
  const errorEl = document.getElementById("dataError");
  errorEl.textContent = "";
  try {
    const { receipts } = await api("/api/receipts");
    allReceipts = receipts;
    render();
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

// ─── PDF export ──────────────────────────────────────────────────────────────

function exportPdf() {
  const receipts = getFiltered();
  const total = receipts.reduce((sum, r) => sum + Number(r.fee || 0), 0);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

  doc.setFontSize(16);
  doc.text("Parking Receipts Report", 14, 16);

  doc.setFontSize(10);
  const filters = [];
  if (searchInput.value.trim()) filters.push(`Search: "${searchInput.value.trim()}"`);
  if (fromDateInput.value) filters.push(`From: ${fromDateInput.value}`);
  if (toDateInput.value) filters.push(`To: ${toDateInput.value}`);
  doc.text(filters.length ? filters.join("   ") : "All receipts", 14, 23);
  doc.text(`Generated: ${formatCreated(new Date().toISOString())}`, 14, 28);

  doc.autoTable({
    startY: 33,
    head: [["Receipt No.", "Created", "In-Time", "Out-Time", "Plate No.", "TIN No.", "Fee", "Prints"]],
    body: receipts.map((r) => [
      r.receiptNo,
      formatCreated(r.createdAt),
      r.inTime,
      r.outTime,
      r.plateNumber || "-",
      r.tinNumber || "-",
      formatMoney(r.fee),
      String(r.printCount || 0),
    ]),
    foot: [["", "", "", "", "", `${receipts.length} receipts`, formatMoney(total), ""]],
    headStyles: { fillColor: [22, 101, 52] },
    footStyles: { fillColor: [237, 241, 238], textColor: [23, 34, 27] },
    columnStyles: { 6: { halign: "right" }, 7: { halign: "right" } },
    styles: { fontSize: 9 },
  });

  doc.save(`parking-receipts-${localDateKey(new Date().toISOString())}.pdf`);
}

// ─── Views ───────────────────────────────────────────────────────────────────

function showLogin() {
  loginSection.classList.remove("hidden");
  dataSection.classList.add("hidden");
  topActions.classList.add("hidden");
}

function showData() {
  loginSection.classList.add("hidden");
  dataSection.classList.remove("hidden");
  topActions.classList.remove("hidden");
  loadReceipts();
}

document.getElementById("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorEl = document.getElementById("loginError");
  errorEl.textContent = "";
  try {
    const { token } = await api("/api/login", {
      method: "POST",
      body: {
        username: document.getElementById("username").value.trim(),
        password: document.getElementById("password").value,
      },
    });
    setToken(token);
    document.getElementById("password").value = "";
    showData();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById("logoutButton").addEventListener("click", () => {
  setToken(null);
  allReceipts = [];
  showLogin();
});

document.getElementById("passwordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const messageEl = document.getElementById("passwordMessage");
  messageEl.textContent = "";
  try {
    await api("/api/change-password", {
      method: "POST",
      body: {
        currentPassword: document.getElementById("currentPassword").value,
        newPassword: document.getElementById("newPassword").value,
      },
    });
    event.target.reset();
    messageEl.style.color = "var(--primary)";
    messageEl.textContent = "Password updated.";
  } catch (err) {
    messageEl.style.color = "";
    messageEl.textContent = err.message;
  }
});

searchInput.addEventListener("input", render);
fromDateInput.addEventListener("change", render);
toDateInput.addEventListener("change", render);
document.getElementById("exportButton").addEventListener("click", exportPdf);

if (memoryToken) showData();
else showLogin();
