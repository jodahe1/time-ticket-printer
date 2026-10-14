// Printer choice form, used by first-run setup and the Admin page.
// The form needs: select[name=printer], select[name=paperWidth],
// input[name=cut], buttons [data-action=refresh] / [data-action=test],
// a .message element and a submit button.

import { testPrint } from "./printing.js";

const { invoke } = window.__TAURI__.core;

export function initPrinterSettings({ form, getToken, onSave }) {
  const printerSelect = form.elements.printer;
  const paperSelect = form.elements.paperWidth;
  const cutInput = form.elements.cut;
  const message = form.querySelector(".message");

  function show(text, ok = false) {
    message.style.color = ok ? "var(--primary)" : "";
    message.textContent = text;
  }

  function read() {
    return {
      printerName: printerSelect.value,
      paperWidthMm: Number(paperSelect.value),
      cut: cutInput.checked,
    };
  }

  async function loadPrinters(preferred) {
    const printers = await invoke("list_printers");
    printerSelect.replaceChildren(
      ...printers.map((p) => {
        const option = document.createElement("option");
        option.value = p.name;
        option.textContent =
          p.name + (p.connected ? "  [USB CONNECTED]" : "") + (p.isDefault ? "  (Windows default)" : "");
        return option;
      }),
    );

    // Keep the saved printer, else pick a plugged-in USB printer, else the Windows default
    const pick =
      printers.find((p) => p.name === preferred) ||
      printers.find((p) => p.connected) ||
      printers.find((p) => p.isDefault) ||
      printers[0];
    if (pick) printerSelect.value = pick.name;
    if (!printers.length) show("No printers are installed on this computer. Install the printer driver, then press Refresh.");
  }

  async function load() {
    show("");
    try {
      const status = await invoke("get_status");
      paperSelect.value = status.paperWidthMm >= 80 ? "80" : "58";
      cutInput.checked = status.cut;
      await loadPrinters(status.configured ? status.printerName : "");
      return status;
    } catch (err) {
      show(String(err?.message ?? err));
    }
  }

  form.querySelector("[data-action=refresh]").addEventListener("click", async () => {
    show("");
    await loadPrinters(printerSelect.value);
  });

  const testButton = form.querySelector("[data-action=test]");
  testButton.addEventListener("click", async () => {
    show("");
    testButton.disabled = true;
    try {
      const printer = await testPrint(read(), getToken());
      show(`Test receipt sent to ${printer}.`, true);
    } catch (err) {
      show("Test print failed: " + String(err?.message ?? err));
    } finally {
      testButton.disabled = false;
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    show("");
    if (!printerSelect.value) {
      show("Choose a printer.");
      return;
    }
    try {
      await onSave(read());
      show("Settings saved.", true);
    } catch (err) {
      show(String(err?.message ?? err));
    }
  });

  return { load, read, show };
}
