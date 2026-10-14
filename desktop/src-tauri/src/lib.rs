// Parking Manager desktop app. The pages are the same as the website; these
// commands replace the browser print service (http://localhost:9123), so
// saving, printing and the admin data all work offline inside the app.

mod printer;
mod store;

use printer::Raster;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use store::{Config, Store};
use tauri::{Manager, State};

struct AppState {
  store: Mutex<Store>,
  sessions: Mutex<HashMap<String, Instant>>,
}

const SESSION_HOURS: u64 = 12;
const NOT_LOGGED_IN: &str = "Not logged in";

impl AppState {
  fn check_session(&self, token: &str) -> Result<(), String> {
    let mut sessions = self.sessions.lock().unwrap();
    match sessions.get(token) {
      Some(expires) if *expires > Instant::now() => Ok(()),
      Some(_) => {
        sessions.remove(token);
        Err(NOT_LOGGED_IN.into())
      }
      None => Err(NOT_LOGGED_IN.into()),
    }
  }

  /// Printer settings may be changed during first-run setup or by the admin.
  fn check_setup_allowed(&self, token: Option<&str>) -> Result<(), String> {
    let configured = self.store.lock().unwrap().config().admin.is_some();
    if !configured {
      return Ok(());
    }
    self.check_session(token.unwrap_or(""))
  }
}

// --- Status & setup ------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
  configured: bool,
  printer_name: String,
  paper_width_mm: u32,
  cut: bool,
  admin_username: String,
}

#[tauri::command]
fn get_status(state: State<AppState>) -> Status {
  let config = state.store.lock().unwrap().config();
  Status {
    configured: config.admin.is_some(),
    printer_name: if config.printer_name.is_empty() { printer::default_printer() } else { config.printer_name },
    paper_width_mm: config.paper_width_mm,
    cut: config.cut,
    admin_username: config.admin.map(|a| a.username).unwrap_or_default(),
  }
}

