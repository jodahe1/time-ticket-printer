# Parking Manager – Desktop (offline)

Windows desktop version of the Parking Manager website, built with Tauri.
It works fully offline: no browser, no print service and no internet needed.
The website in the repository root is separate and is not affected.

## What one installation sets up

- **The app**: the same receipt form, receipt and Admin page as the website,
  plus optional **Plate Number** and **TIN Number** fields (shown on the
  receipt and the paper only when filled in, and as columns on the Admin page).
- **Z Report**: link at the bottom of the receipt page, open to every user
  (no login). Shows the receipts, prints and total fees of a day, prints the
  daily summary on the receipt printer and exports a PDF.
- **Printing**: receipts print silently on the chosen printer, with no dialog.
  Thermal printers get the receipt exactly like the screen (ESC/POS) and the
  paper is cut after each receipt. Office printers use normal Windows
  printing. If a USB printer is plugged into another socket, the app finds it.
- **Admin data**: every receipt is saved on the PC for the Admin page (search,
  date filter, totals, PDF export, change password).

On first start the app asks once for the receipt printer, the paper width
(58/80 mm) and the admin login. If the browser print service was already
installed on the PC, its printer, admin login and saved receipts are imported
automatically and this step is skipped.

The printer can be changed later on the Admin page → *Printer settings*.

## Files on the PC

`%LOCALAPPDATA%\com.nyt.parking-manager.desktop\`

- `config.json` – printer and admin login (password stored as a salted hash)
- `data\receipts.json` – saved receipts
- `app.log` – print log

Uninstalling keeps these files unless "Delete the application data" is ticked.

## Build the installer

Requires Node.js, Rust and the Visual Studio C++ build tools.

```
cd desktop
npm install
npm run build
```

The installer is written to
`desktop/src-tauri/target/release/bundle/nsis/Parking Manager_1.0.0_x64-setup.exe`.
Copy it to each POS PC and run it (no administrator rights needed).

`npm run dev` starts the app in development mode.
