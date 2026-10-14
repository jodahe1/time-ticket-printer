import { initPrinterSettings } from "./printer-settings.js";

const { invoke } = window.__TAURI__.core;

const settings = initPrinterSettings({
  form: document.getElementById("setupForm"),
  getToken: () => null,
  onSave: async (printer) => {
    const username = document.getElementById("adminUsername").value.trim() || "admin";
    const password = document.getElementById("adminPassword").value;
    if (password.length < 6) throw new Error("Admin password must be at least 6 characters.");
    if (password !== document.getElementById("adminPassword2").value) throw new Error("Passwords do not match.");

    await invoke("save_setup", {
      input: { ...printer, adminUsername: username, adminPassword: password },
    });
    window.location.replace("index.html");
  },
});

settings.load().then((status) => {
  if (status?.configured) window.location.replace("index.html");
});