#[tauri::command]
fn list_printers() -> Vec<printer::PrinterInfo> {
  printer::list_printers()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrinterSettings {
  printer_name: String,
  paper_width_mm: u32,
  cut: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupInput {
  #[serde(flatten)]
  printer: PrinterSettings,
  admin_username: Option<String>,
  admin_password: Option<String>,
}

#[tauri::command]
fn save_setup(state: State<AppState>, input: SetupInput, token: Option<String>) -> Result<(), String> {
  state.check_setup_allowed(token.as_deref())?;
  let store = state.store.lock().unwrap();
  let mut config = store.config();

  config.printer_name = input.printer.printer_name;
  config.paper_width_mm = if input.printer.paper_width_mm >= 80 { 80 } else { 58 };
  config.cut = input.printer.cut;

  if let Some(password) = input.admin_password.filter(|p| !p.is_empty()) {
    if password.chars().count() < 6 {
      return Err("Admin password must be at least 6 characters".into());
    }
    let username = input.admin_username.map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
    config.admin = Some(store::new_admin(username.as_deref().unwrap_or("admin"), &password));
  }
  if config.admin.is_none() {
    return Err("Create the admin login".into());
  }

  store.save_config(&config)?;
  store.log(&format!("Settings saved. Printer: {}", config.printer_name));
  Ok(())
}

// --- Printing ------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrintTarget {
  printer: String,
  escpos: bool,
  dots: u32,
}

fn settings_target(config: &Config, settings: Option<PrinterSettings>) -> printer::Target {
  match settings {
    Some(s) => printer::target(&s.printer_name, "auto", s.paper_width_mm),
    None => printer::target(&config.printer_name, &config.print_mode, config.paper_width_mm),
  }
}

/// Which printer will be used and how wide the receipt image must be.
#[tauri::command]
async fn print_target(state: State<'_, AppState>, settings: Option<PrinterSettings>) -> Result<PrintTarget, String> {
  let config = state.store.lock().unwrap().config();
  let t = settings_target(&config, settings);
  Ok(PrintTarget { printer: t.printer, escpos: t.escpos, dots: t.dots })
}

#[tauri::command]
fn save_receipt(state: State<AppState>, receipt: Map<String, Value>) -> Result<Map<String, Value>, String> {
  state.store.lock().unwrap().save_receipt(&receipt, false)
}

#[tauri::command]
async fn print_receipt(
  state: State<'_, AppState>,
  receipt: Map<String, Value>,
  target: PrintTarget,
  raster: Raster,
) -> Result<String, String> {
  let (saved, config) = {
    let store = state.store.lock().unwrap();
    (store.save_receipt(&receipt, false)?, store.config())
  };
  let receipt_no = saved.get("receiptNo").and_then(Value::as_str).unwrap_or("").to_string();
  let t = printer::Target { printer: target.printer, escpos: target.escpos, dots: target.dots };

  let result = printer::print(&t, &format!("Parking Receipt {receipt_no}"), &raster, config.cut, config.receipt_width_mm);
  let store = state.store.lock().unwrap();
  match result {
    Ok(()) => {
      store.save_receipt(&receipt, true)?;
      store.log(&format!("Printed {receipt_no} on {}", t.printer));
      Ok(t.printer)
    }
    Err(e) => {
      store.log(&format!("Print of {receipt_no} failed: {e}"));
      Err(e)
    }
  }
}

#[tauri::command]
async fn test_print(
  state: State<'_, AppState>,
  settings: PrinterSettings,
  target: PrintTarget,
  raster: Raster,
  token: Option<String>,
) -> Result<String, String> {
  state.check_setup_allowed(token.as_deref())?;
  let t = printer::Target { printer: target.printer, escpos: target.escpos, dots: target.dots };
  let config = state.store.lock().unwrap().config();
  printer::print(&t, "Parking Receipt TEST-PRINT", &raster, settings.cut, config.receipt_width_mm)?;
  Ok(t.printer)
}

// --- Z report (open to every user) --------------------------------------------

/// Receipts of one local day ("YYYY-MM-DD"), oldest first.
#[tauri::command]
fn z_report(state: State<AppState>, day: String) -> Vec<Map<String, Value>> {
  state.store.lock().unwrap().receipts_for_day(&day)
}

#[tauri::command]
async fn print_report(state: State<'_, AppState>, day: String, target: PrintTarget, raster: Raster) -> Result<String, String> {
  let config = state.store.lock().unwrap().config();
  let t = printer::Target { printer: target.printer, escpos: target.escpos, dots: target.dots };
  let result = printer::print(&t, &format!("Parking Z Report {day}"), &raster, config.cut, config.receipt_width_mm);
  let store = state.store.lock().unwrap();
  match result {
    Ok(()) => {
      store.log(&format!("Printed Z report {day} on {}", t.printer));
      Ok(t.printer)
    }
    Err(e) => {
      store.log(&format!("Print of Z report {day} failed: {e}"));
      Err(e)
    }
  }
}

// --- Admin ---------------------------------------------------------------------

#[tauri::command]
fn login(state: State<AppState>, username: String, password: String) -> Result<String, String> {
  let config = state.store.lock().unwrap().config();
  match &config.admin {
    Some(admin) if admin.username == username && store::check_password(&password, admin) => {
      let token = store::random_hex(32);
      state
        .sessions
        .lock()
        .unwrap()
        .insert(token.clone(), Instant::now() + Duration::from_secs(SESSION_HOURS * 3600));
      Ok(token)
    }
    _ => Err("Invalid username or password".into()),
  }
}

#[tauri::command]
fn list_receipts(state: State<AppState>, token: String) -> Result<Vec<Map<String, Value>>, String> {
  state.check_session(&token)?;
  let mut receipts = state.store.lock().unwrap().receipts();
  let created = |r: &Map<String, Value>| r.get("createdAt").and_then(Value::as_str).unwrap_or("").to_string();
  receipts.sort_by_key(|r| std::cmp::Reverse(created(r)));
  Ok(receipts)
}

#[tauri::command]
fn change_password(
  state: State<AppState>,
  token: String,
  current_password: String,
  new_password: String,
) -> Result<(), String> {
  state.check_session(&token)?;
  let store = state.store.lock().unwrap();
  let mut config = store.config();
  let Some(admin) = config.admin.clone() else { return Err(NOT_LOGGED_IN.into()) };
  if !store::check_password(&current_password, &admin) {
    return Err("Current password is wrong".into());
  }
  if new_password.chars().count() < 6 {
    return Err("New password must be at least 6 characters".into());
  }
  config.admin = Some(store::new_admin(&admin.username, &new_password));
  store.save_config(&config)
}

/// Saves an exported PDF (admin list or Z report) to the Downloads folder and
/// shows it in Explorer.
#[tauri::command]
fn save_pdf(app: tauri::AppHandle, file_name: String, data: Vec<u8>) -> Result<String, String> {
  let dir = app.path().download_dir().map_err(|e| e.to_string())?;
  let safe: String = file_name.chars().filter(|c| c.is_ascii_alphanumeric() || "-_.".contains(*c)).collect();
  let (stem, ext) = safe.rsplit_once('.').unwrap_or((&safe, "pdf"));
  let mut path = dir.join(format!("{stem}.{ext}"));
  let mut n = 1;
  while path.exists() {
    path = dir.join(format!("{stem} ({n}).{ext}"));
    n += 1;
  }
  std::fs::write(&path, data).map_err(|e| e.to_string())?;
  #[cfg(windows)]
  {
    let _ = std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).spawn();
  }
  Ok(path.display().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
      }
    }))
    .setup(|app| {
      let dir = app.path().app_local_data_dir()?;
      let store = Store::new(dir);
      store.import_print_service();
      store.log("App started");
      app.manage(AppState { store: Mutex::new(store), sessions: Mutex::new(HashMap::new()) });
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      get_status,
      list_printers,
      save_setup,
      print_target,
      save_receipt,
      print_receipt,
      test_print,
      z_report,
      print_report,
      login,
      list_receipts,
      change_password,
      save_pdf,
    ])
    .run(tauri::generate_context!())
    .expect("error while running Parking Manager");
}
